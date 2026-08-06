// ── CDN access for hotlink-protected media ────────────────────────────
// Booru CDNs commonly reject requests that lack a same-site Referer, and they
// rarely send CORS headers. Two mechanisms cover that:
//
//  1. declarativeNetRequest session rules inject `Access-Control-Allow-Origin`
//     into the CDN's response for the duration of one import, so the in-page
//     fetch (running in the page origin, with cookies) can read the bytes.
//  2. A webRequest fallback for browsers without session rules, plus Referer
//     rewriting for image loads made from the extension's own popup.
//
// Both are scoped to hosts of an in-flight import, so neither acts as a
// browser-wide CORS bypass on unrelated traffic.

import { registrableDomain, registrableDomainOfUrl } from "~/shared/host";

/** Registrable domains of content URLs currently being fetched during an import. */
const activeImportHosts = new Set<string>();

let nextCorsRuleId = 10_000;

function getDeclarativeNetRequest(): any {
  return (globalThis as any).chrome?.declarativeNetRequest ?? (browser as any).declarativeNetRequest;
}

async function addCorsRule(url: string, pageUrl?: string): Promise<number> {
  const dnr = getDeclarativeNetRequest();
  if (!dnr?.updateSessionRules) return 0;

  const ruleId = nextCorsRuleId++;
  const origin = pageUrl ? new URL(pageUrl).origin : "*";

  await dnr.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { operation: "set", header: "Access-Control-Allow-Origin", value: origin },
          { operation: "set", header: "Access-Control-Allow-Credentials", value: "true" },
        ],
      },
      condition: {
        urlFilter: url,
        resourceTypes: ["xmlhttprequest"],
      },
    }],
  });

  return ruleId;
}

async function removeCorsRule(ruleId: number): Promise<void> {
  if (ruleId === 0) return;
  const dnr = getDeclarativeNetRequest();
  if (!dnr?.updateSessionRules) return;
  await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => { });
}

/**
 * Run `fn` with the CDN temporarily reachable: a CORS rule scoped to
 * `contentUrl` and the host registered for Referer rewriting. Both are undone
 * afterwards regardless of outcome, so a failed candidate leaves nothing behind.
 */
export async function withCdnAccess<T>(
  contentUrl: string,
  pageUrl: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ruleId = await addCorsRule(contentUrl, pageUrl).catch(() => 0);
  const host = registrableDomainOfUrl(contentUrl);
  if (host) activeImportHosts.add(host);
  try {
    return await fn();
  } finally {
    await removeCorsRule(ruleId);
    if (host) activeImportHosts.delete(host);
  }
}

/**
 * Register the webRequest listeners. Called once at worker start.
 *
 * Chrome MV3 has no blocking webRequest (it is enterprise-only) and the
 * manifest omits the permission there, so both listeners simply never attach.
 */
export function installCdnHeaderRewriting(): void {
  installRefererRewriting();
  installCorsFallback();
}

// Native Referer injection for extension popup image loads.
// When the popup's <img> tries to load a CDN-protected image the browser sends
// the extension origin as Referer, which hotlink protection blocks. We replace
// it with the request host's own registrable domain so the check passes
// natively. Only requests from the extension context (tabId === -1) that are
// either image loads (popup previews) or part of an active import fetch are
// touched — unrelated traffic (e.g. szurubooru API calls) is never modified.
function installRefererRewriting(): void {
  const webRequest = (browser as any).webRequest;
  if (!webRequest?.onBeforeSendHeaders) return;

  try {
    webRequest.onBeforeSendHeaders.addListener(
      (details: any) => {
        if (details.tabId !== -1) return {};
        try {
          const base = registrableDomain(new URL(details.url).hostname);
          if (details.type !== "image" && !activeImportHosts.has(base)) return {};
          const spoofedReferer = `https://${base}/`;
          const headers: Array<{ name: string; value: string }> = details.requestHeaders ?? [];
          const idx = headers.findIndex((h: any) => h.name.toLowerCase() === "referer");
          if (idx >= 0) {
            headers[idx] = { name: "Referer", value: spoofedReferer };
          } else {
            headers.push({ name: "Referer", value: spoofedReferer });
          }
          return { requestHeaders: headers };
        } catch {
          return {};
        }
      },
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"],
    );
  } catch (ex) {
    console.warn("webRequest.onBeforeSendHeaders blocking not available:", ex);
  }
}

// Inject CORS headers into CDN responses so content-script fetch() calls
// (running in the page context) can read image bytes cross-origin.
// This is a fallback ONLY for browsers without declarativeNetRequest session
// rules. On modern Chrome/Firefox withCdnAccess handles this per-import, so we
// don't register the listener at all — avoiding any browser-wide webRequest cost.
function installCorsFallback(): void {
  if (getDeclarativeNetRequest()?.updateSessionRules) return;

  const webRequest = (browser as any).webRequest;
  if (!webRequest?.onHeadersReceived) return;

  try {
    webRequest.onHeadersReceived.addListener(
      (details: any) => {
        if (activeImportHosts.size === 0) return {};
        const base = registrableDomainOfUrl(details.url);
        if (!base || !activeImportHosts.has(base)) return {};

        const headers: Array<{ name: string; value: string }> = [...(details.responseHeaders ?? [])];
        if (headers.some((h: any) => h.name.toLowerCase() === "access-control-allow-origin")) {
          return {};
        }

        // Echo the requesting page's origin when known, else fall back to the
        // request host's own registrable domain.
        let origin: string | undefined;
        try {
          if (details.originUrl) origin = new URL(details.originUrl).origin;
        } catch { /* ignore */ }
        if (!origin) origin = `https://${base}`;

        headers.push({ name: "Access-Control-Allow-Origin", value: origin });
        headers.push({ name: "Access-Control-Allow-Credentials", value: "true" });
        return { responseHeaders: headers };
      },
      { urls: ["<all_urls>"], types: ["xmlhttprequest"] },
      ["blocking", "responseHeaders"],
    );
  } catch (ex) {
    console.warn("webRequest.onHeadersReceived CORS injection not available:", ex);
  }
}

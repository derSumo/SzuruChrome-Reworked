/** URL / hostname normalisation shared across every extension context. */

/**
 * Host of a URL, lowercased and without a leading "www.".
 * Returns undefined for anything that isn't a parsable URL.
 */
export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * Normalise user input that may be either a bare host ("example.com") or a
 * full URL. Falls back to a lowercased string so a typo still round-trips
 * instead of vanishing from the list it was typed into.
 */
export function normalizeHost(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed);
    return url.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, "");
  }
}

/** True when `pageUrl`'s host equals one of `patterns`, or is a subdomain of it. */
export function hostMatchesAny(pageUrl: string | undefined, patterns: string[] | undefined): boolean {
  const host = normalizeHost(pageUrl);
  if (!host || !patterns?.length) return false;
  return patterns.some((entry) => {
    const target = normalizeHost(entry);
    if (!target) return false;
    return host === target || host.endsWith("." + target);
  });
}

// Common second-level public suffixes. Not a full PSL — enough to keep
// "images.example.co.uk" from collapsing to "co.uk".
const MULTI_PART_SLDS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);

/**
 * Derive the registrable (parent) domain from a host, so a same-site
 * Referer/Origin can be built for hotlink-protected CDNs served from a
 * subdomain — without hardcoding any specific site.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const sld = labels[labels.length - 2];
  if (MULTI_PART_SLDS.has(sld) && labels.length >= 3) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

/** Registrable domain of a full URL, or undefined when it can't be parsed. */
export function registrableDomainOfUrl(url: string): string | undefined {
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** Join a szurubooru base URL with path segments, collapsing stray slashes. */
export function getUrl(root: string, ...parts: string[]): string {
  let url = root.replace(/\/+$/, "");
  for (const part of parts) {
    url += "/" + part.replace(/\/+$/, "");
  }
  return url;
}

/** Canonical post URL for an instance domain. */
export function postUrlFor(domain: string, postId: number): string {
  return `${domain.replace(/\/+$/, "")}/post/${postId}`;
}

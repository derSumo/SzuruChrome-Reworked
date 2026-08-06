// ── Supported source sites and runtime host permissions ─────────────────
//
// Content scripts are deliberately registered only for these known scraper
// sources. Keeping this list separate from neo-scraper's runtime classes makes
// it usable by the manifest, background worker and options UI without pulling
// the (large) scraper bundle into the latter two contexts.

export interface SourceSite {
  /** Stable ID for Vue keys and diagnostics. */
  id: string;
  /** Human-readable domain shown in the access settings. */
  label: string;
  /** A registrable host; its www/subdomains are included in the match pattern. */
  host: string;
}

export const SOURCE_SITES: readonly SourceSite[] = [
  { id: "anime-pictures", label: "anime-pictures.net", host: "anime-pictures.net" },
  { id: "bluesky", label: "bsky.app", host: "bsky.app" },
  { id: "donmai", label: "Danbooru / Donmai", host: "donmai.us" },
  { id: "e621", label: "e621.net", host: "e621.net" },
  { id: "e926", label: "e926.net", host: "e926.net" },
  { id: "ehentai", label: "e-hentai.org", host: "e-hentai.org" },
  { id: "exhentai", label: "exhentai.org", host: "exhentai.org" },
  { id: "furaffinity", label: "furaffinity.net", host: "furaffinity.net" },
  { id: "gelbooru", label: "gelbooru.com", host: "gelbooru.com" },
  { id: "safebooru", label: "safebooru.org", host: "safebooru.org" },
  { id: "rule34xxx", label: "rule34.xxx", host: "rule34.xxx" },
  { id: "tbib", label: "tbib.org", host: "tbib.org" },
  { id: "xbooru", label: "xbooru.com", host: "xbooru.com" },
  { id: "mspabooru", label: "mspabooru.com", host: "mspabooru.com" },
  { id: "hypnohub", label: "hypnohub.net", host: "hypnohub.net" },
  { id: "inkbunny", label: "inkbunny.net", host: "inkbunny.net" },
  { id: "yandere", label: "yande.re", host: "yande.re" },
  { id: "konachan-com", label: "konachan.com", host: "konachan.com" },
  { id: "konachan-net", label: "konachan.net", host: "konachan.net" },
  { id: "sakugabooru", label: "sakugabooru.com", host: "sakugabooru.com" },
  { id: "genshiken", label: "img.genshiken-itb.org", host: "img.genshiken-itb.org" },
  { id: "nozomi", label: "nozomi.la", host: "nozomi.la" },
  { id: "derpibooru", label: "derpibooru.org", host: "derpibooru.org" },
  { id: "trixiebooru", label: "trixiebooru.org", host: "trixiebooru.org" },
  { id: "ponybooru", label: "ponybooru.org", host: "ponybooru.org" },
  { id: "furbooru", label: "furbooru.org", host: "furbooru.org" },
  { id: "ponerpics", label: "ponerpics.org", host: "ponerpics.org" },
  { id: "manebooru", label: "manebooru.art", host: "manebooru.art" },
  { id: "twibooru", label: "twibooru.org", host: "twibooru.org" },
  { id: "pixiv", label: "pixiv.net", host: "pixiv.net" },
  { id: "reddit", label: "reddit.com", host: "reddit.com" },
  { id: "rule34us", label: "rule34.us", host: "rule34.us" },
  { id: "sankaku", label: "chan.sankakucomplex.com", host: "sankakucomplex.com" },
  { id: "paheal", label: "rule34.paheal.net", host: "paheal.net" },
  { id: "rule34hentai", label: "rule34hentai.net", host: "rule34hentai.net" },
  { id: "shuushuu", label: "e-shuushuu.net", host: "e-shuushuu.net" },
  { id: "twitter", label: "twitter.com", host: "twitter.com" },
  { id: "x", label: "x.com", host: "x.com" },
  { id: "zerochan", label: "zerochan.net", host: "zerochan.net" },
];

function patternsForHost(host: string): string[] {
  return [`https://*.${host}/*`, `http://*.${host}/*`];
}

/** All supported source match patterns, suitable for dynamic registration. */
export const SOURCE_SITE_MATCH_PATTERNS = SOURCE_SITES.flatMap((site) => patternsForHost(site.host));

/** Whether a URL belongs to one of the shipped scraper engines. */
export function isSupportedSourceUrl(rawUrl: string): boolean {
  return !!sourceSiteForUrl(rawUrl);
}

/** Find the supported source-site entry responsible for a page URL. */
export function sourceSiteForUrl(rawUrl: string): SourceSite | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return SOURCE_SITES.find((site) => host === site.host || host.endsWith(`.${site.host}`));
  } catch {
    return undefined;
  }
}

/** The two protocol patterns required for one entry in the site-access UI. */
export function sourceSitePermissionPatterns(site: SourceSite): string[] {
  return patternsForHost(site.host);
}

/** True when both HTTP and HTTPS access to a supported source has been granted. */
export function hasSourceSitePermission(site: SourceSite): Promise<boolean> {
  return browser.permissions.contains({ origins: sourceSitePermissionPatterns(site) });
}

/** Request only one site's access, from a user-initiated options-page click. */
export function requestSourceSitePermission(site: SourceSite): Promise<boolean> {
  return browser.permissions.request({ origins: sourceSitePermissionPatterns(site) });
}

/** Remove only one site's access and leave all other optional grants untouched. */
export function removeSourceSitePermission(site: SourceSite): Promise<boolean> {
  return browser.permissions.remove({ origins: sourceSitePermissionPatterns(site) });
}

/**
 * Source-site patterns currently available to automatic content scripts.
 * Registration must contain only granted origins; otherwise Chrome rejects it.
 */
export async function getGrantedSourceSiteMatchPatterns(): Promise<string[]> {
  const granted = await Promise.all(SOURCE_SITES.map(async (site) => (
    await hasSourceSitePermission(site) ? sourceSitePermissionPatterns(site) : []
  )));
  return granted.flat();
}

/** Match pattern for a user-configured Szurubooru instance. */
export function instancePermissionPattern(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return undefined;
  }
}

/** A configured instance needs host access for the extension's API requests. */
export async function ensureInstancePermission(rawUrl: string): Promise<boolean> {
  const origin = instancePermissionPattern(rawUrl);
  if (!origin) return false;
  // Call request directly from the button's click stack. Awaiting a preliminary
  // `contains()` check can consume Chrome's user activation and suppress the
  // permission prompt. Requesting an already granted origin is a no-op.
  return browser.permissions.request({ origins: [origin] });
}

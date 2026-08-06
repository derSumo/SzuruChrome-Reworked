// ── Booru listing pages: post links, pagination, search URLs ──────────
// Pure URL logic behind the batch importer's "all pages" crawl. It has to work
// on every booru without per-site code, so nothing here hardcodes a host — the
// shapes below are derived from the page the user is already standing on.
//
// The DOM-touching parts take an explicit `pageUrl` instead of reading
// `window.location`, because the crawler parses *fetched* pages with DOMParser:
// such a document inherits the base URI of the document that created it, so
// `anchor.href` would resolve relative links against the wrong page.

/** Same-origin anchors whose href looks like a post-detail page. */
const POST_URL_PATTERNS = [
  /\/posts\/\d+/,            // Danbooru, e621
  /\/post\/show\/\d+/,       // Moebooru (yande.re, konachan)
  /\/post\/view\/\d+/,       // Shimmie2
  /[?&]id=\d+/,              // Gelbooru / rule34 (index.php?page=post&s=view&id=)
  /\/post\/\d+(?:[/?#]|$)/,  // generic /post/123
];

/**
 * Query parameters used for pagination. Only these may appear on a candidate
 * link while being absent from the current URL — "page 1" usually omits them.
 * Any other new parameter (`id`, `s`, …) means the link is not a next page.
 */
const PAGINATION_PARAMS = new Set(["pid", "page", "p", "offset", "start", "from", "skip", "after_id"]);

/** Link labels that mean "next page" on their own. "Last »" deliberately misses. */
const NEXT_LABEL = /^(?:>{1,2}|»|›|→|next(?:\s*(?:page|>{1,2}|»))?|nächste(?:\s*seite)?|weiter)$/i;

export interface NextPageCandidate {
  href: string;
  rel?: string | null;
  text?: string | null;
  ariaLabel?: string | null;
  alt?: string | null;
}

function parse(url: string, base?: string): URL | undefined {
  try {
    return new URL(url, base);
  } catch {
    return undefined;
  }
}

function stripHash(url: URL): string {
  return url.origin + url.pathname + url.search;
}

/** True when `href` points at a post-detail page of the same site as `pageUrl`. */
export function isPostDetailUrl(href: string, pageUrl: string): boolean {
  const url = parse(href, pageUrl);
  const page = parse(pageUrl);
  if (!url || !page) return false;
  if (url.host !== page.host) return false;
  // Don't offer the very page we're looking at as one of its own candidates.
  if (stripHash(url) === stripHash(page)) return false;
  return POST_URL_PATTERNS.some((re) => re.test(url.pathname + url.search));
}

/** Absolute, hash-free post URL, or undefined when `href` isn't one. */
export function normalizePostUrl(href: string, pageUrl: string): string | undefined {
  if (!isPostDetailUrl(href, pageUrl)) return undefined;
  const url = parse(href, pageUrl);
  return url ? stripHash(url) : undefined;
}

/**
 * Post URLs linked from a listing document, in document order and de-duplicated.
 * An anchor only counts when it wraps a thumbnail — that is what separates the
 * post grid from the navigation, tag sidebar and comment links.
 */
export function extractPostUrls(doc: Document, pageUrl: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    if (!anchor.querySelector("img")) continue;
    const url = normalizePostUrl(anchor.getAttribute("href") ?? "", pageUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/**
 * How much further into the listing `candidate` is, or undefined when it isn't
 * simply a later page of the same listing.
 *
 * A next-page link differs from the current URL in exactly one numeric token —
 * either one path segment (`/post/list/tag/2`) or one query parameter
 * (`?page=2`, `&pid=42`) — and that token must have grown. Everything else
 * (tags, sort order, the post id of a detail page) has to match exactly, which
 * is what keeps post links and unrelated navigation out.
 */
function pageDistance(current: URL, candidate: URL): number | undefined {
  if (current.origin !== candidate.origin) return undefined;

  if (current.pathname !== candidate.pathname) {
    // A path-numbered listing may only differ in that one segment.
    if (current.search !== candidate.search) return undefined;
    const a = current.pathname.split("/");
    const b = candidate.pathname.split("/");
    if (a.length !== b.length) return undefined;
    const differing = a.map((_, i) => i).filter((i) => a[i] !== b[i]);
    if (differing.length !== 1) return undefined;
    const [i] = differing;
    if (!/^\d+$/.test(a[i]) || !/^\d+$/.test(b[i])) return undefined;
    const delta = Number(b[i]) - Number(a[i]);
    return delta > 0 ? delta : undefined;
  }

  const keys = new Set([...current.searchParams.keys(), ...candidate.searchParams.keys()]);
  let delta: number | undefined;
  for (const key of keys) {
    const from = current.searchParams.getAll(key).join(",");
    const to = candidate.searchParams.getAll(key).join(",");
    if (from === to) continue;
    if (delta !== undefined) return undefined; // more than one difference

    // "Page 1" typically omits the parameter entirely, so an absent value reads
    // as 0 — but only for a parameter we know paginates.
    const fromValue = from === "" && PAGINATION_PARAMS.has(key) ? 0 : Number(from);
    const toValue = Number(to);
    if (!Number.isFinite(fromValue) || !Number.isFinite(toValue) || to === "") return undefined;
    if (toValue <= fromValue) return undefined;
    delta = toValue - fromValue;
  }
  return delta;
}

/**
 * The next page of the listing at `currentUrl`, picked from the page's links.
 *
 * Explicit markers win (`rel="next"`, then a "next"-ish label); otherwise the
 * paginator is read numerically and the *nearest* higher page wins, so a
 * "Last »" link can't make the crawl skip everything in between.
 */
export function pickNextPageUrl(currentUrl: string, candidates: NextPageCandidate[]): string | undefined {
  const current = parse(currentUrl);
  if (!current) return undefined;

  const resolved = candidates
    .map((c) => ({ ...c, url: parse(c.href, currentUrl) }))
    .filter((c): c is typeof c & { url: URL } => !!c.url
      && c.url.origin === current.origin
      && stripHash(c.url) !== stripHash(current));

  const labelled = resolved.find((c) => /(?:^|\s)next(?:\s|$)/i.test(c.rel ?? ""))
    ?? resolved.find((c) => [c.text, c.ariaLabel, c.alt].some((v) => NEXT_LABEL.test((v ?? "").trim())));
  if (labelled) return stripHash(labelled.url);

  let best: { url: URL; delta: number } | undefined;
  for (const c of resolved) {
    const delta = pageDistance(current, c.url);
    if (delta === undefined) continue;
    if (!best || delta < best.delta) best = { url: c.url, delta };
  }
  return best ? stripHash(best.url) : undefined;
}

/** Read the anchors of a listing document as next-page candidates. */
export function nextPageCandidates(doc: Document): NextPageCandidate[] {
  const links = Array.from(doc.querySelectorAll("a[href], link[rel][href]"));
  return links.map((el) => ({
    href: el.getAttribute("href") ?? "",
    rel: el.getAttribute("rel"),
    text: el.textContent,
    ariaLabel: el.getAttribute("aria-label"),
    alt: el.getAttribute("alt"),
  })).filter((c) => c.href && !c.href.startsWith("#") && !/^javascript:/i.test(c.href));
}

export interface ResolvedMedia {
  url: string;
  kind: "image" | "video";
}

/**
 * The full-size media a post page shows, read from its markup.
 *
 * Used by the hover preview, which needs the real file rather than the 150px
 * thumbnail. Deliberately ordered from "the site told us" to "we guessed":
 * boorus overwhelmingly publish an og:image or a data-file-url, and only when
 * both are missing does this fall back to picking the biggest <img> around.
 */
export function resolveMediaUrl(doc: Document, pageUrl: string): ResolvedMedia | undefined {
  const abs = (value?: string | null): string | undefined => {
    if (!value) return undefined;
    const url = parse(value.trim(), pageUrl);
    return url && (url.protocol === "http:" || url.protocol === "https:") ? url.href : undefined;
  };

  // Video first: a post with a video also carries a poster image, and showing
  // the poster while a video exists would be the wrong preview.
  const videoSrc = abs(doc.querySelector("video source[src]")?.getAttribute("src"))
    ?? abs(doc.querySelector("video[src]")?.getAttribute("src"));
  if (videoSrc) return { url: videoSrc, kind: "video" };

  // Danbooru-style: the file URL is an attribute on the image container.
  const dataFileUrl = abs(doc.querySelector("[data-file-url]")?.getAttribute("data-file-url"));
  if (dataFileUrl) return { url: dataFileUrl, kind: /\.(mp4|webm|mkv)(\?|$)/i.test(dataFileUrl) ? "video" : "image" };

  const meta = abs(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"))
    ?? abs(doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content"));
  if (meta) return { url: meta, kind: "image" };

  // Gelbooru/rule34/Moebooru/Shimmie all name their main image tag.
  const named = doc.querySelector<HTMLImageElement>("img#image, img#img, img.fit-width, img#main_image");
  const namedSrc = abs(named?.getAttribute("src"));
  if (namedSrc) return { url: namedSrc, kind: "image" };

  // Last resort: the biggest image on the page that isn't an icon.
  let best: { url: string; area: number } | undefined;
  for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const url = abs(img.getAttribute("src"));
    if (!url) continue;
    const width = Number(img.getAttribute("width")) || 0;
    const height = Number(img.getAttribute("height")) || 0;
    const area = width * height;
    if (area < 40_000) continue; // smaller than ~200×200 is chrome, not content
    if (!best || area > best.area) best = { url, area };
  }
  return best ? { url: best.url, kind: "image" } : undefined;
}

/**
 * Rewrite the listing URL the user is on to search for `query` instead —
 * that's how "everything from user X" works without knowing the site: the page
 * already tells us the shape of its own search.
 *
 * Returns undefined when the URL isn't a recognisable search, so the caller can
 * say so instead of navigating somewhere meaningless.
 */
export function buildSearchUrl(currentUrl: string, query: string): string | undefined {
  const url = parse(currentUrl);
  const tags = query.trim();
  if (!url || !tags) return undefined;

  const applyTagsParam = () => {
    url.searchParams.set("tags", tags);
    for (const key of PAGINATION_PARAMS) {
      // Only drop a numeric value: Gelbooru routes with `page=post`, and
      // deleting that turns the search URL into the site's front page.
      const value = url.searchParams.get(key);
      if (value !== null && /^\d*$/.test(value)) url.searchParams.delete(key);
    }
    return stripHash(url);
  };

  // Danbooru/e621/Gelbooru/Moebooru: the listing already carries a tags param,
  // or is one of the well-known listing paths where adding it works.
  if (url.searchParams.has("tags")) return applyTagsParam();

  // Shimmie2: /post/list/<tags>/<page> — the search lives in the path.
  const shimmie = url.pathname.match(/^(.*\/post\/list)(?:\/[^/]*)?(?:\/\d+)?\/?$/);
  if (shimmie) {
    url.pathname = `${shimmie[1]}/${encodeURIComponent(tags)}/1`;
    url.search = "";
    return stripHash(url);
  }

  if (/\/(?:posts|post)\/?$/.test(url.pathname) || url.pathname.endsWith("/index.php")) {
    return applyTagsParam();
  }

  return undefined;
}

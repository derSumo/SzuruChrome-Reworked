// ── Endless scroll for listing pages ──────────────────────────────────
// Paging through a booru 42 posts at a time is the main reason a bulk import
// takes so long to assemble. With this on, the next page is fetched and its
// thumbnails are appended to the grid the user is already looking at — the
// selection, the "already imported" marks and the hover actions all keep
// working, because it is still the same document.
//
// Opt-in, and deliberately conservative: it only ever appends into the grid it
// found the current posts in, it stops at the first page that yields nothing,
// and it never touches a page whose pagination it cannot read.

import { t } from "~/i18n";
import { extractPostUrls, nextPageCandidates, normalizePostUrl, pickNextPageUrl } from "~/shared/listing";
import { getListingSettings, onConfigReloaded } from "../pageConfig";
import { onNavigation } from "../navigation";

const SENTINEL_ID = "szuru-endless-sentinel";
const STYLE_ID = "szuru-endless-style";

/** Start fetching this far before the sentinel is actually on screen. */
const PREFETCH_MARGIN = "800px";
/** Politeness gap between two page loads. */
const PAGE_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 20_000;
/** Hard stop, so an infinite listing cannot grow the DOM without bound. */
const MAX_PAGES = 40;

const STYLES = `
  #${SENTINEL_ID}{display:flex;align-items:center;justify-content:center;gap:8px;
    width:100%;padding:18px 8px;box-sizing:border-box;
    font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    color:rgba(140,140,160,.9);}
  #${SENTINEL_ID} .szes-spin{width:15px;height:15px;border-radius:50%;
    border:2px solid rgba(140,140,160,.35);border-top-color:rgba(140,140,160,.95);
    animation:szes-spin .7s linear infinite}
  @keyframes szes-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){#${SENTINEL_ID} .szes-spin{animation:none}}
`;

let observer: IntersectionObserver | undefined;
let sentinel: HTMLElement | undefined;
let container: HTMLElement | undefined;
let nextUrl: string | undefined;
let loading = false;
let pagesLoaded = 0;
let installed = false;
let enabled = false;

/** URLs already on the page, so an overlapping next page adds nothing twice. */
const seenPosts = new Set<string>();

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

function postAnchors(root: ParentNode, pageUrl: string): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter((a) => a.querySelector("img") && normalizePostUrl(a.getAttribute("href") ?? "", pageUrl));
}

/**
 * The element the post grid lives in: the deepest node that contains all the
 * thumbnails. Appending anywhere else would drop the new posts outside the
 * layout the site set up for them.
 */
function findGrid(root: Document, pageUrl: string): HTMLElement | undefined {
  const anchors = postAnchors(root, pageUrl);
  if (anchors.length < 2) return undefined;

  // Walk up from the first anchor until an ancestor holds most of the others.
  let node: HTMLElement | null = anchors[0].parentElement;
  while (node && node !== root.body) {
    const inside = anchors.filter((a) => node!.contains(a)).length;
    if (inside >= Math.max(2, Math.floor(anchors.length * 0.8))) return node;
    node = node.parentElement;
  }
  return undefined;
}

function setSentinel(state: "idle" | "loading" | "end" | "error"): void {
  if (!sentinel) return;
  switch (state) {
    case "loading":
      sentinel.innerHTML = `<span class="szes-spin"></span><span>${t("batch.moreLoading") || "Loading next page…"}</span>`;
      break;
    case "end":
      sentinel.textContent = t("batch.moreEnd") || "End of the listing";
      break;
    case "error":
      sentinel.textContent = t("batch.moreFailed") || "Could not load the next page";
      break;
    default:
      sentinel.textContent = "";
  }
}

function stop(state: "end" | "error"): void {
  observer?.disconnect();
  setSentinel(state);
  nextUrl = undefined;
}

async function loadNextPage(): Promise<void> {
  if (loading || !nextUrl || !container) return;
  if (pagesLoaded >= MAX_PAGES) { stop("end"); return; }

  loading = true;
  const url = nextUrl;
  setSentinel("loading");

  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");

    const fetchedUrls = extractPostUrls(doc, url);
    if (fetchedUrls.length === 0) { stop("end"); return; }

    // Import the nodes rather than moving them: the fetched document stays
    // intact, and adoption keeps event-less markup working in this document.
    const grid = findGrid(doc, url);
    let appended = 0;
    for (const anchor of postAnchors(grid ?? doc, url)) {
      const postUrl = normalizePostUrl(anchor.getAttribute("href") ?? "", url);
      if (!postUrl || seenPosts.has(postUrl)) continue;
      seenPosts.add(postUrl);

      // Take the anchor's own wrapper when it has one (most boorus wrap each
      // thumbnail in a span/article that carries the grid's spacing).
      const source = anchor.parentElement && grid?.contains(anchor.parentElement) && anchor.parentElement !== grid
        ? anchor.parentElement
        : anchor;
      const node = document.importNode(source, true);
      absolutizeUrls(node as HTMLElement, url);
      container.appendChild(node);
      appended++;
    }

    pagesLoaded++;
    if (appended === 0) { stop("end"); return; }

    nextUrl = pickNextPageUrl(url, nextPageCandidates(doc));
    if (!nextUrl) { stop("end"); return; }

    setSentinel("idle");
    // Keep the sentinel last so it stays below everything just added.
    container.parentElement?.appendChild(sentinel!);
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  } catch {
    stop("error");
  } finally {
    loading = false;
  }
}

/**
 * Relative `href`/`src` in the fetched markup resolve against *this* page once
 * the node is adopted, which on a paginated URL is not where they came from.
 */
function absolutizeUrls(root: HTMLElement, base: string): void {
  const fix = (el: Element, attr: string) => {
    const raw = el.getAttribute(attr);
    if (!raw || /^(data:|https?:|#|javascript:)/i.test(raw)) return;
    try {
      el.setAttribute(attr, new URL(raw, base).href);
    } catch { /* leave it alone */ }
  };
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (el.hasAttribute("href")) fix(el, "href");
    if (el.hasAttribute("src")) fix(el, "src");
  }
}

async function refresh(): Promise<void> {
  observer?.disconnect();
  observer = undefined;
  sentinel?.remove();
  sentinel = undefined;
  seenPosts.clear();
  pagesLoaded = 0;
  loading = false;

  const listing = await getListingSettings();
  enabled = listing.endlessScroll;
  if (!enabled) return;

  container = findGrid(document, window.location.href);
  if (!container) return;

  nextUrl = pickNextPageUrl(window.location.href, nextPageCandidates(document));
  if (!nextUrl) return;

  for (const url of extractPostUrls(document, window.location.href)) seenPosts.add(url);

  ensureStyles();
  sentinel = document.createElement("div");
  sentinel.id = SENTINEL_ID;
  (container.parentElement ?? container).appendChild(sentinel);

  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadNextPage();
  }, { rootMargin: PREFETCH_MARGIN });
  observer.observe(sentinel);
}

export function installEndlessScroll(): void {
  if (installed) return;
  installed = true;
  onNavigation(() => void refresh());
  onConfigReloaded(() => void refresh());
  void refresh();
}

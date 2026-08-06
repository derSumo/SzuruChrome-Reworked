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

/** Start fetching far enough ahead that scrolling does not hit a blank end. */
const PREFETCH_MARGIN = "1400px";
const FETCH_TIMEOUT_MS = 20_000;
/** Hard stop, so an infinite listing cannot grow the DOM without bound. */
const MAX_PAGES = 40;

const STYLES = `
  #${SENTINEL_ID}{display:flex;align-items:center;justify-content:center;gap:8px;
    width:100%;min-height:48px;padding:14px 8px;box-sizing:border-box;
    font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    color:rgba(140,140,160,.92);font-variant-numeric:tabular-nums;
    transition:color .2s ease,opacity .2s ease;}
  #${SENTINEL_ID} .szes-track{position:relative;width:32px;height:4px;overflow:hidden;
    border-radius:999px;background:rgba(140,140,160,.2)}
  #${SENTINEL_ID} .szes-track::after{content:"";position:absolute;inset:0;width:45%;
    border-radius:inherit;background:rgba(140,180,255,.95);animation:szes-sweep 1.05s ease-in-out infinite}
  #${SENTINEL_ID} .szes-spin{width:15px;height:15px;border-radius:50%;
    border:2px solid rgba(140,140,160,.35);border-top-color:rgba(140,140,160,.95);
    animation:szes-spin .7s linear infinite}
  #${SENTINEL_ID} .szes-retry{margin-left:4px;padding:4px 8px;border:1px solid rgba(140,180,255,.38);
    border-radius:999px;background:rgba(105,145,220,.13);color:inherit;font:inherit;cursor:pointer;
    transition:background .15s ease,border-color .15s ease}
  #${SENTINEL_ID} .szes-retry:hover{background:rgba(105,145,220,.26);border-color:rgba(140,180,255,.72)}
  #${SENTINEL_ID}.is-end{color:rgba(120,190,145,.9)}
  #${SENTINEL_ID}.is-error{color:rgba(240,150,140,.96)}
  @keyframes szes-spin{to{transform:rotate(360deg)}}
  @keyframes szes-sweep{from{transform:translateX(-120%)}to{transform:translateX(280%)}}
  @media (prefers-reduced-motion:reduce){#${SENTINEL_ID} .szes-spin,#${SENTINEL_ID} .szes-track::after{animation:none}}
`;

let observer: IntersectionObserver | undefined;
let sentinel: HTMLElement | undefined;
let container: HTMLElement | undefined;
let nextUrl: string | undefined;
let loading = false;
let pagesLoaded = 0;
let installed = false;
let enabled = false;
let generation = 0;
let loadController: AbortController | undefined;
let continuationQueued = false;
let sentinelState: "ready" | "loading" | "end" | "limit" | "error" = "ready";

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

function sentinelText(key: "batch.moreLoading" | "batch.moreReady" | "batch.moreEnd" | "batch.moreFailed" | "batch.moreLimit", fallback: string): string {
  return t(key, { pages: pagesLoaded, page: pagesLoaded + 1, posts: seenPosts.size }) || fallback;
}

function retry(): void {
  if (!sentinel || !nextUrl || !container || loading) return;
  observer?.observe(sentinel);
  void loadNextPage();
}

function setSentinel(state: "ready" | "loading" | "end" | "limit" | "error"): void {
  if (!sentinel) return;
  sentinelState = state;
  sentinel.classList.toggle("is-end", state === "end" || state === "limit");
  sentinel.classList.toggle("is-error", state === "error");
  sentinel.replaceChildren();

  const label = document.createElement("span");
  switch (state) {
    case "loading":
      sentinel.insertAdjacentHTML("beforeend", '<span class="szes-spin" aria-hidden="true"></span>');
      label.textContent = sentinelText("batch.moreLoading", `Loading page ${pagesLoaded + 1}…`);
      break;
    case "ready":
      sentinel.insertAdjacentHTML("beforeend", '<span class="szes-track" aria-hidden="true"></span>');
      label.textContent = sentinelText("batch.moreReady", `${pagesLoaded} pages loaded · keep scrolling`);
      break;
    case "end":
      label.textContent = sentinelText("batch.moreEnd", `End of the listing · ${seenPosts.size} posts loaded`);
      break;
    case "limit":
      label.textContent = sentinelText("batch.moreLimit", `${pagesLoaded} pages loaded · safety limit reached`);
      break;
    case "error": {
      label.textContent = sentinelText("batch.moreFailed", "Could not load the next page");
      const button = document.createElement("button");
      button.className = "szes-retry";
      button.type = "button";
      button.textContent = t("batch.moreRetry") || "Retry";
      button.addEventListener("click", retry);
      sentinel.append(label, button);
      return;
    }
  }
  sentinel.appendChild(label);
}

/**
 * IntersectionObserver only reports a threshold transition. If it fired while
 * a page was still loading, the sentinel can remain in view afterwards without
 * another callback — which used to leave the loader looking idle forever.
 */
function continueWhileNear(): void {
  if (continuationQueued || loading || sentinelState !== "ready" || !nextUrl || !sentinel) return;
  continuationQueued = true;
  requestAnimationFrame(() => {
    continuationQueued = false;
    if (loading || sentinelState !== "ready" || !nextUrl || !sentinel?.isConnected) return;
    const bounds = sentinel.getBoundingClientRect();
    const margin = Number.parseInt(PREFETCH_MARGIN, 10) || 0;
    const closeEnough = bounds.top <= window.innerHeight + margin && bounds.bottom >= -margin;
    if (closeEnough) void loadNextPage();
  });
}

function stop(state: "end" | "limit" | "error"): void {
  observer?.disconnect();
  setSentinel(state);
  // An error can be retried without making the user reload the whole listing.
  if (state !== "error") nextUrl = undefined;
}

async function loadNextPage(): Promise<void> {
  if (loading || !nextUrl || !container) return;
  if (pagesLoaded >= MAX_PAGES) { stop("limit"); return; }

  loading = true;
  const loadGeneration = generation;
  const url = nextUrl;
  const target = container;
  const controller = new AbortController();
  loadController = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  setSentinel("loading");

  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    // A pjax navigation/config change may have started a newer listing while
    // this response was in flight. Never append an old page into that listing.
    if (loadGeneration !== generation || controller.signal.aborted) return;

    const fetchedUrls = extractPostUrls(doc, url);
    if (fetchedUrls.length === 0) { stop("end"); return; }

    // Import the nodes rather than moving them: the fetched document stays
    // intact, and adoption keeps event-less markup working in this document.
    const grid = findGrid(doc, url);
    let appended = 0;
    const fragment = document.createDocumentFragment();
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
      // The next page may be well below the viewport. Let the browser defer
      // its image requests instead of competing with the thumbnails in view.
      for (const image of Array.from((node as HTMLElement).querySelectorAll<HTMLImageElement>("img"))) {
        if (!image.hasAttribute("loading")) image.loading = "lazy";
      }
      fragment.appendChild(node);
      appended++;
    }

    pagesLoaded++;
    if (appended === 0) { stop("end"); return; }

    // One insertion avoids a layout/repaint cycle for every single thumbnail.
    target.appendChild(fragment);
    nextUrl = pickNextPageUrl(url, nextPageCandidates(doc));
    if (!nextUrl) { stop("end"); return; }

    setSentinel("ready");
    // Keep the sentinel last so it stays below everything just added.
    target.parentElement?.appendChild(sentinel!);
  } catch {
    // Refreshes cancel the old request silently; a real timeout remains
    // visible and retryable instead of leaving the sentinel stuck on loading.
    if (loadGeneration === generation && (!controller.signal.aborted || timedOut)) stop("error");
  } finally {
    clearTimeout(timeout);
    if (loadController === controller) loadController = undefined;
    if (loadGeneration === generation) {
      loading = false;
      continueWhileNear();
    }
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
  generation++;
  loadController?.abort();
  loadController = undefined;
  observer?.disconnect();
  observer = undefined;
  sentinel?.remove();
  sentinel = undefined;
  seenPosts.clear();
  pagesLoaded = 0;
  loading = false;
  continuationQueued = false;

  const listing = await getListingSettings();
  enabled = listing.endlessScroll;
  if (!enabled) return;

  container = findGrid(document, window.location.href);
  if (!container) return;

  for (const url of extractPostUrls(document, window.location.href)) seenPosts.add(url);

  ensureStyles();
  sentinel = document.createElement("div");
  sentinel.id = SENTINEL_ID;
  sentinel.setAttribute("role", "status");
  sentinel.setAttribute("aria-live", "polite");
  (container.parentElement ?? container).appendChild(sentinel);

  nextUrl = pickNextPageUrl(window.location.href, nextPageCandidates(document));
  if (!nextUrl) { setSentinel("end"); return; }
  setSentinel("ready");

  observer = new IntersectionObserver((entries) => {
    const entry = entries.find((e) => e.target === sentinel);
    if (!entry) return;
    if (entry.isIntersecting) void loadNextPage();
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

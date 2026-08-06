// ── "Already imported" marks on listing thumbnails ────────────────────
// The detail-page badge (./importedBadge) answers "do I have this one?" for the
// post you are looking at. On a listing that answer is needed 40 times at once,
// so the work is arranged differently here:
//
//   · only thumbnails that actually scroll into view are looked up
//     (IntersectionObserver), so a 200-post page costs what you read of it,
//   · the URLs are collected for a moment and then asked for in ONE bulk
//     message, which the background turns into a single `source:` OR query,
//   · answers are remembered per URL, so infinite scroll and pjax paging never
//     re-ask for a thumbnail that was already resolved.
//
// A mark means "this post is in your instance" — the batch importer skips the
// same posts, so what you see is what it will do.

import { BrowserCommand } from "~/models";
import { t } from "~/i18n";
import { normalizePostUrl } from "~/shared/listing";
import { getBadgeSettings, onConfigReloaded } from "./pageConfig";
import { onNavigation } from "./navigation";

const MARK_CLASS = "szuru-thumb-imported";
const PENDING_CLASS = "szuru-thumb-checking";
const STYLE_ID = "szuru-thumb-style";
const MARKED_ATTR = "data-szuru-imported";
/** Holds the URL an anchor was registered for, so re-scans stay cheap. */
const SEEN_ATTR = "data-szuru-seen";
/** The page's own tooltip, parked while ours is shown. */
const TITLE_ATTR = "data-szuru-title";

/** Collect intersecting thumbnails this long before asking, to batch them. */
const BULK_DEBOUNCE_MS = 250;
/** Start resolving a little before the thumbnail is actually on screen. */
const PREFETCH_MARGIN = "300px";
/** Ceiling per message, matching what the background is willing to chunk. */
const MAX_URLS_PER_REQUEST = 60;

const THUMB_STYLES = `
  .${MARK_CLASS},.${PENDING_CLASS}{position:relative}
  .${MARK_CLASS}::after{
    content:"✓";position:absolute;top:4px;right:4px;z-index:2147483000;
    display:grid;place-items:center;width:19px;height:19px;border-radius:50%;
    background:rgba(52,199,89,.95);color:#fff;
    font:700 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    box-shadow:0 1px 4px rgba(0,0,0,.45);pointer-events:none;
    animation:szb-thumb-pop .18s cubic-bezier(.16,1,.3,1) both;
  }
  .${MARK_CLASS}{opacity:.62;transition:opacity .2s ease}
  .${MARK_CLASS}:hover{opacity:1}
  /* Waiting for the lookup. The fade is delayed so an answer that arrives
     quickly never shows a spinner that flashes and vanishes. */
  .${PENDING_CLASS}::after{
    content:"";position:absolute;top:4px;right:4px;z-index:2147483000;
    box-sizing:border-box;width:17px;height:17px;border-radius:50%;
    border:2px solid rgba(0,0,0,.35);border-top-color:rgba(255,255,255,.92);
    background:rgba(28,28,32,.45);box-shadow:0 1px 4px rgba(0,0,0,.4);
    pointer-events:none;
    animation:szb-thumb-spin .7s linear infinite,szb-thumb-fade .2s ease .35s both;
  }
  @keyframes szb-thumb-spin{to{transform:rotate(360deg)}}
  @keyframes szb-thumb-fade{from{opacity:0}to{opacity:1}}
  @keyframes szb-thumb-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
  @media (prefers-reduced-motion:reduce){
    .${PENDING_CLASS}::after{animation:szb-thumb-fade .2s ease .35s both}
    .${MARK_CLASS}::after{animation:none}
  }
`;

/** Answers we already have, so a thumbnail is never looked up twice. */
const resolved = new Map<string, boolean>();
const pendingUrls = new Set<string>();
/** Anchors waiting for their answer, keyed by the URL they point at. */
const watchedAnchors = new Map<string, Set<HTMLAnchorElement>>();

let observer: IntersectionObserver | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let enabled = false;
/** Invalidates in-flight lookups when a listing or its settings change. */
let lookupGeneration = 0;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = THUMB_STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * Replace an anchor's tooltip, keeping the page's own. Booru thumbnails carry
 * their tag list in `title`; overwriting it without a way back would take away
 * something the user relies on.
 */
function setTitle(anchor: HTMLAnchorElement, value?: string): void {
  if (value === undefined) {
    const original = anchor.getAttribute(TITLE_ATTR);
    if (original === null) return;
    anchor.title = original;
    anchor.removeAttribute(TITLE_ATTR);
    return;
  }
  if (!anchor.hasAttribute(TITLE_ATTR)) anchor.setAttribute(TITLE_ATTR, anchor.title ?? "");
  anchor.title = value;
}

/**
 * Spinner while the lookup for this thumbnail is out. Deliberately without a
 * tooltip: the page's own is more useful than "Checking…" for the moment this
 * lasts, and the spinner already says what is going on.
 */
function setPending(anchor: HTMLAnchorElement, pending: boolean): void {
  if (pending) ensureStyles();
  anchor.classList.toggle(PENDING_CLASS, pending);
}

function markAnchor(anchor: HTMLAnchorElement, postUrl?: string): void {
  ensureStyles();
  setPending(anchor, false);
  anchor.classList.add(MARK_CLASS);
  anchor.setAttribute(MARKED_ATTR, "1");
  const label = t("badge.imported") || "Already imported";
  setTitle(anchor, postUrl ? `${label} — ${postUrl}` : label);
}

function clearMarks(): void {
  const selector = `.${MARK_CLASS}, .${PENDING_CLASS}, [${SEEN_ATTR}]`;
  for (const el of Array.from(document.querySelectorAll<HTMLAnchorElement>(selector))) {
    el.classList.remove(MARK_CLASS, PENDING_CLASS);
    el.removeAttribute(MARKED_ATTR);
    el.removeAttribute(SEEN_ATTR);
    setTitle(el, undefined);
  }
}

function applyResult(url: string, result: { imported: boolean; postUrl?: string; unavailable?: boolean }): void {
  const anchors = watchedAnchors.get(url) ?? [];

  // `unavailable` means the lookup itself failed. Stop the spinner and forget
  // the thumbnail entirely — dropping the "seen" mark puts it back in line for
  // the next scan, rather than leaving it spinning forever.
  if (result?.unavailable) {
    for (const anchor of anchors) {
      setPending(anchor, false);
      anchor.removeAttribute(SEEN_ATTR);
    }
    watchedAnchors.delete(url);
    return;
  }

  resolved.set(url, !!result?.imported);
  for (const anchor of anchors) {
    if (result?.imported) markAnchor(anchor, result.postUrl);
    else setPending(anchor, false);
  }
  // Drop the element references: on an infinite-scroll listing they would
  // otherwise pin every thumbnail node the user has ever passed.
  watchedAnchors.delete(url);
}

async function flushPending(): Promise<void> {
  flushTimer = undefined;
  const urls = [...pendingUrls].slice(0, MAX_URLS_PER_REQUEST);
  if (urls.length === 0) return;
  for (const url of urls) pendingUrls.delete(url);
  const generation = lookupGeneration;

  try {
    const answers: Record<string, any> = await browser.runtime.sendMessage(
      new BrowserCommand("check_imported_bulk", { pageUrls: urls }),
    );
    if (generation !== lookupGeneration || !enabled) return;
    for (const url of urls) applyResult(url, answers?.[url] ?? { unavailable: true });
  } catch {
    if (generation !== lookupGeneration || !enabled) return;
    // Background unreachable (worker restarting). Treat it like any other
    // failed lookup so the spinners stop and the thumbnails can be retried.
    for (const url of urls) applyResult(url, { imported: false, unavailable: true });
  }

  // More arrived while the request was in flight.
  if (generation === lookupGeneration && pendingUrls.size > 0) scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => void flushPending(), BULK_DEBOUNCE_MS);
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const anchor = entry.target as HTMLAnchorElement;
    observer?.unobserve(anchor);

    const url = normalizePostUrl(anchor.href, window.location.href);
    if (!url) continue;

    const known = resolved.get(url);
    if (known === true) { markAnchor(anchor); continue; }
    if (known === false) continue;

    let anchors = watchedAnchors.get(url);
    if (!anchors) { anchors = new Set(); watchedAnchors.set(url, anchors); }
    anchors.add(anchor);
    // Say that something is happening — on a slow instance a whole screen of
    // thumbnails would otherwise sit there looking like "none of these are
    // imported" until the answer lands.
    setPending(anchor, true);

    pendingUrls.add(url);
    scheduleFlush();
  }
}

/**
 * Post anchors within `root`, including `root` itself when an entire thumbnail
 * wrapper was added in one mutation.
 */
function thumbnailAnchors(root: ParentNode): HTMLAnchorElement[] {
  const anchors: HTMLAnchorElement[] = [];
  if (root instanceof HTMLAnchorElement && root.matches("a[href]")) anchors.push(root);
  if (root instanceof Element) {
    const parentAnchor = root.closest<HTMLAnchorElement>("a[href]");
    if (parentAnchor) anchors.push(parentAnchor);
  }
  anchors.push(...Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")));
  return anchors;
}

/** Register post thumbnails that aren't being watched yet; returns how many. */
function scanThumbnails(root: ParentNode = document): number {
  if (!enabled || !observer) return 0;
  let added = 0;
  for (const anchor of thumbnailAnchors(root)) {
    if (!anchor.isConnected) continue;
    if (!anchor.querySelector("img")) continue;
    const url = normalizePostUrl(anchor.href, window.location.href);
    if (!url) continue;
    // Already handled — unless the site recycled the node for another post.
    if (anchor.getAttribute(SEEN_ATTR) === url) continue;
    anchor.setAttribute(SEEN_ATTR, url);
    observer.observe(anchor);
    added++;
  }
  return added;
}

/**
 * Infinite scroll appends thumbnails without any navigation event, so a
 * mutation watcher is the only way to see them. It is installed lazily: on a
 * page that never had a post grid (an artist's profile, a forum thread) there
 * is nothing to re-scan and no reason to watch its DOM churn.
 */
let mutationWatcher: MutationObserver | undefined;
function watchForNewThumbnails(): void {
  if (mutationWatcher) return;
  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingRoots = new Set<ParentNode>();
  mutationWatcher = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) pendingRoots.add(node);
      }
    }
    if (pendingRoots.size === 0) return;
    if (rescanTimer !== undefined) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined;
      // Endless scroll used to trigger a complete document scan here. On a
      // long listing that gets slower with every page; inspect just the newly
      // appended thumbnail wrappers instead.
      for (const root of pendingRoots) scanThumbnails(root);
      pendingRoots.clear();
    }, 80);
  });
  mutationWatcher.observe(document.documentElement, { childList: true, subtree: true });
}

async function refresh(): Promise<void> {
  const refreshGeneration = ++lookupGeneration;
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  pendingUrls.clear();
  watchedAnchors.clear();
  // A virtual navigation replaces thumbnails without unloading this script.
  // Disconnecting drops the old element references before scanning the new DOM.
  observer?.disconnect();
  observer = undefined;

  const settings = await getBadgeSettings();
  if (refreshGeneration !== lookupGeneration) return;
  enabled = settings.enabled && settings.thumbnails;

  if (!enabled) {
    mutationWatcher?.disconnect();
    mutationWatcher = undefined;
    clearMarks();
    return;
  }

  if (!observer) {
    observer = new IntersectionObserver(onIntersect, { rootMargin: PREFETCH_MARGIN });
  }
  if (scanThumbnails() > 0) watchForNewThumbnails();
}

export function installThumbBadges(): void {
  if (installed) return;
  installed = true;

  onNavigation(() => void refresh());
  onConfigReloaded(() => {
    resolved.clear();
    clearMarks();
    void refresh();
  });

  void refresh();
}

/** Re-check the listing after an import, so the new post gets its mark. */
export function invalidateThumbBadges(): void {
  resolved.clear();
  clearMarks();
  void refresh();
}

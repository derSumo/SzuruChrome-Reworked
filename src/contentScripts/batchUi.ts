// ── Batch import UI (listing / gallery pages) ─────────────────────────
// Lets the user pick many posts on a listing page and import them all. The
// heavy lifting (open each in a tab, scrape, upload, close) happens in the
// background; here we only detect post links, run the selection UI, and show
// progress. Detection is deliberately conservative — an anchor to a post-detail
// URL that also wraps a thumbnail image.
//
// Selection is not limited to what is on screen: "All pages" crawls the
// listing's pagination (see ./listingCrawl) and the search box re-points that
// crawl at any query — that is how "import everything from user X" works.
// Selected URLs therefore live in a Set, not in the DOM: most of them belong to
// pages that were never rendered here.
//
// Nor is it limited to one document. The basket lives in the background
// (see background/batchSelection) and is keyed per site, so paging through a
// listing and picking as you go builds one list; this module keeps a local
// mirror for instant feedback and syncs the differences.
//
// Everything this module shows lives in one bottom-left dock: running imports
// stack above, the picker (or its launcher) sits below them. A batch is fire-
// and-forget in the background, so starting one must not take the picker away
// — you can queue the next selection while the previous one is still running,
// and each batch keeps its own row.

import { BrowserCommand } from "~/models";
import { t } from "~/i18n";
import { buildSearchUrl, isPostDetailUrl, normalizePostUrl } from "~/shared/listing";
import { getBatchSettings, onConfigReloaded } from "./pageConfig";
import { icon } from "./ui/icons";
import { crawlListing, type CrawlResult } from "./listingCrawl";
import { onNavigation } from "./navigation";

const BATCH_ID = "szuru-batch";
const SELECTABLE_CLASS = "szuru-batch-selectable";
const SELECTED_CLASS = "szuru-batch-selected";

/** Below this many candidates a listing page isn't worth a batch launcher. */
const MIN_CANDIDATES = 2;
const DONE_AUTO_DISMISS_MS = 8000;
const NOTE_LIFETIME_MS = 6000;

const BATCH_STYLES = `
  /* ── Selection marks on the thumbnails ───────────────────────────── */
  .${SELECTABLE_CLASS}{outline:2px dashed rgba(129,140,248,.55)!important;outline-offset:-2px;
    cursor:pointer!important;position:relative;
    transition:outline-color .16s ease,transform .16s cubic-bezier(.16,1,.3,1)}
  .${SELECTABLE_CLASS}:hover{outline-color:rgba(129,140,248,.95)!important}
  .${SELECTED_CLASS}{outline:3px solid rgba(52,199,89,.95)!important;transform:scale(.97)}
  .${SELECTED_CLASS}::after{content:"";position:absolute;top:5px;left:5px;z-index:2147483646;
    width:20px;height:20px;border-radius:50%;background:rgba(52,199,89,.96);
    background-image:url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.4 8.4l3 3 6.2-6.6'/%3E%3C/svg%3E");
    background-size:14px 14px;background-position:center;background-repeat:no-repeat;
    box-shadow:0 1px 5px rgba(0,0,0,.45);animation:szb-pop .18s cubic-bezier(.16,1,.3,1) both}
  /* Anchor of a shift-range: the "from" end, so the range is predictable. */
  .${SELECTABLE_CLASS}.szb-range-anchor{outline-color:rgba(255,214,10,.95)!important}

  /* ── The dock ────────────────────────────────────────────────────── */
  #${BATCH_ID}-dock{
    position:fixed;left:16px;bottom:16px;z-index:2147483647;
    display:flex;flex-direction:column;align-items:flex-start;gap:8px;
    max-width:min(480px,calc(100vw - 32px));pointer-events:none;
    font:600 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI","Helvetica Neue",sans-serif;
    -webkit-font-smoothing:antialiased;}
  #${BATCH_ID}-dock > *{pointer-events:auto}
  #${BATCH_ID}-runs{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%}

  .${BATCH_ID}-panel{
    color:rgba(255,255,255,.95);background:rgba(24,24,28,.86);
    border:.5px solid rgba(255,255,255,.14);border-radius:15px;
    -webkit-backdrop-filter:saturate(180%) blur(36px);backdrop-filter:saturate(180%) blur(36px);
    box-shadow:0 10px 34px rgba(0,0,0,.3),inset 0 .5px 0 rgba(255,255,255,.12);
    animation:szb-rise .24s cubic-bezier(.16,1,.3,1) both;}

  #${BATCH_ID}-launcher{display:flex;align-items:stretch;overflow:hidden}
  #${BATCH_ID}-launcher button{display:flex;align-items:center;gap:7px;padding:9px 13px;cursor:pointer;
    background:none;border:0;color:inherit;font:inherit;transition:background .16s ease}
  #${BATCH_ID}-launcher .szb-open:hover{background:rgba(255,255,255,.09)}
  #${BATCH_ID}-launcher .szb-quick{background:rgba(99,102,241,.4);border-left:.5px solid rgba(255,255,255,.14)}
  #${BATCH_ID}-launcher .szb-quick:hover{background:rgba(99,102,241,.62)}
  #${BATCH_ID}-launcher .szb-basket{padding:1px 7px;border-radius:999px;background:rgba(52,199,89,.22);
    color:rgba(171,255,196,.98);font-size:12px}

  #${BATCH_ID}-toolbar{display:flex;flex-direction:column;gap:8px;padding:11px 12px;
    width:min(480px,calc(100vw - 32px));box-sizing:border-box}
  .${BATCH_ID} .szb-head{display:flex;align-items:center;gap:8px}
  .${BATCH_ID} .szb-title{display:flex;align-items:center;gap:7px;font-size:13px}
  .${BATCH_ID} .szb-tally{margin-left:auto;display:flex;align-items:center;gap:6px;
    font-weight:500;font-size:12px;color:rgba(255,255,255,.62)}
  .${BATCH_ID} .szb-tally b{font-weight:700;font-size:13px;color:rgba(255,255,255,.95);
    font-variant-numeric:tabular-nums}
  .${BATCH_ID} .szb-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .${BATCH_ID} .szb-fields{display:flex;align-items:center;gap:6px}
  .${BATCH_ID} .szb-field{display:flex;align-items:center;gap:6px;flex:1;min-width:120px;
    padding:0 9px;border-radius:10px;border:.5px solid rgba(255,255,255,.16);background:rgba(0,0,0,.28);
    color:rgba(255,255,255,.45);transition:border-color .16s ease,background .16s ease}
  .${BATCH_ID} .szb-field:focus-within{border-color:rgba(129,140,248,.75);background:rgba(0,0,0,.4)}
  .${BATCH_ID} .szb-field input{flex:1;min-width:0;padding:7px 0;border:0;background:none;
    color:rgba(255,255,255,.95);font:inherit;font-weight:500;outline:none}
  .${BATCH_ID} .szb-field input::placeholder{color:rgba(255,255,255,.38);font-weight:400}

  .${BATCH_ID} .szb-btn{display:inline-flex;align-items:center;gap:6px;
    padding:7px 11px;border-radius:10px;border:.5px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.06);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;
    transition:background .15s ease,border-color .15s ease,transform .12s ease}
  .${BATCH_ID} .szb-btn:hover{background:rgba(255,255,255,.13)}
  .${BATCH_ID} .szb-btn:active{transform:scale(.96)}
  .${BATCH_ID} .szb-btn.primary{background:rgba(99,102,241,.6);border-color:rgba(129,140,248,.55)}
  .${BATCH_ID} .szb-btn.primary:hover{background:rgba(99,102,241,.78)}
  .${BATCH_ID} .szb-btn.danger:hover{background:rgba(255,105,97,.24);border-color:rgba(255,105,97,.4)}
  .${BATCH_ID} .szb-btn.busy{background:rgba(255,159,10,.24);border-color:rgba(255,159,10,.45)}
  .${BATCH_ID} .szb-btn:disabled{opacity:.42;cursor:default;transform:none}
  .${BATCH_ID} .szb-btn.icon-only{padding:7px 8px}
  .${BATCH_ID} .szb-icon{flex-shrink:0;opacity:.92}

  .${BATCH_ID} .szb-note{font-weight:450;font-size:12px;color:rgba(255,255,255,.62);
    display:flex;align-items:center;gap:6px;min-height:16px}
  .${BATCH_ID} .szb-hint{font-weight:400;font-size:11.5px;color:rgba(255,255,255,.4)}

  /* ── Run rows ────────────────────────────────────────────────────── */
  .${BATCH_ID}-run{display:flex;flex-direction:column;gap:7px;padding:10px 12px;
    width:min(480px,calc(100vw - 32px));box-sizing:border-box}
  .${BATCH_ID}-run.done{background:rgba(22,42,30,.86);border-color:rgba(52,199,89,.26)}
  .${BATCH_ID}-run.failed{background:rgba(46,25,25,.88);border-color:rgba(255,105,97,.3)}
  .${BATCH_ID}-run .szb-stats{display:flex;align-items:center;gap:10px;font-weight:500;font-size:11.5px;
    color:rgba(255,255,255,.55);flex-wrap:wrap}
  .${BATCH_ID}-run .szb-stat{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
  .${BATCH_ID}-run .szb-stat.ok{color:rgba(120,220,150,.92)}
  .${BATCH_ID}-run .szb-stat.skip{color:rgba(160,180,255,.85)}
  .${BATCH_ID}-run .szb-stat.fail{color:rgba(255,140,130,.92)}
  .${BATCH_ID}-run .szb-eta{margin-left:auto}

  #${BATCH_ID}-runs-summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;
    font:inherit;color:inherit;width:auto}
  #${BATCH_ID}-runs-summary:hover{background:rgba(38,38,44,.9)}

  .${BATCH_ID} .szb-collapse{margin-left:auto;display:inline-flex;padding:2px;cursor:pointer;border:0;
    background:none;color:rgba(255,255,255,.45);line-height:0;border-radius:6px;transition:color .15s ease}
  .${BATCH_ID} .szb-collapse:hover{color:rgba(255,255,255,.95);background:rgba(255,255,255,.08)}
  .${BATCH_ID} .szb-dot{width:7px;height:7px;border-radius:50%;background:rgba(129,140,248,.95);flex-shrink:0;
    box-shadow:0 0 0 0 rgba(129,140,248,.5);animation:szb-ping 1.6s cubic-bezier(.16,1,.3,1) infinite}

  .${BATCH_ID} .szb-bar{position:relative;height:5px;border-radius:3px;background:rgba(255,255,255,.12);
    overflow:hidden;width:100%}
  .${BATCH_ID} .szb-bar > i{display:block;height:100%;border-radius:3px;
    background:linear-gradient(90deg,rgba(99,102,241,.95),rgba(168,85,247,.85));
    transition:width .35s cubic-bezier(.16,1,.3,1)}
  .${BATCH_ID} .szb-bar.live::after{content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);
    animation:szb-sheen 1.6s ease-in-out infinite}
  .${BATCH_ID}-run.done .szb-bar > i{background:linear-gradient(90deg,rgba(52,199,89,.9),rgba(120,220,150,.8))}

  @keyframes szb-rise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  @keyframes szb-pop{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}
  @keyframes szb-ping{0%{box-shadow:0 0 0 0 rgba(129,140,248,.5)}70%{box-shadow:0 0 0 7px rgba(129,140,248,0)}100%{box-shadow:0 0 0 0 rgba(129,140,248,0)}}
  @keyframes szb-sheen{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
  @media (prefers-reduced-motion:reduce){
    .${BATCH_ID}-panel,.${SELECTED_CLASS}::after{animation:none}
    .${BATCH_ID} .szb-dot,.${BATCH_ID} .szb-bar.live::after{animation:none}
    .${SELECTED_CLASS}{transform:none}
  }
`;


let batchLauncher: HTMLElement | undefined;
let batchToolbar: HTMLElement | undefined;
let batchSelectMode = false;
let crawlAbort: AbortController | undefined;
const batchSelectedUrls = new Set<string>();

/** One entry per batch this tab started, alive until it is dismissed. */
interface BatchRun {
  batchId: string;
  done: number;
  total: number;
  skipped: number;
  poolName?: string;
  /** Items that failed, so the row can show ok/skipped/failed separately. */
  failedCount?: number;
  /** First progress this tab saw; the ETA is measured from it. */
  startedAt?: number;
  /** Set once the batch reported "done"; the row then shows its summary. */
  message?: string;
  /** Transient second line, e.g. "everything was already queued". */
  note?: string;
  noteTimer?: ReturnType<typeof setTimeout>;
  failed?: boolean;
  dismissTimer?: ReturnType<typeof setTimeout>;
}

const batchRuns = new Map<string, BatchRun>();
let runsCollapsed = false;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string
  ));
}

// ── Basket sync ───────────────────────────────────────────────────────
// The local Set answers every click immediately; the background holds the
// authoritative basket for the whole site. Differences are pushed as deltas
// (not the whole list) so a second tab picking on the same booru merges with
// this one instead of overwriting it.

const pendingAdd = new Set<string>();
const pendingRemove = new Set<string>();
let syncTimer: ReturnType<typeof setTimeout> | undefined;

interface BatchSelectionState {
  urls: string[];
  active: boolean;
  poolName?: string;
}

function sendSelectionCommand(data: Record<string, unknown>): Promise<BatchSelectionState | undefined> {
  return browser.runtime
    .sendMessage(new BrowserCommand("batch_selection", { pageUrl: window.location.href, ...data }))
    .catch(() => undefined) as Promise<BatchSelectionState | undefined>;
}

/**
 * Adopt the background's list as the truth and redraw what depends on it.
 * Skipped while clicks are still unsent: that answer predates them and would
 * make the thumbnails the user just ticked flicker back off.
 */
function adoptSelection(state: BatchSelectionState | undefined): void {
  if (!state?.urls) return;
  if (pendingAdd.size > 0 || pendingRemove.size > 0) return;
  batchSelectedUrls.clear();
  for (const url of state.urls) batchSelectedUrls.add(url);
  if (batchToolbar) refreshSelectionMarks();
}

async function flushSelection(): Promise<void> {
  syncTimer = undefined;
  if (pendingAdd.size === 0 && pendingRemove.size === 0) return;

  const add = [...pendingAdd];
  const remove = [...pendingRemove];
  pendingAdd.clear();
  pendingRemove.clear();

  adoptSelection(await sendSelectionCommand({ add, remove, active: batchSelectMode }));
}

function scheduleSelectionSync(): void {
  if (syncTimer !== undefined) return;
  syncTimer = setTimeout(() => void flushSelection(), 300);
}

function recordSelected(url: string, selected: boolean): void {
  if (selected) { pendingAdd.add(url); pendingRemove.delete(url); }
  else { pendingRemove.add(url); pendingAdd.delete(url); }
  scheduleSelectionSync();
}

// ── Candidate detection ───────────────────────────────────────────────

function postAnchorsIn(root: ParentNode = document): HTMLAnchorElement[] {
  const seen = new Set<string>();
  const anchors: HTMLAnchorElement[] = [];
  const candidates: HTMLAnchorElement[] = [];
  if (root instanceof HTMLAnchorElement && root.matches("a[href]")) candidates.push(root);
  if (root instanceof Element) {
    const parentAnchor = root.closest<HTMLAnchorElement>("a[href]");
    if (parentAnchor) candidates.push(parentAnchor);
  }
  candidates.push(...Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")));

  for (const a of candidates) {
    if (!a.querySelector("img")) continue;
    if (!isPostDetailUrl(a.href, window.location.href)) continue;
    const key = normalizePostUrl(a.href, window.location.href);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    anchors.push(a);
  }
  return anchors;
}

function findPostAnchors(): HTMLAnchorElement[] {
  return postAnchorsIn();
}

/** Anchor → the URL it contributes to the selection. */
function urlOfAnchor(anchor: HTMLAnchorElement): string {
  return normalizePostUrl(anchor.href, window.location.href) ?? anchor.href;
}

function ensureBatchStyles(): void {
  if (document.getElementById(BATCH_ID + "-style")) return;
  const style = document.createElement("style");
  style.id = BATCH_ID + "-style";
  style.textContent = BATCH_STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

// ── Dock ──────────────────────────────────────────────────────────────
// Running imports and the picker share one bottom-left column instead of
// being three independently positioned panels fighting over the same corner.

let dockEl: HTMLElement | undefined;
let runsEl: HTMLElement | undefined;

/** The dock's control slot — holds either the launcher or the open picker. */
function ensureDock(): HTMLElement {
  ensureBatchStyles();
  if (!dockEl || !dockEl.isConnected) {
    dockEl = document.createElement("div");
    dockEl.id = BATCH_ID + "-dock";
    dockEl.classList.add(BATCH_ID);

    runsEl = document.createElement("div");
    runsEl.id = BATCH_ID + "-runs";
    dockEl.appendChild(runsEl);

    document.documentElement.appendChild(dockEl);
  }
  return dockEl;
}

function removeDockIfEmpty(): void {
  if (!dockEl) return;
  if (batchLauncher || batchToolbar || batchRuns.size > 0) return;
  dockEl.remove();
  dockEl = undefined;
  runsEl = undefined;
}

function clearSelectionMarks(): void {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(`.${SELECTABLE_CLASS}`))) {
    a.classList.remove(SELECTABLE_CLASS, SELECTED_CLASS);
  }
}

/**
 * Endless scroll appends nodes without a navigation event. While the picker is
 * open, turn only those fresh nodes into selectable thumbnails; repeatedly
 * searching a long, growing listing makes every append more expensive.
 */
let selectionWatcher: MutationObserver | undefined;
let selectionRescanTimer: ReturnType<typeof setTimeout> | undefined;
const selectionRoots = new Set<ParentNode>();

function stopWatchingSelection(): void {
  selectionWatcher?.disconnect();
  selectionWatcher = undefined;
  selectionRoots.clear();
  if (selectionRescanTimer !== undefined) clearTimeout(selectionRescanTimer);
  selectionRescanTimer = undefined;
}

function watchNewSelectionCandidates(): void {
  if (selectionWatcher) return;
  selectionWatcher = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) selectionRoots.add(node);
      }
    }
    if (selectionRoots.size === 0 || selectionRescanTimer !== undefined) return;
    selectionRescanTimer = setTimeout(() => {
      selectionRescanTimer = undefined;
      if (!batchSelectMode) return;
      for (const root of selectionRoots) {
        for (const anchor of postAnchorsIn(root)) {
          anchor.classList.add(SELECTABLE_CLASS);
          anchor.classList.toggle(SELECTED_CLASS, batchSelectedUrls.has(urlOfAnchor(anchor)));
        }
      }
      selectionRoots.clear();
      updateBatchToolbarCount();
    }, 80);
  });
  selectionWatcher.observe(document.documentElement, { childList: true, subtree: true });
}

// ── Launcher ──────────────────────────────────────────────────────────

function removeBatchUi(): void {
  batchLauncher?.remove(); batchLauncher = undefined;
  batchToolbar?.remove(); batchToolbar = undefined;
  removeDockIfEmpty();
}

async function updateBatchLauncher(): Promise<void> {
  // The picker replaces the launcher; a running import no longer hides it, so
  // the next batch can be put together while the previous one is still going.
  if (batchSelectMode) return;

  const settings = await getBatchSettings();
  if (!settings.enabled || !settings.hasSites) { removeBatchUi(); return; }

  const count = findPostAnchors().length;
  if (count < MIN_CANDIDATES) { removeBatchUi(); return; }

  if (!batchLauncher) {
    const el = document.createElement("div");
    el.id = BATCH_ID + "-launcher";
    el.classList.add(BATCH_ID, `${BATCH_ID}-panel`);
    ensureDock().appendChild(el);
    batchLauncher = el;
  }
  // Two entry points: open the picker, or take everything on this page in a
  // single click — the common case on a search result the user already trusts.
  // A non-empty basket is shown as a pill so picks made on an earlier page are
  // visible before the picker is even open.
  const basket = batchSelectedUrls.size;
  batchLauncher.innerHTML = `
    <button class="szb-open" type="button">
      ${icon("grid")}
      <span>${escapeHtml(t("batch.launcher", { count }) || `Batch import (${count})`)}</span>
      ${basket > 0 ? `<span class="szb-basket">${basket}</span>` : ""}
    </button>
    <button class="szb-quick" type="button" title="${escapeHtml(t("batch.selectAllTitle") || "Select every post on this page")}">
      ${icon("selectAll")}<span>${escapeHtml(t("batch.selectAll") || "All")}</span>
    </button>
  `;
  batchLauncher.querySelector(".szb-open")?.addEventListener("click", () => enterBatchSelectMode());
  batchLauncher.querySelector(".szb-quick")?.addEventListener("click", () => enterBatchSelectMode(true));
}

// ── Selection mode ────────────────────────────────────────────────────

function updateBatchToolbarCount(): void {
  const countEl = batchToolbar?.querySelector(".szb-count");
  const importBtn = batchToolbar?.querySelector<HTMLButtonElement>(".szb-import");
  const allBtn = batchToolbar?.querySelector<HTMLButtonElement>(".szb-all");
  const clearBtn = batchToolbar?.querySelector<HTMLButtonElement>(".szb-clear");
  const n = batchSelectedUrls.size;
  const pageUrls = findPostAnchors().map(urlOfAnchor);
  const onThisPage = pageUrls.filter((u) => batchSelectedUrls.has(u)).length;

  if (countEl) {
    // Say where the picks live once the basket outgrows this page — otherwise
    // "84 selected" on a page showing 42 posts looks like a bug.
    countEl.innerHTML = onThisPage < n
      ? `<b>${n}</b> ${escapeHtml(t("batch.selectedSuffix") || "selected")} · ${onThisPage} ${escapeHtml(t("batch.onThisPage") || "here")}`
      : `<b>${n}</b> ${escapeHtml(t("batch.selectedSuffix") || "selected")}`;
  }
  if (importBtn) {
    importBtn.disabled = n === 0;
    const label = importBtn.querySelector(".szb-import-label");
    if (label) label.textContent = n > 0
      ? (t("batch.importCount", { count: n }) || `Import ${n}`)
      : (t("batch.import") || "Import");
  }
  if (clearBtn) clearBtn.hidden = n === 0;
  // The same button clears the selection once everything on the page is in it.
  if (allBtn) {
    const allSelected = pageUrls.length > 0 && pageUrls.every((u) => batchSelectedUrls.has(u));
    const label = allSelected ? (t("batch.selectNone") || "None") : (t("batch.selectAll") || "All");
    allBtn.innerHTML = `${icon(allSelected ? "selectNone" : "selectAll")}<span class="szb-all-label">${escapeHtml(label)}</span>`;
  }
}

function selectAllOnPage(): void {
  const anchors = findPostAnchors();
  const allSelected = anchors.length > 0 && anchors.every((a) => batchSelectedUrls.has(urlOfAnchor(a)));
  for (const a of anchors) {
    const url = urlOfAnchor(a);
    if (allSelected) {
      batchSelectedUrls.delete(url);
      a.classList.remove(SELECTED_CLASS);
    } else {
      batchSelectedUrls.add(url);
      a.classList.add(SELECTED_CLASS);
    }
    recordSelected(url, !allSelected);
  }
  updateBatchToolbarCount();
}

/** Empty the basket for this site, on this page and everywhere else. */
function clearSelection(): void {
  batchSelectedUrls.clear();
  pendingAdd.clear();
  pendingRemove.clear();
  void sendSelectionCommand({ clear: true, active: batchSelectMode });
  refreshSelectionMarks();
}

/**
 * Re-apply the selection to the anchors currently in the DOM. Needed after a
 * crawl (which selects URLs that were never on screen) and after an in-page
 * navigation, where the toolbar survives but the thumbnails were replaced.
 */
function refreshSelectionMarks(): void {
  for (const a of findPostAnchors()) {
    a.classList.add(SELECTABLE_CLASS);
    a.classList.toggle(SELECTED_CLASS, batchSelectedUrls.has(urlOfAnchor(a)));
  }
  updateBatchToolbarCount();
}

function toggleAnchor(anchor: HTMLAnchorElement): void {
  const url = urlOfAnchor(anchor);
  const selected = !batchSelectedUrls.has(url);
  if (selected) batchSelectedUrls.add(url);
  else batchSelectedUrls.delete(url);
  anchor.classList.toggle(SELECTED_CLASS, selected);
  recordSelected(url, selected);
  updateBatchToolbarCount();
}

/**
 * Where the last plain click landed. Shift-clicking selects everything between
 * it and the new click, the way a file manager does — picking 40 posts on a
 * page is two clicks instead of forty.
 */
let rangeAnchorUrl: string | undefined;

function markRangeAnchor(url: string | undefined): void {
  rangeAnchorUrl = url;
  for (const a of Array.from(document.querySelectorAll(`.${SELECTABLE_CLASS}.szb-range-anchor`))) {
    a.classList.remove("szb-range-anchor");
  }
  if (!url) return;
  const anchor = findPostAnchors().find((a) => urlOfAnchor(a) === url);
  anchor?.classList.add("szb-range-anchor");
}

/** Select every thumbnail between the range anchor and `anchor`, inclusive. */
function selectRangeTo(anchor: HTMLAnchorElement): void {
  const anchors = findPostAnchors();
  const to = anchors.indexOf(anchor);
  const from = anchors.findIndex((a) => urlOfAnchor(a) === rangeAnchorUrl);
  if (to < 0 || from < 0) { toggleAnchor(anchor); return; }

  const [start, end] = from <= to ? [from, to] : [to, from];
  for (const a of anchors.slice(start, end + 1)) {
    const url = urlOfAnchor(a);
    if (batchSelectedUrls.has(url)) continue;
    batchSelectedUrls.add(url);
    a.classList.add(SELECTED_CLASS);
    recordSelected(url, true);
  }
  updateBatchToolbarCount();
}

const onSelectClick = (e: MouseEvent) => {
  const anchor = (e.target as HTMLElement)?.closest?.("a");
  if (!anchor || !anchor.classList.contains(SELECTABLE_CLASS)) return;
  e.preventDefault();
  e.stopPropagation();

  const target = anchor as HTMLAnchorElement;
  if (e.shiftKey && rangeAnchorUrl) {
    // Don't leave a text selection behind from the shift-drag the browser
    // starts on its own.
    window.getSelection?.()?.removeAllRanges?.();
    selectRangeTo(target);
    return;
  }

  toggleAnchor(target);
  // Ctrl/Cmd means "just this one" — it must not move the range anchor, so a
  // following shift-click still spans from where the user started.
  if (!e.ctrlKey && !e.metaKey) markRangeAnchor(urlOfAnchor(target));
};

function setToolbarNote(message: string): void {
  const note = batchToolbar?.querySelector(".szb-note");
  if (note) note.textContent = message;
}

/**
 * While the crawl runs, its own button turns into the way to stop it. The label
 * says *what* stops — "Stop" on its own read as "stop selecting", which is
 * exactly what it does not do: everything found so far stays selected.
 */
function setCrawlBusy(busy: boolean): void {
  if (!batchToolbar) return;
  const crawlBtn = batchToolbar.querySelector<HTMLButtonElement>(".szb-crawl");
  if (crawlBtn) {
    crawlBtn.classList.toggle("busy", busy);
    crawlBtn.innerHTML = busy
      ? `${icon("stop")}<span class="szb-crawl-label">${escapeHtml(t("batch.stopScan") || "Stop scanning")}</span>`
      : `${icon("allPages")}<span class="szb-crawl-label">${escapeHtml(t("batch.allPages") || "All pages")}</span>`;
  }
  for (const btn of Array.from(batchToolbar.querySelectorAll<HTMLButtonElement>(".szb-all,.szb-import"))) {
    btn.disabled = busy || (btn.classList.contains("szb-import") && batchSelectedUrls.size === 0);
  }
}

/**
 * Open the picker. `resumed` marks the re-open that happens automatically on
 * the next page of a listing: the basket is already loaded, so it must not be
 * cleared and the pool name is restored from it.
 */
function enterBatchSelectMode(selectAll = false, resumed = false): void {
  batchSelectMode = true;
  if (!resumed) {
    // A picker opened by hand starts from what the basket already holds — the
    // whole point of keeping it across pages.
    void sendSelectionCommand({ active: true }).then(adoptSelection);
  }
  batchLauncher?.remove(); batchLauncher = undefined;
  batchToolbar?.remove(); batchToolbar = undefined;

  for (const a of findPostAnchors()) a.classList.add(SELECTABLE_CLASS);
  watchNewSelectionCandidates();
  document.addEventListener("click", onSelectClick, true);

  const bar = document.createElement("div");
  bar.id = BATCH_ID + "-toolbar";
  bar.classList.add(BATCH_ID, `${BATCH_ID}-panel`);
  bar.innerHTML = `
    <div class="szb-head">
      <span class="szb-title">${icon("grid")}<span>${escapeHtml(t("batch.title") || "Batch import")}</span></span>
      <span class="szb-tally szb-count"></span>
      <button class="szb-collapse szb-cancel" type="button" title="${escapeHtml(t("batch.cancel") || "Cancel")}">${icon("close", 14)}</button>
    </div>
    <div class="szb-actions">
      <button class="szb-btn szb-all" type="button">${icon("selectAll")}<span class="szb-all-label">${escapeHtml(t("batch.selectAll") || "All")}</span></button>
      <button class="szb-btn szb-crawl" type="button" title="${escapeHtml(t("batch.allPagesTitle") || "Follow the pagination and select every post")}">
        ${icon("allPages")}<span class="szb-crawl-label">${escapeHtml(t("batch.allPages") || "All pages")}</span>
      </button>
      <button class="szb-btn danger icon-only szb-clear" type="button" title="${escapeHtml(t("batch.clear") || "Clear")}" hidden>${icon("trash")}</button>
      <button class="szb-btn primary szb-import" type="button" disabled>${icon("play")}<span class="szb-import-label">${escapeHtml(t("batch.import") || "Import")}</span></button>
    </div>
    <div class="szb-fields">
      <label class="szb-field">${icon("search", 13)}
        <input class="szb-query" type="text" placeholder="${escapeHtml(t("batch.queryPlaceholder") || "Search, e.g. user:name")}" />
      </label>
      <label class="szb-field">${icon("pool", 13)}
        <input class="szb-pool" type="text" placeholder="${escapeHtml(t("batch.poolPlaceholder") || "Pool name")}" />
      </label>
    </div>
    <span class="szb-note"></span>
    <span class="szb-hint">${escapeHtml(t("batch.rangeHint") || "Shift-click selects a range, Ctrl-click toggles one.")}</span>
  `;
  ensureDock().appendChild(bar);
  batchToolbar = bar;

  bar.querySelector(".szb-all")?.addEventListener("click", selectAllOnPage);
  bar.querySelector(".szb-crawl")?.addEventListener("click", () => {
    if (crawlAbort) { crawlAbort.abort(); return; }
    void startCrawl(bar.querySelector<HTMLInputElement>(".szb-query")?.value?.trim() || undefined);
  });
  bar.querySelector(".szb-clear")?.addEventListener("click", clearSelection);
  bar.querySelector(".szb-cancel")?.addEventListener("click", exitBatchSelectMode);
  bar.querySelector(".szb-import")?.addEventListener("click", () => {
    void startBatchImport(bar.querySelector<HTMLInputElement>(".szb-pool")?.value?.trim() || undefined);
  });
  // The pool name belongs to the basket, not to the page it was typed on.
  const poolInput = bar.querySelector<HTMLInputElement>(".szb-pool");
  poolInput?.addEventListener("change", () => {
    void sendSelectionCommand({ poolName: poolInput.value.trim() });
  });

  if (selectAll) selectAllOnPage();
  updateBatchToolbarCount();
}

function exitBatchSelectMode(): void {
  batchSelectMode = false;
  stopWatchingSelection();
  crawlAbort?.abort();
  crawlAbort = undefined;
  document.removeEventListener("click", onSelectClick, true);
  clearSelectionMarks();
  batchSelectedUrls.clear();
  pendingAdd.clear();
  pendingRemove.clear();
  // Closing the picker drops the basket: leaving it behind would silently
  // re-open the picker on the next listing the user visits.
  void sendSelectionCommand({ clear: true, active: false });
  batchToolbar?.remove(); batchToolbar = undefined;
  void updateBatchLauncher();
}

// ── "All pages" crawl ─────────────────────────────────────────────────

function describeCrawlResult(result: CrawlResult, added: number): string {
  const base = t("batch.crawlDone", { found: added, pages: result.pages })
    || `${added} posts from ${result.pages} pages`;
  switch (result.stoppedBy) {
    case "maxPages": return `${base} · ${t("batch.crawlLimitPages") || "page limit reached"}`;
    case "maxPosts": return `${base} · ${t("batch.crawlLimitPosts") || "post limit reached"}`;
    case "aborted": return `${base} · ${t("batch.crawlStopped") || "stopped"}`;
    case "error": return `${base} · ${t("batch.crawlError", { error: result.error ?? "" }) || `stopped: ${result.error}`}`;
    default: return base;
  }
}

/**
 * Crawl the current listing — or the listing for `query`, which is what turns
 * "user:name" into every post that user uploaded — and add everything found to
 * the selection.
 */
async function startCrawl(query?: string): Promise<void> {
  const settings = await getBatchSettings();

  let startUrl = window.location.href;
  if (query) {
    const searchUrl = buildSearchUrl(window.location.href, query);
    if (!searchUrl) {
      setToolbarNote(t("batch.queryUnsupported") || "Can't build a search URL from this page — open the search yourself and use All pages.");
      return;
    }
    startUrl = searchUrl;
  }

  crawlAbort = new AbortController();
  setCrawlBusy(true);
  setToolbarNote(t("batch.crawlStart") || "Scanning…");

  let result: CrawlResult;
  try {
    result = await crawlListing(
      startUrl,
      { maxPages: settings.maxPages, maxPosts: settings.maxPosts },
      ({ page, found }) => setToolbarNote(t("batch.crawlProgress", { page, found }) || `Page ${page} · ${found} found`),
      crawlAbort.signal,
    );
  } finally {
    crawlAbort = undefined;
    setCrawlBusy(false);
  }

  // The picker may have been cancelled — or the import already started — while
  // the crawl was still running. Its results must not resurrect either.
  if (!batchSelectMode) return;

  // Cap the total selection too: a crawl started twice must not walk past the
  // configured ceiling just because it ran in two halves.
  let added = 0;
  for (const url of result.urls) {
    if (batchSelectedUrls.size >= settings.maxPosts) break;
    if (batchSelectedUrls.has(url)) continue;
    batchSelectedUrls.add(url);
    recordSelected(url, true);
    added++;
  }
  // Mark whatever of it happens to be visible on the page in front of the user.
  refreshSelectionMarks();
  setToolbarNote(describeCrawlResult(result, added));
}

// ── Import + progress ─────────────────────────────────────────────────

async function startBatchImport(poolName?: string): Promise<void> {
  const urls = [...batchSelectedUrls];
  if (urls.length === 0) return;

  // Close the picker and hand the list over; the launcher comes straight back
  // so the next selection can be started while this batch runs.
  batchSelectMode = false;
  stopWatchingSelection();
  crawlAbort?.abort();
  crawlAbort = undefined;
  document.removeEventListener("click", onSelectClick, true);
  clearSelectionMarks();
  batchToolbar?.remove(); batchToolbar = undefined;

  // The basket has been handed to the runner; emptying it now stops the picker
  // from re-opening with the same posts on the next page the user visits.
  batchSelectedUrls.clear();
  pendingAdd.clear();
  pendingRemove.clear();
  void sendSelectionCommand({ clear: true, active: false });

  const proposedId = crypto.randomUUID();
  void updateBatchLauncher();

  try {
    // The background decides the id: when a batch is already running, these
    // URLs join its queue instead of starting a rival run, and the answer says
    // how many were genuinely new.
    const res: { batchId?: string; accepted?: number; duplicates?: number; total?: number } | undefined =
      await browser.runtime.sendMessage(new BrowserCommand("batch_import", { urls, poolName, batchId: proposedId }));

    const batchId = res?.batchId ?? proposedId;
    const duplicates = res?.duplicates ?? 0;
    updateBatchRun(batchId, {
      total: res?.total ?? urls.length,
      poolName,
      // Say so when a click added nothing — selecting "All" twice is easy, and
      // silence would look like the import was lost.
      note: duplicates > 0
        ? (res?.accepted
          ? t("batch.queuedSome", { added: res.accepted, duplicates }) || `${res.accepted} added, ${duplicates} already queued`
          : t("batch.queuedNone", { duplicates }) || `All ${duplicates} already queued`)
        : undefined,
    });
  } catch (ex: any) {
    updateBatchRun(proposedId, { total: urls.length, poolName });
    finishBatchRun(proposedId, t("batch.failed", { error: ex?.message ?? String(ex) }) || "Batch failed", true);
  }
}

// ── Running batches ───────────────────────────────────────────────────

function dismissRun(batchId: string): void {
  const run = batchRuns.get(batchId);
  if (run?.dismissTimer) clearTimeout(run.dismissTimer);
  if (run?.noteTimer) clearTimeout(run.noteTimer);
  batchRuns.delete(batchId);
  if (batchRuns.size === 0) runsCollapsed = false;
  renderRuns();
}

/** Create or update a run's row. */
function updateBatchRun(batchId: string, patch: Partial<Omit<BatchRun, "batchId">>): void {
  const run = batchRuns.get(batchId) ?? { batchId, done: 0, total: 0, skipped: 0, startedAt: Date.now() };
  Object.assign(run, patch);
  batchRuns.set(batchId, run);

  if (patch.note) {
    // The note explains one click; it must not outlive the reason for it.
    if (run.noteTimer) clearTimeout(run.noteTimer);
    run.noteTimer = setTimeout(() => {
      run.note = undefined;
      run.noteTimer = undefined;
      renderRuns();
    }, NOTE_LIFETIME_MS);
  }

  renderRuns();
}

function finishBatchRun(batchId: string, message: string, sticky = false): void {
  const run = batchRuns.get(batchId);
  if (!run) return;
  run.message = message;
  run.failed = sticky;
  // Auto-dismiss a clean success; keep failures until the user closes them so
  // the reason stays readable.
  if (!sticky) run.dismissTimer = setTimeout(() => dismissRun(batchId), DONE_AUTO_DISMISS_MS);
  renderRuns();
}

function describeRun(run: BatchRun): string {
  if (run.message) return run.message;
  const parts = [t("batch.progress", { done: run.done, total: run.total }) || `Importing ${run.done}/${run.total}`];
  if (run.poolName) parts.push(run.poolName);
  return parts.join(" · ");
}

/** Rough time left, from how long the finished items actually took. */
function describeEta(run: BatchRun): string | undefined {
  const left = run.total - run.done;
  if (left <= 0 || !run.startedAt || run.done < 2) return undefined;
  const perItem = (Date.now() - run.startedAt) / run.done;
  const seconds = Math.round((perItem * left) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  if (seconds < 90) return t("batch.etaSeconds", { seconds }) || `~${seconds}s left`;
  return t("batch.etaMinutes", { minutes: Math.round(seconds / 60) }) || `~${Math.round(seconds / 60)}min left`;
}

/** The ok / skipped / failed line under a run's progress bar. */
function renderRunStats(run: BatchRun): string {
  const imported = Math.max(0, run.done - run.skipped - (run.failedCount ?? 0));
  const stats = [
    `<span class="szb-stat ok">${icon("check", 12)}${imported}</span>`,
    run.skipped ? `<span class="szb-stat skip">${icon("selectNone", 12)}${run.skipped}</span>` : "",
    run.failedCount ? `<span class="szb-stat fail">${icon("warn", 12)}${run.failedCount}</span>` : "",
  ].filter(Boolean);

  const eta = run.message ? undefined : describeEta(run);
  if (eta) stats.push(`<span class="szb-stat szb-eta">${escapeHtml(eta)}</span>`);
  return stats.join("");
}

function renderRuns(): void {
  if (batchRuns.size === 0) {
    runsEl?.replaceChildren();
    removeDockIfEmpty();
    return;
  }

  const runs = [...batchRuns.values()];
  ensureDock();
  const container = runsEl;
  if (!container) return;
  container.replaceChildren();

  // Several batches at once would otherwise cover half the page, so the stack
  // folds into a single summary line the user can open again.
  if (runsCollapsed) {
    const active = runs.filter((r) => !r.message);
    const done = runs.reduce((sum, r) => sum + r.done, 0);
    const total = runs.reduce((sum, r) => sum + r.total, 0);
    const summary = document.createElement("button");
    summary.id = BATCH_ID + "-runs-summary";
    summary.className = `${BATCH_ID} ${BATCH_ID}-panel`;
    summary.type = "button";
    summary.innerHTML = `
      ${active.length ? `<span class="szb-dot"></span>` : ""}
      <span>${escapeHtml(t("batch.runsSummary", { runs: runs.length, done, total }) || `${runs.length} imports · ${done}/${total}`)}</span>
      <span class="szb-collapse">${icon("chevronUp", 14)}</span>
    `;
    summary.addEventListener("click", () => { runsCollapsed = false; renderRuns(); });
    container.appendChild(summary);
    return;
  }

  for (const run of runs) {
    const row = document.createElement("div");
    row.className = `${BATCH_ID} ${BATCH_ID}-panel ${BATCH_ID}-run`;
    if (run.message) row.classList.add(run.failed ? "failed" : "done");

    const pct = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
    row.innerHTML = `
      <div class="szb-head">
        ${run.message ? icon(run.failed ? "warn" : "check", 14) : `<span class="szb-dot"></span>`}
        <span class="szb-count">${escapeHtml(describeRun(run))}</span>
        ${runs.length > 1 ? `<button class="szb-collapse szb-fold" type="button" title="${escapeHtml(t("batch.collapse") || "Collapse")}">${icon("chevronDown", 14)}</button>` : ""}
        <button class="szb-collapse szb-close" type="button" title="${escapeHtml(t("batch.dismiss") || "Dismiss")}">${icon("close", 14)}</button>
      </div>
      <div class="szb-bar${run.message ? "" : " live"}"><i style="width:${pct}%"></i></div>
      <div class="szb-stats">${renderRunStats(run)}</div>
      ${run.note ? `<span class="szb-note">${escapeHtml(run.note)}</span>` : ""}
    `;
    row.querySelector(".szb-fold")?.addEventListener("click", () => { runsCollapsed = true; renderRuns(); });
    row.querySelector(".szb-close")?.addEventListener("click", () => dismissRun(run.batchId));
    container.appendChild(row);
  }
}

export function handleBatchStatus(data: any): void {
  // Every batch this tab started gets its own row, including ones begun before
  // a navigation — the first status message after the reload rebuilds the row.
  const batchId: string | undefined = data?.batchId;
  if (!batchId) return;

  if (data.phase === "start" || data.phase === "progress") {
    updateBatchRun(batchId, {
      done: data.done ?? 0,
      total: data.total ?? 0,
      skipped: data.skipped ?? 0,
      failedCount: data.failedCount ?? undefined,
      poolName: data.poolName,
    });
    return;
  }

  if (data.phase !== "done") return;

  let msg = t("batch.done", { ok: data.succeeded ?? 0, total: data.total ?? 0 }) || `Done: ${data.succeeded}/${data.total}`;
  if (data.skipped) msg += ` · ${t("batch.doneSkipped", { skipped: data.skipped }) || `${data.skipped} already there`}`;
  if (data.failed) msg += ` · ${t("batch.doneFailed", { failed: data.failed }) || `${data.failed} failed`}`;
  if (data.poolName && data.poolId) msg += ` · ${t("batch.pooled") || "pooled"}`;
  if (data.poolError) msg += ` · ${data.poolError}`;
  // Include the first failure's reason so a lone failed item is actionable.
  if (data.failed && data.failedError) msg += ` — ${data.failedError}`;

  // Anything that went wrong stays on screen until the user closes it.
  finishBatchRun(batchId, msg, !!(data.failed || data.poolError));
}

/**
 * Pick up an unfinished selection on page load.
 *
 * A full navigation (the "next page" link on most boorus) destroys this
 * document and everything in it. The basket survives in the background, so the
 * picker is re-opened here with the earlier picks intact — from the user's side
 * the selection simply continues onto the next page.
 */
async function resumeSelection(): Promise<void> {
  const settings = await getBatchSettings();
  if (!settings.enabled || !settings.hasSites) return;

  const state = await sendSelectionCommand({});
  if (!state?.active) return;
  // Nothing to pick here — leave the basket alone and wait for a listing.
  if (findPostAnchors().length < MIN_CANDIDATES) return;

  adoptSelection(state);
  enterBatchSelectMode(false, true);
  const poolInput = batchToolbar?.querySelector<HTMLInputElement>(".szb-pool");
  if (poolInput && state.poolName) poolInput.value = state.poolName;
  refreshSelectionMarks();
}

/**
 * Show a batch that is already running when this page loads.
 *
 * The runner lives in the background and keeps going through navigations and
 * closed tabs; without this, landing on a listing mid-batch would look like
 * nothing was happening until the next post finished.
 */
async function attachToRunningBatch(): Promise<void> {
  try {
    const active: { batchId?: string; done?: number; total?: number; skipped?: number; poolName?: string } | undefined =
      await browser.runtime.sendMessage(new BrowserCommand("batch_active"));
    if (!active?.batchId || !active.total) return;
    updateBatchRun(active.batchId, {
      done: active.done ?? 0,
      total: active.total,
      skipped: active.skipped ?? 0,
      poolName: active.poolName,
    });
  } catch {
    // Worker still waking up; the next status message will build the row.
  }
}

export function installBatchUi(): void {
  // A new listing page means a fresh set of candidates for the batch pill.
  onNavigation(() => {
    // An in-page navigation (pjax paging) keeps the toolbar and the selection
    // alive but swaps the thumbnails out from under them.
    if (batchSelectMode) { refreshSelectionMarks(); return; }
    void updateBatchLauncher();
  });
  onConfigReloaded(() => void updateBatchLauncher());
  void resumeSelection().then(() => {
    if (!batchSelectMode) void updateBatchLauncher();
  });
  void attachToRunningBatch();
}

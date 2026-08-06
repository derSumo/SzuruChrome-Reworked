// ── Background state (MV3-durable) ────────────────────────────────────
// Everything the background holds between messages lives here, mirrored into
// `browser.storage.session` so a service-worker teardown mid-burst doesn't
// silently drop the queue or lose the link chain. See ./sessionState.ts.
//
// Every mutation of these collections must be followed by `persistState()`.

import { getScrapePageUrl } from "~/shared/scrape";
import {
  loadSessionState,
  saveSessionState,
  type ActiveImportEntry,
  type ImportTask,
  type SiteUploadState,
} from "./sessionState";

/** How long a finished import stays restorable for a newly-loaded page. */
const SUCCESS_RETENTION_MS = 15_000;
const ERROR_RETENTION_MS = 8_000;

// Per-site upload state used by the link-chain mode.
// lastUploadedPostId  = most recent normal upload (seed for the next chain).
// linkChain           = posts uploaded consecutively via hotkey_import_link_last.
//                       A normal hotkey/context-menu/popup upload clears the chain.
export const siteStates = new Map<string, SiteUploadState>();

// Tracks in-flight and recently finished imports so content scripts that
// load on the next page can restore toasts that were still visible.
export const activeImports = new Map<string, ActiveImportEntry>();

/** Imports waiting to run, in order. The head is picked up by the queue worker. */
export const importQueue: ImportTask[] = [];

// Page URLs of imports that are currently pending — i.e. still sitting in the
// queue or actively uploading. A URL is removed as soon as its task settles, so
// only a genuine double-fire of the *same* page while a copy is still in flight
// is rejected. Distinct pages and deliberate re-imports of an already-finished
// page are always allowed (szurubooru's own "already uploaded" handling is the
// safety net there, surfaced as a success toast rather than a hard error).
export const pendingPageUrls = new Set<string>();

let activeQueueTask: ImportTask | undefined;

export function getActiveQueueTask(): ImportTask | undefined {
  return activeQueueTask;
}

export function setActiveQueueTask(task: ImportTask | undefined): void {
  activeQueueTask = task;
}

export function getSiteState(siteId: string): SiteUploadState {
  let state = siteStates.get(siteId);
  if (!state) {
    state = { linkChain: [] };
    siteStates.set(siteId, state);
  }
  return state;
}

/** A normal upload seeds the next chain and clears any chain in progress. */
export function recordNormalUpload(siteId: string, postId: number): void {
  const state = getSiteState(siteId);
  state.lastUploadedPostId = postId;
  state.linkChain = [];
  persistState();
}

/** A link-last upload extends the current chain. */
export function recordChainUpload(siteId: string, postId: number): void {
  const state = getSiteState(siteId);
  state.linkChain.push(postId);
  state.lastUploadedPostId = postId;
  persistState();
}

export function persistState(): void {
  saveSessionState({
    siteStates: Object.fromEntries(siteStates),
    activeImports: Object.fromEntries(activeImports),
    // The task currently uploading has already been shifted off the queue, so
    // include it explicitly — otherwise a worker teardown mid-upload would
    // drop exactly the one import that was in progress.
    queue: activeQueueTask ? [activeQueueTask, ...importQueue] : [...importQueue],
  });
}

let successfulImportCleanupTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The whole success history has one lifetime: every completed upload restarts
 * it, so earlier rows do not disappear while a burst continues.
 */
export function scheduleSuccessfulImportCleanup(): void {
  if (successfulImportCleanupTimer) clearTimeout(successfulImportCleanupTimer);
  successfulImportCleanupTimer = setTimeout(() => {
    for (const [importId, entry] of activeImports) {
      if (entry.status === "success") activeImports.delete(importId);
    }
    successfulImportCleanupTimer = undefined;
    persistState();
  }, SUCCESS_RETENTION_MS);
}

/** Errors are transient: drop them once the toast has had time to be read. */
export function scheduleErrorCleanup(importId: string): void {
  setTimeout(() => {
    activeImports.delete(importId);
    persistState();
  }, ERROR_RETENTION_MS);
}

let stateRestored: Promise<void> | undefined;

/**
 * Rehydrate the collections from session storage. Memoised: a freshly revived
 * worker may take several messages at once and must only restore once.
 */
export function restoreState(): Promise<void> {
  stateRestored ??= (async () => {
    const state = await loadSessionState();
    if (!state) return;

    for (const [siteId, value] of Object.entries(state.siteStates)) {
      if (!siteStates.has(siteId)) siteStates.set(siteId, value);
    }
    for (const [importId, entry] of Object.entries(state.activeImports)) {
      if (!activeImports.has(importId)) activeImports.set(importId, entry);
    }
    // Tasks that were still queued when the worker died are resumed. Anything
    // that was mid-upload is indistinguishable from a queued task here, so it
    // re-runs; szurubooru's "already uploaded" handling makes that harmless.
    for (const task of state.queue) {
      if (importQueue.some((x) => x.importId === task.importId)) continue;
      importQueue.push(task);
      const pageUrl = getScrapePageUrl(task.scrapeResults);
      if (pageUrl) pendingPageUrls.add(pageUrl);
    }
  })();
  return stateRestored;
}

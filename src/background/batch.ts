// ── Batch & pool import runner ────────────────────────────────────────
// Imports a list of booru post URLs that the user selected on a listing/
// gallery page. neo-scraper's engines read document.location inside
// scrapeDocument, so a DOMParser document (location === null) crashes them —
// the only correct way to scrape an arbitrary URL is to load it in a real
// tab. We therefore, for each URL in turn:
//   1. open it in a background tab,
//   2. wait for it to finish loading,
//   3. scrape it with the normal content-script grab_post,
//   4. import it (the tab stays open so the content-script CDN fetch works),
//   5. close the tab.
// Sequential by default so we never open a swarm of tabs; the concurrency
// setting is honoured but capped hard for safety.
//
// There is one queue, not one per click. Importing again while a batch runs
// appends to it (see BatchSession), which keeps the totals honest — "12/84"
// rather than four rival runs each claiming "3/42" — and makes a double click
// or an overlapping selection cost nothing, because the session remembers every
// URL it has ever queued.
//
// Pool mode additionally collects the created post ids in selection order and
// assigns them to a szurubooru pool once every item has been processed.
//
// Upload order is reversed by default (`oldestFirst`), because a booru listing
// runs newest → oldest while szurubooru shows the highest post id first: import
// a whole artist in listing order and the instance ends up with that artist's
// oldest work on top. Walking the selection backwards makes the newest source
// post the last upload, and therefore the first one seen afterwards.

import { BrowserCommand } from "~/models";
import { getErrorMessage } from "~/utils";
import { sleep } from "~/shared/async";
import { batchWindow, openScrapeTab } from "./scrapeTab";

const HARD_CONCURRENCY_CAP = 3;

/** Settings that shape how a batch is driven; read once when it starts. */
export interface BatchOptions {
  skipImported: boolean;
  separateWindow: boolean;
  /** Import the selection back to front, newest source post last. */
  oldestFirst: boolean;
}

const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  skipImported: true,
  separateWindow: true,
  oldestFirst: true,
};

export interface BatchImportRequest {
  urls: string[];
  poolName?: string;
  /** Tab these URLs came from; it joins the batch's status recipients. */
  originTabId?: number;
  /** Id to use if this starts a new batch; an append keeps the running one's. */
  batchId: string;
}

export interface BatchItemResult {
  url: string;
  postId?: number;
  alreadyUploaded?: boolean;
  /** Recognised as already imported before any tab was opened. */
  skipped?: boolean;
  error?: string;
}

// The runner calls back into the background for the per-URL work and the pool
// assignment, so this module stays free of the heavy import machinery.
export interface BatchRunnerHooks {
  importUrlInTab: (url: string, tabId: number) => Promise<{ postId?: number; alreadyUploaded?: boolean }>;
  assignPool: (poolName: string, postIds: number[]) => Promise<{ poolId?: number; error?: string }>;
  concurrency: () => Promise<number>;
  /** Settings that shape how the tabs are driven; read once per batch. */
  options: () => Promise<BatchOptions>;
  /** Post id when the URL is already in the instance — then no tab is opened. */
  findImported: (url: string) => Promise<number | undefined>;
}

async function importOneUrlOnce(url: string, hooks: BatchRunnerHooks, separateWindow: boolean): Promise<BatchItemResult> {
  let close: (() => Promise<void>) | undefined;
  try {
    const tab = await openScrapeTab(url, separateWindow);
    close = tab.close;
    const { postId, alreadyUploaded } = await hooks.importUrlInTab(url, tab.tabId);
    return { url, postId, alreadyUploaded };
  } catch (ex) {
    return { url, error: getErrorMessage(ex) };
  } finally {
    // Close only after the upload finished, so the in-tab CDN fetch had the
    // live page context available while it ran.
    await close?.();
  }
}

// Retry with a fresh tab. Chrome throttles background tabs, so a tab can report
// "complete" before the booru's thumbnail/DOM is actually laid out — the scrape
// then finds nothing and the item fails. A second attempt on a new tab clears
// the vast majority of these, which is exactly the "last one always fails"
// pattern (the freshest background tab is the least settled).
async function importOneUrl(
  url: string,
  hooks: BatchRunnerHooks,
  separateWindow: boolean,
  attempts = 2,
): Promise<BatchItemResult> {
  let result: BatchItemResult = { url, error: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    result = await importOneUrlOnce(url, hooks, separateWindow);
    if (!result.error) return result;
    if (i < attempts - 1) await sleep(1500);
  }
  return result;
}

// ── The running batch ─────────────────────────────────────────────────
// There is at most one batch in flight. A second "import" click does not start
// a rival run whose tabs would compete with the first for the same browser and
// the same instance — it appends to the queue that is already going. Which also
// makes the obvious accident harmless: selecting "All" twice, or re-importing a
// listing that is half in the queue already, adds only what is genuinely new,
// because every URL the session has ever seen is remembered.
//
// A pool is the one thing that cannot be merged: posts destined for different
// pools have different endings, so a mismatching pool name starts its own run.

interface BatchSession {
  batchId: string;
  poolName?: string;
  /** Every tab that contributed to this batch; all of them see the progress. */
  originTabIds: Set<number>;
  /** Upload order — reversed against `poolOrder` when `oldestFirst` is on. */
  queue: string[];
  /** The same URLs as the user selected them; the order a pool is built in. */
  poolOrder: string[];
  /** URLs ever queued here — the dedupe that makes a double click a no-op. */
  seen: Set<string>;
  ordered: BatchItemResult[];
  cursor: number;
  done: number;
  concurrency: number;
  options: BatchOptions;
  hooks: BatchRunnerHooks;
  /**
   * Set by `cancelBatchImport`. Workers check it before picking up the next
   * URL, so a cancel stops the queue without killing whatever is mid-upload —
   * tearing a tab down between the content fetch and `createPost` is how you
   * get a half-imported post.
   */
  cancelled?: boolean;
}

let activeSession: BatchSession | undefined;

/**
 * Stop the running batch after the items currently in flight.
 *
 * Returns false when there was nothing to cancel — either no batch is running,
 * or `batchId` names a different one. Anything not yet started is dropped; the
 * queue is not resumable afterwards, so the persisted session is cleared too.
 */
export function cancelBatchImport(batchId?: string): boolean {
  const session = activeSession;
  if (!session) return false;
  if (batchId && session.batchId !== batchId) return false;
  if (session.cancelled) return true;

  session.cancelled = true;
  // Nothing is left to hand out; workers still finishing an item run to the end.
  session.cursor = session.queue.length;
  clearPersistedSession();
  console.log(`[batch] cancel requested for ${session.batchId}`);
  broadcastBatchStatus(session, {
    phase: "progress",
    done: session.done,
    total: session.queue.length,
    skipped: skippedCount(session),
    failed: failedCount(session),
    poolName: session.poolName,
    cancelling: true,
  });
  return true;
}

export interface BatchAcceptance {
  batchId: string;
  /** Newly queued URLs. Zero means everything was already in the queue. */
  accepted: number;
  /** URLs dropped because this batch already covers them. */
  duplicates: number;
  total: number;
  /** Resolves when the whole session ends; only set for a fresh session. */
  completion?: Promise<BatchItemResult[]>;
}

function broadcastBatchStatus(session: BatchSession, payload: Record<string, unknown>) {
  for (const tabId of session.originTabIds) {
    void browser.tabs
      .sendMessage(tabId, new BrowserCommand("batch_status", { batchId: session.batchId, ...payload }))
      .catch(() => {
        // The listing page may have navigated away; progress is best-effort.
      });
  }
}

function skippedCount(session: BatchSession): number {
  return session.ordered.reduce((n, r) => n + (r?.skipped ? 1 : 0), 0);
}

function failedCount(session: BatchSession): number {
  return session.ordered.reduce((n, r) => n + (r?.error ? 1 : 0), 0);
}

// ── Surviving a service-worker teardown ───────────────────────────────
// A batch runs for minutes; the MV3 worker is not guaranteed to live that long
// (a crash, an extension update, or the keep-alive losing a race). Everything
// needed to pick the queue back up is therefore mirrored into storage.session —
// what is left to do, and what has already been done, so a resume neither
// re-imports finished posts nor forgets the rest.
//
// The hooks can't be serialised; batchController rebuilds them and calls
// `resumeBatchImport` on start-up.

export const BATCH_SESSION_KEY = "szuru_batch_session";

interface PersistedSession {
  batchId: string;
  poolName?: string;
  originTabIds: number[];
  queue: string[];
  poolOrder?: string[];
  ordered: (BatchItemResult | undefined)[];
  concurrency: number;
  options: BatchOptions;
}

function sessionArea() {
  return (browser.storage as any).session ?? browser.storage.local;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function persistSession(session: BatchSession): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (activeSession !== session) return;
    const data: PersistedSession = {
      batchId: session.batchId,
      poolName: session.poolName,
      originTabIds: [...session.originTabIds],
      queue: session.queue,
      poolOrder: session.poolOrder,
      ordered: session.ordered,
      concurrency: session.concurrency,
      options: session.options,
    };
    void sessionArea().set({ [BATCH_SESSION_KEY]: data }).catch(() => { /* best effort */ });
  }, 500);
}

function clearPersistedSession(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
  void sessionArea().remove?.(BATCH_SESSION_KEY).catch(() => { /* best effort */ });
}

/**
 * Restart a batch that a worker teardown interrupted. Anything without a result
 * is queued again — including whatever was mid-flight, which is safe: a post
 * that did make it through is recognised as already imported and skipped.
 */
export async function resumeBatchImport(
  hooks: BatchRunnerHooks,
): Promise<{ completion: Promise<BatchItemResult[]> } | undefined> {
  if (activeSession) return undefined;

  let stored: PersistedSession | undefined;
  try {
    stored = (await sessionArea().get(BATCH_SESSION_KEY))?.[BATCH_SESSION_KEY];
  } catch {
    return undefined;
  }
  if (!stored?.queue?.length) return undefined;

  const ordered = Array.isArray(stored.ordered) ? stored.ordered : [];
  const remaining = stored.queue.filter((_, i) => !ordered[i]);
  if (remaining.length === 0) {
    clearPersistedSession();
    return undefined;
  }

  console.log(`[batch] resuming after worker restart: ${remaining.length} of ${stored.queue.length} left`);

  const session: BatchSession = {
    batchId: stored.batchId,
    poolName: stored.poolName,
    originTabIds: new Set(stored.originTabIds ?? []),
    queue: stored.queue,
    // Written since v3.0.4; a session stored before that ran unreversed, so its
    // queue *is* the selection order.
    poolOrder: stored.poolOrder ?? stored.queue,
    seen: new Set(stored.queue),
    // Sparse on purpose: the holes are what still needs importing.
    ordered: ordered as BatchItemResult[],
    cursor: stored.queue.findIndex((_, i) => !ordered[i]),
    done: ordered.filter(Boolean).length,
    concurrency: stored.concurrency || 1,
    options: { ...DEFAULT_BATCH_OPTIONS, ...stored.options },
    hooks,
  };

  // Wrapped, because awaiting this function must not wait for the whole batch:
  // `await` flattens a returned promise.
  return { completion: enqueueSession(session) };
}

/** Summary for a page that wants to show a batch it didn't start itself. */
export function getActiveBatchStatus():
  | { batchId: string; done: number; total: number; skipped: number; poolName?: string; cancelling: boolean }
  | undefined {
  if (!activeSession) return undefined;
  return {
    batchId: activeSession.batchId,
    done: activeSession.done,
    total: activeSession.queue.length,
    skipped: skippedCount(activeSession),
    poolName: activeSession.poolName,
    cancelling: activeSession.cancelled === true,
  };
}

/**
 * Queue the URLs this session hasn't seen yet; returns how many were new.
 *
 * With `oldestFirst` the chunk goes into the upload queue back to front (see the
 * note at the top of this file). Each append is reversed within itself, not the
 * queue as a whole — what is already running keeps running, so selecting page 1
 * and then page 2 gives two newest-last runs rather than one.
 */
function appendToSession(session: BatchSession, urls: string[], originTabId?: number): { accepted: number; duplicates: number } {
  let duplicates = 0;
  const fresh: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (session.seen.has(url)) { duplicates++; continue; }
    session.seen.add(url);
    fresh.push(url);
  }

  for (const url of fresh) session.poolOrder.push(url);
  for (const url of session.options.oldestFirst ? fresh.slice().reverse() : fresh) session.queue.push(url);

  if (typeof originTabId === "number") session.originTabIds.add(originTabId);
  return { accepted: fresh.length, duplicates };
}

async function runWorker(session: BatchSession): Promise<void> {
  for (;;) {
    if (session.cancelled) return;
    const index = session.cursor++;
    const url = session.queue[index];
    if (url === undefined) return;
    // Carries a result already: a resumed session walks past what is done.
    if (session.ordered[index]) continue;

    // Posts already in the instance cost nothing here: no tab, no page load,
    // no upload. On a listing the user has half-imported this is the
    // difference between minutes and seconds.
    let result: BatchItemResult | undefined;
    if (session.options.skipImported) {
      const postId = await session.hooks.findImported(url).catch(() => undefined);
      if (postId) result = { url, postId, alreadyUploaded: true, skipped: true };
    }
    result ??= await importOneUrl(url, session.hooks, session.options.separateWindow);

    session.ordered[index] = result;
    session.done++;
    persistSession(session);
    broadcastBatchStatus(session, {
      phase: "progress",
      done: session.done,
      total: session.queue.length,
      skipped: skippedCount(session),
      failed: failedCount(session),
      poolName: session.poolName,
      lastUrl: url,
      lastPostId: result.postId,
      lastError: result.error,
    });
  }
}

async function runSession(session: BatchSession): Promise<BatchItemResult[]> {
  batchWindow.acquire(session.options.separateWindow);
  broadcastBatchStatus(session, { phase: "start", total: session.queue.length, poolName: session.poolName });

  try {
    // Workers exit when the queue runs dry — but an append may have landed in
    // the same tick, so re-check before calling it a day.
    for (;;) {
      await Promise.all(Array.from({ length: session.concurrency }, () => runWorker(session)));
      if (session.cancelled || session.cursor >= session.queue.length) break;
    }
  } finally {
    await batchWindow.release();
  }

  // Detach synchronously, before the first await below: from here on the queue
  // is closed, and anything appended has to open a new session instead of
  // slipping into one that is already writing its pool and final status.
  if (activeSession === session) activeSession = undefined;
  clearPersistedSession();

  const results = session.ordered.filter(Boolean);

  // Pool assignment, in the order the user selected the posts — deliberately
  // not the upload order: a pool's sequence is its page order and must not flip
  // just because `oldestFirst` uploads the selection backwards.
  //
  // A cancelled batch still pools what it managed to import: those posts exist
  // in the instance either way, and leaving them out of the pool would be the
  // surprising outcome.
  let poolResult: { poolId?: number; error?: string } | undefined;
  if (session.poolName) {
    const byUrl = new Map(results.map((r) => [r.url, r]));
    const postIds = session.poolOrder
      .map((url) => byUrl.get(url)?.postId)
      .filter((id): id is number => id !== undefined);
    if (postIds.length > 0) {
      poolResult = await session.hooks
        .assignPool(session.poolName, postIds)
        .catch((ex) => ({ error: getErrorMessage(ex) }));
    }
  }

  const failures = results.filter((r) => r.error);
  const succeeded = results.filter((r) => r.postId && !r.error).length;
  // Surface the first failure's reason so the toast can say *why* — a silent
  // "1 failed" is impossible to act on.
  const firstFailure = failures[0];
  if (firstFailure) {
    console.warn("Batch import failures:", failures.map((f) => `${f.url} → ${f.error}`).join("; "));
  }
  broadcastBatchStatus(session, {
    phase: "done",
    // A cancelled run reports against what it actually attempted, not against
    // the queue it never got through — "24/24, 300 cancelled" reads honestly,
    // "24/324 done" reads like a failure.
    total: session.cancelled ? session.done : session.queue.length,
    cancelled: session.cancelled === true,
    cancelledRemaining: session.cancelled ? Math.max(0, session.queue.length - session.done) : 0,
    succeeded,
    skipped: skippedCount(session),
    failed: failures.length,
    failedUrl: firstFailure?.url,
    failedError: firstFailure?.error,
    poolName: session.poolName,
    poolId: poolResult?.poolId,
    poolError: poolResult?.error,
  });

  return results;
}

/**
 * Sessions run strictly one after another. A batch bound for a different pool
 * can't merge into the running one, but it must not run *beside* it either —
 * two runs would open twice the tabs and hammer the source site — so it waits
 * its turn on this chain.
 */
let sessionChain: Promise<unknown> = Promise.resolve();

function enqueueSession(session: BatchSession): Promise<BatchItemResult[]> {
  const completion = sessionChain.then(() => {
    activeSession = session;
    persistSession(session);
    return runSession(session);
  });
  // The chain must never break on a failed session.
  sessionChain = completion.then(() => undefined, () => undefined);
  return completion;
}

/**
 * Queue `req.urls`: appended to the batch already running when their pool
 * matches, otherwise started as a new one.
 */
export async function runBatchImport(req: BatchImportRequest, hooks: BatchRunnerHooks): Promise<BatchAcceptance> {
  const urls = [...new Set(req.urls)].filter(Boolean);

  // Same destination → same run. `undefined` and "" both mean "no pool".
  if (activeSession && (activeSession.poolName ?? "") === (req.poolName ?? "")) {
    const session = activeSession;
    const { accepted, duplicates } = appendToSession(session, urls, req.originTabId);
    console.log(`[batch] appended ${accepted} url(s) to running batch (${duplicates} already queued)`);
    persistSession(session);
    broadcastBatchStatus(session, {
      phase: "progress",
      done: session.done,
      total: session.queue.length,
      skipped: skippedCount(session),
      failed: failedCount(session),
      poolName: session.poolName,
      accepted,
      duplicates,
    });
    return { batchId: session.batchId, accepted, duplicates, total: session.queue.length };
  }

  const requested = await hooks.concurrency().catch(() => 1);
  const session: BatchSession = {
    batchId: req.batchId,
    poolName: req.poolName,
    originTabIds: new Set(typeof req.originTabId === "number" ? [req.originTabId] : []),
    queue: [],
    poolOrder: [],
    seen: new Set(),
    ordered: [],
    cursor: 0,
    done: 0,
    concurrency: Math.max(1, Math.min(requested || 1, HARD_CONCURRENCY_CAP)),
    options: await hooks.options().catch(() => ({ ...DEFAULT_BATCH_OPTIONS })),
    hooks,
  };
  const { accepted, duplicates } = appendToSession(session, urls);
  console.log(`[batch] new batch with ${accepted} url(s), pool: ${session.poolName ?? "(none)"}`);

  return {
    batchId: session.batchId,
    accepted,
    duplicates,
    total: session.queue.length,
    completion: enqueueSession(session),
  };
}

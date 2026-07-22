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
// Pool mode additionally collects the created post ids in selection order and
// assigns them to a szurubooru pool once every item has been processed.

import { BrowserCommand } from "~/models";
import { getErrorMessage } from "~/utils";

const TAB_LOAD_TIMEOUT_MS = 30_000;
const HARD_CONCURRENCY_CAP = 3;

export interface BatchImportRequest {
  urls: string[];
  poolName?: string;
  /** Tab that launched the batch — receives progress updates. */
  originTabId?: number;
  batchId: string;
}

export interface BatchItemResult {
  url: string;
  postId?: number;
  alreadyUploaded?: boolean;
  error?: string;
}

// The runner calls back into the background for the per-URL work and the pool
// assignment, so this module stays free of the heavy import machinery.
export interface BatchRunnerHooks {
  importUrlInTab: (url: string, tabId: number) => Promise<{ postId?: number; alreadyUploaded?: boolean }>;
  assignPool: (poolName: string, postIds: number[]) => Promise<{ poolId?: number; error?: string }>;
  concurrency: () => Promise<number>;
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn();
    };

    const onUpdated = (updatedTabId: number, changeInfo: any) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve);
      }
    };

    const timer = setTimeout(() => finish(() => reject(new Error("Tab load timed out"))), TAB_LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);

    // The tab may already be "complete" (e.g. served from cache) before the
    // listener attached — check once up front.
    browser.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(resolve);
    }).catch(() => { /* handled by timeout */ });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function importOneUrlOnce(url: string, hooks: BatchRunnerHooks): Promise<BatchItemResult> {
  let tabId: number | undefined;
  try {
    const tab = await browser.tabs.create({ url, active: false });
    tabId = tab.id;
    if (typeof tabId !== "number") throw new Error("Could not open tab");

    await waitForTabComplete(tabId);
    const { postId, alreadyUploaded } = await hooks.importUrlInTab(url, tabId);
    return { url, postId, alreadyUploaded };
  } catch (ex) {
    return { url, error: getErrorMessage(ex) };
  } finally {
    // Close only after the upload finished, so the in-tab CDN fetch had the
    // live page context available while it ran.
    if (typeof tabId === "number") {
      await browser.tabs.remove(tabId).catch(() => { /* already gone */ });
    }
  }
}

// Retry with a fresh tab. Chrome throttles background tabs, so a tab can report
// "complete" before the booru's thumbnail/DOM is actually laid out — the scrape
// then finds nothing and the item fails. A second attempt on a new tab clears
// the vast majority of these, which is exactly the "last one always fails"
// pattern (the freshest background tab is the least settled).
async function importOneUrl(url: string, hooks: BatchRunnerHooks, attempts = 2): Promise<BatchItemResult> {
  let result: BatchItemResult = { url, error: "not attempted" };
  for (let i = 0; i < attempts; i++) {
    result = await importOneUrlOnce(url, hooks);
    if (!result.error) return result;
    if (i < attempts - 1) await sleep(1500);
  }
  return result;
}

function sendBatchStatus(originTabId: number | undefined, batchId: string, payload: Record<string, unknown>) {
  if (typeof originTabId !== "number") return;
  void browser.tabs.sendMessage(originTabId, new BrowserCommand("batch_status", { batchId, ...payload })).catch(() => {
    // The listing page may have navigated away; progress is best-effort.
  });
}

export async function runBatchImport(req: BatchImportRequest, hooks: BatchRunnerHooks): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  const urls = [...new Set(req.urls)].filter(Boolean);
  const total = urls.length;
  let done = 0;

  sendBatchStatus(req.originTabId, req.batchId, { phase: "start", total });

  const requested = await hooks.concurrency().catch(() => 1);
  const concurrency = Math.max(1, Math.min(requested || 1, HARD_CONCURRENCY_CAP));

  // A tiny worker pool. Pool mode still gets its ids in selection order because
  // we key results back to the URL's original index below.
  const indexed = urls.map((url, index) => ({ url, index }));
  const ordered: BatchItemResult[] = new Array(total);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const next = indexed[cursor++];
      if (!next) return;
      const result = await importOneUrl(next.url, hooks);
      ordered[next.index] = result;
      done++;
      sendBatchStatus(req.originTabId, req.batchId, {
        phase: "progress",
        done,
        total,
        lastUrl: next.url,
        lastPostId: result.postId,
        lastError: result.error,
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  results.push(...ordered.filter(Boolean));

  // Pool assignment, in the order the user selected the posts.
  let poolResult: { poolId?: number; error?: string } | undefined;
  if (req.poolName) {
    const postIds = ordered.filter((r) => r?.postId).map((r) => r!.postId!);
    if (postIds.length > 0) {
      poolResult = await hooks.assignPool(req.poolName, postIds).catch((ex) => ({ error: getErrorMessage(ex) }));
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
  sendBatchStatus(req.originTabId, req.batchId, {
    phase: "done",
    total,
    succeeded,
    failed: failures.length,
    failedUrl: firstFailure?.url,
    failedError: firstFailure?.error,
    poolName: req.poolName,
    poolId: poolResult?.poolId,
    poolError: poolResult?.error,
  });

  return results;
}

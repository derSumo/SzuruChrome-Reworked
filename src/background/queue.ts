// ── Sequential import queue ───────────────────────────────────────────
// All hotkey, link-chain, context-menu and retry imports go through this queue
// so they run one after another instead of racing. The chain bookkeeping for
// link-last imports happens in the queue worker (not at enqueue time) so the
// chain reflects the actual upload order.

import { t } from "~/i18n";
import { getErrorMessage } from "~/utils";
import { sleep } from "~/shared/async";
import { getScrapePageUrl } from "~/shared/scrape";
import { postUrlFor } from "~/shared/host";
import { recordImport, removeFailure } from "~/stats";
import { importCurrentPageInBackground, tryLinkPostWithRelations } from "./importPipeline";
import { cacheImportedCheck } from "./importedCheck";
import { getImportSettings } from "./settings";
import { sendQuickImportStatus } from "./status";
import { refreshQueueBadge, setImportedTabBadge } from "./toolbarBadge";
import {
  activeImports,
  getSiteState,
  importQueue,
  pendingPageUrls,
  persistState,
  recordChainUpload,
  recordNormalUpload,
  restoreState,
  setActiveQueueTask,
} from "./state";
import { startKeepAlive, stopKeepAlive, type ImportTask } from "./sessionState";

const MAX_RETRY_BACKOFF_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 1000;

let queueRunning = false;

/**
 * Transient conditions worth another attempt: the network dropped, the CDN
 * rate-limited us, or szurubooru itself hiccuped. A rejected upload (bad
 * credentials, unsupported file, nothing to scrape) fails identically on every
 * retry, so those go straight to the failure list.
 */
const RETRYABLE_PATTERNS = [
  /network/i,
  /timed? ?out/i,
  /timeout/i,
  /failed to fetch/i,
  /econnreset/i,
  /socket/i,
  /temporarily/i,
  /\bHTTP 4(08|29)\b/,
  /\bHTTP 5\d\d\b/,
];

function isRetryableError(message: string): boolean {
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

/** Rehydrate persisted state and resume anything the worker teardown left behind. */
export function ensureStateRestored(): Promise<void> {
  return restoreState().then(() => {
    refreshQueueBadge();
    if (importQueue.length > 0 && !queueRunning) {
      console.log(`Resuming ${importQueue.length} queued import(s) after worker restart.`);
      void runQueue();
    }
  });
}

export function enqueueImport(task: ImportTask): void {
  const pageUrl = getScrapePageUrl(task.scrapeResults);
  if (pageUrl && pendingPageUrls.has(pageUrl)) {
    // The exact same page is already queued/uploading — this is a redundant
    // double-fire (e.g. the hotkey pressed twice on one page). Reject it so we
    // don't create two posts of the same image in a race.
    void sendQuickImportStatus(task.tabId, "error", {
      importId: task.importId,
      message: t("bg.duplicateInBurst"),
    });
    return;
  }

  if (pageUrl) pendingPageUrls.add(pageUrl);
  importQueue.push(task);
  persistState();
  refreshQueueBadge();
  void sendQuickImportStatus(task.tabId, "running", {
    importId: task.importId,
    queued: importQueue.length > 0 && queueRunning,
  });
  void runQueue();
}

async function runQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  // Uploads regularly outlive Chrome's 30s service-worker idle timeout.
  startKeepAlive();

  try {
    while (importQueue.length > 0) {
      const task = importQueue.shift()!;
      setActiveQueueTask(task);
      persistState();
      refreshQueueBadge();

      try {
        await processImportTask(task);
      } catch (ex) {
        await handleTaskFailure(task, getErrorMessage(ex));
      } finally {
        const key = getScrapePageUrl(task.scrapeResults);
        // Keep the de-dupe lock while a retry is pending — the task is back in
        // the queue and a fresh hotkey press for the same page is still a dupe.
        if (key && !importQueue.some((x) => getScrapePageUrl(x.scrapeResults) === key)) {
          pendingPageUrls.delete(key);
        }
        setActiveQueueTask(undefined);
        persistState();
        refreshQueueBadge();
      }
    }
  } finally {
    queueRunning = false;
    stopKeepAlive();
    persistState();
    refreshQueueBadge();
  }
}

/** Re-queue with backoff when the error looks transient, else record a failure. */
async function handleTaskFailure(task: ImportTask, message: string): Promise<void> {
  const attempts = (task.attempts ?? 0) + 1;
  const { retryEnabled, maxAttempts } = await getImportSettings();

  if (retryEnabled && attempts < maxAttempts && isRetryableError(message)) {
    // Exponential-ish backoff: 2s, 4s, 8s … capped so a long queue behind a
    // flaky host still drains in reasonable time.
    const delay = Math.min(2000 * 2 ** (attempts - 1), MAX_RETRY_BACKOFF_MS);
    console.warn(`Queued import failed (attempt ${attempts}/${maxAttempts}), retrying in ${delay}ms:`, message);
    await sendQuickImportStatus(task.tabId, "running", {
      importId: task.importId,
      queued: true,
      message: t("bg.retrying", { attempt: attempts + 1, total: maxAttempts }),
    });
    await sleep(delay);
    // Re-queue at the front so retries stay near their original position
    // instead of landing behind an entire burst.
    importQueue.unshift({ ...task, attempts });
    persistState();
    refreshQueueBadge();
    return;
  }

  console.error("Queued import failed:", message);
  await sendQuickImportStatus(task.tabId, "error", { message, importId: task.importId });
  await recordFailure(task, message, attempts);
}

async function recordFailure(task: ImportTask, message: string, attempts: number): Promise<void> {
  const { statsEnabled, selectedSiteId } = await getImportSettings();
  if (!statsEnabled) return;

  const pageUrl = getScrapePageUrl(task.scrapeResults) ?? task.tabUrl;
  await recordImport({
    outcome: "error",
    pageUrl,
    siteId: selectedSiteId,
    failure: {
      id: task.importId,
      pageUrl,
      siteId: selectedSiteId,
      message,
      attempts,
      // Storing the scrape lets the options page retry without the original
      // tab still being open.
      scrapeResults: task.scrapeResults,
    },
  }).catch((ex) => console.warn("Failed to record import failure:", ex));
}

/**
 * Link a finished link-last upload to the current chain, seeding the chain from
 * the previous normal upload when it is still empty.
 */
async function applyLinkChain(
  siteId: string,
  selectedSite: Parameters<typeof tryLinkPostWithRelations>[0],
  postId: number,
  linkedPostIds: number[] | undefined,
): Promise<number[] | undefined> {
  const state = getSiteState(siteId);
  // If the chain is empty, seed it with the previous "normal" upload so the
  // very first link-last upload still links to the last normal post.
  const seed = state.linkChain.length === 0 && state.lastUploadedPostId ? [state.lastUploadedPostId] : [];
  const targets = [...state.linkChain, ...seed];

  let result = linkedPostIds;
  if (targets.length > 0) {
    try {
      await tryLinkPostWithRelations(selectedSite, postId, targets);
      result = [...new Set([...(linkedPostIds ?? []), ...targets])].filter((id) => id !== postId);
    } catch (ex) {
      console.warn("Chain relation linking failed:", getErrorMessage(ex));
    }
  }

  // Seed the chain with the previous upload too, so subsequent chain entries
  // keep linking back to it (and to each other).
  if (state.linkChain.length === 0 && state.lastUploadedPostId) {
    state.linkChain.push(state.lastUploadedPostId);
  }
  recordChainUpload(siteId, postId);

  return result;
}

async function processImportTask(task: ImportTask): Promise<void> {
  // Signal that this specific import has started its actual upload phase.
  await sendQuickImportStatus(task.tabId, "running", { importId: task.importId, queued: false });

  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const entry = activeImports.get(task.importId);
    if (entry?.status === "success" || entry?.status === "error") return;
    void sendQuickImportStatus(task.tabId, "heartbeat", {
      importId: task.importId,
      progress: entry?.progress,
      speedBytesPerSecond: entry?.speedBytesPerSecond,
      totalBytes: entry?.totalBytes,
      elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const result = await importCurrentPageInBackground(task.tabId, task.tabUrl, task.importId, task.scrapeResults);
    const postId = result.info.instancePostId;
    const siteId = result.selectedSite.id;
    const postUrl = postId ? postUrlFor(result.selectedSite.domain, postId) : undefined;
    let linkedPostIds = result.info.relatedPostIds ? [...result.info.relatedPostIds] : undefined;

    if (postId) {
      if (task.kind === "link_last") {
        linkedPostIds = await applyLinkChain(siteId, result.selectedSite, postId, linkedPostIds);
      } else {
        // A normal upload resets any active chain so the next link-last starts fresh.
        recordNormalUpload(siteId, postId);
      }
    }

    // Read the transferred size before the success update replaces the entry.
    const transferredBytes = activeImports.get(task.importId)?.totalBytes;

    await sendQuickImportStatus(task.tabId, "success", {
      postId,
      postUrl,
      alreadyUploaded: result.alreadyUploaded,
      linkedPostIds,
      duplicateOutcome: result.info.duplicateOutcome,
      importId: task.importId,
    });

    // Prime the badge cache so returning to this page shows "imported"
    // immediately instead of after the next lookup TTL.
    const taskPageUrl = getScrapePageUrl(task.scrapeResults) ?? task.tabUrl;
    if (taskPageUrl && postId) {
      cacheImportedCheck(taskPageUrl, { imported: true, postId, postUrl });
    }
    if (typeof task.tabId === "number" && postId) setImportedTabBadge(task.tabId, true);

    // A retry that finally succeeded should disappear from the failure list.
    if (task.isRetry || (task.attempts ?? 0) > 0) {
      await removeFailure(task.importId).catch(() => { });
    }

    const { statsEnabled } = await getImportSettings();
    if (statsEnabled) {
      await recordImport({
        outcome: result.alreadyUploaded ? "duplicate" : "success",
        pageUrl: taskPageUrl,
        siteId,
        postId,
        bytes: transferredBytes,
        durationMs: Date.now() - startedAt,
      }).catch((ex) => console.warn("Failed to record import stats:", ex));
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/** True while the queue worker is draining — batch mode shares the keep-alive. */
export function isQueueRunning(): boolean {
  return queueRunning;
}

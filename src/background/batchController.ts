// ── Batch import wiring ───────────────────────────────────────────────
// Connects the tab-driving runner in ./batch.ts to the import pipeline, pool
// assignment and statistics. Kept apart from the runner so that module stays
// free of the heavy import machinery.

import SzurubooruApi from "~/api";
import { t } from "~/i18n";
import { encodeTagName, getErrorMessage } from "~/utils";
import { recordImport } from "~/stats";
import { resumeBatchImport, runBatchImport, type BatchImportRequest, type BatchRunnerHooks } from "./batch";
import { grabPostsWithRetry, importCurrentPageInBackground } from "./importPipeline";
import { cacheImportedCheck, checkImported } from "./importedCheck";
import { isQueueRunning } from "./queue";
import { getImportSettings, readStoredConfig, resolveSelectedSite } from "./settings";
import { startKeepAlive, stopKeepAlive } from "./sessionState";
import type { SzuruSiteConfig } from "~/models";

/**
 * Create the pool if absent, else append. Ids stay in selection order and are
 * de-duplicated so re-running a batch doesn't add a post twice.
 */
export async function assignPostsToPool(
  site: SzuruSiteConfig,
  poolName: string,
  postIds: number[],
): Promise<{ poolId?: number; error?: string }> {
  console.log(`[pool] assigning ${postIds.length} post(s) to pool "${poolName}"`, postIds);
  try {
    const szuru = SzurubooruApi.createFromConfig(site);

    // Look for an existing pool by exact name. A search that errors (e.g. the
    // name trips szurubooru's query parser) must NOT abort the whole operation
    // — fall through and create the pool, which is the common case anyway.
    let existing: Awaited<ReturnType<typeof szuru.getPools>> | undefined;
    try {
      existing = await szuru.getPools(`name:${encodeTagName(poolName)}`, 0, 5, ["id", "names", "posts", "version"]);
    } catch (searchEx) {
      console.warn("[pool] search failed, will attempt to create instead:", getErrorMessage(searchEx));
    }

    const match = existing?.results?.find((p) => p.names?.some((n) => n.toLowerCase() === poolName.toLowerCase()));

    if (!match) {
      // `category` is required and must be an EXISTING pool category. Hardcoding
      // "default" fails on instances whose pool category is named differently
      // (that's why manual creation works but this didn't). Resolve the real
      // default category, falling back to "default" only if the lookup fails.
      let category = "default";
      try {
        const cats = (await szuru.getPoolCategories())?.results ?? [];
        const chosen = cats.find((c) => c.default) ?? cats[0];
        if (chosen?.name) category = chosen.name;
      } catch (catEx) {
        console.warn("[pool] could not read pool categories, using \"default\":", getErrorMessage(catEx));
      }

      // Create empty, then add posts via the proven updatePool path — some
      // szurubooru versions validate a create-with-posts payload differently.
      const created = await szuru.createPool(poolName, category);
      console.log(`[pool] created pool #${created.id} "${poolName}" (category "${category}"), adding ${postIds.length} post(s)`);
      if (postIds.length > 0) {
        await szuru.updatePool(created.id, { version: created.version ?? 0, posts: postIds });
      }
      return { poolId: created.id };
    }

    const seen = new Set<number>();
    const merged = [...match.posts.map((x) => x.id), ...postIds].filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    await szuru.updatePool(match.id, { version: match.version, posts: merged });
    console.log(`[pool] updated pool #${match.id} "${poolName}" → ${merged.length} post(s)`);
    return { poolId: match.id };
  } catch (ex) {
    console.error("[pool] assignment failed:", getErrorMessage(ex));
    return { error: getErrorMessage(ex) };
  }
}

/** Batches currently in flight; they may overlap, so the keep-alive is counted. */
let runningBatches = 0;

/** The callbacks the runner needs; identical for a fresh and a resumed batch. */
function buildHooks(poolSite: SzuruSiteConfig | undefined): BatchRunnerHooks {
  return {
    concurrency: async () => (await readStoredConfig())?.batchImport?.concurrency ?? 1,

    options: async () => {
      const batchCfg = (await readStoredConfig())?.batchImport;
      return {
        skipImported: batchCfg?.skipImported !== false,
        separateWindow: batchCfg?.separateWindow !== false,
        oldestFirst: batchCfg?.oldestFirst !== false,
      };
    },

    // Deliberately the single-URL check, not the bulk one: a false negative
    // here only costs a redundant tab, but a false *positive* would silently
    // drop a post from the batch.
    findImported: async (url) => {
      const result = await checkImported({ pageUrl: url });
      return result.imported ? result.postId : undefined;
    },

    importUrlInTab: async (url, tabId) => {
      const startedAt = Date.now();
      // Scrape with retries here (not inside importCurrentPageInBackground) so
      // a throttled background tab that isn't laid out yet gets another chance
      // instead of failing the item outright.
      const scrapeResults = await grabPostsWithRetry(tabId);
      const result = await importCurrentPageInBackground(tabId, url, crypto.randomUUID(), scrapeResults);
      const postId = result.info.instancePostId;

      const { statsEnabled } = await getImportSettings();
      if (statsEnabled) {
        await recordImport({
          outcome: result.alreadyUploaded ? "duplicate" : "success",
          pageUrl: url,
          siteId: result.selectedSite.id,
          durationMs: Date.now() - startedAt,
        }).catch(() => { });
      }

      if (postId && url) cacheImportedCheck(url, { imported: true, postId });
      return { postId, alreadyUploaded: result.alreadyUploaded };
    },

    assignPool: async (poolName, postIds) => {
      if (!poolSite) return { error: t("bg.noInstances") };
      return assignPostsToPool(poolSite, poolName, postIds);
    },
  };
}

/** Record the failures of a finished batch and let go of the keep-alive. */
function trackBatchCompletion(completion: Promise<Array<{ url: string; error?: string }>>): void {
  void completion
    .then(async (results) => {
      const { statsEnabled, selectedSiteId } = await getImportSettings();
      if (!statsEnabled) return;
      for (const r of results.filter((x) => x.error)) {
        await recordImport({
          outcome: "error",
          pageUrl: r.url,
          siteId: selectedSiteId,
          failure: {
            id: crypto.randomUUID(),
            pageUrl: r.url,
            siteId: selectedSiteId,
            message: r.error ?? "Unknown error",
            attempts: 1,
          },
        }).catch(() => { });
      }
    })
    .catch((ex) => console.error("Batch import failed:", getErrorMessage(ex)))
    .finally(() => {
      runningBatches = Math.max(0, runningBatches - 1);
      if (runningBatches === 0 && !isQueueRunning()) stopKeepAlive();
    });
}

/**
 * Pick a batch back up after the service worker was torn down mid-run. Called
 * once on start-up, next to the import queue's own restore.
 */
export async function resumeInterruptedBatch(): Promise<void> {
  const cfg = await readStoredConfig();
  const poolSite = cfg ? resolveSelectedSite(cfg, undefined) : undefined;

  runningBatches++;
  startKeepAlive();
  const resumed = await resumeBatchImport(buildHooks(poolSite)).catch((ex) => {
    console.warn("Could not resume batch:", getErrorMessage(ex));
    return undefined;
  });

  if (!resumed) {
    runningBatches = Math.max(0, runningBatches - 1);
    if (runningBatches === 0 && !isQueueRunning()) stopKeepAlive();
    return;
  }
  trackBatchCompletion(resumed.completion);
}

export async function handleBatchImport(
  data: { urls?: string[]; poolName?: string; batchId?: string },
  originTabId?: number,
): Promise<{ batchId: string; accepted: number; duplicates: number; total: number }> {
  const urls = Array.isArray(data.urls) ? data.urls.filter((u) => typeof u === "string" && u) : [];
  if (urls.length === 0) throw new Error(t("bg.batchNoUrls"));

  const req: BatchImportRequest = {
    urls,
    poolName: data.poolName?.trim() || undefined,
    originTabId,
    batchId: data.batchId ?? crypto.randomUUID(),
  };

  // Resolve the pool's target instance once (pool mode targets the selected
  // instance even if individual posts host-map elsewhere).
  const cfgForPool = req.poolName ? await readStoredConfig() : undefined;
  const poolSite = cfgForPool ? resolveSelectedSite(cfgForPool, undefined) : undefined;

  // A batch of tab-loads + uploads easily outlives Chrome's 30s service-worker
  // idle timeout, so hold the worker open for its duration (the plain queue
  // does the same). Counted, because a second batch can be queued behind the
  // running one — the first to finish must not pull the keep-alive out from
  // under it.
  runningBatches++;
  startKeepAlive();

  // The runner streams progress to the involved tabs via batch_status, so this
  // returns as soon as the URLs are queued. Success stats are recorded inline
  // (once per item); failures are recorded afterwards from the result list so
  // per-attempt retries don't double-count.
  const acceptance = await runBatchImport(req, buildHooks(poolSite));

  // Only a fresh session carries a completion; an append rode along on one that
  // already holds the keep-alive and will record its own stats at the end.
  if (!acceptance.completion) {
    runningBatches = Math.max(0, runningBatches - 1);
    if (runningBatches === 0 && !isQueueRunning()) stopKeepAlive();
    return {
      batchId: acceptance.batchId,
      accepted: acceptance.accepted,
      duplicates: acceptance.duplicates,
      total: acceptance.total,
    };
  }

  trackBatchCompletion(acceptance.completion);

  return {
    batchId: acceptance.batchId,
    accepted: acceptance.accepted,
    duplicates: acceptance.duplicates,
    total: acceptance.total,
  };
}

// ── Import one post URL that isn't open in front of the user ──────────
// Behind the per-thumbnail buttons on a listing page: import the post this
// thumbnail links to, without navigating there.
//
// Mechanically the same trick the batch runner uses — neo-scraper needs a real
// document, so the post is loaded in a background tab, scraped, imported and
// the tab closed again. What differs is everything around it: this runs on its
// own (a hover click must not queue behind a 500-post batch), it reports
// through the regular import toasts in the tab the user is actually looking at,
// and it can chain the new post to the previous one, exactly like the
// "import + link last" shortcut.

import { t } from "~/i18n";
import { getErrorMessage } from "~/utils";
import { postUrlFor } from "~/shared/host";
import { recordImport } from "~/stats";
import { openScrapeTab } from "./scrapeTab";
import { grabPostsWithRetry, importCurrentPageInBackground, tryLinkPostWithRelations } from "./importPipeline";
import { cacheImportedCheck } from "./importedCheck";
import { getImportSettings } from "./settings";
import { sendQuickImportStatus } from "./status";
import { getSiteState, recordChainUpload, recordNormalUpload } from "./state";
import { setImportedTabBadge } from "./toolbarBadge";
import { startKeepAlive, stopKeepAlive } from "./sessionState";
import { isQueueRunning } from "./queue";
import type { SzuruSiteConfig } from "~/models";

export interface ImportPostUrlRequest {
  url?: string;
  /** Chain the new post to the previous import, like the link-last shortcut. */
  linkLast?: boolean;
  importId?: string;
}

export interface ImportPostUrlResult {
  postId?: number;
  postUrl?: string;
  alreadyUploaded?: boolean;
  linkedPostIds?: number[];
  error?: string;
}

/** Hover imports are one-offs; more than a couple at once is a misclick. */
const MAX_CONCURRENT = 3;
let running = 0;

/**
 * Link `postId` into the running chain, seeding it from the last normal upload
 * so the first link-last import still attaches to what came before it. Same
 * rules as the queue's chain, kept in step through the shared site state.
 */
async function linkToChain(site: SzuruSiteConfig, postId: number): Promise<number[] | undefined> {
  const state = getSiteState(site.id);
  const seed = state.linkChain.length === 0 && state.lastUploadedPostId ? [state.lastUploadedPostId] : [];
  const targets = [...state.linkChain, ...seed];

  let linked: number[] | undefined;
  if (targets.length > 0) {
    try {
      await tryLinkPostWithRelations(site, postId, targets);
      linked = targets.filter((id) => id !== postId);
    } catch (ex) {
      console.warn("[hover import] chain linking failed:", getErrorMessage(ex));
    }
  }

  if (state.linkChain.length === 0 && state.lastUploadedPostId) {
    state.linkChain.push(state.lastUploadedPostId);
  }
  recordChainUpload(site.id, postId);
  return linked;
}

export async function importPostUrl(
  req: ImportPostUrlRequest,
  originTabId?: number,
): Promise<ImportPostUrlResult> {
  const url = req?.url;
  if (!url) return { error: t("bg.noMedia") };
  if (running >= MAX_CONCURRENT) return { error: t("bg.hoverBusy") };

  const importId = req.importId ?? crypto.randomUUID();
  const startedAt = Date.now();
  running++;
  startKeepAlive();

  // The toast lives in the page the user is on, not in the hidden tab.
  void sendQuickImportStatus(originTabId, "running", { importId, queued: false });

  let close: (() => Promise<void>) | undefined;
  try {
    const tab = await openScrapeTab(url);
    close = tab.close;

    const scrapeResults = await grabPostsWithRetry(tab.tabId);
    const result = await importCurrentPageInBackground(tab.tabId, url, importId, scrapeResults);
    const postId = result.info.instancePostId;
    const site = result.selectedSite;
    const postUrl = postId ? postUrlFor(site.domain, postId) : undefined;

    let linkedPostIds = result.info.relatedPostIds ? [...result.info.relatedPostIds] : undefined;
    if (postId) {
      if (req.linkLast) {
        const chained = await linkToChain(site, postId);
        if (chained?.length) linkedPostIds = [...new Set([...(linkedPostIds ?? []), ...chained])];
      } else {
        // A plain import ends any chain, so the next link-last starts here.
        recordNormalUpload(site.id, postId);
      }
    }

    void sendQuickImportStatus(originTabId, "success", {
      importId,
      postId,
      postUrl,
      alreadyUploaded: result.alreadyUploaded,
      linkedPostIds,
      duplicateOutcome: result.info.duplicateOutcome,
    });

    if (postId) {
      cacheImportedCheck(url, { imported: true, postId, postUrl });
      if (typeof originTabId === "number") setImportedTabBadge(originTabId, true);
    }

    const { statsEnabled } = await getImportSettings();
    if (statsEnabled) {
      await recordImport({
        outcome: result.alreadyUploaded ? "duplicate" : "success",
        pageUrl: url,
        siteId: site.id,
        durationMs: Date.now() - startedAt,
      }).catch(() => { });
    }

    return { postId, postUrl, alreadyUploaded: result.alreadyUploaded, linkedPostIds };
  } catch (ex) {
    const message = getErrorMessage(ex);
    console.error("[hover import] failed:", message);
    void sendQuickImportStatus(originTabId, "error", { importId, message });

    const { statsEnabled, selectedSiteId } = await getImportSettings();
    if (statsEnabled) {
      await recordImport({
        outcome: "error",
        pageUrl: url,
        siteId: selectedSiteId,
        failure: { id: importId, pageUrl: url, siteId: selectedSiteId, message, attempts: 1 },
      }).catch(() => { });
    }
    return { error: message };
  } finally {
    // Close only now: the in-tab CDN fetch needed the live page while it ran.
    await close?.();
    running--;
    if (running === 0 && !isQueueRunning()) stopKeepAlive();
  }
}

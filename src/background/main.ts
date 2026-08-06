// ── Background entry point ────────────────────────────────────────────
// Wiring only: message routing, browser event listeners and worker start-up.
// The actual work lives in the sibling modules:
//
//   settings.ts        config access + instance resolution
//   state.ts           MV3-durable queue / chain / toast state
//   status.ts          quick-import status broadcasting
//   cdnAccess.ts       CORS + Referer handling for hotlink-protected CDNs
//   importPipeline.ts  scrape → content token → post creation
//   queue.ts           sequential import queue, retries, link chains
//   importedCheck.ts   "already imported" lookup for the page badge
//   batchController.ts batch / pool import wiring
//   stats.ts           import statistics and the failure list

import { BrowserCommand, type FetchCommandData } from "~/models";
import { setLanguage, t, type Language } from "~/i18n";
import { getErrorMessage } from "~/utils";
import { getActiveTab, getActiveTabId, isRestrictedTabUrl } from "~/shared/tabs";
import { onConfigChanged } from "~/shared/config";
import { getGrantedSourceSiteMatchPatterns } from "~/shared/sourceSites";
import { clearFailures, getStats, removeFailure, resetStats } from "~/stats";
import { handleBatchImport, resumeInterruptedBatch } from "./batchController";
import { getActiveBatchStatus } from "./batch";
import { importPostUrl } from "./pageImport";
import { mutateBatchSelection } from "./batchSelection";
import { installCdnHeaderRewriting } from "./cdnAccess";
import { checkImported, checkImportedBulk } from "./importedCheck";
import { scrapeNowOrUndefined, updatePost, uploadPost } from "./importPipeline";
import { ensureStateRestored, enqueueImport } from "./queue";
import { readStoredConfig } from "./settings";
import { collectActiveImportsForTab, sendQuickImportStatus } from "./status";
import { installContentScriptPermissionSync, syncContentScriptRegistration } from "./contentScripts";
import { installToolbarBadgeListeners, refreshQueueBadge, setImportedTabBadge } from "./toolbarBadge";

const QUICK_IMPORT_MENU_ID = "szuru-quick-import-current-page";

// Only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import("/@vite/client");
  // load latest content script
  import("./contentScriptHMR");
}

// ── Hotkey / context-menu imports ─────────────────────────────────────

interface ActiveTabImportData {
  url: string;
  importId?: string;
  scrapeResults?: any;
}

/**
 * Queue an import for the page in `senderTabId`.
 *
 * The scrape captured at hotkey time is preferred over re-scraping later, so
 * the queue can't pick up a different page after the user has navigated on.
 */
async function handleActiveTabImport(
  data: ActiveTabImportData,
  senderTabId: number | undefined,
  kind: "normal" | "link_last",
): Promise<void> {
  const tabId = senderTabId ?? await getActiveTabId();
  if (typeof tabId !== "number") throw new Error(t("bg.noActiveTab"));

  enqueueImport({
    kind,
    tabId,
    tabUrl: data.url,
    importId: data.importId ?? crypto.randomUUID(),
    scrapeResults: data.scrapeResults ?? await scrapeNowOrUndefined(tabId),
  });
}

/** Re-queue a stored failure from the options page; it carries its own scrape. */
async function retryFailedImport(data: { id?: string }): Promise<{ queued: true }> {
  if (!data?.id) throw new Error("Missing failure id");

  const stats = await getStats();
  const failure = stats.failures.find((f) => f.id === data.id);
  if (!failure) throw new Error(t("bg.retryNotFound"));
  if (!failure.scrapeResults) throw new Error(t("bg.retryNoPayload"));

  // Drop it from the list up front: either the retry succeeds, or it fails
  // again and gets re-recorded with a fresh attempt count.
  await removeFailure(failure.id);

  enqueueImport({
    kind: "normal",
    tabId: undefined,
    tabUrl: failure.pageUrl,
    importId: crypto.randomUUID(),
    scrapeResults: failure.scrapeResults,
    isRetry: true,
  });

  return { queued: true };
}

/**
 * Statistics writes from the options page are delegated here so every writer
 * shares the background's serialised chain (see stats.ts). Reads still happen
 * directly in the options context — only mutations must funnel through.
 */
async function handleStatsMutate(data: { op?: string; id?: string }): Promise<{ ok: true }> {
  switch (data.op) {
    case "removeFailure":
      if (data.id) await removeFailure(data.id);
      return { ok: true };
    case "clearFailures":
      await clearFailures();
      return { ok: true };
    case "resetStats":
      await resetStats();
      return { ok: true };
    default:
      throw new Error(`Unknown stats op: ${data.op}`);
  }
}

/**
 * Load the opt-in listing extras (hover zoom, endless scroll) into a tab.
 *
 * They ship as a second content-script bundle so pages never pay for features
 * nobody enabled; the script guards itself against being injected twice, which
 * makes repeat calls cheap and harmless.
 */
async function injectListingExtras(tabId: number | undefined): Promise<{ injected: boolean }> {
  if (typeof tabId !== "number") return { injected: false };
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["dist/contentScripts/listingExtras.global.js"],
    });
    return { injected: true };
  } catch (ex) {
    console.warn("Could not inject listing extras:", getErrorMessage(ex));
    return { injected: false };
  }
}

/**
 * Executes fetch in the background context, which is exempt from the page's
 * CORS restrictions.
 */
function executeFetch(data: FetchCommandData) {
  return fetch(data.url, data.options);
}

// ── Message routing ───────────────────────────────────────────────────

async function messageHandler(cmd: BrowserCommand, sender: any): Promise<any> {
  console.log("Background received message:");
  console.dir(cmd);

  // Restoring first means a message arriving on a freshly-revived MV3 worker
  // still sees the link chain and queue from before it was torn down.
  await ensureStateRestored();

  const senderTabId: number | undefined = sender?.tab?.id;

  switch (cmd.name) {
    case "upload_post":
      return uploadPost(cmd.data);
    case "update_post":
      return updatePost(cmd.data);
    case "fetch":
      return executeFetch(cmd.data);
    case "get_active_imports":
      return typeof senderTabId === "number" ? collectActiveImportsForTab(senderTabId) : [];
    case "check_imported": {
      const result = await checkImported(cmd.data ?? {});
      if (typeof senderTabId === "number") setImportedTabBadge(senderTabId, result.imported);
      return result;
    }
    case "check_imported_bulk":
      return checkImportedBulk(cmd.data ?? {});
    case "retry_failed_import":
      return retryFailedImport(cmd.data ?? {});
    case "batch_import":
      return handleBatchImport(cmd.data ?? {}, senderTabId);
    case "batch_selection":
      return mutateBatchSelection(cmd.data ?? {});
    case "batch_active":
      return getActiveBatchStatus();
    case "import_post_url":
      return importPostUrl(cmd.data ?? {}, senderTabId);
    case "inject_listing_extras":
      return injectListingExtras(senderTabId);
    case "stats_mutate":
      return handleStatsMutate(cmd.data ?? {});
    case "report_progress":
      if (senderTabId) {
        void sendQuickImportStatus(senderTabId, "progress", {
          progress: cmd.data.progress,
          speedBytesPerSecond: cmd.data.speedBytesPerSecond,
          totalBytes: cmd.data.totalBytes,
          importId: cmd.data.importId,
        });
      }
      return;
  }
}

browser.runtime.onMessage.addListener(messageHandler);

// ── Context menu ──────────────────────────────────────────────────────

async function setupContextMenu(): Promise<void> {
  if (!browser.contextMenus) return;
  await browser.contextMenus.removeAll();

  // Showing the menu only where the user granted source access matches the
  // dynamic content-script boundary and avoids advertising a page action on
  // unrelated sites.
  const documentUrlPatterns = await getGrantedSourceSiteMatchPatterns();
  if (documentUrlPatterns.length === 0) return;

  browser.contextMenus.create({
    id: QUICK_IMPORT_MENU_ID,
    title: t("bg.contextMenu"),
    contexts: ["page", "image", "video"],
    documentUrlPatterns,
  });
}

if (browser.contextMenus) {
  browser.runtime.onInstalled.addListener(() => void setupContextMenu());

  if ((browser.runtime as any).onStartup?.addListener) {
    (browser.runtime as any).onStartup.addListener(() => void setupContextMenu());
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== QUICK_IMPORT_MENU_ID) return;

    void (async () => {
      const tabId = tab?.id ?? await getActiveTabId();
      if (typeof tabId !== "number") {
        console.error("Context-menu quick import: no active tab");
        return;
      }
      enqueueImport({
        kind: "normal",
        tabId,
        tabUrl: tab?.url,
        importId: crypto.randomUUID(),
        scrapeResults: await scrapeNowOrUndefined(tabId),
      });
    })();
  });
}

// ── Native keyboard commands ────────────────────────────────────────────

async function runNativeImportCommand(command: "quick-import" | "quick-import-link-last"): Promise<void> {
  const tab = await getActiveTab();
  if (typeof tab?.id !== "number" || isRestrictedTabUrl(tab.url)) {
    console.warn("Native import command ignored: no importable active tab.");
    return;
  }

  // `activeTab` grants one-shot injection access for a keyboard command. The
  // regular dynamic content script still remains limited to opted-in sources.
  await handleActiveTabImport(
    { url: tab.url ?? "", importId: crypto.randomUUID() },
    tab.id,
    command === "quick-import-link-last" ? "link_last" : "normal",
  );
}

if (browser.commands?.onCommand) {
  browser.commands.onCommand.addListener((command) => {
    if (command !== "quick-import" && command !== "quick-import-link-last") return;
    void runNativeImportCommand(command).catch((ex) => console.error("Native import command failed:", getErrorMessage(ex)));
  });
}

// ── Worker start-up ───────────────────────────────────────────────────

/** Keep background-generated strings (toasts, menu, errors) in the user's language. */
async function syncLanguage(): Promise<void> {
  const cfg = await readStoredConfig().catch(() => undefined);
  if (cfg?.language) setLanguage(cfg.language as Language);
}

installCdnHeaderRewriting();
installContentScriptPermissionSync();
installToolbarBadgeListeners();

// Pick the queue, link chain and any running batch back up if the MV3 worker
// was torn down while imports were still pending.
void ensureStateRestored();
void resumeInterruptedBatch().catch((ex) => console.error("Failed to resume batch:", getErrorMessage(ex)));
void syncContentScriptRegistration().catch((ex) => console.error("Failed to register content scripts:", getErrorMessage(ex)));
refreshQueueBadge();

// The context menu title is localised, so its language must be resolved first.
// Install/startup listeners may not fire on every worker restart, so this also
// runs unconditionally here.
void syncLanguage()
  .then(() => setupContextMenu())
  .catch((ex) => console.error("Failed to initialize background:", getErrorMessage(ex)));

onConfigChanged(() => void syncLanguage());
browser.permissions.onAdded.addListener(() => void setupContextMenu());
browser.permissions.onRemoved.addListener(() => void setupContextMenu());

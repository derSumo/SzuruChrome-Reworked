// ── Content script entry point ────────────────────────────────────────
// Dynamically injected only into opted-in source sites. This file stays
// wiring-only; the heavy scraper bundle is never loaded on unrelated pages.
// Features live in sibling modules:
//
//   scraper.ts        neo-scraper access for popup/background imports
//   fetchContent.ts   media fetching from the page context (beats hotlinking)
//   toasts.ts         quick-import toasts + upload history panel
//   importedBadge.ts  "already imported" badge
//   thumbBadges.ts    "already imported" marks on listing thumbnails
//   thumbActions.ts   per-thumbnail import buttons
//   extras/           opt-in hover zoom + endless scroll, injected on demand
//   batchUi.ts        batch selection UI on listing pages
//   pageConfig.ts     one cached config read, shared by all of the above
//   navigation.ts     one navigation detector, shared by all of the above

import { BrowserCommand } from "~/models";
import { setLanguage, type Language } from "~/i18n";
import { handleBatchStatus, installBatchUi } from "./batchUi";
import { fetchContent, fetchHeadInfo } from "./fetchContent";
import { installImportedBadge, updateImportedBadge } from "./importedBadge";
import { installThumbBadges, invalidateThumbBadges, markThumbnailImported } from "./thumbBadges";
import { installThumbActions } from "./thumbActions";
import { getConfig, getListingSettings, onConfigReloaded } from "./pageConfig";
import { grabPost } from "./scraper";
import { handleQuickImportStatus, onImportSucceeded, restoreActiveImports } from "./toasts";
import { onBfcacheRestore } from "./navigation";

// Firefox `browser.tabs.executeScript()` requires scripts return a primitive value
(() => {
  // The script is declared in the manifest but may also be injected on demand
  // while a navigation is still settling. Two concurrent fallback injections
  // used to register two message/key handlers in the same document, causing
  // every queue status toast to be rendered twice. Keep the first instance as
  // the single owner for this document.
  const initializationFlag = "__szuruContentScriptInitialized__";
  const pageGlobal = globalThis as typeof globalThis & Record<string, boolean | undefined>;
  if (pageGlobal[initializationFlag]) return;
  pageGlobal[initializationFlag] = true;

  function messageHandler(cmd: BrowserCommand): Promise<any> | void {
    switch (cmd.name) {
      case "grab_post":
        return Promise.resolve(grabPost());
      case "fetch_content":
        return fetchContent(cmd.data.url, cmd.data.importId);
      case "fetch_head_info":
        return fetchHeadInfo(cmd.data.url);
      case "quick_import_status":
        handleQuickImportStatus(cmd.data);
        return;
      case "batch_status":
        handleBatchStatus(cmd.data);
        // Batch work happens in background tabs, so it does not emit the
        // listing's regular quick-import toast. Its per-item progress is the
        // moment to update the matching thumbnail in real time.
        if (cmd.data?.phase === "progress" && cmd.data.lastUrl && cmd.data.lastPostId) {
          markThumbnailImported(cmd.data.lastUrl);
        }
        return;
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  /**
   * Hover zoom and endless scroll live in their own bundle and are fetched only
   * once one of them is switched on — they are off by default, and the content
   * script runs on every page of every enabled site.
   */
  async function ensureListingExtras(): Promise<void> {
    const listing = await getListingSettings();
    if (!listing.hoverZoom && !listing.endlessScroll) return;
    await browser.runtime.sendMessage(new BrowserCommand("inject_listing_extras")).catch(() => {
      // Background asleep or the tab is not scriptable; retried on the next
      // config change or page load.
    });
  }

  void getConfig().then((cfg) => {
    if (cfg?.language) setLanguage(cfg.language as Language);
  });

  // The page the user is standing on may be the one just imported — flip the
  // badge over immediately instead of waiting for the next navigation.
  onImportSucceeded(() => {
    void updateImportedBadge(true);
    // A listing the user just imported from should show the new check mark.
    invalidateThumbBadges();
  });

  installImportedBadge();
  installThumbBadges();
  installThumbActions();
  void ensureListingExtras();
  onConfigReloaded(() => void ensureListingExtras());
  installBatchUi();
  // Restore whatever the background still has in flight, both on a fresh load
  // and when the page comes back from the back/forward cache.
  void restoreActiveImports();
  onBfcacheRestore(() => void restoreActiveImports());
})();

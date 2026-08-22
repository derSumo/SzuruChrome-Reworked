// ── Settings index ────────────────────────────────────────────────────
// One entry per individual setting, carrying where it lives, what it is
// called, and which config path it writes. Three features read it:
//
//   · the search box    — ~35 settings across 7 tabs is past the point where
//                         scanning beats searching
//   · deep links        — options.html#tags/tagRules.enabled
//   · "changed" markers — compare the stored value against defaultConfig()
//
// It is a hand-maintained list, which normally means it goes stale the first
// time someone adds a switch. `src/tests/settingsIndex.spec.ts` parses the tab
// components and fails when a SettingRow carries a path that is missing here
// (or vice versa), so staleness is a failing test rather than a silent gap.

import type { TranslationKey } from "~/i18n";

export type OptionsTabId = "import" | "tags" | "onPage" | "connections" | "appearance" | "data" | "about";

export interface SettingEntry {
  /** Dotted path into the config object; also the deep-link anchor. */
  path: string;
  tab: OptionsTabId;
  label: TranslationKey;
  hint?: TranslationKey;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  // ── Import ──────────────────────────────────────────────
  { path: "addPageUrlToSource", tab: "import", label: "options.general.addPageUrl", hint: "options.general.addPageUrlHint" },
  { path: "addAllParsedTags", tab: "import", label: "options.general.autoImportTags", hint: "options.general.autoImportTagsHint" },
  { path: "alwaysUploadAsContent", tab: "import", label: "options.general.uploadAsContent", hint: "options.general.uploadAsContentHint" },
  { path: "addTagImplications", tab: "import", label: "options.general.addImplications", hint: "options.general.addImplicationsHint" },
  { path: "autoRelationsEnabled", tab: "import", label: "options.general.autoRelationsEnable", hint: "options.general.autoRelationsEnableHint" },
  { path: "autoRelationThreshold", tab: "import", label: "options.general.autoRelationThreshold", hint: "options.general.autoRelationThresholdHint" },
  { path: "replaceExactDuplicates", tab: "import", label: "options.general.replaceExactDuplicates", hint: "options.general.replaceExactDuplicatesHint" },
  { path: "queueRetry.enabled", tab: "import", label: "options.queue.retryEnable", hint: "options.queue.retryEnableHint" },
  { path: "queueRetry.maxAttempts", tab: "import", label: "options.queue.maxAttempts", hint: "options.queue.maxAttemptsHint" },

  // ── Tags ────────────────────────────────────────────────
  { path: "tagRules.enabled", tab: "tags", label: "options.tagRules.enable", hint: "options.tagRules.enableHint" },

  // ── On the page ─────────────────────────────────────────
  { path: "importedBadge.enabled", tab: "onPage", label: "options.badge.enable", hint: "options.badge.enableHint" },
  { path: "importedBadge.showWhenNotImported", tab: "onPage", label: "options.badge.showMissing", hint: "options.badge.showMissingHint" },
  { path: "importedBadge.thumbnails", tab: "onPage", label: "options.badge.thumbnails", hint: "options.badge.thumbnailsHint" },
  { path: "listing.hoverActions", tab: "onPage", label: "options.listing.hoverActions", hint: "options.listing.hoverActionsHint" },
  { path: "listing.endlessScroll", tab: "onPage", label: "options.listing.endlessScroll", hint: "options.listing.endlessScrollHint" },
  { path: "listing.hoverZoom", tab: "onPage", label: "options.listing.hoverZoom", hint: "options.listing.hoverZoomHint" },
  { path: "listing.hoverZoomScope", tab: "onPage", label: "options.listing.hoverZoomScope", hint: "options.listing.hoverZoomScopeHint" },
  { path: "listing.hoverZoomDelayMs", tab: "onPage", label: "options.listing.hoverZoomDelay", hint: "options.listing.hoverZoomDelayHint" },
  { path: "batchImport.enabled", tab: "onPage", label: "options.batch.enable", hint: "options.batch.enableHint" },
  { path: "batchImport.skipImported", tab: "onPage", label: "options.batch.skipImported", hint: "options.batch.skipImportedHint" },
  { path: "batchImport.oldestFirst", tab: "onPage", label: "options.batch.oldestFirst", hint: "options.batch.oldestFirstHint" },
  { path: "batchImport.separateWindow", tab: "onPage", label: "options.batch.separateWindow", hint: "options.batch.separateWindowHint" },
  { path: "batchImport.concurrency", tab: "onPage", label: "options.batch.concurrency", hint: "options.batch.concurrencyHint" },
  { path: "batchImport.maxPosts", tab: "onPage", label: "options.batch.maxPosts", hint: "options.batch.maxPostsHint" },
  { path: "batchImport.maxPages", tab: "onPage", label: "options.batch.maxPages", hint: "options.batch.maxPagesHint" },

  // ── Appearance ──────────────────────────────────────────
  { path: "language", tab: "appearance", label: "options.interface.language", hint: "options.interface.languageHint" },
  { path: "autoSearchSimilar", tab: "appearance", label: "options.interface.autoSearch", hint: "options.interface.autoSearchHint" },
  { path: "loadTagCounts", tab: "appearance", label: "options.interface.tagCounts", hint: "options.interface.tagCountsHint" },
  { path: "fetchPostInfo", tab: "appearance", label: "options.interface.fetchPostInfo", hint: "options.interface.fetchPostInfoHint" },
  { path: "popup.showSource", tab: "appearance", label: "options.interface.showSource", hint: "options.interface.showSourceHint" },
  { path: "popup.showPools", tab: "appearance", label: "options.interface.showPools", hint: "options.interface.showPoolsHint" },
  { path: "popup.tagSortMode", tab: "appearance", label: "options.interface.tagSortMode", hint: "options.interface.tagSortModeHint" },

  // ── Data ────────────────────────────────────────────────
  { path: "statsEnabled", tab: "data", label: "options.queue.stats", hint: "options.queue.statsHint" },
];

/** Read a dotted path out of an object; undefined when any hop is missing. */
export function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<any>((value, key) => (value == null ? undefined : value[key]), source);
}

/** Write a dotted path, creating intermediate objects as needed. */
export function writePath(target: any, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cursor = target;
  for (const key of keys) {
    if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[last] = value;
}

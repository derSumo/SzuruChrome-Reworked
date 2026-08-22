// ── Changelog data ────────────────────────────────────────────────────
//
// The release history used to live as hand-copied markup in the options
// template, which meant every release added ~10 lines of duplicated <li>
// scaffolding. It is data, so it lives here: adding a release is one entry
// plus the matching i18n keys in `src/i18n/messages/*.ui.ts`.

import type { TranslationKey } from "~/i18n";

export interface ChangelogItem {
  /** i18n key rendered bold in front of the em dash. Omit for a plain line. */
  title?: TranslationKey;
  /** i18n key for the description — or for the whole line when `title` is absent. */
  text: TranslationKey;
}

export interface ChangelogEntry {
  /** Display version, without the leading "v". */
  version: string;
  /** i18n key holding the release date. */
  date: TranslationKey;
  items: ChangelogItem[];
}

/** Newest release first — the options page renders them in this order. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "3.1.0",
    date: "changelog.v310.date",
    items: [
      { title: "changelog.v310.stopBatch", text: "changelog.v310.stopBatchDesc" },
      { title: "changelog.v310.settingsRework", text: "changelog.v310.settingsReworkDesc" },
      { title: "changelog.v310.settingsSearch", text: "changelog.v310.settingsSearchDesc" },
      { title: "changelog.v310.batchInPopup", text: "changelog.v310.batchInPopupDesc" },
      { title: "changelog.v310.history", text: "changelog.v310.historyDesc" },
      { title: "changelog.v310.perInstanceRules", text: "changelog.v310.perInstanceRulesDesc" },
      { title: "changelog.v310.testerFromPage", text: "changelog.v310.testerFromPageDesc" },
      { title: "changelog.v310.fetchPostInfo", text: "changelog.v310.fetchPostInfoDesc" },
      { title: "changelog.v310.a11y", text: "changelog.v310.a11yDesc" },
      { title: "changelog.v310.cleanBackup", text: "changelog.v310.cleanBackupDesc" },
      { title: "changelog.v310.zoomScope", text: "changelog.v310.zoomScopeDesc" },
    ],
  },
  {
    version: "3.0.6",
    date: "changelog.v306.date",
    items: [
      { title: "changelog.v306.releaseBuild", text: "changelog.v306.releaseBuildDesc" },
    ],
  },
  {
    version: "3.0.5",
    date: "changelog.v305.date",
    items: [
      { title: "changelog.v305.selectionOrder", text: "changelog.v305.selectionOrderDesc" },
    ],
  },
  {
    version: "3.0.4",
    date: "changelog.v304.date",
    items: [
      { title: "changelog.v304.oldestFirst", text: "changelog.v304.oldestFirstDesc" },
    ],
  },
  {
    version: "3.0.3",
    date: "changelog.v303.date",
    items: [
      { title: "changelog.v303.ctrlHover", text: "changelog.v303.ctrlHoverDesc" },
    ],
  },
  {
    version: "3.0.2",
    date: "changelog.v302.date",
    items: [
      { title: "changelog.v302.ctrlHover", text: "changelog.v302.ctrlHoverDesc" },
    ],
  },
  {
    version: "3.0.1",
    date: "changelog.v301.date",
    items: [
      { title: "changelog.v301.listingFlow", text: "changelog.v301.listingFlowDesc" },
      { title: "changelog.v301.liveState", text: "changelog.v301.liveStateDesc" },
    ],
  },
  {
    version: "3.0.0",
    date: "changelog.v300.date",
    items: [
      { title: "changelog.v300.hoverActions", text: "changelog.v300.hoverActionsDesc" },
      { title: "changelog.v300.rangeSelect", text: "changelog.v300.rangeSelectDesc" },
      { title: "changelog.v300.endlessScroll", text: "changelog.v300.endlessScrollDesc" },
      { title: "changelog.v300.hoverZoom", text: "changelog.v300.hoverZoomDesc" },
      { title: "changelog.v300.hoverButtonsFix", text: "changelog.v300.hoverButtonsFixDesc" },
      { title: "changelog.v300.lazyExtras", text: "changelog.v300.lazyExtrasDesc" },
      { title: "changelog.v300.dockRedesign", text: "changelog.v300.dockRedesignDesc" },
      { title: "changelog.v300.stopLabel", text: "changelog.v300.stopLabelDesc" },
      { title: "changelog.v300.batchDurable", text: "changelog.v300.batchDurableDesc" },
    ],
  },
  {
    version: "2.9.0",
    date: "changelog.v290.date",
    items: [
      { title: "changelog.v290.parallelBatches", text: "changelog.v290.parallelBatchesDesc" },
      { title: "changelog.v290.oneQueue", text: "changelog.v290.oneQueueDesc" },
      { title: "changelog.v290.selectionAcrossPages", text: "changelog.v290.selectionAcrossPagesDesc" },
      { title: "changelog.v290.thumbMarks", text: "changelog.v290.thumbMarksDesc" },
      { title: "changelog.v290.batchSkip", text: "changelog.v290.batchSkipDesc" },
      { title: "changelog.v290.batchWindow", text: "changelog.v290.batchWindowDesc" },
      { title: "changelog.v290.duplicateQuality", text: "changelog.v290.duplicateQualityDesc" },
    ],
  },
  {
    version: "2.8.0",
    date: "changelog.v280.date",
    items: [
      { title: "changelog.v280.selectAll", text: "changelog.v280.selectAllDesc" },
      { title: "changelog.v280.allPages", text: "changelog.v280.allPagesDesc" },
      { title: "changelog.v280.userImport", text: "changelog.v280.userImportDesc" },
      { title: "changelog.v280.crawlLimits", text: "changelog.v280.crawlLimitsDesc" },
    ],
  },
  {
    version: "2.7.0",
    date: "changelog.v270.date",
    items: [
      { title: "changelog.v270.batch", text: "changelog.v270.batchDesc" },
      { title: "changelog.v270.pool", text: "changelog.v270.poolDesc" },
    ],
  },
  {
    version: "2.6.0",
    date: "changelog.v260.date",
    items: [
      { title: "changelog.v260.backup", text: "changelog.v260.backupDesc" },
      { title: "changelog.v260.tagSuggestions", text: "changelog.v260.tagSuggestionsDesc" },
      { title: "changelog.v260.instanceStats", text: "changelog.v260.instanceStatsDesc" },
    ],
  },
  {
    version: "2.5.0",
    date: "changelog.v250.date",
    items: [
      { title: "changelog.v250.tagRules", text: "changelog.v250.tagRulesDesc" },
      { title: "changelog.v250.importedBadge", text: "changelog.v250.importedBadgeDesc" },
      { title: "changelog.v250.retry", text: "changelog.v250.retryDesc" },
      { title: "changelog.v250.durableQueue", text: "changelog.v250.durableQueueDesc" },
      { title: "changelog.v250.stats", text: "changelog.v250.statsDesc" },
    ],
  },
  {
    version: "2.4.0",
    date: "changelog.v240.date",
    items: [
      { title: "changelog.v240.queue", text: "changelog.v240.queueDesc" },
      { title: "changelog.v240.linkChain", text: "changelog.v240.linkChainDesc" },
      { title: "changelog.v240.uploadAsContentSites", text: "changelog.v240.uploadAsContentSitesDesc" },
      { title: "changelog.v240.compactToast", text: "changelog.v240.compactToastDesc" },
      { title: "changelog.v240.dedupToast", text: "changelog.v240.dedupToastDesc" },
    ],
  },
  {
    version: "2.3.0",
    date: "changelog.v230.date",
    items: [
      { title: "changelog.v230.hotfixFormData", text: "changelog.v230.hotfixFormDataDesc" },
      { title: "changelog.v230.multiStrategyFetch", text: "changelog.v230.multiStrategyFetchDesc" },
      { title: "changelog.v230.declarativeNetRequest", text: "changelog.v230.declarativeNetRequestDesc" },
      { title: "changelog.v230.webRequestReferer", text: "changelog.v230.webRequestRefererDesc" },
      { title: "changelog.v230.toastRestore", text: "changelog.v230.toastRestoreDesc" },
    ],
  },
  {
    version: "2.2.0",
    date: "changelog.v220.date",
    items: [
      { title: "changelog.v220.autoRelationsToggle", text: "changelog.v220.autoRelationsToggleDesc" },
      { title: "changelog.v220.serverPill", text: "changelog.v220.serverPillDesc" },
      { title: "changelog.v220.formatChips", text: "changelog.v220.formatChipsDesc" },
      { title: "changelog.v220.popupCustomization", text: "changelog.v220.popupCustomizationDesc" },
      { title: "changelog.v220.thresholdDefault", text: "changelog.v220.thresholdDefaultDesc" },
      { title: "changelog.v220.fallbackTags", text: "changelog.v220.fallbackTagsDesc" },
    ],
  },
  {
    version: "2.1.1",
    date: "changelog.v211.date",
    items: [
      { title: "changelog.v211.slider", text: "changelog.v211.sliderDesc" },
    ],
  },
  {
    version: "2.1.0",
    date: "changelog.v210.date",
    items: [
      { title: "changelog.v210.autoRelations", text: "changelog.v210.autoRelationsDesc" },
      { title: "changelog.v210.linkLastHotkey", text: "changelog.v210.linkLastHotkeyDesc" },
      { title: "changelog.v210.liquidUi", text: "changelog.v210.liquidUiDesc" },
      { title: "changelog.v210.fixAutoRelations", text: "changelog.v210.fixAutoRelationsDesc" },
    ],
  },
  {
    version: "2.0.1",
    date: "changelog.v201.date",
    items: [
      { title: "changelog.v201.multiLang", text: "changelog.v201.multiLangDesc" },
      { title: "changelog.v201.colorPicker", text: "changelog.v201.colorPickerDesc" },
      { title: "changelog.v201.alreadyUploaded", text: "changelog.v201.alreadyUploadedDesc" },
      { title: "changelog.v201.objectObject", text: "changelog.v201.objectObjectDesc" },
      { title: "changelog.v201.emptyTag", text: "changelog.v201.emptyTagDesc" },
      { title: "changelog.v201.forkLink", text: "changelog.v201.forkLinkDesc" },
    ],
  },
  {
    version: "2.0.0",
    date: "changelog.v200.date",
    items: [
      { title: "changelog.v200.contextMenu", text: "changelog.v200.contextMenuDesc" },
      { title: "changelog.v200.hotkey", text: "changelog.v200.hotkeyDesc" },
      { title: "changelog.v200.progress", text: "changelog.v200.progressDesc" },
      { title: "changelog.v200.toasts", text: "changelog.v200.toastsDesc" },
      { title: "changelog.v200.fix403", text: "changelog.v200.fix403Desc" },
      { title: "changelog.v200.fixOctet", text: "changelog.v200.fixOctetDesc" },
      { title: "changelog.v200.fixPreview", text: "changelog.v200.fixPreviewDesc" },
      { title: "changelog.v200.options", text: "changelog.v200.optionsDesc" },
      { title: "changelog.v200.mime", text: "changelog.v200.mimeDesc" },
      { title: "changelog.v200.filename", text: "changelog.v200.filenameDesc" },
    ],
  },
  {
    version: "1.1.24",
    date: "changelog.v1124.date",
    items: [
      { text: "changelog.v1124.initial" },
      { text: "changelog.v1124.autocomplete" },
      { text: "changelog.v1124.pools" },
      { text: "changelog.v1124.similar" },
      { text: "changelog.v1124.merge" },
      { text: "changelog.v1124.multiInstance" },
    ],
  },
];

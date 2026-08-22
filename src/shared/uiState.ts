// ── Remembered panel state ────────────────────────────────────────────
// Which collapsible sections the user last had open. This is not a setting:
// nobody goes looking for it in the options page, and it has no business in a
// config backup — exporting your configuration used to carry "the pools
// section was collapsed" along with your instance credentials.
//
// It therefore lives under its own storage key, separate from `config`.

export const UI_STATE_STORAGE_KEY = "szuru_ui_state";

export function defaultUiState() {
  return {
    popup: {
      expandTags: true,
      expandPools: false,
    },
    merge: {
      expandOptions: true,
      expandExistingTags: false,
      expandAddTags: true,
    },
  };
}

export type UiState = ReturnType<typeof defaultUiState>;

/** Panel-state keys as they were stored inside `config` before v3.1.0. */
export interface LegacyUiStateSource {
  popup?: { expandTags?: boolean; expandPools?: boolean };
  merge?: { expandOptions?: boolean; expandExistingTags?: boolean; expandAddTags?: boolean };
}

/**
 * Lift the panel booleans out of an old config object. Returns undefined when
 * there is nothing to carry over, so a fresh install doesn't write a redundant
 * copy of the defaults.
 */
export function extractLegacyUiState(cfg: LegacyUiStateSource | undefined): Partial<UiState> | undefined {
  if (!cfg) return undefined;

  const popup: Record<string, boolean> = {};
  if (typeof cfg.popup?.expandTags === "boolean") popup.expandTags = cfg.popup.expandTags;
  if (typeof cfg.popup?.expandPools === "boolean") popup.expandPools = cfg.popup.expandPools;

  const merge: Record<string, boolean> = {};
  if (typeof cfg.merge?.expandOptions === "boolean") merge.expandOptions = cfg.merge.expandOptions;
  if (typeof cfg.merge?.expandExistingTags === "boolean") merge.expandExistingTags = cfg.merge.expandExistingTags;
  if (typeof cfg.merge?.expandAddTags === "boolean") merge.expandAddTags = cfg.merge.expandAddTags;

  const hasPopup = Object.keys(popup).length > 0;
  const hasMerge = Object.keys(merge).length > 0;
  if (!hasPopup && !hasMerge) return undefined;

  return {
    ...(hasPopup ? { popup: { ...defaultUiState().popup, ...popup } } : {}),
    ...(hasMerge ? { merge: { ...defaultUiState().merge, ...merge } } : {}),
  };
}

// ── Config access for the background ──────────────────────────────────
// Thin, typed accessors around the raw stored config so the import pipeline
// never has to spell out default-handling (`?? true`, `!== false`, …) inline.

import { t } from "~/i18n";
import { readStoredConfig, writeStoredConfig, type StoredConfig } from "~/shared/config";
import { hostOf } from "~/shared/host";
import type { SzuruSiteConfig } from "~/models";

export { readStoredConfig, type StoredConfig };

const DEFAULT_AUTO_RELATION_THRESHOLD = 60;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Which instance an import targets. An explicit selection wins; otherwise we
 * work down a chain of fallbacks so a user who never opened the options page
 * still gets a sensible target.
 */
export function resolveSelectedSite(cfg: StoredConfig, tabUrl?: string): SzuruSiteConfig {
  if (!cfg.sites || cfg.sites.length == 0) {
    throw new Error(t("bg.noInstances"));
  }

  // Preferred: explicit selection from popup/options config.
  if (cfg.selectedSiteId) {
    const selected = cfg.sites.find((x) => x.id == cfg.selectedSiteId);
    if (selected) return selected;
  }

  // Fallback #1: when only one instance exists, use it automatically.
  if (cfg.sites.length == 1) return cfg.sites[0];

  // Fallback #2: try to map current page host to configured instance host.
  const tabHost = hostOf(tabUrl);
  if (tabHost) {
    const matching = cfg.sites.find((x) => hostOf(x.domain) == tabHost);
    if (matching) return matching;
  }

  // Fallback #3: deterministic first entry.
  return cfg.sites[0];
}

/** Remember the resolved instance so the popup opens on the same one. */
export async function persistSelectedSite(cfg: StoredConfig, siteId: string): Promise<void> {
  if (cfg.selectedSiteId == siteId) return;
  cfg.selectedSiteId = siteId;
  await writeStoredConfig(cfg);
}

export interface ImportSettings {
  retryEnabled: boolean;
  maxAttempts: number;
  statsEnabled: boolean;
  autoRelationsEnabled: boolean;
  autoRelationThreshold: number;
  replaceExactDuplicates: boolean;
  selectedSiteId?: string;
}

/** Resolve every import-behaviour setting, with defaults applied once. */
function toImportSettings(cfg: StoredConfig | undefined): ImportSettings {
  return {
    retryEnabled: cfg?.queueRetry?.enabled !== false,
    maxAttempts: Math.max(1, cfg?.queueRetry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    statsEnabled: cfg?.statsEnabled !== false,
    autoRelationsEnabled: cfg?.autoRelationsEnabled !== false,
    autoRelationThreshold: cfg?.autoRelationThreshold ?? DEFAULT_AUTO_RELATION_THRESHOLD,
    replaceExactDuplicates: cfg?.replaceExactDuplicates !== false,
    selectedSiteId: cfg?.selectedSiteId,
  };
}

export async function getImportSettings(): Promise<ImportSettings> {
  return toImportSettings(await readStoredConfig().catch(() => undefined));
}

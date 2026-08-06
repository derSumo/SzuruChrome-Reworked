// ── Cached config for the content script ──────────────────────────────
// The config is read once and refreshed on change rather than re-read from
// storage per feature. The badge and batch launcher share this cache.

import { onConfigChanged, readStoredConfig, type StoredConfig } from "~/shared/config";
import { hostMatchesAny } from "~/shared/host";

let inFlight: Promise<StoredConfig | undefined>;

const listeners = new Set<() => void>();

function load(): Promise<StoredConfig | undefined> {
  inFlight = readStoredConfig().then((cfg) => {
    return cfg;
  });
  return inFlight;
}

load();

onConfigChanged(() => {
  void load().then(() => {
    for (const listener of listeners) listener();
  });
});

/** Await the current config, waiting for the first read if it is still running. */
export function getConfig(): Promise<StoredConfig | undefined> {
  return inFlight;
}

/** Run `listener` whenever the stored config changes. */
export function onConfigReloaded(listener: () => void): void {
  listeners.add(listener);
}

export interface BadgeSettings {
  enabled: boolean;
  showWhenNotImported: boolean;
  /** Check marks on listing thumbnails, see contentScripts/thumbBadges. */
  thumbnails: boolean;
}

export async function getBadgeSettings(): Promise<BadgeSettings> {
  const cfg = await getConfig();
  return {
    enabled: cfg?.importedBadge?.enabled !== false,
    showWhenNotImported: cfg?.importedBadge?.showWhenNotImported === true,
    thumbnails: cfg?.importedBadge?.thumbnails !== false,
  };
}

/** Clamp a stored number into a sane range, tolerating undefined and garbage. */
function limit(value: unknown, fallback: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export interface ListingSettings {
  hoverActions: boolean;
  /** Already resolved against the whitelist for *this* page. */
  hoverZoom: boolean;
  hoverZoomDelayMs: number;
  endlessScroll: boolean;
}

export async function getListingSettings(): Promise<ListingSettings> {
  const cfg = await getConfig();
  const listing = cfg?.listing;

  // The zoom is opt-in per site unless the user chose "everywhere": it changes
  // how a page behaves under the cursor, which is not something to switch on
  // for sites the user never asked about.
  const zoomAllowedHere = listing?.hoverZoomScope === "all"
    || hostMatchesAny(window.location.href, listing?.hoverZoomSites);

  return {
    hoverActions: listing?.hoverActions !== false,
    hoverZoom: listing?.hoverZoom === true && zoomAllowedHere,
    hoverZoomDelayMs: limit(listing?.hoverZoomDelayMs, 350, 3000),
    endlessScroll: listing?.endlessScroll === true,
  };
}

export interface BatchSettings {
  enabled: boolean;
  hasSites: boolean;
  /** Ceilings for the "all pages" crawl; see `batchImport` in shared/config. */
  maxPages: number;
  maxPosts: number;
}

export async function getBatchSettings(): Promise<BatchSettings> {
  const cfg = await getConfig();
  return {
    enabled: cfg?.batchImport?.enabled !== false,
    hasSites: Array.isArray(cfg?.sites) && cfg.sites.length > 0,
    maxPages: limit(cfg?.batchImport?.maxPages, 20, 500),
    maxPosts: limit(cfg?.batchImport?.maxPosts, 500, 10_000),
  };
}

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

/**
 * Clamp a stored number into a sane range, tolerating undefined and garbage.
 *
 * `min` is a real lower bound, not just a guard against nonsense: a delay of 0
 * ("open immediately") is a legitimate setting the slider offers, while 0 pages
 * or 0 posts is not — those fall back so a corrupted value cannot silently turn
 * a crawl into a no-op.
 */
function limit(value: unknown, fallback: number, max: number, min = 1): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < min) return fallback;
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

  // The zoom can be narrowed to a hand-picked list of hosts. An *empty* list
  // is not that choice — it is a user who switched the feature on and never
  // reached the host field, so it means "wherever this runs" rather than
  // "nowhere". Silently disabling everything is what made the toggle look
  // broken; a list with entries still restricts to exactly those.
  const zoomSites = listing?.hoverZoomSites;
  const zoomAllowedHere = listing?.hoverZoomScope !== "sites"
    || !zoomSites?.length
    || hostMatchesAny(window.location.href, zoomSites);

  return {
    hoverActions: listing?.hoverActions !== false,
    hoverZoom: listing?.hoverZoom === true && zoomAllowedHere,
    hoverZoomDelayMs: limit(listing?.hoverZoomDelayMs, 350, 3000, 0),
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

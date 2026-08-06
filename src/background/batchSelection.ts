// ── Cross-page batch selection ────────────────────────────────────────
// The picker used to live and die with one document: paging to the next page
// of a listing threw the selection away, so a batch could only ever cover what
// fit on a single page. The selection therefore lives here instead, in the one
// context that survives navigation — one basket per site, filled from any tab
// on it.
//
// Deltas rather than a wholesale replace: two tabs on the same booru can be
// picking at the same time, and last-writer-wins would silently drop one of
// them. Adds and removes merge in whatever order they arrive.
//
// Persisted into storage.session so an MV3 worker teardown mid-selection
// doesn't empty the basket either.

import { registrableDomainOfUrl } from "~/shared/host";

export const BATCH_SELECTION_KEY = "szuru_batch_selection";

/** Baskets older than this are stale enough to be surprising; drop them. */
const SELECTION_TTL_MS = 6 * 60 * 60_000;
/** Hard ceiling per basket, matching the crawl's own upper bound. */
const SELECTION_MAX = 10_000;

export interface BatchSelectionState {
  urls: string[];
  /** True while a picker is open, so other pages re-open theirs on load. */
  active: boolean;
  poolName?: string;
  updatedAt: number;
}

export interface BatchSelectionRequest {
  /** Any URL on the site the basket belongs to. */
  pageUrl?: string;
  add?: string[];
  remove?: string[];
  clear?: boolean;
  active?: boolean;
  poolName?: string;
}

type SessionArea = {
  get(key: string): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
};

function getArea(): SessionArea {
  return (browser.storage as any).session ?? browser.storage.local;
}

let baskets: Record<string, BatchSelectionState> | undefined;
let restoring: Promise<void> | undefined;

/** Site key for a page URL — the whole booru shares one basket. */
function basketKey(pageUrl?: string): string | undefined {
  return pageUrl ? registrableDomainOfUrl(pageUrl) : undefined;
}

function emptyState(): BatchSelectionState {
  return { urls: [], active: false, updatedAt: Date.now() };
}

async function ensureRestored(): Promise<void> {
  if (baskets) return;
  restoring ??= (async () => {
    try {
      const stored = await getArea().get(BATCH_SELECTION_KEY);
      const raw = stored?.[BATCH_SELECTION_KEY];
      baskets = raw && typeof raw === "object" ? raw : {};
    } catch {
      baskets = {};
    }
    // Drop anything the user has long since forgotten about.
    const now = Date.now();
    for (const [key, state] of Object.entries(baskets!)) {
      if (!state?.updatedAt || now - state.updatedAt > SELECTION_TTL_MS) delete baskets![key];
    }
  })().finally(() => { restoring = undefined; });
  await restoring;
}

let pendingWrite: ReturnType<typeof setTimeout> | undefined;

/** Debounced: ticking through a grid of thumbnails must not write per click. */
function persist(): void {
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = undefined;
    void getArea().set({ [BATCH_SELECTION_KEY]: baskets ?? {} }).catch(() => {
      // A lost basket is recoverable by re-selecting; never fail the click.
    });
  }, 250);
}

/**
 * Apply a delta and return the resulting basket. Reading is the same call with
 * no mutations, so the picker only ever needs this one round trip.
 */
export async function mutateBatchSelection(req: BatchSelectionRequest): Promise<BatchSelectionState> {
  const key = basketKey(req?.pageUrl);
  if (!key) return emptyState();

  await ensureRestored();
  const state = baskets![key] ?? emptyState();

  let changed = false;

  if (req.clear) {
    if (state.urls.length > 0) changed = true;
    state.urls = [];
    state.poolName = undefined;
  }

  if (req.remove?.length) {
    const drop = new Set(req.remove);
    const kept = state.urls.filter((url) => !drop.has(url));
    if (kept.length !== state.urls.length) changed = true;
    state.urls = kept;
  }

  if (req.add?.length) {
    const known = new Set(state.urls);
    for (const url of req.add) {
      if (!url || known.has(url) || state.urls.length >= SELECTION_MAX) continue;
      known.add(url);
      state.urls.push(url);
      changed = true;
    }
  }

  if (typeof req.active === "boolean" && req.active !== state.active) {
    state.active = req.active;
    changed = true;
  }

  if (req.poolName !== undefined && req.poolName !== state.poolName) {
    state.poolName = req.poolName || undefined;
    changed = true;
  }

  if (changed) {
    state.updatedAt = Date.now();
    baskets![key] = state;
    persist();
  }

  return state;
}

/** Empty the basket for the site `pageUrl` belongs to (after an import ran). */
export async function clearBatchSelection(pageUrl?: string): Promise<void> {
  await mutateBatchSelection({ pageUrl, clear: true, active: false });
}

// ── MV3 service-worker state persistence ──────────────────────────────
// Chrome tears the background service worker down after ~30s of inactivity
// and rebuilds it on the next event. Everything the queue holds in module
// scope (pending tasks, link-chain bookkeeping, toast restoration data)
// would silently reset — a queued burst would simply stop halfway.
//
// We therefore mirror that state into `browser.storage.session`, which lives
// for the whole browser session but never hits disk. Firefox 115+ and
// Chrome 102+ have it; older builds fall back to storage.local under the same
// key, which is functionally identical apart from surviving a restart (and
// gets cleared on the next worker start anyway).

export const SESSION_STATE_KEY = "szuru_bg_state";

export interface SiteUploadState {
  lastUploadedPostId?: number;
  linkChain: number[];
}

export interface ActiveImportEntry {
  tabId?: number;
  status: "running" | "progress" | "success" | "error";
  progress?: number;
  postId?: number;
  postUrl?: string;
  alreadyUploaded?: boolean;
  linkedPostIds?: number[];
  duplicateOutcome?: "replaced" | "tags_merged";
  completedAt?: number;
  speedBytesPerSecond?: number;
  lastDownloadSpeedBytesPerSecond?: number;
  totalBytes?: number;
  message?: string;
  queued?: boolean;
}

export interface ImportTask {
  kind: "normal" | "link_last";
  tabId?: number;
  tabUrl?: string;
  importId: string;
  scrapeResults?: any;
  /** Failed attempts so far; drives the retry backoff. */
  attempts?: number;
  /** Set when the task was re-queued from the failure list in the options page. */
  isRetry?: boolean;
}

export interface BackgroundSessionState {
  siteStates: Record<string, SiteUploadState>;
  activeImports: Record<string, ActiveImportEntry>;
  queue: ImportTask[];
}

type SessionArea = {
  get(key: string): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
};

function getArea(): SessionArea {
  const session = (browser.storage as any).session;
  // storage.session is the correct home for this data, but a missing API must
  // not disable queue persistence entirely.
  return session ?? browser.storage.local;
}

export async function loadSessionState(): Promise<BackgroundSessionState | undefined> {
  try {
    const stored = await getArea().get(SESSION_STATE_KEY);
    const raw = stored?.[SESSION_STATE_KEY];
    if (!raw || typeof raw !== "object") return undefined;
    return {
      siteStates: raw.siteStates ?? {},
      activeImports: raw.activeImports ?? {},
      queue: Array.isArray(raw.queue) ? raw.queue : [],
    };
  } catch (ex) {
    console.warn("Failed to restore background session state:", ex);
    return undefined;
  }
}

let pendingWrite: ReturnType<typeof setTimeout> | undefined;
let pendingState: BackgroundSessionState | undefined;

/**
 * Debounced write. A burst of imports mutates the state on every progress
 * tick; persisting each one would mean hundreds of storage writes per upload.
 */
export function saveSessionState(state: BackgroundSessionState): void {
  pendingState = state;
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = undefined;
    const toWrite = pendingState;
    pendingState = undefined;
    if (!toWrite) return;
    void getArea().set({ [SESSION_STATE_KEY]: toWrite }).catch((ex) => {
      console.warn("Failed to persist background session state:", ex);
    });
  }, 250);
}

// ── Service-worker keep-alive ─────────────────────────────────────────
// An in-flight upload can easily exceed the idle timeout while waiting on a
// slow CDN, with no extension API call in between to reset it. Periodically
// touching an extension API keeps the worker alive for the duration of the
// queue. This is a no-op cost on Firefox, where the background page persists.
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

export function startKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // Any extension API call resets the idle timer; getPlatformInfo is the
    // cheapest one with no side effects.
    void (browser.runtime as any).getPlatformInfo?.().catch(() => { });
  }, 20_000);
}

export function stopKeepAlive(): void {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = undefined;
}

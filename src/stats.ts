// ── Import statistics & failure store ─────────────────────────────────
// Lives in browser.storage.local under its own key so it never bloats the
// `config` object (which is read on every content-script injection).
//
// Writes happen from the background queue only, which is strictly
// sequential — so the read-modify-write below cannot interleave with itself.
// The options page only reads (plus explicit reset / failure dismissal).

import { createWriteChain } from "~/shared/async";
import { hostOf } from "~/shared/host";

export const STATS_STORAGE_KEY = "szuru_stats";

/** Keep the failure list bounded — it stores scrape payloads for retries. */
export const MAX_STORED_FAILURES = 50;

/** How many successful imports the history keeps. Bounded so the stats blob
 *  stays small — it is read on every options-page open. */
export const MAX_RECENT_IMPORTS = 50;

/** Days retained in the per-day histogram (drives the options-page chart). */
export const STATS_HISTORY_DAYS = 60;

export type ImportOutcome = "success" | "duplicate" | "error";

export interface OutcomeCounters {
  success: number;
  duplicate: number;
  error: number;
}

export interface FailedImport {
  id: string;
  at: number;
  pageUrl?: string;
  host?: string;
  siteId?: string;
  message: string;
  attempts: number;
  /** Scrape payload captured at import time, so a retry needs no open tab. */
  scrapeResults?: any;
}

/**
 * One successful import, kept so the options page can answer "what did I
 * upload last, and where did it go?" — the counters alone cannot.
 *
 * Deliberately small: no tags, no scrape payload. This is a log to click
 * through, not a second copy of the post.
 */
export interface RecentImport {
  at: number;
  /** Post id in the instance; absent only if szurubooru returned none. */
  postId?: number;
  /** Instance the post landed in, resolved to a label by the options page. */
  siteId?: string;
  /** Source page it came from, so the row can link back to the booru. */
  pageUrl?: string;
  host?: string;
  /** "duplicate" means it was already there — still worth showing. */
  outcome: Exclude<ImportOutcome, "error">;
}

export interface ImportStats {
  version: 1;
  totalSuccess: number;
  totalDuplicates: number;
  totalErrors: number;
  totalBytes: number;
  totalDurationMs: number;
  bySite: Record<string, OutcomeCounters>;
  byHost: Record<string, OutcomeCounters>;
  /** "YYYY-MM-DD" → successful (incl. duplicate) imports that day. */
  byDay: Record<string, number>;
  failures: FailedImport[];
  /** Newest-last log of successful imports; bounded by MAX_RECENT_IMPORTS. */
  recent: RecentImport[];
  firstImportAt?: number;
  lastImportAt?: number;
}

export function emptyStats(): ImportStats {
  return {
    version: 1,
    totalSuccess: 0,
    totalDuplicates: 0,
    totalErrors: 0,
    totalBytes: 0,
    totalDurationMs: 0,
    bySite: {},
    byHost: {},
    byDay: {},
    failures: [],
    recent: [],
  };
}

function emptyCounters(): OutcomeCounters {
  return { success: 0, duplicate: 0, error: 0 };
}

export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export { hostOf };

export async function getStats(): Promise<ImportStats> {
  try {
    const stored = await browser.storage.local.get(STATS_STORAGE_KEY);
    const raw = stored?.[STATS_STORAGE_KEY];
    if (!raw || typeof raw !== "object") return emptyStats();
    // Merge onto a fresh object so a stats blob written by an older version
    // never leaves a field undefined for the UI.
    return { ...emptyStats(), ...(raw as ImportStats) };
  } catch {
    return emptyStats();
  }
}

async function writeStats(stats: ImportStats): Promise<void> {
  try {
    await browser.storage.local.set({ [STATS_STORAGE_KEY]: stats });
  } catch (ex) {
    console.warn("Failed to persist import stats:", ex);
  }
}

// Every mutation is a read-modify-write on one storage key. Two of them
// overlapping at an await boundary would read the same snapshot and the second
// write would clobber the first. Once all writers live in the background
// context (the options page routes its mutations through messages — see the
// background's stats_mutate handler), chaining them here fully serialises the
// read-modify-write so no update is lost.
const serializeStatsWrite = createWriteChain();

function pruneHistory(stats: ImportStats) {
  const keys = Object.keys(stats.byDay).sort();
  while (keys.length > STATS_HISTORY_DAYS) {
    const oldest = keys.shift()!;
    delete stats.byDay[oldest];
  }
}

export interface RecordImportInput {
  outcome: ImportOutcome;
  pageUrl?: string;
  siteId?: string;
  /** Resulting post in the instance; drives the history row's link. */
  postId?: number;
  bytes?: number;
  durationMs?: number;
  /** Only used for `error`. */
  failure?: Omit<FailedImport, "at" | "host">;
}

export function recordImport(input: RecordImportInput): Promise<void> {
  return serializeStatsWrite(async () => {
    const stats = await getStats();
    const now = Date.now();
    const host = hostOf(input.pageUrl);

    const bump = (bucket: Record<string, OutcomeCounters>, key?: string) => {
      if (!key) return;
      bucket[key] = bucket[key] ?? emptyCounters();
      bucket[key][input.outcome]++;
    };

    bump(stats.bySite, input.siteId);
    bump(stats.byHost, host);

    if (input.outcome === "error") {
      stats.totalErrors++;
      if (input.failure) {
        stats.failures.push({ ...input.failure, at: now, host });
        // Newest failures are the actionable ones; drop from the front.
        if (stats.failures.length > MAX_STORED_FAILURES) {
          stats.failures.splice(0, stats.failures.length - MAX_STORED_FAILURES);
        }
      }
    } else {
      if (input.outcome === "duplicate") stats.totalDuplicates++;
      else stats.totalSuccess++;
      stats.byDay[dayKey(now)] = (stats.byDay[dayKey(now)] ?? 0) + 1;
      pruneHistory(stats);
      if (input.bytes && input.bytes > 0) stats.totalBytes += input.bytes;
      if (input.durationMs && input.durationMs > 0) stats.totalDurationMs += input.durationMs;

      stats.recent.push({
        at: now,
        postId: input.postId,
        siteId: input.siteId,
        pageUrl: input.pageUrl,
        host,
        outcome: input.outcome,
      });
      // Newest-last, so the oldest entries fall off the front.
      if (stats.recent.length > MAX_RECENT_IMPORTS) {
        stats.recent.splice(0, stats.recent.length - MAX_RECENT_IMPORTS);
      }
    }

    stats.firstImportAt = stats.firstImportAt ?? now;
    stats.lastImportAt = now;

    await writeStats(stats);
  });
}

export function removeFailure(id: string): Promise<void> {
  return serializeStatsWrite(async () => {
    const stats = await getStats();
    const next = stats.failures.filter((f) => f.id !== id);
    if (next.length === stats.failures.length) return;
    stats.failures = next;
    await writeStats(stats);
  });
}

export function clearFailures(): Promise<void> {
  return serializeStatsWrite(async () => {
    const stats = await getStats();
    if (stats.failures.length === 0) return;
    stats.failures = [];
    await writeStats(stats);
  });
}

/** Empty the import history without touching the counters. */
export function clearRecent(): Promise<void> {
  return serializeStatsWrite(async () => {
    const stats = await getStats();
    if (stats.recent.length === 0) return;
    stats.recent = [];
    await writeStats(stats);
  });
}

export function resetStats(): Promise<void> {
  return serializeStatsWrite(() => writeStats(emptyStats()));
}

/** Total imports that actually reached szurubooru (new posts + duplicates). */
export function totalImports(stats: ImportStats): number {
  return stats.totalSuccess + stats.totalDuplicates;
}

export function successRate(stats: ImportStats): number {
  const attempts = totalImports(stats) + stats.totalErrors;
  if (attempts === 0) return 0;
  return Math.round((totalImports(stats) / attempts) * 100);
}

/** Last `days` days as [dayKey, count] pairs, oldest first, gaps filled with 0. */
export function dailySeries(stats: ImportStats, days = 30): Array<{ day: string; count: number }> {
  const series: Array<{ day: string; count: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    const key = dayKey(d.getTime());
    series.push({ day: key, count: stats.byDay[key] ?? 0 });
  }
  return series;
}

export function topHosts(stats: ImportStats, limit = 8) {
  return Object.entries(stats.byHost)
    .map(([host, counters]) => ({
      host,
      ...counters,
      total: counters.success + counters.duplicate + counters.error,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** Newest-first view of the import history, for the options page. */
export function recentImports(stats: ImportStats, limit = MAX_RECENT_IMPORTS) {
  return [...stats.recent].reverse().slice(0, limit);
}

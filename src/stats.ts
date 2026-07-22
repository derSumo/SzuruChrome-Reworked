// ── Import statistics & failure store ─────────────────────────────────
// Lives in browser.storage.local under its own key so it never bloats the
// `config` object (which is read on every content-script injection).
//
// Writes happen from the background queue only, which is strictly
// sequential — so the read-modify-write below cannot interleave with itself.
// The options page only reads (plus explicit reset / failure dismissal).

export const STATS_STORAGE_KEY = "szuru_stats";

/** Keep the failure list bounded — it stores scrape payloads for retries. */
export const MAX_STORED_FAILURES = 50;

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

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

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
// read-modify-write so no update is lost. A rejected op must not break the
// chain, so its result is swallowed before the next op links on.
let statsWriteChain: Promise<unknown> = Promise.resolve();

function serializeStatsWrite<T>(op: () => Promise<T>): Promise<T> {
  const run = statsWriteChain.then(op, op);
  statsWriteChain = run.catch(() => { });
  return run;
}

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

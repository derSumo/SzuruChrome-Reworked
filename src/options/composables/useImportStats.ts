// ── Statistics tab state ──────────────────────────────────────────────
// Read-only view over `szuru_stats`; every mutation goes through the
// background so it joins that context's serialised write chain and can never
// clobber a concurrent recordImport from a finishing upload.

import { computed, onMounted, onUnmounted, ref } from "vue";
import byteSize from "byte-size";
import { cfg } from "~/stores";
import { BrowserCommand } from "~/models";
import { getErrorMessage } from "~/utils";
import {
  STATS_STORAGE_KEY,
  dailySeries,
  emptyStats,
  getStats,
  recentImports,
  successRate,
  topHosts,
  totalImports,
  type ImportStats,
} from "~/stats";
import { useI18n } from "~/i18n/vue";
import { useStatusMessage } from "./useStatusMessage";

export function useImportStats() {
  const { t } = useI18n();
  const { text: statusText, type: statusType, set: setStatus, clear: clearStatus } = useStatusMessage();
  const stats = ref<ImportStats>(emptyStats());

  async function refresh() {
    stats.value = await getStats();
  }

  // The background writes stats as imports complete; mirror that live so an
  // open options page doesn't show a stale snapshot.
  const onStorageChanged = (changes: Record<string, unknown>, area: string) => {
    if (area === "local" && changes[STATS_STORAGE_KEY]) void refresh();
  };

  onMounted(() => {
    void refresh();
    browser.storage.onChanged.addListener(onStorageChanged);
  });
  onUnmounted(() => browser.storage.onChanged.removeListener(onStorageChanged));

  const total = computed(() => totalImports(stats.value));
  const rate = computed(() => successRate(stats.value));
  const series = computed(() => dailySeries(stats.value, 30));
  const seriesMax = computed(() => Math.max(1, ...series.value.map((x) => x.count)));
  const hasActivity = computed(() => series.value.some((x) => x.count > 0));
  const hosts = computed(() => topHosts(stats.value, 8));

  // bySite is keyed by the (opaque) site id, so resolve each to its configured
  // label; unknown ids (a since-deleted instance) fall back to a shortened id
  // so the counts aren't silently dropped.
  const bySite = computed(() =>
    Object.entries(stats.value.bySite)
      .map(([siteId, counters]) => {
        const site = cfg.value.sites.find((s) => s.id === siteId);
        const label = site ? `${site.username} @ ${site.domain}` : `${siteId.slice(0, 8)}…`;
        return {
          siteId,
          label,
          ...counters,
          total: counters.success + counters.duplicate + counters.error,
        };
      })
      .sort((a, b) => b.total - a.total),
  );

  const transferred = computed(() => {
    const size = byteSize(stats.value.totalBytes);
    return `${size.value} ${size.unit}`;
  });

  const avgDuration = computed(() => {
    const count = total.value;
    if (count === 0 || stats.value.totalDurationMs === 0) return "–";
    const seconds = stats.value.totalDurationMs / count / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  });

  const lastImport = computed(() => {
    if (!stats.value.lastImportAt) return t("options.stats.never");
    return new Date(stats.value.lastImportAt).toLocaleString();
  });

  // Failures are stored oldest-first; the newest one is the one to act on.
  const failures = computed(() => [...stats.value.failures].reverse());

  // Same for the success log — newest first is the useful order to read it in.
  const history = computed(() => recentImports(stats.value));

  /** "2026-07-21" → "21.07." */
  function shortDay(day: string) {
    const [, month, date] = day.split("-");
    return `${date}.${month}.`;
  }

  async function retryFailure(id: string) {
    try {
      await browser.runtime.sendMessage(new BrowserCommand("retry_failed_import", { id }));
      setStatus(t("options.stats.retryQueued"), "success");
    } catch (ex) {
      setStatus(t("options.stats.retryFailed", { error: getErrorMessage(ex) }), "error");
    }
    await refresh();
  }

  async function mutate(op: string, id?: string) {
    await browser.runtime.sendMessage(new BrowserCommand("stats_mutate", id ? { op, id } : { op }));
    await refresh();
  }

  const dismissFailure = (id: string) => mutate("removeFailure", id);
  const dismissAllFailures = () => mutate("clearFailures");
  const clearHistory = () => mutate("clearRecent");

  async function reset() {
    if (!window.confirm(t("options.stats.resetConfirm"))) return;
    await mutate("resetStats");
    clearStatus();
  }

  return {
    stats,
    statusText,
    statusType,
    refresh,
    total,
    rate,
    series,
    seriesMax,
    hasActivity,
    hosts,
    bySite,
    transferred,
    avgDuration,
    lastImport,
    failures,
    history,
    shortDay,
    retryFailure,
    dismissFailure,
    dismissAllFailures,
    clearHistory,
    reset,
  };
}

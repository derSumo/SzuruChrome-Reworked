<script setup lang="ts">
// Everything the extension has stored about you: the configuration backup, the
// counters, the import history, and the failures worth retrying. Backup used
// to sit under "Interface", which it has nothing to do with.

import { cfg } from "~/stores";
import { postUrlFor } from "~/shared/host";
import { useI18n } from "~/i18n/vue";
import { useConfigBackup } from "../../composables/useConfigBackup";
import { useImportStats } from "../../composables/useImportStats";
import SettingCard from "../SettingCard.vue";
import SettingRow from "../SettingRow.vue";
import SettingToggle from "../SettingToggle.vue";

const { t } = useI18n();

const {
  statusText: backupStatus,
  statusType: backupStatusType,
  fileInput: backupFileInput,
  exportConfig,
  triggerImport,
  onImportFileChosen,
} = useConfigBackup();

const {
  stats,
  statusText,
  statusType,
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
} = useImportStats();

/** Link an import back to the post it created, when the instance is still configured. */
function postLink(siteId: string | undefined, postId: number | undefined): string | undefined {
  if (!siteId || !postId) return undefined;
  const site = cfg.value.sites.find((s) => s.id === siteId);
  return site ? postUrlFor(site.domain, postId) : undefined;
}
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.data.title") }}</h2>

    <!-- ── Backup ────────────────────────────────────────── -->
    <SettingCard :title="t('options.backup.title')" :hint="t('options.backup.hint')">
      <div class="card-actions backup-actions">
        <button class="btn btn-primary" @click="exportConfig(true)">{{ t("options.backup.export") }}</button>
        <button class="btn btn-secondary" @click="exportConfig(false)">
          {{ t("options.backup.exportNoTokens") }}
        </button>
        <button class="btn btn-secondary" @click="triggerImport()">{{ t("options.backup.import") }}</button>
        <input
          ref="backupFileInput"
          type="file"
          accept="application/json,.json"
          class="hidden-file-input"
          @change="onImportFileChosen"
        />
      </div>

      <p v-if="backupStatus" class="status-text" :class="`status-${backupStatusType}`">{{ backupStatus }}</p>
    </SettingCard>

    <!-- ── Statistics ────────────────────────────────────── -->
    <SettingCard :title="t('options.stats.overview')">
      <SettingRow path="statsEnabled" :label="t('options.queue.stats')" :hint="t('options.queue.statsHint')">
        <SettingToggle v-model="cfg.statsEnabled" />
      </SettingRow>

      <div class="stat-grid">
        <div class="stat-tile">
          <span class="stat-value">{{ total }}</span>
          <span class="stat-label">{{ t("options.stats.imported") }}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{{ stats.totalDuplicates }}</span>
          <span class="stat-label">{{ t("options.stats.duplicates") }}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value" :class="{ bad: stats.totalErrors > 0 }">{{ stats.totalErrors }}</span>
          <span class="stat-label">{{ t("options.stats.errors") }}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{{ rate }}%</span>
          <span class="stat-label">{{ t("options.stats.successRate") }}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{{ transferred }}</span>
          <span class="stat-label">{{ t("options.stats.transferred") }}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-value">{{ avgDuration }}</span>
          <span class="stat-label">{{ t("options.stats.avgDuration") }}</span>
        </div>
      </div>

      <div class="stat-footnote">{{ t("options.stats.lastImport") }}: {{ lastImport }}</div>
    </SettingCard>

    <SettingCard :title="t('options.stats.activity')">
      <div v-if="!hasActivity" class="uac-empty">{{ t("options.stats.activityEmpty") }}</div>
      <div v-else class="stat-chart">
        <div
          v-for="entry in series"
          :key="entry.day"
          class="stat-bar-slot"
          :title="`${shortDay(entry.day)} — ${entry.count}`"
        >
          <div
            class="stat-bar"
            :class="{ empty: entry.count === 0 }"
            :style="{ height: `${Math.max((entry.count / seriesMax) * 100, entry.count > 0 ? 6 : 2)}%` }"
          ></div>
        </div>
      </div>
    </SettingCard>

    <!-- ── Import history ────────────────────────────────── -->
    <SettingCard :title="t('options.history.title')" :hint="t('options.history.hint')">
      <div v-if="history.length === 0" class="uac-empty">{{ t("options.history.empty") }}</div>

      <div v-else class="history-list">
        <div v-for="(entry, index) in history" :key="index" class="history-row">
          <span class="history-outcome" :class="entry.outcome">
            {{ entry.outcome === "duplicate" ? t("options.history.duplicate") : t("options.history.new") }}
          </span>
          <a
            v-if="postLink(entry.siteId, entry.postId)"
            class="history-post"
            :href="postLink(entry.siteId, entry.postId)"
            target="_blank"
            rel="noopener"
          >#{{ entry.postId }}</a>
          <span v-else class="history-post muted">—</span>
          <a
            v-if="entry.pageUrl"
            class="history-source"
            :href="entry.pageUrl"
            target="_blank"
            rel="noopener"
            :title="entry.pageUrl"
          >{{ entry.host ?? entry.pageUrl }}</a>
          <span v-else class="history-source muted">{{ entry.host ?? "—" }}</span>
          <span class="history-time">{{ new Date(entry.at).toLocaleString() }}</span>
        </div>
      </div>

      <div v-if="history.length > 0" class="card-actions">
        <button class="btn btn-secondary" @click="clearHistory">{{ t("options.history.clear") }}</button>
      </div>
    </SettingCard>

    <!-- ── Breakdowns ────────────────────────────────────── -->
    <SettingCard v-if="hosts.length > 0" :title="t('options.stats.topHosts')">
      <div class="host-table">
        <div class="host-table-header">
          <span>{{ t("options.stats.host") }}</span>
          <span>{{ t("options.stats.colOk") }}</span>
          <span>{{ t("options.stats.colDupe") }}</span>
          <span>{{ t("options.stats.colFail") }}</span>
        </div>
        <div v-for="host in hosts" :key="host.host" class="host-table-row">
          <span class="host-name">{{ host.host }}</span>
          <span>{{ host.success }}</span>
          <span>{{ host.duplicate }}</span>
          <span :class="{ bad: host.error > 0 }">{{ host.error }}</span>
        </div>
      </div>
    </SettingCard>

    <SettingCard v-if="bySite.length > 1" :title="t('options.stats.byInstance')">
      <div class="host-table">
        <div class="host-table-header">
          <span>{{ t("options.stats.instance") }}</span>
          <span>{{ t("options.stats.colOk") }}</span>
          <span>{{ t("options.stats.colDupe") }}</span>
          <span>{{ t("options.stats.colFail") }}</span>
        </div>
        <div v-for="site in bySite" :key="site.siteId" class="host-table-row">
          <span class="host-name">{{ site.label }}</span>
          <span>{{ site.success }}</span>
          <span>{{ site.duplicate }}</span>
          <span :class="{ bad: site.error > 0 }">{{ site.error }}</span>
        </div>
      </div>
    </SettingCard>

    <!-- ── Failures ──────────────────────────────────────── -->
    <SettingCard :title="t('options.stats.failures')" :hint="t('options.stats.failuresHint')">
      <div v-if="failures.length === 0" class="uac-empty">{{ t("options.stats.noFailures") }}</div>

      <div v-for="failure in failures" :key="failure.id" class="failure-row">
        <div class="failure-info">
          <span class="failure-message">{{ failure.message }}</span>
          <a v-if="failure.pageUrl" class="failure-url" :href="failure.pageUrl" target="_blank" rel="noopener">
            {{ failure.pageUrl }}
          </a>
          <span class="failure-meta">
            {{ new Date(failure.at).toLocaleString() }} ·
            {{ t("options.stats.attempts", { count: failure.attempts }) }}
          </span>
        </div>
        <div class="failure-actions">
          <button class="btn btn-secondary" :disabled="!failure.scrapeResults" @click="retryFailure(failure.id)">
            {{ t("options.stats.retry") }}
          </button>
          <button class="btn-icon btn-remove" :title="t('options.stats.dismiss')" @click="dismissFailure(failure.id)">
            ✕
          </button>
        </div>
      </div>

      <div v-if="failures.length > 0" class="card-actions">
        <button class="btn btn-secondary" @click="dismissAllFailures">{{ t("options.stats.clearFailures") }}</button>
      </div>
    </SettingCard>

    <div class="card-actions">
      <span v-if="statusText" class="status-text" :class="`status-${statusType}`">{{ statusText }}</span>
      <button class="btn btn-danger ml-auto" @click="reset">{{ t("options.stats.reset") }}</button>
    </div>
  </div>
</template>

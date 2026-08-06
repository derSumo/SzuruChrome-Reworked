<script setup lang="ts">
import { useColorMode } from "@vueuse/core";
import byteSize from "byte-size";
import { cfg } from "~/stores";
import { getErrorMessage } from "~/utils";
import { normalizeHost } from "~/shared/host";
import {
  SOURCE_SITES,
  ensureInstancePermission,
  hasSourceSitePermission,
  removeSourceSitePermission,
  requestSourceSitePermission,
  type SourceSite,
} from "~/shared/sourceSites";
import OptionsSidebar from "./components/OptionsSidebar.vue";
import SourceAccessSettings from "./components/SourceAccessSettings.vue";
import { BrowserCommand, SzuruSiteConfig, TagCategoryColor, getDefaultTagCategories } from "~/models";
import { previewTagRules } from "~/tagRules";
import {
  STATS_STORAGE_KEY,
  dailySeries,
  emptyStats,
  getStats,
  successRate,
  topHosts,
  totalImports,
  type ImportStats,
} from "~/stats";
import SzurubooruApi from "~/api";
import { setLanguage, type Language } from "~/i18n";
import { useI18n } from "~/i18n/vue";

const { t, availableLanguages } = useI18n();

type StatusType = "success" | "error" | "quiet";

const statusText = ref("");
const statusType = ref<StatusType>("quiet");
const versionInfo = import.meta.env.VITE_SZ_VERSION ?? browser.runtime.getManifest().version;
const activeTab = ref("general");

const tabs = computed(() => [
  { id: "general", label: t("options.tab.general") },
  { id: "interface", label: t("options.tab.interface") },
  { id: "instances", label: t("options.tab.instances") },
  { id: "tags", label: t("options.tab.tags") },
  { id: "stats", label: t("options.tab.stats") },
  { id: "changelog", label: t("options.tab.changelog") },
]);

// Sync language from config into i18n system
watch(() => cfg.value.language, (lang) => {
  setLanguage(lang as Language);
}, { immediate: true });

const selectedSite = computed(() => {
  if (cfg.value.selectedSiteId) {
    return cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId);
  }
});

const mode = useColorMode({ emitAuto: true });

async function testConnection() {
  if (!selectedSite.value?.domain || !selectedSite.value?.username || !selectedSite.value?.authToken) {
    setStatus(t("options.instances.required"), "error");
    return;
  }
  if (!await ensureInstancePermission(selectedSite.value.domain)) {
    setStatus(t("options.instances.permissionRequired"), "error");
    return;
  }
  const api = new SzurubooruApi(selectedSite.value.domain, selectedSite.value.username, selectedSite.value.authToken);
  try {
    const info = await api.getInfo();
    const instanceName = info?.config.name;
    if (instanceName == undefined) {
      setStatus(t("options.instances.connectedNoName", { domain: selectedSite.value.domain }), "error");
    } else {
      setStatus(t("options.instances.connected", { name: info.config.name, domain: selectedSite.value.domain }), "success");
    }
  } catch (ex) {
    setStatus(t("options.instances.connectFailed", { domain: selectedSite.value.domain, error: getErrorMessage(ex) }), "error");
  }
}

function setStatus(text: string, type: StatusType = "success") {
  statusText.value = text;
  statusType.value = type;
}

function addSite() {
  const site = new SzuruSiteConfig();
  cfg.value.sites.push(site);
  cfg.value.selectedSiteId = site.id;
}

function removeSelectedSite() {
  if (selectedSite.value) {
    const idx = cfg.value.sites.indexOf(selectedSite.value);
    cfg.value.sites.splice(idx, 1);
  }
  if (cfg.value.sites.length > 0) {
    cfg.value.selectedSiteId = cfg.value.sites[0].id;
  } else {
    cfg.value.selectedSiteId = undefined;
  }
}

function resetTagCategories() {
  cfg.value.tagCategories.splice(0);
  cfg.value.tagCategories.push(...getDefaultTagCategories());
}

function addTagCategory() {
  cfg.value.tagCategories.push(new TagCategoryColor("category", "#abcdef"));
}

async function importTagCategoriesFromInstance() {
  const szuruConfig = cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId)!;
  if (!await ensureInstancePermission(szuruConfig.domain)) {
    setStatus(t("options.instances.permissionRequired"), "error");
    return;
  }
  const szuru = SzurubooruApi.createFromConfig(szuruConfig);
  const cats = (await szuru.getTagCategories()).results;
  for (const cat of cats) {
    if (cat.name == "default") continue;
    if (!cfg.value.tagCategories.find((x) => x.name == cat.name)) {
      cfg.value.tagCategories.push(new TagCategoryColor(cat.name, cat.color));
    }
  }
}

const wnd = window as any;
wnd.szc_get_config = () => JSON.parse(JSON.stringify(cfg.value));
wnd.szc_set_config_version = (v = 0) => (cfg.value.version = v);

// ── Hotkey recorder ──────────────────────────────────────
const sourceSiteAccess = ref<Record<string, boolean>>({});

async function refreshSourceSiteAccess(): Promise<void> {
  const values = await Promise.all(SOURCE_SITES.map(async (site) => [site.id, await hasSourceSitePermission(site)] as const));
  sourceSiteAccess.value = Object.fromEntries(values);
}

async function setSourceSiteAccess(site: SourceSite, enabled: boolean): Promise<void> {
  try {
    // The first call inside this handler is the permission request/removal, so
    // Chrome still considers it a direct user gesture.
    const changed = enabled
      ? await requestSourceSitePermission(site)
      : await removeSourceSitePermission(site);
    sourceSiteAccess.value = { ...sourceSiteAccess.value, [site.id]: enabled && changed };
  } catch (ex) {
    setStatus(getErrorMessage(ex), "error");
    await refreshSourceSiteAccess();
  }
}

// ── Per-site "upload as content" whitelist ───────────────────
const newUploadAsContentSite = ref("");

function addUploadAsContentSite(raw: string) {
  const host = normalizeHost(raw);
  if (!host) return;
  if (!cfg.value.uploadAsContentSites) cfg.value.uploadAsContentSites = [];
  if (!cfg.value.uploadAsContentSites.includes(host)) {
    cfg.value.uploadAsContentSites.push(host);
  }
}

function removeUploadAsContentSite(host: string) {
  if (!cfg.value.uploadAsContentSites) return;
  const idx = cfg.value.uploadAsContentSites.indexOf(host);
  if (idx >= 0) cfg.value.uploadAsContentSites.splice(idx, 1);
}

// ── Hover-zoom site whitelist ────────────────────────────────
const newZoomSite = ref("");

function addZoomSite() {
  const host = normalizeHost(newZoomSite.value);
  if (!host) return;
  if (!cfg.value.listing.hoverZoomSites) cfg.value.listing.hoverZoomSites = [];
  if (!cfg.value.listing.hoverZoomSites.includes(host)) {
    cfg.value.listing.hoverZoomSites.push(host);
  }
  newZoomSite.value = "";
}

function removeZoomSite(host: string) {
  const idx = cfg.value.listing.hoverZoomSites?.indexOf(host) ?? -1;
  if (idx >= 0) cfg.value.listing.hoverZoomSites.splice(idx, 1);
}

function addNewSiteFromInput() {
  if (!newUploadAsContentSite.value.trim()) return;
  addUploadAsContentSite(newUploadAsContentSite.value);
  newUploadAsContentSite.value = "";
}

// ── Configuration backup (export / import) ───────────────────
const importFileInput = ref<HTMLInputElement | null>(null);
const backupMessage = ref("");
const backupMessageType = ref<StatusType>("quiet");

function setBackupMessage(text: string, type: StatusType = "success") {
  backupMessage.value = text;
  backupMessageType.value = type;
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick so the click has committed the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportConfig(includeTokens: boolean) {
  const snapshot = JSON.parse(JSON.stringify(cfg.value));
  if (!includeTokens) {
    // Strip credentials so a shared backup can't leak instance access.
    for (const site of snapshot.sites ?? []) site.authToken = "";
  }
  const stamp = new Date().toISOString().slice(0, 10);
  downloadJson(snapshot, `szuruchrome-config-${stamp}.json`);
  setBackupMessage(t("options.backup.exported"), "success");
}

function triggerImport() {
  importFileInput.value?.click();
}

async function onImportFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // allow re-picking the same file later
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sites)) {
      throw new Error(t("options.backup.importInvalid"));
    }

    // Assign top-level keys individually rather than replacing cfg.value, so
    // keys absent from an older backup keep their current defaults. Reset the
    // version so the store's migration re-runs and fills any new fields.
    for (const key of Object.keys(parsed)) {
      (cfg.value as any)[key] = parsed[key];
    }
    cfg.value.version = 0;

    setBackupMessage(t("options.backup.imported"), "success");
  } catch (ex) {
    setBackupMessage(t("options.backup.importFailed", { error: getErrorMessage(ex) }), "error");
  }
}

// ── Tag blacklist / rename rules ─────────────────────────────
const newBlacklistPattern = ref("");

function addBlacklistPattern() {
  const pattern = newBlacklistPattern.value.trim();
  if (!pattern) return;
  if (!cfg.value.tagRules.blacklist.includes(pattern)) {
    cfg.value.tagRules.blacklist.push(pattern);
  }
  newBlacklistPattern.value = "";
}

function removeBlacklistPattern(index: number) {
  cfg.value.tagRules.blacklist.splice(index, 1);
}

function addRewriteRule() {
  cfg.value.tagRules.rewrites.push({ from: "", to: "" });
}

function removeRewriteRule(index: number) {
  cfg.value.tagRules.rewrites.splice(index, 1);
}

// Live tester: accepts newline- or comma-separated tag names.
const tagRuleTestInput = ref("");

const tagRuleTestRows = computed(() => {
  const names = tagRuleTestInput.value
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (names.length === 0) return [];
  return previewTagRules(names, cfg.value.tagRules);
});

// ── Statistics ───────────────────────────────────────────────
const stats = ref<ImportStats>(emptyStats());
const statsMessage = ref("");
const statsMessageType = ref<StatusType>("quiet");

async function refreshStats() {
  stats.value = await getStats();
}

function setStatsMessage(text: string, type: StatusType = "success") {
  statsMessage.value = text;
  statsMessageType.value = type;
}

onMounted(() => {
  void refreshStats();
  void refreshSourceSiteAccess();
});

// The background writes stats as imports complete; mirror that live so an
// open options page doesn't show a stale snapshot.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STATS_STORAGE_KEY]) void refreshStats();
});

watch(activeTab, (tab) => {
  if (tab === "stats") void refreshStats();
});

const statsTotalImports = computed(() => totalImports(stats.value));
const statsSuccessRate = computed(() => successRate(stats.value));
const statsSeries = computed(() => dailySeries(stats.value, 30));
const statsSeriesMax = computed(() => Math.max(1, ...statsSeries.value.map((x) => x.count)));
const statsHasActivity = computed(() => statsSeries.value.some((x) => x.count > 0));
const statsTopHosts = computed(() => topHosts(stats.value, 8));

// Per-instance breakdown. bySite is keyed by the (opaque) site id, so resolve
// each to its configured label; unknown ids (a since-deleted instance) fall
// back to a shortened id so the counts aren't silently dropped.
const statsBySite = computed(() =>
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

const statsTransferred = computed(() => {
  const size = byteSize(stats.value.totalBytes);
  return `${size.value} ${size.unit}`;
});

const statsAvgDuration = computed(() => {
  const count = statsTotalImports.value;
  if (count === 0 || stats.value.totalDurationMs === 0) return "–";
  const seconds = stats.value.totalDurationMs / count / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
});

const statsLastImport = computed(() => {
  if (!stats.value.lastImportAt) return t("options.stats.never");
  return new Date(stats.value.lastImportAt).toLocaleString();
});

// Failures are stored oldest-first; the newest one is the one to act on.
const statsFailures = computed(() => [...stats.value.failures].reverse());

function shortDay(day: string) {
  // "2026-07-21" → "21.07."
  const [, month, date] = day.split("-");
  return `${date}.${month}.`;
}

async function retryFailure(id: string) {
  try {
    await browser.runtime.sendMessage(new BrowserCommand("retry_failed_import", { id }));
    setStatsMessage(t("options.stats.retryQueued"), "success");
  } catch (ex) {
    setStatsMessage(t("options.stats.retryFailed", { error: getErrorMessage(ex) }), "error");
  }
  await refreshStats();
}

// Stats mutations go through the background so they share its serialised write
// chain and never clobber a concurrent recordImport from a finishing upload.
async function dismissFailure(id: string) {
  await browser.runtime.sendMessage(new BrowserCommand("stats_mutate", { op: "removeFailure", id }));
  await refreshStats();
}

async function dismissAllFailures() {
  await browser.runtime.sendMessage(new BrowserCommand("stats_mutate", { op: "clearFailures" }));
  await refreshStats();
}

async function doResetStats() {
  if (!window.confirm(t("options.stats.resetConfirm"))) return;
  await browser.runtime.sendMessage(new BrowserCommand("stats_mutate", { op: "resetStats" }));
  await refreshStats();
  setStatsMessage("", "quiet");
}

</script>

<template>
  <div class="page">
    <OptionsSidebar
      :tabs="tabs"
      :active-tab="activeTab"
      :version="versionInfo"
      :brand="t('options.brand')"
      :fork-by="t('options.forkBy')"
      @select="activeTab = $event"
    />

    <main class="content">
      <!-- General Tab -->
      <div v-if="activeTab === 'general'" class="tab-content">
        <h2 class="tab-title">{{ t("options.general.title") }}</h2>

        <div class="card">
          <h3 class="card-title">{{ t("options.general.importBehavior") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.addPageUrl") }}</span>
              <span class="option-hint">{{ t("options.general.addPageUrlHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addPageUrlToSource" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.autoImportTags") }}</span>
              <span class="option-hint">{{ t("options.general.autoImportTagsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addAllParsedTags" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">
                {{ t("options.general.uploadAsContent") }}
                <span class="warn-tooltip" :title="t('options.general.uploadAsContentWarning')">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="8" cy="8" r="7" stroke="#f59e0b" stroke-width="1.5"/>
                    <path d="M8 5v4" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/>
                    <circle cx="8" cy="11.5" r="0.75" fill="#f59e0b"/>
                  </svg>
                </span>
              </span>
              <span class="option-hint">{{ t("options.general.uploadAsContentHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.alwaysUploadAsContent" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.addImplications") }}</span>
              <span class="option-hint">{{ t("options.general.addImplicationsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addTagImplications" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.general.uploadAsContentSites") }}</h3>
          <p class="card-hint">{{ t("options.general.uploadAsContentSitesHint") }}</p>

          <div class="uac-active">
            <template v-if="(cfg.uploadAsContentSites ?? []).length === 0">
              <div class="uac-empty">{{ t("options.general.uploadAsContentSitesEmpty") }}</div>
            </template>
            <span v-for="host in cfg.uploadAsContentSites" :key="host" class="uac-chip">
              <span class="uac-host">{{ host }}</span>
              <button class="uac-remove" @click="removeUploadAsContentSite(host)" title="Remove">✕</button>
            </span>
          </div>

          <div class="uac-add-row">
            <input
              type="text"
              :placeholder="t('options.general.uploadAsContentAddPlaceholder')"
              v-model="newUploadAsContentSite"
              @keydown.enter.prevent="addNewSiteFromInput"
            />
            <button class="btn btn-secondary" @click="addNewSiteFromInput">{{ t("options.general.uploadAsContentAdd") }}</button>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.tagRules.title") }}</h3>
          <p class="card-hint">{{ t("options.tagRules.hint") }}</p>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.tagRules.enable") }}</span>
              <span class="option-hint">{{ t("options.tagRules.enableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.tagRules.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <template v-if="cfg.tagRules.enabled">
            <p class="rule-syntax">{{ t("options.tagRules.syntax") }}</p>

            <h4 class="sub-title">{{ t("options.tagRules.blacklist") }}</h4>
            <p class="card-hint">{{ t("options.tagRules.blacklistHint") }}</p>

            <div class="uac-active">
              <div v-if="cfg.tagRules.blacklist.length === 0" class="uac-empty">
                {{ t("options.tagRules.blacklistEmpty") }}
              </div>
              <span v-for="(pattern, index) in cfg.tagRules.blacklist" :key="index" class="uac-chip">
                <span class="uac-host">{{ pattern }}</span>
                <button class="uac-remove" @click="removeBlacklistPattern(index)" :title="t('options.tagRules.remove')">✕</button>
              </span>
            </div>

            <div class="uac-add-row">
              <input
                type="text"
                :placeholder="t('options.tagRules.blacklistPlaceholder')"
                v-model="newBlacklistPattern"
                @keydown.enter.prevent="addBlacklistPattern"
              />
              <button class="btn btn-secondary" @click="addBlacklistPattern">{{ t("options.tagRules.add") }}</button>
            </div>

            <h4 class="sub-title">{{ t("options.tagRules.rewrites") }}</h4>
            <p class="card-hint">{{ t("options.tagRules.rewritesHint") }}</p>

            <div class="rule-table">
              <div class="rule-table-header">
                <span>{{ t("options.tagRules.from") }}</span>
                <span>{{ t("options.tagRules.to") }}</span>
                <span></span>
              </div>
              <div v-for="(rule, index) in cfg.tagRules.rewrites" :key="index" class="rule-table-row">
                <input type="text" v-model="rule.from" :placeholder="t('options.tagRules.fromPlaceholder')" />
                <input type="text" v-model="rule.to" :placeholder="t('options.tagRules.toPlaceholder')" />
                <button class="btn-icon btn-remove" @click="removeRewriteRule(index)" :title="t('options.tagRules.remove')">✕</button>
              </div>
              <div v-if="cfg.tagRules.rewrites.length === 0" class="tag-table-empty">
                {{ t("options.tagRules.rewritesEmpty") }}
              </div>
            </div>

            <div class="card-actions">
              <button class="btn btn-primary" @click="addRewriteRule">{{ t("options.tagRules.addRewrite") }}</button>
            </div>

            <h4 class="sub-title">{{ t("options.tagRules.tester") }}</h4>
            <p class="card-hint">{{ t("options.tagRules.testerHint") }}</p>
            <textarea
              class="rule-tester-input"
              rows="4"
              v-model="tagRuleTestInput"
              :placeholder="t('options.tagRules.testerPlaceholder')"
            ></textarea>

            <div class="rule-preview">
              <div v-if="tagRuleTestRows.length === 0" class="uac-empty">
                {{ t("options.tagRules.testerEmpty") }}
              </div>
              <div
                v-for="(row, index) in tagRuleTestRows"
                :key="index"
                class="rule-preview-row"
                :class="{ dropped: row.dropped, changed: row.changed }"
              >
                <span class="rule-preview-in">{{ row.input }}</span>
                <span class="rule-preview-arrow">→</span>
                <span v-if="row.dropped" class="rule-preview-out muted">{{ t("options.tagRules.testerDropped") }}</span>
                <span v-else-if="row.changed" class="rule-preview-out">{{ row.output }}</span>
                <span v-else class="rule-preview-out muted">{{ t("options.tagRules.testerUnchanged") }}</span>
              </div>
            </div>
          </template>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.general.autoRelations") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.autoRelationsEnable") }}</span>
              <span class="option-hint">{{ t("options.general.autoRelationsEnableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.autoRelationsEnabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <template v-if="cfg.autoRelationsEnabled">
            <div class="option-row">
              <div class="option-info">
                <span class="option-label">{{ t("options.general.autoRelationThreshold") }}</span>
                <span class="option-hint">{{ t("options.general.autoRelationThresholdHint") }}</span>
              </div>
              <div class="slider-group">
                <input
                  type="range"
                  min="50"
                  max="100"
                  step="1"
                  v-model.number="cfg.autoRelationThreshold"
                  class="lq-slider"
                />
                <span class="slider-value">{{ cfg.autoRelationThreshold }}%</span>
              </div>
            </div>
            <div class="option-row">
              <div class="option-info">
                <span class="option-label">{{ t("options.general.replaceExactDuplicates") }}</span>
                <span class="option-hint">{{ t("options.general.replaceExactDuplicatesHint") }}</span>
              </div>
              <label class="toggle">
                <input type="checkbox" v-model="cfg.replaceExactDuplicates" />
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </template>
        </div>

        <SourceAccessSettings
          :access="sourceSiteAccess"
          :title="t('options.permissions.title')"
          :hint="t('options.permissions.hint')"
          @change="setSourceSiteAccess"
        />

        <div class="card">
          <h3 class="card-title">{{ t("options.commands.title") }}</h3>
          <p class="card-hint">{{ t("options.commands.hint") }}</p>
          <p class="card-hint"><code>chrome://extensions/shortcuts</code></p>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.badge.title") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.badge.enable") }}</span>
              <span class="option-hint">{{ t("options.badge.enableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.importedBadge.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.importedBadge.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.badge.showMissing") }}</span>
              <span class="option-hint">{{ t("options.badge.showMissingHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.importedBadge.showWhenNotImported" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.importedBadge.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.badge.thumbnails") }}</span>
              <span class="option-hint">{{ t("options.badge.thumbnailsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.importedBadge.thumbnails" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.listing.title") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.listing.hoverActions") }}</span>
              <span class="option-hint">{{ t("options.listing.hoverActionsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.listing.hoverActions" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.listing.endlessScroll") }}</span>
              <span class="option-hint">{{ t("options.listing.endlessScrollHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.listing.endlessScroll" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.listing.hoverZoom") }}</span>
              <span class="option-hint">{{ t("options.listing.hoverZoomHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.listing.hoverZoom" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.listing.hoverZoom">
            <div class="option-info">
              <span class="option-label">{{ t("options.listing.hoverZoomScope") }}</span>
              <span class="option-hint">{{ t("options.listing.hoverZoomScopeHint") }}</span>
            </div>
            <div class="select-wrapper">
              <select v-model="cfg.listing.hoverZoomScope">
                <option value="sites">{{ t("options.listing.hoverZoomScopeSites") }}</option>
                <option value="all">{{ t("options.listing.hoverZoomScopeAll") }}</option>
              </select>
            </div>
          </div>

          <div class="option-row" v-if="cfg.listing.hoverZoom">
            <div class="option-info">
              <span class="option-label">{{ t("options.listing.hoverZoomDelay") }}</span>
              <span class="option-hint">{{ t("options.listing.hoverZoomDelayHint") }}</span>
            </div>
            <div class="slider-group">
              <input
                type="range" min="0" max="1500" step="50"
                v-model.number="cfg.listing.hoverZoomDelayMs" class="lq-slider"
              />
              <span class="slider-value">{{ cfg.listing.hoverZoomDelayMs }} ms</span>
            </div>
          </div>

          <template v-if="cfg.listing.hoverZoom && cfg.listing.hoverZoomScope === 'sites'">
            <p class="card-hint">{{ t("options.listing.hoverZoomSitesHint") }}</p>

            <div class="uac-active">
              <template v-if="(cfg.listing.hoverZoomSites ?? []).length === 0">
                <div class="uac-empty">{{ t("options.listing.hoverZoomSitesEmpty") }}</div>
              </template>
              <span v-for="host in cfg.listing.hoverZoomSites" :key="host" class="uac-chip">
                <span class="uac-host">{{ host }}</span>
                <button class="uac-remove" @click="removeZoomSite(host)" title="Remove">✕</button>
              </span>
            </div>

            <div class="uac-add-row">
              <input
                type="text"
                :placeholder="t('options.general.uploadAsContentAddPlaceholder')"
                v-model="newZoomSite"
                @keydown.enter.prevent="addZoomSite"
              />
              <button class="btn btn-secondary" @click="addZoomSite">{{ t("options.general.uploadAsContentAdd") }}</button>
            </div>
          </template>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.batch.title") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.enable") }}</span>
              <span class="option-hint">{{ t("options.batch.enableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.batchImport.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.batchImport.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.skipImported") }}</span>
              <span class="option-hint">{{ t("options.batch.skipImportedHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.batchImport.skipImported" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.batchImport.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.separateWindow") }}</span>
              <span class="option-hint">{{ t("options.batch.separateWindowHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.batchImport.separateWindow" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.batchImport.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.concurrency") }}</span>
              <span class="option-hint">{{ t("options.batch.concurrencyHint") }}</span>
            </div>
            <div class="slider-group">
              <input type="range" min="1" max="3" step="1" v-model.number="cfg.batchImport.concurrency" class="lq-slider" />
              <span class="slider-value">{{ cfg.batchImport.concurrency }}×</span>
            </div>
          </div>

          <div class="option-row" v-if="cfg.batchImport.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.maxPosts") }}</span>
              <span class="option-hint">{{ t("options.batch.maxPostsHint") }}</span>
            </div>
            <input
              type="number" min="1" max="10000" step="10"
              v-model.number="cfg.batchImport.maxPosts"
              class="limit-input"
            />
          </div>

          <div class="option-row" v-if="cfg.batchImport.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.batch.maxPages") }}</span>
              <span class="option-hint">{{ t("options.batch.maxPagesHint") }}</span>
            </div>
            <input
              type="number" min="1" max="500" step="1"
              v-model.number="cfg.batchImport.maxPages"
              class="limit-input"
            />
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.queue.title") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.queue.retryEnable") }}</span>
              <span class="option-hint">{{ t("options.queue.retryEnableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.queueRetry.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row" v-if="cfg.queueRetry.enabled">
            <div class="option-info">
              <span class="option-label">{{ t("options.queue.maxAttempts") }}</span>
              <span class="option-hint">{{ t("options.queue.maxAttemptsHint") }}</span>
            </div>
            <div class="slider-group">
              <input type="range" min="1" max="6" step="1" v-model.number="cfg.queueRetry.maxAttempts" class="lq-slider" />
              <span class="slider-value">{{ cfg.queueRetry.maxAttempts }}×</span>
            </div>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.queue.stats") }}</span>
              <span class="option-hint">{{ t("options.queue.statsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.statsEnabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Interface Tab -->
      <div v-if="activeTab === 'interface'" class="tab-content">
        <h2 class="tab-title">{{ t("options.interface.title") }}</h2>

        <div class="card">
          <h3 class="card-title">{{ t("options.interface.appearance") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.theme") }}</span>
              <span class="option-hint">{{ t("options.interface.themeHint") }}</span>
            </div>
            <div class="select-wrapper">
              <select v-model="mode">
                <option value="auto">{{ t("options.interface.themeAuto") }}</option>
                <option value="light">{{ t("options.interface.themeLight") }}</option>
                <option value="dark">{{ t("options.interface.themeDark") }}</option>
              </select>
            </div>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.language") }}</span>
              <span class="option-hint">{{ t("options.interface.languageHint") }}</span>
            </div>
            <div class="select-wrapper">
              <select v-model="cfg.language">
                <option v-for="lang in availableLanguages" :key="lang.value" :value="lang.value">{{ lang.label }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.interface.popupCustomization") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.autoSearch") }}</span>
              <span class="option-hint">{{ t("options.interface.autoSearchHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.autoSearchSimilar" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.tagCounts") }}</span>
              <span class="option-hint">{{ t("options.interface.tagCountsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.loadTagCounts" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.showSource") }}</span>
              <span class="option-hint">{{ t("options.interface.showSourceHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.popup.showSource" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.showPools") }}</span>
              <span class="option-hint">{{ t("options.interface.showPoolsHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.popup.showPools" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.interface.tagSortMode") }}</span>
              <span class="option-hint">{{ t("options.interface.tagSortModeHint") }}</span>
            </div>
            <div class="select-wrapper">
              <select v-model="cfg.popup.tagSortMode">
                <option value="usage">{{ t("popup.sortUsage") }}</option>
                <option value="category">{{ t("popup.sortCategory") }}</option>
                <option value="name">{{ t("popup.sortName") }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.backup.title") }}</h3>
          <p class="card-hint">{{ t("options.backup.hint") }}</p>

          <div class="card-actions backup-actions">
            <button class="btn btn-primary" @click="exportConfig(true)">{{ t("options.backup.export") }}</button>
            <button class="btn btn-secondary" @click="exportConfig(false)">{{ t("options.backup.exportNoTokens") }}</button>
            <button class="btn btn-secondary" @click="triggerImport">{{ t("options.backup.import") }}</button>
            <input
              ref="importFileInput"
              type="file"
              accept="application/json,.json"
              class="hidden-file-input"
              @change="onImportFileChosen"
            />
          </div>

          <p v-if="backupMessage" class="status-text" :class="`status-${backupMessageType}`">{{ backupMessage }}</p>
        </div>
      </div>

      <!-- Instances Tab -->
      <div v-if="activeTab === 'instances'" class="tab-content">
        <h2 class="tab-title">{{ t("options.instances.title") }}</h2>

        <div class="card">
          <h3 class="card-title">{{ t("options.instances.servers") }}</h3>

          <div class="instance-bar">
            <select v-model="cfg.selectedSiteId" class="instance-select">
              <option v-for="site in cfg.sites" :key="site.id" :value="site.id">
                {{ site.username }} @ {{ site.domain }}
              </option>
              <option v-if="cfg.sites.length === 0" disabled value="">{{ t("options.instances.noInstances") }}</option>
            </select>
            <button class="btn btn-primary" @click="addSite">{{ t("options.instances.add") }}</button>
            <button class="btn btn-danger" @click="removeSelectedSite" :disabled="!selectedSite">{{ t("options.instances.remove") }}</button>
          </div>

          <template v-if="selectedSite">
            <div class="divider"></div>

            <div class="form-group">
              <label class="form-label">{{ t("options.instances.url") }}</label>
              <input type="text" placeholder="https://szuru.example.com" v-model="selectedSite.domain" />
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">{{ t("options.instances.username") }}</label>
                <input type="text" placeholder="username" v-model="selectedSite.username" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t("options.instances.authToken") }}</label>
                <input type="password" placeholder="token" v-model="selectedSite.authToken" />
              </div>
            </div>

            <div class="connection-test">
              <button class="btn btn-secondary" @click="testConnection">{{ t("options.instances.testConnection") }}</button>
              <span v-if="statusText" class="status-text" :class="`status-${statusType}`">{{ statusText }}</span>
            </div>
          </template>

          <div v-else class="empty-state">
            <span>{{ t("options.instances.emptyState").replace("{bold}", "").replace("{/bold}", "") }}</span>
          </div>
        </div>
      </div>

      <!-- Tags Tab -->
      <div v-if="activeTab === 'tags'" class="tab-content">
        <h2 class="tab-title">{{ t("options.tags.title") }}</h2>

        <div class="card">
          <h3 class="card-title">{{ t("options.tags.colorMapping") }}</h3>
          <p class="card-hint">{{ t("options.tags.colorMappingHint") }}</p>

          <div class="tag-table">
            <div class="tag-table-header">
              <span>{{ t("options.tags.categoryName") }}</span>
              <span>{{ t("options.tags.cssColor") }}</span>
              <span>{{ t("options.tags.preview") }}</span>
              <span></span>
            </div>
            <div v-for="(cat, index) in cfg.tagCategories" :key="index" class="tag-table-row">
              <input type="text" v-model="cat.name" placeholder="category name" />
              <div class="color-input-group">
                <input type="color" :value="cat.color" @input="cat.color = ($event.target as HTMLInputElement).value" class="color-picker" />
                <input type="text" v-model="cat.color" placeholder="#rrggbb" class="color-input" />
              </div>
              <div class="color-preview-row">
                <span class="color-chip" :style="{ background: cat.color }"></span>
                <span class="color-sample-text" :style="{ color: cat.color }">{{ cat.name || 'Tag' }}</span>
              </div>
              <button class="btn-icon btn-remove" @click="cfg.tagCategories.splice(index, 1)" title="Remove">✕</button>
            </div>
            <div v-if="cfg.tagCategories.length === 0" class="tag-table-empty">
              {{ t("options.tags.noCategories") }}
            </div>
          </div>

          <div class="card-actions">
            <button class="btn btn-primary" @click="addTagCategory">{{ t("options.tags.addCategory") }}</button>
            <button class="btn btn-secondary" @click="importTagCategoriesFromInstance">{{ t("options.tags.importFromInstance") }}</button>
            <button class="btn btn-danger ml-auto" @click="resetTagCategories">{{ t("options.tags.resetToDefault") }}</button>
          </div>
        </div>
      </div>

      <!-- Statistics Tab -->
      <div v-if="activeTab === 'stats'" class="tab-content">
        <h2 class="tab-title">{{ t("options.stats.title") }}</h2>

        <p v-if="!cfg.statsEnabled" class="card-hint stats-disabled">{{ t("options.stats.disabled") }}</p>

        <div class="card">
          <h3 class="card-title">{{ t("options.stats.overview") }}</h3>

          <div class="stat-grid">
            <div class="stat-tile">
              <span class="stat-value">{{ statsTotalImports }}</span>
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
              <span class="stat-value">{{ statsSuccessRate }}%</span>
              <span class="stat-label">{{ t("options.stats.successRate") }}</span>
            </div>
            <div class="stat-tile">
              <span class="stat-value">{{ statsTransferred }}</span>
              <span class="stat-label">{{ t("options.stats.transferred") }}</span>
            </div>
            <div class="stat-tile">
              <span class="stat-value">{{ statsAvgDuration }}</span>
              <span class="stat-label">{{ t("options.stats.avgDuration") }}</span>
            </div>
          </div>

          <div class="stat-footnote">{{ t("options.stats.lastImport") }}: {{ statsLastImport }}</div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.stats.activity") }}</h3>

          <div v-if="!statsHasActivity" class="uac-empty">{{ t("options.stats.activityEmpty") }}</div>
          <div v-else class="stat-chart">
            <div
              v-for="entry in statsSeries"
              :key="entry.day"
              class="stat-bar-slot"
              :title="`${shortDay(entry.day)} — ${entry.count}`"
            >
              <div
                class="stat-bar"
                :class="{ empty: entry.count === 0 }"
                :style="{ height: `${Math.max((entry.count / statsSeriesMax) * 100, entry.count > 0 ? 6 : 2)}%` }"
              ></div>
            </div>
          </div>
        </div>

        <div class="card" v-if="statsTopHosts.length > 0">
          <h3 class="card-title">{{ t("options.stats.topHosts") }}</h3>

          <div class="host-table">
            <div class="host-table-header">
              <span>{{ t("options.stats.host") }}</span>
              <span>{{ t("options.stats.colOk") }}</span>
              <span>{{ t("options.stats.colDupe") }}</span>
              <span>{{ t("options.stats.colFail") }}</span>
            </div>
            <div v-for="host in statsTopHosts" :key="host.host" class="host-table-row">
              <span class="host-name">{{ host.host }}</span>
              <span>{{ host.success }}</span>
              <span>{{ host.duplicate }}</span>
              <span :class="{ bad: host.error > 0 }">{{ host.error }}</span>
            </div>
          </div>
        </div>

        <div class="card" v-if="statsBySite.length > 1">
          <h3 class="card-title">{{ t("options.stats.byInstance") }}</h3>

          <div class="host-table">
            <div class="host-table-header">
              <span>{{ t("options.stats.instance") }}</span>
              <span>{{ t("options.stats.colOk") }}</span>
              <span>{{ t("options.stats.colDupe") }}</span>
              <span>{{ t("options.stats.colFail") }}</span>
            </div>
            <div v-for="site in statsBySite" :key="site.siteId" class="host-table-row">
              <span class="host-name">{{ site.label }}</span>
              <span>{{ site.success }}</span>
              <span>{{ site.duplicate }}</span>
              <span :class="{ bad: site.error > 0 }">{{ site.error }}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.stats.failures") }}</h3>
          <p class="card-hint">{{ t("options.stats.failuresHint") }}</p>

          <div v-if="statsFailures.length === 0" class="uac-empty">{{ t("options.stats.noFailures") }}</div>

          <div v-for="failure in statsFailures" :key="failure.id" class="failure-row">
            <div class="failure-info">
              <span class="failure-message">{{ failure.message }}</span>
              <a
                v-if="failure.pageUrl"
                class="failure-url"
                :href="failure.pageUrl"
                target="_blank"
                rel="noopener"
              >{{ failure.pageUrl }}</a>
              <span class="failure-meta">
                {{ new Date(failure.at).toLocaleString() }} · {{ t("options.stats.attempts", { count: failure.attempts }) }}
              </span>
            </div>
            <div class="failure-actions">
              <button
                class="btn btn-secondary"
                :disabled="!failure.scrapeResults"
                @click="retryFailure(failure.id)"
              >{{ t("options.stats.retry") }}</button>
              <button class="btn-icon btn-remove" @click="dismissFailure(failure.id)" :title="t('options.stats.dismiss')">✕</button>
            </div>
          </div>

          <div class="card-actions" v-if="statsFailures.length > 0">
            <button class="btn btn-secondary" @click="dismissAllFailures">{{ t("options.stats.clearFailures") }}</button>
          </div>
        </div>

        <div class="card-actions">
          <span v-if="statsMessage" class="status-text" :class="`status-${statsMessageType}`">{{ statsMessage }}</span>
          <button class="btn btn-danger ml-auto" @click="doResetStats">{{ t("options.stats.reset") }}</button>
        </div>
      </div>

      <!-- Changelog Tab -->
      <div v-if="activeTab === 'changelog'" class="tab-content">
        <h2 class="tab-title">{{ t("changelog.title") }}</h2>

        <div class="card changelog-card">
          <div class="changelog-entry">
            <div class="changelog-version">v3.0.2</div>
            <div class="changelog-date">{{ t("changelog.v302.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v302.ctrlHover") }}</strong> — {{ t("changelog.v302.ctrlHoverDesc") }}</li>
            </ul>
          </div>
          <div class="changelog-entry">
            <div class="changelog-version">v3.0.1</div>
            <div class="changelog-date">{{ t("changelog.v301.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v301.listingFlow") }}</strong> — {{ t("changelog.v301.listingFlowDesc") }}</li>
              <li><strong>{{ t("changelog.v301.liveState") }}</strong> — {{ t("changelog.v301.liveStateDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v3.0.0</div>
            <div class="changelog-date">{{ t("changelog.v300.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v300.hoverActions") }}</strong> — {{ t("changelog.v300.hoverActionsDesc") }}</li>
              <li><strong>{{ t("changelog.v300.rangeSelect") }}</strong> — {{ t("changelog.v300.rangeSelectDesc") }}</li>
              <li><strong>{{ t("changelog.v300.endlessScroll") }}</strong> — {{ t("changelog.v300.endlessScrollDesc") }}</li>
              <li><strong>{{ t("changelog.v300.hoverZoom") }}</strong> — {{ t("changelog.v300.hoverZoomDesc") }}</li>
              <li><strong>{{ t("changelog.v300.hoverButtonsFix") }}</strong> — {{ t("changelog.v300.hoverButtonsFixDesc") }}</li>
              <li><strong>{{ t("changelog.v300.lazyExtras") }}</strong> — {{ t("changelog.v300.lazyExtrasDesc") }}</li>
              <li><strong>{{ t("changelog.v300.dockRedesign") }}</strong> — {{ t("changelog.v300.dockRedesignDesc") }}</li>
              <li><strong>{{ t("changelog.v300.stopLabel") }}</strong> — {{ t("changelog.v300.stopLabelDesc") }}</li>
              <li><strong>{{ t("changelog.v300.batchDurable") }}</strong> — {{ t("changelog.v300.batchDurableDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.9.0</div>
            <div class="changelog-date">{{ t("changelog.v290.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v290.parallelBatches") }}</strong> — {{ t("changelog.v290.parallelBatchesDesc") }}</li>
              <li><strong>{{ t("changelog.v290.oneQueue") }}</strong> — {{ t("changelog.v290.oneQueueDesc") }}</li>
              <li><strong>{{ t("changelog.v290.selectionAcrossPages") }}</strong> — {{ t("changelog.v290.selectionAcrossPagesDesc") }}</li>
              <li><strong>{{ t("changelog.v290.thumbMarks") }}</strong> — {{ t("changelog.v290.thumbMarksDesc") }}</li>
              <li><strong>{{ t("changelog.v290.batchSkip") }}</strong> — {{ t("changelog.v290.batchSkipDesc") }}</li>
              <li><strong>{{ t("changelog.v290.batchWindow") }}</strong> — {{ t("changelog.v290.batchWindowDesc") }}</li>
              <li><strong>{{ t("changelog.v290.duplicateQuality") }}</strong> — {{ t("changelog.v290.duplicateQualityDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.8.0</div>
            <div class="changelog-date">{{ t("changelog.v280.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v280.selectAll") }}</strong> — {{ t("changelog.v280.selectAllDesc") }}</li>
              <li><strong>{{ t("changelog.v280.allPages") }}</strong> — {{ t("changelog.v280.allPagesDesc") }}</li>
              <li><strong>{{ t("changelog.v280.userImport") }}</strong> — {{ t("changelog.v280.userImportDesc") }}</li>
              <li><strong>{{ t("changelog.v280.crawlLimits") }}</strong> — {{ t("changelog.v280.crawlLimitsDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.7.0</div>
            <div class="changelog-date">{{ t("changelog.v270.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v270.batch") }}</strong> — {{ t("changelog.v270.batchDesc") }}</li>
              <li><strong>{{ t("changelog.v270.pool") }}</strong> — {{ t("changelog.v270.poolDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.6.0</div>
            <div class="changelog-date">{{ t("changelog.v260.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v260.backup") }}</strong> — {{ t("changelog.v260.backupDesc") }}</li>
              <li><strong>{{ t("changelog.v260.tagSuggestions") }}</strong> — {{ t("changelog.v260.tagSuggestionsDesc") }}</li>
              <li><strong>{{ t("changelog.v260.instanceStats") }}</strong> — {{ t("changelog.v260.instanceStatsDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.5.0</div>
            <div class="changelog-date">{{ t("changelog.v250.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v250.tagRules") }}</strong> — {{ t("changelog.v250.tagRulesDesc") }}</li>
              <li><strong>{{ t("changelog.v250.importedBadge") }}</strong> — {{ t("changelog.v250.importedBadgeDesc") }}</li>
              <li><strong>{{ t("changelog.v250.retry") }}</strong> — {{ t("changelog.v250.retryDesc") }}</li>
              <li><strong>{{ t("changelog.v250.durableQueue") }}</strong> — {{ t("changelog.v250.durableQueueDesc") }}</li>
              <li><strong>{{ t("changelog.v250.stats") }}</strong> — {{ t("changelog.v250.statsDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.4.0</div>
            <div class="changelog-date">{{ t("changelog.v240.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v240.queue") }}</strong> — {{ t("changelog.v240.queueDesc") }}</li>
              <li><strong>{{ t("changelog.v240.linkChain") }}</strong> — {{ t("changelog.v240.linkChainDesc") }}</li>
              <li><strong>{{ t("changelog.v240.uploadAsContentSites") }}</strong> — {{ t("changelog.v240.uploadAsContentSitesDesc") }}</li>
              <li><strong>{{ t("changelog.v240.compactToast") }}</strong> — {{ t("changelog.v240.compactToastDesc") }}</li>
              <li><strong>{{ t("changelog.v240.dedupToast") }}</strong> — {{ t("changelog.v240.dedupToastDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.3.0</div>
            <div class="changelog-date">{{ t("changelog.v230.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v230.hotfixFormData") }}</strong> — {{ t("changelog.v230.hotfixFormDataDesc") }}</li>
              <li><strong>{{ t("changelog.v230.multiStrategyFetch") }}</strong> — {{ t("changelog.v230.multiStrategyFetchDesc") }}</li>
              <li><strong>{{ t("changelog.v230.declarativeNetRequest") }}</strong> — {{ t("changelog.v230.declarativeNetRequestDesc") }}</li>
              <li><strong>{{ t("changelog.v230.webRequestReferer") }}</strong> — {{ t("changelog.v230.webRequestRefererDesc") }}</li>
              <li><strong>{{ t("changelog.v230.toastRestore") }}</strong> — {{ t("changelog.v230.toastRestoreDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.2.0</div>
            <div class="changelog-date">{{ t("changelog.v220.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v220.autoRelationsToggle") }}</strong> — {{ t("changelog.v220.autoRelationsToggleDesc") }}</li>
              <li><strong>{{ t("changelog.v220.serverPill") }}</strong> — {{ t("changelog.v220.serverPillDesc") }}</li>
              <li><strong>{{ t("changelog.v220.formatChips") }}</strong> — {{ t("changelog.v220.formatChipsDesc") }}</li>
              <li><strong>{{ t("changelog.v220.popupCustomization") }}</strong> — {{ t("changelog.v220.popupCustomizationDesc") }}</li>
              <li><strong>{{ t("changelog.v220.thresholdDefault") }}</strong> — {{ t("changelog.v220.thresholdDefaultDesc") }}</li>
              <li><strong>{{ t("changelog.v220.fallbackTags") }}</strong> — {{ t("changelog.v220.fallbackTagsDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.1.1</div>
            <div class="changelog-date">{{ t("changelog.v211.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v211.slider") }}</strong> — {{ t("changelog.v211.sliderDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.1.0</div>
            <div class="changelog-date">{{ t("changelog.v210.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v210.autoRelations") }}</strong> — {{ t("changelog.v210.autoRelationsDesc") }}</li>
              <li><strong>{{ t("changelog.v210.linkLastHotkey") }}</strong> — {{ t("changelog.v210.linkLastHotkeyDesc") }}</li>
              <li><strong>{{ t("changelog.v210.liquidUi") }}</strong> — {{ t("changelog.v210.liquidUiDesc") }}</li>
              <li><strong>{{ t("changelog.v210.fixAutoRelations") }}</strong> — {{ t("changelog.v210.fixAutoRelationsDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.0.1</div>
            <div class="changelog-date">{{ t("changelog.v201.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v201.multiLang") }}</strong> — {{ t("changelog.v201.multiLangDesc") }}</li>
              <li><strong>{{ t("changelog.v201.colorPicker") }}</strong> — {{ t("changelog.v201.colorPickerDesc") }}</li>
              <li><strong>{{ t("changelog.v201.alreadyUploaded") }}</strong> — {{ t("changelog.v201.alreadyUploadedDesc") }}</li>
              <li><strong>{{ t("changelog.v201.objectObject") }}</strong> — {{ t("changelog.v201.objectObjectDesc") }}</li>
              <li><strong>{{ t("changelog.v201.emptyTag") }}</strong> — {{ t("changelog.v201.emptyTagDesc") }}</li>
              <li><strong>{{ t("changelog.v201.forkLink") }}</strong> — {{ t("changelog.v201.forkLinkDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v2.0.0</div>
            <div class="changelog-date">{{ t("changelog.v200.date") }}</div>
            <ul class="changelog-list">
              <li><strong>{{ t("changelog.v200.contextMenu") }}</strong> — {{ t("changelog.v200.contextMenuDesc") }}</li>
              <li><strong>{{ t("changelog.v200.hotkey") }}</strong> — {{ t("changelog.v200.hotkeyDesc") }}</li>
              <li><strong>{{ t("changelog.v200.progress") }}</strong> — {{ t("changelog.v200.progressDesc") }}</li>
              <li><strong>{{ t("changelog.v200.toasts") }}</strong> — {{ t("changelog.v200.toastsDesc") }}</li>
              <li><strong>{{ t("changelog.v200.fix403") }}</strong> — {{ t("changelog.v200.fix403Desc") }}</li>
              <li><strong>{{ t("changelog.v200.fixOctet") }}</strong> — {{ t("changelog.v200.fixOctetDesc") }}</li>
              <li><strong>{{ t("changelog.v200.fixPreview") }}</strong> — {{ t("changelog.v200.fixPreviewDesc") }}</li>
              <li><strong>{{ t("changelog.v200.options") }}</strong> — {{ t("changelog.v200.optionsDesc") }}</li>
              <li><strong>{{ t("changelog.v200.mime") }}</strong> — {{ t("changelog.v200.mimeDesc") }}</li>
              <li><strong>{{ t("changelog.v200.filename") }}</strong> — {{ t("changelog.v200.filenameDesc") }}</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v1.1.24</div>
            <div class="changelog-date">{{ t("changelog.v1124.date") }}</div>
            <ul class="changelog-list">
              <li>{{ t("changelog.v1124.initial") }}</li>
              <li>{{ t("changelog.v1124.autocomplete") }}</li>
              <li>{{ t("changelog.v1124.pools") }}</li>
              <li>{{ t("changelog.v1124.similar") }}</li>
              <li>{{ t("changelog.v1124.merge") }}</li>
              <li>{{ t("changelog.v1124.multiInstance") }}</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style lang="scss">
/* ══════════════════════════════════════════════════════════
   LIQUID UI – SzuruChrome Options
   Frosted glass, fluid motion, depth & translucency
   ══════════════════════════════════════════════════════════ */

/* ── Liquid tokens ─────────────────────────────────────── */
:root {
  --lq-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --lq-mono: "SF Mono", "Cascadia Code", "Fira Code", "Consolas", monospace;

  /* surfaces */
  --lq-bg: #f2f3f7;
  --lq-bg-gradient: linear-gradient(135deg, #e8eaf6 0%, #f5f0fa 50%, #e3f2fd 100%);
  --lq-surface: rgba(255, 255, 255, 0.72);
  --lq-surface-hover: rgba(255, 255, 255, 0.88);
  --lq-surface-border: rgba(0, 0, 0, 0.06);
  --lq-surface-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 4px 24px rgba(0, 0, 0, 0.06);
  --lq-blur: 24px;

  /* text */
  --lq-text: #1a1a2e;
  --lq-text-secondary: rgba(26, 26, 46, 0.52);
  --lq-text-tertiary: rgba(26, 26, 46, 0.36);

  /* accent */
  --lq-accent: #6366f1;
  --lq-accent-soft: rgba(99, 102, 241, 0.12);
  --lq-accent-glow: rgba(99, 102, 241, 0.25);

  /* semantic */
  --lq-success: #10b981;
  --lq-danger: #ef4444;
  --lq-warning: #f59e0b;

  /* controls */
  --lq-input-bg: rgba(0, 0, 0, 0.03);
  --lq-input-border: rgba(0, 0, 0, 0.1);
  --lq-input-focus: var(--lq-accent);
  --lq-toggle-off: rgba(0, 0, 0, 0.16);
  --lq-toggle-on: var(--lq-accent);

  --lq-radius: 14px;
  --lq-radius-sm: 10px;
  --lq-radius-xs: 6px;
  --lq-transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

html.dark {
  --lq-bg: #0c0c14;
  --lq-bg-gradient: linear-gradient(135deg, #0f0f1e 0%, #150d20 50%, #0d1117 100%);
  --lq-surface: rgba(255, 255, 255, 0.05);
  --lq-surface-hover: rgba(255, 255, 255, 0.09);
  --lq-surface-border: rgba(255, 255, 255, 0.07);
  --lq-surface-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), 0 4px 24px rgba(0, 0, 0, 0.3);

  --lq-text: rgba(255, 255, 255, 0.92);
  --lq-text-secondary: rgba(255, 255, 255, 0.48);
  --lq-text-tertiary: rgba(255, 255, 255, 0.28);

  --lq-accent: #818cf8;
  --lq-accent-soft: rgba(129, 140, 248, 0.12);
  --lq-accent-glow: rgba(129, 140, 248, 0.2);

  --lq-input-bg: rgba(255, 255, 255, 0.04);
  --lq-input-border: rgba(255, 255, 255, 0.08);
  --lq-toggle-off: rgba(255, 255, 255, 0.14);
}

/* ── Layout ────────────────────────────────────────────── */
.page {
  display: flex;
  min-height: 100vh;
  background: var(--lq-bg);
  background-image: var(--lq-bg-gradient);
  background-attachment: fixed;
  color: var(--lq-text);
  font-family: var(--lq-font);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ── Sidebar ───────────────────────────────────────────── */
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--lq-surface);
  backdrop-filter: blur(var(--lq-blur)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--lq-blur)) saturate(140%);
  border-right: 1px solid var(--lq-surface-border);
  display: flex;
  flex-direction: column;
  padding: 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.sidebar-brand {
  padding: 24px 20px 20px;
  border-bottom: 1px solid var(--lq-surface-border);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.brand-name {
  font-weight: 750;
  font-size: 16px;
  letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--lq-accent), #a78bfa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.brand-version {
  font-size: 11px;
  font-weight: 500;
  color: var(--lq-text-secondary);
  font-family: var(--lq-mono);
}

.brand-fork {
  font-size: 10px;
  color: var(--lq-text-tertiary);
  font-style: italic;
  text-decoration: none;
  transition: color var(--lq-transition);

  &:hover { color: var(--lq-text-secondary); }
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  padding: 12px 10px;
  gap: 2px;
}

.nav-item {
  display: block;
  width: 100%;
  padding: 10px 14px;
  background: transparent;
  border: none;
  border-radius: var(--lq-radius-sm);
  color: var(--lq-text-secondary);
  text-align: left;
  font-family: var(--lq-font);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  height: auto;
  white-space: nowrap;
  transition: all var(--lq-transition);
  position: relative;

  &:hover {
    background: var(--lq-accent-soft);
    color: var(--lq-text);
  }

  &.active {
    background: var(--lq-accent);
    color: #fff;
    font-weight: 600;
    box-shadow: 0 2px 12px var(--lq-accent-glow);
  }
}

/* ── Main content ──────────────────────────────────────── */
.content {
  flex: 1;
  padding: 36px 40px;
  max-width: 800px;
  min-width: 0;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: lq-fade-in 0.3s ease-out;
}

@keyframes lq-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

.tab-title {
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.03em;
  margin: 0 0 4px;
  color: var(--lq-text);
}

/* ── Card (glass panel) ───────────────────────────────── */
.card {
  background: var(--lq-surface);
  backdrop-filter: blur(var(--lq-blur)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--lq-blur)) saturate(140%);
  border: 1px solid var(--lq-surface-border);
  border-radius: var(--lq-radius);
  padding: 24px;
  box-shadow: var(--lq-surface-shadow);
  display: flex;
  flex-direction: column;
  gap: 0;
  transition: box-shadow var(--lq-transition);
}

.card-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
  margin: 0 0 18px;
}

.card-hint {
  font-size: 12px;
  color: var(--lq-text-secondary);
  margin: -12px 0 16px;
  line-height: 1.5;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
  align-items: center;
}

.divider {
  border: none;
  border-top: 1px solid var(--lq-surface-border);
  margin: 18px 0;
}

/* ── Option rows ──────────────────────────────────────── */
.option-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--lq-surface-border);
  transition: background var(--lq-transition);

  &:first-of-type { padding-top: 0; }
  &:last-of-type  { border-bottom: none; padding-bottom: 0; }
}

.option-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.option-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--lq-text);
  display: flex;
  align-items: center;
  gap: 5px;
}

.warn-tooltip {
  display: inline-flex;
  align-items: center;
  cursor: help;
  opacity: 0.85;
  transition: opacity 150ms;
  &:hover { opacity: 1; }
}

.option-hint {
  font-size: 12px;
  color: var(--lq-text-secondary);
  line-height: 1.45;
}

/* ── Toggle switch (liquid pill) ──────────────────────── */
.toggle {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
  margin-top: 2px;

  input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    margin: 0;
  }
}

.toggle-track {
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 24px;
  background: var(--lq-toggle-off);
  border-radius: 999px;
  padding: 2px;
  transition: background 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;

  .toggle input:checked ~ & {
    background: var(--lq-toggle-on);
    box-shadow: 0 0 12px var(--lq-accent-glow);
  }
}

.toggle-thumb {
  width: 20px;
  height: 20px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);

  .toggle input:checked ~ .toggle-track & {
    transform: translateX(16px);
  }
}

/* ── Select / Input overrides ─────────────────────────── */
.select-wrapper select,
.page select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--lq-input-bg);
  border: 1px solid var(--lq-input-border);
  border-radius: var(--lq-radius-xs);
  color: var(--lq-text);
  font-family: var(--lq-font);
  font-size: 13px;
  padding: 0 32px 0 10px;
  height: 34px;
  cursor: pointer;
  transition: border-color var(--lq-transition), box-shadow var(--lq-transition);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%236366f1' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;

  &:focus {
    outline: none;
    border-color: var(--lq-input-focus);
    box-shadow: 0 0 0 3px var(--lq-accent-soft);
  }
}

.select-wrapper select {
  width: auto;
  min-width: 150px;
}

.select-wrapper select option,
.page select option {
  background: #1a1a2e;
  color: #e8e8f0;
}

html:not(.dark) .select-wrapper select option,
html:not(.dark) .page select option {
  background: #ffffff;
  color: #1a1a2e;
}

.page input[type="text"],
.page input[type="password"],
.page input[type="email"],
.page input[type="number"] {
  background: var(--lq-input-bg);
  border: 1px solid var(--lq-input-border);
  border-radius: var(--lq-radius-xs);
  color: var(--lq-text);
  font-family: var(--lq-font);
  font-size: 13px;
  padding: 0 10px;
  height: 34px;
  width: 100%;
  transition: border-color var(--lq-transition), box-shadow var(--lq-transition);

  &::placeholder { color: var(--lq-text-tertiary); }
  &:focus {
    outline: none;
    border-color: var(--lq-input-focus);
    box-shadow: 0 0 0 3px var(--lq-accent-soft);
  }
}

/* ── Instance form ─────────────────────────────────────── */
.instance-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.instance-select {
  flex: 1;
  min-width: 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.form-row {
  display: flex;
  gap: 16px;
  margin-top: 14px;
}

.form-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--lq-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.connection-test {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.status-text {
  font-size: 13px;
  flex: 1;
  font-weight: 500;
}

.status-success { color: var(--lq-success); }
.status-error   { color: var(--lq-danger); }
.status-quiet   { color: var(--lq-text-secondary); }

.empty-state {
  padding: 20px 0 4px;
  color: var(--lq-text-secondary);
  font-size: 13px;
}

/* ── Tag category table ────────────────────────────────── */
.tag-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tag-table-header {
  display: grid;
  grid-template-columns: 1fr 1fr 80px 32px;
  gap: 8px;
  padding: 0 2px 8px;
  border-bottom: 1px solid var(--lq-surface-border);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
}

.tag-table-row {
  display: grid;
  grid-template-columns: 1fr 1fr 80px 32px;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  border-radius: var(--lq-radius-xs);
  transition: background var(--lq-transition);

  &:hover { background: var(--lq-accent-soft); }
}

.tag-table-empty {
  padding: 16px 0;
  color: var(--lq-text-secondary);
  font-size: 13px;
}

/* ── Tag blacklist / rename rules ──────────────────────── */
.sub-title {
  margin: 22px 0 4px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
}

.rule-syntax {
  margin: 4px 0 0;
  padding: 9px 12px;
  border-radius: var(--lq-radius-sm);
  background: var(--lq-input-bg);
  color: var(--lq-text-secondary);
  font-family: var(--lq-mono);
  font-size: 11px;
  line-height: 1.6;
}

.rule-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-table-header,
.rule-table-row {
  display: grid;
  grid-template-columns: 1fr 1fr 32px;
  gap: 8px;
  align-items: center;
}

.rule-table-header {
  padding: 0 2px 8px;
  border-bottom: 1px solid var(--lq-surface-border);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
}

.rule-table-row {
  padding: 4px 0;
  border-radius: var(--lq-radius-xs);
  transition: background var(--lq-transition);

  &:hover { background: var(--lq-accent-soft); }

  input { font-family: var(--lq-mono); font-size: 12px; }
}

.rule-tester-input {
  width: 100%;
  margin-top: 4px;
  padding: 9px 12px;
  border: 1px solid var(--lq-input-border);
  border-radius: var(--lq-radius-sm);
  background: var(--lq-input-bg);
  color: var(--lq-text);
  font-family: var(--lq-mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;

  &:focus {
    outline: none;
    border-color: var(--lq-input-focus);
  }
}

.rule-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
}

.rule-preview-row {
  display: grid;
  grid-template-columns: 1fr 18px 1fr;
  gap: 6px;
  align-items: center;
  padding: 5px 10px;
  border-radius: var(--lq-radius-xs);
  background: var(--lq-input-bg);
  font-family: var(--lq-mono);
  font-size: 12px;

  &.dropped .rule-preview-in { text-decoration: line-through; opacity: 0.55; }
  &.changed { background: var(--lq-accent-soft); }
}

.rule-preview-arrow { color: var(--lq-text-tertiary); text-align: center; }
.rule-preview-in,
.rule-preview-out { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rule-preview-out.muted { color: var(--lq-text-tertiary); font-style: italic; }

/* ── Configuration backup ──────────────────────────────── */
.backup-actions { flex-wrap: wrap; }
.hidden-file-input { display: none; }

/* ── Statistics ────────────────────────────────────────── */
.stats-disabled {
  margin: -8px 0 16px;
  color: var(--lq-warning);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.stat-tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 14px 16px;
  border: 1px solid var(--lq-surface-border);
  border-radius: var(--lq-radius-sm);
  background: var(--lq-input-bg);
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--lq-text);

  &.bad { color: var(--lq-danger); }
}

.stat-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--lq-text-secondary);
}

.stat-footnote {
  margin-top: 14px;
  color: var(--lq-text-tertiary);
  font-size: 11px;
}

.stat-chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 120px;
  padding-top: 6px;
}

.stat-bar-slot {
  display: flex;
  flex: 1;
  align-items: flex-end;
  height: 100%;
  min-width: 0;
}

.stat-bar {
  width: 100%;
  border-radius: 3px 3px 1px 1px;
  background: linear-gradient(180deg, var(--lq-accent), var(--lq-accent-glow));
  transition: height var(--lq-transition);

  &.empty { background: var(--lq-input-border); }
}

.host-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.host-table-header,
.host-table-row {
  display: grid;
  grid-template-columns: 1fr 60px 60px 60px;
  gap: 8px;
  align-items: center;
}

.host-table-header {
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--lq-surface-border);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
}

.host-table-row {
  padding: 7px 8px;
  border-radius: var(--lq-radius-xs);
  font-size: 13px;
  transition: background var(--lq-transition);

  &:hover { background: var(--lq-accent-soft); }

  .bad { color: var(--lq-danger); }
}

.host-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--lq-mono);
  font-size: 12px;
}

.failure-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid var(--lq-surface-border);

  &:last-of-type { border-bottom: 0; }
}

.failure-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.failure-message {
  color: var(--lq-danger);
  font-size: 13px;
  font-weight: 600;
}

.failure-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lq-text-secondary);
  font-family: var(--lq-mono);
  font-size: 11px;
}

.failure-meta {
  color: var(--lq-text-tertiary);
  font-size: 11px;
}

.failure-actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  align-items: center;
}

.color-input {
  font-family: var(--lq-mono);
  font-size: 12px;
  flex: 1;
  min-width: 0;
}

.color-input-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color-picker {
  width: 32px;
  height: 32px;
  padding: 2px;
  border: 1px solid var(--lq-input-border);
  border-radius: var(--lq-radius-xs);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color var(--lq-transition);

  &:hover { border-color: var(--lq-accent); }
  &::-webkit-color-swatch-wrapper { padding: 2px; }
  &::-webkit-color-swatch { border: none; border-radius: 4px; }
  &::-moz-color-swatch { border: none; border-radius: 4px; }
}

.color-preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-chip {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid var(--lq-surface-border);
  flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}

.color-sample-text {
  font-size: 13px;
  font-weight: 600;
}

/* ── Buttons ───────────────────────────────────────────── */
.btn {
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: var(--lq-radius-xs);
  font-family: var(--lq-font);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--lq-transition);
  position: relative;
  overflow: hidden;

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
  }

  &:not(:disabled):hover {
    transform: translateY(-1px);
  }

  &:not(:disabled):active {
    transform: translateY(0);
  }
}

.btn-primary {
  background: linear-gradient(135deg, var(--lq-accent), #8b5cf6);
  color: #fff;
  box-shadow: 0 2px 8px var(--lq-accent-glow);

  &:not(:disabled):hover {
    box-shadow: 0 4px 16px var(--lq-accent-glow);
  }
}

.btn-secondary {
  background: var(--lq-input-bg);
  border: 1px solid var(--lq-input-border);
  color: var(--lq-text);

  &:not(:disabled):hover {
    background: var(--lq-surface-hover);
    border-color: var(--lq-accent);
  }
}

.btn-danger {
  background: var(--lq-danger);
  color: #fff;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.2);

  &:not(:disabled):hover {
    box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
  }
}

.btn-icon {
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--lq-radius-xs);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--lq-text-tertiary);
  transition: all var(--lq-transition);

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    color: var(--lq-danger);
  }
}

.ml-auto { margin-left: auto; }

/* ── Hotkey recorder ───────────────────────────────────── */
.slider-group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* Numeric limit next to an option label — narrow, so the hint keeps its room. */
.page input[type="number"].limit-input {
  width: 96px;
  flex-shrink: 0;
  text-align: right;
}

.lq-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 160px;
  height: 6px;
  border-radius: 999px;
  background: var(--lq-input-border);
  outline: none;
  cursor: pointer;
  transition: background var(--lq-transition);

  &::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--lq-accent), #8b5cf6);
    box-shadow: 0 2px 8px var(--lq-accent-glow);
    cursor: pointer;
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
                box-shadow var(--lq-transition);

    &:hover {
      transform: scale(1.15);
      box-shadow: 0 3px 12px var(--lq-accent-glow);
    }
  }

  &::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--lq-accent), #8b5cf6);
    box-shadow: 0 2px 8px var(--lq-accent-glow);
    cursor: pointer;
  }

  &::-moz-range-track {
    height: 6px;
    border-radius: 999px;
    background: var(--lq-input-border);
  }
}

.slider-value {
  font-family: var(--lq-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--lq-accent);
  min-width: 40px;
  text-align: right;
}

.source-access-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 6px 16px;
}

.source-access-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 7px 0;
  color: var(--lq-text-secondary);
  font-size: 13px;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  input {
    flex: 0 0 auto;
    accent-color: var(--lq-accent);
  }
}

/* ── Upload-as-Content sites ──────────────────────────── */
.uac-active {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px;
  border: 1.5px dashed var(--lq-input-border);
  border-radius: var(--lq-radius-sm);
  background: var(--lq-input-bg);
  min-height: 56px;
  transition: border-color var(--lq-transition), background var(--lq-transition);

  &.drag-hover {
    border-color: var(--lq-accent);
    background: var(--lq-accent-soft);
  }
}

.uac-empty {
  font-size: 12px;
  color: var(--lq-text-tertiary);
  font-style: italic;
  align-self: center;
  padding: 4px 2px;
}

.uac-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 4px 10px;
  background: var(--lq-surface);
  border: 1px solid var(--lq-surface-border);
  border-radius: 999px;
  font-size: 12px;
  font-family: var(--lq-mono);
  font-weight: 600;
  color: var(--lq-text);
  transition: all var(--lq-transition);
}

.uac-chip-drag {
  cursor: grab;
  user-select: none;
  background: var(--lq-input-bg);

  &:hover {
    border-color: var(--lq-accent);
    background: var(--lq-accent-soft);
    transform: translateY(-1px);
  }

  &:active { cursor: grabbing; }
}

.uac-host { letter-spacing: -0.02em; }

.uac-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: linear-gradient(135deg, var(--lq-accent), #8b5cf6);
  color: #fff;
  padding: 2px 6px;
  border-radius: 999px;
}

.uac-remove {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--lq-text-tertiary);
  border-radius: 50%;
  cursor: pointer;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--lq-transition);

  &:hover {
    background: rgba(239, 68, 68, 0.15);
    color: var(--lq-danger);
  }
}

.uac-add-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;

  input[type="text"] { flex: 1; }
}

.uac-suggested-label {
  margin-top: 18px;
  margin-bottom: 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--lq-text-tertiary);
}

.uac-suggested {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ── Changelog ─────────────────────────────────────────── */
.changelog-card {
  gap: 0;
}

.changelog-entry {
  padding: 20px 0;
  border-bottom: 1px solid var(--lq-surface-border);

  &:first-child { padding-top: 0; }
  &:last-child  { border-bottom: none; padding-bottom: 0; }
}

.changelog-version {
  display: inline-block;
  font-size: 13px;
  font-weight: 700;
  font-family: var(--lq-mono);
  color: var(--lq-accent);
  background: var(--lq-accent-soft);
  padding: 2px 10px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}

.changelog-date {
  font-size: 12px;
  color: var(--lq-text-tertiary);
  margin: 8px 0 12px;
}

.changelog-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  li {
    font-size: 13px;
    line-height: 1.55;
    color: var(--lq-text);

    strong { color: var(--lq-text); font-weight: 650; }
  }
}

/* ── Responsive ────────────────────────────────────────── */
@media (max-width: 640px) {
  .page { flex-direction: column; }

  .sidebar {
    width: 100%;
    position: relative;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--lq-surface-border);
  }

  .sidebar-nav {
    flex-direction: row;
    padding: 6px 8px;
    overflow-x: auto;
    gap: 4px;
  }

  .nav-item { padding: 8px 14px; font-size: 12px; }

  .content { padding: 20px 16px; }

  .form-row { flex-direction: column; gap: 12px; }

  .tag-table-header,
  .tag-table-row { grid-template-columns: 1fr 1fr 56px 32px; }
}
</style>

<script setup lang="ts">
import { useColorMode } from "@vueuse/core";
import { cfg } from "~/stores";
import { getErrorMessage } from "~/utils";
import { SzuruSiteConfig, TagCategoryColor, getDefaultTagCategories } from "~/models";
import SzurubooruApi from "~/api";
import { useI18n, setLanguage, type Language, availableLanguages } from "~/i18n";

const { t } = useI18n();

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
const isRecordingHotkey = ref(false);
const isRecordingHotkeyLinkLast = ref(false);

const hotkeyDisplayText = computed(() => {
  const h = cfg.value.hotkey;
  if (!h.key) return t("options.general.hotkeyNotSet");
  const parts: string[] = [];
  if (h.modifiers.includes("ctrl")) parts.push("Ctrl");
  if (h.modifiers.includes("alt")) parts.push("Alt");
  if (h.modifiers.includes("shift")) parts.push("Shift");
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return parts.join(" + ");
});

function startRecordingHotkey() {
  isRecordingHotkey.value = true;
}

function onHotkeyKeydown(e: KeyboardEvent) {
  // Ignore pure modifier presses
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");

  cfg.value.hotkey.key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  cfg.value.hotkey.modifiers = mods;
  isRecordingHotkey.value = false;
}

function clearHotkey() {
  cfg.value.hotkey.key = "";
  cfg.value.hotkey.modifiers = [];
}

const hotkeyLinkLastDisplayText = computed(() => {
  const h = cfg.value.hotkeyLinkLast;
  if (!h.key) return t("options.general.hotkeyNotSet");
  const parts: string[] = [];
  if (h.modifiers.includes("ctrl")) parts.push("Ctrl");
  if (h.modifiers.includes("alt")) parts.push("Alt");
  if (h.modifiers.includes("shift")) parts.push("Shift");
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return parts.join(" + ");
});

function startRecordingHotkeyLinkLast() {
  isRecordingHotkeyLinkLast.value = true;
}

function onHotkeyLinkLastKeydown(e: KeyboardEvent) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");

  cfg.value.hotkeyLinkLast.key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  cfg.value.hotkeyLinkLast.modifiers = mods;
  isRecordingHotkeyLinkLast.value = false;
}

function clearHotkeyLinkLast() {
  cfg.value.hotkeyLinkLast.key = "";
  cfg.value.hotkeyLinkLast.modifiers = [];
}
</script>

<template>
  <div class="page">
    <div class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-name">{{ t("options.brand") }}</span>
        <span class="brand-version">v{{ versionInfo }}</span>
        <a class="brand-fork" href="https://github.com/derSumo/SzuruChrome-Reworked" target="_blank">{{ t("options.forkBy") }}</a>
      </div>

      <nav class="sidebar-nav">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="nav-item"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

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
          </template>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.general.hotkey") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.hotkeyEnable") }}</span>
              <span class="option-hint">{{ t("options.general.hotkeyEnableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.hotkey.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <template v-if="cfg.hotkey.enabled">
            <div class="option-row">
              <div class="option-info">
                <span class="option-label">{{ t("options.general.hotkeyShortcut") }}</span>
                <span class="option-hint">{{ t("options.general.hotkeyShortcutHint") }}</span>
              </div>
              <div class="hotkey-recorder">
                <button
                  class="btn hotkey-btn"
                  :class="{ recording: isRecordingHotkey }"
                  @click="startRecordingHotkey"
                  @keydown="isRecordingHotkey && onHotkeyKeydown($event)"
                >
                  {{ isRecordingHotkey ? t("options.general.hotkeyPressKeys") : hotkeyDisplayText }}
                </button>
                <button class="btn btn-secondary hotkey-clear" @click="clearHotkey" v-if="cfg.hotkey.key" title="Clear">✕</button>
              </div>
            </div>
          </template>
        </div>

        <div class="card">
          <h3 class="card-title">{{ t("options.general.hotkeyLinkLast") }}</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">{{ t("options.general.hotkeyLinkLastEnable") }}</span>
              <span class="option-hint">{{ t("options.general.hotkeyLinkLastEnableHint") }}</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.hotkeyLinkLast.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <template v-if="cfg.hotkeyLinkLast.enabled">
            <div class="option-row">
              <div class="option-info">
                <span class="option-label">{{ t("options.general.hotkeyShortcut") }}</span>
                <span class="option-hint">{{ t("options.general.hotkeyLinkLastShortcutHint") }}</span>
              </div>
              <div class="hotkey-recorder">
                <button
                  class="btn hotkey-btn"
                  :class="{ recording: isRecordingHotkeyLinkLast }"
                  @click="startRecordingHotkeyLinkLast"
                  @keydown="isRecordingHotkeyLinkLast && onHotkeyLinkLastKeydown($event)"
                >
                  {{ isRecordingHotkeyLinkLast ? t("options.general.hotkeyPressKeys") : hotkeyLinkLastDisplayText }}
                </button>
                <button
                  class="btn btn-secondary hotkey-clear"
                  @click="clearHotkeyLinkLast"
                  v-if="cfg.hotkeyLinkLast.key"
                  title="Clear"
                >✕</button>
              </div>
            </div>
          </template>
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

      <!-- Changelog Tab -->
      <div v-if="activeTab === 'changelog'" class="tab-content">
        <h2 class="tab-title">{{ t("changelog.title") }}</h2>

        <div class="card changelog-card">
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

.hotkey-recorder {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hotkey-btn {
  min-width: 130px;
  background: var(--lq-input-bg);
  border: 1px solid var(--lq-input-border);
  color: var(--lq-text);
  font-family: var(--lq-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-align: center;
  border-radius: var(--lq-radius-xs);

  &.recording {
    background: var(--lq-accent-soft);
    border-color: var(--lq-accent);
    color: var(--lq-accent);
    box-shadow: 0 0 0 3px var(--lq-accent-soft);
    animation: lq-hotkey-pulse 1.2s ease-in-out infinite;
  }
}

@keyframes lq-hotkey-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.hotkey-clear {
  width: 34px;
  height: 34px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  background: transparent;
  border: 1px solid var(--lq-input-border);
  color: var(--lq-text-tertiary);
  border-radius: var(--lq-radius-xs);
  cursor: pointer;
  transition: all var(--lq-transition);

  &:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: var(--lq-danger);
    color: var(--lq-danger);
  }
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

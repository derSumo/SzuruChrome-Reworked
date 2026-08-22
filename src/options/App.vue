<script setup lang="ts">
// Shell only: sidebar, tab dispatch, search, deep links, and the two globals
// that must survive a tab switch (language sync and the colour mode that
// writes `html.dark`). Everything else lives in `./components/tabs/*` and
// `./composables/*`.

import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useColorMode } from "@vueuse/core";
import { cfg } from "~/stores";
import { setLanguage, type Language } from "~/i18n";
import { useI18n } from "~/i18n/vue";
import type { ColorModeValue } from "./colorMode";
import type { OptionsIconName } from "./icons";
import { HIGHLIGHT_KEY } from "./keys";
import { SETTINGS_INDEX, type OptionsTabId } from "./settingsIndex";
import { useSettingsSearch } from "./composables/useSettingsSearch";
import OptionsSidebar from "./components/OptionsSidebar.vue";
import ImportTab from "./components/tabs/ImportTab.vue";
import TagsTab from "./components/tabs/TagsTab.vue";
import OnPageTab from "./components/tabs/OnPageTab.vue";
import ConnectionsTab from "./components/tabs/ConnectionsTab.vue";
import AppearanceTab from "./components/tabs/AppearanceTab.vue";
import DataTab from "./components/tabs/DataTab.vue";
import AboutTab from "./components/tabs/AboutTab.vue";

const { t } = useI18n();

const versionInfo = import.meta.env.VITE_SZ_VERSION ?? browser.runtime.getManifest().version;

const TAB_IDS: OptionsTabId[] = ["import", "tags", "onPage", "connections", "appearance", "data", "about"];
const activeTab = ref<OptionsTabId>("import");

const tabs = computed<Array<{ id: OptionsTabId; label: string; icon: OptionsIconName }>>(() => [
  { id: "import", label: t("options.tab.import"), icon: "import" },
  { id: "tags", label: t("options.tab.tags"), icon: "tags" },
  { id: "onPage", label: t("options.tab.onPage"), icon: "onPage" },
  { id: "connections", label: t("options.tab.connections"), icon: "connections" },
  { id: "appearance", label: t("options.tab.appearance"), icon: "appearance" },
  { id: "data", label: t("options.tab.data"), icon: "data" },
  { id: "about", label: t("options.tab.about"), icon: "about" },
]);

// Sync language from config into i18n system
watch(
  () => cfg.value.language,
  (lang) => setLanguage(lang as Language),
  { immediate: true },
);

// Owned here rather than in AppearanceTab: it toggles the `html.dark` class,
// which has to stay applied while any other tab is open.
const mode = useColorMode({ emitAuto: true });
const theme = computed({
  get: () => mode.value as ColorModeValue,
  set: (value: ColorModeValue) => (mode.value = value),
});

// ── Search ──────────────────────────────────────────────────
const { query, results } = useSettingsSearch();
const searching = computed(() => query.value.trim().length >= 2);

// Path the shell wants drawn attention to; SettingRow injects this.
const highlight = ref<string | undefined>(undefined);
provide(HIGHLIGHT_KEY, highlight);

let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Switch to the setting's tab, scroll it into view and flash it briefly. */
async function goToSetting(tab: OptionsTabId, path: string) {
  activeTab.value = tab;
  query.value = "";
  highlight.value = path;
  window.location.hash = `${tab}/${path}`;

  // The tab renders on the next tick; only then does the row exist.
  await nextTick();
  document.getElementById(`setting-${path}`)?.scrollIntoView({ block: "center", behavior: "smooth" });

  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => (highlight.value = undefined), 2400);
}

function tabLabel(id: OptionsTabId): string {
  return tabs.value.find((tab) => tab.id === id)?.label ?? id;
}

// ── Deep links ──────────────────────────────────────────────
// "#tags" opens a tab, "#tags/tagRules.enabled" opens it and points at one
// setting — so a toast or the popup can link straight at the switch it means.
function applyHash() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return;
  const [tab, path] = raw.split("/");
  if (!TAB_IDS.includes(tab as OptionsTabId)) return;

  activeTab.value = tab as OptionsTabId;
  if (!path) return;
  if (!SETTINGS_INDEX.some((entry) => entry.path === path)) return;
  void goToSetting(tab as OptionsTabId, path);
}

function selectTab(id: string) {
  if (!TAB_IDS.includes(id as OptionsTabId)) return;
  activeTab.value = id as OptionsTabId;
  window.location.hash = id;
}

onMounted(() => {
  applyHash();
  window.addEventListener("hashchange", applyHash);
});
onUnmounted(() => {
  window.removeEventListener("hashchange", applyHash);
  if (highlightTimer) clearTimeout(highlightTimer);
});

// Debug hooks for poking the stored config from the options page devtools
// console (inspecting it, and forcing the store's migration to re-run).
const wnd = window as any;
wnd.szc_get_config = () => JSON.parse(JSON.stringify(cfg.value));
wnd.szc_set_config_version = (v = 0) => (cfg.value.version = v);
</script>

<template>
  <div class="page">
    <OptionsSidebar
      :tabs="tabs"
      :active-tab="activeTab"
      :version="versionInfo"
      :brand="t('options.brand')"
      :search-label="t('options.search.label')"
      :search-placeholder="t('options.search.placeholder')"
      v-model:search-query="query"
      @select="selectTab"
    />

    <main class="content">
      <!-- Search replaces the tab body: results span every tab, so showing
           them beside one tab's content would be misleading. -->
      <div v-if="searching" class="tab-content">
        <h2 class="tab-title">{{ t("options.search.results", { count: results.length }) }}</h2>

        <div v-if="results.length === 0" class="uac-empty">
          {{ t("options.search.noResults", { query: query.trim() }) }}
        </div>

        <div v-else class="search-results">
          <button
            v-for="hit in results"
            :key="hit.path"
            type="button"
            class="search-hit"
            @click="goToSetting(hit.tab, hit.path)"
          >
            <span class="search-hit-main">
              <span class="search-hit-label">{{ hit.labelText }}</span>
              <span v-if="hit.hintText" class="search-hit-hint">{{ hit.hintText }}</span>
            </span>
            <span class="search-hit-tab">{{ tabLabel(hit.tab) }}</span>
          </button>
        </div>
      </div>

      <template v-else>
        <ImportTab v-if="activeTab === 'import'" />
        <TagsTab v-else-if="activeTab === 'tags'" />
        <OnPageTab v-else-if="activeTab === 'onPage'" />
        <ConnectionsTab v-else-if="activeTab === 'connections'" />
        <AppearanceTab v-else-if="activeTab === 'appearance'" v-model:theme="theme" />
        <DataTab v-else-if="activeTab === 'data'" />
        <AboutTab v-else-if="activeTab === 'about'" :version="versionInfo" />
      </template>
    </main>
  </div>
</template>

<style lang="scss" src="./styles/options.scss"></style>

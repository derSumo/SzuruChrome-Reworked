<script setup lang="ts">
import { computed } from "vue";
import { cfg } from "~/stores";
import { useI18n } from "~/i18n/vue";
import type { ColorModeValue } from "../../colorMode";
import SettingCard from "../SettingCard.vue";
import SettingRow from "../SettingRow.vue";
import SettingToggle from "../SettingToggle.vue";

const { t, availableLanguages } = useI18n();

// `useColorMode` writes the global `html.dark` class, so it is owned by App.vue
// (always mounted) — this tab only edits it.
const props = defineProps<{ theme: ColorModeValue }>();
const emit = defineEmits<{ "update:theme": [value: ColorModeValue] }>();
const mode = computed({
  get: () => props.theme,
  set: (value) => emit("update:theme", value),
});
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.appearance.title") }}</h2>

    <SettingCard :title="t('options.interface.appearance')">
      <SettingRow :label="t('options.interface.theme')" :hint="t('options.interface.themeHint')">
        <div class="select-wrapper">
          <select v-model="mode">
            <option value="auto">{{ t("options.interface.themeAuto") }}</option>
            <option value="light">{{ t("options.interface.themeLight") }}</option>
            <option value="dark">{{ t("options.interface.themeDark") }}</option>
          </select>
        </div>
      </SettingRow>

      <SettingRow path="language" :label="t('options.interface.language')" :hint="t('options.interface.languageHint')">
        <div class="select-wrapper">
          <select v-model="cfg.language">
            <option v-for="lang in availableLanguages" :key="lang.value" :value="lang.value">{{ lang.label }}</option>
          </select>
        </div>
      </SettingRow>
    </SettingCard>

    <SettingCard :title="t('options.interface.popupCustomization')">
      <SettingRow
        path="autoSearchSimilar"
        :label="t('options.interface.autoSearch')"
        :hint="t('options.interface.autoSearchHint')"
      >
        <SettingToggle v-model="cfg.autoSearchSimilar" />
      </SettingRow>

      <SettingRow path="loadTagCounts" :label="t('options.interface.tagCounts')" :hint="t('options.interface.tagCountsHint')">
        <SettingToggle v-model="cfg.loadTagCounts" />
      </SettingRow>

      <SettingRow
        path="fetchPostInfo"
        :label="t('options.interface.fetchPostInfo')"
        :hint="t('options.interface.fetchPostInfoHint')"
      >
        <SettingToggle v-model="cfg.fetchPostInfo" />
      </SettingRow>

      <SettingRow path="popup.showSource" :label="t('options.interface.showSource')" :hint="t('options.interface.showSourceHint')">
        <SettingToggle v-model="cfg.popup.showSource" />
      </SettingRow>

      <SettingRow path="popup.showPools" :label="t('options.interface.showPools')" :hint="t('options.interface.showPoolsHint')">
        <SettingToggle v-model="cfg.popup.showPools" />
      </SettingRow>

      <SettingRow
        path="popup.tagSortMode"
        :label="t('options.interface.tagSortMode')"
        :hint="t('options.interface.tagSortModeHint')"
      >
        <div class="select-wrapper">
          <select v-model="cfg.popup.tagSortMode">
            <option value="usage">{{ t("popup.sortUsage") }}</option>
            <option value="category">{{ t("popup.sortCategory") }}</option>
            <option value="name">{{ t("popup.sortName") }}</option>
          </select>
        </div>
      </SettingRow>
    </SettingCard>
  </div>
</template>

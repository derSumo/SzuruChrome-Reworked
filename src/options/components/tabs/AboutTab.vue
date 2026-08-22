<script setup lang="ts">
import ChangelogList from "../ChangelogList.vue";
import SettingCard from "../SettingCard.vue";
import { useI18n } from "~/i18n/vue";

defineProps<{ version: string }>();

const { t } = useI18n();
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.about.title") }}</h2>

    <SettingCard :title="t('options.brand')">
      <div class="about-meta">
        <span class="about-version">v{{ version }}</span>
        <a class="about-link" href="https://github.com/derSumo/SzuruChrome-Reworked" target="_blank" rel="noopener">
          {{ t("options.forkBy") }}
        </a>
      </div>
    </SettingCard>

    <h3 class="sub-title">{{ t("changelog.title") }}</h3>
    <ChangelogList />
  </div>
</template>

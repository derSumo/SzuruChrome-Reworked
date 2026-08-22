<script setup lang="ts">
import { CHANGELOG } from "../changelog";
import { useI18n } from "~/i18n/vue";

const { t } = useI18n();
</script>

<template>
  <div class="card changelog-card">
    <div v-for="entry in CHANGELOG" :key="entry.version" class="changelog-entry">
      <div class="changelog-version">v{{ entry.version }}</div>
      <div class="changelog-date">{{ t(entry.date) }}</div>
      <ul class="changelog-list">
        <li v-for="(item, index) in entry.items" :key="index">
          <template v-if="item.title">
            <strong>{{ t(item.title) }}</strong> — {{ t(item.text) }}
          </template>
          <template v-else>{{ t(item.text) }}</template>
        </li>
      </ul>
    </div>
  </div>
</template>

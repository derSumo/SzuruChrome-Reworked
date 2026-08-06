<script setup lang="ts">
defineProps<{
  tabs: Array<{ id: string; label: string }>;
  activeTab: string;
  version: string;
  brand: string;
  forkBy: string;
}>();

defineEmits<{
  select: [tabId: string];
}>();
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-brand">
      <span class="brand-name">{{ brand }}</span>
      <span class="brand-version">v{{ version }}</span>
      <a class="brand-fork" href="https://github.com/derSumo/SzuruChrome-Reworked" target="_blank">{{ forkBy }}</a>
    </div>

    <nav class="sidebar-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="nav-item"
        :class="{ active: activeTab === tab.id }"
        @click="$emit('select', tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>
  </div>
</template>

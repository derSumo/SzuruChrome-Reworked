<script setup lang="ts">
import { icon, type OptionsIconName } from "../icons";

defineProps<{
  tabs: Array<{ id: string; label: string; icon: OptionsIconName }>;
  activeTab: string;
  version: string;
  brand: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchQuery: string;
}>();

defineEmits<{
  select: [tabId: string];
  "update:searchQuery": [value: string];
}>();
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-brand">
      <span class="brand-name">{{ brand }}</span>
      <span class="brand-version">v{{ version }}</span>
    </div>

    <div class="sidebar-search">
      <span class="sidebar-search-icon" v-html="icon('search')"></span>
      <input
        type="search"
        class="sidebar-search-input"
        :aria-label="searchLabel"
        :placeholder="searchPlaceholder"
        :value="searchQuery"
        @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <nav class="sidebar-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="nav-item"
        :class="{ active: activeTab === tab.id }"
        type="button"
        @click="$emit('select', tab.id)"
      >
        <span class="nav-item-icon" v-html="icon(tab.icon)"></span>
        <span class="nav-item-label">{{ tab.label }}</span>
      </button>
    </nav>
  </div>
</template>

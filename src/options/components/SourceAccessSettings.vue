<script setup lang="ts">
import { SOURCE_SITES, type SourceSite } from "~/shared/sourceSites";

defineProps<{
  access: Record<string, boolean>;
  title: string;
  hint: string;
  /** Shown when a request/removal was rejected — previously this went to a status line on another tab. */
  error?: string;
}>();

defineEmits<{
  change: [site: SourceSite, enabled: boolean];
}>();
</script>

<template>
  <div class="card">
    <h3 class="card-title">{{ title }}</h3>
    <p class="card-hint">{{ hint }}</p>

    <div class="source-access-grid">
      <label v-for="site in SOURCE_SITES" :key="site.id" class="source-access-row">
        <span>{{ site.label }}</span>
        <input
          type="checkbox"
          :checked="access[site.id] === true"
          @change="$emit('change', site, ($event.target as HTMLInputElement).checked)"
        />
      </label>
    </div>

    <p v-if="error" class="status-text status-error">{{ error }}</p>
  </div>
</template>

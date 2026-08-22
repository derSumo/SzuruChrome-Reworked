<script setup lang="ts">
defineProps<{
  title: string;
  /** Optional paragraph shown under the title. */
  hint?: string;
}>();
</script>

<template>
  <div class="card">
    <h3 class="card-title">{{ title }}</h3>
    <p v-if="hint" class="card-hint">{{ hint }}</p>
    <slot />
  </div>
</template>

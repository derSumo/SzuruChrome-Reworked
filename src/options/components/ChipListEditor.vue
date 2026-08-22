<script setup lang="ts">
// Shared chrome for the three chip lists in the options page (upload-as-content
// hosts, tag blacklist patterns, hover-zoom hosts). The parent owns the actual
// mutation because each list normalises its input differently.
import { ref } from "vue";

defineProps<{
  items: readonly string[];
  emptyText: string;
  placeholder: string;
  addLabel: string;
  removeTitle?: string;
}>();

const emit = defineEmits<{
  add: [value: string];
  remove: [index: number, value: string];
}>();

const draft = ref("");

function submit() {
  const value = draft.value.trim();
  if (!value) return;
  emit("add", value);
  draft.value = "";
}
</script>

<template>
  <div class="uac-active">
    <div v-if="items.length === 0" class="uac-empty">{{ emptyText }}</div>
    <span v-for="(item, index) in items" :key="item" class="uac-chip">
      <span class="uac-host">{{ item }}</span>
      <button class="uac-remove" :title="removeTitle ?? 'Remove'" @click="emit('remove', index, item)">✕</button>
    </span>
  </div>

  <div class="uac-add-row">
    <input type="text" :placeholder="placeholder" v-model="draft" @keydown.enter.prevent="submit" />
    <button class="btn btn-secondary" @click="submit">{{ addLabel }}</button>
  </div>
</template>

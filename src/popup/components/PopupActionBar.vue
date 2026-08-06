<script setup lang="ts">
defineProps<{
  showFindSimilar: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  uploadSuccess: boolean;
  hasExactMatch: boolean;
  findSimilarLabel: string;
  importingLabel: string;
  importedLabel: string;
  importLabel: string;
}>();

defineEmits<{
  findSimilar: [];
  upload: [];
}>();
</script>

<template>
  <footer class="glass-action-bar">
    <button v-if="showFindSimilar" class="glass-btn glass-btn-ghost" :disabled="isSubmitting" @click="$emit('findSimilar')">
      {{ findSimilarLabel }}
    </button>
    <button
      class="glass-btn glass-btn-primary"
      :disabled="isSubmitting || isUploading || hasExactMatch || uploadSuccess"
      @click="$emit('upload')"
    >
      <span v-if="isSubmitting || isUploading" class="glass-spinner glass-spinner-sm"></span>
      <span>{{ isSubmitting || isUploading ? importingLabel : uploadSuccess ? importedLabel : importLabel }}</span>
    </button>
  </footer>
</template>

<script setup lang="ts">
// The toggle markup was repeated 23× in the options template; `v-model` keeps
// the call sites as short as the raw checkbox they replace.
defineProps<{ modelValue: boolean }>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label class="toggle">
    <input
      type="checkbox"
      :checked="modelValue"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  /** Rendered next to the slider, e.g. "80%" or "250 ms". */
  display: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: number] }>();
</script>

<template>
  <div class="slider-group">
    <input
      type="range"
      class="lq-slider"
      :min="min"
      :max="max"
      :step="step ?? 1"
      :value="modelValue"
      @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
    />
    <span class="slider-value">{{ display }}</span>
  </div>
</template>

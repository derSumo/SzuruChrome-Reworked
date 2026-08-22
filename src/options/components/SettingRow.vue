<script setup lang="ts">
import { computed, inject } from "vue";
import { cfg } from "~/stores";
import { defaultConfig } from "~/shared/config";
import { readPath, writePath } from "../settingsIndex";
import { HIGHLIGHT_KEY } from "../keys";
import { useI18n } from "~/i18n/vue";

const props = defineProps<{
  label: string;
  hint?: string;
  /**
   * Config path this row edits, e.g. "batchImport.maxPosts". Optional because
   * a couple of rows (the theme picker) are not backed by the config, but
   * every row that is should pass it: it powers the deep-link anchor, the
   * "differs from default" marker, and the search highlight.
   */
  path?: string;
}>();

const { t } = useI18n();

// Set by the options shell when a search result or a deep link points here.
const highlighted = inject(HIGHLIGHT_KEY, undefined);

const isHighlighted = computed(() => !!props.path && highlighted?.value === props.path);

const changed = computed(() => {
  if (!props.path) return false;
  const current = readPath(cfg.value, props.path);
  const fallback = readPath(defaultConfig(), props.path);
  // Compared structurally so an array/object setting doesn't read as changed
  // just because it is a different instance of the same value.
  return JSON.stringify(current) !== JSON.stringify(fallback);
});

function resetToDefault() {
  if (!props.path) return;
  writePath(cfg.value, props.path, readPath(defaultConfig(), props.path));
}
</script>

<template>
  <div
    class="option-row"
    :class="{ highlighted: isHighlighted }"
    :id="path ? `setting-${path}` : undefined"
  >
    <div class="option-info">
      <span class="option-label">
        {{ label }}
        <!-- e.g. the warning tooltip next to "upload as content" -->
        <slot name="label-suffix" />
        <button
          v-if="changed"
          type="button"
          class="option-changed"
          :title="t('options.setting.resetOne')"
          :aria-label="t('options.setting.resetOne')"
          @click="resetToDefault"
        >
          <span class="option-changed-dot"></span>
          <span class="option-changed-text">{{ t("options.setting.changed") }}</span>
        </button>
      </span>
      <span v-if="hint" class="option-hint">{{ hint }}</span>
    </div>
    <slot />
  </div>
</template>

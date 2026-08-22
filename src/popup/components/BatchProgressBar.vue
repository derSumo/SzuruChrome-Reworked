<script setup lang="ts">
// ── Running batch, seen from the popup ────────────────────────────────
// The batch runner lives in the background and keeps going through
// navigations and closed tabs, but its progress dock is part of the booru
// page's content script. Move to any other tab and a running import became
// invisible — which is exactly when you want to know whether it is still
// going, and exactly where the only way to stop it used to not exist.
//
// This polls rather than subscribing: `batch_status` is broadcast to the tabs
// a batch came from, and the popup is not one of them. A popup is open for
// seconds at a time, so a 1s poll is cheap.

import { onMounted, onUnmounted, ref } from "vue";
import { BrowserCommand } from "~/models";
import { useI18n } from "~/i18n/vue";

interface ActiveBatch {
  batchId: string;
  done: number;
  total: number;
  skipped: number;
  poolName?: string;
  cancelling?: boolean;
}

const POLL_MS = 1000;

const { t } = useI18n();
const active = ref<ActiveBatch | undefined>(undefined);
const stopping = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

async function poll() {
  try {
    const status: ActiveBatch | undefined = await browser.runtime.sendMessage(new BrowserCommand("batch_active"));
    active.value = status?.batchId && status.total ? status : undefined;
    if (!active.value) stopping.value = false;
  } catch {
    // Worker asleep — treat as "nothing running" rather than showing an error.
    active.value = undefined;
  }
}

async function stop() {
  const batchId = active.value?.batchId;
  if (!batchId) return;
  stopping.value = true;
  try {
    await browser.runtime.sendMessage(new BrowserCommand("batch_cancel", { batchId }));
  } catch {
    stopping.value = false;
  }
  await poll();
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="active" class="batch-strip">
    <div class="batch-strip-head">
      <span class="batch-strip-dot"></span>
      <span class="batch-strip-label">
        {{
          stopping || active.cancelling
            ? t("popup.batchStopping")
            : t("popup.batchRunning", { done: active.done, total: active.total })
        }}
      </span>
      <span v-if="active.poolName" class="batch-strip-pool">{{ active.poolName }}</span>
      <button
        v-if="!stopping && !active.cancelling"
        type="button"
        class="batch-strip-stop"
        @click="stop"
      >
        {{ t("popup.batchStop") }}
      </button>
    </div>
    <div class="batch-strip-bar">
      <i :style="{ width: `${active.total > 0 ? Math.round((active.done / active.total) * 100) : 0}%` }"></i>
    </div>
  </div>
</template>

<style scoped lang="scss">
.batch-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.24);
}

.batch-strip-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.batch-strip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6366f1;
  flex-shrink: 0;
  animation: batch-strip-pulse 1.4s ease-in-out infinite;
}

.batch-strip-label {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.batch-strip-pool {
  color: rgba(127, 127, 150, 0.9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-strip-stop {
  margin-left: auto;
  flex-shrink: 0;
  padding: 3px 10px;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  color: inherit;
  cursor: pointer;
  background: rgba(127, 127, 150, 0.14);
  border: 1px solid rgba(127, 127, 150, 0.26);
  border-radius: 999px;
}

.batch-strip-stop:hover {
  background: rgba(239, 68, 68, 0.18);
  border-color: rgba(239, 68, 68, 0.42);
}

.batch-strip-stop:focus-visible {
  outline: 2px solid #6366f1;
  outline-offset: 2px;
}

.batch-strip-bar {
  height: 4px;
  border-radius: 3px;
  background: rgba(127, 127, 150, 0.22);
  overflow: hidden;
}

.batch-strip-bar > i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #6366f1, #818cf8);
  transition: width 0.3s ease;
}

@keyframes batch-strip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .batch-strip-dot { animation: none; }
  .batch-strip-bar > i { transition: none; }
}
</style>

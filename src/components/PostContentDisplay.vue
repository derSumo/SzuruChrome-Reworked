<script setup lang="ts">
import type { PropType } from "vue";

const props = defineProps({
  contentUrl: String,
  notes: {
    type: Array,
    default: () => [],
  },
  contentType: String,
  fetchViaContentScript: Function as PropType<(url: string) => Promise<{ base64: string; mimeType: string }>>,
});

const emit = defineEmits(["onResolutionLoaded"]);

const imgEl = ref<HTMLImageElement | undefined>(undefined);
const blobUrl = ref<string | undefined>(undefined);

const effectiveImgUrl = computed(() => blobUrl.value || props.contentUrl);

// Get image width and height from the <img> element.
function onloadImage() {
  if (imgEl.value) {
    emit("onResolutionLoaded", [imgEl.value.naturalWidth, imgEl.value.naturalHeight]);
  }
}

// When the <img> tag fails to load (e.g. CDN hotlink protection), fall back to
// fetching via the content script (has page cookies + Referer), then the
// extension's own fetch() as a last resort.
async function onImageError() {
  if (!props.contentUrl || blobUrl.value) return;

  if (props.fetchViaContentScript) {
    try {
      const { base64, mimeType } = await props.fetchViaContentScript(props.contentUrl);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blobUrl.value = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      return;
    } catch (e) {
      console.error("PostContentDisplay: content script fetch failed:", e);
    }
  }

  try {
    const r = await fetch(props.contentUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    blobUrl.value = URL.createObjectURL(await r.blob());
  } catch (e) {
    console.error("PostContentDisplay: fetch fallback failed:", e);
  }
}

watch(
  () => props.contentUrl,
  () => {
    if (blobUrl.value) {
      URL.revokeObjectURL(blobUrl.value);
      blobUrl.value = undefined;
    }
  },
);

onUnmounted(() => {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
  }
});
</script>

<template>
  <div class="post-container">
    <img v-if="contentType == 'image'" ref="imgEl" :src="effectiveImgUrl" @load="onloadImage" @error="onImageError" />
    <video v-if="contentType == 'video'" controls>
      <source :src="contentUrl" />
    </video>
    <div class="post-overlay">
      <PostNotes :notes="notes" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.post-overlay {
  position: absolute;
  width: 100%;
  height: 100%;
}

.post-container {
  position: relative;
  display: flex;
}
</style>

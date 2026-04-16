<script setup lang="ts">
const props = defineProps({
  contentUrl: String,
  notes: {
    type: Array,
    default: () => [],
  },
  contentType: String,
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

// When the <img> tag fails to load (e.g. CDN hotlink protection blocks the
// request because the Referer is chrome-extension://), fall back to fetching
// via the extension's fetch() API (which benefits from host_permissions and
// doesn't have the same referer restrictions) and create a blob URL.
function onImageError() {
  if (props.contentUrl && !blobUrl.value) {
    fetch(props.contentUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        blobUrl.value = URL.createObjectURL(blob);
      })
      .catch((e) => console.error("PostContentDisplay: fetch fallback failed:", e));
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

<script setup lang="ts">
import { PropType } from "vue";
import { TagDetails } from "~/models";
import { encodeTagName, getTagClasses } from "~/utils";
import SzurubooruApi from "~/api";

const autocompleteItems = ref<TagDetails[]>([]);

const props = defineProps({
  szuru: Object as PropType<SzurubooruApi>,
});
const emit = defineEmits(["addTag"]);

function addTag(tag: TagDetails) {
  emit("addTag", tag);
}

function addTagFromCurrentInput(input: string) {
  addTag(new TagDetails([input]));
}

async function autocompletePopulator(input: string, signal: AbortSignal) {
  const query = decodeURIComponent(`*${encodeTagName(input)}* sort:usages`);
  try {
    const res = await props.szuru?.getTags(query, 0, 100, ["names", "category", "usages", "implications"], signal);

    if (res) {
      // TODO: Maybe search on hamming distance or something?
      autocompleteItems.value = res.results.map((x) => TagDetails.fromTag(x));
      console.dir(autocompleteItems.value);
    } else {
      autocompleteItems.value = [];
    }
  } catch (ex) {
    if (!signal.aborted) console.warn("Tag autocomplete failed:", ex);
  }
}
</script>

<template>
  <AutocompleteInput
    :autocomplete-items="autocompleteItems"
    @add-item="addTag"
    @add-from-current-input="addTagFromCurrentInput"
    @autocomplete-populator="autocompletePopulator"
    v-slot="slotProps"
  >
    <span :class="getTagClasses(slotProps.item)">{{ slotProps.item.name }}</span>
    <span class="tag-usages">{{ slotProps.item.usages ? slotProps.item.usages : "" }}</span>
  </AutocompleteInput>
</template>

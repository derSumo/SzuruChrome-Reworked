<script setup lang="ts">
import { PropType } from "vue";
import { PoolDetails } from "~/models";
import { encodeTagName, getTagClasses } from "~/utils";
import SzurubooruApi from "~/api";

const autocompleteItems = ref<PoolDetails[]>([]);

const props = defineProps({
  szuru: Object as PropType<SzurubooruApi>,
});
const emit = defineEmits(["addPool"]);

function addPool(tag: PoolDetails) {
  emit("addPool", tag);
}

function addPoolFromCurrentInput(input: string) {
  addPool(new PoolDetails([input]));
}

async function autocompletePopulator(input: string, signal: AbortSignal) {
  const query = decodeURIComponent(`*${encodeTagName(input)}*`);
  try {
    const res = await props.szuru?.getPools(query, 0, 100, ["id", "names", "category", "description", "postCount"], signal);

    if (res) {
      // TODO: Maybe search on hamming distance or something?
      autocompleteItems.value = res.results.map((x) => PoolDetails.fromPool(x));
    } else {
      autocompleteItems.value = [];
    }
  } catch (ex) {
    if (!signal.aborted) console.warn("Pool autocomplete failed:", ex);
  }
}
</script>

<template>
  <AutocompleteInput
    :autocomplete-items="autocompleteItems"
    @add-item="addPool"
    @add-from-current-input="addPoolFromCurrentInput"
    @autocomplete-populator="autocompletePopulator"
    v-slot="slotProps"
  >
    <span :class="getTagClasses(slotProps.item)">{{ slotProps.item.name }}</span>
    <span class="tag-usages">{{ slotProps.item.usages ? slotProps.item.usages : "" }}</span>
  </AutocompleteInput>
</template>

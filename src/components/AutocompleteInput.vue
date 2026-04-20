<script setup lang="ts">
import axios, { CancelTokenSource } from "axios";

const inputText = ref("");
const autocompleteShown = ref(false);
const cancelSource = ref<CancelTokenSource | undefined>(undefined);
const autocompleteIndex = ref(-1);

const props = defineProps({
  autocompleteItems: {
    type: Array<any>,
    required: true,
  },
});
const emit = defineEmits(["addItem", "addFromCurrentInput", "autocompletePopulator"]);

function addItem(item: any) {
  emit("addItem", item);
}

async function onAddItemKeyUp(e: KeyboardEvent) {
  await autocompletePopulator((<HTMLInputElement>e.target).value);
}

function addItemFromCurrentInput() {
  emit("addFromCurrentInput", inputText.value);
  inputText.value = ""; // Reset input

  // Only needed when the button is clicked
  // When this is triggered by the enter key the `onAddItemKeyUp` will internally also hide the autocomplete.
  // Though hiding it twice doesn't hurt so we don't care.
  hideAutocomplete();
}

function onAddItemKeyDown(e: KeyboardEvent) {
  if (e.code == "ArrowDown") {
    e.preventDefault();
    if (autocompleteIndex.value < props.autocompleteItems.length - 1) {
      autocompleteIndex.value++;
    }
  } else if (e.code == "ArrowUp") {
    e.preventDefault();
    if (autocompleteIndex.value >= 0) {
      autocompleteIndex.value--;
    }
  } else if (e.code == "Enter") {
    if (autocompleteIndex.value == -1) {
      addItemFromCurrentInput();
    } else {
      // Add auto completed item
      const itemToAdd = props.autocompleteItems[autocompleteIndex.value];
      addItem(itemToAdd);
      inputText.value = ""; // Reset input
    }
  }
}

function onClickAutocompleteItem(item: any) {
  addItem(item);
  inputText.value = ""; // Reset input
  autocompleteShown.value = false; // Hide autocomplete list
}

function hideAutocomplete() {
  autocompleteIndex.value = -1;
  autocompleteShown.value = false;
}

async function autocompletePopulator(input: string) {
  // Based on https://www.w3schools.com/howto/howto_js_autocomplete.asp

  // Hide autocomplete when the input is empty, and don't do anything else.
  if (input.length == 0) {
    hideAutocomplete();
    return;
  }

  // Cancel previous request, not sure if this still works after the refactor.
  if (cancelSource.value) {
    cancelSource.value.cancel();
  }
  cancelSource.value = axios.CancelToken.source();

  emit("autocompletePopulator", inputText.value, cancelSource.value.token);
}

watch(props, (newValue) => {
  if (newValue.autocompleteItems.length > 0) {
    autocompleteShown.value = true;
  }
});
</script>

<template>
  <div class="autocomplete-wrap">
    <div class="autocomplete-input-row">
      <input type="text" v-model="inputText" @keyup="onAddItemKeyUp" @keydown="onAddItemKeyDown" autocomplete="off" class="autocomplete-field" />
      <button class="autocomplete-add-btn" @click="addItemFromCurrentInput">Add</button>
    </div>

    <div class="autocomplete-items" v-bind:class="{ show: autocompleteShown }">
      <div
        v-for="(item, idx) in autocompleteItems"
        @click="onClickAutocompleteItem(item)"
        :key="item.name"
        :class="{
          active: idx == autocompleteIndex,
        }"
      >
        <slot :item="item"></slot>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.autocomplete-wrap {
  display: flex;
  flex-direction: column;
  position: relative;
}

.autocomplete-input-row {
  display: flex;
  gap: 6px;
}

.autocomplete-field {
  flex: 1;
  min-width: 0;
  height: 28px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary-color);
  color: var(--text-color);
  padding: 0 8px;
  font-size: 12px;
  transition: border-color 150ms ease;

  &:focus {
    outline: none;
    border-color: var(--primary-color);
    box-shadow: 0 0 0 2px rgba(36, 170, 221, 0.15);
  }
}

.autocomplete-add-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--primary-color);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
  white-space: nowrap;

  &:hover {
    opacity: 0.9;
  }
}

.autocomplete-items {
  position: absolute;
  z-index: 10;
  top: 32px;
  left: 0;
  right: 0;
  background-color: var(--bg-main-color);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  display: none;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: thin;

  &.show {
    display: block;
  }

  > div {
    cursor: pointer;
    padding: 4px 8px;

    display: flex;
    align-items: center;
    gap: 0.4em;
    font-size: 12px;
    transition: background 100ms ease;

    &:first-child {
      border-radius: 6px 6px 0 0;
    }
    &:last-child {
      border-radius: 0 0 6px 6px;
    }

    &:hover {
      background: var(--tab-color);
    }
  }

  > div.active {
    background: var(--primary-color);

    > span {
      color: #fff;
    }
  }
}
</style>

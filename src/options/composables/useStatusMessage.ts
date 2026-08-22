// ── Inline status line ────────────────────────────────────────────────
// The options page shows three independent status lines (connection test,
// backup, statistics). They used to be three hand-rolled ref pairs with the
// same setter; this is that pair, once.

import { ref } from "vue";

export type StatusType = "success" | "error" | "quiet";

export function useStatusMessage() {
  const text = ref("");
  const type = ref<StatusType>("quiet");

  function set(message: string, kind: StatusType = "success") {
    text.value = message;
    type.value = kind;
  }

  function clear() {
    set("", "quiet");
  }

  return { text, type, set, clear };
}

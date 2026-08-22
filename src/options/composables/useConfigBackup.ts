// ── Configuration backup (export / import) ────────────────────────────

import { ref } from "vue";
import { cfg } from "~/stores";
import { getErrorMessage } from "~/utils";
import { useStatusMessage } from "./useStatusMessage";
import { useI18n } from "~/i18n/vue";

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick so the click has committed the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function useConfigBackup() {
  const { t } = useI18n();
  const { text: statusText, type: statusType, set: setStatus } = useStatusMessage();
  const fileInput = ref<HTMLInputElement | null>(null);

  function exportConfig(includeTokens: boolean) {
    const snapshot = JSON.parse(JSON.stringify(cfg.value));
    if (!includeTokens) {
      // Strip credentials so a shared backup can't leak instance access.
      for (const site of snapshot.sites ?? []) site.authToken = "";
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(snapshot, `szuruchrome-config-${stamp}.json`);
    setStatus(t("options.backup.exported"), "success");
  }

  function triggerImport() {
    fileInput.value?.click();
  }

  async function onImportFileChosen(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file later
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sites)) {
        throw new Error(t("options.backup.importInvalid"));
      }

      // Assign top-level keys individually rather than replacing cfg.value, so
      // keys absent from an older backup keep their current defaults. Reset the
      // version so the store's migration re-runs and fills any new fields.
      for (const key of Object.keys(parsed)) {
        (cfg.value as any)[key] = parsed[key];
      }
      cfg.value.version = 0;

      setStatus(t("options.backup.imported"), "success");
    } catch (ex) {
      setStatus(t("options.backup.importFailed", { error: getErrorMessage(ex) }), "error");
    }
  }

  return { statusText, statusType, fileInput, exportConfig, triggerImport, onImportFileChosen };
}

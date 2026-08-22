// ── Search across every setting ───────────────────────────────────────
// Matches the translated label and hint, so searching works in whichever
// language the user actually reads.

import { computed, ref } from "vue";
import { SETTINGS_INDEX, type SettingEntry } from "../settingsIndex";
import { useI18n } from "~/i18n/vue";

export interface SearchHit extends SettingEntry {
  labelText: string;
  hintText: string;
}

export function useSettingsSearch() {
  const { t } = useI18n();
  const query = ref("");

  const results = computed<SearchHit[]>(() => {
    const needle = query.value.trim().toLowerCase();
    if (needle.length < 2) return [];

    const hits: SearchHit[] = [];
    for (const entry of SETTINGS_INDEX) {
      const labelText = t(entry.label);
      const hintText = entry.hint ? t(entry.hint) : "";
      const haystack = `${labelText} ${hintText} ${entry.path}`.toLowerCase();
      if (haystack.includes(needle)) hits.push({ ...entry, labelText, hintText });
    }

    // Label matches first — someone typing "badge" wants the badge switches,
    // not every setting whose explanation happens to mention one.
    return hits.sort((a, b) => {
      const aLabel = a.labelText.toLowerCase().includes(needle) ? 0 : 1;
      const bLabel = b.labelText.toLowerCase().includes(needle) ? 0 : 1;
      if (aLabel !== bLabel) return aLabel - bLabel;
      return a.labelText.localeCompare(b.labelText);
    });
  });

  return { query, results };
}

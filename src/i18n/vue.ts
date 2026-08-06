// ── Reactive translation layer for Vue contexts ───────────────────────
// The core in `~/i18n` is a plain module so non-Vue contexts don't bundle Vue.
// Components need re-rendering when the language changes, so this mirrors the
// active language into a ref that the returned `t` reads before delegating.

import { computed, ref } from "vue";
import {
  availableLanguages,
  getLanguage,
  onLanguageChanged,
  registerMessages,
  t as translate,
  type Language,
  type TranslationKey,
} from "./index";
import enUi from "./messages/en.ui";
import deUi from "./messages/de.ui";

// Every UI surface imports this module to translate reactively, so registering
// the popup/options strings here means no entry point can forget to do it —
// and no non-UI context ever pulls them into its bundle.
registerMessages("en", enUi);
registerMessages("de", deUi);

const currentLanguage = ref<Language>(getLanguage());
onLanguageChanged((lang) => (currentLanguage.value = lang));

export function useI18n() {
  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    // Touch the ref so the surrounding computed/render effect re-runs when the
    // language changes; the actual lookup happens in the framework-free core.
    void currentLanguage.value;
    return translate(key, params);
  };

  return {
    t,
    locale: computed(() => currentLanguage.value),
    currentLanguage,
    availableLanguages,
  };
}

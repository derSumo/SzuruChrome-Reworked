import { computed } from "vue";
import en from "./en";
import de from "./de";

export type TranslationKey = keyof typeof en;
export type Language = "en" | "de";
export const availableLanguages: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

const messages: Record<Language, Record<string, string>> = { en, de };

// Reactive language ref – set from config by the app entry points.
import { ref } from "vue";
export const currentLanguage = ref<Language>("en");

/**
 * Translate a key, with optional interpolation.
 * Placeholders use `{name}` syntax.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const msg = messages[currentLanguage.value]?.[key] ?? messages.en[key] ?? key;
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

/**
 * Vue composable – returns reactive `t` function.
 */
export function useI18n() {
  const locale = computed(() => currentLanguage.value);
  return {
    t,
    locale,
    currentLanguage,
    availableLanguages,
  };
}

/**
 * Standalone (non-reactive) translate for background/content scripts.
 * Call `setLanguage` once after reading the config.
 */
export function setLanguage(lang: Language) {
  currentLanguage.value = lang;
}

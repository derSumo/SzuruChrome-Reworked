// ── Translations (framework-free core) ────────────────────────────────
// Deliberately free of any Vue import: the background service worker and the
// content script both translate strings, and the content script runs on every
// page in the browser.
//
// For the same reason the message tables are split. Only the ~40 runtime
// strings (toasts, badge, batch, background errors) are bundled here; the ~340
// popup/options strings are registered on demand by `~/i18n/vue`, which only
// UI surfaces import. `TranslationKey` still covers both, so a typo in any
// context is a compile error.

import enRuntime from "./messages/en.runtime";
import deRuntime from "./messages/de.runtime";
import type enUi from "./messages/en.ui";

export type Language = "en" | "de";
export type TranslationKey = keyof typeof enRuntime | keyof typeof enUi;

export const availableLanguages: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

const messages: Record<Language, Record<string, string>> = {
  en: { ...enRuntime },
  de: { ...deRuntime },
};

/** Add a message table for a language (see `~/i18n/vue` for the UI strings). */
export function registerMessages(lang: Language, table: Record<string, string>): void {
  Object.assign(messages[lang], table);
}

let language: Language = "en";
const languageListeners = new Set<(lang: Language) => void>();

export function getLanguage(): Language {
  return language;
}

/**
 * Switch the active language. Call once after reading the config in each
 * context; the Vue layer subscribes so components re-render.
 */
export function setLanguage(lang: Language): void {
  if (language === lang) return;
  language = lang;
  for (const listener of languageListeners) listener(lang);
}

export function onLanguageChanged(listener: (lang: Language) => void): void {
  languageListeners.add(listener);
}

/**
 * Translate a key, with optional `{name}` interpolation. Falls back to English
 * and finally to the key itself, so a missing translation degrades to
 * something readable rather than an empty string.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const msg = messages[language]?.[key] ?? messages.en[key] ?? key;
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

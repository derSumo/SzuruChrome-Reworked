// Injection keys shared between the options shell and the setting rows.

import type { InjectionKey, Ref } from "vue";

/**
 * Config path the shell wants drawn attention to — set when a search result is
 * chosen or the page is opened on a deep link. Injected rather than passed down
 * so it doesn't have to be threaded through every card and tab.
 */
export const HIGHLIGHT_KEY: InjectionKey<Ref<string | undefined>> = Symbol("szuru:highlight");

// ── Extension configuration: shape, defaults and raw reader ──────────
// Single source of truth for `browser.storage.local["config"]`.
//
// The Pinia store (`~/stores`) wraps this in a reactive ref for the popup and
// options page; the background and content script read it through
// `readStoredConfig()` instead, so neither pulls Vue/Pinia into its bundle.
// Keeping the defaults here means adding a setting is a one-line change that
// every context sees, rather than three parallel declarations drifting apart.

import type { SzuruSiteConfig, TagCategoryColor } from "~/models";

export const CONFIG_STORAGE_KEY = "config";

export type TagSortMode = "usage" | "category" | "name";

export function defaultConfig() {
  return {
    version: 0,
    language: "en" as "en" | "de",
    addPageUrlToSource: true,
    alwaysUploadAsContent: false,
    autoSearchSimilar: false,
    loadTagCounts: true,
    fetchPostInfo: true,
    sites: [] as Array<SzuruSiteConfig>,
    selectedSiteId: undefined as string | undefined,
    addTagImplications: true,
    addAllParsedTags: true,
    merge: {
      expandOptions: true,
      expandExistingTags: false,
      expandAddTags: true,
      addMissingTags: true,
      appendSource: true,
      mergeSafety: true,
    },
    popup: {
      expandTags: true,
      expandPools: false,
      showSource: true,
      showPools: true,
      tagSortMode: "usage" as TagSortMode,
    },
    tagCategories: [] as Array<TagCategoryColor>,
    autoRelationsEnabled: true,
    autoRelationThreshold: 60,
    replaceExactDuplicates: true,
    uploadAsContentSites: [] as string[],
    tagRules: {
      enabled: true,
      blacklist: [] as string[],
      rewrites: [] as Array<{ from: string; to: string }>,
    },
    importedBadge: {
      enabled: true,
      // Off by default: a "not imported" pill on every booru page is noise for
      // users who only import a fraction of what they browse.
      showWhenNotImported: false,
      // Check marks on listing thumbnails. Only what scrolls into view is
      // looked up, and a screenful costs one bulk query.
      thumbnails: true,
    },
    queueRetry: {
      enabled: true,
      maxAttempts: 3,
    },
    statsEnabled: true,
    batchImport: {
      // Shows the "select & import" launcher on booru listing/gallery pages.
      enabled: true,
      // Cap concurrent background tabs the batch runner opens at once.
      concurrency: 1,
      // Ceilings for the "all pages" crawl. A single click on a broad search
      // could otherwise queue tens of thousands of posts, so the defaults stay
      // conservative and the user raises them deliberately.
      maxPages: 20,
      maxPosts: 500,
      // Don't even open a tab for a post that is already in the instance.
      skipImported: true,
      // Drive the batch in its own unfocused window so the user's window
      // doesn't fill up with tabs; it closes again when the batch is done.
      separateWindow: true,
    },
    // Listing-page comfort features. All of them touch pages the user is
    // browsing, so anything that changes how a site behaves stays opt-in.
    listing: {
      /** Import buttons on each thumbnail while the mouse is over it. */
      hoverActions: true,
      /** Append the next page instead of making the user click through. */
      endlessScroll: false,
      /** Enlarge the thumbnail under the cursor. */
      hoverZoom: false,
      /** "all" = every supported source site, "sites" = the list below. */
      hoverZoomScope: "sites" as "all" | "sites",
      hoverZoomSites: [] as string[],
      /** Grace period before the preview opens, so passing over is quiet. */
      hoverZoomDelayMs: 350,
    },
  };
}

export type ExtensionConfig = ReturnType<typeof defaultConfig>;

/**
 * Config as it comes back from storage: written by an older version, so every
 * field added after the user's last save may be missing. The store's migration
 * fills them in for the UI, but the background/content script read the raw
 * value and must treat everything as optional.
 */
export type StoredConfig = Partial<ExtensionConfig>;

/**
 * Unwrap whatever storage handed back. Different adapters have wrapped the
 * value in various ways over the extension's life (raw object, JSON string,
 * `{ value: … }`), so normalisation lives in exactly one place.
 */
function normalizeStoredConfig(input: unknown): StoredConfig | undefined {
  if (!input) return undefined;

  if (typeof input === "string") {
    try {
      return normalizeStoredConfig(JSON.parse(input));
    } catch {
      return undefined;
    }
  }

  if (typeof input !== "object") return undefined;

  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.sites)) return obj as StoredConfig;
  if (obj.value) return normalizeStoredConfig(obj.value);

  return undefined;
}

/** Read the stored config, or undefined when nothing usable is saved yet. */
export async function readStoredConfig(): Promise<StoredConfig | undefined> {
  try {
    const storage = await browser.storage.local.get(CONFIG_STORAGE_KEY);
    return normalizeStoredConfig(storage?.[CONFIG_STORAGE_KEY]);
  } catch {
    return undefined;
  }
}

/** Persist a mutated config object read via `readStoredConfig`. */
export async function writeStoredConfig(cfg: StoredConfig): Promise<void> {
  await browser.storage.local.set({ [CONFIG_STORAGE_KEY]: cfg });
}

/** Run `fn` whenever the stored config changes in any context. */
export function onConfigChanged(fn: () => void): void {
  browser.storage.onChanged.addListener((changes) => {
    if (changes[CONFIG_STORAGE_KEY]) fn();
  });
}

import { defineStore } from "pinia";
import deepMerge from "deepmerge";
import {
  getDefaultTagCategories,
  type ScrapedPostDetails,
  type SetPostUploadInfoData,
  type SzuruSiteConfig,
  type TagCategoryColor,
} from "~/models";
import { useStorageLocal } from "~/composables/useStorageLocal";

export const cfg = useStorageLocal(
  "config",
  {
    version: 0,
    language: "en" as "en" | "de",
    addPageUrlToSource: true,
    alwaysUploadAsContent: false,
    autoSearchSimilar: false,
    loadTagCounts: true,
    fetchPostInfo: true,
    useContentTokens: true,
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
      tagSortMode: "usage" as "usage" | "category" | "name",
    },
    tagCategories: [] as Array<TagCategoryColor>,
    hotkey: {
      enabled: false,
      key: "a",
      modifiers: [] as string[],
    },
    hotkeyLinkLast: {
      enabled: false,
      key: "",
      modifiers: [] as string[],
    },
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
    },
  },
  {
    mergeDefaults(storageValue, defaults) {
      // Default deepMerge concatenates arrays, which would append default
      // array entries on every load → duplicates after a few reloads. Replace
      // arrays wholesale instead: stored value wins when present.
      const cfg = deepMerge(defaults, storageValue, {
        arrayMerge: (_target, source) => source,
      });
      const oldVersion = cfg.version;

      // Crappy config migration.
      switch (cfg.version) {
        case 0:
          cfg.version++;

          // Don't clear the existing tagCategories and don't add duplicates.
          for (const cat of getDefaultTagCategories()) {
            if (!cfg.tagCategories.find((x) => x.name == cat.name)) {
              cfg.tagCategories.push(cat);
            }
          }
        // eslint-disable-next-line no-fallthrough
        case 1:
          cfg.version++;
          // Ensure the per-site upload-as-content whitelist is always an array.
          if (!Array.isArray(cfg.uploadAsContentSites)) {
            cfg.uploadAsContentSites = [];
          }
        // eslint-disable-next-line no-fallthrough
        case 2:
          cfg.version++;
          // Repair duplicates introduced by the previous deepMerge concat behavior.
          if (Array.isArray(cfg.uploadAsContentSites)) {
            cfg.uploadAsContentSites = [...new Set(cfg.uploadAsContentSites)];
          }
        // eslint-disable-next-line no-fallthrough
        case 3:
          cfg.version++;
          // Tag rules arrive in v2.5.0. deepMerge with the defaults normally
          // supplies the object, but guard the container before writing into
          // it so a stored value that somehow nulled it can't crash migration.
          if (!cfg.tagRules || typeof cfg.tagRules !== "object") {
            cfg.tagRules = { enabled: true, blacklist: [], rewrites: [] };
          }
          if (!Array.isArray(cfg.tagRules.blacklist)) cfg.tagRules.blacklist = [];
          if (!Array.isArray(cfg.tagRules.rewrites)) cfg.tagRules.rewrites = [];
        // eslint-disable-next-line no-fallthrough
        case 4:
          cfg.version++;
          // Batch import arrives in v2.7.0.
          if (!cfg.batchImport || typeof cfg.batchImport !== "object") {
            cfg.batchImport = { enabled: true, concurrency: 1 };
          }
      }

      if (oldVersion != cfg.version) {
        console.log(`Migrated config from version ${oldVersion} to ${cfg.version}`);
      }

      return cfg;
    },
  },
);

export const usePopupStore = defineStore("popup", {
  state: () => ({
    posts: [] as ScrapedPostDetails[],
    selectedPostId: undefined as string | undefined,
    isSearchingForSimilarPosts: 0,
  }),
  getters: {
    selectedPost: (state) => {
      return state.posts.find((x) => x.id == state.selectedPostId);
    },
  },
  actions: {
    getPostForContentUrl(contentUrl: string): ScrapedPostDetails | undefined {
      return this.posts.find((x) => x.contentUrl == contentUrl);
    },
  },
});

export const useMergeStore = defineStore("merge", {
  state: () => ({
    uploadInfo: [] as SetPostUploadInfoData[],
    genericError: undefined as string | undefined,
  }),
});

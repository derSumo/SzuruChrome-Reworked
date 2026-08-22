import { defineStore } from "pinia";
import deepMerge from "deepmerge";
import {
  getDefaultTagCategories,
  type ScrapedPostDetails,
  type SetPostUploadInfoData,
} from "~/models";
import { useStorageLocal } from "~/composables/useStorageLocal";
import { CONFIG_STORAGE_KEY, defaultConfig } from "~/shared/config";
import {
  UI_STATE_STORAGE_KEY,
  defaultUiState,
  extractLegacyUiState,
  type LegacyUiStateSource,
} from "~/shared/uiState";

// The config shape and its defaults live in `~/shared/config` so the
// background and content script can read them without pulling in Vue/Pinia.
// This store only adds reactivity plus the migration chain below.
export const cfg = useStorageLocal(
  CONFIG_STORAGE_KEY,
  defaultConfig(),
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
            cfg.batchImport = {
              enabled: true,
              concurrency: 1,
              maxPages: 20,
              maxPosts: 500,
              skipImported: true,
              separateWindow: true,
              oldestFirst: true,
            };
          }
        // eslint-disable-next-line no-fallthrough
        case 5:
          cfg.version++;
          // Native browser commands replace the page-level keydown listener.
          // Drop obsolete settings so backups do not keep dead configuration.
          delete (cfg as any).hotkey;
          delete (cfg as any).hotkeyLinkLast;
          delete (cfg as any).useContentTokens;
        // eslint-disable-next-line no-fallthrough
        case 6:
          cfg.version++;
          // The "all pages" crawl arrives in v2.8.0. deepMerge supplies the new
          // limits, but a config stored with an explicit 0/undefined would let a
          // crawl select nothing at all — pull those back to the defaults.
          if (!(cfg.batchImport.maxPages > 0)) cfg.batchImport.maxPages = 20;
          if (!(cfg.batchImport.maxPosts > 0)) cfg.batchImport.maxPosts = 500;
        // eslint-disable-next-line no-fallthrough
        case 7:
          cfg.version++;
          // Thumbnail marks, skip-already-imported and the separate batch
          // window arrive in v2.9.0. deepMerge supplies the defaults; the
          // guards only matter for a config that stored an explicit null.
          if (typeof cfg.importedBadge.thumbnails !== "boolean") cfg.importedBadge.thumbnails = true;
          if (typeof cfg.batchImport.skipImported !== "boolean") cfg.batchImport.skipImported = true;
          if (typeof cfg.batchImport.separateWindow !== "boolean") cfg.batchImport.separateWindow = true;
        // eslint-disable-next-line no-fallthrough
        case 8:
          cfg.version++;
          // Listing-page features arrive in v3.0.0. Everything that changes how
          // a site behaves starts off; only the hover import buttons default on.
          if (!cfg.listing || typeof cfg.listing !== "object") {
            cfg.listing = {
              hoverActions: true,
              endlessScroll: false,
              hoverZoom: false,
              hoverZoomScope: "sites",
              hoverZoomSites: [],
              hoverZoomDelayMs: 350,
            };
          }
          if (!Array.isArray(cfg.listing.hoverZoomSites)) cfg.listing.hoverZoomSites = [];
        // eslint-disable-next-line no-fallthrough
        case 9:
          cfg.version++;
          // Newest-last batch order arrives in v3.0.4. On by default, including
          // for existing users: importing a listing in its own order is what put
          // their oldest posts on top of the instance in the first place.
          if (typeof cfg.batchImport.oldestFirst !== "boolean") cfg.batchImport.oldestFirst = true;
        // eslint-disable-next-line no-fallthrough
        case 10: {
          cfg.version++;
          // Panel open/closed state moves out of the settings config in v3.1.0,
          // so a config backup stops carrying "the pools section was collapsed"
          // next to the instance credentials. Carry the user's current state
          // over before dropping the keys, then delete them so a later export
          // is clean.
          const carried = extractLegacyUiState(cfg as LegacyUiStateSource);
          if (carried) {
            // Fire and forget: migration is synchronous, and losing a panel
            // toggle is not worth blocking the config read on.
            void browser.storage.local
              .get(UI_STATE_STORAGE_KEY)
              .then((stored) => {
                // Never clobber state this browser already wrote.
                if (stored?.[UI_STATE_STORAGE_KEY]) return;
                return browser.storage.local.set({
                  [UI_STATE_STORAGE_KEY]: { ...defaultUiState(), ...carried },
                });
              })
              .catch(() => { /* best effort */ });
          }
          for (const key of ["expandTags", "expandPools"]) delete (cfg.popup as any)[key];
          for (const key of ["expandOptions", "expandExistingTags", "expandAddTags"]) {
            delete (cfg.merge as any)[key];
          }
        }
        // eslint-disable-next-line no-fallthrough
        case 11:
          cfg.version++;
          // The hover zoom shipped scoped to a host whitelist that started out
          // empty, so switching it on did nothing until a host was typed in.
          // Anyone who never filled the list in gets the new "all" default;
          // a curated list is a deliberate choice and stays untouched.
          if (cfg.listing.hoverZoomScope === "sites" && !cfg.listing.hoverZoomSites?.length) {
            cfg.listing.hoverZoomScope = "all";
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

// Remembered panel state, kept out of `cfg` on purpose — see ~/shared/uiState.
export const uiState = useStorageLocal(UI_STATE_STORAGE_KEY, defaultUiState(), {
  mergeDefaults: true,
});

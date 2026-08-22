<script setup lang="ts">
import { useDark } from "@vueuse/core";
import { cloneDeep } from "lodash";
import { ScrapeResults } from "neo-scraper";
import { setLanguage, Language } from "~/i18n";
import { useI18n } from "~/i18n/vue";
import {
  encodeTagName,
  getErrorMessage,
  getPostInfoSummary,
  getTagClasses,
  breakTagName,
} from "~/utils";
import { getUrl } from "~/shared/host";
import { ensureInstancePermission } from "~/shared/sourceSites";
import { applyConfigToScrapedPost, buildPostDisplayName, resolveTagRules } from "~/shared/scrape";
import { getActiveTab, getActiveTabId, isRestrictedTabUrl, sendTabCommand } from "~/shared/tabs";
import { ensurePostHasContentToken } from "../contentToken";
import {
  ScrapedPostDetails,
  TagDetails,
  SimilarPostInfo,
  SimpleSimilarPost,
  SimpleImageSearchResult,
  PostUploadCommandData,
  SzuruSiteConfig,
  PoolDetails,
  BrowserCommand,
} from "~/models";
import { isMobile } from "~/env";
import { DeepReadonly } from "vue";
import { cfg, uiState, usePopupStore } from "~/stores";
import SzurubooruApi from "~/api";
import PopupActionBar from "~/popup/components/PopupActionBar.vue";
import BatchProgressBar from "~/popup/components/BatchProgressBar.vue";

const pop = usePopupStore();
const { t } = useI18n();
const extIconUrl = browser.runtime.getURL("assets/icon-128.png");

// Sync language from config
watch(() => cfg.value.language, (lang) => setLanguage(lang as Language), { immediate: true });

const isSearchingForSimilarPosts = ref<number>(0);
const enableAutoSearch = ref(true);
const serverOnline = ref<boolean | null>(null);
const serverExpanded = ref(false);
const serverDropdownOpen = ref(false);
const pillRef = ref<HTMLElement | null>(null);
const dropdownPos = ref({ top: 0, right: 0 });

function onPillClick() {
  if (!serverExpanded.value) {
    serverExpanded.value = true;
  } else {
    if (pillRef.value) {
      const rect = pillRef.value.getBoundingClientRect();
      dropdownPos.value = { top: rect.bottom + 6, right: window.innerWidth - rect.right };
    }
    serverDropdownOpen.value = !serverDropdownOpen.value;
  }
}

function collapseServer() {
  serverDropdownOpen.value = false;
  serverExpanded.value = false;
}

function closeServerDropdown() {
  if (serverDropdownOpen.value) {
    serverDropdownOpen.value = false;
  } else {
    serverExpanded.value = false;
  }
}

function selectSite(siteId: string) {
  cfg.value.selectedSiteId = siteId;
  serverDropdownOpen.value = false;
}
// Local flag set immediately on click — drives the spinner independently of
// backend push-messages, which can arrive too fast for Vue to render "uploading".
const isSubmitting = ref(false);

const selectedSite = computed(() => {
  if (cfg.value.selectedSiteId) {
    return cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId);
  }
});

const szuru = computed(() => {
  return selectedSite.value ? SzurubooruApi.createFromConfig(selectedSite.value) : undefined;
});

const instanceSpecificData = readonly(
  computed(() => {
    if (pop.selectedPost && cfg.value.selectedSiteId) {
      return pop.selectedPost.instanceSpecificData[cfg.value.selectedSiteId];
    }
  }),
);

// Local upload state — set directly in upload() so the status area is
// always in sync. The instanceSpecificData reactive chain proved unreliable
// for subsequent imports (Vue's ?. short-circuit doesn't always establish
// tracking on fresh objects), so we drive the display from these refs instead.
type UploadPhase = "" | "uploading" | "uploaded" | "error";
const uploadPhase = ref<UploadPhase>("");
const uploadResultPostId = ref<number | undefined>(undefined);
const uploadResultError = ref<string | undefined>(undefined);
const uploadTagsState = ref<{ total: number; current?: number; totalChanged?: number } | undefined>(undefined);
const scrapeError = ref<string | undefined>(undefined);
const showAllTags = ref(false);
const collapsedTagCount = 20;

const sortedTags = computed(() => {
  const tags = [...(pop.selectedPost?.tags ?? [])];

  if (cfg.value.popup.tagSortMode == "usage") {
    tags.sort((a, b) => {
      const usageDelta = (b.usages ?? -1) - (a.usages ?? -1);
      if (usageDelta != 0) return usageDelta;
      return a.name.localeCompare(b.name);
    });
    return tags;
  }

  if (cfg.value.popup.tagSortMode == "category") {
    tags.sort((a, b) => {
      const ca = a.category ?? "zzzz";
      const cb = b.category ?? "zzzz";
      if (ca != cb) return ca.localeCompare(cb);
      return a.name.localeCompare(b.name);
    });
    return tags;
  }

  tags.sort((a, b) => a.name.localeCompare(b.name));
  return tags;
});

const visibleTags = computed(() => {
  if (showAllTags.value) return sortedTags.value;
  return sortedTags.value.slice(0, collapsedTagCount);
});

const hiddenTagCount = computed(() => Math.max(0, sortedTags.value.length - visibleTags.value.length));

const safetySlider = computed<number>({
  get() {
    const rating = pop.selectedPost?.rating;
    if (rating == "safe") return 0;
    if (rating == "sketchy") return 1;
    return 2;
  },
  set(value: number) {
    if (!pop.selectedPost) return;
    if (value <= 0) pop.selectedPost.rating = "safe";
    else if (value >= 2) pop.selectedPost.rating = "unsafe";
    else pop.selectedPost.rating = "sketchy";
  },
});

const safetyOptions = computed(() => [
  { key: "safe", label: t("popup.safe"), value: 0 },
  { key: "sketchy", label: t("popup.sketchy"), value: 1 },
  { key: "unsafe", label: t("popup.unsafe"), value: 2 },
]);

const isUploading = computed(() => uploadPhase.value === "uploading");
const uploadSuccess = computed(() => uploadPhase.value === "uploaded" && !!uploadResultPostId.value);

// Reset local upload state when the user switches to a different post
watch(
  () => pop.selectedPostId,
  () => {
    uploadPhase.value = "";
    uploadResultPostId.value = undefined;
    uploadResultError.value = undefined;
    uploadTagsState.value = undefined;
    showAllTags.value = false;
  },
);

watch(
  () => pop.selectedPostId,
  (value) => {
    if (cfg.value.autoSearchSimilar && enableAutoSearch.value) {
      let selectedPost = pop.posts.find((x) => x.id == value);
      if (selectedPost) findSimilar(selectedPost);
    }

    // When switching to a fallback post that has no tags, copy tags from the first post
    const selected = pop.posts.find((x) => x.id == value);
    const firstPost = pop.posts[0];
    if (selected && firstPost && selected.id !== firstPost.id && selected.tags.length === 0 && firstPost.tags.length > 0) {
      selected.tags.push(...cloneDeep(firstPost.tags));
    }
  },
);

watch(
  () => cfg.value.selectedSiteId,
  async (value, oldValue) => {
    if (value != oldValue) {
      cfg.value.selectedSiteId = value;
      checkServerStatus();
      if (cfg.value.autoSearchSimilar && pop.selectedPost) {
        findSimilar(pop.selectedPost);
      }
    }
  },
);

function openOptionsPage() {
  browser.runtime.openOptionsPage();
}

async function checkServerStatus() {
  if (!szuru.value) { serverOnline.value = false; return; }
  try {
    await szuru.value.getInfo();
    serverOnline.value = true;
  } catch {
    serverOnline.value = false;
  }
}

async function grabPost() {
  scrapeError.value = undefined;

  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    scrapeError.value = t("popup.noActiveTab");
    pop.posts.splice(0);
    return;
  }
  if (isRestrictedTabUrl(activeTab.url)) {
    scrapeError.value = t("popup.restrictedPage");
    pop.posts.splice(0);
    return;
  }

  const raw = await sendTabCommand(activeTab.id, "grab_post");
  const res: ScrapeResults = Object.assign(new ScrapeResults(), raw);

  pop.posts.splice(0);

  for (const result of res.results) {
    for (const [index, scrapedPost] of result.posts.entries()) {
      const vm = new ScrapedPostDetails(scrapedPost);
      vm.name = buildPostDisplayName(result.engine, scrapedPost.name, index);

      // Tag rules, forced content upload and source handling are shared with
      // the background import path so both routes honour the same settings.
      applyConfigToScrapedPost(vm, { ...cfg.value, tagRules: resolveTagRules(cfg.value, cfg.value.selectedSiteId) });

      for (const site of cfg.value.sites) {
        vm.instanceSpecificData[site.id] = {};
      }

      pop.posts.push(vm);
    }
  }

  if (pop.posts.length > 0) {
    enableAutoSearch.value = false;
    pop.selectedPostId = pop.posts[0].id;

    if (cfg.value.loadTagCounts) loadTagCounts();
    if (cfg.value.fetchPostInfo) await fetchPostsInfo();

    enableAutoSearch.value = true;
    if (cfg.value.autoSearchSimilar) findSimilar(pop.selectedPost);
  }
}

async function upload() {
  if (!cfg.value.selectedSiteId || isSubmitting.value) return;
  if (!selectedSite.value || !await ensureInstancePermission(selectedSite.value.domain)) {
    uploadPhase.value = "error";
    uploadResultError.value = "Access to the selected Szurubooru instance was not granted.";
    return;
  }
  const isd = pop.selectedPost?.instanceSpecificData[cfg.value.selectedSiteId];

  if (instanceSpecificData.value?.reverseSearchResult?.exactPostId) return;
  if (uploadPhase.value === "uploaded") return;

  isSubmitting.value = true;
  uploadPhase.value = "uploading";
  uploadResultPostId.value = undefined;
  uploadResultError.value = undefined;
  uploadTagsState.value = undefined;
  // Flush DOM so the "Uploading…" badge is visible before the (possibly fast) upload
  await nextTick();

  try {
    const post: ScrapedPostDetails = cloneDeep(pop.selectedPost)!;
    const activeTabId = await getActiveTabId().catch(() => undefined);

    const cmdData = new PostUploadCommandData(post, <SzuruSiteConfig>cloneDeep(selectedSite.value), activeTabId);
    const finalInfo = await browser.runtime.sendMessage(new BrowserCommand("upload_post", cmdData));
    // finalInfo is the authoritative result (sendMessage return value is always delivered)
    uploadPhase.value = finalInfo?.state ?? "error";
    uploadResultPostId.value = finalInfo?.instancePostId;
    uploadResultError.value = finalInfo?.error;
    uploadTagsState.value = finalInfo?.updateTagsState;
    // Also mirror into the store so other features (merge, reverse search) stay in sync
    if (isd && finalInfo) isd.uploadState = finalInfo;
  } catch (ex: any) {
    console.error("upload sendMessage failed:", ex);
    uploadPhase.value = "error";
    uploadResultError.value = getErrorMessage(ex);
  } finally {
    isSubmitting.value = false;
  }
}

function removeTag(tag: TagDetails) {
  if (pop.selectedPost) {
    const idx = pop.selectedPost.tags.indexOf(tag);
    if (idx != -1) pop.selectedPost.tags.splice(idx, 1);
  }
}

function removePool(pool: PoolDetails) {
  if (pop.selectedPost) {
    const idx = pop.selectedPost.pools.indexOf(pool);
    if (idx != -1) pop.selectedPost.pools.splice(idx, 1);
  }
}

function getActiveSitePostUrl(postId: number): string {
  if (!selectedSite.value) return "";
  return getUrl(selectedSite.value.domain, "post", postId.toString());
}

function getSimilarPosts(data?: DeepReadonly<SimpleImageSearchResult>): SimilarPostInfo[] {
  if (!data) return [];
  const lst: SimilarPostInfo[] = [];
  for (const similarPost of data.similarPosts) {
    if (data.exactPostId == similarPost.postId) continue;
    lst.push(new SimilarPostInfo(similarPost.postId, Math.round(100 - similarPost.distance * 100)));
  }
  return lst;
}

function addTag(tag: TagDetails) {
  if (pop.selectedPost) {
    if (tag.name.length > 0 && pop.selectedPost.tags.find((x) => x.name == tag.name) == undefined) {
      pop.selectedPost.tags.push(tag);
      if (cfg.value.addTagImplications) pop.selectedPost.tags.push(...tag.implications);
    }
  }
}

// Rank tags by how many of the visually similar posts carry them, drop any the
// scrape already produced, and keep the top handful as one-click suggestions.
// The reverse-search response already includes each similar post's full tag
// list, so this needs no extra API calls.
function buildTagSuggestions(post: ScrapedPostDetails, similarPosts: { post: any }[]): TagDetails[] {
  const existing = new Set(post.tags.map((x) => x.name.toLowerCase()));
  const counts = new Map<string, { tag: TagDetails; count: number }>();

  for (const similar of similarPosts) {
    for (const micro of similar.post?.tags ?? []) {
      const name: string | undefined = micro?.names?.[0];
      if (!name) continue;
      const key = name.toLowerCase();
      if (existing.has(key)) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tag: TagDetails.fromMicroTag(micro), count: 1 });
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || (b.tag.usages ?? 0) - (a.tag.usages ?? 0))
    .slice(0, 12)
    .map((x) => x.tag);
}

// Suggestions minus anything the user has meanwhile added, so a chip vanishes
// the moment its tag lands on the post.
const suggestedTags = computed<TagDetails[]>(() => {
  if (!pop.selectedPost || !cfg.value.selectedSiteId) return [];
  const isd = pop.selectedPost.instanceSpecificData[cfg.value.selectedSiteId];
  const suggestions = isd?.suggestedTags;
  if (!suggestions?.length) return [];
  const current = new Set(pop.selectedPost.tags.map((x) => x.name.toLowerCase()));
  return suggestions.filter((tag) => !current.has(tag.name.toLowerCase())) as TagDetails[];
});

function addPool(pool: PoolDetails) {
  if (pop.selectedPost) {
    if (pool.name.length > 0 && pop.selectedPost.pools.find((x) => x.name == pool.name) == undefined) {
      pop.selectedPost.pools.push(pool);
    }
  }
}

async function clickFindSimilar() {
  if (pop.selectedPost) return await findSimilar(pop.selectedPost);
}

async function findSimilar(post: ScrapedPostDetails | undefined) {
  if (!post || !szuru.value || !cfg.value.selectedSiteId) return;

  const selectedInstance = toRaw(szuru.value);
  let isd = post.instanceSpecificData[cfg.value.selectedSiteId];

  if (!isd) {
    console.error("instanceSpecificData is undefined. This should never happen!");
    return;
  }

  if (isd.reverseSearchResult) return;

  isSearchingForSimilarPosts.value++;

  try {
    await ensurePostHasContentToken(selectedInstance, post, cfg);
    const res = await selectedInstance.reverseSearchToken(isd.contentToken!);
    isd.reverseSearchResult = {
      exactPostId: res.exactPost?.id,
      similarPosts: res.similarPosts.map((x) => <SimpleSimilarPost>{ postId: x.post.id, distance: x.distance }),
    };
    isd.suggestedTags = buildTagSuggestions(post, res.similarPosts);
  } catch (ex: any) {
    isd.genericError = "Couldn't reverse search. " + getErrorMessage(ex);
  }

  isSearchingForSimilarPosts.value--;
}

async function loadTagCounts() {
  const allTags = pop.posts.flatMap((x) => x.tags);
  for (let i = 0; i < allTags.length; i += 100) {
    const query = allTags
      .slice(i, i + 101)
      .map((x) => encodeTagName(x.name))
      .join();
    const resp = await szuru.value?.getTags(query);
    if (resp) {
      for (let post of pop.posts)
        for (let tag of resp.results) {
          const found = post.tags.find((postTag) => tag.names.includes(postTag.name));
          if (found) {
            found.usages = tag.usages;
          }
        }
    }
  }
}

async function fetchContentViaActiveTab(url: string): Promise<{ base64: string; mimeType: string }> {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) throw new Error("No active tab");
  if (isRestrictedTabUrl(activeTab.url)) throw new Error("Active tab is a restricted URL");
  return sendTabCommand(activeTab.id, "fetch_content", { url });
}

async function updatePostWithRemoteInfo(post: ScrapedPostDetails, contentUrl: string) {
  try {
    const activeTabId = await getActiveTabId();

    let contentType: string | undefined;
    let contentLength: string | undefined;
    let finalUrl: string | undefined;

    // Try via content script first — it runs in page context with page cookies +
    // Referer, bypassing CDN hotlink protection (e.g. Gelbooru).
    if (activeTabId) {
      try {
        const info: any = await sendTabCommand(activeTabId, "fetch_head_info", { url: contentUrl });
        contentType = info?.contentType;
        contentLength = info?.contentLength;
        finalUrl = info?.finalUrl;
      } catch { /* fall through */ }
    }

    // Fallback: direct fetch from popup context (works for non-CDN-protected sources)
    if (!contentType) {
      const res = await fetch(contentUrl, { method: "HEAD" });
      contentType = res.headers.get("Content-Type") ?? undefined;
      contentLength = res.headers.get("Content-Length") ?? undefined;
      finalUrl = res.url !== contentUrl ? res.url : undefined;
    }

    if (contentType) {
      if (contentType.indexOf("text/html") != -1) {
        throw new Error("Received a text/html content type. Probably no permission to access the resource.");
      }
      const [_main, sub] = contentType.split("/");
      if (sub) post.contentSubType = sub.toUpperCase();
    }

    if (contentLength) post.contentSize = parseInt(contentLength);

    const resolvedUrl = finalUrl ?? contentUrl;
    if (resolvedUrl != post.contentUrl) {
      console.log(`Updating post.contentUrl to '${resolvedUrl}'`);
      post.contentUrl = resolvedUrl;
    }

    return true;
  } catch (ex) {
    console.error(ex);
    return false;
  }
}

async function fetchPostsInfo() {
  for (const post of pop.posts) {
    if (!post.contentSize || post.extraContentUrl) {
      let ok = false;
      if (post.extraContentUrl) ok = await updatePostWithRemoteInfo(post, post.extraContentUrl);
      if (!ok) await updatePostWithRemoteInfo(post, post.contentUrl);
    }
  }
}

function getUpdatedTagsText(count: number) {
  return t("popup.updatedTags", { count });
}

function setSafety(level: number) {
  safetySlider.value = level;
}

function onResolutionLoaded(res: any) {
  if (pop.selectedPost) pop.selectedPost.resolution = res;
}

const VIDEO_FORMATS = new Set(['mp4','webm','mov','avi','mkv','flv','wmv','m4v','ogv']);
const GIF_FORMATS   = new Set(['gif','apng','avif']);

function getFormatChipClass(format?: string): string {
  if (!format) return '';
  const f = format.toLowerCase();
  if (GIF_FORMATS.has(f))   return 'glass-chip-gif';
  if (VIDEO_FORMATS.has(f)) return 'glass-chip-video';
  return 'glass-chip-image';
}

// Force exact popup-window size to avoid Firefox caching the old 780px width.
// `html { width: max-content }` resolves to viewport width (= cached popup size),
// so we set the inline style explicitly instead.
function applyPopupSize() {
  const html = document.documentElement;
  if (pop.selectedPost) {
    html.style.width = "780px";
    html.style.height = "540px";
  } else {
    html.style.width = "530px";
    html.style.height = "93px";
  }
}
watch(() => pop.selectedPost, applyPopupSize, { immediate: true });

onMounted(() => {
  checkServerStatus();
  if (pop.posts.length == 0) {
    void grabPost().catch((ex) => {
      scrapeError.value = getErrorMessage(ex);
      pop.posts.splice(0);
    });
  }
  document.addEventListener("click", closeServerDropdown);
});

onUnmounted(() => {
  document.removeEventListener("click", closeServerDropdown);
});

useDark();
</script>

<template>
  <!-- Compact: no content / restricted page view -->
  <div v-if="!pop.selectedPost" class="glass-compact" :class="{ mobile: isMobile }">

    <!-- Row 1: brand · server picker · settings -->
    <div class="gc-bar">
      <div class="gc-brand">
        <img :src="extIconUrl" class="glass-ext-icon" alt="" />
        <span class="gc-brand-name">SzuruChrome</span>
      </div>
      <div class="gc-controls">
        <!-- Server picker (same markup as main popup) -->
        <div class="glass-server-picker" v-if="cfg.sites.length > 0" ref="pillRef">
          <div
            class="glass-server-pill"
            :class="{ expanded: serverExpanded, open: serverDropdownOpen }"
            @click.stop="onPillClick"
            :title="!serverExpanded ? (selectedSite?.domain ?? 'Server wählen') : ''"
          >
            <span class="glass-server-pill-icon">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="2" width="13" height="4" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <rect x="1.5" y="10" width="13" height="4" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <line x1="1.5" y1="7" x2="14.5" y2="7" stroke="currentColor" stroke-width="1.2"/>
                <circle cx="12" cy="4" r="1" fill="currentColor"/>
                <circle cx="12" cy="12" r="1" fill="currentColor"/>
              </svg>
            </span>
            <span class="glass-server-pill-content">
              <span class="glass-server-pill-dot" :class="serverOnline === true ? 'online' : serverOnline === false ? 'offline' : ''"></span>
              <span class="glass-server-pill-domain">{{ selectedSite?.domain ?? '—' }}</span>
            </span>
            <button class="glass-server-pill-collapse" @click.stop="collapseServer" tabindex="-1">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M3.5 2l3.5 3-3.5 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <Teleport to="body">
            <Transition name="server-dropdown">
              <div
                v-if="serverDropdownOpen"
                class="glass-server-dropdown"
                :style="{ top: dropdownPos.top + 'px', right: dropdownPos.right + 'px' }"
                @click.stop
              >
                <div class="glass-server-dropdown-header">Server</div>
                <button
                  v-for="site in cfg.sites"
                  :key="site.id"
                  class="glass-server-option"
                  :class="{ active: site.id === cfg.selectedSiteId }"
                  @click="selectSite(site.id)"
                >
                  <span class="glass-server-option-dot" :class="site.id === cfg.selectedSiteId && serverOnline === true ? 'online' : site.id === cfg.selectedSiteId && serverOnline === false ? 'offline' : ''"></span>
                  <span class="glass-server-option-domain">{{ site.domain }}</span>
                  <svg v-if="site.id === cfg.selectedSiteId" class="glass-server-option-check" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
            </Transition>
          </Teleport>
        </div>

        <button class="glass-icon-btn" @click="openOptionsPage" title="Settings">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06M12.95 12.95l-1.06-1.06M4.11 4.11L3.05 3.05" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Row 2: status message · hotkey toggles -->
    <div class="gc-info-row">
      <span class="gc-status-msg" :class="{ 'gc-status-error': !!scrapeError }" :title="scrapeError || t('popup.noContent')">
        {{ scrapeError || t("popup.noContent") }}
      </span>
    </div>

    <!-- A batch keeps running on pages the popup has nothing else to say about. -->
    <BatchProgressBar />

  </div>

  <!-- â"€â"€ Main popup â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ -->
  <div v-else class="glass-root" :class="{ mobile: isMobile }">

    <!-- Top chrome bar -->
    <header class="glass-chrome">
      <div class="glass-chrome-left">
        <img :src="extIconUrl" class="glass-ext-icon" alt="SzuruChrome" />
        <span class="glass-server-status" :class="serverOnline === true ? 'online' : serverOnline === false ? 'offline' : 'checking'">
          <span class="glass-status-dot"></span>
          {{ serverOnline === true ? 'Online' : serverOnline === false ? 'Offline' : '...' }}
        </span>
      </div>
      <div class="glass-chrome-controls">
        <select class="glass-select" v-model="pop.selectedPostId">
          <option v-for="post in pop.posts" :key="post.id" :value="post.id">
            {{ post.name }}{{ getPostInfoSummary(post) ? ' — ' + getPostInfoSummary(post) : '' }}
          </option>
        </select>

        <!-- Server picker -->
        <div class="glass-server-picker" v-if="cfg.sites.length > 0" ref="pillRef">
          <div
            class="glass-server-pill"
            :class="{ expanded: serverExpanded, open: serverDropdownOpen }"
            @click.stop="onPillClick"
            :title="!serverExpanded ? (selectedSite?.domain ?? 'Server wählen') : ''"
          >
            <!-- DB icon (immer sichtbar, linker Anker) -->
            <span class="glass-server-pill-icon">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <rect x="1.5" y="2" width="13" height="4" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <rect x="1.5" y="10" width="13" height="4" rx="1.5" stroke="currentColor" stroke-width="1.2"/>
                <line x1="1.5" y1="7" x2="14.5" y2="7" stroke="currentColor" stroke-width="1.2"/>
                <circle cx="12" cy="4" r="1" fill="currentColor"/>
                <circle cx="12" cy="12" r="1" fill="currentColor"/>
              </svg>
            </span>
            <!-- Expandierbarer Inhalt: Status-Dot + Domain -->
            <span class="glass-server-pill-content">
              <span class="glass-server-pill-dot" :class="serverOnline === true ? 'online' : serverOnline === false ? 'offline' : ''"></span>
              <span class="glass-server-pill-domain">{{ selectedSite?.domain ?? '—' }}</span>
            </span>
            <!-- Einklapp-Pfeil (nach rechts) -->
            <button class="glass-server-pill-collapse" @click.stop="collapseServer" tabindex="-1" title="Einklappen">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M3.5 2l3.5 3-3.5 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <Teleport to="body">
            <Transition name="server-dropdown">
              <div
                v-if="serverDropdownOpen"
                class="glass-server-dropdown"
                :style="{ top: dropdownPos.top + 'px', right: dropdownPos.right + 'px' }"
                @click.stop
              >
                <div class="glass-server-dropdown-header">Server</div>
                <button
                  v-for="site in cfg.sites"
                  :key="site.id"
                  class="glass-server-option"
                  :class="{ active: site.id === cfg.selectedSiteId }"
                  @click="selectSite(site.id)"
                >
                  <span class="glass-server-option-dot" :class="site.id === cfg.selectedSiteId && serverOnline === true ? 'online' : site.id === cfg.selectedSiteId && serverOnline === false ? 'offline' : ''"></span>
                  <span class="glass-server-option-domain">{{ site.domain }}</span>
                  <svg v-if="site.id === cfg.selectedSiteId" class="glass-server-option-check" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              </div>
            </Transition>
          </Teleport>
        </div>

        <button class="glass-icon-btn" @click="openOptionsPage" title="Settings">
          <!-- Settings icon -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.2"/>
            <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06M12.95 12.95l-1.06-1.06M4.11 4.11L3.05 3.05" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </header>

    <BatchProgressBar />

    <!-- Status ribbon -->
    <div class="glass-status-area" v-if="uploadPhase || isSearchingForSimilarPosts > 0 || instanceSpecificData?.reverseSearchResult?.exactPostId || instanceSpecificData?.reverseSearchResult?.similarPosts.length === 0 || getSimilarPosts(instanceSpecificData?.reverseSearchResult).length > 0 || instanceSpecificData?.genericError">
      <div v-if="instanceSpecificData?.reverseSearchResult?.exactPostId" class="glass-status glass-status-warn">
        <span>{{ t("popup.alreadyUploaded") }}
          <a :href="getActiveSitePostUrl(instanceSpecificData.reverseSearchResult.exactPostId)" target="_blank">#{{ instanceSpecificData.reverseSearchResult.exactPostId }}</a>
        </span>
        <router-link class="glass-pill-link" :to="{ name: 'merge', params: { siteId: cfg.selectedSiteId, postId: instanceSpecificData.reverseSearchResult.exactPostId } }">{{ t("popup.merge") }}</router-link>
      </div>
      <div v-if="uploadPhase === 'error' && uploadResultError" class="glass-status glass-status-error">{{ uploadResultError }}</div>
      <div v-if="instanceSpecificData?.genericError" class="glass-status glass-status-error">{{ instanceSpecificData.genericError }}</div>
      <div v-if="uploadSuccess" class="glass-status glass-status-success">
        {{ t("popup.importedAs") }}
        <a :href="getActiveSitePostUrl(uploadResultPostId!)" target="_blank">{{ t("popup.post") }} #{{ uploadResultPostId }}</a>
        <span v-if="uploadTagsState?.totalChanged"> — {{ getUpdatedTagsText(uploadTagsState.totalChanged) }}</span>
      </div>
      <div v-if="isUploading" class="glass-status glass-status-info">
        <span class="glass-spinner"></span>
        <span v-if="uploadTagsState?.current">{{ t("popup.updatingTags", { current: uploadTagsState.current, total: uploadTagsState.total }) }}</span>
        <span v-else-if="uploadTagsState?.total">{{ t("popup.tagsNeedUpdate", { total: uploadTagsState.total }) }}</span>
        <span v-else>{{ t("popup.uploading") }}</span>
      </div>
      <div v-if="isSearchingForSimilarPosts > 0 && !uploadPhase" class="glass-status glass-status-info">
        <span class="glass-spinner"></span> {{ t("popup.searchingSimilar") }}
      </div>
      <div v-if="instanceSpecificData?.reverseSearchResult?.similarPosts.length === 0 && !uploadPhase" class="glass-status glass-status-muted">{{ t("popup.noSimilar") }}</div>
      <div v-for="sp in getSimilarPosts(instanceSpecificData?.reverseSearchResult)" :key="sp.id" class="glass-status glass-status-warn">
        <span>{{ t("popup.similarPost", { id: sp.id, pct: sp.percentage }) }} <a :href="getActiveSitePostUrl(sp.id)" target="_blank">#{{ sp.id }}</a></span>
        <router-link class="glass-pill-link" :to="{ name: 'merge', params: { siteId: cfg.selectedSiteId, postId: sp.id } }">{{ t("popup.merge") }}</router-link>
      </div>
    </div>

    <!-- 2-col grid -->
    <div class="glass-grid">

      <!-- LEFT COLUMN: controls -->
      <div class="glass-col glass-col-controls">
        <div class="glass-scroll">

          <!-- Safety -->
          <section class="glass-card">
            <span class="glass-card-label">{{ t("popup.safety") }}</span>
            <div class="glass-safety-row">
              <button
                v-for="opt in safetyOptions" :key="opt.key"
                :class="['glass-safety-btn', `tone-${opt.key}`, { active: pop.selectedPost.rating === opt.key }]"
                @click="setSafety(opt.value)"
              >
                <span class="glass-safety-dot"></span>
                <span>{{ opt.label }}</span>
              </button>
            </div>
          </section>

          <!-- Tags -->
          <section class="glass-card glass-card-flush">
            <PopupSection :header="t('popup.tags')" toggleable v-model="uiState.popup.expandTags">
              <div class="section-row">
                <TagInput :szuru="szuru" @add-tag="addTag" />
              </div>
              <div v-if="suggestedTags.length > 0" class="section-row glass-suggest-row">
                <span class="glass-suggest-label">{{ t("popup.suggestedTags") }}</span>
                <ul class="glass-suggest-list">
                  <li v-for="tag in suggestedTags" :key="tag.name">
                    <button class="glass-suggest-chip" :class="getTagClasses(tag)" @click="addTag(tag)" :title="t('popup.suggestedTagsAdd')">
                      <span v-html="breakTagName(tag.name)"></span>
                      <span class="glass-suggest-plus">+</span>
                    </button>
                  </li>
                </ul>
              </div>
              <div class="section-row glass-tags-toolbar">
                <select v-model="cfg.popup.tagSortMode" class="glass-select glass-select-xs">
                  <option value="usage">{{ t("popup.sortUsage") }}</option>
                  <option value="category">{{ t("popup.sortCategory") }}</option>
                  <option value="name">{{ t("popup.sortName") }}</option>
                </select>
                <button v-if="hiddenTagCount > 0" class="glass-btn-xs" @click="showAllTags = true">+{{ hiddenTagCount }}</button>
                <button v-else-if="showAllTags && sortedTags.length > collapsedTagCount" class="glass-btn-xs" @click="showAllTags = false">{{ t("popup.showLess") }}</button>
              </div>
              <div class="section-row">
                <transition-group name="tag-fade" tag="ul" class="compact-tags animated-tags">
                  <li v-for="tag in visibleTags" :key="tag.name">
                    <a class="remove-tag" @click="removeTag(tag)">×</a>
                    <span :class="getTagClasses(tag)" v-html="breakTagName(tag.name)"></span>
                    <span v-if="cfg.loadTagCounts" class="tag-usages tag-usages-reserve-space">{{ tag.usages ? tag.usages : "" }}</span>
                  </li>
                </transition-group>
              </div>
            </PopupSection>
          </section>

          <!-- Pools -->
          <section v-if="cfg.popup.showPools" class="glass-card glass-card-flush">
            <PopupSection :header="t('popup.pools')" toggleable v-model="uiState.popup.expandPools">
              <div class="section-row">
                <PoolInput :szuru="szuru" @add-pool="addPool" />
              </div>
              <div class="section-row">
                <CompactPools :pools="pop.selectedPost.pools" :show-remove-pool="true" show-post-count @remove-pool="removePool" />
              </div>
            </PopupSection>
          </section>

          <!-- Source -->
          <section v-if="cfg.popup.showSource" class="glass-card">
            <span class="glass-card-label">{{ t("popup.source") }}</span>
            <textarea class="glass-textarea" v-model="pop.selectedPost.source" rows="2"></textarea>
          </section>

        </div>
      </div>

      <!-- RIGHT COLUMN: preview -->
      <div class="glass-col glass-col-preview">
        <div class="glass-preview-pane">
          <PostContentDisplay
            :content-url="pop.selectedPost.contentUrl"
            :content-type="pop.selectedPost.contentType"
            :fetch-via-content-script="fetchContentViaActiveTab"
            @on-resolution-loaded="onResolutionLoaded"
          />
        </div>
        <div class="glass-preview-footer">
          <div class="glass-preview-meta">
            <span class="glass-chip" :class="getFormatChipClass(pop.selectedPost.contentSubType || pop.selectedPost.contentType)">{{ pop.selectedPost.contentSubType || pop.selectedPost.contentType }}</span>
            <span v-if="getPostInfoSummary(pop.selectedPost)" class="glass-chip glass-chip-dim">{{ getPostInfoSummary(pop.selectedPost) }}</span>
          </div>
          <div class="glass-preview-links">
            <a v-if="uploadSuccess" class="glass-chip glass-chip-link" :href="getActiveSitePostUrl(uploadResultPostId!)" target="_blank">#{{ uploadResultPostId }}</a>
          </div>
        </div>
      </div>

    </div>

    <!-- Import bar -->
    <PopupActionBar
      :show-find-similar="!cfg.autoSearchSimilar"
      :is-submitting="isSubmitting"
      :is-uploading="isUploading"
      :upload-success="uploadSuccess"
      :has-exact-match="!!instanceSpecificData?.reverseSearchResult?.exactPostId"
      :find-similar-label="t('popup.findSimilar')"
      :importing-label="t('popup.importing')"
      :imported-label="t('popup.imported')"
      :import-label="t('popup.import')"
      @find-similar="clickFindSimilar"
      @upload="upload"
    />

  </div>
</template>
<style scoped lang="scss" src="./PopupMain.scss"></style>

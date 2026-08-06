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
import { applyConfigToScrapedPost, buildPostDisplayName } from "~/shared/scrape";
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
import { cfg, usePopupStore } from "~/stores";
import SzurubooruApi from "~/api";
import PopupActionBar from "~/popup/components/PopupActionBar.vue";

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

const safetyLabel = computed(() => {
  if (safetySlider.value == 0) return t("popup.safe");
  if (safetySlider.value == 1) return t("popup.sketchy");
  return t("popup.unsafe");
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
      applyConfigToScrapedPost(vm, cfg.value);

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
            <PopupSection :header="t('popup.tags')" toggleable v-model="cfg.popup.expandTags">
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
            <PopupSection :header="t('popup.pools')" toggleable v-model="cfg.popup.expandPools">
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
<style scoped lang="scss">
/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SzuruChrome Popup — iOS Liquid Glass Design
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* â”€â”€ Design tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-root,
.glass-empty,
.glass-compact {
  --g-bg: rgba(13, 16, 23, 0.88);
  --g-surface: rgba(255, 255, 255, 0.055);
  --g-surface-hi: rgba(255, 255, 255, 0.085);
  --g-border: rgba(255, 255, 255, 0.09);
  --g-border-hi: rgba(255, 255, 255, 0.16);
  --g-text: rgba(255, 255, 255, 0.9);
  --g-text-2: rgba(255, 255, 255, 0.5);
  --g-text-3: rgba(255, 255, 255, 0.28);
  --g-accent: #6e8eff;
  --g-accent-soft: rgba(110, 142, 255, 0.14);
  --g-accent-glow: rgba(110, 142, 255, 0.22);
  --g-safe: #34d399;
  --g-warn: #fbbf24;
  --g-danger: #f87171;
  --g-info: #60a5fa;
  --g-radius: 18px;
  --g-radius-md: 12px;
  --g-radius-sm: 8px;
  --g-blur: 28px;
  --g-ease: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --g-transition: 200ms var(--g-ease);
  color-scheme: dark;
  font-family: -apple-system, "SF Pro Display", "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
}

/* â”€â”€ Root shell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-root {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 780px;
  height: 540px;
  padding: 8px;
  gap: 5px;
  background: var(--g-bg);
  border-radius: 0;
  box-sizing: border-box;
  color: var(--g-text);
  font-size: 12.5px;
  line-height: 1.45;
  overflow: hidden;
  animation: g-enter 300ms var(--g-ease) both;

  /* subtle ambient glow — very faint */
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: inherit;
    background:
      radial-gradient(ellipse 60% 50% at 20% 0%, rgba(110, 142, 255, 0.03), transparent),
      radial-gradient(ellipse 50% 40% at 80% 100%, rgba(110, 142, 255, 0.02), transparent);
  }

  &.mobile {
    width: 100%;
    height: auto;
    max-height: 94vh;
    .glass-grid { flex-direction: column; }
    .glass-col { width: 100%; flex: none; }
    .glass-col-preview { max-height: 280px; }
  }
}

/* â”€â”€ Glass surface mixin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
@mixin glass-panel {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(24px) saturate(130%);
  -webkit-backdrop-filter: blur(24px) saturate(130%);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: var(--g-radius-md);
  transition: border-color var(--g-transition), box-shadow var(--g-transition);
}

/* â”€â”€ Chrome bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 8px;
  @include glass-panel;
}

.glass-chrome-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 1;
}

.glass-chrome-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.glass-chrome-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--g-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.glass-chrome-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

/* â”€â”€ Orb (brand icon) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-orb {
  position: relative;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: linear-gradient(145deg, rgba(110, 142, 255, 0.18), rgba(110, 142, 255, 0.06));
  border: 1px solid rgba(110, 142, 255, 0.18);

  span {
    position: absolute;
    inset: 5px;
    border-radius: 6px;
    background:
      radial-gradient(circle at 36% 36%, rgba(255, 255, 255, 0.7), transparent 35%),
      linear-gradient(150deg, #6e8eff, #4b62d1);
    box-shadow: 0 0 10px rgba(110, 142, 255, 0.3);
  }
}

.glass-orb-sm { width: 24px; height: 24px; span { inset: 4px; border-radius: 5px; } }

.glass-ext-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  object-fit: contain;
  border-radius: 5px;
}

/* â"€â"€ Server status indicator â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€ */
.glass-server-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--g-text-2);

  .glass-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--g-text-3);
    transition: background 300ms, box-shadow 300ms;
  }

  &.online {
    color: var(--g-safe);
    .glass-status-dot {
      background: var(--g-safe);
      box-shadow: 0 0 6px rgba(52, 211, 153, 0.5);
    }
  }
  &.offline {
    color: var(--g-danger);
    .glass-status-dot {
      background: var(--g-danger);
      box-shadow: 0 0 6px rgba(248, 113, 113, 0.5);
    }
  }
  &.checking {
    .glass-status-dot {
      animation: g-pulse 1s ease infinite;
    }
  }
}

@keyframes g-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.glass-eyebrow {
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--g-text-2);
}

/* â”€â”€ Status area â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-status-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}

.glass-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 10px;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  background: var(--g-surface);
  font-size: 11px;
  line-height: 1.3;
  animation: g-status-in 200ms var(--g-ease) both;

  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }

  &.glass-status-error  { color: #fca5a5; border-color: rgba(248, 113, 113, 0.18); background: rgba(127, 29, 29, 0.2); }
  &.glass-status-warn   { color: #fcd34d; border-color: rgba(251, 191, 36, 0.18); background: rgba(120, 77, 0, 0.15); }
  &.glass-status-success { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.18); background: rgba(6, 78, 59, 0.2); }
  &.glass-status-info   { color: #93c5fd; border-color: rgba(96, 165, 250, 0.18); background: rgba(23, 37, 84, 0.2); }
  &.glass-status-muted  { color: var(--g-text-3); }
}

.glass-pill-link {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none !important;
  opacity: 0.75;
  transition: opacity var(--g-transition);
  &:hover { opacity: 1; }
}

/* â”€â”€ 2-col grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-grid {
  display: flex;
  flex: 1 1 0;
  gap: 6px;
  min-height: 0;
  overflow: hidden;
}

.glass-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.glass-col-controls {
  flex: 1 1 0;
  min-width: 0;
  @include glass-panel;
  overflow: hidden;
}

.glass-col-preview {
  flex: 1 1 0;
  min-width: 0;
  @include glass-panel;
  overflow: hidden;
}

.glass-scroll {
  flex: 1 1 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.1) transparent;

  &::-webkit-scrollbar { width: 3px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(255, 255, 255, 0.1); }
}

/* â”€â”€ Glass card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-card {
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-sm);
  background: var(--g-surface);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.glass-card-flush { padding: 0; }

.glass-card-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--g-text-2);
}

/* â”€â”€ Safety selector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-safety-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}

.glass-safety-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 4px;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  background: transparent;
  color: var(--g-text-2);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all var(--g-transition);

  &:hover { border-color: var(--g-border-hi); }

  &.active { color: var(--g-text); }
  &.tone-safe.active   { border-color: rgba(52, 211, 153, 0.4); background: rgba(6, 78, 59, 0.2); }
  &.tone-sketchy.active { border-color: rgba(251, 191, 36, 0.4); background: rgba(120, 77, 0, 0.15); }
  &.tone-unsafe.active  { border-color: rgba(248, 113, 113, 0.4); background: rgba(127, 29, 29, 0.18); }
}

.glass-safety-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.6);
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
}

/* â”€â”€ Section header overrides (PopupSection) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
:deep(.popup-section) {
  border: none;
  border-radius: 0;
  background: transparent;
}

:deep(.section-header) {
  min-height: 28px;
  padding: 0 10px;
  background: var(--g-surface-hi);
  border-bottom: 1px solid var(--g-border);
  display: flex;
  align-items: center;
  justify-content: space-between;

  > span {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--g-text-2);
  }

  &.toggleable { cursor: pointer; }
  &.toggleable:hover { background: rgba(255, 255, 255, 0.06); }

  svg { color: var(--g-text-3); font-size: 9px; }
}

:deep(.section-row) { margin: 0; padding: 6px 10px 4px; }

/* â”€â”€ Tags toolbar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-tags-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
}

.glass-btn-xs {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: transparent;
  color: var(--g-text-2);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--g-transition);
  &:hover { border-color: var(--g-border-hi); color: var(--g-text); }
}

/* â”€â”€ Suggested tags (from reverse search) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-suggest-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.glass-suggest-label {
  flex-shrink: 0;
  padding-top: 3px;
  color: var(--g-text-2);
  font-size: 10px;
  font-weight: 600;
}

.glass-suggest-list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.glass-suggest-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px dashed var(--g-border-hi);
  background: transparent;
  color: var(--g-text);
  font-size: 10px;
  line-height: 1.3;
  cursor: pointer;
  transition: all var(--g-transition);

  &:hover {
    border-style: solid;
    background: var(--g-surface);
    transform: translateY(-1px);
  }
}

.glass-suggest-plus {
  opacity: 0.55;
  font-weight: 700;
}

/* â”€â”€ Compact tags / pools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
:deep(.compact-tags),
:deep(.compact-pools) {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;

  li {
    min-height: 0;
    padding: 2px 6px;
    border-radius: 999px;
    border: 1px solid var(--g-border);
    background: var(--g-surface);
    font-size: 10px;
    line-height: 1.3;
    transition: border-color var(--g-transition), background var(--g-transition), box-shadow var(--g-transition), transform 150ms var(--g-ease);
    cursor: default;
    &:hover {
      border-color: var(--g-border-hi);
      background: var(--g-surface-hi);
      transform: translateY(-1px);
      box-shadow: 0 2px 6px -2px rgba(0, 0, 0, 0.3);
    }
  }
}

:deep(.remove-tag) {
  width: 14px;
  text-align: center;
  opacity: 0.4;
  transition: opacity var(--g-transition);
  &:hover { opacity: 1; }
}

:deep(.tag-usages) { font-size: 9px; color: var(--g-text-3); }

.tag-usages-reserve-space { min-width: 5ch; display: inline-block; }
.animated-tags { position: relative; }

/* Tag category color indicators */
:deep([class*="tag-"]) {
  transition: color var(--g-transition);
}
/* Subtle glow only for non-general categories (artist, character, copyright, meta, etc.) */
:deep([class*="tag-"]:not(.tag-general):not(.tag-default)) {
  background: color-mix(in srgb, currentColor 6%, transparent) !important;
  border-color: color-mix(in srgb, currentColor 10%, transparent) !important;
}

/* â”€â”€ Autocomplete overrides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
:deep(.autocomplete-wrap) { gap: 4px; }
:deep(.autocomplete-input-row) { gap: 4px; }

:deep(.autocomplete-field) {
  height: 26px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-sm);
  background: var(--g-surface);
  color: var(--g-text);
  font-size: 11px;
  padding: 0 8px;
  transition: border-color var(--g-transition), box-shadow var(--g-transition);

  &:focus {
    outline: none;
    border-color: rgba(110, 142, 255, 0.4);
    box-shadow: 0 0 0 3px var(--g-accent-soft);
  }
}

:deep(.autocomplete-add-btn) {
  height: 26px;
  padding: 0 10px;
  border-radius: var(--g-radius-sm);
  border: 1px solid rgba(110, 142, 255, 0.25);
  background: var(--g-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 2px 8px -4px var(--g-accent-glow);
}

:deep(.autocomplete-items) {
  top: 32px;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border-hi);
  background: rgba(14, 17, 23, 0.97);
  backdrop-filter: blur(20px);
  font-size: 11px;
}

/* â”€â”€ Form elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-select {
  height: 26px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-sm);
  background: var(--g-surface);
  color: var(--g-text);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--g-transition), box-shadow var(--g-transition);

  &:focus {
    outline: none;
    border-color: rgba(110, 142, 255, 0.4);
    box-shadow: 0 0 0 3px var(--g-accent-soft);
  }

  option { background: #161b22; color: #e5e7eb; }
}

.glass-select-sm { max-width: 120px; }

.glass-select-xs {
  height: 22px;
  padding: 0 6px;
  font-size: 10px;
  border-radius: 6px;
}

.glass-textarea {
  width: 100%;
  min-height: 40px;
  padding: 6px 8px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-sm);
  background: var(--g-surface);
  color: var(--g-text);
  font-size: 11px;
  font-family: inherit;
  resize: vertical;
  transition: border-color var(--g-transition);

  &:focus {
    outline: none;
    border-color: rgba(110, 142, 255, 0.4);
    box-shadow: 0 0 0 3px var(--g-accent-soft);
  }
}

/* â”€â”€ Icon button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-icon-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  background: var(--g-surface);
  color: var(--g-text);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--g-transition);

  &:hover {
    border-color: var(--g-border-hi);
    background: var(--g-surface-hi);
    transform: translateY(-1px);
  }

  &.active {
    border-color: var(--g-accent);
    background: var(--g-accent-soft);
    color: var(--g-accent);
  }
}

/* ── Server picker ────────────────────────────────────────── */
.glass-server-picker {
  position: relative;
}

/* ── Server pill (kollabiert ↔ expandiert) ─────────────── */
.glass-server-pill {
  display: flex;
  align-items: center;
  height: 26px;
  max-width: 26px;
  overflow: hidden;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  background: var(--g-surface);
  color: var(--g-text);
  cursor: pointer;
  transition: max-width 300ms var(--g-ease), border-color 180ms, background 180ms, box-shadow 180ms;

  &:hover {
    border-color: var(--g-border-hi);
    background: var(--g-surface-hi);
  }

  &.expanded {
    max-width: 220px;
    border-color: var(--g-border-hi);
  }

  &.open {
    border-color: var(--g-accent);
    box-shadow: 0 0 0 1px var(--g-accent) inset;
  }
}

.glass-server-pill-icon {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.glass-server-pill-content {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 2px 0 0;
  opacity: 0;
  transform: translateX(8px);
  transition: opacity 220ms var(--g-ease) 100ms, transform 220ms var(--g-ease) 100ms;
  min-width: 0;
  pointer-events: none;

  .expanded & {
    opacity: 1;
    transform: translateX(0);
  }
}

.glass-server-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--g-text-3);
  flex-shrink: 0;
  transition: background 300ms, box-shadow 300ms;

  &.online  { background: var(--g-safe);   box-shadow: 0 0 5px rgba(52, 211, 153, 0.5); }
  &.offline { background: var(--g-danger); box-shadow: 0 0 5px rgba(248, 113, 113, 0.5); }
}

.glass-server-pill-domain {
  font-size: 11px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--g-text);
}

.glass-server-pill-collapse {
  flex-shrink: 0;
  width: 22px;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--g-text-3);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: translateX(10px);
  transition: opacity 200ms var(--g-ease) 140ms, transform 200ms var(--g-ease) 140ms, color 150ms;

  .expanded & {
    opacity: 1;
    transform: translateX(0);
  }

  &:hover {
    color: var(--g-text);
  }
}

.glass-server-dropdown {
  position: fixed;
  min-width: 180px;
  background: rgba(14, 17, 24, 0.97);
  border: 1px solid var(--g-border-hi);
  border-radius: var(--g-radius-md);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 8px 32px -8px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.04) inset;
  overflow: hidden;
  z-index: 100;
  transform-origin: top right;
}

.glass-server-dropdown-header {
  padding: 6px 10px 4px;
  font-size: 8.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--g-text-3);
  border-bottom: 1px solid var(--g-border);
}

.glass-server-option {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  color: var(--g-text);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background var(--g-transition);

  &:hover { background: rgba(255, 255, 255, 0.06); }
  &.active { color: var(--g-accent); }
}

.glass-server-option-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--g-text-3);
  flex-shrink: 0;
  transition: background 300ms;

  &.online  { background: var(--g-safe); box-shadow: 0 0 5px rgba(52, 211, 153, 0.5); }
  &.offline { background: var(--g-danger); box-shadow: 0 0 5px rgba(248, 113, 113, 0.5); }
}

.glass-server-option-domain {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.glass-server-option-check {
  flex-shrink: 0;
  color: var(--g-accent);
  opacity: 0.8;
}

/* Dropdown transition */
.server-dropdown-enter-active {
  transition: opacity 180ms var(--g-ease), transform 180ms var(--g-ease);
}
.server-dropdown-leave-active {
  transition: opacity 130ms var(--g-ease), transform 130ms var(--g-ease);
}
.server-dropdown-enter-from,
.server-dropdown-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-6px);
}

/* â”€â”€ Preview pane â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-preview-pane {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: transparent;

  :deep(.post-container) {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :deep(img),
  :deep(video) {
    max-width: calc(100% - 16px);
    max-height: calc(100% - 16px);
    object-fit: contain;
    border-radius: var(--g-radius-md);
    box-shadow: 0 8px 32px -12px rgba(0, 0, 0, 0.5);
  }
}

.glass-preview-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid var(--g-border);
  flex-shrink: 0;
}

.glass-preview-meta {
  display: flex;
  gap: 4px;
  align-items: center;
}

/* â”€â”€ Chips â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: var(--g-surface);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--g-text);
}

.glass-chip-dim { color: var(--g-text-3); }

/* Format chip colors */
.glass-chip-video {
  color: #60a5fa;
  border-color: rgba(96, 165, 250, 0.3);
  background: rgba(96, 165, 250, 0.08);
}
.glass-chip-gif {
  color: #a78bfa;
  border-color: rgba(167, 139, 250, 0.3);
  background: rgba(167, 139, 250, 0.08);
}
.glass-chip-image {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.08);
}

.glass-chip-link {
  text-decoration: none;
  cursor: pointer;
  transition: border-color var(--g-transition);
  &:hover { border-color: var(--g-border-hi); }
}

/* â”€â”€ Hotkey toggles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-preview-links {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* â”€â”€ Action bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-action-bar {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  padding: 2px 0 0;
}

.glass-btn {
  flex: 1;
  min-height: 32px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: var(--g-radius-md);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  letter-spacing: 0.01em;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all var(--g-transition);
  white-space: nowrap;

  &:disabled { opacity: 0.35; cursor: not-allowed; }
  &:not(:disabled):hover { transform: translateY(-1px); }
}

.glass-btn-primary {
  background: var(--g-accent);
  color: #fff;
  border-color: rgba(110, 142, 255, 0.3);
  box-shadow: 0 4px 16px -8px var(--g-accent-glow);

  &:not(:disabled):hover { box-shadow: 0 6px 22px -6px var(--g-accent-glow); }
}

.glass-btn-ghost {
  flex: 0 0 auto;
  background: var(--g-surface);
  color: var(--g-text);
  border-color: var(--g-border);

  &:not(:disabled):hover { border-color: var(--g-border-hi); }
}

/* â”€â”€ Spinner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
@keyframes g-spin { to { transform: rotate(360deg); } }

.glass-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: g-spin 0.65s linear infinite;
  flex-shrink: 0;
}

.glass-spinner-sm { width: 12px; height: 12px; }

/* â”€â”€ Animations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
@keyframes g-enter {
  from { opacity: 0; transform: translateY(6px) scale(0.99); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes g-status-in {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}

.tag-fade-enter-active,
.tag-fade-leave-active,
.tag-fade-move { transition: all 180ms var(--g-ease); }

.tag-fade-enter-from,
.tag-fade-leave-to { opacity: 0; transform: translateY(3px); }

/* â”€â”€ Compact “no content” shell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-compact {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 530px;
  height: 93px;
  padding: 10px 8px;
  background: var(--g-bg);
  color: var(--g-text);
  font-size: 12.5px;
  line-height: 1.45;
  box-sizing: border-box;
  overflow: hidden;
  animation: g-enter 250ms var(--g-ease) both;

  &.mobile { width: 100%; height: auto; }
}

.gc-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(24px) saturate(130%);
  -webkit-backdrop-filter: blur(24px) saturate(130%);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
}

.gc-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}

.gc-brand-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--g-text-2);
  white-space: nowrap;
}

.gc-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.gc-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
}

.gc-status-msg {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--g-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.gc-status-error { color: #fca5a5; }
}

/* â”€â”€ Empty state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
.glass-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 16px;
  margin: 10px;
  min-width: 280px;
  border-radius: var(--g-radius);
  border: 1px solid var(--g-border);
  background:
    radial-gradient(ellipse at 20% 0%, rgba(110, 142, 255, 0.08), transparent 50%),
    var(--g-bg);
}

.glass-empty-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.glass-empty-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;

  strong { font-size: 13px; font-weight: 600; color: var(--g-text); }
}

.glass-error-text { color: #fca5a5; font-size: 11.5px; }

/* â”€â”€ Responsive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
@media (max-width: 720px) {
  .glass-chrome { flex-wrap: wrap; }
  .glass-status, .glass-action-bar, .glass-preview-footer { flex-wrap: wrap; }
  .glass-safety-row { grid-template-columns: 1fr; }
}
</style>

<script setup lang="ts">
import { useDark } from "@vueuse/core";
import { cloneDeep } from "lodash";
import { ScrapeResults } from "neo-scraper";
import {
  getUrl,
  encodeTagName,
  getErrorMessage,
  getPostInfoSummary,
  ensurePostHasContentToken,
  getTagClasses,
  breakTagName,
} from "~/utils";
import {
  BrowserCommand,
  ScrapedPostDetails,
  TagDetails,
  SimilarPostInfo,
  SimpleSimilarPost,
  SimpleImageSearchResult,
  PostUploadCommandData,
  SzuruSiteConfig,
  PoolDetails,
} from "~/models";
import { isMobile } from "~/env";
import { DeepReadonly } from "vue";
import { cfg, usePopupStore } from "~/stores";
import SzurubooruApi from "~/api";

const pop = usePopupStore();
const isSearchingForSimilarPosts = ref<number>(0);
const enableAutoSearch = ref(true);
// Local flag set immediately on click – drives the spinner independently of
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

// Local upload state – set directly in upload() so the status area is
// always in sync. The instanceSpecificData reactive chain proved unreliable
// for subsequent imports (Vue's ?. short-circuit doesn't always establish
// tracking on fresh objects), so we drive the display from these refs instead.
type UploadPhase = "" | "uploading" | "uploaded" | "error";
const uploadPhase = ref<UploadPhase>("");
const uploadResultPostId = ref<number | undefined>(undefined);
const uploadResultError = ref<string | undefined>(undefined);
const uploadTagsState = ref<{ total: number; current?: number; totalChanged?: number } | undefined>(undefined);
const scrapeError = ref<string | undefined>(undefined);
const tagSortMode = ref<"usage" | "category" | "name">("usage");
const showAllTags = ref(false);
const collapsedTagCount = 20;

const sortedTags = computed(() => {
  const tags = [...(pop.selectedPost?.tags ?? [])];

  if (tagSortMode.value == "usage") {
    tags.sort((a, b) => {
      const usageDelta = (b.usages ?? -1) - (a.usages ?? -1);
      if (usageDelta != 0) return usageDelta;
      return a.name.localeCompare(b.name);
    });
    return tags;
  }

  if (tagSortMode.value == "category") {
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
  if (safetySlider.value == 0) return "Safe";
  if (safetySlider.value == 1) return "Sketchy";
  return "Unsafe";
});

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
  },
);

watch(
  () => cfg.value.selectedSiteId,
  async (value, oldValue) => {
    if (value != oldValue) {
      cfg.value.selectedSiteId = value;
      if (cfg.value.autoSearchSimilar && pop.selectedPost) {
        findSimilar(pop.selectedPost);
      }
    }
  },
);

function openOptionsPage() {
  browser.runtime.openOptionsPage();
}

async function getActiveTabId(): Promise<number> {
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (activeTabs.length > 0 && activeTabs[0].id) return activeTabs[0].id;
  throw new Error("No active tab.");
}

function isRestrictedTabUrl(url?: string) {
  if (!url) return false;
  const x = url.toLowerCase();
  return x.startsWith("chrome://") || x.startsWith("edge://") || x.startsWith("about:");
}

async function ensureContentScriptLoaded(tabId: number) {
  const scripting = (browser as any).scripting;
  if (scripting?.executeScript) {
    await scripting.executeScript({
      target: { tabId },
      files: ["dist/contentScripts/index.global.js"],
    });
    return;
  }

  // Firefox fallback (MV2 API)
  await browser.tabs.executeScript(tabId, { file: "./dist/contentScripts/index.global.js" });
}

function isMissingContentScriptError(ex: unknown) {
  const msg = getErrorMessage(ex).toLowerCase();
  return msg.includes("receiving end does not exist")
    || msg.includes("could not establish connection")
    || msg.includes("no matching message handler");
}

async function grabPost() {
  scrapeError.value = undefined;

  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  const activeTab = activeTabs[0];
  if (!activeTab?.id) {
    scrapeError.value = "No active tab.";
    pop.posts.splice(0);
    return;
  }
  if (isRestrictedTabUrl(activeTab.url)) {
    scrapeError.value = "Cannot scrape on browser internal pages (chrome://, edge://, about:). Open a normal website tab.";
    pop.posts.splice(0);
    return;
  }

  const activeTabId = activeTab.id;
  let x: any;
  try {
    x = await browser.tabs.sendMessage(activeTabId, new BrowserCommand("grab_post"));
  } catch (ex) {
    if (!isMissingContentScriptError(ex)) throw ex;
    await ensureContentScriptLoaded(activeTabId);
    x = await browser.tabs.sendMessage(activeTabId, new BrowserCommand("grab_post"));
  }
  const res: ScrapeResults = Object.assign(new ScrapeResults(), x);

  pop.posts.splice(0);

  for (const result of res.results) {
    for (const i in result.posts) {
      const vm = new ScrapedPostDetails(result.posts[i]);
      const name = result.posts[i].name ?? `Post ${parseInt(i) + 1}`;
      vm.name = `[${result.engine}] ${name}`;

      if (!cfg.value.addAllParsedTags) vm.tags.splice(0);
      if (cfg.value.alwaysUploadAsContent && vm.name !== "[fallback] Upload as URL") {
        vm.uploadMode = "content";
      }

      if (cfg.value.addPageUrlToSource || vm.source == "") {
        if (vm.source != "") vm.source += "\n";
        vm.source += vm.pageUrl;
      }

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

async function updatePostWithRemoteInfo(post: ScrapedPostDetails, contentUrl: string) {
  try {
    const res = await fetch(contentUrl, { method: "HEAD" });
    const size = res.headers.get("Content-Length");
    const type = res.headers.get("Content-Type");

    if (type) {
      if (type.indexOf("text/html") != -1) {
        throw new Error("Received a text/html content type. Probably no permission to access the resource.");
      }
      const [_main, sub] = type.split("/");
      if (sub) post.contentSubType = sub.toUpperCase();
    }

    if (size) post.contentSize = parseInt(size);

    if (res.url != post.contentUrl) {
      console.log(`Updating post.contentUrl to '${res.url}'`);
      post.contentUrl = res.url;
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
  return `Updated ${count} tag${count > 1 ? "s" : ""}`;
}

function onResolutionLoaded(res: any) {
  if (pop.selectedPost) pop.selectedPost.resolution = res;
}

onMounted(() => {
  if (pop.posts.length == 0) {
    void grabPost().catch((ex) => {
      scrapeError.value = getErrorMessage(ex);
      pop.posts.splice(0);
    });
  }
});

useDark();
</script>

<template>
  <!-- No content -->
  <div v-if="!pop.selectedPost" class="empty-state">
    <span>No content found on this page</span>
    <span v-if="scrapeError" class="empty-state-error">{{ scrapeError }}</span>
    <button class="icon-btn" @click="openOptionsPage" title="Settings">⚙</button>
  </div>

  <div v-else class="popup-root" :class="{ mobile: isMobile }">

    <!-- Main column -->
    <div class="main-col">

      <!-- Header: post picker + settings — always visible -->
      <div class="popup-header">
        <select class="post-select" v-model="pop.selectedPostId">
          <option v-for="post in pop.posts" :key="post.id" :value="post.id">
            {{ post.name }}{{ getPostInfoSummary(post) ? ' — ' + getPostInfoSummary(post) : '' }}
          </option>
        </select>
        <button class="icon-btn" @click="openOptionsPage" title="Settings">⚙</button>
      </div>

      <!-- Scrollable middle area -->
      <div class="scroll-area">

      <!-- Status messages -->
      <div class="status-area">
        <!-- Exact duplicate -->
        <div v-if="instanceSpecificData?.reverseSearchResult?.exactPostId" class="status-msg status-warn">
          <span>Already uploaded as post
            <a :href="getActiveSitePostUrl(instanceSpecificData.reverseSearchResult.exactPostId)" target="_blank">
              #{{ instanceSpecificData.reverseSearchResult.exactPostId }}
            </a>
          </span>
          <router-link
            class="merge-link"
            :to="{ name: 'merge', params: { siteId: cfg.selectedSiteId, postId: instanceSpecificData.reverseSearchResult.exactPostId } }"
          >Merge</router-link>
        </div>

        <!-- Upload error -->
        <div v-if="uploadPhase === 'error' && uploadResultError" class="status-msg status-error">
          {{ uploadResultError }}
        </div>

        <!-- Generic error (e.g. reverse search fail) -->
        <div v-if="instanceSpecificData?.genericError" class="status-msg status-error">
          {{ instanceSpecificData.genericError }}
        </div>

        <!-- Success -->
        <div v-if="uploadSuccess" class="status-msg status-success">
          Imported as
          <a :href="getActiveSitePostUrl(uploadResultPostId!)" target="_blank">
            post #{{ uploadResultPostId }}
          </a>
          <span v-if="uploadTagsState?.totalChanged">
            · {{ getUpdatedTagsText(uploadTagsState.totalChanged) }}
          </span>
        </div>

        <!-- Upload progress -->
        <div v-if="isUploading" class="status-msg status-info">
          <span class="spinner"></span>
          <span v-if="uploadTagsState?.current">
            Updating tags {{ uploadTagsState.current }}/{{ uploadTagsState.total }}…
          </span>
          <span v-else-if="uploadTagsState?.total">
            {{ uploadTagsState.total }} tags need category update…
          </span>
          <span v-else>Uploading…</span>
        </div>

        <!-- Similar posts -->
        <div v-if="isSearchingForSimilarPosts > 0 && !uploadPhase" class="status-msg status-info">
          <span class="spinner"></span> Searching for similar posts…
        </div>

        <div
          v-if="instanceSpecificData?.reverseSearchResult?.similarPosts.length === 0 && !uploadPhase"
          class="status-msg status-quiet"
        >
          No similar posts found
        </div>

        <div
          v-for="similarPost in getSimilarPosts(instanceSpecificData?.reverseSearchResult)"
          :key="similarPost.id"
          class="status-msg status-warn"
        >
          <span>Post <a :href="getActiveSitePostUrl(similarPost.id)" target="_blank">#{{ similarPost.id }}</a> looks {{ similarPost.percentage }}% similar</span>
          <router-link
            class="merge-link"
            :to="{ name: 'merge', params: { siteId: cfg.selectedSiteId, postId: similarPost.id } }"
          >Merge</router-link>
        </div>
      </div>

      <!-- Safety -->
      <div class="section">
        <span class="section-label">Safety</span>
        <div class="safety-track-wrap" :class="`safety-${safetyLabel.toLowerCase()}`">
          <div class="safety-labels">
            <span>Safe</span>
            <span>Sketchy</span>
            <span>Unsafe</span>
          </div>
          <input
            v-model.number="safetySlider"
            class="safety-slider"
            type="range"
            min="0"
            max="2"
            step="1"
          />
          <div class="safety-value">{{ safetyLabel }}</div>
        </div>
      </div>

      <!-- Source -->
      <div v-if="cfg.popup.showSource" class="section">
        <span class="section-label">Source</span>
        <textarea v-model="pop.selectedPost.source" rows="2"></textarea>
      </div>

      <!-- Tags -->
      <PopupSection header="Tags" toggleable v-model="cfg.popup.expandTags">
        <div class="section-row">
          <TagInput :szuru="szuru" @add-tag="addTag" />
        </div>
        <div class="section-row tags-toolbar">
          <label class="tags-sort-label" for="tag-sort">Sort</label>
          <select id="tag-sort" v-model="tagSortMode" class="tags-sort-select">
            <option value="usage">Usage</option>
            <option value="category">Category</option>
            <option value="name">Name</option>
          </select>
          <button
            v-if="hiddenTagCount > 0"
            class="btn btn-secondary btn-small"
            @click="showAllTags = true"
          >
            +{{ hiddenTagCount }} more
          </button>
          <button
            v-else-if="showAllTags && sortedTags.length > collapsedTagCount"
            class="btn btn-secondary btn-small"
            @click="showAllTags = false"
          >
            Show less
          </button>
        </div>
        <div class="section-row">
          <transition-group name="tag-fade" tag="ul" class="compact-tags animated-tags">
            <li v-for="tag in visibleTags" :key="tag.name">
              <a class="remove-tag" @click="removeTag(tag)">x</a>
              <span :class="getTagClasses(tag)" v-html="breakTagName(tag.name)"></span>
              <span v-if="cfg.loadTagCounts" class="tag-usages tag-usages-reserve-space">{{ tag.usages ? tag.usages : "" }}</span>
            </li>
          </transition-group>
        </div>
      </PopupSection>

      <!-- Pools -->
      <PopupSection v-if="cfg.popup.showPools" header="Pools" toggleable v-model="cfg.popup.expandPools">
        <div class="section-row">
          <PoolInput :szuru="szuru" @add-pool="addPool" />
        </div>
        <div class="section-row">
          <CompactPools
            :pools="pop.selectedPost.pools"
            :show-remove-pool="true"
            show-post-count
            @remove-pool="removePool"
          />
        </div>
      </PopupSection>

      <!-- Instance picker -->
      <div v-if="cfg.popup.showInstancePicker" class="section">
        <select v-model="cfg.selectedSiteId">
          <option v-for="site in cfg.sites" :key="site.id" :value="site.id">
            {{ site.domain }}
          </option>
        </select>
      </div>

      </div><!-- end scroll-area -->

      <!-- Action buttons — always visible at bottom -->
      <div class="action-bar">
        <button v-if="!cfg.autoSearchSimilar" class="btn btn-secondary" :disabled="isSubmitting" @click="clickFindSimilar">
          Find Similar
        </button>
        <button
          class="btn btn-primary btn-import"
          :disabled="isSubmitting || isUploading || !!instanceSpecificData?.reverseSearchResult?.exactPostId || uploadSuccess"
          @click="upload"
        >
          <span v-if="isSubmitting || isUploading" class="spinner spinner-sm"></span>
          <span>{{ isSubmitting || isUploading ? 'Importing…' : uploadSuccess ? 'Imported ✓' : 'Import' }}</span>
        </button>
      </div>

    </div>

    <!-- Preview column (right side) -->
    <div class="preview-col">
      <PostContentDisplay
        :content-url="pop.selectedPost.contentUrl"
        :content-type="pop.selectedPost.contentType"
        @on-resolution-loaded="onResolutionLoaded"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
/* ── Root layout ─────────────────────────────────────── */
.popup-root {
  display: flex;
  flex-direction: row;
  width: 720px;
  height: 560px;        /* fixed height – popup never grows */
  background: var(--bg-main-color);
  color: var(--text-color);
  font-size: 13px;
  overflow: hidden;
  animation: popup-in 180ms ease-out;

  &.mobile {
    flex-direction: column-reverse;
    width: 100%;
    height: auto;
    max-height: 90vh;
  }
}

/* ── Preview column ──────────────────────────────────── */
.preview-col {
  flex: 0 0 300px;
  width: 300px;
  background: #000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: hidden;
  border-left: 1px solid var(--border-color);

  .mobile & {
    flex: none;
    width: 100%;
    max-height: 260px;
    border-left: none;
    border-top: 1px solid var(--border-color);
  }
}

/* ── Main column ─────────────────────────────────────── */
.main-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;   /* children handle their own scroll */
}

/* ── Scrollable middle ───────────────────────────────── */
.scroll-area {
  flex: 1 1 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: 4px;

  /* thin scrollbar */
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

/* ── Header ──────────────────────────────────────────── */
.popup-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  background: var(--section-header-bg-color);
}

.post-select {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  height: 26px;
}

.icon-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  padding: 0;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--secondary-text);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background: var(--tab-color);
    color: var(--text-color);
  }
}

.empty-state-error {
  margin-top: 6px;
  max-width: 520px;
  color: var(--danger-color);
  text-align: center;
  font-size: 12px;
}

/* ── Status area ─────────────────────────────────────── */
.status-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 10px;

  &:not(:empty) {
    padding-top: 8px;
    padding-bottom: 4px;
  }
}

.status-msg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.3;
  animation: status-in 180ms ease-out;

  a {
    color: inherit;
    text-decoration: underline;
  }

  &.status-error  { background: rgba(244, 67, 54, 0.15); color: var(--danger-color); border: 1px solid rgba(244,67,54,0.3); }
  &.status-warn   { background: rgba(255, 152, 0, 0.12); color: #e65100; border: 1px solid rgba(255,152,0,0.3); }
  &.status-success { background: rgba(76, 175, 80, 0.12); color: var(--success-color); border: 1px solid rgba(76,175,80,0.3); }
  &.status-info   { background: rgba(36, 170, 221, 0.1); color: var(--primary-color); border: 1px solid rgba(36,170,221,0.25); }
  &.status-quiet  { background: var(--tab-color); color: var(--secondary-text); border: 1px solid var(--border-color); }
}

.tags-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tags-sort-label {
  color: var(--secondary-text);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.tags-sort-select {
  height: 24px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  background: var(--section-header-bg-color);
  color: var(--text-color);
  padding: 0 6px;
}

.btn-small {
  margin-left: auto;
  height: 24px;
  font-size: 11px;
  padding: 0 10px;
}

.animated-tags {
  position: relative;
}

.tag-usages-reserve-space {
  min-width: 5ch;
  display: inline-block;
}

.tag-fade-enter-active,
.tag-fade-leave-active,
.tag-fade-move {
  transition: all 180ms ease;
}

.tag-fade-enter-from,
.tag-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@keyframes popup-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes status-in {
  from {
    opacity: 0;
    transform: translateX(8px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}

html.dark .status-msg.status-warn { color: #ffb74d; }

.merge-link {
  flex-shrink: 0;
  padding: 2px 8px;
  background: rgba(0,0,0,0.15);
  border-radius: 3px;
  color: inherit;
  text-decoration: none;
  font-size: 11px;
  font-weight: 600;

  &:hover { background: rgba(0,0,0,0.25); }
}

/* ── Section ─────────────────────────────────────────── */
.section {
  padding: 8px 10px 0;
}

.section-label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--secondary-text);
  margin-bottom: 5px;
}

/* ── Safety slider ───────────────────────────────────── */
.safety-track-wrap {
  padding: 10px 10px 8px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.06));
  transition: border-color 180ms ease, box-shadow 180ms ease;

  &.safety-safe {
    border-color: rgba(76, 175, 80, 0.5);
    box-shadow: inset 0 0 0 1px rgba(76, 175, 80, 0.12);
  }

  &.safety-sketchy {
    border-color: rgba(255, 193, 7, 0.55);
    box-shadow: inset 0 0 0 1px rgba(255, 193, 7, 0.14);
  }

  &.safety-unsafe {
    border-color: rgba(244, 67, 54, 0.55);
    box-shadow: inset 0 0 0 1px rgba(244, 67, 54, 0.14);
  }
}

.safety-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--secondary-text);
  margin-bottom: 8px;
}

.safety-slider {
  width: 100%;
  margin: 0;
  appearance: none;
  background: transparent;

  &::-webkit-slider-runnable-track {
    height: 10px;
    border-radius: 999px;
    background: linear-gradient(90deg, #2e7d32 0%, #f9a825 50%, #c62828 100%);
  }

  &::-webkit-slider-thumb {
    appearance: none;
    width: 18px;
    height: 18px;
    margin-top: -4px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: #1d1f22;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
    transition: transform 120ms ease;
  }

  &:active::-webkit-slider-thumb {
    transform: scale(1.08);
  }

  &::-moz-range-track {
    height: 10px;
    border: none;
    border-radius: 999px;
    background: linear-gradient(90deg, #2e7d32 0%, #f9a825 50%, #c62828 100%);
  }

  &::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: #1d1f22;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
  }
}

.safety-value {
  margin-top: 8px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

/* ── Action bar ──────────────────────────────────────── */
.action-bar {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;   /* never shrink, always visible */
  background: var(--bg-main-color);
}

.btn {
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: opacity 0.15s;
  white-space: nowrap;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  &:not(:disabled):hover {
    opacity: 0.85;
  }
}

.btn-primary  { background: var(--primary-color); color: #fff; }
.btn-secondary { background: var(--button-bg-color); color: #fff; }
.btn-import   { flex: 1; justify-content: center; }

/* ── Spinner ─────────────────────────────────────────── */
@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255,255,255,0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;

  &.spinner-sm {
    width: 12px;
    height: 12px;
  }
}

/* ── Empty state ─────────────────────────────────────── */
.empty-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 16px;
  color: var(--secondary-text);
  font-size: 13px;
  min-width: 240px;
}
</style>

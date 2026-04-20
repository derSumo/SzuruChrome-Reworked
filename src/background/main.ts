import { encodeTagName, getErrorMessage } from "~/utils";
import { t, setLanguage, Language } from "~/i18n";
import {
  BrowserCommand,
  PostUploadCommandData,
  PostUploadInfo,
  SetPostUploadInfoData,
  SetExactPostId,
  PostUpdateCommandData,
  FetchCommandData,
  HotkeyImportCommandData,
  SzuruSiteConfig,
} from "~/models";
import { ImageSearchResult, PostAlreadyUploadedError, UpdatePoolRequest, UpdatePostRequest } from "~/api/models";
import SzurubooruApi from "~/api";
import { guessMimeTypeFromUrl } from "~/utils";

const QUICK_IMPORT_MENU_ID = "szuru-quick-import-current-page";
const DEFAULT_AUTO_RELATION_THRESHOLD = 60;
const lastUploadedPostPerSite = new Map<string, { last?: number; previous?: number }>();

// ── Temporary CORS rule injection via declarativeNetRequest ───────
// We inject Access-Control-Allow-Origin into CDN responses so that
// the content script (running in the page origin) can cross-origin
// fetch the image and return the real bytes with cookies/referer.
let _corsRuleId = 10000;

async function addCorsRule(url: string, pageUrl?: string): Promise<number> {
  const dnr = (globalThis as any).chrome?.declarativeNetRequest
    ?? (browser as any).declarativeNetRequest;
  if (!dnr?.updateSessionRules) return 0;

  const ruleId = _corsRuleId++;
  const origin = pageUrl ? new URL(pageUrl).origin : "*";

  await dnr.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { operation: "set", header: "Access-Control-Allow-Origin", value: origin },
        ],
      },
      condition: {
        urlFilter: url,
        resourceTypes: ["xmlhttprequest"],
      },
    }],
  });

  return ruleId;
}

async function removeCorsRule(ruleId: number): Promise<void> {
  if (ruleId === 0) return;
  const dnr = (globalThis as any).chrome?.declarativeNetRequest
    ?? (browser as any).declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => { });
}

type StoredConfig = {
  addPageUrlToSource?: boolean;
  alwaysUploadAsContent?: boolean;
  addAllParsedTags?: boolean;
  selectedSiteId?: string;
  language?: string;
  autoRelationThreshold?: number;
  sites: Array<{ id: string; domain: string; username: string; authToken: string }>;
};

function tryGetHost(url?: string) {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function resolveSelectedSite(cfg: StoredConfig, tabUrl?: string) {
  if (!cfg.sites || cfg.sites.length == 0) {
    throw new Error(t("bg.noInstances"));
  }

  // Preferred: explicit selection from popup/options config.
  if (cfg.selectedSiteId) {
    const selected = cfg.sites.find((x) => x.id == cfg.selectedSiteId);
    if (selected) return selected;
  }

  // Fallback #1: when only one instance exists, use it automatically.
  if (cfg.sites.length == 1) return cfg.sites[0];

  // Fallback #2: try to map current page host to configured instance host.
  const tabHost = tryGetHost(tabUrl);
  if (tabHost) {
    const matching = cfg.sites.find((x) => tryGetHost(x.domain) == tabHost);
    if (matching) return matching;
  }

  // Fallback #3: deterministic first entry.
  return cfg.sites[0];
}

async function persistSelectedSite(cfg: StoredConfig, siteId: string) {
  if (cfg.selectedSiteId == siteId) return;
  cfg.selectedSiteId = siteId;
  await browser.storage.local.set({ config: cfg });
}

async function getActiveTabIdFallback() {
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  return activeTabs[0]?.id;
}

function sendQuickImportStatus(
  tabId: number,
  status: "running" | "success" | "error" | "progress",
  data: { message?: string; postId?: number; postUrl?: string; progress?: number; alreadyUploaded?: boolean } = {},
) {
  const payload = new BrowserCommand("quick_import_status", { status, ...data });
  return browser.tabs.sendMessage(tabId, payload).catch(async (ex) => {
    if (!isMissingContentScriptError(ex)) return;

    try {
      await ensureContentScriptLoaded(tabId);
      await browser.tabs.sendMessage(tabId, payload);
    } catch {
      // Status feedback is best-effort; do not break import flow.
    }
  });
}

// Only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import("/@vite/client");
  // load latest content script
  import("./contentScriptHMR");
}

function isMissingContentScriptError(ex: unknown) {
  const msg = getErrorMessage(ex).toLowerCase();
  return msg.includes("receiving end does not exist")
    || msg.includes("could not establish connection")
    || msg.includes("no matching message handler");
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

function isRestrictedTabUrl(url?: string) {
  if (!url) return false;
  const x = url.toLowerCase();
  return x.startsWith("chrome://") || x.startsWith("edge://") || x.startsWith("about:");
}

async function readStoredConfig(): Promise<StoredConfig | undefined> {
  const storage = await browser.storage.local.get("config");
  const raw = storage?.config;

  if (!raw) return undefined;

  const normalize = (input: unknown): StoredConfig | undefined => {
    if (!input) return undefined;
    if (typeof input === "string") {
      try {
        return normalize(JSON.parse(input));
      } catch {
        return undefined;
      }
    }

    if (typeof input !== "object") return undefined;

    const obj = input as Record<string, unknown>;

    if (Array.isArray(obj.sites)) {
      return obj as unknown as StoredConfig;
    }

    // Some storage adapters wrap values in { value: ... }
    if (obj.value) {
      return normalize(obj.value);
    }

    return undefined;
  };

  return normalize(raw);
}

async function grabPostsFromTab(tabId: number): Promise<any> {
  try {
    return await browser.tabs.sendMessage(tabId, new BrowserCommand("grab_post"));
  } catch (ex) {
    if (!isMissingContentScriptError(ex)) throw ex;
    await ensureContentScriptLoaded(tabId);
    return await browser.tabs.sendMessage(tabId, new BrowserCommand("grab_post"));
  }
}

function mapScrapedPostForUpload(scrapedPost: any, engine: string, cfg: StoredConfig) {
  const name = scrapedPost?.name ?? "Post 1";
  const tags = (scrapedPost?.tags ?? [])
    .filter((tag: any) => tag.name && tag.name.trim())
    .map((tag: any) => ({
      names: [tag.name],
      category: tag.category,
      implications: [],
    }));
  const source = (scrapedPost?.sources ?? []).join("\n");

  const post: any = {
    id: crypto.randomUUID(),
    name: `[${engine}] ${name}`,
    tags,
    pools: [],
    notes: scrapedPost?.notes ?? [],
    contentUrl: scrapedPost?.contentUrl,
    extraContentUrl: scrapedPost?.extraContentUrl,
    contentSize: undefined,
    pageUrl: scrapedPost?.pageUrl,
    contentType: scrapedPost?.contentType,
    contentSubType: undefined,
    rating: scrapedPost?.rating,
    source,
    uploadMode: scrapedPost?.uploadMode,
    referrer: scrapedPost?.referrer,
    resolution: scrapedPost?.resolution,
    instanceSpecificData: {},
  };

  if (!cfg.addAllParsedTags) post.tags = [];

  if (cfg.alwaysUploadAsContent && post.name !== "[fallback] Upload as URL") {
    post.uploadMode = "content";
  }

  if (cfg.addPageUrlToSource || post.source == "") {
    if (post.source != "") post.source += "\n";
    post.source += post.pageUrl;
  }

  for (const site of cfg.sites) {
    post.instanceSpecificData[site.id] = {};
  }

  return post;
}

async function importCurrentPageInBackground(tabId: number, tabUrl?: string) {
  if (isRestrictedTabUrl(tabUrl)) {
    throw new Error(t("bg.restrictedPage"));
  }

  const cfg = await readStoredConfig();
  if (!cfg) throw new Error(t("bg.noConfig"));
  if (cfg.language) setLanguage(cfg.language as Language);
  const selectedSite = resolveSelectedSite(cfg, tabUrl);
  await persistSelectedSite(cfg, selectedSite.id);

  const scrapeResults = await grabPostsFromTab(tabId);
  const firstResultWithPosts = scrapeResults?.results?.find((result: any) => Array.isArray(result.posts) && result.posts.length > 0);

  if (!firstResultWithPosts) {
    throw new Error(t("bg.noMedia"));
  }

  const post = mapScrapedPostForUpload(firstResultWithPosts.posts[0], firstResultWithPosts.engine, cfg);
  const uploadData = new PostUploadCommandData(post, selectedSite, tabId);
  const info = await uploadPost(uploadData);

  if (info.state == "error") {
    if (info.existingPostId) {
      // Post was already uploaded – treat as success for quick-import.
      return {
        info: { ...info, instancePostId: info.existingPostId },
        selectedSite,
        alreadyUploaded: true,
      };
    }
    throw new Error(info.error ?? t("bg.importFailed"));
  }

  return {
    info,
    selectedSite,
  };
}

async function setupContextMenu() {
  if (!browser.contextMenus) return;
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: QUICK_IMPORT_MENU_ID,
    title: t("bg.contextMenu"),
    contexts: ["page", "image", "video"],
  });
}

async function fetchContentViaContentScript(tabId: number, url: string): Promise<{ base64: string; mimeType: string }> {
  try {
    return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url }));
  } catch (ex) {
    if (!isMissingContentScriptError(ex)) throw ex;
    await ensureContentScriptLoaded(tabId);
    return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url }));
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function guessFilenameFromUrl(url: string, mimeType: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop();
    if (lastSegment && lastSegment.includes(".")) return lastSegment;
  } catch { /* ignore */ }

  const extMap: Record<string, string> = {
    "image/jpeg": "file.jpg",
    "image/png": "file.png",
    "image/gif": "file.gif",
    "image/webp": "file.webp",
    "image/avif": "file.avif",
    "video/mp4": "file.mp4",
    "video/webm": "file.webm",
  };
  return extMap[mimeType] ?? "file.bin";
}

function getCandidateContentUrls(post: { contentUrl: string; extraContentUrl?: string }) {
  const candidates: string[] = [];
  if (post.contentUrl) candidates.push(post.contentUrl);
  if (post.extraContentUrl && post.extraContentUrl != post.contentUrl) candidates.push(post.extraContentUrl);
  return candidates;
}

async function tryAcquireContentToken(
  szuru: SzurubooruApi,
  data: PostUploadCommandData,
  onProgress?: (progress: number) => void,
): Promise<string | undefined> {
  const candidates = getCandidateContentUrls(data.post);

  // 1) Try content script fetch in page context (best chance against hotlink protection).
  //    We inject a temporary CORS rule so cross-origin CDN responses include
  //    Access-Control-Allow-Origin, letting the in-page fetch read the bytes.
  if (data.tabId) {
    for (const candidateUrl of candidates) {
      const ruleId = await addCorsRule(candidateUrl, data.post.pageUrl).catch(() => 0);
      try {
        const result = await fetchContentViaContentScript(data.tabId, candidateUrl);

        // Content script returns base64-encoded data to survive message serialization.
        if (!result.base64 || typeof result.base64 !== "string") {
          console.warn("Content script returned invalid data (missing base64 string) – skipping.");
          continue;
        }

        const buffer = base64ToArrayBuffer(result.base64);
        const correctedMime = guessMimeTypeFromUrl(candidateUrl, result.mimeType);
        const filename = guessFilenameFromUrl(candidateUrl, correctedMime);
        const blob = new Blob([buffer], { type: correctedMime });

        // Sanity-check: reject obviously wrong content (e.g. HTML error pages)
        if (blob.size < 64) {
          console.warn("Content script fetch returned suspiciously small payload:", blob.size, "bytes – skipping.");
          continue;
        }

        const tmpRes = await szuru.uploadTempFileFromBlob(blob, filename, onProgress);
        return tmpRes.token;
      } catch (ex) {
        console.warn("Content script fetch/upload failed for candidate URL:", candidateUrl, ex);
      } finally {
        await removeCorsRule(ruleId);
      }
    }
  }

  // 2) Try background-side content fetch with credentials/referrer.
  for (const candidateUrl of candidates) {
    try {
      const tmpRes = await szuru.uploadTempFile(candidateUrl, "content", data.post.referrer ?? data.post.pageUrl, onProgress);
      return tmpRes.token;
    } catch (ex) {
      console.warn("Background content fetch/upload failed for candidate URL:", candidateUrl, ex);
    }
  }

  return undefined;
}

function getAutoRelationIds(searchResult: ImageSearchResult, createdPostId: number, thresholdPercent: number) {
  const maxDistance = 1 - thresholdPercent / 100;
  const relationIds = new Set<number>();

  for (const similar of searchResult.similarPosts) {
    if (similar.post.id == createdPostId) continue;
    if (similar.distance <= maxDistance) {
      relationIds.add(similar.post.id);
    }
  }

  return [...relationIds];
}

async function tryApplyAutoRelations(
  szuru: SzurubooruApi,
  createdPostId: number,
  createdPostVersion: number,
  relationIds: number[],
) {
  if (relationIds.length == 0) return;

  const updateRequest: UpdatePostRequest = {
    version: createdPostVersion,
    relations: relationIds,
  };
  await szuru.updatePost(createdPostId, updateRequest);
}

async function tryLinkPostWithLastPostRelation(
  selectedSite: SzuruSiteConfig,
  newPostId: number,
  targetPostId: number,
) {
  if (newPostId == targetPostId) return;

  const szuru = SzurubooruApi.createFromConfig(selectedSite);
  const post = await szuru.getPost(newPostId);
  const existingRelationIds = post.relations
    ?.map((x: any) => x?.id)
    .filter((x: unknown): x is number => typeof x == "number") ?? [];

  if (existingRelationIds.includes(targetPostId)) return;

  await szuru.updatePost(newPostId, {
    version: post.version,
    relations: [...existingRelationIds, targetPostId],
  });
}

function updateLastUploadedPost(siteId: string, postId: number) {
  const prev = lastUploadedPostPerSite.get(siteId)?.last;
  lastUploadedPostPerSite.set(siteId, { previous: prev, last: postId });
}

async function uploadPost(data: PostUploadCommandData): Promise<PostUploadInfo> {
  const info: PostUploadInfo = {
    state: "uploading",
  };

  // Send status update to popup. Fire-and-forget – if popup is closed the
  // message will fail silently, which is fine (popup resets state on reopen).
  const pushInfo = () =>
    browser.runtime.sendMessage(
      new BrowserCommand("set_post_upload_info", new SetPostUploadInfoData(data.selectedSite.id, data.post.id, info)),
    ).catch(() => { /* popup may be closed */ });

  // Send upload progress to the content script for the progress bar.
  let lastProgressSent = 0;
  const sendProgress = (progress: number) => {
    // Throttle: only send if progress changed by at least 2%
    if (data.tabId && (progress - lastProgressSent >= 0.02 || progress >= 1)) {
      lastProgressSent = progress;
      sendQuickImportStatus(data.tabId, "progress", { progress });
    }
  };

  try {
    const szuru = SzurubooruApi.createFromConfig(data.selectedSite);

    // Create and upload post
    pushInfo();

    let contentToken = data.post.instanceSpecificData[data.selectedSite.id]?.contentToken;

    if (!contentToken) {
      contentToken = await tryAcquireContentToken(szuru, data, sendProgress);

      // Last chance before URL mode: prefer extraContentUrl if present, as many
      // booru pages expose CDN links that block server-side fetch while alt URLs work.
      if (!contentToken && data.post.extraContentUrl && data.post.extraContentUrl != data.post.contentUrl) {
        console.warn("No content token acquired; switching createPost URL to extraContentUrl as fallback.");
        data.post.contentUrl = data.post.extraContentUrl;
      }
      // If contentToken is still undefined here → createPost uses contentUrl (URL mode).
    }

    // Reverse search BEFORE createPost – content tokens are single-use and
    // get consumed by createPost, so we must search while the token is alive.
    let reverseSearchResult: ImageSearchResult | undefined;
    try {
      reverseSearchResult = contentToken
        ? await szuru.reverseSearchToken(contentToken)
        : await szuru.reverseSearch(data.post.contentUrl);
    } catch (ex) {
      console.warn("Pre-upload reverse search failed (auto-relations):", getErrorMessage(ex));
    }

    const createdPost = await szuru.createPost(data.post, contentToken);

    // Apply auto-relations from the stored reverse search results.
    if (reverseSearchResult) {
      try {
        const storedCfg = await readStoredConfig();
        const autoRelationsEnabled = storedCfg?.autoRelationsEnabled !== false; // default true
        const threshold = storedCfg?.autoRelationThreshold ?? DEFAULT_AUTO_RELATION_THRESHOLD;
        if (autoRelationsEnabled) {
          const relationIds = getAutoRelationIds(reverseSearchResult, createdPost.id, threshold);
          await tryApplyAutoRelations(szuru, createdPost.id, createdPost.version, relationIds);
        }
      } catch (ex) {
        console.warn("Auto relation assignment failed:", getErrorMessage(ex));
      }
    }

    info.state = "uploaded";
    info.instancePostId = createdPost.id;
    updateLastUploadedPost(data.selectedSite.id, createdPost.id);
    pushInfo();

    // Find tags with "default" category and update it
    // TODO: Make all these categories configurable
    const tagsWithCategory = data.post.tags.filter((x) => x.category);
    const unsetCategoryTags = createdPost.tags
      .filter((x) => x.category == "default")
      .filter((x) => tagsWithCategory.some((y) => x.names.includes(y.names[0])));

    if (unsetCategoryTags.length != 0) {
      info.updateTagsState = {
        total: unsetCategoryTags.length,
      };
      pushInfo();

      // unsetCategoryTags is of type MicroTag[] and we need a Tag resource to update it, so let's get those
      const query = unsetCategoryTags.map((x) => encodeTagName(x.names[0])).join();
      const tags = (await szuru.getTags(query)).results;
      const existingCategories = (await szuru.getTagCategories()).results;
      let categoriesChangedCount = 0;

      for (const i in tags) {
        info.updateTagsState.current = parseInt(i);
        pushInfo();

        const wantedCategory = tagsWithCategory.find((x) => tags[i].names.includes(x.names[0]))?.category;
        if (wantedCategory) {
          if (existingCategories.some((x) => x.name == wantedCategory)) {
            tags[i].category = wantedCategory;
            await szuru.updateTag(tags[i]);
            categoriesChangedCount++;
          } else {
            console.log(
              `Not adding the '${wantedCategory}' category to the tag '${tags[i].names[0]}' because the szurubooru instance does not have this category.`,
            );
          }
        }
      }

      if (categoriesChangedCount > 0) {
        info.updateTagsState.totalChanged = categoriesChangedCount;
        pushInfo();
      }
    }

    // Add post to pools
    for (const scrapedPool of data.post.pools) {
      // Attention! Don't use the .name getter as it does not exist. Just use names[0].
      const existingPools = await szuru.getPools(encodeTagName(scrapedPool.names[0]), 0, 1, ["id", "posts", "version"]);

      if (existingPools.results.length == 0) {
        // Pool does not exist. Create a new pool and add the post to it in one API call.
        console.log(`Creating new pool ${scrapedPool.names[0]} and adding post ${createdPost.id}.`);
        await szuru.createPool(scrapedPool.names[0], "default", [createdPost.id]);
      } else {
        // Pool exists, so add it to the existing pool.
        const existingPool = existingPools.results[0];
        const posts = existingPool.posts.map((x) => x.id);
        posts.push(createdPost.id);

        console.log(`Adding post ${createdPost.id} to existing pool ${existingPool.id}`);

        const updateRequest = <UpdatePoolRequest>{
          version: existingPool.version,
          posts,
        };

        await szuru.updatePool(existingPool.id, updateRequest);
      }
    }

    return info;
  } catch (ex: any) {
    if (ex.name && ex.name == "PostAlreadyUploadedError") {
      console.info("Post already uploaded:", getErrorMessage(ex));
      const otherPostId = (ex as PostAlreadyUploadedError).otherPostId;
      info.existingPostId = otherPostId;
      browser.runtime.sendMessage(
        new BrowserCommand("set_exact_post_id", new SetExactPostId(data.selectedSite.id, data.post.id, otherPostId)),
      ).catch(() => { /* popup may be closed */ });
      // We don't set an error message, because we have a different message for posts that are already uploaded.
    } else {
      console.error("Upload failed:", getErrorMessage(ex));
      // Set generic error message.
      info.error = getErrorMessage(ex);
    }
    info.state = "error";
    pushInfo();
    return info;
  }
}

async function updatePost(data: PostUpdateCommandData) {
  const info: PostUploadInfo = {
    state: "uploading",
    instancePostId: data.postId,
  };

  const pushInfo = () =>
    browser.runtime.sendMessage(
      new BrowserCommand(
        "set_post_update_info",
        new SetPostUploadInfoData(data.selectedSite.id, `merge-${data.postId}`, info),
      ),
    ).catch(() => { /* popup may be closed */ });

  try {
    const szuru = SzurubooruApi.createFromConfig(data.selectedSite);

    pushInfo();

    await szuru.updatePost(data.postId, data.updateRequest);

    info.state = "uploaded";
    pushInfo();
  } catch (ex: any) {
    console.error(ex);
    info.state = "error";
    info.error = getErrorMessage(ex);
    pushInfo();
  }
}

/**
 * Executes fetch in the background page. This allows us to do "forbidden" stuff, like ignoring CORS headers.
 * @param data
 * @returns
 */
async function executeFetch(data: FetchCommandData) {
  return await fetch(data.url, data.options);
}

async function handleHotkeyImport(data: { url: string }) {
  // The content script sends us the page URL. We need the active tab ID.
  const tabId = await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));

  // Run the same import flow as the context menu, with status feedback.
  try {
    const result = await importCurrentPageInBackground(tabId, data.url);
    const postId = result?.info?.instancePostId;
    const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;
    await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result.alreadyUploaded });
  } catch (ex) {
    const message = getErrorMessage(ex);
    console.error("Hotkey import failed:", message);
    await sendQuickImportStatus(tabId, "error", { message });
  }
}

async function handleHotkeyImportLinkLast(data: HotkeyImportCommandData) {
  const tabId = await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));

  try {
    const result = await importCurrentPageInBackground(tabId, data.url);
    const postId = result?.info?.instancePostId;
    const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;

    if (postId) {
      const lastState = lastUploadedPostPerSite.get(result.selectedSite.id);
      const previousPostId = lastState?.previous;

      if (previousPostId) {
        try {
          await tryLinkPostWithLastPostRelation(result.selectedSite, postId, previousPostId);
        } catch (ex) {
          console.warn("Hotkey relation to last post failed:", getErrorMessage(ex));
        }
      }
    }

    await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result.alreadyUploaded });
  } catch (ex) {
    const message = getErrorMessage(ex);
    console.error("Hotkey import+link failed:", message);
    await sendQuickImportStatus(tabId, "error", { message });
  }
}

async function messageHandler(cmd: BrowserCommand): Promise<any> {
  console.log("Background received message:");
  console.dir(cmd);

  switch (cmd.name) {
    case "upload_post":
      return uploadPost(cmd.data);
    case "update_post":
      return updatePost(cmd.data);
    case "fetch":
      return executeFetch(cmd.data);
    case "hotkey_import":
      return handleHotkeyImport(cmd.data);
    case "hotkey_import_link_last":
      return handleHotkeyImportLinkLast(cmd.data);
  }
}

browser.runtime.onMessage.addListener(messageHandler);

// Also initialize on worker start; install/startup listeners may not fire on every restart.
void setupContextMenu().catch((ex) => {
  console.error("Failed to initialize context menu:", getErrorMessage(ex));
});

// Initialize language from stored config
void readStoredConfig().then((cfg) => {
  if (cfg?.language) setLanguage(cfg.language as Language);
}).catch(() => {});

if (browser.contextMenus) {
  browser.runtime.onInstalled.addListener(() => {
    void setupContextMenu();
  });

  if ((browser.runtime as any).onStartup?.addListener) {
    (browser.runtime as any).onStartup.addListener(() => {
      void setupContextMenu();
    });
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== QUICK_IMPORT_MENU_ID) return;

    void (async () => {
      const tabId = tab?.id ?? await getActiveTabIdFallback();
      if (!tabId) throw new Error(t("bg.noActiveTab").replace("hotkey", "quick"));
      await sendQuickImportStatus(tabId, "running");
      return importCurrentPageInBackground(tabId, tab?.url);
    })()
      .then(async (result) => {
        console.log("Background quick import succeeded:", result);
        const tabId = tab?.id ?? await getActiveTabIdFallback();
        if (!tabId) return;

        const postId = result?.info?.instancePostId;
        const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;
        await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result?.alreadyUploaded });
      })
      .catch(async (ex) => {
        const message = getErrorMessage(ex);
        console.error("Background quick import failed:", message);
        const tabId = tab?.id ?? await getActiveTabIdFallback();
        if (!tabId) return;
        await sendQuickImportStatus(tabId, "error", { message });
      });
  });
}

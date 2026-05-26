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

// Tracks in-flight and recently finished imports so content scripts that
// load on the next page can restore toasts that were still visible.
interface ActiveImportEntry {
  tabId: number;
  status: "running" | "progress" | "success" | "error";
  progress?: number;
  postId?: number;
  postUrl?: string;
  alreadyUploaded?: boolean;
  message?: string;
}
const activeImports = new Map<string, ActiveImportEntry>();

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
          { operation: "set", header: "Access-Control-Allow-Credentials", value: "true" },
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
  data: { message?: string; postId?: number; postUrl?: string; progress?: number; alreadyUploaded?: boolean; importId?: string } = {},
) {
  const { importId, progress, postId, postUrl, alreadyUploaded, message } = data;

  // Keep activeImports in sync so new content scripts can restore toasts.
  if (importId) {
    if (status === "running") {
      activeImports.set(importId, { tabId, status: "running" });
    } else if (status === "progress") {
      const entry = activeImports.get(importId);
      if (entry) entry.progress = progress;
      else activeImports.set(importId, { tabId, status: "progress", progress });
    } else if (status === "success" || status === "error") {
      activeImports.set(importId, { tabId, status, postId, postUrl, alreadyUploaded, message });
      // Remove after 15 s — long enough for the next page to load and pick it up.
      setTimeout(() => activeImports.delete(importId), 15000);
    }
  }

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

async function importCurrentPageInBackground(tabId: number, tabUrl?: string, importId?: string) {
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
  const uploadData = new PostUploadCommandData(post, selectedSite, tabId, importId);
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
  const FETCH_TIMEOUT_MS = 30_000;

  const msgPromise = (async () => {
    try {
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url }));
    } catch (ex) {
      if (!isMissingContentScriptError(ex)) throw ex;
      await ensureContentScriptLoaded(tabId);
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url }));
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Content-script fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`)), FETCH_TIMEOUT_MS),
  );

  return Promise.race([msgPromise, timeoutPromise]);
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
  //    Inject a CORS rule so the background fetch can read the CDN response,
  //    mirroring the same approach used in step 1 for content script fetches.
  for (const candidateUrl of candidates) {
    const ruleId = await addCorsRule(candidateUrl, data.post.pageUrl).catch(() => 0);
    try {
      const tmpRes = await szuru.uploadTempFile(candidateUrl, "content", data.post.referrer ?? data.post.pageUrl, onProgress);
      return tmpRes.token;
    } catch (ex) {
      console.warn("Background content fetch/upload failed for candidate URL:", candidateUrl, ex);
    } finally {
      await removeCorsRule(ruleId);
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
      sendQuickImportStatus(data.tabId, "progress", { progress, importId: data.importId });
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

async function handleHotkeyImport(data: { url: string; importId?: string }) {
  // The content script sends us the page URL. We need the active tab ID.
  const tabId = await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));
  const importId = data.importId;

  // Run the same import flow as the context menu, with status feedback.
  try {
    const result = await importCurrentPageInBackground(tabId, data.url, importId);
    const postId = result?.info?.instancePostId;
    const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;
    await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result.alreadyUploaded, importId });
  } catch (ex) {
    const message = getErrorMessage(ex);
    console.error("Hotkey import failed:", message);
    await sendQuickImportStatus(tabId, "error", { message, importId });
  }
}

async function handleHotkeyImportLinkLast(data: HotkeyImportCommandData) {
  const tabId = await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));
  const importId = data.importId;

  try {
    const result = await importCurrentPageInBackground(tabId, data.url, importId);
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

    await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result.alreadyUploaded, importId });
  } catch (ex) {
    const message = getErrorMessage(ex);
    console.error("Hotkey import+link failed:", message);
    await sendQuickImportStatus(tabId, "error", { message, importId });
  }
}

async function messageHandler(cmd: BrowserCommand, sender: any): Promise<any> {
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
    case "get_active_imports": {
      const tabId = sender?.tab?.id;
      const result: Array<ActiveImportEntry & { importId: string }> = [];
      for (const [importId, entry] of activeImports) {
        if (entry.tabId === tabId) result.push({ importId, ...entry });
      }
      return result;
    }
  }
}

browser.runtime.onMessage.addListener(messageHandler);

// ── Native Referer injection for extension popup image loads ────────────────
// When the popup's <img> tag tries to load a CDN-protected image (e.g.
// img2.gelbooru.com), the browser sends the extension origin as Referer, which
// gets blocked. We intercept those requests and replace the Referer with the
// CDN's own parent domain so the hotlink check passes natively.
// This also covers background-service-worker fetches (tabId === -1) to the same
// CDN hosts so that tryAcquireContentToken's direct-fetch fallback sends a valid Referer.
if ((browser as any).webRequest?.onBeforeSendHeaders) {
  const CDN_HOSTS: Record<string, string> = {
    "img2.gelbooru.com":   "https://gelbooru.com/",
    "img3.gelbooru.com":   "https://gelbooru.com/",
    "wimg.rule34.xxx":     "https://rule34.xxx/",
    "us.rule34.xxx":       "https://rule34.xxx/",
  };

  try {
    (browser as any).webRequest.onBeforeSendHeaders.addListener(
      (details: any) => {
        // Only modify requests from the extension popup/background page (tabId === -1).
        // Content script requests run in web page tabs (tabId >= 0) and already carry
        // the correct Referer via referrerPolicy:"unsafe-url" — don't touch those.
        if (details.tabId !== -1) return {};
        try {
          const host = new URL(details.url).hostname;
          const spoofedReferer = CDN_HOSTS[host]
            ?? (host.endsWith(".rule34.xxx") ? "https://rule34.xxx/" : undefined)
            ?? (host.endsWith(".gelbooru.com") ? "https://gelbooru.com/" : undefined);
          if (!spoofedReferer) return {};
          const headers: Array<{ name: string; value: string }> = details.requestHeaders ?? [];
          const idx = headers.findIndex((h: any) => h.name.toLowerCase() === "referer");
          if (idx >= 0) {
            headers[idx] = { name: "Referer", value: spoofedReferer };
          } else {
            headers.push({ name: "Referer", value: spoofedReferer });
          }
          return { requestHeaders: headers };
        } catch {
          return {};
        }
      },
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"],
    );
  } catch (ex) {
    console.warn("webRequest.onBeforeSendHeaders blocking not available:", ex);
  }
}

// Inject CORS headers into CDN responses so content-script fetch() calls
// (running in the page context) can read image bytes cross-origin.
// This is a fallback for Firefox versions where declarativeNetRequest.updateSessionRules
// is unavailable. Both mechanisms are harmless when active simultaneously.
//
// We use a hardcoded host→origin map so the correct Access-Control-Allow-Origin
// is always injected regardless of whether details.originUrl is populated,
// preventing a wrong Gelbooru default being applied to rule34.xxx requests.
if ((browser as any).webRequest?.onHeadersReceived) {
  const CDN_CORS_ORIGIN_MAP: Record<string, string> = {
    "img2.gelbooru.com": "https://gelbooru.com",
    "img3.gelbooru.com": "https://gelbooru.com",
    "wimg.rule34.xxx":   "https://rule34.xxx",
    "us.rule34.xxx":     "https://rule34.xxx",
  };

  try {
    (browser as any).webRequest.onHeadersReceived.addListener(
      (details: any) => {
        const headers: Array<{ name: string; value: string }> = [...(details.responseHeaders ?? [])];
        if (headers.some((h: any) => h.name.toLowerCase() === "access-control-allow-origin")) {
          return {};
        }
        let host: string;
        try {
          host = new URL(details.url).hostname.toLowerCase();
        } catch {
          return {};
        }
        // Use hardcoded mapping first, then wildcard subdomain fallback.
        let origin: string | undefined = CDN_CORS_ORIGIN_MAP[host];
        if (!origin && host.endsWith(".rule34.xxx")) origin = "https://rule34.xxx";
        if (!origin && host.endsWith(".gelbooru.com")) origin = "https://gelbooru.com";
        // Fall back to originUrl for any other unlisted hosts.
        if (!origin) {
          try {
            if (details.originUrl) origin = new URL(details.originUrl).origin;
          } catch { /* ignore */ }
        }
        if (!origin) return {};
        headers.push({ name: "Access-Control-Allow-Origin", value: origin });
        headers.push({ name: "Access-Control-Allow-Credentials", value: "true" });
        return { responseHeaders: headers };
      },
      {
        urls: [
          "*://img2.gelbooru.com/*",
          "*://img3.gelbooru.com/*",
          "*://*.rule34.xxx/*",
        ],
        types: ["xmlhttprequest"],
      },
      ["blocking", "responseHeaders"],
    );
  } catch (ex) {
    console.warn("webRequest.onHeadersReceived CORS injection not available:", ex);
  }
}

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
    const importId = crypto.randomUUID();

    void (async () => {
      const tabId = tab?.id ?? await getActiveTabIdFallback();
      if (!tabId) throw new Error(t("bg.noActiveTab").replace("hotkey", "quick"));
      await sendQuickImportStatus(tabId, "running", { importId });
      return importCurrentPageInBackground(tabId, tab?.url, importId);
    })()
      .then(async (result) => {
        console.log("Background quick import succeeded:", result);
        const tabId = tab?.id ?? await getActiveTabIdFallback();
        if (!tabId) return;

        const postId = result?.info?.instancePostId;
        const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;
        await sendQuickImportStatus(tabId, "success", { postId, postUrl, alreadyUploaded: result?.alreadyUploaded, importId });
      })
      .catch(async (ex) => {
        const message = getErrorMessage(ex);
        console.error("Background quick import failed:", message);
        const tabId = tab?.id ?? await getActiveTabIdFallback();
        if (!tabId) return;
        await sendQuickImportStatus(tabId, "error", { message, importId });
      });
  });
}

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
  SzuruSiteConfig,
} from "~/models";
import { ImageSearchResult, PostAlreadyUploadedError, UpdatePoolRequest, UpdatePostRequest, type Post } from "~/api/models";
import SzurubooruApi from "~/api";
import { guessMimeTypeFromUrl } from "~/utils";
import { applyTagRulesToTagList, type TagRulesConfig } from "~/tagRules";
import { getStats, recordImport, removeFailure, clearFailures, resetStats } from "~/stats";
import {
  loadSessionState,
  saveSessionState,
  startKeepAlive,
  stopKeepAlive,
  type ActiveImportEntry,
  type ImportTask,
  type SiteUploadState,
} from "./sessionState";
import { runBatchImport, type BatchImportRequest } from "./batch";

const QUICK_IMPORT_MENU_ID = "szuru-quick-import-current-page";
const DEFAULT_AUTO_RELATION_THRESHOLD = 60;
const DEFAULT_MAX_ATTEMPTS = 3;

// Per-site upload state used by the link-chain mode.
// lastUploadedPostId  = most recent normal upload (seed for the next chain).
// linkChain           = posts uploaded consecutively via hotkey_import_link_last.
//                       A normal hotkey/context-menu/popup upload clears the chain.
const siteStates = new Map<string, SiteUploadState>();

function getSiteState(siteId: string): SiteUploadState {
  let s = siteStates.get(siteId);
  if (!s) {
    s = { linkChain: [] };
    siteStates.set(siteId, s);
  }
  return s;
}

// Tracks in-flight and recently finished imports so content scripts that
// load on the next page can restore toasts that were still visible.
const activeImports = new Map<string, ActiveImportEntry>();
let successfulImportCleanupTimer: ReturnType<typeof setTimeout> | undefined;

// ── State mirroring (MV3) ─────────────────────────────────────────────
// Every mutation of the three long-lived maps goes through here so a worker
// restart mid-burst can pick the queue back up. See ./sessionState.ts.
function persistState() {
  saveSessionState({
    siteStates: Object.fromEntries(siteStates),
    activeImports: Object.fromEntries(activeImports),
    // The task currently uploading has already been shifted off the queue, so
    // include it explicitly — otherwise a worker teardown mid-upload would
    // drop exactly the one import that was in progress.
    queue: activeQueueTask ? [activeQueueTask, ...importQueue] : [...importQueue],
  });
}

let stateRestored: Promise<void> | undefined;

function restoreState(): Promise<void> {
  stateRestored ??= (async () => {
    const state = await loadSessionState();
    if (!state) return;

    for (const [siteId, value] of Object.entries(state.siteStates)) {
      if (!siteStates.has(siteId)) siteStates.set(siteId, value);
    }
    for (const [importId, entry] of Object.entries(state.activeImports)) {
      if (!activeImports.has(importId)) activeImports.set(importId, entry);
    }
    // Tasks that were still queued when the worker died are resumed. Anything
    // that was mid-upload is indistinguishable from a queued task here, so it
    // re-runs; szurubooru's "already uploaded" handling makes that harmless.
    for (const task of state.queue) {
      if (importQueue.some((x) => x.importId === task.importId)) continue;
      importQueue.push(task);
      const pageUrl = getTaskPageUrl(task);
      if (pageUrl) pendingPageUrls.add(pageUrl);
    }
    if (importQueue.length > 0) {
      console.log(`Resuming ${importQueue.length} queued import(s) after worker restart.`);
      void runQueue();
    }
  })();
  return stateRestored;
}

function scheduleSuccessfulImportCleanup() {
  if (successfulImportCleanupTimer) clearTimeout(successfulImportCleanupTimer);
  successfulImportCleanupTimer = setTimeout(() => {
    for (const [importId, entry] of activeImports) {
      if (entry.status === "success") activeImports.delete(importId);
    }
    successfulImportCleanupTimer = undefined;
    persistState();
  }, 15_000);
}

// Derive the registrable (parent) domain from a host so we can build a
// same-site Referer/Origin for hotlink-protected CDNs (e.g. an image host on a
// subdomain) without hardcoding any specific site. Handles the common
// second-level public suffixes (e.g. "co.uk", "com.au").
const MULTI_PART_SLDS = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go"]);
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const sld = labels[labels.length - 2];
  if (MULTI_PART_SLDS.has(sld) && labels.length >= 3) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

// Registrable domains of content URLs currently being fetched during an import.
// The webRequest CORS fallback only injects headers for hosts in this set, so it
// never acts as a browser-wide CORS bypass on unrelated traffic.
const activeImportHosts = new Set<string>();

function beginImportHost(url: string): string | undefined {
  try {
    const base = registrableDomain(new URL(url).hostname);
    activeImportHosts.add(base);
    return base;
  } catch {
    return undefined;
  }
}

function endImportHost(base: string | undefined) {
  if (base) activeImportHosts.delete(base);
}

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
  uploadAsContentSites?: string[];
  addAllParsedTags?: boolean;
  selectedSiteId?: string;
  language?: string;
  autoRelationThreshold?: number;
  autoRelationsEnabled?: boolean;
  replaceExactDuplicates?: boolean;
  tagRules?: TagRulesConfig;
  importedBadge?: { enabled?: boolean; showWhenNotImported?: boolean };
  queueRetry?: { enabled?: boolean; maxAttempts?: number };
  statsEnabled?: boolean;
  batchImport?: { enabled?: boolean; concurrency?: number };
  sites: Array<{ id: string; domain: string; username: string; authToken: string }>;
};

function normalizeHost(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    // Allow either bare hosts ("example.com") or full URLs.
    const url = value.includes("://") ? new URL(value) : new URL("https://" + value);
    return url.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^www\./, "");
  }
}

function isUploadAsContentSiteMatch(pageUrl: string | undefined, sites: string[] | undefined): boolean {
  const host = normalizeHost(pageUrl);
  if (!host || !sites || sites.length === 0) return false;
  return sites.some((entry) => {
    const target = normalizeHost(entry);
    if (!target) return false;
    return host === target || host.endsWith("." + target);
  });
}

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
  tabId: number | undefined,
  status: "running" | "success" | "error" | "progress" | "heartbeat",
  data: { message?: string; postId?: number; postUrl?: string; progress?: number; speedBytesPerSecond?: number; totalBytes?: number; elapsedSeconds?: number; alreadyUploaded?: boolean; linkedPostIds?: number[]; duplicateOutcome?: "replaced" | "tags_merged"; importId?: string; queued?: boolean } = {},
) {
  const { importId, progress, speedBytesPerSecond, totalBytes, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome, message, queued } = data;

  // Keep activeImports in sync so new content scripts can restore toasts.
  if (importId) {
    if (status === "running") {
      const prev = activeImports.get(importId);
      activeImports.set(importId, { tabId, status: "running", queued: queued ?? prev?.queued });
    } else if (status === "progress") {
      const entry = activeImports.get(importId);
      if (entry) {
        entry.progress = progress;
        entry.speedBytesPerSecond = speedBytesPerSecond;
        if (typeof totalBytes === "number" && totalBytes > 0) entry.totalBytes = totalBytes;
        if (typeof speedBytesPerSecond === "number" && speedBytesPerSecond > 0) {
          entry.lastDownloadSpeedBytesPerSecond = speedBytesPerSecond;
        }
        entry.queued = false;
      } else {
        activeImports.set(importId, {
          tabId,
          status: "progress",
          progress,
          speedBytesPerSecond,
          lastDownloadSpeedBytesPerSecond: speedBytesPerSecond,
          totalBytes,
        });
      }
    } else if (status === "success") {
      const completedAt = Date.now();
      activeImports.set(importId, { tabId, status, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome, completedAt, message });
      // The whole success history has one lifetime: every completed upload
      // restarts it, so earlier rows do not disappear while a burst continues.
      scheduleSuccessfulImportCleanup();
    } else if (status === "error") {
      activeImports.set(importId, { tabId, status, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome, message });
      setTimeout(() => {
        activeImports.delete(importId);
        persistState();
      }, 8000);
    }
    persistState();
  }

  const completedAt = importId ? activeImports.get(importId)?.completedAt : undefined;
  const lastDownloadSpeedBytesPerSecond = importId ? activeImports.get(importId)?.lastDownloadSpeedBytesPerSecond : undefined;
  const storedTotalBytes = importId ? activeImports.get(importId)?.totalBytes : undefined;
  const payload = new BrowserCommand("quick_import_status", { status, ...data, completedAt, lastDownloadSpeedBytesPerSecond, totalBytes: totalBytes ?? storedTotalBytes });
  // Retries triggered from the options page have no originating tab; their
  // result surfaces in the statistics tab instead of a toast.
  if (typeof tabId !== "number") return Promise.resolve();
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

function scrapeHasPost(results: any): boolean {
  return !!results?.results?.some((r: any) => Array.isArray(r?.posts) && r.posts.length > 0);
}

// A background tab reports "complete" before a throttled booru page has laid
// out its content, so a single scrape can see an empty DOM. Retry a few times
// until a post appears (or we give up and let the caller report the miss).
async function grabPostsWithRetry(tabId: number, attempts = 5, delayMs = 500): Promise<any> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await grabPostsFromTab(tabId);
    } catch {
      last = undefined;
    }
    if (scrapeHasPost(last)) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
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
  // Blacklist / rename rules run last, so they also catch tags the scraper
  // added implicitly and stay consistent with the popup import path.
  post.tags = applyTagRulesToTagList(post.tags, cfg.tagRules);

  const siteSpecificForce = isUploadAsContentSiteMatch(post.pageUrl, cfg.uploadAsContentSites);
  if ((cfg.alwaysUploadAsContent || siteSpecificForce) && post.name !== "[fallback] Upload as URL") {
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

async function importCurrentPageInBackground(tabId: number | undefined, tabUrl?: string, importId?: string, preScrapedResults?: any) {
  if (isRestrictedTabUrl(tabUrl)) {
    throw new Error(t("bg.restrictedPage"));
  }

  const cfg = await readStoredConfig();
  if (!cfg) throw new Error(t("bg.noConfig"));
  if (cfg.language) setLanguage(cfg.language as Language);
  const selectedSite = resolveSelectedSite(cfg, tabUrl);
  await persistSelectedSite(cfg, selectedSite.id);

  // Use pre-scraped results when available (captured at enqueue/hotkey time)
  // so a navigation between queue enqueue and queue processing doesn't make
  // the task scrape the wrong page (which would then upload the same image
  // twice → "already uploaded" → blocks any meaningful subsequent imports).
  // A retry launched from the options page has no tab to scrape; it always
  // carries the payload captured when the original import failed.
  const scrapeResults = preScrapedResults ?? (typeof tabId === "number" ? await grabPostsFromTab(tabId) : undefined);
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
    alreadyUploaded: info.existingPostId === info.instancePostId,
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

async function fetchContentViaContentScript(tabId: number, url: string, importId?: string): Promise<{ base64: string; mimeType: string }> {
  const FETCH_TIMEOUT_MS = 30_000;

  const msgPromise = (async () => {
    try {
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url, importId }));
    } catch (ex) {
      if (!isMissingContentScriptError(ex)) throw ex;
      await ensureContentScriptLoaded(tabId);
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url, importId }));
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
): Promise<{ token: string; fileSize?: number } | undefined> {
  const candidates = getCandidateContentUrls(data.post);

  // 1) Try content script fetch in page context (best chance against hotlink protection).
  //    We inject a temporary CORS rule so cross-origin CDN responses include
  //    Access-Control-Allow-Origin, letting the in-page fetch read the bytes.
  if (data.tabId) {
    for (const candidateUrl of candidates) {
      const ruleId = await addCorsRule(candidateUrl, data.post.pageUrl).catch(() => 0);
      const importHost = beginImportHost(candidateUrl);
      try {
        const result = await fetchContentViaContentScript(data.tabId, candidateUrl, data.importId);

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

        // Download complete — signal 85% so the bar freezes near the end while
        // the upload to szurubooru completes (usually < 1s on a local network).
        onProgress?.(0.85);
        const tmpRes = await szuru.uploadTempFileFromBlob(blob, filename);
        return { token: tmpRes.token, fileSize: blob.size };
      } catch (ex) {
        console.warn("Content script fetch/upload failed for candidate URL:", candidateUrl, ex);
      } finally {
        await removeCorsRule(ruleId);
        endImportHost(importHost);
      }
    }
  }

  // 2) Try background-side content fetch with credentials/referrer.
  //    Inject a CORS rule so the background fetch can read the CDN response,
  //    mirroring the same approach used in step 1 for content script fetches.
  for (const candidateUrl of candidates) {
    const ruleId = await addCorsRule(candidateUrl, data.post.pageUrl).catch(() => 0);
    const importHost = beginImportHost(candidateUrl);
    try {
      const tmpRes = await szuru.uploadTempFile(candidateUrl, "content", data.post.referrer ?? data.post.pageUrl, onProgress);
      return { token: tmpRes.token };
    } catch (ex) {
      console.warn("Background content fetch/upload failed for candidate URL:", candidateUrl, ex);
    } finally {
      await removeCorsRule(ruleId);
      endImportHost(importHost);
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

async function tryLinkPostWithRelations(
  selectedSite: SzuruSiteConfig,
  newPostId: number,
  targetPostIds: number[],
) {
  const targets = [...new Set(targetPostIds)].filter((id) => id !== newPostId);
  if (targets.length === 0) return;

  const szuru = SzurubooruApi.createFromConfig(selectedSite);
  const post = await szuru.getPost(newPostId);
  const existingRelationIds = post.relations
    ?.map((x: any) => x?.id)
    .filter((x: unknown): x is number => typeof x == "number") ?? [];

  const missing = targets.filter((id) => !existingRelationIds.includes(id));
  if (missing.length === 0) return;

  await szuru.updatePost(newPostId, {
    version: post.version,
    relations: [...existingRelationIds, ...missing],
  });
}

function recordNormalUpload(siteId: string, postId: number) {
  const state = getSiteState(siteId);
  state.lastUploadedPostId = postId;
  state.linkChain = [];
  persistState();
}

function recordChainUpload(siteId: string, postId: number) {
  const state = getSiteState(siteId);
  state.linkChain.push(postId);
  state.lastUploadedPostId = postId;
  persistState();
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
      const acquiredContent = await tryAcquireContentToken(szuru, data, sendProgress);
      contentToken = acquiredContent?.token;
      if (acquiredContent?.fileSize) data.post.contentSize = acquiredContent.fileSize;

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

    // Exact duplicates are not relations. Keep the higher-quality content on
    // the existing post and merge newly discovered tags/sources into it.
    const storedCfg = await readStoredConfig();
    const exactDuplicate = storedCfg?.replaceExactDuplicates !== false && reverseSearchResult && getExactDuplicate(reverseSearchResult);
    if (exactDuplicate) {
      const duplicateInfo = await mergeExactDuplicate(szuru, data, exactDuplicate, contentToken);
      Object.assign(info, duplicateInfo);
      pushInfo();
      return info;
    }

    const createdPost = await szuru.createPost(data.post, contentToken);

    // Apply auto-relations from the stored reverse search results.
    if (reverseSearchResult) {
      try {
        const autoRelationsEnabled = storedCfg?.autoRelationsEnabled !== false; // default true
        const threshold = storedCfg?.autoRelationThreshold ?? DEFAULT_AUTO_RELATION_THRESHOLD;
        if (autoRelationsEnabled) {
          const relationIds = getAutoRelationIds(reverseSearchResult, createdPost.id, threshold);
          await tryApplyAutoRelations(szuru, createdPost.id, createdPost.version, relationIds);
          // Keep the successful automatic relation targets so the quick-import
          // history can show the same links that were written to Szurubooru.
          info.relatedPostIds = relationIds;
        }
      } catch (ex) {
        console.warn("Auto relation assignment failed:", getErrorMessage(ex));
      }
    }

    info.state = "uploaded";
    info.instancePostId = createdPost.id;
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

// ── Sequential import queue ────────────────────────────────────
// All hotkey, link-chain and context-menu imports go through this queue so
// they run one after another instead of racing. The chain bookkeeping for
// hotkey_import_link_last must happen in the queue worker (not at enqueue
// time) so the chain reflects the actual upload order.
const importQueue: ImportTask[] = [];
let queueRunning = false;
let activeQueueTask: ImportTask | undefined;

// Page URLs of imports that are currently pending — i.e. still sitting in the
// queue or actively uploading. A URL is removed as soon as its task settles, so
// only a genuine double-fire of the *same* page while a copy is still in flight
// is rejected. Distinct pages and deliberate re-imports of an already-finished
// page are always allowed (szurubooru's own "already uploaded" handling is the
// safety net there, surfaced as a success toast rather than a hard error).
const pendingPageUrls = new Set<string>();

function getTaskPageUrl(task: ImportTask): string | undefined {
  const post = task.scrapeResults?.results?.find((r: any) => Array.isArray(r?.posts) && r.posts.length > 0)?.posts?.[0];
  return post?.pageUrl;
}

function enqueueImport(task: ImportTask) {
  const pageUrl = getTaskPageUrl(task);
  if (pageUrl && pendingPageUrls.has(pageUrl)) {
    // The exact same page is already queued/uploading — this is a redundant
    // double-fire (e.g. the hotkey pressed twice on one page). Reject it so we
    // don't create two posts of the same image in a race.
    void sendQuickImportStatus(task.tabId, "error", {
      importId: task.importId,
      message: t("bg.duplicateInBurst"),
    });
    return;
  }
  if (pageUrl) pendingPageUrls.add(pageUrl);
  importQueue.push(task);
  persistState();
  void sendQuickImportStatus(task.tabId, "running", { importId: task.importId, queued: importQueue.length > 0 && queueRunning });
  void runQueue();
}

// Transient conditions worth another attempt: the network dropped, the CDN
// rate-limited us, or szurubooru itself hiccuped. A rejected upload (bad
// credentials, unsupported file, nothing to scrape) will fail identically on
// every retry, so those go straight to the failure list.
const RETRYABLE_PATTERNS = [
  /network/i,
  /timed? ?out/i,
  /timeout/i,
  /failed to fetch/i,
  /econnreset/i,
  /socket/i,
  /temporarily/i,
  /\bHTTP 4(08|29)\b/,
  /\bHTTP 5\d\d\b/,
];

function isRetryableError(message: string): boolean {
  return RETRYABLE_PATTERNS.some((re) => re.test(message));
}

async function getRetryConfig() {
  const cfg = await readStoredConfig();
  const enabled = cfg?.queueRetry?.enabled !== false;
  const maxAttempts = Math.max(1, cfg?.queueRetry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  return { enabled, maxAttempts, statsEnabled: cfg?.statsEnabled !== false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  // Uploads regularly outlive Chrome's 30s service-worker idle timeout.
  startKeepAlive();
  try {
    while (importQueue.length > 0) {
      const task = importQueue.shift()!;
      activeQueueTask = task;
      persistState();
      const pageUrl = getTaskPageUrl(task) ?? task.tabUrl;
      try {
        await processImportTask(task);
      } catch (ex) {
        const message = getErrorMessage(ex);
        const attempts = (task.attempts ?? 0) + 1;
        const { enabled, maxAttempts } = await getRetryConfig();

        if (enabled && attempts < maxAttempts && isRetryableError(message)) {
          // Exponential-ish backoff: 2s, 4s, 8s … capped so a long queue
          // behind a flaky host still drains in reasonable time.
          const delay = Math.min(2000 * 2 ** (attempts - 1), 15_000);
          console.warn(`Queued import failed (attempt ${attempts}/${maxAttempts}), retrying in ${delay}ms:`, message);
          await sendQuickImportStatus(task.tabId, "running", {
            importId: task.importId,
            queued: true,
            message: t("bg.retrying", { attempt: attempts + 1, total: maxAttempts }),
          });
          await sleep(delay);
          // Re-queue at the front so retries stay near their original position
          // instead of landing behind an entire burst.
          importQueue.unshift({ ...task, attempts });
          persistState();
          continue;
        }

        console.error("Queued import failed:", message);
        await sendQuickImportStatus(task.tabId, "error", { message, importId: task.importId });
        await recordFailure(task, message, attempts, pageUrl);
      } finally {
        const key = getTaskPageUrl(task);
        // Keep the de-dupe lock while a retry is pending — the task is back in
        // the queue and a fresh hotkey press for the same page is still a dupe.
        if (key && !importQueue.some((x) => getTaskPageUrl(x) === key)) {
          pendingPageUrls.delete(key);
        }
        activeQueueTask = undefined;
        persistState();
      }
    }
  } finally {
    queueRunning = false;
    stopKeepAlive();
    persistState();
  }
}

async function recordFailure(task: ImportTask, message: string, attempts: number, pageUrl?: string) {
  const { statsEnabled } = await getRetryConfig();
  if (!statsEnabled) return;
  const cfg = await readStoredConfig().catch(() => undefined);
  await recordImport({
    outcome: "error",
    pageUrl,
    siteId: cfg?.selectedSiteId,
    failure: {
      id: task.importId,
      pageUrl,
      siteId: cfg?.selectedSiteId,
      message,
      attempts,
      // Storing the scrape lets the options page retry without the original
      // tab still being open.
      scrapeResults: task.scrapeResults,
    },
  }).catch((ex) => console.warn("Failed to record import failure:", ex));
}

async function processImportTask(task: ImportTask) {
  // Signal that this specific import has started its actual upload phase.
  await sendQuickImportStatus(task.tabId, "running", { importId: task.importId, queued: false });
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const entry = activeImports.get(task.importId);
    if (entry?.status === "success" || entry?.status === "error") return;
    void sendQuickImportStatus(task.tabId, "heartbeat", {
      importId: task.importId,
      progress: entry?.progress,
      speedBytesPerSecond: entry?.speedBytesPerSecond,
      totalBytes: entry?.totalBytes,
      elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }, 1000);

  try {

  const result = await importCurrentPageInBackground(task.tabId, task.tabUrl, task.importId, task.scrapeResults);
  const postId = result?.info?.instancePostId;
  const postUrl = postId ? `${result.selectedSite.domain.replace(/\/+$/, "")}/post/${postId}` : undefined;
  const siteId = result.selectedSite.id;
  let linkedPostIds = result.info.relatedPostIds ? [...result.info.relatedPostIds] : undefined;

  if (postId) {
    if (task.kind === "link_last") {
      const state = getSiteState(siteId);
      // If the chain is empty, seed it with the previous "normal" upload so
      // the very first link-last upload still links to the last normal post.
      const seed = state.linkChain.length === 0 && state.lastUploadedPostId
        ? [state.lastUploadedPostId]
        : [];
      const targets = [...state.linkChain, ...seed];
      if (targets.length > 0) {
        try {
          await tryLinkPostWithRelations(result.selectedSite, postId, targets);
          linkedPostIds = [...new Set([...(linkedPostIds ?? []), ...targets])].filter((id) => id !== postId);
        } catch (ex) {
          console.warn("Chain relation linking failed:", getErrorMessage(ex));
        }
      }
      // Seed the chain with the previous upload too, so subsequent chain
      // entries keep linking back to it (and to each other).
      if (state.linkChain.length === 0 && state.lastUploadedPostId) {
        state.linkChain.push(state.lastUploadedPostId);
      }
      recordChainUpload(siteId, postId);
    } else {
      // Normal upload resets any active chain so the next link-last starts fresh.
      recordNormalUpload(siteId, postId);
    }
  }

  // Read the transferred size before the success update replaces the entry.
  const transferredBytes = activeImports.get(task.importId)?.totalBytes;

  await sendQuickImportStatus(task.tabId, "success", {
    postId,
    postUrl,
    alreadyUploaded: result.alreadyUploaded,
    linkedPostIds,
    duplicateOutcome: result.info.duplicateOutcome,
    importId: task.importId,
  });

  // Prime the badge cache so returning to this page shows "imported"
  // immediately instead of after the next lookup TTL.
  const taskPageUrl = getTaskPageUrl(task) ?? task.tabUrl;
  if (taskPageUrl && postId) {
    cacheImportedCheck(taskPageUrl, { imported: true, postId, postUrl });
  }

  // A retry that finally succeeded should disappear from the failure list.
  if (task.isRetry || (task.attempts ?? 0) > 0) {
    await removeFailure(task.importId).catch(() => { });
  }

  const { statsEnabled } = await getRetryConfig();
  if (statsEnabled) {
    await recordImport({
      outcome: result.alreadyUploaded ? "duplicate" : "success",
      pageUrl: taskPageUrl,
      siteId,
      bytes: transferredBytes,
      durationMs: Date.now() - startedAt,
    }).catch((ex) => console.warn("Failed to record import stats:", ex));
  }
  } finally {
    clearInterval(heartbeat);
  }
}

function getExactDuplicate(searchResult: ImageSearchResult): Post | undefined {
  return searchResult.exactPost ?? searchResult.similarPosts.find((result) => result.distance === 0)?.post;
}

function mergeDistinctLines(...values: Array<string | null | undefined>): string | null {
  const lines = new Set<string>();
  for (const value of values) {
    for (const line of value?.split("\n") ?? []) {
      const normalized = line.trim();
      if (normalized) lines.add(normalized);
    }
  }
  return lines.size ? [...lines].join("\n") : null;
}

function isIncomingContentBetter(post: Post, incoming: { resolution?: [number, number]; contentSize?: number }): boolean {
  const [incomingWidth = 0, incomingHeight = 0] = incoming.resolution ?? [];
  const incomingPixels = incomingWidth * incomingHeight;
  const existingPixels = post.canvasWidth * post.canvasHeight;
  if (incomingPixels !== existingPixels) return incomingPixels > existingPixels;

  // For the same resolution, a larger file normally preserves more detail.
  // Only compare it when the source provided an actual byte count.
  if (typeof incoming.contentSize === "number" && incoming.contentSize > 0) {
    return incoming.contentSize > post.fileSize;
  }
  return false;
}

async function mergeExactDuplicate(
  szuru: SzurubooruApi,
  data: PostUploadCommandData,
  existing: Post,
  contentToken?: string,
): Promise<PostUploadInfo> {
  const incomingTagNames = data.post.tags.map((tag: any) => tag.names?.[0]).filter((tag: unknown): tag is string => !!tag);
  const mergedTags = [...new Set([...existing.tags.flatMap((tag) => tag.names), ...incomingTagNames])];
  const mergedSource = mergeDistinctLines(existing.source, data.post.source);
  const replaceContent = isIncomingContentBetter(existing, data.post);
  const changedTags = mergedTags.length !== existing.tags.flatMap((tag) => tag.names).length;
  const changedSource = mergedSource !== existing.source;

  if (replaceContent || changedTags || changedSource) {
    const update: UpdatePostRequest = {
      version: existing.version,
      tags: mergedTags,
      source: mergedSource,
    };
    if (replaceContent) {
      if (contentToken) update.contentToken = contentToken;
      else update.contentUrl = data.post.contentUrl;
    }
    await szuru.updatePost(existing.id, update);
  }

  const info = new PostUploadInfo();
  info.state = "uploaded";
  info.instancePostId = existing.id;
  info.existingPostId = existing.id;
  info.duplicateOutcome = replaceContent ? "replaced" : "tags_merged";
  return info;
}

async function scrapeNowOrUndefined(tabId: number) {
  try {
    return await grabPostsFromTab(tabId);
  } catch (ex) {
    console.warn("Pre-enqueue scrape failed, queue task will rescrape:", getErrorMessage(ex));
    return undefined;
  }
}

async function handleHotkeyImport(data: { url: string; importId?: string; scrapeResults?: any }, senderTabId?: number) {
  const tabId = senderTabId ?? await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));
  const importId = data.importId ?? crypto.randomUUID();
  // Use scrape captured at hotkey time when present (avoids the queue picking
  // up a different page after the user navigates between hotkey presses).
  const scrapeResults = data.scrapeResults ?? await scrapeNowOrUndefined(tabId);
  enqueueImport({ kind: "normal", tabId, tabUrl: data.url, importId, scrapeResults });
}

async function handleHotkeyImportLinkLast(data: { url: string; importId?: string; scrapeResults?: any }, senderTabId?: number) {
  const tabId = senderTabId ?? await getActiveTabIdFallback();
  if (!tabId) throw new Error(t("bg.noActiveTab"));
  const importId = data.importId ?? crypto.randomUUID();
  const scrapeResults = data.scrapeResults ?? await scrapeNowOrUndefined(tabId);
  enqueueImport({ kind: "link_last", tabId, tabUrl: data.url, importId, scrapeResults });
}

// ── "Already imported" lookup ─────────────────────────────────────────
// The content script asks once per page. We answer from a short-lived cache
// so paging back and forth through a gallery doesn't hammer the instance.
export interface ImportedCheckResult {
  imported: boolean;
  postId?: number;
  postUrl?: string;
  /** Set when the lookup itself failed — the badge stays hidden. */
  unavailable?: boolean;
}

const IMPORTED_CHECK_TTL_MS = 5 * 60_000;
const IMPORTED_CHECK_CACHE_MAX = 300;
const importedCheckCache = new Map<string, { at: number; result: ImportedCheckResult }>();

function cacheImportedCheck(pageUrl: string, result: ImportedCheckResult) {
  importedCheckCache.set(pageUrl, { at: Date.now(), result });
  // Map iterates in insertion order, so the head is always the oldest entry.
  while (importedCheckCache.size > IMPORTED_CHECK_CACHE_MAX) {
    const oldest = importedCheckCache.keys().next().value;
    if (oldest === undefined) break;
    importedCheckCache.delete(oldest);
  }
}

// szurubooru parses ':' as a token separator, '-' as negation and '*' as a
// wildcard; '\' escapes all of them. We escape the needle and add our own
// wildcards afterwards.
function escapeSzuruSearchValue(value: string) {
  return value.replace(/([\\:*-])/g, "\\$1");
}

function normalizeSourceNeedle(pageUrl: string) {
  return pageUrl
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// The `source:*needle*` query matches substrings, so a page whose URL ends in
// a short id (e.g. rule34's "…&id=12") would also match a stored post sourced
// from "…&id=123". Re-check the candidate's actual source against a word
// boundary after the needle so "id=12" no longer matches "id=123", while a
// legitimate trailing slash / query separator / newline still counts.
function sourceMatchesPage(source: string | null | undefined, needle: string): boolean {
  if (!source) return false;
  const haystack = source.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return false;
    const after = haystack[idx + needle.length];
    // End of string, or a non-alphanumeric boundary → a genuine match.
    if (after === undefined || !/[a-z0-9]/.test(after)) return true;
    from = idx + 1;
  }
}

async function checkImported(data: { pageUrl?: string; force?: boolean }): Promise<ImportedCheckResult> {
  const pageUrl = data?.pageUrl;
  if (!pageUrl) return { imported: false };

  const cached = importedCheckCache.get(pageUrl);
  if (!data.force && cached && Date.now() - cached.at < IMPORTED_CHECK_TTL_MS) {
    return cached.result;
  }

  const cfg = await readStoredConfig();
  if (!cfg || cfg.importedBadge?.enabled === false) return { imported: false, unavailable: true };
  if (!cfg.sites?.length) return { imported: false, unavailable: true };

  const site = resolveSelectedSite(cfg, pageUrl);
  const szuru = new SzurubooruApi(site.domain, site.username, site.authToken);
  const needle = normalizeSourceNeedle(pageUrl);
  const query = `source:*${escapeSzuruSearchValue(needle)}*`;

  try {
    // Fetch a few candidates + their source: the substring query can return a
    // post that merely shares a URL prefix, so we confirm on a word boundary.
    const posts = await szuru.getPosts(query, 0, 5, ["id", "source"]);
    const post = posts.results?.find((p) => sourceMatchesPage(p.source, needle));
    const result: ImportedCheckResult = post
      ? {
          imported: true,
          postId: post.id,
          postUrl: `${site.domain.replace(/\/+$/, "")}/post/${post.id}`,
        }
      : { imported: false };
    cacheImportedCheck(pageUrl, result);
    return result;
  } catch (ex) {
    // A failed lookup must never surface as "not imported" — that would be a
    // false negative inviting a duplicate upload. Report it as unavailable.
    console.warn("Imported check failed:", getErrorMessage(ex));
    return { imported: false, unavailable: true };
  }
}

async function handleStatsMutate(data: { op?: string; id?: string }) {
  switch (data.op) {
    case "removeFailure":
      if (data.id) await removeFailure(data.id);
      return { ok: true };
    case "clearFailures":
      await clearFailures();
      return { ok: true };
    case "resetStats":
      await resetStats();
      return { ok: true };
    default:
      throw new Error(`Unknown stats op: ${data.op}`);
  }
}

// Create the pool if absent, else append; ids stay in selection order and are
// de-duplicated so re-running a batch doesn't add a post twice.
async function assignPostsToPool(
  site: { domain: string; username: string; authToken: string },
  poolName: string,
  postIds: number[],
): Promise<{ poolId?: number; error?: string }> {
  console.log(`[pool] assigning ${postIds.length} post(s) to pool "${poolName}"`, postIds);
  try {
    const szuru = new SzurubooruApi(site.domain, site.username, site.authToken);

    // Look for an existing pool by exact name. A search that errors (e.g. the
    // name trips szurubooru's query parser) must NOT abort the whole operation
    // — fall through and create the pool, which is the common case anyway.
    let existing: Awaited<ReturnType<typeof szuru.getPools>> | undefined;
    try {
      existing = await szuru.getPools(`name:${encodeTagName(poolName)}`, 0, 5, ["id", "names", "posts", "version"]);
    } catch (searchEx) {
      console.warn("[pool] search failed, will attempt to create instead:", getErrorMessage(searchEx));
    }

    const match = existing?.results?.find((p) => p.names?.some((n) => n.toLowerCase() === poolName.toLowerCase()));

    if (!match) {
      // `category` is required and must be an EXISTING pool category. Hardcoding
      // "default" fails on instances whose pool category is named differently
      // (that's why manual creation works but this didn't). Resolve the real
      // default category, falling back to "default" only if the lookup fails.
      let category = "default";
      try {
        const cats = (await szuru.getPoolCategories())?.results ?? [];
        const chosen = cats.find((c) => c.default) ?? cats[0];
        if (chosen?.name) category = chosen.name;
      } catch (catEx) {
        console.warn("[pool] could not read pool categories, using \"default\":", getErrorMessage(catEx));
      }

      // Create empty, then add posts via the proven updatePool path — some
      // szurubooru versions validate a create-with-posts payload differently.
      const created = await szuru.createPool(poolName, category);
      console.log(`[pool] created pool #${created.id} "${poolName}" (category "${category}"), adding ${postIds.length} post(s)`);
      if (postIds.length > 0) {
        await szuru.updatePool(created.id, { version: created.version ?? 0, posts: postIds });
      }
      return { poolId: created.id };
    }

    const seen = new Set<number>();
    const merged = [...match.posts.map((x) => x.id), ...postIds].filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    await szuru.updatePool(match.id, { version: match.version, posts: merged });
    console.log(`[pool] updated pool #${match.id} "${poolName}" → ${merged.length} post(s)`);
    return { poolId: match.id };
  } catch (ex) {
    console.error("[pool] assignment failed:", getErrorMessage(ex));
    return { error: getErrorMessage(ex) };
  }
}

async function handleBatchImport(data: { urls?: string[]; poolName?: string; batchId?: string }, originTabId?: number) {
  const urls = Array.isArray(data.urls) ? data.urls.filter((u) => typeof u === "string" && u) : [];
  if (urls.length === 0) throw new Error(t("bg.batchNoUrls"));
  const batchId = data.batchId ?? crypto.randomUUID();

  const req: BatchImportRequest = {
    urls,
    poolName: data.poolName?.trim() || undefined,
    originTabId,
    batchId,
  };
  console.log(`[batch] ${urls.length} url(s), pool: ${req.poolName ?? "(none)"}`);

  // Resolve the pool's target instance once (pool mode targets the selected
  // instance even if individual posts host-map elsewhere).
  const cfgForPool = req.poolName ? await readStoredConfig() : undefined;
  const poolSite = cfgForPool ? resolveSelectedSite(cfgForPool, undefined) : undefined;

  // A batch of tab-loads + uploads easily outlives Chrome's 30s service-worker
  // idle timeout, so hold the worker open for its duration (the plain queue
  // does the same). Stop only if the regular queue isn't also relying on it.
  startKeepAlive();

  // Fire-and-forget: the runner streams progress to the origin tab via
  // batch_status, so we don't block the message channel on the whole batch.
  // Success stats are recorded inline (once per item); failures are recorded
  // afterwards from the result list so per-attempt retries don't double-count.
  void runBatchImport(req, {
    concurrency: async () => {
      const cfg = await readStoredConfig();
      return cfg?.batchImport?.concurrency ?? 1;
    },
    importUrlInTab: async (url, tabId) => {
      const startedAt = Date.now();
      // Scrape with retries here (not inside importCurrentPageInBackground) so
      // a throttled background tab that isn't laid out yet gets another chance
      // instead of failing the item outright.
      const scrapeResults = await grabPostsWithRetry(tabId);
      const result = await importCurrentPageInBackground(tabId, url, crypto.randomUUID(), scrapeResults);
      const postId = result.info.instancePostId;
      const { statsEnabled } = await getRetryConfig();
      if (statsEnabled) {
        await recordImport({
          outcome: result.alreadyUploaded ? "duplicate" : "success",
          pageUrl: url,
          siteId: result.selectedSite.id,
          durationMs: Date.now() - startedAt,
        }).catch(() => { });
      }
      if (postId && url) cacheImportedCheck(url, { imported: true, postId });
      return { postId, alreadyUploaded: result.alreadyUploaded };
    },
    assignPool: async (poolName, postIds) => {
      if (!poolSite) return { error: t("bg.noInstances") };
      return assignPostsToPool(poolSite, poolName, postIds);
    },
  })
    .then(async (results) => {
      const { statsEnabled } = await getRetryConfig();
      if (!statsEnabled) return;
      const cfg = await readStoredConfig().catch(() => undefined);
      for (const r of results.filter((x) => x.error)) {
        await recordImport({
          outcome: "error",
          pageUrl: r.url,
          siteId: cfg?.selectedSiteId,
          failure: { id: crypto.randomUUID(), pageUrl: r.url, siteId: cfg?.selectedSiteId, message: r.error ?? "Unknown error", attempts: 1 },
        }).catch(() => { });
      }
    })
    .catch((ex) => console.error("Batch import failed:", getErrorMessage(ex)))
    .finally(() => { if (!queueRunning) stopKeepAlive(); });

  return { batchId, accepted: urls.length };
}

async function retryFailedImport(data: { id?: string }) {
  if (!data?.id) throw new Error("Missing failure id");
  const stats = await getStats();
  const failure = stats.failures.find((f) => f.id === data.id);
  if (!failure) throw new Error(t("bg.retryNotFound"));
  if (!failure.scrapeResults) throw new Error(t("bg.retryNoPayload"));

  // Drop it from the list up front: either the retry succeeds, or it fails
  // again and gets re-recorded with a fresh attempt count.
  await removeFailure(failure.id);

  enqueueImport({
    kind: "normal",
    tabId: undefined,
    tabUrl: failure.pageUrl,
    importId: crypto.randomUUID(),
    scrapeResults: failure.scrapeResults,
    isRetry: true,
  });

  return { queued: true };
}

async function messageHandler(cmd: BrowserCommand, sender: any): Promise<any> {
  console.log("Background received message:");
  console.dir(cmd);

  // Restoring first means a message arriving on a freshly-revived MV3 worker
  // still sees the link chain and queue from before it was torn down.
  await restoreState();

  switch (cmd.name) {
    case "upload_post":
      return uploadPost(cmd.data);
    case "update_post":
      return updatePost(cmd.data);
    case "fetch":
      return executeFetch(cmd.data);
    case "hotkey_import":
      return handleHotkeyImport(cmd.data, sender?.tab?.id);
    case "hotkey_import_link_last":
      return handleHotkeyImportLinkLast(cmd.data, sender?.tab?.id);
    case "get_active_imports": {
      const tabId = sender?.tab?.id;
      const result: Array<ActiveImportEntry & { importId: string }> = [];
      if (typeof tabId !== "number") return result;
      const returnedImportIds = new Set<string>();
      for (const [importId, entry] of activeImports) {
        if (entry.tabId !== tabId) continue;
        // Successful imports rebuild the compact history menu after a page
        // change. Errors remain transient and should not reappear on a later
        // page just because they are still in the short retention window.
        if (entry.status === "error") continue;
        result.push({ importId, ...entry });
        returnedImportIds.add(importId);
      }

      // The queue itself is the source of truth for work that still exists.
      // Include it in restoration as well so a content script loaded during a
      // rapid navigation never briefly sees only the active task because one
      // of the earlier queued status broadcasts was missed.
      if (activeQueueTask?.tabId === tabId && !returnedImportIds.has(activeQueueTask.importId)) {
        result.push({ importId: activeQueueTask.importId, tabId, status: "running", queued: false });
        returnedImportIds.add(activeQueueTask.importId);
      }
      for (const task of importQueue) {
        if (task.tabId !== tabId || returnedImportIds.has(task.importId)) continue;
        result.push({ importId: task.importId, tabId, status: "running", queued: true });
        returnedImportIds.add(task.importId);
      }
      return result;
    }
    case "check_imported":
      return checkImported(cmd.data ?? {});
    case "retry_failed_import":
      return retryFailedImport(cmd.data ?? {});
    case "batch_import":
      return handleBatchImport(cmd.data ?? {}, sender?.tab?.id);
    case "stats_mutate":
      // The options page delegates every stats write here so all writers share
      // the background's serialised chain (see stats.ts). Reads still happen
      // directly in the options context — only mutations must funnel through.
      return handleStatsMutate(cmd.data ?? {});
    case "report_progress": {
      const tabId = sender?.tab?.id;
      if (tabId) sendQuickImportStatus(tabId, "progress", { progress: cmd.data.progress, speedBytesPerSecond: cmd.data.speedBytesPerSecond, totalBytes: cmd.data.totalBytes, importId: cmd.data.importId });
      return;
    }
  }
}

browser.runtime.onMessage.addListener(messageHandler);

// ── Native Referer injection for extension popup image loads ────────────────
// When the popup's <img> tag tries to load a CDN-protected image, the browser
// sends the extension origin as Referer, which hotlink protection blocks. We
// replace it with the request host's own registrable domain so the hotlink
// check passes natively. We only touch requests from the extension context
// (tabId === -1) that are either image loads (popup previews) or part of an
// active import fetch — so unrelated traffic (e.g. szurubooru API calls) is
// never modified.
if ((browser as any).webRequest?.onBeforeSendHeaders) {
  try {
    (browser as any).webRequest.onBeforeSendHeaders.addListener(
      (details: any) => {
        if (details.tabId !== -1) return {};
        try {
          const base = registrableDomain(new URL(details.url).hostname);
          if (details.type !== "image" && !activeImportHosts.has(base)) return {};
          const spoofedReferer = `https://${base}/`;
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
// This is a fallback ONLY for browsers without declarativeNetRequest session
// rules (addCorsRule). On modern Chrome/Firefox addCorsRule handles this
// per-import, so we don't register this listener at all — avoiding any
// browser-wide webRequest cost. When we do register it, injection is limited to
// hosts of an in-flight import (activeImportHosts), so it never acts as a
// general CORS bypass on unrelated traffic.
{
  const dnr = (globalThis as any).chrome?.declarativeNetRequest ?? (browser as any).declarativeNetRequest;
  const sessionRulesAvailable = !!dnr?.updateSessionRules;
  if (!sessionRulesAvailable && (browser as any).webRequest?.onHeadersReceived) {
    try {
      (browser as any).webRequest.onHeadersReceived.addListener(
        (details: any) => {
          if (activeImportHosts.size === 0) return {};
          let host: string;
          try {
            host = new URL(details.url).hostname.toLowerCase();
          } catch {
            return {};
          }
          const base = registrableDomain(host);
          if (!activeImportHosts.has(base)) return {};
          const headers: Array<{ name: string; value: string }> = [...(details.responseHeaders ?? [])];
          if (headers.some((h: any) => h.name.toLowerCase() === "access-control-allow-origin")) {
            return {};
          }
          // Echo the requesting page's origin when known, else fall back to the
          // request host's own registrable domain.
          let origin: string | undefined;
          try {
            if (details.originUrl) origin = new URL(details.originUrl).origin;
          } catch { /* ignore */ }
          if (!origin) origin = `https://${base}`;
          headers.push({ name: "Access-Control-Allow-Origin", value: origin });
          headers.push({ name: "Access-Control-Allow-Credentials", value: "true" });
          return { responseHeaders: headers };
        },
        { urls: ["<all_urls>"], types: ["xmlhttprequest"] },
        ["blocking", "responseHeaders"],
      );
    } catch (ex) {
      console.warn("webRequest.onHeadersReceived CORS injection not available:", ex);
    }
  }
}

// Pick the queue and link-chain back up if the MV3 worker was torn down
// while imports were still pending.
void restoreState();

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
      if (!tabId) {
        console.error("Context-menu quick import: no active tab");
        return;
      }
      const scrapeResults = await scrapeNowOrUndefined(tabId);
      enqueueImport({ kind: "normal", tabId, tabUrl: tab?.url, importId, scrapeResults });
    })();
  });
}

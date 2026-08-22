// ── Import pipeline ───────────────────────────────────────────────────
// Turns a scrape into a szurubooru post: acquire the media, reverse search,
// deduplicate, create the post, then fix up tag categories and pools.
//
// Ordering constraint: content tokens are single-use and `createPost` consumes
// them, so the reverse search for auto-relations must run BEFORE createPost.

import SzurubooruApi from "~/api";
import {
  ImageSearchResult,
  PostAlreadyUploadedError,
  UpdatePoolRequest,
  UpdatePostRequest,
  type Post,
} from "~/api/models";
import { t } from "~/i18n";
import {
  BrowserCommand,
  PostUploadCommandData,
  PostUploadInfo,
  PostUpdateCommandData,
  SetExactPostId,
  SetPostUploadInfoData,
  type SzuruSiteConfig,
} from "~/models";
import { encodeTagName, getErrorMessage } from "~/utils";
import { base64ToArrayBuffer, isPlausibleMediaSize } from "~/shared/binary";
import { guessFilenameFromUrl, guessMimeTypeFromUrl, isBetterContent, measureImageSize } from "~/shared/media";
import {
  applyConfigToScrapedPost,
  buildPostDisplayName,
  getFirstScrapeHit,
  resolveTagRules,
  scrapeHasPost,
} from "~/shared/scrape";
import { sendTabCommand, isRestrictedTabUrl } from "~/shared/tabs";
import { sleep, withTimeout } from "~/shared/async";
import type { StoredConfig } from "~/shared/config";
import { hasSourceSitePermission, sourceSiteForUrl } from "~/shared/sourceSites";
import { withCdnAccess } from "./cdnAccess";
import { getImportSettings, persistSelectedSite, readStoredConfig, resolveSelectedSite } from "./settings";
import { sendQuickImportStatus } from "./status";

const CONTENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Progress fraction reported once the source download finished. The bar
 * freezes there while the (usually fast, unmeasurable) transfer to szurubooru
 * completes, rather than showing a fake upload rate.
 */
const DOWNLOAD_COMPLETE_PROGRESS = 0.85;

// ── Scraping ──────────────────────────────────────────────────────────

export function grabPostsFromTab(tabId: number): Promise<any> {
  return sendTabCommand(tabId, "grab_post");
}

/**
 * A background tab reports "complete" before a throttled booru page has laid
 * out its content, so a single scrape can see an empty DOM. Retry a few times
 * until a post appears (or we give up and let the caller report the miss).
 */
export async function grabPostsWithRetry(tabId: number, attempts = 5, delayMs = 500): Promise<any> {
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

/** Try to scrape now, tolerating failure — the queue task can rescrape later. */
export async function scrapeNowOrUndefined(tabId: number): Promise<any> {
  try {
    return await grabPostsFromTab(tabId);
  } catch (ex) {
    console.warn("Pre-enqueue scrape failed, queue task will rescrape:", getErrorMessage(ex));
    return undefined;
  }
}

/** Map a raw neo-scraper post into the shape `uploadPost` expects. */
function mapScrapedPostForUpload(scrapedPost: any, engine: string, cfg: StoredConfig, siteId?: string) {
  const post: any = {
    id: crypto.randomUUID(),
    name: buildPostDisplayName(engine, scrapedPost?.name),
    tags: (scrapedPost?.tags ?? [])
      .filter((tag: any) => tag.name && tag.name.trim())
      .map((tag: any) => ({ names: [tag.name], category: tag.category, implications: [] })),
    pools: [],
    notes: scrapedPost?.notes ?? [],
    contentUrl: scrapedPost?.contentUrl,
    extraContentUrl: scrapedPost?.extraContentUrl,
    contentSize: undefined,
    pageUrl: scrapedPost?.pageUrl,
    contentType: scrapedPost?.contentType,
    contentSubType: undefined,
    rating: scrapedPost?.rating,
    source: (scrapedPost?.sources ?? []).join("\n"),
    uploadMode: scrapedPost?.uploadMode,
    referrer: scrapedPost?.referrer,
    resolution: scrapedPost?.resolution,
    instanceSpecificData: {},
  };

  // The target instance may override the global tag rules, so resolve them
  // against the site this import is bound for.
  applyConfigToScrapedPost(post, { ...cfg, tagRules: resolveTagRules(cfg, siteId) });

  for (const site of cfg.sites ?? []) {
    post.instanceSpecificData[site.id] = {};
  }

  return post;
}

export interface ImportResult {
  info: PostUploadInfo;
  selectedSite: SzuruSiteConfig;
  alreadyUploaded: boolean;
}

/**
 * Import the page behind `tabId`. `preScrapedResults` (captured at enqueue or
 * hotkey time) takes precedence so navigation between enqueue and processing
 * can't make the task upload a different page — which would then collide as
 * "already uploaded" and block the rest of the burst. A retry launched from the
 * options page has no tab at all and always carries its stored payload.
 */
export async function importCurrentPageInBackground(
  tabId: number | undefined,
  tabUrl?: string,
  importId?: string,
  preScrapedResults?: any,
): Promise<ImportResult> {
  if (isRestrictedTabUrl(tabUrl)) {
    throw new Error(t("bg.restrictedPage"));
  }

  const cfg = await readStoredConfig();
  if (!cfg) throw new Error(t("bg.noConfig"));

  const selectedSite = resolveSelectedSite(cfg, tabUrl);
  await persistSelectedSite(cfg, selectedSite.id);

  const scrapeResults = preScrapedResults ?? (typeof tabId === "number" ? await grabPostsFromTab(tabId) : undefined);
  const hit = getFirstScrapeHit(scrapeResults);
  if (!hit) throw new Error(t("bg.noMedia"));

  const post = mapScrapedPostForUpload(hit.post, hit.engine, cfg, selectedSite.id);

  // `activeTab` lets a hotkey scrape the visible document, but it does not
  // grant access to a booru's image-CDN subdomains. Since the source-access
  // refactor those origins are opt-in. Fail early rather than letting the
  // server-side URL downloader hit booru hotlink protection and report 500.
  const sourceSite = sourceSiteForUrl(post.pageUrl ?? tabUrl ?? "");
  if (sourceSite && !(await hasSourceSitePermission(sourceSite))) {
    throw new Error(t("bg.sourceAccessRequired", { site: sourceSite.label }));
  }
  const info = await uploadPost(new PostUploadCommandData(post, selectedSite, tabId, importId));

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

// ── Content acquisition ───────────────────────────────────────────────

function getCandidateContentUrls(post: { contentUrl: string; extraContentUrl?: string }): string[] {
  const candidates: string[] = [];
  if (post.contentUrl) candidates.push(post.contentUrl);
  if (post.extraContentUrl && post.extraContentUrl != post.contentUrl) candidates.push(post.extraContentUrl);
  return candidates;
}

function fetchContentViaContentScript(tabId: number, url: string, importId?: string): Promise<{ base64: string; mimeType: string }> {
  return withTimeout(
    sendTabCommand(tabId, "fetch_content", { url, importId }),
    CONTENT_FETCH_TIMEOUT_MS,
    `Content-script fetch timed out after ${CONTENT_FETCH_TIMEOUT_MS / 1000}s`,
  );
}

/** Fetch in the page context (cookies + Referer intact) and upload the blob. */
async function uploadViaContentScript(
  szuru: SzurubooruApi,
  tabId: number,
  candidateUrl: string,
  importId: string | undefined,
  onProgress?: (progress: number) => void,
): Promise<{ token: string; fileSize: number; resolution?: [number, number] } | undefined> {
  const result = await fetchContentViaContentScript(tabId, candidateUrl, importId);

  // Content script returns base64 to survive message serialization.
  if (!result.base64 || typeof result.base64 !== "string") {
    console.warn("Content script returned invalid data (missing base64 string) – skipping.");
    return undefined;
  }

  const buffer = base64ToArrayBuffer(result.base64);
  const mimeType = guessMimeTypeFromUrl(candidateUrl, result.mimeType);
  const blob = new Blob([buffer], { type: mimeType });

  // Sanity-check: reject obviously wrong content (e.g. HTML error pages).
  if (!isPlausibleMediaSize(blob.size)) {
    console.warn("Content script fetch returned suspiciously small payload:", blob.size, "bytes – skipping.");
    return undefined;
  }

  onProgress?.(DOWNLOAD_COMPLETE_PROGRESS);
  // Measure while we hold the bytes: this is the only point in the pipeline
  // where the real pixel size is knowable, and the duplicate comparison needs
  // it to decide which of two versions of the same image to keep.
  const resolution = await measureImageSize(blob);
  const tmpRes = await szuru.uploadTempFileFromBlob(blob, guessFilenameFromUrl(candidateUrl, mimeType));
  return { token: tmpRes.token, fileSize: blob.size, resolution };
}

/**
 * Obtain a content token, trying every route before giving up and letting
 * `createPost` fall back to plain URL mode.
 */
async function tryAcquireContentToken(
  szuru: SzurubooruApi,
  data: PostUploadCommandData,
  onProgress?: (progress: number) => void,
): Promise<{ token: string; fileSize?: number; resolution?: [number, number] } | undefined> {
  const candidates = getCandidateContentUrls(data.post);
  const pageUrl = data.post.pageUrl;

  // 1) Content-script fetch in page context — best chance against hotlink
  //    protection, since it carries the page's cookies and Referer.
  if (data.tabId) {
    for (const candidateUrl of candidates) {
      try {
        const acquired = await withCdnAccess(candidateUrl, pageUrl, () =>
          uploadViaContentScript(szuru, data.tabId!, candidateUrl, data.importId, onProgress));
        if (acquired) return acquired;
      } catch (ex) {
        console.warn("Content script fetch/upload failed for candidate URL:", candidateUrl, ex);
      }
    }
  }

  // 2) Background-side fetch with credentials/referrer.
  for (const candidateUrl of candidates) {
    try {
      return await withCdnAccess(candidateUrl, pageUrl, async () => {
        const tmpRes = await szuru.uploadTempFile(candidateUrl, "content", data.post.referrer ?? pageUrl, onProgress);
        return { token: tmpRes.token };
      });
    } catch (ex) {
      console.warn("Background content fetch/upload failed for candidate URL:", candidateUrl, ex);
    }
  }

  return undefined;
}

// ── Relations & duplicates ────────────────────────────────────────────

function getAutoRelationIds(searchResult: ImageSearchResult, createdPostId: number, thresholdPercent: number): number[] {
  const maxDistance = 1 - thresholdPercent / 100;
  const relationIds = new Set<number>();

  for (const similar of searchResult.similarPosts) {
    if (similar.post.id == createdPostId) continue;
    if (similar.distance <= maxDistance) relationIds.add(similar.post.id);
  }

  return [...relationIds];
}

/** Add `targetPostIds` to a post's relations, keeping the ones already set. */
export async function tryLinkPostWithRelations(
  selectedSite: SzuruSiteConfig,
  newPostId: number,
  targetPostIds: number[],
): Promise<void> {
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

/**
 * Decide whether the incoming file should replace the one on the existing post.
 * `measuredResolution` (read from the downloaded bytes) is preferred over the
 * scraped one, which most engines never fill in — see `isBetterContent`.
 */
function isIncomingContentBetter(
  post: Post,
  incoming: { resolution?: [number, number]; measuredResolution?: [number, number]; contentSize?: number },
): boolean {
  const [width, height] = incoming.measuredResolution ?? incoming.resolution ?? [];
  return isBetterContent(
    { width: post.canvasWidth, height: post.canvasHeight, fileSize: post.fileSize },
    { width, height, fileSize: incoming.contentSize },
  );
}

/**
 * Exact duplicates are not relations. Keep the higher-quality content on the
 * existing post and merge newly discovered tags/sources into it.
 */
async function mergeExactDuplicate(
  szuru: SzurubooruApi,
  data: PostUploadCommandData,
  existing: Post,
  contentToken?: string,
): Promise<PostUploadInfo> {
  const incomingTagNames = data.post.tags.map((tag: any) => tag.names?.[0]).filter((tag: unknown): tag is string => !!tag);
  const existingTagNames = existing.tags.flatMap((tag) => tag.names);
  const mergedTags = [...new Set([...existingTagNames, ...incomingTagNames])];
  const mergedSource = mergeDistinctLines(existing.source, data.post.source);
  const replaceContent = isIncomingContentBetter(existing, data.post);
  const changedTags = mergedTags.length !== existingTagNames.length;
  const changedSource = mergedSource !== existing.source;

  const incomingSize = data.post.measuredResolution ?? data.post.resolution;
  console.log(
    `[duplicate] post #${existing.id}: existing ${existing.canvasWidth}×${existing.canvasHeight} `
    + `(${existing.fileSize} B) vs incoming ${incomingSize ? incomingSize.join("×") : "?"} `
    + `(${data.post.contentSize ?? "?"} B) → ${replaceContent ? "replacing content" : "keeping existing content"}`,
  );

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

// ── Post-creation follow-up ───────────────────────────────────────────

/**
 * szurubooru creates unknown tags in the "default" category, so any category
 * the scrape supplied has to be applied afterwards — and only when the
 * instance actually has a category by that name.
 */
async function applyTagCategories(
  szuru: SzurubooruApi,
  data: PostUploadCommandData,
  createdPost: Post,
  info: PostUploadInfo,
  pushInfo: () => void,
): Promise<void> {
  const tagsWithCategory = data.post.tags.filter((x) => x.category);
  const unsetCategoryTags = createdPost.tags
    .filter((x) => x.category == "default")
    .filter((x) => tagsWithCategory.some((y) => x.names.includes(y.names[0])));

  if (unsetCategoryTags.length == 0) return;

  info.updateTagsState = { total: unsetCategoryTags.length };
  pushInfo();

  // unsetCategoryTags is MicroTag[]; a full Tag resource is needed to update it.
  const query = unsetCategoryTags.map((x) => encodeTagName(x.names[0])).join();
  const tags = (await szuru.getTags(query)).results;
  const existingCategories = (await szuru.getTagCategories()).results;
  let categoriesChangedCount = 0;

  for (const [index, tag] of tags.entries()) {
    info.updateTagsState.current = index;
    pushInfo();

    const wantedCategory = tagsWithCategory.find((x) => tag.names.includes(x.names[0]))?.category;
    if (!wantedCategory) continue;

    if (!existingCategories.some((x) => x.name == wantedCategory)) {
      console.log(
        `Not adding the '${wantedCategory}' category to the tag '${tag.names[0]}' because the szurubooru instance does not have this category.`,
      );
      continue;
    }

    tag.category = wantedCategory;
    await szuru.updateTag(tag);
    categoriesChangedCount++;
  }

  if (categoriesChangedCount > 0) {
    info.updateTagsState.totalChanged = categoriesChangedCount;
    pushInfo();
  }
}

/** Add the created post to each scraped pool, creating pools that don't exist. */
async function addPostToScrapedPools(szuru: SzurubooruApi, data: PostUploadCommandData, createdPostId: number): Promise<void> {
  for (const scrapedPool of data.post.pools) {
    // Attention! Don't use the .name getter as it does not exist. Just use names[0].
    const existingPools = await szuru.getPools(encodeTagName(scrapedPool.names[0]), 0, 1, ["id", "posts", "version"]);

    if (existingPools.results.length == 0) {
      console.log(`Creating new pool ${scrapedPool.names[0]} and adding post ${createdPostId}.`);
      await szuru.createPool(scrapedPool.names[0], "default", [createdPostId]);
      continue;
    }

    const existingPool = existingPools.results[0];
    const posts = existingPool.posts.map((x) => x.id);
    posts.push(createdPostId);

    console.log(`Adding post ${createdPostId} to existing pool ${existingPool.id}`);
    await szuru.updatePool(existingPool.id, <UpdatePoolRequest>{ version: existingPool.version, posts });
  }
}

// ── Upload ────────────────────────────────────────────────────────────

export async function uploadPost(data: PostUploadCommandData): Promise<PostUploadInfo> {
  const info: PostUploadInfo = { state: "uploading" };

  // Fire-and-forget – if the popup is closed the message fails silently, which
  // is fine (the popup resets its state on reopen).
  const pushInfo = () =>
    void browser.runtime.sendMessage(
      new BrowserCommand("set_post_upload_info", new SetPostUploadInfoData(data.selectedSite.id, data.post.id, info)),
    ).catch(() => { /* popup may be closed */ });

  // Throttle progress to the content script: only send on a ≥2% change.
  let lastProgressSent = 0;
  const sendProgress = (progress: number) => {
    if (data.tabId && (progress - lastProgressSent >= 0.02 || progress >= 1)) {
      lastProgressSent = progress;
      void sendQuickImportStatus(data.tabId, "progress", { progress, importId: data.importId });
    }
  };

  try {
    const szuru = SzurubooruApi.createFromConfig(data.selectedSite);
    pushInfo();

    let contentToken = data.post.instanceSpecificData[data.selectedSite.id]?.contentToken;

    if (!contentToken) {
      const acquiredContent = await tryAcquireContentToken(szuru, data, sendProgress);
      contentToken = acquiredContent?.token;
      if (acquiredContent?.fileSize) data.post.contentSize = acquiredContent.fileSize;
      if (acquiredContent?.resolution) data.post.measuredResolution = acquiredContent.resolution;

      // Last chance before URL mode: prefer extraContentUrl if present, as many
      // booru pages expose CDN links that block server-side fetch while alt URLs work.
      if (!contentToken && data.post.extraContentUrl && data.post.extraContentUrl != data.post.contentUrl) {
        console.warn("No content token acquired; switching createPost URL to extraContentUrl as fallback.");
        data.post.contentUrl = data.post.extraContentUrl;
      }
      // If contentToken is still undefined here → createPost uses contentUrl (URL mode).
    }

    // Reverse search BEFORE createPost – content tokens are single-use and get
    // consumed by createPost, so we must search while the token is alive.
    let reverseSearchResult: ImageSearchResult | undefined;
    try {
      reverseSearchResult = contentToken
        ? await szuru.reverseSearchToken(contentToken)
        : await szuru.reverseSearch(data.post.contentUrl);
    } catch (ex) {
      console.warn("Pre-upload reverse search failed (auto-relations):", getErrorMessage(ex));
    }

    const settings = await getImportSettings();

    const exactDuplicate = settings.replaceExactDuplicates && reverseSearchResult
      ? getExactDuplicate(reverseSearchResult)
      : undefined;
    if (exactDuplicate) {
      Object.assign(info, await mergeExactDuplicate(szuru, data, exactDuplicate, contentToken));
      pushInfo();
      return info;
    }

    const createdPost = await szuru.createPost(data.post, contentToken);

    // Apply auto-relations from the stored reverse search results.
    if (reverseSearchResult && settings.autoRelationsEnabled) {
      try {
        const relationIds = getAutoRelationIds(reverseSearchResult, createdPost.id, settings.autoRelationThreshold);
        if (relationIds.length > 0) {
          await szuru.updatePost(createdPost.id, { version: createdPost.version, relations: relationIds });
        }
        // Keep the successful automatic relation targets so the quick-import
        // history can show the same links that were written to szurubooru.
        info.relatedPostIds = relationIds;
      } catch (ex) {
        console.warn("Auto relation assignment failed:", getErrorMessage(ex));
      }
    }

    info.state = "uploaded";
    info.instancePostId = createdPost.id;
    pushInfo();

    await applyTagCategories(szuru, data, createdPost, info, pushInfo);
    await addPostToScrapedPools(szuru, data, createdPost.id);

    return info;
  } catch (ex: any) {
    if (ex.name && ex.name == "PostAlreadyUploadedError") {
      console.info("Post already uploaded:", getErrorMessage(ex));
      const otherPostId = (ex as PostAlreadyUploadedError).otherPostId;
      info.existingPostId = otherPostId;
      void browser.runtime.sendMessage(
        new BrowserCommand("set_exact_post_id", new SetExactPostId(data.selectedSite.id, data.post.id, otherPostId)),
      ).catch(() => { /* popup may be closed */ });
      // No error message: already-uploaded posts get their own wording.
    } else {
      console.error("Upload failed:", getErrorMessage(ex));
      info.error = getErrorMessage(ex);
    }
    info.state = "error";
    pushInfo();
    return info;
  }
}

/** Apply a merge from the popup's MergePost page to an existing post. */
export async function updatePost(data: PostUpdateCommandData): Promise<void> {
  const info: PostUploadInfo = { state: "uploading", instancePostId: data.postId };

  const pushInfo = () =>
    void browser.runtime.sendMessage(
      new BrowserCommand("set_post_update_info", new SetPostUploadInfoData(data.selectedSite.id, `merge-${data.postId}`, info)),
    ).catch(() => { /* popup may be closed */ });

  try {
    pushInfo();
    await SzurubooruApi.createFromConfig(data.selectedSite).updatePost(data.postId, data.updateRequest);
    info.state = "uploaded";
    pushInfo();
  } catch (ex: any) {
    console.error(ex);
    info.state = "error";
    info.error = getErrorMessage(ex);
    pushInfo();
  }
}

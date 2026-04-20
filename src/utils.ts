import byteSize from "byte-size";
import { MicroUser, Post } from "./api/models";
import { BrowserCommand } from "./models";
import { ScrapedPostDetails, TagDetails } from "./models";
import SzurubooruApi from "./api";

export function getUrl(root: string, ...parts: string[]): string {
  let url = root.replace(/\/+$/, "");
  for (const part of parts) {
    url += "/" + part.replace(/\/+$/, "");
  }
  return url;
}

export function encodeTagName(tagName: string) {
  // Searching for posts with re:zero will show an error message about unknown named token.
  // Searching for posts with re\:zero will show posts tagged with re:zero.
  return tagName.replace(/:/g, "\\:");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getErrorMessage(ex: any) {
  if (ex == null) return "Unknown error";

  if (typeof ex === "string") return ex;

  // Native Error and many browser/runtime errors
  if (typeof ex.message === "string" && ex.message.length > 0) {
    return ex.message;
  }

  if (typeof ex.description === "string" && ex.description.length > 0) {
    return ex.description;
  }

  // HTTP/axios-like error shapes
  const responseData = ex.response?.data;
  if (typeof responseData === "string" && responseData.length > 0) {
    return responseData;
  }

  if (responseData && typeof responseData === "object") {
    const responseMessage
      = responseData.message
        ?? responseData.description
        ?? responseData.error
        ?? responseData.reason
        ?? responseData.title;
    if (typeof responseMessage === "string" && responseMessage.length > 0) {
      return responseMessage;
    }
  }

  // Browser fetch/HTTP status-like objects
  if (typeof ex.status === "number" && typeof ex.statusText === "string") {
    return `HTTP ${ex.status} ${ex.statusText}`;
  }

  // Last-resort serialization so objects do not render as "[object Object]"
  try {
    const serialized = JSON.stringify(ex);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Ignore serialization errors and fall through.
  }

  return String(ex);
}

export function emptyMicroUser(): MicroUser {
  return {
    name: "",
    avatarUrl: "",
  };
}

export function emptyPost(): Post {
  return {
    id: 0,
    version: 0,
    creationTime: new Date(),
    lastEditTime: new Date(),
    safety: "safe",
    source: "",
    type: "",
    mimeType: "",
    checksum: "",
    fileSize: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    contentUrl: "",
    thumbnailUrl: "",
    flags: [],
    tags: [],
    relations: [],
    user: emptyMicroUser(),
    score: 0,
    ownScore: 0,
    ownFavorite: false,
    tagCount: 0,
    favoriteCount: 0,
    commentCount: 0,
    noteCount: 0,
    relationCount: 0,
    featureCount: 0,
    lastFeatureTime: new Date(),
    favoritedBy: [],
    hasCustomThumbnail: false,
    notes: [],
    comments: [],
  };
}

export function getTagClasses(tag: TagDetails): string[] {
  const classes: string[] = [];

  if (tag.category && tag.category != "default") {
    classes.push("tag-" + tag.category);
  } else {
    classes.push("tag-general");
  }

  return classes;
}

export function breakTagName(tagName: string) {
  // Based on https://stackoverflow.com/a/6316913
  return tagName.replace(/_/g, "_<wbr>");
}

/**
 * Guess a MIME type from a URL's file extension when the server returns
 * a generic `application/octet-stream` (or no type at all).
 */
export function guessMimeTypeFromUrl(url: string, detectedMime?: string): string {
  if (detectedMime && detectedMime !== "application/octet-stream") return detectedMime;

  const extMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    swf: "application/x-shockwave-flash",
  };

  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (ext && extMap[ext]) return extMap[ext];
  } catch { /* ignore malformed URLs */ }

  return detectedMime || "application/octet-stream";
}

export function resolutionToString(resolution: [number, number]) {
  if (resolution && resolution.length == 2) {
    return resolution[0] + "x" + resolution[1];
  }
  return "";
}

export function getPostInfoSummary(post: ScrapedPostDetails) {
  const parts = [];
  if (post.contentSize) {
    parts.push(byteSize(post.contentSize));
  }
  if (post.resolution) {
    parts.push(resolutionToString(post.resolution));
  }
  return parts.join(" / ");
}

export async function ensurePostHasContentToken(selectedInstance: SzurubooruApi, post: ScrapedPostDetails, cfg: any) {
  if (!selectedInstance || !cfg.value.selectedSiteId) return;

  const instanceSpecificData = post.instanceSpecificData[cfg.value.selectedSiteId];

  if (!instanceSpecificData) {
    console.error("instanceSpecificData is undefined. This should never happen!");
    return;
  }

  if (instanceSpecificData.contentToken) {
    console.log("[ensurePostHasContentToken] contentToken is already set.");
    return;
  }

  const isMissingContentScriptError = (ex: unknown) => {
    const msg = getErrorMessage(ex).toLowerCase();
    return msg.includes("receiving end does not exist")
      || msg.includes("could not establish connection")
      || msg.includes("no matching message handler");
  };

  const isRestrictedTabUrl = (url?: string) => {
    if (!url) return false;
    const x = url.toLowerCase();
    return x.startsWith("chrome://") || x.startsWith("edge://") || x.startsWith("about:");
  };

  const ensureContentScriptLoaded = async (tabId: number) => {
    const scripting = (browser as any).scripting;
    if (scripting?.executeScript) {
      await scripting.executeScript({
        target: { tabId },
        files: ["dist/contentScripts/index.global.js"],
      });
      return;
    }

    await browser.tabs.executeScript(tabId, { file: "./dist/contentScripts/index.global.js" });
  };

  const fetchViaContentScript = async (tabId: number) => {
    try {
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url: post.contentUrl }));
    } catch (ex) {
      if (!isMissingContentScriptError(ex)) throw ex;
      await ensureContentScriptLoaded(tabId);
      return await browser.tabs.sendMessage(tabId, new BrowserCommand("fetch_content", { url: post.contentUrl }));
    }
  };

  try {
    const tmpRes = await selectedInstance.uploadTempFile(post.contentUrl, post.uploadMode, post.referrer);
    // Save contentToken in PostViewModel so that we can reuse it when creating/uploading the post.
    instanceSpecificData.contentToken = tmpRes.token;
  } catch (ex) {
    // Fallback for hotlink-protected sources in Chrome: fetch from page context
    // via content script, then upload blob to szuru.
    try {
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = activeTabs[0];
      if (!tab?.id || isRestrictedTabUrl(tab.url)) {
        throw ex;
      }

      const result: { base64: string; mimeType: string } = await fetchViaContentScript(tab.id);
      // Decode base64 back to binary (content script encodes as base64 for safe message passing)
      const binaryStr = atob(result.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      if (bytes.byteLength < 64) {
        throw new Error("Content script returned suspiciously small payload – likely not actual media.");
      }
      const correctedMime = guessMimeTypeFromUrl(post.contentUrl, result.mimeType);
      const blob = new Blob([bytes], { type: correctedMime });
      const tmpRes = await selectedInstance.uploadTempFileFromBlob(blob);
      instanceSpecificData.contentToken = tmpRes.token;
      return;
    } catch (fallbackEx) {
      instanceSpecificData.genericError = "Couldn't upload content. " + getErrorMessage(fallbackEx);
      throw fallbackEx;
    }
  }
}

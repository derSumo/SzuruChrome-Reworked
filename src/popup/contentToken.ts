// ── Content token acquisition (popup path) ────────────────────────────
// szurubooru needs the media bytes before a post can be created or reverse
// searched. The straightforward route is to hand it the content URL and let
// the server fetch it; hotlink-protected CDNs reject that, so we fall back to
// fetching from the active tab's page context (cookies + Referer intact) and
// uploading the blob ourselves.

import type SzurubooruApi from "~/api";
import type { ScrapedPostDetails } from "~/models";
import { getErrorMessage } from "~/utils";
import { base64ToArrayBuffer, isPlausibleMediaSize } from "~/shared/binary";
import { guessFilenameFromUrl, guessMimeTypeFromUrl } from "~/shared/media";
import { getActiveTab, isRestrictedTabUrl, sendTabCommand } from "~/shared/tabs";

/** Fetch media through the active tab's content script and upload it. */
async function uploadViaActiveTab(szuru: SzurubooruApi, contentUrl: string) {
  const tab = await getActiveTab();
  if (!tab?.id || isRestrictedTabUrl(tab.url)) {
    throw new Error("No usable tab to fetch the content from.");
  }

  const result: { base64: string; mimeType: string } = await sendTabCommand(tab.id, "fetch_content", { url: contentUrl });
  const buffer = base64ToArrayBuffer(result.base64);
  if (!isPlausibleMediaSize(buffer.byteLength)) {
    throw new Error("Content script returned suspiciously small payload – likely not actual media.");
  }

  const mimeType = guessMimeTypeFromUrl(contentUrl, result.mimeType);
  const blob = new Blob([buffer], { type: mimeType });
  return szuru.uploadTempFileFromBlob(blob, guessFilenameFromUrl(contentUrl, mimeType));
}

/**
 * Ensure `post` holds a content token for the selected instance, acquiring one
 * if needed. Records the failure on the post and rethrows when both routes fail.
 */
export async function ensurePostHasContentToken(
  selectedInstance: SzurubooruApi,
  post: ScrapedPostDetails,
  cfg: { value: { selectedSiteId?: string } },
): Promise<void> {
  const selectedSiteId = cfg.value.selectedSiteId;
  if (!selectedInstance || !selectedSiteId) return;

  const instanceSpecificData = post.instanceSpecificData[selectedSiteId];
  if (!instanceSpecificData) {
    console.error("instanceSpecificData is undefined. This should never happen!");
    return;
  }

  if (instanceSpecificData.contentToken) return;

  try {
    const tmpRes = await selectedInstance.uploadTempFile(post.contentUrl, post.uploadMode, post.referrer);
    instanceSpecificData.contentToken = tmpRes.token;
  } catch (ex) {
    console.warn("Direct temp-file upload failed, retrying via page context:", getErrorMessage(ex));
    try {
      const tmpRes = await uploadViaActiveTab(selectedInstance, post.contentUrl);
      instanceSpecificData.contentToken = tmpRes.token;
    } catch (fallbackEx) {
      instanceSpecificData.genericError = "Couldn't upload content. " + getErrorMessage(fallbackEx);
      throw fallbackEx;
    }
  }
}

// ── MIME / filename inference ─────────────────────────────────────────
// Booru CDNs frequently answer with `application/octet-stream` (or nothing at
// all), and szurubooru uses the uploaded filename's extension as a type hint.
// Both are derived from the URL here.

const EXTENSION_TO_MIME: Record<string, string> = {
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

const MIME_TO_FILENAME: Record<string, string> = {
  "image/jpeg": "file.jpg",
  "image/png": "file.png",
  "image/gif": "file.gif",
  "image/webp": "file.webp",
  "image/avif": "file.avif",
  "video/mp4": "file.mp4",
  "video/webm": "file.webm",
};

export const GENERIC_MIME = "application/octet-stream";

/** Last path segment of a URL when it looks like a filename. */
function filenameFromUrl(url: string): string | undefined {
  try {
    const lastSegment = new URL(url).pathname.split("/").pop();
    if (lastSegment && lastSegment.includes(".")) return lastSegment;
  } catch { /* ignore malformed URLs */ }
  return undefined;
}

/**
 * Guess a MIME type from a URL's file extension when the server returned a
 * generic `application/octet-stream` (or no type at all).
 */
export function guessMimeTypeFromUrl(url: string, detectedMime?: string): string {
  if (detectedMime && detectedMime !== GENERIC_MIME) return detectedMime;

  const ext = filenameFromUrl(url)?.split(".").pop()?.toLowerCase();
  if (ext && EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];

  return detectedMime || GENERIC_MIME;
}

/**
 * Filename to upload under: the URL's own name when it has one, otherwise a
 * synthetic name carrying the right extension for the MIME type.
 */
export function guessFilenameFromUrl(url: string, mimeType?: string): string {
  return filenameFromUrl(url) ?? (mimeType ? MIME_TO_FILENAME[mimeType] : undefined) ?? "file.bin";
}

/**
 * Real pixel size of an image blob, or undefined when it can't be decoded
 * (video, Flash, a broken download).
 *
 * Scrapers report a resolution only when the booru happens to print one, so the
 * bytes we already downloaded are the one source that is always available and
 * always right. `createImageBitmap` exists in the MV3 service worker, which is
 * where the duplicate comparison runs.
 */
export async function measureImageSize(blob: Blob): Promise<[number, number] | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  if (blob.type && !blob.type.startsWith("image/")) return undefined;
  try {
    const bitmap = await createImageBitmap(blob);
    const size: [number, number] = [bitmap.width, bitmap.height];
    bitmap.close?.();
    return size[0] > 0 && size[1] > 0 ? size : undefined;
  } catch {
    // Animated/exotic formats the decoder rejects fall back to file size.
    return undefined;
  }
}

export interface ContentQuality {
  width?: number;
  height?: number;
  fileSize?: number;
}

/**
 * Whether `incoming` is the better version of the same image as `existing`.
 *
 * Resolution decides when both sides report one; file size is the tie-break and
 * the fallback. The subtle case is a *missing* resolution: booru scrapers only
 * fill one in when the page happens to print it, and treating that as "0
 * pixels" made every such import lose against the stored post — the reason an
 * obviously larger re-upload could be silently discarded. An unknown size
 * therefore decides on bytes instead of losing outright, which also covers
 * video, Flash and posts szurubooru stored with a zero canvas.
 */
export function isBetterContent(existing: ContentQuality, incoming: ContentQuality): boolean {
  const incomingPixels = (incoming.width ?? 0) * (incoming.height ?? 0);
  const existingPixels = (existing.width ?? 0) * (existing.height ?? 0);
  const largerFile = (incoming.fileSize ?? 0) > 0 && (incoming.fileSize ?? 0) > (existing.fileSize ?? 0);

  if (incomingPixels > 0 && existingPixels > 0 && incomingPixels !== existingPixels) {
    return incomingPixels > existingPixels;
  }
  return largerFile;
}

/** True for content types szurubooru can actually store as a post. */
export function isSupportedMediaType(mimeType: string): boolean {
  const prefix = mimeType.split("/")[0];
  return prefix === "image" || prefix === "video" || mimeType === "application/x-shockwave-flash";
}

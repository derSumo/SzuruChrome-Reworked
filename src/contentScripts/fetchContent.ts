// ── Media fetching from the page context ──────────────────────────────
// Running inside the page means the request carries its cookies and a
// same-site Referer, which is what gets past CDN hotlink protection. Three
// strategies are tried in order of least to most privileged.
//
// The result is base64-encoded because extension message passing (especially
// Chrome MV3 / webextension-polyfill) JSON-serialises payloads, which destroys
// ArrayBuffer instances.

import { BrowserCommand } from "~/models";
import { arrayBufferToBase64 } from "~/shared/binary";
import { guessMimeTypeFromUrl } from "~/shared/media";

/** Progress is reported over 0–0.8; the rest belongs to the szurubooru upload. */
const DOWNLOAD_PROGRESS_SHARE = 0.8;
const PROGRESS_REPORT_STEP = 0.02;

function isHtmlResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/html");
}

function sendDownloadProgress(importId: string, progress: number, speedBytesPerSecond?: number, totalBytes?: number) {
  void browser.runtime
    .sendMessage(new BrowserCommand("report_progress", { importId, progress, speedBytesPerSecond, totalBytes }))
    .catch(() => { });
}

/** Throttled progress reporter that also derives a transfer rate. */
function createProgressReporter(importId: string | undefined, total: number) {
  if (!importId || total <= 0) return undefined;

  let lastReported = -1;
  let lastSampleBytes = 0;
  let lastSampleAt = Date.now();

  return (received: number) => {
    const pct = Math.min(received / total, 1) * DOWNLOAD_PROGRESS_SHARE;
    if (pct - lastReported < PROGRESS_REPORT_STEP) return;
    const now = Date.now();
    const speed = ((received - lastSampleBytes) / Math.max(now - lastSampleAt, 1)) * 1000;
    lastReported = pct;
    lastSampleBytes = received;
    lastSampleAt = now;
    sendDownloadProgress(importId, pct, speed, total);
  };
}

/**
 * XHR with credentials. In Firefox content scripts with host_permissions this
 * bypasses CORS entirely, which `fetch()` does not — it still can't read a
 * cross-origin response without server-side CORS headers.
 */
function xhrFetchBinary(url: string, importId?: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.withCredentials = true;

    if (importId) {
      let report: ((received: number) => void) | undefined;
      xhr.onprogress = (e) => {
        if (!e.lengthComputable) return;
        report ??= createProgressReporter(importId, e.total);
        report?.(e.loaded);
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({
          buffer: xhr.response as ArrayBuffer,
          contentType: xhr.getResponseHeader("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream",
        });
      } else {
        reject(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("XHR network error"));
    xhr.ontimeout = () => reject(new Error("XHR timeout"));
    xhr.send();
  });
}

/**
 * Stream a response body while reporting download progress. Falls back to
 * `arrayBuffer()` when Content-Length is unavailable (no progress to report).
 */
async function streamResponse(res: Response, importId?: string): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const rawMime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
  const contentLength = parseInt(res.headers.get("content-length") ?? "0");
  const report = res.body ? createProgressReporter(importId, contentLength) : undefined;

  if (!report || !res.body) {
    return { buffer: await res.arrayBuffer(), mimeType: rawMime };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.length;
    report(received);
  }

  const buffer = new ArrayBuffer(received);
  const view = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.length;
  }
  return { buffer, mimeType: rawMime };
}

export async function fetchContent(url: string, importId?: string): Promise<{ base64: string; mimeType: string }> {
  let fetched: { buffer: ArrayBuffer; mimeType: string } | undefined;

  // Attempt 1: plain fetch with a full-URL Referer, no credentials.
  // "unsafe-url" sends the complete page URL as Referer for cross-origin
  // requests, satisfying CDN hotlink checks that verify the full path.
  // Reject HTML responses — some CDNs answer 200 OK + HTML error page when the
  // Referer is wrong, which must not be mistaken for the actual media.
  try {
    const res = await fetch(url, { referrerPolicy: "unsafe-url" });
    if (res.ok && !isHtmlResponse(res)) fetched = await streamResponse(res, importId);
  } catch { /* fall through */ }

  // Attempt 2: same, plus credentials. Some CDNs (in Brave/Chrome) require
  // session cookies AND the correct Referer, so the request can be verified as
  // coming from an authenticated session.
  if (!fetched) {
    try {
      const res = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
      if (res.ok && !isHtmlResponse(res)) fetched = await streamResponse(res, importId);
    } catch { /* fall through */ }
  }

  // Attempt 3: XHR with credentials, for CDNs that send no CORS headers at all.
  if (!fetched) {
    const xhrResult = await xhrFetchBinary(url, importId);
    if (xhrResult.contentType.includes("text/html")) throw new Error("CDN returned an HTML error page");
    fetched = { buffer: xhrResult.buffer, mimeType: xhrResult.contentType };
  }

  if (fetched.buffer.byteLength === 0) throw new Error("Empty response body");

  return {
    base64: arrayBufferToBase64(fetched.buffer),
    mimeType: guessMimeTypeFromUrl(url, fetched.mimeType),
  };
}

/** HEAD the media URL so the popup can show size/type before importing. */
export async function fetchHeadInfo(url: string): Promise<{ contentType?: string; contentLength?: string; finalUrl?: string }> {
  let res: Response | undefined;
  try {
    res = await fetch(url, { method: "HEAD" });
    if (!res.ok || isHtmlResponse(res)) res = undefined;
  } catch { res = undefined; }

  if (!res) {
    res = await fetch(url, { method: "HEAD", credentials: "include", referrerPolicy: "unsafe-url" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  return {
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength: res.headers.get("content-length") ?? undefined,
    finalUrl: res.url !== url ? res.url : undefined,
  };
}

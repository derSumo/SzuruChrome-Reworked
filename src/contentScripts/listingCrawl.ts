// ── "All pages" crawl for the batch importer ──────────────────────────
// Walks a listing's pagination and collects every post URL it links to, so a
// whole search — "everything from user X", an artist tag, a pool page — can be
// selected without paging through it by hand.
//
// The pages are fetched from the *content script*, not the background: same
// origin means the user's session cookies and a correct Referer come along for
// free, which is what makes login-gated or rating-filtered listings return the
// same results the user sees. Parsing happens in an inert DOMParser document,
// so no thumbnail is ever downloaded — this only costs the HTML.

import { extractPostUrls, nextPageCandidates, pickNextPageUrl } from "~/shared/listing";
import { sleep } from "~/shared/async";

/** Politeness gap between page fetches; a crawl must not look like a flood. */
const PAGE_DELAY_MS = 400;
const PAGE_FETCH_TIMEOUT_MS = 20_000;

export interface CrawlLimits {
  maxPages: number;
  maxPosts: number;
}

export type CrawlStopReason = "end" | "maxPages" | "maxPosts" | "aborted" | "error";

export interface CrawlResult {
  urls: string[];
  pages: number;
  stoppedBy: CrawlStopReason;
  error?: string;
}

export interface CrawlProgress {
  page: number;
  found: number;
}

/** The fetch is bounded by both the page timeout and the caller's stop button. */
function fetchSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
  if (!external) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, external]) : timeout;
}

async function fetchDocument(url: string, signal?: AbortSignal): Promise<Document> {
  const response = await fetch(url, {
    credentials: "same-origin",
    redirect: "follow",
    signal: fetchSignal(signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new DOMParser().parseFromString(await response.text(), "text/html");
}

/**
 * Collect post URLs from `startUrl` and every following page.
 *
 * The live document is reused for the page the user is already on, so the crawl
 * starts from exactly what they can see (including anything a script rendered
 * after load). `signal` aborts between pages as well as mid-fetch.
 */
export async function crawlListing(
  startUrl: string,
  limits: CrawlLimits,
  onProgress: (progress: CrawlProgress) => void,
  signal?: AbortSignal,
): Promise<CrawlResult> {
  const seenPosts = new Set<string>();
  const urls: string[] = [];
  // Pagination that loops back on itself would otherwise crawl forever.
  const visited = new Set<string>();

  let nextUrl: string | undefined = startUrl;
  let pages = 0;
  let stoppedBy: CrawlStopReason = "end";
  let error: string | undefined;

  try {
    while (nextUrl) {
      if (signal?.aborted) { stoppedBy = "aborted"; break; }
      if (pages >= limits.maxPages) { stoppedBy = "maxPages"; break; }
      if (visited.has(nextUrl)) break;
      visited.add(nextUrl);

      const isLivePage = pages === 0 && nextUrl.split("#")[0] === window.location.href.split("#")[0];
      if (pages > 0) await sleep(PAGE_DELAY_MS);
      const doc: Document = isLivePage ? document : await fetchDocument(nextUrl, signal);
      pages++;

      for (const url of extractPostUrls(doc, nextUrl)) {
        if (seenPosts.has(url)) continue;
        seenPosts.add(url);
        urls.push(url);
      }
      onProgress({ page: pages, found: urls.length });

      if (urls.length >= limits.maxPosts) {
        urls.length = limits.maxPosts;
        stoppedBy = "maxPosts";
        break;
      }

      nextUrl = pickNextPageUrl(nextUrl, nextPageCandidates(doc));
    }
  } catch (ex: any) {
    // Whatever was gathered before the failure is still worth importing, so the
    // partial result is returned rather than thrown away.
    if (signal?.aborted || ex?.name === "AbortError") {
      stoppedBy = "aborted";
    } else {
      stoppedBy = "error";
      error = ex?.name === "TimeoutError" ? "timeout" : (ex?.message ?? String(ex));
    }
  }

  return { urls, pages, stoppedBy, error };
}

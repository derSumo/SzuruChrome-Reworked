// ── Page scraping ─────────────────────────────────────────────────────
// neo-scraper reads `document.location` inside its engines, so scraping only
// ever works against a live document — which is why every import path has to
// route through a real tab rather than a DOMParser document.

import { NeoScraper, type ScrapeResults } from "neo-scraper";
import { sleep } from "~/shared/async";
import { getFirstScrapeHit, getFirstScrapedPost } from "~/shared/scrape";

/** How long to keep re-scraping while the DOM catches up with the URL. */
const SCRAPE_SETTLE_TIMEOUT_MS = 2500;
const SCRAPE_RETRY_INTERVAL_MS = 120;

/**
 * Gelbooru occasionally serves markup for which neo-scraper misses the
 * "Original image" anchor.  Sending the post page itself to szurubooru then
 * makes its server-side downloader fail with a misleading HTTP 500.  Repair
 * just that malformed result from the live document, keeping neo-scraper's
 * normal result untouched whenever it already found the media URL.
 */
export function repairGelbooruContentUrl(results: ScrapeResults, doc: Document = document): ScrapeResults {
  const hit = getFirstScrapeHit(results);
  if (hit?.engine !== "gelbooru") return results;

  const post = hit.post;

  const contentUrlIsPageUrl = !!post.contentUrl && !!post.pageUrl && post.contentUrl === post.pageUrl;
  if (post.contentUrl && !contentUrlIsPageUrl) return results;

  const links = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const originalMediaLink = links.find((link) => /^original (?:image|video)$/i.test(link.textContent?.trim() ?? ""))
    // Browser translation changes the visible English label that neo-scraper
    // relies on.  Gelbooru-family pages still expose the original file at the
    // stable /images/ URL, so recover it structurally instead of from text.
    ?? links.find((link) => {
      try {
        const url = new URL(link.href);
        return url.pathname.includes("/images/")
          && /\.(?:avif|gif|jpe?g|png|webm|mp4|swf)$/i.test(url.pathname);
      } catch {
        return false;
      }
    });
  const openGraphImage = doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  const recoveredUrl = originalMediaLink?.href ?? openGraphImage;

  if (recoveredUrl?.startsWith("http://") || recoveredUrl?.startsWith("https://")) {
    console.warn("Gelbooru scraper did not return a media URL; recovered it from the page markup.");
    post.contentUrl = recoveredUrl;
  }

  return results;
}

export function grabPost(): ScrapeResults {
  return repairGelbooruContentUrl(new NeoScraper().scrapeDocument(document, true));
}

/**
 * Scrape the page, retrying briefly until the DOM reflects `pressUrl`.
 *
 * When a booru navigates with arrow keys / "next" without a full reload, the
 * URL updates a tick before the new image swaps into the DOM. A single scrape
 * then sees the *previous* post, whose pageUrl no longer matches the current
 * URL. Instead of rejecting that press (which silently drops imports when the
 * user pages through quickly), we poll until the DOM catches up — keeping the
 * burst lossless.
 */
export async function scrapeForCurrentPage(pressUrl: string): Promise<ScrapeResults | undefined> {
  const deadline = Date.now() + SCRAPE_SETTLE_TIMEOUT_MS;
  let last: ScrapeResults | undefined;

  for (;;) {
    try {
      last = grabPost();
    } catch (ex) {
      console.warn("Hotkey scrape failed:", ex);
    }

    const post = getFirstScrapedPost(last);
    // Accept once we have a post whose pageUrl matches (or the scraper exposes
    // no pageUrl at all — nothing to compare against).
    if (post && (!post.pageUrl || post.pageUrl === pressUrl)) return last;

    // If the user has already navigated away from the page they pressed on,
    // stop chasing — this press was meant for pressUrl, which is gone.
    if (window.location.href !== pressUrl) return last;
    if (Date.now() >= deadline) return last;
    await sleep(SCRAPE_RETRY_INTERVAL_MS);
  }
}

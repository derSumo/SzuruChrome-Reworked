// ── Scrape result handling ────────────────────────────────────────────
// `grab_post` returns neo-scraper's ScrapeResults, which the popup and the
// background both have to interpret and turn into an uploadable post. The two
// paths used to carry parallel copies of that logic, so a setting honoured by
// one silently did nothing on the other. Both now go through here.

import type { ScrapeResults } from "neo-scraper";
import { applyTagRulesToTagList, type TagRulesConfig } from "~/tagRules";
import { hostMatchesAny } from "./host";

/** Name neo-scraper gives its "there is no real post here" result. */
export const FALLBACK_POST_NAME = "[fallback] Upload as URL";

/** Loosely typed neo-scraper post — engines differ in which fields they set. */
export interface RawScrapedPost {
  name?: string;
  tags?: Array<{ name?: string; category?: string }>;
  sources?: string[];
  notes?: unknown[];
  contentUrl?: string;
  extraContentUrl?: string;
  pageUrl?: string;
  contentType?: string;
  rating?: string;
  uploadMode?: string;
  referrer?: string;
  resolution?: [number, number];
}

/** Anything shaped like a ScrapeResults, including a message-passed clone. */
type ScrapeResultsLike = ScrapeResults | { results?: Array<{ engine?: string; posts?: unknown[] }> } | undefined;

/** First engine result that actually produced a post, with its engine name. */
export function getFirstScrapeHit(
  results: ScrapeResultsLike,
): { engine: string; post: RawScrapedPost } | undefined {
  const hit = (results as any)?.results?.find(
    (result: any) => Array.isArray(result?.posts) && result.posts.length > 0,
  );
  if (!hit) return undefined;
  return { engine: hit.engine ?? "unknown", post: hit.posts[0] as RawScrapedPost };
}

/** First scraped post of a scrape result, or undefined when nothing matched. */
export function getFirstScrapedPost(results: ScrapeResultsLike): RawScrapedPost | undefined {
  return getFirstScrapeHit(results)?.post;
}

/** True when a scrape found at least one post. */
export function scrapeHasPost(results: ScrapeResultsLike): boolean {
  return !!getFirstScrapeHit(results);
}

/** Page URL a scrape belongs to — the de-dupe key for queued imports. */
export function getScrapePageUrl(results: ScrapeResultsLike): string | undefined {
  return getFirstScrapedPost(results)?.pageUrl;
}

/** Display name shown in the popup's post picker. */
export function buildPostDisplayName(engine: string, name: string | undefined, index = 0): string {
  return `[${engine}] ${name ?? `Post ${index + 1}`}`;
}

/**
 * The subset of the config that affects a scraped post. Declared structurally
 * rather than as `StoredConfig` so both the reactive store value and a raw
 * (partially populated) stored config satisfy it.
 */
export interface ScrapedPostConfig {
  addAllParsedTags?: boolean;
  tagRules?: TagRulesConfig;
  alwaysUploadAsContent?: boolean;
  uploadAsContentSites?: string[];
  addPageUrlToSource?: boolean;
}

/**
 * Config-driven adjustments applied to every scraped post regardless of which
 * context imported it: tag stripping, blacklist/rename rules, forced content
 * upload, and appending the page URL to the source list.
 *
 * Mutates and returns `post` — callers own a fresh object either way.
 */
export function applyConfigToScrapedPost<
  T extends {
    name?: string;
    tags: Array<{ names: string[] }>;
    pageUrl?: string;
    source: string;
    uploadMode?: string;
  },
>(post: T, cfg: ScrapedPostConfig): T {
  if (!cfg.addAllParsedTags) post.tags = [];
  // Blacklist / rename rules run last, so they also catch tags the scraper
  // added implicitly and stay consistent across every import route.
  post.tags = applyTagRulesToTagList(post.tags, cfg.tagRules);

  const siteForcesContent = hostMatchesAny(post.pageUrl, cfg.uploadAsContentSites);
  if ((cfg.alwaysUploadAsContent || siteForcesContent) && post.name !== FALLBACK_POST_NAME) {
    post.uploadMode = "content";
  }

  if (cfg.addPageUrlToSource || post.source == "") {
    if (post.source != "") post.source += "\n";
    post.source += post.pageUrl ?? "";
  }

  return post;
}

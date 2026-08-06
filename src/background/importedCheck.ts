// ── "Already imported" lookup ─────────────────────────────────────────
// Answers "did I already grab this one?" for the content-script badge. The
// content script asks once per page; we answer from a short-lived cache so
// paging back and forth through a gallery doesn't hammer the instance.

import SzurubooruApi from "~/api";
import { getErrorMessage } from "~/utils";
import { postUrlFor } from "~/shared/host";
import { readStoredConfig, resolveSelectedSite } from "./settings";

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

export function cacheImportedCheck(pageUrl: string, result: ImportedCheckResult): void {
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
function escapeSzuruSearchValue(value: string): string {
  return value.replace(/([\\:*-])/g, "\\$1");
}

function normalizeSourceNeedle(pageUrl: string): string {
  return pageUrl
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * The `source:*needle*` query matches substrings, so a page whose URL ends in a
 * short id (e.g. rule34's "…&id=12") would also match a stored post sourced
 * from "…&id=123". Re-check the candidate's actual source against a word
 * boundary after the needle so "id=12" no longer matches "id=123", while a
 * legitimate trailing slash / query separator / newline still counts.
 */
export function sourceMatchesPage(source: string | null | undefined, needle: string): boolean {
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

/** Cached answer for `pageUrl`, or undefined when it is missing or stale. */
function readCache(pageUrl: string): ImportedCheckResult | undefined {
  const cached = importedCheckCache.get(pageUrl);
  if (!cached || Date.now() - cached.at >= IMPORTED_CHECK_TTL_MS) return undefined;
  return cached.result;
}

/**
 * One `source:` query per chunk of pages. szurubooru treats comma-separated
 * values as OR, so a screenful of thumbnails costs a single request instead of
 * one per post — without that, the listing badges would hammer the instance.
 *
 * Kept small enough that the query string stays well inside any proxy's URL
 * limit, and that one bad needle can only spoil its own chunk.
 */
const BULK_CHUNK_SIZE = 20;

/**
 * "Not found" answers from the bulk query, kept apart from the shared cache.
 *
 * A hit is proof (the candidate's own source is re-checked on a word boundary),
 * but a miss is only as good as the OR syntax the instance understood. Letting
 * such a miss into the shared cache would teach the *import* path that a post is
 * new when it isn't — the one error this feature must not make. So misses stay
 * here, where they only decide whether a thumbnail gets a check mark.
 */
const bulkMissCache = new Map<string, number>();

function rememberBulkMiss(pageUrl: string): void {
  bulkMissCache.set(pageUrl, Date.now());
  while (bulkMissCache.size > IMPORTED_CHECK_CACHE_MAX) {
    const oldest = bulkMissCache.keys().next().value;
    if (oldest === undefined) break;
    bulkMissCache.delete(oldest);
  }
}

function hasFreshBulkMiss(pageUrl: string): boolean {
  const at = bulkMissCache.get(pageUrl);
  return at !== undefined && Date.now() - at < IMPORTED_CHECK_TTL_MS;
}

export async function checkImportedBulk(
  data: { pageUrls?: string[]; force?: boolean },
): Promise<Record<string, ImportedCheckResult>> {
  const pageUrls = [...new Set((data?.pageUrls ?? []).filter((u) => typeof u === "string" && u))];
  const results: Record<string, ImportedCheckResult> = {};
  if (pageUrls.length === 0) return results;

  const pending: string[] = [];
  for (const pageUrl of pageUrls) {
    const cached = data.force ? undefined : readCache(pageUrl);
    if (cached) results[pageUrl] = cached;
    else if (!data.force && hasFreshBulkMiss(pageUrl)) results[pageUrl] = { imported: false };
    else pending.push(pageUrl);
  }
  if (pending.length === 0) return results;

  const cfg = await readStoredConfig();
  if (!cfg || cfg.importedBadge?.enabled === false || !cfg.sites?.length) {
    for (const pageUrl of pending) results[pageUrl] = { imported: false, unavailable: true };
    return results;
  }

  // All thumbnails on a listing belong to the same site, so one instance
  // resolution for the whole batch is correct and saves the repeated lookup.
  const site = resolveSelectedSite(cfg, pending[0]);
  const szuru = SzurubooruApi.createFromConfig(site);

  for (let i = 0; i < pending.length; i += BULK_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + BULK_CHUNK_SIZE);
    const needles = chunk.map((pageUrl) => ({ pageUrl, needle: normalizeSourceNeedle(pageUrl) }));
    const query = `source:${needles.map((n) => `*${escapeSzuruSearchValue(n.needle)}*`).join(",")}`;

    try {
      // A post can match several needles, and each needle may bring along
      // prefix collisions, so ask for more rows than there are pages.
      const posts = await szuru.getPosts(query, 0, chunk.length * 3, ["id", "source"]);
      for (const { pageUrl, needle } of needles) {
        const post = posts.results?.find((p) => sourceMatchesPage(p.source, needle));
        if (post) {
          const result: ImportedCheckResult = {
            imported: true,
            postId: post.id,
            postUrl: postUrlFor(site.domain, post.id),
          };
          cacheImportedCheck(pageUrl, result);
          results[pageUrl] = result;
        } else {
          rememberBulkMiss(pageUrl);
          results[pageUrl] = { imported: false };
        }
      }
    } catch (ex) {
      // Never downgrade a failed lookup to "not imported" — see checkImported.
      console.warn("Bulk imported check failed:", getErrorMessage(ex));
      for (const { pageUrl } of needles) results[pageUrl] = { imported: false, unavailable: true };
    }
  }

  return results;
}

export async function checkImported(data: { pageUrl?: string; force?: boolean }): Promise<ImportedCheckResult> {
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
  const szuru = SzurubooruApi.createFromConfig(site);
  const needle = normalizeSourceNeedle(pageUrl);

  try {
    // Fetch a few candidates + their source: the substring query can return a
    // post that merely shares a URL prefix, so we confirm on a word boundary.
    const posts = await szuru.getPosts(`source:*${escapeSzuruSearchValue(needle)}*`, 0, 5, ["id", "source"]);
    const post = posts.results?.find((p) => sourceMatchesPage(p.source, needle));
    const result: ImportedCheckResult = post
      ? { imported: true, postId: post.id, postUrl: postUrlFor(site.domain, post.id) }
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

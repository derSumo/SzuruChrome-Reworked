import { describe, expect, it } from "vitest";
import {
  applyConfigToScrapedPost,
  buildPostDisplayName,
  FALLBACK_POST_NAME,
  getFirstScrapeHit,
  getScrapePageUrl,
  scrapeHasPost,
} from "~/shared/scrape";
import { repairGelbooruContentUrl } from "~/contentScripts/scraper";

const results = (engines: Array<{ engine: string; posts: unknown[] }>) => ({ results: engines });

describe("getFirstScrapeHit", () => {
  it("skips engines that produced no posts", () => {
    const hit = getFirstScrapeHit(results([
      { engine: "empty", posts: [] },
      { engine: "gelbooru", posts: [{ pageUrl: "https://gelbooru.com/index.php?id=1" }] },
    ]));
    expect(hit?.engine).toBe("gelbooru");
    expect(hit?.post.pageUrl).toBe("https://gelbooru.com/index.php?id=1");
  });

  it("is undefined when nothing matched", () => {
    expect(getFirstScrapeHit(results([{ engine: "empty", posts: [] }]))).toBeUndefined();
    expect(getFirstScrapeHit(undefined)).toBeUndefined();
    expect(scrapeHasPost(undefined)).toBe(false);
  });

  it("exposes the page URL used as the queue de-dupe key", () => {
    expect(getScrapePageUrl(results([{ engine: "e", posts: [{ pageUrl: "https://x/1" }] }]))).toBe("https://x/1");
    expect(getScrapePageUrl(undefined)).toBeUndefined();
  });
});

describe("buildPostDisplayName", () => {
  it("prefixes the engine and falls back to a 1-based index", () => {
    expect(buildPostDisplayName("gelbooru", "Post 5")).toBe("[gelbooru] Post 5");
    expect(buildPostDisplayName("gelbooru", undefined, 2)).toBe("[gelbooru] Post 3");
  });
});

describe("repairGelbooruContentUrl", () => {
  it("recovers Gelbooru's original media URL when the scraper returned the post page", () => {
    // Simulates Chrome's page translation: neo-scraper's exact English text
    // match misses this link, but the stable /images/ path still identifies it.
    document.body.innerHTML = '<a href="https://img4.gelbooru.com/images/a/b/image.jpg">Originalbild</a>';
    const pageUrl = "https://gelbooru.com/index.php?page=post&s=view&id=14567103";
    const gelbooruDocument = {
      location: new URL(pageUrl),
      querySelectorAll: document.querySelectorAll.bind(document),
      querySelector: document.querySelector.bind(document),
    } as unknown as Document;
    const scrape: any = results([{
      engine: "gelbooru",
      posts: [{ pageUrl, contentUrl: pageUrl }],
    }]);

    repairGelbooruContentUrl(scrape, gelbooruDocument);

    expect(scrape.results[0].posts[0].contentUrl).toBe("https://img4.gelbooru.com/images/a/b/image.jpg");
  });
});

describe("applyConfigToScrapedPost", () => {
  const makePost = (over: Partial<any> = {}) => ({
    name: "[gelbooru] Post 1",
    tags: [{ names: ["absurdres"] }, { names: ["1girl"] }],
    pageUrl: "https://gelbooru.com/index.php?id=7",
    source: "",
    uploadMode: "url",
    ...over,
  });

  it("drops every tag when addAllParsedTags is off", () => {
    const post = applyConfigToScrapedPost(makePost(), { addAllParsedTags: false });
    expect(post.tags).toEqual([]);
  });

  it("applies blacklist rules from the tag rule engine", () => {
    const post = applyConfigToScrapedPost(makePost(), {
      addAllParsedTags: true,
      tagRules: { enabled: true, blacklist: ["absurdres"] },
    });
    expect(post.tags.map((t) => t.names[0])).toEqual(["1girl"]);
  });

  it("forces content upload for a whitelisted host", () => {
    const post = applyConfigToScrapedPost(makePost(), {
      addAllParsedTags: true,
      uploadAsContentSites: ["gelbooru.com"],
    });
    expect(post.uploadMode).toBe("content");
  });

  it("never forces content upload for the URL-mode fallback post", () => {
    const post = applyConfigToScrapedPost(makePost({ name: FALLBACK_POST_NAME }), {
      addAllParsedTags: true,
      alwaysUploadAsContent: true,
    });
    expect(post.uploadMode).toBe("url");
  });

  it("appends the page URL to an existing source on its own line", () => {
    const post = applyConfigToScrapedPost(makePost({ source: "https://artist.example/art" }), {
      addAllParsedTags: true,
      addPageUrlToSource: true,
    });
    expect(post.source).toBe("https://artist.example/art\nhttps://gelbooru.com/index.php?id=7");
  });

  it("still sets a source when the setting is off but nothing was scraped", () => {
    const post = applyConfigToScrapedPost(makePost(), { addAllParsedTags: true, addPageUrlToSource: false });
    expect(post.source).toBe("https://gelbooru.com/index.php?id=7");
  });

  it("leaves a scraped source alone when the setting is off", () => {
    const post = applyConfigToScrapedPost(makePost({ source: "https://artist.example/art" }), {
      addAllParsedTags: true,
      addPageUrlToSource: false,
    });
    expect(post.source).toBe("https://artist.example/art");
  });
});

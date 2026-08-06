import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  extractPostUrls,
  isPostDetailUrl,
  nextPageCandidates,
  normalizePostUrl,
  pickNextPageUrl,
  resolveMediaUrl,
} from "~/shared/listing";

function docOf(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("isPostDetailUrl", () => {
  const page = "https://rule34.xxx/index.php?page=post&s=list&tags=all";

  it("recognises the common booru post shapes", () => {
    expect(isPostDetailUrl("https://danbooru.donmai.us/posts/123", "https://danbooru.donmai.us/posts")).toBe(true);
    expect(isPostDetailUrl("https://yande.re/post/show/456", "https://yande.re/post")).toBe(true);
    expect(isPostDetailUrl("https://rule34.paheal.net/post/view/7", "https://rule34.paheal.net/post/list/x/1")).toBe(true);
    expect(isPostDetailUrl("index.php?page=post&s=view&id=99", page)).toBe(true);
  });

  it("rejects other hosts, so a crawl never leaves the site", () => {
    expect(isPostDetailUrl("https://example.com/posts/1", "https://danbooru.donmai.us/posts")).toBe(false);
  });

  it("rejects the page it was found on", () => {
    expect(isPostDetailUrl("https://danbooru.donmai.us/posts/5#c", "https://danbooru.donmai.us/posts/5")).toBe(false);
  });

  it("rejects listing and navigation links", () => {
    expect(isPostDetailUrl("index.php?page=post&s=list&tags=cat", page)).toBe(false);
    expect(isPostDetailUrl("https://danbooru.donmai.us/wiki_pages/abc", "https://danbooru.donmai.us/posts")).toBe(false);
  });
});

describe("normalizePostUrl", () => {
  it("resolves against the page it was found on, not the current document", () => {
    expect(normalizePostUrl("../posts/12", "https://danbooru.donmai.us/pool/posts?page=2"))
      .toBe("https://danbooru.donmai.us/posts/12");
  });

  it("drops the fragment so the same post can't be selected twice", () => {
    expect(normalizePostUrl("/posts/12#comments", "https://danbooru.donmai.us/posts"))
      .toBe("https://danbooru.donmai.us/posts/12");
  });
});

describe("extractPostUrls", () => {
  it("takes thumbnail links only, de-duplicated and in document order", () => {
    const doc = docOf(`
      <a href="/posts/2"><img src="a.jpg"></a>
      <a href="/posts/1"><img src="b.jpg"></a>
      <a href="/posts/2"><img src="a.jpg"></a>
      <a href="/posts/9">no thumbnail, likely a comment link</a>
      <a href="/wiki_pages/x"><img src="c.jpg"></a>
    `);
    expect(extractPostUrls(doc, "https://danbooru.donmai.us/posts")).toEqual([
      "https://danbooru.donmai.us/posts/2",
      "https://danbooru.donmai.us/posts/1",
    ]);
  });

  it("resolves relative hrefs against the fetched page, not the parser's document", () => {
    const doc = docOf(`<a href="index.php?page=post&s=view&id=5"><img src="t.jpg"></a>`);
    expect(extractPostUrls(doc, "https://rule34.xxx/index.php?page=post&s=list&pid=42"))
      .toEqual(["https://rule34.xxx/index.php?page=post&s=view&id=5"]);
  });
});

describe("pickNextPageUrl", () => {
  it("prefers an explicit rel=next", () => {
    const doc = docOf(`
      <a href="/posts?page=9">Last</a>
      <a rel="next" href="/posts?page=2">Next</a>
    `);
    expect(pickNextPageUrl("https://danbooru.donmai.us/posts", nextPageCandidates(doc)))
      .toBe("https://danbooru.donmai.us/posts?page=2");
  });

  it("falls back to a next-ish label", () => {
    const doc = docOf(`<a href="index.php?page=post&s=list&tags=cat&pid=42" alt="next">&gt;&gt;</a>`);
    expect(pickNextPageUrl("https://rule34.xxx/index.php?page=post&s=list&tags=cat", nextPageCandidates(doc)))
      .toBe("https://rule34.xxx/index.php?page=post&s=list&tags=cat&pid=42");
  });

  it("reads a bare numeric paginator and picks the nearest higher page", () => {
    const doc = docOf(`
      <a href="?page=post&s=list&tags=cat&pid=126">4</a>
      <a href="?page=post&s=list&tags=cat&pid=42">2</a>
      <a href="?page=post&s=list&tags=cat&pid=84">3</a>
    `);
    expect(pickNextPageUrl("https://rule34.xxx/index.php?page=post&s=list&tags=cat", nextPageCandidates(doc)))
      .toBe("https://rule34.xxx/index.php?page=post&s=list&tags=cat&pid=42");
  });

  it("follows a page number that lives in the path", () => {
    const doc = docOf(`<a href="/post/list/cat/3">3</a><a href="/post/list/cat/2">2</a>`);
    expect(pickNextPageUrl("https://rule34.paheal.net/post/list/cat/1", nextPageCandidates(doc)))
      .toBe("https://rule34.paheal.net/post/list/cat/2");
  });

  it("never walks backwards or sideways", () => {
    const doc = docOf(`
      <a href="/posts?page=1">1</a>
      <a href="/posts?page=2&tags=other">other search</a>
      <a href="/posts/77">a post</a>
    `);
    expect(pickNextPageUrl("https://danbooru.donmai.us/posts?page=2", nextPageCandidates(doc))).toBeUndefined();
  });

  it("ignores links to other origins", () => {
    const doc = docOf(`<a rel="next" href="https://evil.example.com/posts?page=2">Next</a>`);
    expect(pickNextPageUrl("https://danbooru.donmai.us/posts", nextPageCandidates(doc))).toBeUndefined();
  });

  it("returns nothing on the last page", () => {
    const doc = docOf(`<a href="/posts?page=1">1</a><span>2</span>`);
    expect(pickNextPageUrl("https://danbooru.donmai.us/posts?page=2", nextPageCandidates(doc))).toBeUndefined();
  });
});

describe("buildSearchUrl", () => {
  it("replaces the tags of the listing the user is on and resets pagination", () => {
    expect(buildSearchUrl("https://rule34.xxx/index.php?page=post&s=list&tags=cat&pid=84", "user:foo"))
      .toBe("https://rule34.xxx/index.php?page=post&s=list&tags=user%3Afoo");
  });

  it("adds tags to a bare listing path", () => {
    expect(buildSearchUrl("https://danbooru.donmai.us/posts", "user:foo"))
      .toBe("https://danbooru.donmai.us/posts?tags=user%3Afoo");
  });

  it("rewrites a Shimmie-style path search", () => {
    expect(buildSearchUrl("https://rule34.paheal.net/post/list/cat/3", "user:foo"))
      .toBe("https://rule34.paheal.net/post/list/user%3Afoo/1");
  });

  it("gives up on a page that is not a search, instead of guessing", () => {
    expect(buildSearchUrl("https://danbooru.donmai.us/wiki_pages/cat", "user:foo")).toBeUndefined();
    expect(buildSearchUrl("https://danbooru.donmai.us/posts", "   ")).toBeUndefined();
  });
});

describe("resolveMediaUrl", () => {
  const page = "https://gelbooru.com/index.php?page=post&s=view&id=42";

  it("prefers a video over the poster image it comes with", () => {
    const doc = docOf(`
      <meta property="og:image" content="/thumbs/poster.jpg">
      <video poster="/thumbs/poster.jpg"><source src="//img.gelbooru.com/clip.webm"></video>
    `);
    expect(resolveMediaUrl(doc, page)).toEqual({ url: "https://img.gelbooru.com/clip.webm", kind: "video" });
  });

  it("takes the file URL a Danbooru-style page states outright", () => {
    const doc = docOf(`<section id="image-container" data-file-url="/data/original.png"><img src="/data/sample.jpg"></section>`);
    expect(resolveMediaUrl(doc, "https://danbooru.donmai.us/posts/1"))
      .toEqual({ url: "https://danbooru.donmai.us/data/original.png", kind: "image" });
  });

  it("falls back to og:image, which nearly every booru publishes", () => {
    const doc = docOf(`<meta property="og:image" content="https://img3.gelbooru.com/images/a/b/full.jpeg">`);
    expect(resolveMediaUrl(doc, page)).toEqual({ url: "https://img3.gelbooru.com/images/a/b/full.jpeg", kind: "image" });
  });

  it("then the named image element, and finally the biggest picture", () => {
    expect(resolveMediaUrl(docOf(`<img id="image" src="/images/full.jpg">`), page))
      .toEqual({ url: "https://gelbooru.com/images/full.jpg", kind: "image" });

    const guess = docOf(`
      <img src="/icons/logo.png" width="32" height="32">
      <img src="/images/big.jpg" width="1200" height="1600">
    `);
    expect(resolveMediaUrl(guess, page)).toEqual({ url: "https://gelbooru.com/images/big.jpg", kind: "image" });
  });

  it("returns nothing rather than a site icon when there is no real media", () => {
    expect(resolveMediaUrl(docOf(`<img src="/icons/logo.png" width="32" height="32">`), page)).toBeUndefined();
  });

  it("ignores a javascript: or data: URL claiming to be the file", () => {
    const doc = docOf(`<section data-file-url="javascript:alert(1)"></section><meta property="og:image" content="/x.jpg">`);
    expect(resolveMediaUrl(doc, page)).toEqual({ url: "https://gelbooru.com/x.jpg", kind: "image" });
  });
});

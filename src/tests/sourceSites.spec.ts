import { describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({ default: {} }));

import {
  SOURCE_SITE_MATCH_PATTERNS,
  instancePermissionPattern,
  isSupportedSourceUrl,
  sourceSiteForUrl,
} from "~/shared/sourceSites";

describe("source-site access", () => {
  it("recognises supported hosts and their expected subdomains", () => {
    expect(isSupportedSourceUrl("https://danbooru.donmai.us/posts/1")).toBe(true);
    expect(isSupportedSourceUrl("https://www.pixiv.net/en/artworks/1")).toBe(true);
    expect(isSupportedSourceUrl("https://old.reddit.com/r/example/comments/1")).toBe(true);
    expect(isSupportedSourceUrl("https://bank.example.com/login")).toBe(false);
  });

  it("resolves a source entry for a booru page and its image CDN", () => {
    expect(sourceSiteForUrl("https://gelbooru.com/index.php?page=post&s=view&id=1")?.id).toBe("gelbooru");
    expect(sourceSiteForUrl("https://img4.gelbooru.com/images/a/b/image.jpg")?.id).toBe("gelbooru");
    expect(sourceSiteForUrl("https://github.com/openai/example")).toBeUndefined();
  });

  it("keeps the dynamic registration limited to HTTP(S) source patterns", () => {
    expect(SOURCE_SITE_MATCH_PATTERNS).toContain("https://*.donmai.us/*");
    expect(SOURCE_SITE_MATCH_PATTERNS).toContain("http://*.pixiv.net/*");
    expect(SOURCE_SITE_MATCH_PATTERNS.every((pattern) => /^https?:\/\/\*\./.test(pattern))).toBe(true);
  });

  it("turns only valid HTTP(S) instance URLs into requestable origins", () => {
    expect(instancePermissionPattern("https://szuru.example.test/path")).toBe("https://szuru.example.test/*");
    expect(instancePermissionPattern("http://localhost:8080/")).toBe("http://localhost:8080/*");
    expect(instancePermissionPattern("not a URL")).toBeUndefined();
    expect(instancePermissionPattern("file:///tmp/example")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  getUrl,
  hostMatchesAny,
  hostOf,
  normalizeHost,
  postUrlFor,
  registrableDomain,
  registrableDomainOfUrl,
} from "~/shared/host";

describe("hostOf", () => {
  it("lowercases and strips www", () => {
    expect(hostOf("https://WWW.Example.com/post/1")).toBe("example.com");
  });

  it("keeps the port, which distinguishes self-hosted instances", () => {
    expect(hostOf("http://localhost:8080/api")).toBe("localhost:8080");
  });

  it("returns undefined for non-URLs", () => {
    expect(hostOf("not a url")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});

describe("normalizeHost", () => {
  it("accepts a bare host as well as a full URL", () => {
    expect(normalizeHost("rule34.xxx")).toBe("rule34.xxx");
    expect(normalizeHost("https://rule34.xxx/index.php?page=post")).toBe("rule34.xxx");
  });

  it("falls back to the lowercased input rather than dropping a typo", () => {
    expect(normalizeHost("not a host")).toBe("not a host");
  });

  it("ignores surrounding whitespace and empty input", () => {
    expect(normalizeHost("  danbooru.donmai.us  ")).toBe("danbooru.donmai.us");
    expect(normalizeHost("   ")).toBeUndefined();
    expect(normalizeHost(undefined)).toBeUndefined();
  });
});

describe("hostMatchesAny", () => {
  it("matches an exact host", () => {
    expect(hostMatchesAny("https://rule34.xxx/index.php", ["rule34.xxx"])).toBe(true);
  });

  it("matches a subdomain of a configured host", () => {
    expect(hostMatchesAny("https://api.rule34.xxx/x", ["rule34.xxx"])).toBe(true);
  });

  it("does not match a host that merely ends with the same text", () => {
    expect(hostMatchesAny("https://notrule34.xxx/x", ["rule34.xxx"])).toBe(false);
  });

  it("is false for an empty or missing list", () => {
    expect(hostMatchesAny("https://rule34.xxx", [])).toBe(false);
    expect(hostMatchesAny("https://rule34.xxx", undefined)).toBe(false);
    expect(hostMatchesAny(undefined, ["rule34.xxx"])).toBe(false);
  });
});

describe("registrableDomain", () => {
  it("collapses a subdomain to its parent domain", () => {
    expect(registrableDomain("img3.gelbooru.com")).toBe("gelbooru.com");
  });

  it("keeps three labels for a second-level public suffix", () => {
    expect(registrableDomain("cdn.example.co.uk")).toBe("example.co.uk");
  });

  it("leaves a bare domain untouched", () => {
    expect(registrableDomain("rule34.xxx")).toBe("rule34.xxx");
  });

  it("returns undefined for an unparsable URL", () => {
    expect(registrableDomainOfUrl("nope")).toBeUndefined();
    expect(registrableDomainOfUrl("https://img3.gelbooru.com/a.jpg")).toBe("gelbooru.com");
  });
});

describe("URL building", () => {
  it("collapses stray slashes between segments", () => {
    expect(getUrl("https://booru.example.com/", "post", "42")).toBe("https://booru.example.com/post/42");
  });

  it("builds a post URL from an instance domain with a trailing slash", () => {
    expect(postUrlFor("https://booru.example.com///", 42)).toBe("https://booru.example.com/post/42");
  });
});

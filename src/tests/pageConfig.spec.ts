/**
 * @vitest-environment-options { "url": "https://gelbooru.com/index.php?page=post&s=list&tags=artist" }
 */
// The hover zoom shipped gated on a host whitelist that started out empty, so
// the toggle in Options did nothing at all until a host was typed in by hand.
// These pin down when the zoom is considered active for a page.

import { beforeEach, describe, expect, it, vi } from "vitest";
// `vi.mock` is hoisted above the imports, so the module under test picks the
// stub up even though this reads like a plain static import.
import { getListingSettings } from "~/contentScripts/pageConfig";

// Hoisted alongside the mock: the module under test reads the config at import
// time, which happens before any `const` in this file is initialised.
const stored = vi.hoisted(() => ({}) as any);

vi.mock("~/shared/config", () => ({
  readStoredConfig: async () => stored,
  onConfigChanged: () => {},
}));

describe("getListingSettings", () => {
  beforeEach(() => {
    stored.listing = { hoverZoom: true, hoverZoomScope: "sites", hoverZoomSites: [] };
  });

  it("treats an empty host list as 'wherever the extension runs'", async () => {
    expect((await getListingSettings()).hoverZoom).toBe(true);
  });

  it("still restricts to a curated list", async () => {
    stored.listing.hoverZoomSites = ["danbooru.donmai.us"];
    expect((await getListingSettings()).hoverZoom).toBe(false);

    stored.listing.hoverZoomSites = ["gelbooru.com"];
    expect((await getListingSettings()).hoverZoom).toBe(true);
  });

  it("stays off when the feature itself is off", async () => {
    stored.listing.hoverZoom = false;
    stored.listing.hoverZoomScope = "all";
    expect((await getListingSettings()).hoverZoom).toBe(false);
  });

  it("keeps a zero delay instead of falling back to the default", async () => {
    stored.listing.hoverZoomDelayMs = 0;
    expect((await getListingSettings()).hoverZoomDelayMs).toBe(0);
  });

  it("falls back for a delay that is missing or nonsense", async () => {
    stored.listing.hoverZoomDelayMs = "nope";
    expect((await getListingSettings()).hoverZoomDelayMs).toBe(350);
  });
});

/**
 * @vitest-environment-options { "url": "https://gelbooru.com/index.php?page=post&s=list&tags=artist" }
 */
// Drives the hover-zoom preview the way a listing page does: real DOM, real
// listeners, only the config and the post-page fetch stubbed out.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listing = { hoverActions: true, hoverZoom: true, hoverZoomDelayMs: 5, endlessScroll: false };

vi.mock("~/contentScripts/pageConfig", () => ({
  getListingSettings: async () => listing,
  onConfigReloaded: () => {},
}));
vi.mock("~/contentScripts/navigation", () => ({ onNavigation: () => {} }));

const POST_HTML = `<meta property="og:image" content="https://img3.gelbooru.com/images/a/b/full.jpeg">`;

function thumbnail(): HTMLImageElement {
  document.body.innerHTML = `
    <a id="thumb" href="https://gelbooru.com/index.php?page=post&s=view&id=42">
      <img src="https://gelbooru.com/thumbs/small.jpg">
    </a>`;
  return document.querySelector("#thumb img")!;
}

function hover(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 100, clientY: 100, ...init }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function install(): Promise<void> {
  const { installHoverZoom } = await import("~/contentScripts/extras/hoverZoom");
  installHoverZoom();
  await settle();
}

describe("hover zoom", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(POST_HTML, { status: 200 })));
  });

  it("opens a preview for a ctrl-hovered thumbnail", async () => {
    await install();

    hover(thumbnail(), { ctrlKey: true });
    await settle();

    const panel = document.getElementById("szuru-hover-zoom");
    expect(panel, "no preview panel was created").not.toBeNull();
    expect(panel!.querySelector("img")?.getAttribute("src"))
      .toBe("https://img3.gelbooru.com/images/a/b/full.jpeg");
  });

  it("opens when ctrl is pressed after the pointer already reached the thumbnail", async () => {
    await install();

    hover(thumbnail());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
    await settle();

    expect(document.getElementById("szuru-hover-zoom"), "ctrl-after-hover opened nothing").not.toBeNull();
  });

  it("survives the thumbnail action bar appearing under the cursor", async () => {
    await install();

    const img = thumbnail();
    hover(img);

    // ../thumbActions appends its buttons into the anchor on plain hover, which
    // moves the pointer onto a brand new element.
    const anchor = document.querySelector("#thumb")!;
    const bar = document.createElement("div");
    anchor.appendChild(bar);
    img.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: bar }));
    hover(bar);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
    await settle();

    expect(document.getElementById("szuru-hover-zoom"), "action bar killed the preview").not.toBeNull();
  });
});

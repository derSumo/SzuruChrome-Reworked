// ── Enlarged preview of the thumbnail under the cursor ────────────────
// Opt-in, and loaded on demand (see ./index): a preview nobody switched on
// should not cost a single byte on every page the user opens.
//
// The full-size file is read from the post page's own markup — a listing
// thumbnail is 150px wide, so upscaling it would be a blurry lie. That costs
// one same-origin request per post, cached per URL (failures included, or a
// site that publishes nothing usable would be re-asked on every hover).
//
// The panel is `pointer-events:none` throughout. It must never swallow a hover:
// the import buttons live on the thumbnail itself (see ../thumbActions), and
// anything placed inside a non-interactive panel would inherit that and stop
// being clickable.

import { normalizePostUrl, resolveMediaUrl, type ResolvedMedia } from "~/shared/listing";
import { getListingSettings, onConfigReloaded } from "../pageConfig";
import { onNavigation } from "../navigation";

const PREVIEW_ID = "szuru-hover-zoom";
const STYLE_ID = "szuru-hover-zoom-style";
const MEDIA_FETCH_TIMEOUT_MS = 12_000;
const CURSOR_GAP_PX = 18;

const STYLES = `
  #${PREVIEW_ID}{
    position:fixed;z-index:2147482000;padding:5px;border-radius:14px;
    background:rgba(18,18,22,.92);border:.5px solid rgba(255,255,255,.16);
    -webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);
    box-shadow:0 18px 50px rgba(0,0,0,.55);
    animation:szz-in .18s cubic-bezier(.16,1,.3,1) both;pointer-events:none;
    transition:left .1s ease-out,top .1s ease-out;will-change:left,top,transform,opacity;}
  #${PREVIEW_ID} img,#${PREVIEW_ID} video{
    display:block;max-width:100%;max-height:100%;border-radius:11px;background:rgba(0,0,0,.3)}
  #${PREVIEW_ID}.loading{min-width:120px;min-height:80px}
  #${PREVIEW_ID}.loading::after{
    content:"";position:absolute;top:50%;left:50%;width:18px;height:18px;margin:-9px 0 0 -9px;
    border-radius:50%;border:2px solid rgba(255,255,255,.28);border-top-color:rgba(255,255,255,.95);
    animation:szz-spin .7s linear infinite}
  @keyframes szz-in{from{opacity:0;transform:translateY(5px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
  @keyframes szz-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){
    #${PREVIEW_ID}{animation:none;transition:none}
    #${PREVIEW_ID}.loading::after{animation:none}
  }
`;

let previewEl: HTMLElement | undefined;
let hoveredUrl: string | undefined;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let enabled = false;
let delayMs = 350;
let lastHoveredTarget: EventTarget | null = null;
let pointerX = 0;
let pointerY = 0;
let positionFrame: number | undefined;

/** Media URL per post page, so re-hovering the same thumbnail is free. */
const mediaCache = new Map<string, ResolvedMedia | null>();

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

function close(): void {
  if (openTimer) { clearTimeout(openTimer); openTimer = undefined; }
  if (positionFrame) { cancelAnimationFrame(positionFrame); positionFrame = undefined; }
  previewEl?.remove();
  previewEl = undefined;
  hoveredUrl = undefined;
}

/** Read the post page and remember where its full-size file lives. */
async function resolveMedia(postUrl: string): Promise<ResolvedMedia | undefined> {
  const cached = mediaCache.get(postUrl);
  if (cached !== undefined) return cached ?? undefined;

  try {
    const response = await fetch(postUrl, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const media = resolveMediaUrl(doc, postUrl);
    mediaCache.set(postUrl, media ?? null);
    return media;
  } catch {
    // Remember the failure too — retrying on every hover would hammer the site.
    mediaCache.set(postUrl, null);
    return undefined;
  }
}

/**
 * Keep the smaller preview close to the cursor without letting it leave the
 * viewport. It remains non-interactive, so thumbnail actions stay reachable.
 */
function position(panel: HTMLElement): void {
  const maxW = Math.min(window.innerWidth * 0.38, 520);
  const maxH = Math.min(window.innerHeight * 0.7, 560);
  panel.style.maxWidth = `${Math.round(maxW)}px`;
  panel.style.maxHeight = `${Math.round(maxH)}px`;

  const rect = panel.getBoundingClientRect();
  const right = window.innerWidth - rect.width - 8;
  const bottom = window.innerHeight - rect.height - 8;
  const left = pointerX + CURSOR_GAP_PX <= right
    ? pointerX + CURSOR_GAP_PX
    : pointerX - rect.width - CURSOR_GAP_PX;
  const top = pointerY + CURSOR_GAP_PX <= bottom
    ? pointerY + CURSOR_GAP_PX
    : pointerY - rect.height - CURSOR_GAP_PX;
  panel.style.left = `${Math.round(Math.max(8, Math.min(left, right)))}px`;
  panel.style.top = `${Math.round(Math.max(8, Math.min(top, bottom)))}px`;
}

function schedulePosition(): void {
  if (positionFrame || !previewEl) return;
  positionFrame = requestAnimationFrame(() => {
    positionFrame = undefined;
    if (previewEl) position(previewEl);
  });
}

async function open(url: string): Promise<void> {
  ensureStyles();
  previewEl?.remove();

  const panel = document.createElement("div");
  panel.id = PREVIEW_ID;
  panel.className = "loading";
  document.documentElement.appendChild(panel);
  previewEl = panel;
  position(panel);

  const media = await resolveMedia(url);
  // The cursor may have moved on while the post page was being read.
  if (previewEl !== panel || hoveredUrl !== url) return;
  if (!media) { close(); return; }

  const el = media.kind === "video"
    ? Object.assign(document.createElement("video"), { src: media.url, autoplay: true, loop: true, muted: true })
    : Object.assign(document.createElement("img"), { src: media.url });
  el.addEventListener("load", () => { panel.classList.remove("loading"); position(panel); });
  el.addEventListener("loadeddata", () => { panel.classList.remove("loading"); position(panel); });
  el.addEventListener("error", close);
  panel.appendChild(el);
}

function previewForTarget(target: EventTarget | null): void {
  const anchor = (target as HTMLElement)?.closest?.("a") as HTMLAnchorElement | null;
  if (!anchor || !anchor.querySelector("img")) return;
  const url = normalizePostUrl(anchor.href, window.location.href);
  if (!url || url === hoveredUrl) return;

  close();
  hoveredUrl = url;
  openTimer = setTimeout(() => {
    openTimer = undefined;
    if (hoveredUrl === url) void open(url);
  }, delayMs);
}

function onPointerOver(event: MouseEvent): void {
  lastHoveredTarget = event.target;
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (!enabled || !event.ctrlKey) return;
  previewForTarget(event.target);
}

/** Ctrl can be pressed after the pointer has already reached a thumbnail. */
function onKeyDown(event: KeyboardEvent): void {
  if (!enabled || event.key !== "Control" || event.repeat) return;
  previewForTarget(lastHoveredTarget);
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === "Control") close();
}

function onPointerMove(event: MouseEvent): void {
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (!previewEl) return;
  if (!event.ctrlKey) { close(); return; }
  schedulePosition();
}

function onPointerOut(event: MouseEvent): void {
  const to = event.relatedTarget as HTMLElement | null;
  // Moving within the same thumbnail — including onto its import buttons — is
  // not leaving it.
  const anchor = (event.target as HTMLElement)?.closest?.("a");
  if (anchor && to && anchor.contains(to)) return;
  close();
}

async function refresh(): Promise<void> {
  const listing = await getListingSettings();
  enabled = listing.hoverZoom;
  delayMs = listing.hoverZoomDelayMs;
  if (!enabled) close();
}

export function installHoverZoom(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("mouseover", onPointerOver, true);
  document.addEventListener("mouseout", onPointerOut, true);
  document.addEventListener("mousemove", onPointerMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  // A panel pinned next to a thumbnail that scrolled away would float over
  // nothing.
  window.addEventListener("scroll", () => { if (previewEl) close(); }, { passive: true, capture: true });
  onNavigation(() => { close(); void refresh(); });
  onConfigReloaded(() => void refresh());

  void refresh();
}

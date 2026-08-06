// ── Import buttons on a listing thumbnail ─────────────────────────────
// Hovering a thumbnail offers two things to do with that post without leaving
// the listing: import it, or import it and chain it to the previous import.
//
// The bar stays put once it appears. It used to vanish the moment the pointer
// left the thumbnail, which made it unreachable — you cannot move onto a button
// that disappears on the way there. So it is anchored *inside* the thumbnail's
// own link, sticks around until another thumbnail is hovered (or the user
// clicks elsewhere), and only dims while the pointer is away.
//
// It is deliberately not part of the zoom preview: that panel is
// `pointer-events:none` so it can never swallow a hover, and a button inside it
// would inherit exactly that and stop being clickable.

import { BrowserCommand } from "~/models";
import { t } from "~/i18n";
import { normalizePostUrl } from "~/shared/listing";
import { getListingSettings, onConfigReloaded } from "./pageConfig";
import { icon } from "./ui/icons";
import { onNavigation } from "./navigation";

const BAR_ID = "szuru-thumb-actions";
const STYLE_ID = "szuru-thumb-actions-style";

/** Enough of a pause that sweeping the mouse across a grid stays quiet. */
const SHOW_DELAY_MS = 120;

const STYLES = `
  #${BAR_ID}{
    position:absolute;top:6px;right:6px;z-index:2147483100;
    display:flex;gap:5px;padding:5px;border-radius:12px;
    background:rgba(20,20,24,.86);border:.5px solid rgba(255,255,255,.16);
    -webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
    box-shadow:0 6px 20px rgba(0,0,0,.42);
    pointer-events:auto;opacity:.62;
    transition:opacity .18s ease;
    animation:sza-in .16s cubic-bezier(.16,1,.3,1) both;}
  /* Full strength while the pointer is on the thumbnail or on the bar itself. */
  #${BAR_ID}.active,#${BAR_ID}:hover{opacity:1}
  #${BAR_ID} button{
    display:grid;place-items:center;width:30px;height:30px;padding:0;
    border:0;border-radius:9px;cursor:pointer;
    background:rgba(255,255,255,.1);color:rgba(255,255,255,.95);
    transition:background .15s ease,transform .12s ease}
  #${BAR_ID} button:hover{background:rgba(99,102,241,.85);transform:translateY(-1px)}
  #${BAR_ID} button:active{transform:scale(.9)}
  #${BAR_ID} button:disabled{opacity:.5;cursor:default;transform:none}
  #${BAR_ID} button.busy{background:rgba(255,159,10,.4)}
  #${BAR_ID} button.ok{background:rgba(52,199,89,.8)}
  #${BAR_ID} button.fail{background:rgba(255,105,97,.75)}
  @keyframes sza-in{from{opacity:0;transform:translateY(4px)}to{opacity:.62;transform:none}}
  @media (prefers-reduced-motion:reduce){#${BAR_ID}{animation:none}}
`;

let barEl: HTMLElement | undefined;
/** The thumbnail the current bar belongs to. */
let barAnchor: HTMLAnchorElement | undefined;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let installed = false;
let enabled = false;

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string
  ));
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

function removeBar(): void {
  barEl?.remove();
  barEl = undefined;
  barAnchor = undefined;
}

async function runImport(bar: HTMLElement, url: string, linkLast: boolean): Promise<void> {
  const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>("button"));
  const pressed = bar.querySelector<HTMLButtonElement>(linkLast ? ".sza-link" : ".sza-import");
  for (const b of buttons) b.disabled = true;
  pressed?.classList.remove("ok", "fail");
  pressed?.classList.add("busy");

  try {
    const result: { postId?: number; error?: string } | undefined = await browser.runtime.sendMessage(
      new BrowserCommand("import_post_url", { url, linkLast }),
    );
    // The regular import toast reports the detail; the button only has to say
    // whether the click landed.
    pressed?.classList.remove("busy");
    pressed?.classList.add(result?.error ? "fail" : "ok");
  } catch {
    pressed?.classList.remove("busy");
    pressed?.classList.add("fail");
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function showBar(anchor: HTMLAnchorElement, url: string): void {
  ensureStyles();
  removeBar();

  const bar = document.createElement("div");
  bar.id = BAR_ID;
  bar.classList.add("active");
  bar.innerHTML = `
    <button class="sza-import" type="button" title="${escapeAttr(t("batch.hoverImport") || "Import this post")}">${icon("upload", 16)}</button>
    <button class="sza-link" type="button" title="${escapeAttr(t("batch.hoverLink") || "Import and link to the previous one")}">${icon("link", 16)}</button>
  `;
  // The bar sits on top of the thumbnail's own link: a click here must not
  // navigate to the post. This must happen while bubbling: a capture handler
  // on the bar runs before its button target and would swallow the import
  // button's own click listener.
  for (const event of ["click", "mousedown", "mouseup"] as const) {
    bar.addEventListener(event, (e) => { e.preventDefault(); e.stopPropagation(); });
  }
  bar.querySelector(".sza-import")?.addEventListener("click", () => void runImport(bar, url, false));
  bar.querySelector(".sza-link")?.addEventListener("click", () => void runImport(bar, url, true));

  // `position:absolute` needs a positioned ancestor. The batch picker makes
  // thumbnails relative, but only while it is open.
  if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
  anchor.appendChild(bar);
  barEl = bar;
  barAnchor = anchor;
}

function postAnchorFrom(target: EventTarget | null): { anchor: HTMLAnchorElement; url: string } | undefined {
  const anchor = (target as HTMLElement)?.closest?.("a") as HTMLAnchorElement | null;
  if (!anchor || !anchor.querySelector("img")) return undefined;
  const url = normalizePostUrl(anchor.href, window.location.href);
  return url ? { anchor, url } : undefined;
}

function revealForTarget(target: EventTarget | null): void {
  const hit = postAnchorFrom(target);
  if (!hit) return;

  // Same thumbnail (or its own bar): just wake the bar back up.
  if (hit.anchor === barAnchor) {
    barEl?.classList.add("active");
    return;
  }

  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = undefined;
    showBar(hit.anchor, hit.url);
  }, SHOW_DELAY_MS);
}

function onPointerOver(event: MouseEvent): void {
  if (!enabled) return;
  revealForTarget(event.target);
}

function onPointerOut(event: MouseEvent): void {
  if (!barAnchor) return;
  const to = event.relatedTarget as HTMLElement | null;
  if (to && barAnchor.contains(to)) return;
  // Leaving only dims the bar. Removing it here is what made it impossible to
  // click: the pointer has to cross the gap to reach it.
  barEl?.classList.remove("active");
}

/** A click anywhere else means the user is done with this thumbnail. */
function onDocumentClick(event: MouseEvent): void {
  if (!barAnchor) return;
  const target = event.target as HTMLElement | null;
  if (target && barAnchor.contains(target)) return;
  removeBar();
}

async function refresh(): Promise<void> {
  const listing = await getListingSettings();
  enabled = listing.hoverActions;
  if (!enabled) removeBar();
}

export function installThumbActions(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("mouseover", onPointerOver, true);
  document.addEventListener("mouseout", onPointerOut, true);
  document.addEventListener("click", onDocumentClick, true);
  onNavigation(() => { removeBar(); void refresh(); });
  onConfigReloaded(() => void refresh());

  void refresh();
}

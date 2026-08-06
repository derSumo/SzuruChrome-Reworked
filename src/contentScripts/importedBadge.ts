// ── "Already imported" badge ──────────────────────────────────────────
// Answers "did I already grab this one?" without opening the popup. The
// background does the actual lookup (a source: search against the selected
// instance) and caches it, so paging through a gallery is cheap.

import { BrowserCommand } from "~/models";
import { t } from "~/i18n";
import { getFirstScrapedPost } from "~/shared/scrape";
import { grabPost } from "./scraper";
import { getBadgeSettings, onConfigReloaded } from "./pageConfig";
import { onNavigation } from "./navigation";

const BADGE_ID = "szuru-imported-badge";

const BADGE_STYLES = `
  #${BADGE_ID}{
    position:fixed;bottom:16px;right:16px;z-index:2147483646;
    display:flex;align-items:center;gap:7px;
    padding:7px 12px;border-radius:11px;
    font:600 12px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
    letter-spacing:-0.01em;color:rgba(255,255,255,.93);
    background:rgba(24,48,34,.86);border:.5px solid rgba(52,199,89,.3);
    -webkit-backdrop-filter:saturate(160%) blur(30px);backdrop-filter:saturate(160%) blur(30px);
    box-shadow:0 6px 22px rgba(0,0,0,.22),inset 0 .5px 0 rgba(255,255,255,.1);
    opacity:0;transform:translateY(8px) scale(.97);
    transition:opacity .26s cubic-bezier(.16,1,.3,1),transform .26s cubic-bezier(.16,1,.3,1);
  }
  #${BADGE_ID}.show{opacity:1;transform:translateY(0) scale(1)}
  #${BADGE_ID}.missing{background:rgba(32,32,38,.82);border-color:rgba(255,255,255,.14)}
  #${BADGE_ID} .szb-mark{display:grid;place-items:center;width:14px;height:14px;flex-shrink:0}
  #${BADGE_ID} a{color:rgba(171,255,196,.98);text-decoration:underline;text-underline-offset:2px}
  #${BADGE_ID} .szb-close{
    margin-left:2px;padding:0 2px;cursor:pointer;border:0;background:none;
    color:rgba(255,255,255,.45);font-size:13px;line-height:1;
  }
  #${BADGE_ID} .szb-close:hover{color:rgba(255,255,255,.85)}
`;

const IMPORTED_ICON = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5l3 3 5-5" stroke="rgba(52,199,89,.95)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const NOT_IMPORTED_ICON = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="rgba(255,255,255,.4)"/><path d="M6.5 4v3.4" stroke="rgba(255,255,255,.6)" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="9.3" r=".7" fill="rgba(255,255,255,.6)"/></svg>`;

interface BadgeResult {
  imported: boolean;
  postId?: number;
  postUrl?: string;
  unavailable?: boolean;
}

let badgeEl: HTMLElement | undefined;
let badgeCheckedUrl: string | undefined;
let badgeCheckInFlight = false;

function removeBadge(): void {
  badgeEl?.remove();
  badgeEl = undefined;
}

function getOrCreateBadge(): HTMLElement {
  if (badgeEl) return badgeEl;

  const el = document.createElement("div");
  el.id = BADGE_ID;

  const style = document.createElement("style");
  style.textContent = BADGE_STYLES;
  el.appendChild(style);

  document.documentElement.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  badgeEl = el;
  return el;
}

function renderBadge(result: BadgeResult): void {
  const el = getOrCreateBadge();
  el.classList.toggle("missing", !result.imported);

  // Keep the injected <style> and replace the content nodes.
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeName !== "STYLE") node.remove();
  }

  const mark = document.createElement("span");
  mark.className = "szb-mark";
  mark.innerHTML = result.imported ? IMPORTED_ICON : NOT_IMPORTED_ICON;

  const label = document.createElement("span");
  if (result.imported) {
    label.textContent = t("badge.imported") || "Already imported";
    if (result.postUrl) {
      const link = document.createElement("a");
      link.href = result.postUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `#${result.postId}`;
      label.append(" ", link);
    }
  } else {
    label.textContent = t("badge.notImported") || "Not imported yet";
  }

  const close = document.createElement("button");
  close.className = "szb-close";
  close.type = "button";
  close.title = t("badge.dismiss") || "Hide";
  close.textContent = "✕";
  close.addEventListener("click", removeBadge);

  el.append(mark, label, close);
}

export async function updateImportedBadge(force = false): Promise<void> {
  if (badgeCheckInFlight) return;

  // Cheapest check first: navigation polling almost always lands on an
  // unchanged URL.
  const currentUrl = window.location.href;
  if (!force && currentUrl === badgeCheckedUrl) return;

  const settings = await getBadgeSettings();
  if (!settings.enabled) {
    removeBadge();
    return;
  }
  badgeCheckedUrl = currentUrl;

  // Only booru-style pages get a badge: if the scraper finds nothing here,
  // there is nothing that could have been imported.
  let scrapedPageUrl: string | undefined;
  try {
    scrapedPageUrl = getFirstScrapedPost(grabPost())?.pageUrl;
  } catch { /* not a supported page */ }
  if (!scrapedPageUrl) {
    removeBadge();
    return;
  }

  badgeCheckInFlight = true;
  try {
    const result: BadgeResult = await browser.runtime.sendMessage(
      new BrowserCommand("check_imported", { pageUrl: scrapedPageUrl, force }),
    );

    // The user may have navigated on while the lookup was running.
    if (window.location.href !== currentUrl) return;

    // `unavailable` means the lookup itself failed (no instance, network
    // error). Showing "not imported" there would be a false negative.
    if (!result || result.unavailable) {
      removeBadge();
      return;
    }

    if (result.imported) renderBadge(result);
    else if (settings.showWhenNotImported) renderBadge({ imported: false });
    else removeBadge();
  } catch {
    removeBadge();
  } finally {
    badgeCheckInFlight = false;
  }
}

export function installImportedBadge(): void {
  onNavigation(() => void updateImportedBadge());
  onConfigReloaded(() => {
    badgeCheckedUrl = undefined;
    void updateImportedBadge();
  });
  void updateImportedBadge();
}

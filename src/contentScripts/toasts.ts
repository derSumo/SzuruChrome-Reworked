// ── Quick-import toast queue ──────────────────────────────────────────
// Renders one toast per in-flight import plus a collapsible "N uploaded"
// history panel. State is mirrored in the background, so a page navigation
// mid-burst restores whatever is still running (see restoreActiveImports).

import { BrowserCommand } from "~/models";
import { t } from "~/i18n";

const TC_ID = "szuru-tc";

/** Matches the background's success retention window. */
const HISTORY_LIFETIME_MS = 15_000;
const SUCCESS_TOAST_DISMISS_MS = 450;
const ERROR_TOAST_DISMISS_MS = 6000;

const TOAST_STYLES = `
  #${TC_ID} .st{
    pointer-events:auto;position:relative;overflow:hidden;
    padding:9px 13px;border-radius:13px;
    color:rgba(255,255,255,.93);
    font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
    letter-spacing:-0.01em;
    background:rgba(28,28,32,.78);
    border:0.5px solid rgba(255,255,255,.14);
    -webkit-backdrop-filter:saturate(160%) blur(36px);
    backdrop-filter:saturate(160%) blur(36px);
    box-shadow:0 8px 28px rgba(0,0,0,.22),inset 0 0.5px 0 rgba(255,255,255,.1);
    opacity:0;transform:translateX(18px) scale(0.97);
    transition:opacity .28s cubic-bezier(.16,1,.3,1),transform .28s cubic-bezier(.16,1,.3,1);
  }
  #${TC_ID} .st.show{opacity:1;transform:translateX(0) scale(1)}
  #${TC_ID} .st.is-active{border-color:rgba(129,140,248,.34)}
  #${TC_ID} .st.queued{background:rgba(28,28,32,.72)}
  #${TC_ID} .st.success{border-color:rgba(52,199,89,.22)}
  #${TC_ID} .st.error{border-color:rgba(255,69,58,.22)}
  #${TC_ID} .st.compact{
    padding:6px 11px;
    transition:padding .25s cubic-bezier(.16,1,.3,1),opacity .28s cubic-bezier(.16,1,.3,1),transform .28s cubic-bezier(.16,1,.3,1);
  }
  #${TC_ID} .st.compact .st-text{
    font-size:12px;font-weight:600;letter-spacing:-0.01em;opacity:.92;
  }
  #${TC_ID} .st.compact .st-icon{width:13px;height:13px}
  #${TC_ID} .st-prog{
    position:absolute;inset:0;transform-origin:left;transform:scaleX(0);z-index:0;
    transition:transform .38s cubic-bezier(.4,0,.2,1);
    background:linear-gradient(90deg,rgba(99,102,241,.3),rgba(168,85,247,.2));
  }
  #${TC_ID} .st.success .st-prog{background:linear-gradient(90deg,rgba(52,199,89,.18),rgba(52,199,89,.08))}
  #${TC_ID} .st.error .st-prog{background:rgba(255,69,58,.14)}
  /* Indeterminate "working/queued" sweep. Decoupled from the determinate
     fill bar so a waiting item never looks ~80% full and then visibly jumps
     back to 0 when its real upload progress begins. An endless sweep also
     has no position to "restart", so recreating the toast after a page
     navigation looks seamless. */
  #${TC_ID} .st-indet{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
  #${TC_ID} .st-indet::before{
    content:"";position:absolute;top:0;bottom:0;left:0;width:45%;
    background:linear-gradient(90deg,transparent,rgba(129,140,248,.40),transparent);
    animation:szuru-sweep 1.25s ease-in-out infinite;
  }
  #${TC_ID} .st-indet.hidden{display:none}
  @keyframes szuru-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}
  #${TC_ID} .st-body{position:relative;z-index:1;display:flex;align-items:center;gap:8px}
  #${TC_ID} .st-icon{flex-shrink:0;width:15px;height:15px;display:flex;align-items:center;justify-content:center}
  #${TC_ID} .st-spin{
    width:13px;height:13px;border:1.8px solid rgba(255,255,255,.2);
    border-top-color:rgba(255,255,255,.85);border-radius:50%;
    animation:szuru-spin .65s linear infinite;
  }
  @keyframes szuru-spin{to{transform:rotate(360deg)}}
  #${TC_ID} .st-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #${TC_ID} .st a{color:inherit;text-decoration:underline;text-underline-offset:2px}
  #${TC_ID} .st-transfer-icon{width:13px;height:13px;vertical-align:-2px;margin-right:3px;opacity:.9}
  #${TC_ID} .st-history{
    pointer-events:auto;overflow:hidden;border-radius:13px;
    color:rgba(255,255,255,.93);background:rgba(24,48,34,.88);
    border:.5px solid rgba(52,199,89,.28);
    -webkit-backdrop-filter:saturate(160%) blur(36px);backdrop-filter:saturate(160%) blur(36px);
    box-shadow:0 8px 28px rgba(0,0,0,.22),inset 0 .5px 0 rgba(255,255,255,.1);
  }
  #${TC_ID} .st-history-head{
    display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;
    font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
  }
  #${TC_ID} .st-history-check{color:rgb(52,199,89);font-size:15px}
  #${TC_ID} .st-history-count{flex:1}
  #${TC_ID} .st-history-chevron{font-size:11px;transition:transform .25s cubic-bezier(.16,1,.3,1)}
  #${TC_ID} .st-history-list{max-height:0;opacity:0;transform:translateY(-6px);overflow:hidden;transition:max-height .32s cubic-bezier(.16,1,.3,1),opacity .2s ease,transform .28s cubic-bezier(.16,1,.3,1)}
  #${TC_ID} .st-history:hover .st-history-list,#${TC_ID} .st-history:focus-within .st-history-list,#${TC_ID} .st-history.open .st-history-list{max-height:330px;opacity:1;transform:translateY(0);overflow:auto}
  #${TC_ID} .st-history:hover .st-history-chevron,#${TC_ID} .st-history:focus-within .st-history-chevron,#${TC_ID} .st-history.open .st-history-chevron{transform:rotate(180deg)}
  #${TC_ID} .st-history-entry{padding:8px 12px;border-top:.5px solid rgba(255,255,255,.1);font:600 12px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif}
  #${TC_ID} .st-history-post{color:rgba(255,255,255,.96);text-decoration:underline;text-underline-offset:2px}
  #${TC_ID} .st-history-existing{margin-left:5px;color:rgba(255,255,255,.6);font-weight:500}
  #${TC_ID} .st-history-relations{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;color:rgba(255,255,255,.64);font-size:11px;font-weight:500}
  #${TC_ID} .st-history-relations a{color:rgba(171,190,255,.95)}
  #${TC_ID} .st-history-link-marker{display:flex;align-items:center;gap:6px;padding:3px 12px;color:rgba(151,181,255,.92);font:600 10px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif}
  #${TC_ID} .st-history-link-marker::before,#${TC_ID} .st-history-link-marker::after{content:"";height:1px;flex:1;background:rgba(151,181,255,.22)}
  #${TC_ID} .st-history-link-marker b{display:grid;place-items:center;width:14px;height:14px;border-radius:50%;background:rgba(114,139,255,.2);font-size:12px}
`;

// Fluent "Arrow Download" icon, kept inline so the content script has no
// external icon-font dependency on arbitrary booru pages.
const DOWNLOAD_ICON = `<svg class="st-transfer-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.75c.38 0 .69.282.743.648l.007.102v11.19l3.22-3.22a.75.75 0 0 1 1.133.976l-.073.085-4.5 4.5a.75.75 0 0 1-.976.073l-.084-.073-4.5-4.5a.75.75 0 0 1 .976-1.133l.085.073 3.22 3.22V3.5c0-.414.336-.75.75-.75Zm5.25 15a.75.75 0 0 1 .743.648l.007.102v1.75a1.75 1.75 0 0 1-1.606 1.743l-.144.007H7.75a1.75 1.75 0 0 1-1.743-1.606L6 20.25V18.5a.75.75 0 0 1 1.493-.102l.007.102v1.75c0 .097.07.177.163.196l.087.009h8.5c.097 0 .177-.07.196-.163l.009-.087V18.5c0-.414.336-.75.75-.75Z"/></svg>`;

const SPINNER_ICON = `<div class="st-spin"></div>`;
const CLOCK_ICON = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="rgba(255,255,255,.36)"/><path d="M6.5 3.7v3l2 1.2" stroke="rgba(255,255,255,.68)" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const CHECK_ICON = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5l3 3 5-5" stroke="rgba(52,199,89,.95)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CROSS_ICON = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 3l7 7M10 3l-7 7" stroke="rgba(255,69,58,.9)" stroke-width="1.7" stroke-linecap="round"/></svg>`;

interface ToastItem {
  el: HTMLElement;
  progressEl: HTMLElement;
  indetEl: HTMLElement;
  iconEl: HTMLElement;
  textEl: HTMLElement;
  phase: "loading" | "done";
  downloadSpeed?: string;
  totalBytes?: number;
}

interface CompletedImport {
  importId: string;
  postId?: number;
  postUrl?: string;
  alreadyUploaded?: boolean;
  linkedPostIds?: number[];
  duplicateOutcome?: "replaced" | "tags_merged";
  completedAt: number;
}

const toastMap = new Map<string, ToastItem>();

// Tracks importIds that have already finished in this page session so we don't
// re-create their toasts during bfcache restores or after a tab navigation
// lands on the same content script.
const seenFinished = new Set<string>();

const completedImports = new Map<string, CompletedImport>();
let completionMenu: HTMLElement | undefined;
let completionCount: HTMLElement | undefined;
let completionList: HTMLElement | undefined;
let completionExpiryTimer: ReturnType<typeof setTimeout> | undefined;

const successListeners = new Set<() => void>();

/** Notified whenever an import completes successfully on this page. */
export function onImportSucceeded(listener: () => void): void {
  successListeners.add(listener);
}

// ── Container ─────────────────────────────────────────────────────────

function getOrCreateContainer(): HTMLElement {
  const existing = document.getElementById(TC_ID);
  if (existing) return existing;

  const container = document.createElement("div");
  container.id = TC_ID;
  container.style.cssText = "position:fixed;top:16px;right:16px;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:7px;z-index:2147483647;pointer-events:none;";

  const style = document.createElement("style");
  style.textContent = TOAST_STYLES;
  container.appendChild(style);
  document.documentElement.appendChild(container);
  return container;
}

// ── Upload history panel ──────────────────────────────────────────────

/** Rewrite a post URL's id, so relation links can point at sibling posts. */
function getPostUrl(postUrl: string | undefined, postId: number): string | undefined {
  if (!postUrl) return undefined;
  try {
    const url = new URL(postUrl);
    url.pathname = url.pathname.replace(/\/post\/\d+\/?$/, `/post/${postId}`);
    return url.href;
  } catch {
    return undefined;
  }
}

function getOrCreateCompletionMenu(): void {
  if (completionMenu) return;

  const menu = document.createElement("div");
  menu.className = "st-history";

  const head = document.createElement("div");
  head.className = "st-history-head";
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  head.setAttribute("aria-expanded", "false");

  const check = document.createElement("span");
  check.className = "st-history-check";
  check.textContent = "✓";
  completionCount = document.createElement("span");
  completionCount.className = "st-history-count";
  const chevron = document.createElement("span");
  chevron.className = "st-history-chevron";
  chevron.textContent = "⌄";
  head.append(check, completionCount, chevron);

  completionList = document.createElement("div");
  completionList.className = "st-history-list";

  const toggle = () => {
    const open = menu.classList.toggle("open");
    head.setAttribute("aria-expanded", String(open));
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  menu.append(head, completionList);
  getOrCreateContainer().prepend(menu);
  completionMenu = menu;
}

function duplicateLabel(entry: Pick<CompletedImport, "duplicateOutcome">): string {
  if (entry.duplicateOutcome === "replaced") return t("toast.duplicateReplaced") || "better file replaced";
  if (entry.duplicateOutcome === "tags_merged") return t("toast.tagsMerged") || "tags imported";
  return t("toast.alreadyUploadedLabel") || "already uploaded";
}

function renderHistoryRow(entry: CompletedImport): HTMLElement {
  const row = document.createElement("div");
  row.className = "st-history-entry";

  const post = document.createElement(entry.postUrl ? "a" : "span");
  post.className = "st-history-post";
  post.textContent = entry.postId ? `#${entry.postId}` : "Post";
  if (post instanceof HTMLAnchorElement && entry.postUrl) {
    post.href = entry.postUrl;
    post.target = "_blank";
    post.rel = "noopener";
  }
  row.appendChild(post);

  if (entry.alreadyUploaded) {
    const existing = document.createElement("span");
    existing.className = "st-history-existing";
    existing.textContent = duplicateLabel(entry);
    row.appendChild(existing);
  }

  if (entry.linkedPostIds?.length) {
    const relations = document.createElement("div");
    relations.className = "st-history-relations";
    const label = document.createElement("span");
    label.textContent = `${t("toast.linkedWith") || "Linked with"}:`;
    relations.appendChild(label);
    for (const linkedId of entry.linkedPostIds) {
      const link = document.createElement("a");
      link.textContent = `#${linkedId}`;
      link.href = getPostUrl(entry.postUrl, linkedId) ?? "#";
      link.target = "_blank";
      link.rel = "noopener";
      relations.appendChild(link);
    }
    row.appendChild(relations);
  }

  return row;
}

export function renderCompletedImports(): void {
  getOrCreateCompletionMenu();
  if (!completionCount || !completionList) return;

  const count = completedImports.size;
  completionCount.textContent = t("toast.uploadCount", { count }) || `${count} uploaded`;
  completionList.replaceChildren();

  const entries = [...completedImports.values()].reverse();
  for (const [index, entry] of entries.entries()) {
    completionList.appendChild(renderHistoryRow(entry));

    // The most useful relation cue is between the two adjacent uploads it
    // connects. A chain upload can still list its additional links inside the
    // row above.
    const nextEntry = entries[index + 1];
    if (nextEntry?.postId && entry.linkedPostIds?.includes(nextEntry.postId)) {
      const marker = document.createElement("div");
      marker.className = "st-history-link-marker";
      marker.innerHTML = `<b>+</b><span>${t("toast.linkedWith") || "Linked"}</span>`;
      completionList.appendChild(marker);
    }
  }
}

export function scheduleCompletionMenuExpiry(): void {
  if (completionExpiryTimer) clearTimeout(completionExpiryTimer);
  const newestCompletion = Math.max(...[...completedImports.values()].map((entry) => entry.completedAt));
  const remaining = HISTORY_LIFETIME_MS - (Date.now() - newestCompletion);

  completionExpiryTimer = setTimeout(() => {
    completedImports.clear();
    completionMenu?.remove();
    completionMenu = undefined;
    completionCount = undefined;
    completionList = undefined;
    completionExpiryTimer = undefined;
  }, Math.max(remaining, 0));
}

export function addCompletedImport(data: any, render = true): void {
  const importId: string = data.importId ?? "__legacy__";
  completedImports.set(importId, {
    importId,
    postId: data.postId,
    postUrl: data.postUrl,
    alreadyUploaded: data.alreadyUploaded,
    linkedPostIds: Array.isArray(data.linkedPostIds) ? data.linkedPostIds : undefined,
    duplicateOutcome: data.duplicateOutcome,
    completedAt: typeof data.completedAt === "number" ? data.completedAt : Date.now(),
  });

  if (render) {
    renderCompletedImports();
    scheduleCompletionMenuExpiry();
  }
}

// ── Individual toasts ─────────────────────────────────────────────────

function createToast(importId: string): ToastItem {
  // Guard against duplicate toasts for the same import — this happens when the
  // page is restored from bfcache, or when the background restore runs
  // alongside a fresh "running" status broadcast.
  const existing = toastMap.get(importId);
  if (existing) return existing;

  const el = document.createElement("div");
  el.className = "st";

  const progressEl = document.createElement("div");
  progressEl.className = "st-prog";

  // Indeterminate sweep shown while loading/queued (no misleading fill level).
  const indetEl = document.createElement("div");
  indetEl.className = "st-indet";

  const bodyEl = document.createElement("div");
  bodyEl.className = "st-body";

  const iconEl = document.createElement("div");
  iconEl.className = "st-icon";
  iconEl.innerHTML = SPINNER_ICON;

  const textEl = document.createElement("span");
  textEl.className = "st-text";
  textEl.textContent = t("toast.importing") || "Importing…";

  bodyEl.append(iconEl, textEl);
  el.append(progressEl, indetEl, bodyEl);
  getOrCreateContainer().appendChild(el);

  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));

  const item: ToastItem = { el, progressEl, indetEl, iconEl, textEl, phase: "loading" };
  toastMap.set(importId, item);
  return item;
}

function dismissToast(importId: string, delay: number): void {
  const item = toastMap.get(importId);
  if (!item) return;
  setTimeout(() => {
    item.el.classList.remove("show");
    setTimeout(() => {
      item.el.remove();
      toastMap.delete(importId);
    }, 320);
  }, delay);
}

function setRunningToastState(item: ToastItem, queued: boolean, message?: string): void {
  item.el.classList.toggle("queued", queued);
  item.el.classList.toggle("is-active", !queued);

  if (queued) {
    // Only the task currently uploading should move. Static queued rows keep a
    // long queue visually calm and aligned instead of a stack of unrelated
    // shimmer animations restarting at different moments.
    item.indetEl.classList.add("hidden");
    item.iconEl.innerHTML = CLOCK_ICON;
    // A retry waiting out its backoff sends its own label ("Retry 2/3…"),
    // which is more informative than the generic queued text.
    item.textEl.textContent = message || t("toast.queued") || "Queued…";
    return;
  }

  item.indetEl.classList.remove("hidden");
  item.iconEl.innerHTML = SPINNER_ICON;
  item.textEl.textContent = t("toast.importing") || "Importing…";
}

function formatTransferSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setTransferText(
  item: ToastItem,
  speedBytesPerSecond: unknown,
  progress: unknown,
  lastDownloadSpeedBytesPerSecond?: unknown,
  totalBytes?: unknown,
): void {
  if (typeof totalBytes === "number" && totalBytes > 0) item.totalBytes = totalBytes;
  const size = item.totalBytes ? ` | ${formatByteSize(item.totalBytes)}` : "";

  if (typeof speedBytesPerSecond === "number" && speedBytesPerSecond > 0) {
    item.downloadSpeed = formatTransferSpeed(speedBytesPerSecond);
    item.textEl.innerHTML = `${t("toast.downloading") || "Downloading…"}${size} | ${DOWNLOAD_ICON}${item.downloadSpeed}`;
    return;
  }

  if (!item.downloadSpeed && typeof lastDownloadSpeedBytesPerSecond === "number" && lastDownloadSpeedBytesPerSecond > 0) {
    item.downloadSpeed = formatTransferSpeed(lastDownloadSpeedBytesPerSecond);
  }

  // At roughly 85% the source download has finished and the background starts
  // the multipart transfer to szurubooru. Native fetch deliberately has no
  // trustworthy upload-byte callback, so retain the measured DL rate while
  // clearly labelling the remaining phase instead of showing a fake UP speed.
  if (typeof progress === "number" && progress >= 0.85 && item.downloadSpeed) {
    item.textEl.innerHTML = `${t("toast.uploading") || "Uploading…"}${size} | ${DOWNLOAD_ICON}${item.downloadSpeed}`;
    return;
  }

  item.textEl.textContent = `${t("toast.importing") || "Importing…"}${size}`;
}

function renderSuccess(item: ToastItem, importId: string, data: any): void {
  seenFinished.add(importId);
  addCompletedImport(data);
  for (const listener of successListeners) listener();

  item.el.classList.add("success");
  item.iconEl.innerHTML = CHECK_ICON;

  // Compact "done" rendering: just the icon and a short post link — keeps the
  // toast stack tidy when many imports finish in quick succession.
  const link = data.postUrl ? `<a href="${data.postUrl}" target="_blank">#${data.postId}</a>` : "Post";
  item.textEl.innerHTML = data.alreadyUploaded
    ? data.duplicateOutcome === "replaced" || data.duplicateOutcome === "tags_merged"
      ? `${link} ${duplicateLabel(data)}`
      : t("toast.alreadyUploadedShort", { link }) || `${link} (existing)`
    : t("toast.importedShort", { link }) || link;

  item.el.classList.add("compact");
  // Successful imports move into the persistent counter menu. Leave the
  // individual toast visible just long enough for its completion animation.
  dismissToast(importId, SUCCESS_TOAST_DISMISS_MS);
}

export function handleQuickImportStatus(data: any): void {
  const importId: string = data.importId ?? "__legacy__";

  // Suppress already-finished imports from being recreated as fresh toasts.
  if (seenFinished.has(importId) && data.status !== "success" && data.status !== "error") {
    return;
  }

  if (data.status === "running") {
    // "queued" mode = waiting in the sequential queue behind another upload.
    setRunningToastState(createToast(importId), !!data.queued, data.message);
    return;
  }

  if (data.status === "heartbeat") {
    const item = createToast(importId);
    item.el.classList.remove("queued");
    item.el.classList.add("is-active");
    setTransferText(item, data.speedBytesPerSecond, data.progress, data.lastDownloadSpeedBytesPerSecond, data.totalBytes);
    if (typeof data.elapsedSeconds === "number" && data.elapsedSeconds > 0) {
      item.textEl.textContent = `${item.textEl.textContent} · ${data.elapsedSeconds}s`;
    }
    return;
  }

  // For hotkey imports the toast is created locally before this point, but
  // guard anyway so progress/success/error always have a toast.
  const item = createToast(importId);

  if (data.status === "progress") {
    // Switch from the indeterminate sweep to a real fill bar once meaningful
    // intermediate progress is available (< 1 means partial). The fill grows
    // from its current value, so there's no jump back to 0.
    item.el.classList.remove("queued");
    item.el.classList.add("is-active");
    setTransferText(item, data.speedBytesPerSecond, data.progress, data.lastDownloadSpeedBytesPerSecond, data.totalBytes);
    if (typeof data.progress === "number" && data.progress < 1 && item.phase === "loading") {
      item.indetEl.classList.add("hidden");
      item.progressEl.style.transform = `scaleX(${Math.min(Math.max(data.progress, 0), 0.98)})`;
    }
    return;
  }

  // Terminal states — hide the sweep, freeze the fill at its current position,
  // then transition to full. rAF ensures the browser records the current value
  // before we override the transform.
  item.phase = "done";
  item.indetEl.classList.add("hidden");
  const progEl = item.progressEl;
  progEl.style.transform = getComputedStyle(progEl).transform; // freeze at current position
  requestAnimationFrame(() => {
    progEl.style.transition = "transform .3s ease-out";
    progEl.style.transform = "scaleX(1)";
  });

  if (data.status === "success") {
    renderSuccess(item, importId, data);
  } else if (data.status === "error") {
    seenFinished.add(importId);
    item.el.classList.add("error");
    item.iconEl.innerHTML = CROSS_ICON;
    item.textEl.textContent = t("toast.importFailed", { message: data.message ?? "Unknown error" });
    dismissToast(importId, ERROR_TOAST_DISMISS_MS);
  }
}

// ── Restoration after a navigation ────────────────────────────────────

interface RestorableImport {
  importId: string;
  status: string;
  progress?: number;
  postId?: number;
  postUrl?: string;
  alreadyUploaded?: boolean;
  linkedPostIds?: number[];
  duplicateOutcome?: "replaced" | "tags_merged";
  completedAt?: number;
  speedBytesPerSecond?: number;
  lastDownloadSpeedBytesPerSecond?: number;
  totalBytes?: number;
  message?: string;
  queued?: boolean;
}

/**
 * The background tracks all in-flight/recently-finished imports. On each new
 * page load we ask for the current state and recreate toasts, so the user
 * always sees what's happening even after navigating away mid-burst.
 */
export async function restoreActiveImports(): Promise<void> {
  try {
    const imports: RestorableImport[] = await browser.runtime.sendMessage(new BrowserCommand("get_active_imports"));
    if (!Array.isArray(imports)) return;

    let restoredSuccessfulImport = false;

    for (const item of imports) {
      // Skip imports already represented in this page session. A new page
      // intentionally restores finished items into the upload-history menu.
      if (!item.importId || seenFinished.has(item.importId)) continue;

      if (item.status === "running") {
        handleQuickImportStatus({ status: "running", importId: item.importId, queued: item.queued });
      } else if (item.status === "progress") {
        createToast(item.importId);
        if (typeof item.progress === "number") {
          handleQuickImportStatus({ ...item, status: "progress" });
        }
      } else if (item.status === "success") {
        // Completed imports restored after a navigation belong straight in the
        // history menu. Replaying their individual success toast here makes old
        // rows briefly pop in below the new counter on every page.
        seenFinished.add(item.importId);
        addCompletedImport(item, false);
        restoredSuccessfulImport = true;
      } else if (item.status === "error") {
        createToast(item.importId);
        handleQuickImportStatus({ status: "error", importId: item.importId, message: item.message });
      }
    }

    // A page change can restore several finished uploads at once. Rendering
    // them as a batch prevents the counter panel from repeatedly collapsing and
    // restarting its opening animation for every restored row.
    if (restoredSuccessfulImport) {
      renderCompletedImports();
      scheduleCompletionMenuExpiry();
    }
  } catch { /* ignore — content script may load before background is ready */ }
}

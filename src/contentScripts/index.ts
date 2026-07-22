import { NeoScraper, ScrapeResults } from "neo-scraper";
import { BrowserCommand } from "~/models";
import { guessMimeTypeFromUrl } from "~/utils";
import { t, setLanguage, Language } from "~/i18n";

// Firefox `browser.tabs.executeScript()` requires scripts return a primitive value
(() => {
  // The script is declared in the manifest but may also be injected on demand
  // while a navigation is still settling. Two concurrent fallback injections
  // used to register two message/key handlers in the same document, causing
  // every queue status toast to be rendered twice. Keep the first instance as
  // the single owner for this document.
  const initializationFlag = "__szuruContentScriptInitialized__";
  const pageGlobal = globalThis as typeof globalThis & Record<string, boolean | undefined>;
  if (pageGlobal[initializationFlag]) return;
  pageGlobal[initializationFlag] = true;

  // Stored config is read by several features here (language, hotkeys, the
  // imported badge). Different storage adapters have wrapped the value in
  // various ways over time, so unwrapping lives in one place.
  async function readStoredConfig(): Promise<any | undefined> {
    try {
      const storage = await browser.storage.local.get("config");
      let raw = storage?.config;
      if (!raw) return undefined;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (raw?.value && typeof raw.value === "object") raw = raw.value;
      return raw;
    } catch {
      return undefined;
    }
  }

  // Read language from stored config
  async function initLanguage() {
    const raw = await readStoredConfig();
    if (raw?.language) setLanguage(raw.language as Language);
  }
  initLanguage();
  function grabPost(): ScrapeResults {
    const scraper = new NeoScraper();
    return scraper.scrapeDocument(document, true);
  }

  // Fetch content from within the page context so cookies and session data are
  // included automatically. This bypasses CDN hotlink protection
  // that blocks requests from non-browser / non-page contexts.
  // Returns base64-encoded data instead of ArrayBuffer because browser extension
  // message passing (especially Chrome MV3 / webextension-polyfill) may use JSON
  // serialization which destroys ArrayBuffer instances.
  function isHtmlResponse(res: Response) {
    return (res.headers.get("content-type") ?? "").includes("text/html");
  }

  // XHR in Firefox content scripts with host_permissions bypasses CORS entirely.
  // fetch() in content scripts still enforces CORS and cannot read cross-origin
  // responses without server-side CORS headers — XHR does not have this restriction.
  function sendDownloadProgress(importId: string, progress: number, speedBytesPerSecond?: number, totalBytes?: number) {
    browser.runtime.sendMessage(new BrowserCommand("report_progress", { importId, progress, speedBytesPerSecond, totalBytes })).catch(() => {});
  }

  function xhrFetchBinary(url: string, importId?: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = true;
      if (importId) {
        let lastReported = -1;
        let lastSampleBytes = 0;
        let lastSampleAt = Date.now();
        xhr.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = (e.loaded / e.total) * 0.8;
            if (pct - lastReported >= 0.02) {
              const now = Date.now();
              const speed = (e.loaded - lastSampleBytes) / Math.max(now - lastSampleAt, 1) * 1000;
              lastReported = pct;
              lastSampleBytes = e.loaded;
              lastSampleAt = now;
              sendDownloadProgress(importId, pct, speed, e.total);
            }
          }
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            buffer: xhr.response as ArrayBuffer,
            contentType: xhr.getResponseHeader("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream",
          });
        } else {
          reject(new Error(`HTTP ${xhr.status} ${xhr.statusText}`));
        }
      };
      xhr.onerror = () => reject(new Error("XHR network error"));
      xhr.ontimeout = () => reject(new Error("XHR timeout"));
      xhr.send();
    });
  }

  // Stream a fetch Response body and report download progress (mapped to 0–0.8 range).
  // Falls back to arrayBuffer() when Content-Length is unavailable.
  async function streamResponse(res: Response, importId?: string): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    const rawMime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    const contentLength = parseInt(res.headers.get("content-length") ?? "0");

    if (!importId || !res.body || contentLength <= 0) {
      return { buffer: await res.arrayBuffer(), mimeType: rawMime };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReported = -1;
    let lastSampleBytes = 0;
    let lastSampleAt = Date.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        const pct = Math.min(received / contentLength, 1) * 0.8;
        if (pct - lastReported >= 0.02) {
          const now = Date.now();
          const speed = (received - lastSampleBytes) / Math.max(now - lastSampleAt, 1) * 1000;
          lastReported = pct;
          lastSampleBytes = received;
          lastSampleAt = now;
          sendDownloadProgress(importId, pct, speed, contentLength);
        }
      }
    }

    const buffer = new ArrayBuffer(received);
    const view = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) { view.set(chunk, offset); offset += chunk.length; }
    return { buffer, mimeType: rawMime };
  }

  async function fetchContent(url: string, importId?: string): Promise<{ base64: string; mimeType: string }> {
    // Attempt 1: fetch with full-URL Referer (unsafe-url policy) but no credentials.
    // "unsafe-url" sends the complete page URL as Referer for cross-origin requests,
    // which satisfies CDN hotlink checks that verify the full path (not just origin).
    // Reject HTML responses — some CDNs return 200 OK + HTML error page
    // when the Referer is wrong, which must not be mistaken for the actual media.
    let fetched: { buffer: ArrayBuffer; mimeType: string } | undefined;
    try {
      const res = await fetch(url, { referrerPolicy: "unsafe-url" });
      if (res.ok && !isHtmlResponse(res)) fetched = await streamResponse(res, importId);
    } catch { /* fall through */ }

    // Attempt 2: fetch with credentials + full-URL Referer.
    // Some CDNs (in Brave/Chrome) require session cookies AND
    // the correct Referer. Including credentials sends the page's cookies so the
    // CDN can verify the request originates from an authenticated session.
    if (!fetched) {
      try {
        const res = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
        if (res.ok && !isHtmlResponse(res)) fetched = await streamResponse(res, importId);
      } catch { /* fall through */ }
    }

    let buffer: ArrayBuffer;
    let rawMime: string;

    if (fetched) {
      buffer = fetched.buffer;
      rawMime = fetched.mimeType;
    } else {
      // Attempt 3: XHR with credentials (includes cookies + page Referer).
      // XHR bypasses CORS in Firefox content scripts with host_permissions,
      // handling CDNs that lack CORS headers.
      const xhrResult = await xhrFetchBinary(url, importId);
      if (xhrResult.contentType.includes("text/html")) throw new Error("CDN returned an HTML error page");
      buffer = xhrResult.buffer;
      rawMime = xhrResult.contentType;
    }

    if (buffer.byteLength === 0) throw new Error("Empty response body");
    const mimeType = guessMimeTypeFromUrl(url, rawMime);

    // Encode as base64 for safe transfer through message passing.
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    return { base64, mimeType };
  }

  // ── Quick-import toast queue ─────────────────────────────────────
  const TC_ID = "szuru-tc";

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

  const toastMap = new Map<string, ToastItem>();

  // Tracks importIds that have already finished in this page session so we
  // don't re-create their toasts during bfcache restores or after a tab
  // navigation lands on the same content script.
  const seenFinished = new Set<string>();

  interface CompletedImport {
    importId: string;
    postId?: number;
    postUrl?: string;
    alreadyUploaded?: boolean;
    linkedPostIds?: number[];
    duplicateOutcome?: "replaced" | "tags_merged";
    completedAt: number;
  }

  const completedImports = new Map<string, CompletedImport>();
  let completionMenu: HTMLElement | undefined;
  let completionCount: HTMLElement | undefined;
  let completionList: HTMLElement | undefined;
  let completionExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  function getOrCreateContainer(): HTMLElement {
    let c = document.getElementById(TC_ID);
    if (c) return c;

    c = document.createElement("div");
    c.id = TC_ID;
    c.style.cssText = "position:fixed;top:16px;right:16px;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:7px;z-index:2147483647;pointer-events:none;";

    const style = document.createElement("style");
    style.textContent = `
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
    c.appendChild(style);
    document.documentElement.appendChild(c);
    return c;
  }

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
    const container = getOrCreateContainer();
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
    container.prepend(menu);
    completionMenu = menu;
  }

  function renderCompletedImports() {
    getOrCreateCompletionMenu();
    if (!completionCount || !completionList) return;
    const count = completedImports.size;
    completionCount.textContent = t("toast.uploadCount", { count }) || `${count} uploaded`;
    completionList.replaceChildren();

    const entries = [...completedImports.values()].reverse();
    for (const [index, entry] of entries.entries()) {
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
        existing.textContent = entry.duplicateOutcome === "replaced"
          ? t("toast.duplicateReplaced") || "better file replaced"
          : entry.duplicateOutcome === "tags_merged"
            ? t("toast.tagsMerged") || "tags imported"
            : t("toast.alreadyUploadedLabel") || "already uploaded";
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
      completionList.appendChild(row);

      // The most useful relation cue is between the two adjacent uploads it
      // connects. A chain upload can still list its additional links inside
      // the row above.
      const nextEntry = entries[index + 1];
      if (nextEntry?.postId && entry.linkedPostIds?.includes(nextEntry.postId)) {
        const marker = document.createElement("div");
        marker.className = "st-history-link-marker";
        marker.innerHTML = `<b>+</b><span>${t("toast.linkedWith") || "Linked"}</span>`;
        completionList.appendChild(marker);
      }
    }
  }

  function scheduleCompletionMenuExpiry() {
    if (completionExpiryTimer) clearTimeout(completionExpiryTimer);
    const newestCompletion = Math.max(...[...completedImports.values()].map((entry) => entry.completedAt));
    const remaining = 15_000 - (Date.now() - newestCompletion);
    completionExpiryTimer = setTimeout(() => {
      completedImports.clear();
      completionMenu?.remove();
      completionMenu = undefined;
      completionCount = undefined;
      completionList = undefined;
      completionExpiryTimer = undefined;
    }, Math.max(remaining, 0));
  }

  function addCompletedImport(data: any, render = true) {
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

  function createToast(importId: string): ToastItem {
    // Guard against duplicate toasts for the same import. This happens when
    // the page is restored from bfcache or when the background restore runs
    // alongside a fresh "running" status broadcast.
    const existing = toastMap.get(importId);
    if (existing) return existing;

    const container = getOrCreateContainer();

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
    const spinner = document.createElement("div");
    spinner.className = "st-spin";
    iconEl.appendChild(spinner);

    const textEl = document.createElement("span");
    textEl.className = "st-text";
    textEl.textContent = t("toast.importing") || "Importing…";

    bodyEl.appendChild(iconEl);
    bodyEl.appendChild(textEl);
    el.appendChild(progressEl);
    el.appendChild(indetEl);
    el.appendChild(bodyEl);
    container.appendChild(el);

    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));

    const item: ToastItem = { el, progressEl, indetEl, iconEl, textEl, phase: "loading" };
    toastMap.set(importId, item);
    return item;
  }

  function dismissToast(importId: string, delay: number) {
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

  function setRunningToastState(item: ToastItem, queued: boolean, message?: string) {
    item.el.classList.toggle("queued", queued);
    item.el.classList.toggle("is-active", !queued);
    if (queued) {
      // Only the task currently uploading should move. Static queued rows keep
      // a long queue visually calm and aligned instead of a stack of unrelated
      // shimmer animations restarting at different moments.
      item.indetEl.classList.add("hidden");
      item.iconEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="rgba(255,255,255,.36)"/><path d="M6.5 3.7v3l2 1.2" stroke="rgba(255,255,255,.68)" stroke-width="1.2" stroke-linecap="round"/></svg>`;
      // A retry waiting out its backoff sends its own label ("Retry 2/3…"),
      // which is more informative than the generic queued text.
      item.textEl.textContent = message || t("toast.queued") || "Queued…";
      return;
    }

    item.indetEl.classList.remove("hidden");
    item.iconEl.innerHTML = `<div class="st-spin"></div>`;
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

  // Fluent "Arrow Download" icon, kept inline so the content script has no
  // external icon-font dependency on arbitrary booru pages.
  const downloadIcon = `<svg class="st-transfer-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.75c.38 0 .69.282.743.648l.007.102v11.19l3.22-3.22a.75.75 0 0 1 1.133.976l-.073.085-4.5 4.5a.75.75 0 0 1-.976.073l-.084-.073-4.5-4.5a.75.75 0 0 1 .976-1.133l.085.073 3.22 3.22V3.5c0-.414.336-.75.75-.75Zm5.25 15a.75.75 0 0 1 .743.648l.007.102v1.75a1.75 1.75 0 0 1-1.606 1.743l-.144.007H7.75a1.75 1.75 0 0 1-1.743-1.606L6 20.25V18.5a.75.75 0 0 1 1.493-.102l.007.102v1.75c0 .097.07.177.163.196l.087.009h8.5c.097 0 .177-.07.196-.163l.009-.087V18.5c0-.414.336-.75.75-.75Z"/></svg>`;

  function setTransferText(item: ToastItem, speedBytesPerSecond: unknown, progress: unknown, lastDownloadSpeedBytesPerSecond?: unknown, totalBytes?: unknown) {
    if (typeof totalBytes === "number" && totalBytes > 0) item.totalBytes = totalBytes;
    const size = item.totalBytes ? ` | ${formatByteSize(item.totalBytes)}` : "";
    if (typeof speedBytesPerSecond === "number" && speedBytesPerSecond > 0) {
      item.downloadSpeed = formatTransferSpeed(speedBytesPerSecond);
      item.textEl.innerHTML = `${t("toast.downloading") || "Downloading…"}${size} | ${downloadIcon}${item.downloadSpeed}`;
      return;
    }

    if (!item.downloadSpeed && typeof lastDownloadSpeedBytesPerSecond === "number" && lastDownloadSpeedBytesPerSecond > 0) {
      item.downloadSpeed = formatTransferSpeed(lastDownloadSpeedBytesPerSecond);
    }

    // At roughly 85% the source download has finished and the background
    // starts the multipart transfer to Szurubooru. Native fetch deliberately
    // has no trustworthy upload-byte callback, so retain the measured DL rate
    // while clearly labelling the remaining phase instead of showing a fake UP
    // speed.
    if (typeof progress === "number" && progress >= 0.85 && item.downloadSpeed) {
      item.textEl.innerHTML = `${t("toast.uploading") || "Uploading…"}${size} | ${downloadIcon}${item.downloadSpeed}`;
      return;
    }

    item.textEl.textContent = `${t("toast.importing") || "Importing…"}${size}`;
  }

  function handleQuickImportStatus(data: any) {
    const importId: string = data.importId ?? "__legacy__";

    // Suppress already-finished imports from being recreated as fresh toasts.
    if (seenFinished.has(importId) && data.status !== "success" && data.status !== "error") {
      return;
    }

    if (data.status === "running") {
      const item = createToast(importId);
      // "queued" mode = waiting in the sequential queue behind another upload.
      setRunningToastState(item, !!data.queued, data.message);
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

    // For hotkey imports the toast is created locally before this point,
    // but guard anyway so progress/success/error always have a toast.
    if (!toastMap.has(importId)) createToast(importId);
    const item = toastMap.get(importId)!;

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
    const currentScale = getComputedStyle(progEl).transform;
    progEl.style.transform = currentScale; // freeze at current position
    requestAnimationFrame(() => {
      progEl.style.transition = "transform .3s ease-out";
      progEl.style.transform = "scaleX(1)";
    });

    if (data.status === "success") {
      seenFinished.add(importId);
      addCompletedImport(data);
      // The page the user is standing on may be the one just imported —
      // flip the badge over immediately instead of after the next navigation.
      void updateImportedBadge(true);
      item.el.classList.add("success");
      item.iconEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5l3 3 5-5" stroke="rgba(52,199,89,.95)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      // Compact "done" rendering: just the icon and a short post link – keeps
      // the toast stack tidy when many imports finish in quick succession.
      const link = data.postUrl
        ? `<a href="${data.postUrl}" target="_blank">#${data.postId}</a>`
        : "Post";
      item.textEl.innerHTML = data.alreadyUploaded
        ? data.duplicateOutcome === "replaced"
          ? `${link} ${t("toast.duplicateReplaced") || "better file replaced"}`
          : data.duplicateOutcome === "tags_merged"
            ? `${link} ${t("toast.tagsMerged") || "tags imported"}`
            : t("toast.alreadyUploadedShort", { link }) || `${link} (existing)`
        : t("toast.importedShort", { link }) || link;
      item.el.classList.add("compact");
      // Successful imports move into the persistent counter menu. Leave the
      // individual toast visible just long enough for its completion animation.
      dismissToast(importId, 450);
    } else if (data.status === "error") {
      seenFinished.add(importId);
      item.el.classList.add("error");
      item.iconEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M3 3l7 7M10 3l-7 7" stroke="rgba(255,69,58,.9)" stroke-width="1.7" stroke-linecap="round"/></svg>`;
      item.textEl.textContent = t("toast.importFailed", { message: data.message ?? "Unknown error" });
      dismissToast(importId, 6000);
    }
  }

  async function fetchHeadInfo(url: string): Promise<{ contentType?: string; contentLength?: string; finalUrl?: string }> {
    let res: Response | undefined;
    try {
      res = await fetch(url, { method: "HEAD" });
      if (!res.ok || isHtmlResponse(res)) res = undefined;
    } catch { res = undefined; }

    if (!res) {
      res = await fetch(url, { method: "HEAD", credentials: "include", referrerPolicy: "unsafe-url" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return {
      contentType: res.headers.get("content-type") ?? undefined,
      contentLength: res.headers.get("content-length") ?? undefined,
      finalUrl: res.url !== url ? res.url : undefined,
    };
  }

  async function messageHandler(cmd: BrowserCommand): Promise<any> {
    switch (cmd.name) {
      case "grab_post":
        return grabPost();
      case "fetch_content":
        return fetchContent(cmd.data.url, cmd.data.importId);
      case "fetch_head_info":
        return fetchHeadInfo(cmd.data.url);
      case "quick_import_status":
        handleQuickImportStatus(cmd.data);
        return;
      case "batch_status":
        handleBatchStatus(cmd.data);
        return;
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // ── Restore toasts from background after page navigation ─────────
  // The background tracks all in-flight/recently-finished imports.
  // On each new page load we ask for the current state and recreate toasts,
  // so the user always sees what's happening even after navigating away.
  async function restoreActiveImports() {
    try {
      const imports: Array<{
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
      }> = await browser.runtime.sendMessage(new BrowserCommand("get_active_imports"));
      if (!Array.isArray(imports)) return;
      let restoredSuccessfulImport = false;
      for (const item of imports) {
        if (!item.importId) continue;
        // Skip imports already represented in this page session. A new page
        // intentionally restores finished items into the upload-history menu.
        if (seenFinished.has(item.importId)) continue;
        // Dedupe: createToast already returns the existing item when present.
        if (item.status === "running") {
          handleQuickImportStatus({ status: "running", importId: item.importId, queued: item.queued });
        } else if (item.status === "progress") {
          createToast(item.importId);
          if (typeof item.progress === "number") {
            handleQuickImportStatus({
              status: "progress",
              importId: item.importId,
              progress: item.progress,
              speedBytesPerSecond: item.speedBytesPerSecond,
              lastDownloadSpeedBytesPerSecond: item.lastDownloadSpeedBytesPerSecond,
              totalBytes: item.totalBytes,
            });
          }
        } else if (item.status === "success") {
          // Completed imports restored after a navigation belong straight in
          // the history menu. Replaying their individual success toast here
          // makes old rows briefly pop in below the new counter on every page.
          seenFinished.add(item.importId);
          addCompletedImport({
            importId: item.importId,
            postId: item.postId,
            postUrl: item.postUrl,
            alreadyUploaded: item.alreadyUploaded,
            linkedPostIds: item.linkedPostIds,
            duplicateOutcome: item.duplicateOutcome,
            completedAt: item.completedAt,
          }, false);
          restoredSuccessfulImport = true;
        } else if (item.status === "error") {
          createToast(item.importId);
          handleQuickImportStatus({ status: "error", importId: item.importId, message: item.message });
        }
      }
      // A page change can restore several finished uploads at once. Rendering
      // them as a batch prevents the counter panel from repeatedly collapsing
      // and restarting its opening animation for every restored row.
      if (restoredSuccessfulImport) {
        renderCompletedImports();
        scheduleCompletionMenuExpiry();
      }
    } catch { /* ignore — content script may load before background is ready */ }
  }
  void restoreActiveImports();

  // bfcache restore (Chrome/Firefox): page comes back from history without a
  // fresh content-script load. Refresh toast state so nothing lingers stale.
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) void restoreActiveImports();
  });

  // ── "Already imported" badge ─────────────────────────────────────
  // Answers "did I already grab this one?" without opening the popup. The
  // background does the actual lookup (source: search against the selected
  // instance) and caches it, so paging through a gallery is cheap.
  const BADGE_ID = "szuru-imported-badge";
  let badgeEl: HTMLElement | undefined;
  let badgeCheckedUrl: string | undefined;
  let badgeCheckInFlight = false;

  function removeBadge() {
    badgeEl?.remove();
    badgeEl = undefined;
  }

  function getOrCreateBadge(): HTMLElement {
    if (badgeEl) return badgeEl;

    const el = document.createElement("div");
    el.id = BADGE_ID;

    const style = document.createElement("style");
    style.textContent = `
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
    el.appendChild(style);
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
    badgeEl = el;
    return el;
  }

  function renderBadge(result: { imported: boolean; postId?: number; postUrl?: string }) {
    const el = getOrCreateBadge();
    el.classList.toggle("missing", !result.imported);

    // Keep the injected <style> (first child) and replace the content nodes.
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeName !== "STYLE") node.remove();
    }

    const mark = document.createElement("span");
    mark.className = "szb-mark";
    mark.innerHTML = result.imported
      ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5l3 3 5-5" stroke="rgba(52,199,89,.95)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="rgba(255,255,255,.4)"/><path d="M6.5 4v3.4" stroke="rgba(255,255,255,.6)" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="9.3" r=".7" fill="rgba(255,255,255,.6)"/></svg>`;

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

  // The poll below runs on every page in the browser, so the config is cached
  // and refreshed on change rather than read from storage every tick.
  interface BadgeConfig { enabled: boolean; showWhenNotImported: boolean }
  let badgeConfig: BadgeConfig | undefined;

  async function getBadgeConfig(): Promise<BadgeConfig> {
    if (badgeConfig) return badgeConfig;
    const raw = await readStoredConfig();
    badgeConfig = {
      enabled: raw?.importedBadge?.enabled !== false,
      showWhenNotImported: raw?.importedBadge?.showWhenNotImported === true,
    };
    return badgeConfig;
  }

  browser.storage.onChanged.addListener((changes) => {
    if (!changes.config) return;
    badgeConfig = undefined;
    badgeCheckedUrl = undefined;
    void updateImportedBadge();
  });

  async function updateImportedBadge(force = false) {
    if (badgeCheckInFlight) return;

    // Cheapest check first: the poll fires every 1.5s and almost always lands
    // on an unchanged URL.
    const currentUrl = window.location.href;
    if (!force && currentUrl === badgeCheckedUrl) return;

    const cfg = await getBadgeConfig();
    if (!cfg.enabled) {
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
      const result = await browser.runtime.sendMessage(
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
      else if (cfg.showWhenNotImported) renderBadge({ imported: false });
      else removeBadge();
    } catch {
      removeBadge();
    } finally {
      badgeCheckInFlight = false;
    }
  }

  // Navigation detection. pageshow, popstate and hashchange are browser-fired
  // window events that reach the content script's isolated world, so they cover
  // full loads and back/forward/hash jumps instantly and for free.
  const onNavigation = () => void updateImportedBadge();
  void updateImportedBadge();
  window.addEventListener("pageshow", onNavigation);
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("hashchange", onNavigation);

  // Danbooru-style pjax navigates via history.pushState in the page's *main*
  // world, which a content script can't hook (isolated world) and which emits
  // no event. A low-frequency poll is the reliable catch-all for that one case;
  // updateImportedBadge early-returns on an unchanged URL, so a tick is just a
  // string compare when nothing moved.
  let lastPolledUrl = window.location.href;
  setInterval(() => {
    if (window.location.href === lastPolledUrl) return;
    lastPolledUrl = window.location.href;
    onNavigation();
    // A new listing page means a fresh set of candidates for the batch pill.
    void updateBatchLauncher();
  }, 2000);

  // ── Batch import (listing / gallery pages) ────────────────────────
  // Lets the user pick many posts on a listing page and import them all. The
  // heavy lifting (open each in a tab, scrape, upload, close) happens in the
  // background; here we only detect post links, run the selection UI, and show
  // progress. Detection is deliberately conservative — an anchor to a post-
  // detail URL that also wraps a thumbnail image.
  const BATCH_ID = "szuru-batch";
  const SELECTABLE_CLASS = "szuru-batch-selectable";
  const SELECTED_CLASS = "szuru-batch-selected";

  // Same-origin anchors whose href looks like a post-detail page. Covers the
  // common booru URL shapes; unknown sites simply yield nothing.
  const POST_URL_PATTERNS = [
    /\/posts\/\d+/,            // Danbooru, e621
    /\/post\/show\/\d+/,       // Moebooru (yande.re, konachan)
    /\/post\/view\/\d+/,       // Shimmie2
    /[?&]id=\d+/,              // Gelbooru / rule34 (index.php?page=post&s=view&id=)
    /\/post\/\d+(?:[/?#]|$)/,  // generic /post/123
  ];

  let batchConfig: { enabled: boolean; hasSites: boolean } | undefined;
  let batchLauncher: HTMLElement | undefined;
  let batchToolbar: HTMLElement | undefined;
  let batchProgress: HTMLElement | undefined;
  let batchSelectMode = false;
  const batchSelectedUrls = new Set<string>();
  let currentBatchId: string | undefined;

  async function getBatchConfig() {
    if (batchConfig) return batchConfig;
    const raw = await readStoredConfig();
    batchConfig = {
      enabled: raw?.batchImport?.enabled !== false,
      hasSites: Array.isArray(raw?.sites) && raw.sites.length > 0,
    };
    return batchConfig;
  }

  function isPostDetailUrl(href: string): boolean {
    try {
      const url = new URL(href, window.location.href);
      if (url.host !== window.location.host) return false;
      // Don't offer the very page we're already on as a candidate.
      if (url.href.replace(/#.*$/, "") === window.location.href.replace(/#.*$/, "")) return false;
      return POST_URL_PATTERNS.some((re) => re.test(url.pathname + url.search));
    } catch {
      return false;
    }
  }

  function findPostAnchors(): HTMLAnchorElement[] {
    const seen = new Set<string>();
    const anchors: HTMLAnchorElement[] = [];
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      if (!a.querySelector("img")) continue;
      if (!isPostDetailUrl(a.href)) continue;
      const key = new URL(a.href, window.location.href).href;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(a);
    }
    return anchors;
  }

  function ensureBatchStyles() {
    if (document.getElementById(BATCH_ID + "-style")) return;
    const style = document.createElement("style");
    style.id = BATCH_ID + "-style";
    style.textContent = `
      .${SELECTABLE_CLASS}{outline:2px dashed rgba(129,140,248,.7)!important;outline-offset:-2px;cursor:pointer!important;position:relative}
      .${SELECTED_CLASS}{outline:3px solid rgba(52,199,89,.95)!important}
      .${SELECTED_CLASS}::after{content:"✓";position:absolute;top:4px;left:4px;z-index:2147483646;
        display:grid;place-items:center;width:20px;height:20px;border-radius:50%;
        background:rgba(52,199,89,.95);color:#fff;font:700 13px/1 sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4)}
      #${BATCH_ID}-launcher,#${BATCH_ID}-toolbar,#${BATCH_ID}-progress{
        position:fixed;left:16px;bottom:16px;z-index:2147483647;
        font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif;
        color:rgba(255,255,255,.94);background:rgba(28,28,32,.82);
        border:.5px solid rgba(255,255,255,.16);border-radius:13px;
        -webkit-backdrop-filter:saturate(160%) blur(34px);backdrop-filter:saturate(160%) blur(34px);
        box-shadow:0 8px 28px rgba(0,0,0,.24),inset 0 .5px 0 rgba(255,255,255,.1);}
      #${BATCH_ID}-launcher{display:flex;align-items:center;gap:7px;padding:9px 14px;cursor:pointer;
        transition:transform .2s cubic-bezier(.16,1,.3,1)}
      #${BATCH_ID}-launcher:hover{transform:translateY(-1px)}
      #${BATCH_ID}-toolbar,#${BATCH_ID}-progress{display:flex;align-items:center;gap:8px;padding:9px 12px;
        width:min(420px,calc(100vw - 32px));flex-wrap:wrap}
      .${BATCH_ID} .szb-btn{padding:6px 11px;border-radius:9px;border:.5px solid rgba(255,255,255,.18);
        background:rgba(255,255,255,.06);color:inherit;font:inherit;cursor:pointer}
      .${BATCH_ID} .szb-btn:hover{background:rgba(255,255,255,.12)}
      .${BATCH_ID} .szb-btn.primary{background:rgba(99,102,241,.55);border-color:rgba(129,140,248,.5)}
      .${BATCH_ID} .szb-btn.primary:disabled{opacity:.5;cursor:default}
      .${BATCH_ID} .szb-pool{flex:1;min-width:120px;padding:6px 9px;border-radius:9px;
        border:.5px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:inherit;font:inherit}
      .${BATCH_ID} .szb-count{flex:1;min-width:60px}
      .${BATCH_ID} .szb-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden;flex-basis:100%;margin-top:2px}
      .${BATCH_ID} .szb-bar > i{display:block;height:100%;background:linear-gradient(90deg,rgba(99,102,241,.9),rgba(168,85,247,.8));transition:width .3s ease}
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  function removeBatchUi() {
    batchLauncher?.remove(); batchLauncher = undefined;
    batchToolbar?.remove(); batchToolbar = undefined;
  }

  async function updateBatchLauncher() {
    // Never show the launcher while selecting, importing, or when disabled.
    if (batchSelectMode || batchProgress) return;
    const cfg = await getBatchConfig();
    if (!cfg.enabled || !cfg.hasSites) { removeBatchUi(); return; }

    const count = findPostAnchors().length;
    if (count < 2) { removeBatchUi(); return; }

    ensureBatchStyles();
    if (!batchLauncher) {
      const el = document.createElement("div");
      el.id = BATCH_ID + "-launcher";
      el.classList.add(BATCH_ID);
      el.addEventListener("click", enterBatchSelectMode);
      document.documentElement.appendChild(el);
      batchLauncher = el;
    }
    batchLauncher.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="1.5" width="6" height="6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="8.5" y="1.5" width="6" height="6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="1.5" y="8.5" width="6" height="6" rx="1.3" stroke="currentColor" stroke-width="1.3"/><rect x="8.5" y="8.5" width="6" height="6" rx="1.3" stroke="currentColor" stroke-width="1.3"/></svg><span>${t("batch.launcher", { count }) || `Batch import (${count})`}</span>`;
  }

  function toggleAnchor(anchor: HTMLAnchorElement) {
    const url = new URL(anchor.href, window.location.href).href;
    if (batchSelectedUrls.has(url)) {
      batchSelectedUrls.delete(url);
      anchor.classList.remove(SELECTED_CLASS);
    } else {
      batchSelectedUrls.add(url);
      anchor.classList.add(SELECTED_CLASS);
    }
    updateBatchToolbarCount();
  }

  const onSelectClick = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement)?.closest?.("a");
    if (!anchor || !anchor.classList.contains(SELECTABLE_CLASS)) return;
    e.preventDefault();
    e.stopPropagation();
    toggleAnchor(anchor as HTMLAnchorElement);
  };

  function updateBatchToolbarCount() {
    const countEl = batchToolbar?.querySelector(".szb-count");
    const importBtn = batchToolbar?.querySelector<HTMLButtonElement>(".szb-import");
    const n = batchSelectedUrls.size;
    if (countEl) countEl.textContent = t("batch.selected", { count: n }) || `${n} selected`;
    if (importBtn) importBtn.disabled = n === 0;
  }

  function enterBatchSelectMode() {
    batchSelectMode = true;
    batchSelectedUrls.clear();
    removeBatchUi();
    ensureBatchStyles();

    const anchors = findPostAnchors();
    for (const a of anchors) a.classList.add(SELECTABLE_CLASS);
    document.addEventListener("click", onSelectClick, true);

    const bar = document.createElement("div");
    bar.id = BATCH_ID + "-toolbar";
    bar.classList.add(BATCH_ID);
    bar.innerHTML = `
      <span class="szb-count"></span>
      <input class="szb-pool" type="text" placeholder="${t("batch.poolPlaceholder") || "Pool name (optional)"}" />
      <button class="szb-btn szb-all">${t("batch.selectAll") || "All"}</button>
      <button class="szb-btn primary szb-import" disabled>${t("batch.import") || "Import"}</button>
      <button class="szb-btn szb-cancel">${t("batch.cancel") || "Cancel"}</button>
    `;
    document.documentElement.appendChild(bar);
    batchToolbar = bar;

    bar.querySelector(".szb-all")?.addEventListener("click", () => {
      for (const a of findPostAnchors()) {
        const url = new URL(a.href, window.location.href).href;
        if (!batchSelectedUrls.has(url)) { batchSelectedUrls.add(url); a.classList.add(SELECTED_CLASS); }
      }
      updateBatchToolbarCount();
    });
    bar.querySelector(".szb-cancel")?.addEventListener("click", exitBatchSelectMode);
    bar.querySelector(".szb-import")?.addEventListener("click", () => {
      const poolName = bar.querySelector<HTMLInputElement>(".szb-pool")?.value?.trim() || undefined;
      void startBatchImport(poolName);
    });

    updateBatchToolbarCount();
  }

  function exitBatchSelectMode() {
    batchSelectMode = false;
    document.removeEventListener("click", onSelectClick, true);
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(`.${SELECTABLE_CLASS}`))) {
      a.classList.remove(SELECTABLE_CLASS, SELECTED_CLASS);
    }
    batchSelectedUrls.clear();
    batchToolbar?.remove(); batchToolbar = undefined;
    void updateBatchLauncher();
  }

  async function startBatchImport(poolName?: string) {
    const urls = [...batchSelectedUrls];
    if (urls.length === 0) return;

    // Leave select mode but keep a progress panel in its place.
    batchSelectMode = false;
    document.removeEventListener("click", onSelectClick, true);
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(`.${SELECTABLE_CLASS}`))) {
      a.classList.remove(SELECTABLE_CLASS, SELECTED_CLASS);
    }
    batchToolbar?.remove(); batchToolbar = undefined;

    currentBatchId = (crypto as any).randomUUID ? crypto.randomUUID() : String(Date.now());
    showBatchProgress(0, urls.length, poolName);

    try {
      await browser.runtime.sendMessage(new BrowserCommand("batch_import", { urls, poolName, batchId: currentBatchId }));
    } catch (ex: any) {
      finishBatchProgress(t("batch.failed", { error: ex?.message ?? String(ex) }) || "Batch failed");
    }
  }

  function showBatchProgress(done: number, total: number, poolName?: string) {
    ensureBatchStyles();
    if (!batchProgress) {
      const el = document.createElement("div");
      el.id = BATCH_ID + "-progress";
      el.classList.add(BATCH_ID);
      document.documentElement.appendChild(el);
      batchProgress = el;
    }
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const poolNote = poolName ? ` · ${poolName}` : "";
    batchProgress.innerHTML = `
      <span class="szb-count">${(t("batch.progress", { done, total }) || `Importing ${done}/${total}`)}${poolNote}</span>
      <button class="szb-btn szb-close">✕</button>
      <div class="szb-bar"><i style="width:${pct}%"></i></div>
    `;
    batchProgress.querySelector(".szb-close")?.addEventListener("click", () => {
      batchProgress?.remove(); batchProgress = undefined; void updateBatchLauncher();
    });
  }

  function finishBatchProgress(message: string, sticky = false) {
    if (!batchProgress) return;
    batchProgress.innerHTML = `<span class="szb-count">${message}</span><button class="szb-btn szb-close">✕</button>`;
    batchProgress.querySelector(".szb-close")?.addEventListener("click", () => {
      batchProgress?.remove(); batchProgress = undefined; void updateBatchLauncher();
    });
    // Auto-dismiss a clean success; keep errors on screen until dismissed so
    // the reason stays readable.
    if (!sticky) {
      setTimeout(() => {
        batchProgress?.remove(); batchProgress = undefined; void updateBatchLauncher();
      }, 8000);
    }
  }

  function handleBatchStatus(data: any) {
    if (currentBatchId && data.batchId && data.batchId !== currentBatchId) return;
    if (data.phase === "start" || data.phase === "progress") {
      showBatchProgress(data.done ?? 0, data.total ?? 0, data.poolName);
    } else if (data.phase === "done") {
      let msg = t("batch.done", { ok: data.succeeded ?? 0, total: data.total ?? 0 }) || `Done: ${data.succeeded}/${data.total}`;
      if (data.failed) msg += ` · ${t("batch.doneFailed", { failed: data.failed }) || `${data.failed} failed`}`;
      if (data.poolName && data.poolId) msg += ` · ${t("batch.pooled") || "pooled"}`;
      if (data.poolError) msg += ` · ${data.poolError}`;
      // Include the first failure's reason so a lone failed item is actionable.
      if (data.failed && data.failedError) msg += ` — ${data.failedError}`;
      // Anything that went wrong stays on screen until the user closes it.
      const sticky = !!(data.failed || data.poolError);
      finishBatchProgress(msg, sticky);
    }
  }

  void updateBatchLauncher();
  window.addEventListener("pageshow", () => void updateBatchLauncher());
  browser.storage.onChanged.addListener((changes) => {
    if (changes.config) { batchConfig = undefined; void updateBatchLauncher(); }
  });

  // ── Hotkey quick-import ─────────────────────────────────
  type HotkeyConfig = { enabled: boolean; key: string; modifiers: string[] };
  type StoredHotkeyConfig = {
    hotkey?: HotkeyConfig;
    hotkeyLinkLast?: HotkeyConfig;
  };

  async function getHotkeyConfig(): Promise<StoredHotkeyConfig | undefined> {
    const raw = await readStoredConfig();
    if (!raw) return undefined;
    return {
      hotkey: raw.hotkey as HotkeyConfig | undefined,
      hotkeyLinkLast: raw.hotkeyLinkLast as HotkeyConfig | undefined,
    };
  }

  function matchesHotkey(e: KeyboardEvent, hk: HotkeyConfig | undefined) {
    if (!hk?.enabled || !hk.key) return false;
    if (e.key.toLowerCase() !== hk.key.toLowerCase()) return false;

    const wantCtrl = hk.modifiers.includes("ctrl");
    const wantAlt = hk.modifiers.includes("alt");
    const wantShift = hk.modifiers.includes("shift");
    return e.ctrlKey === wantCtrl && e.altKey === wantAlt && e.shiftKey === wantShift;
  }

  // Cache the config and refresh on storage changes. We keep the in-flight
  // load promise around so a hotkey press that arrives *before* the config has
  // loaded (common right after navigating to a fresh page, since the storage
  // read is async on top of document_idle injection) can wait for it instead of
  // being silently dropped — which previously lost imports when paging through
  // quickly.
  let _hotkeyConfig: StoredHotkeyConfig | undefined;
  let _hotkeyConfigPromise: Promise<unknown> = getHotkeyConfig().then((c) => (_hotkeyConfig = c));
  browser.storage.onChanged.addListener((changes) => {
    if (changes.config) {
      _hotkeyConfigPromise = getHotkeyConfig().then((c) => (_hotkeyConfig = c));
    }
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function getFirstScrapedPost(results: ScrapeResults | undefined): any {
    return results?.results?.find((r: any) => r?.posts?.length)?.posts?.[0];
  }

  // Scrape the page, retrying briefly until the DOM reflects the URL captured
  // at hotkey-press time. When a booru navigates with arrow keys / "next"
  // without a full reload, the URL updates a tick before the new image swaps
  // into the DOM. A single scrape then sees the *previous* post, whose pageUrl
  // no longer matches the current URL. Instead of rejecting that press (which
  // silently drops imports when the user pages through quickly), we poll until
  // the DOM catches up — keeping the burst lossless.
  async function scrapeForCurrentPage(pressUrl: string): Promise<ScrapeResults | undefined> {
    const deadline = Date.now() + 2500;
    let last: ScrapeResults | undefined;

    while (true) {
      try {
        last = grabPost();
      } catch (ex) {
        console.warn("Hotkey scrape failed:", ex);
      }

      const post = getFirstScrapedPost(last);
      const scrapedPageUrl: string | undefined = post?.pageUrl;
      // Accept once we have a post whose pageUrl matches (or the scraper exposes
      // no pageUrl at all — nothing to compare against).
      if (post && (!scrapedPageUrl || scrapedPageUrl === pressUrl)) return last;

      // If the user has already navigated away from the page they pressed on,
      // stop chasing — this press was meant for pressUrl, which is gone.
      if (window.location.href !== pressUrl) return last;
      if (Date.now() >= deadline) return last;
      await sleep(120);
    }
  }

  // matchesHotkey only reads key/ctrlKey/altKey/shiftKey, so a plain snapshot of
  // those fields works in place of a live KeyboardEvent (needed for the deferred
  // path below, where the original event is long gone by the time we evaluate).
  type KeyCombo = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey">;

  function commandForCombo(combo: KeyCombo): "hotkey_import_link_last" | "hotkey_import" | undefined {
    return matchesHotkey(combo as KeyboardEvent, _hotkeyConfig?.hotkeyLinkLast)
      ? "hotkey_import_link_last"
      : matchesHotkey(combo as KeyboardEvent, _hotkeyConfig?.hotkey)
        ? "hotkey_import"
        : undefined;
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!el?.isContentEditable;
  }

  // pressUrl is the location at the moment the hotkey was pressed. Subsequent
  // navigation must not make the queued upload scrape the wrong page (which would
  // cause "already uploaded" collisions blocking the rest of the queue).
  function startImport(hotkeyCommand: "hotkey_import_link_last" | "hotkey_import", pressUrl: string) {
    const importId = crypto.randomUUID();
    // Create the toast immediately so the user gets instant feedback
    handleQuickImportStatus({ status: "running", importId });

    const currentUrl = pressUrl;

    void (async () => {
      const scrapeResults = await scrapeForCurrentPage(currentUrl);

      // Only reject if, after waiting, the DOM still shows a *different* page
      // than the one pressed on — i.e. the scrape is genuinely stale and would
      // upload the wrong image. A missing pageUrl is allowed through.
      const firstScrapedPost = getFirstScrapedPost(scrapeResults);
      const scrapedPageUrl: string | undefined = firstScrapedPost?.pageUrl;
      if (scrapedPageUrl && currentUrl && scrapedPageUrl !== currentUrl) {
        console.warn("Hotkey rejected — scrape pageUrl mismatch after retry:", { scrapedPageUrl, currentUrl });
        handleQuickImportStatus({
          status: "error",
          importId,
          message: t("toast.staleScrape") || "Page still transitioning – try again",
        });
        return;
      }

      try {
        await browser.runtime.sendMessage(
          new BrowserCommand(hotkeyCommand, {
            url: currentUrl,
            linkWithLastPost: hotkeyCommand === "hotkey_import_link_last",
            importId,
            scrapeResults,
          }),
        );
      } catch (ex: any) {
        handleQuickImportStatus({ status: "error", message: ex?.message ?? String(ex), importId });
      }
    })();
  }

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    // Ignore OS auto-repeat: holding the hotkey even briefly fires a stream of
    // keydown events, each of which would try to import the *same* page again
    // and get rejected downstream as a duplicate. Only act on the initial press.
    if (e.repeat) return;

    // Don't fire inside input/textarea/contenteditable
    if (isEditableTarget(e.target)) return;

    // Fast path: config is loaded, so we can match synchronously and still
    // preventDefault to suppress the browser's own shortcut (e.g. Ctrl+A).
    if (_hotkeyConfig !== undefined) {
      const hotkeyCommand = commandForCombo(e);
      if (!hotkeyCommand) return;
      e.preventDefault();
      e.stopPropagation();
      startImport(hotkeyCommand, window.location.href);
      return;
    }

    // Config not loaded yet (just navigated to a fresh page). Defer the decision
    // until the in-flight load resolves so the press isn't lost. We can't
    // preventDefault after the fact, but missing the import is the worse outcome.
    const combo: KeyCombo = { key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
    const pressUrl = window.location.href;
    void _hotkeyConfigPromise.then(() => {
      const hotkeyCommand = commandForCombo(combo);
      if (hotkeyCommand) startImport(hotkeyCommand, pressUrl);
    });
  }, true);
})();

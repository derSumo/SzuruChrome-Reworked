import { NeoScraper, ScrapeResults } from "neo-scraper";
import { BrowserCommand, HotkeyImportCommandData } from "~/models";
import { guessMimeTypeFromUrl } from "~/utils";
import { t, setLanguage, Language } from "~/i18n";

// Firefox `browser.tabs.executeScript()` requires scripts return a primitive value
(() => {
  // Read language from stored config
  async function initLanguage() {
    try {
      const storage = await browser.storage.local.get("config");
      let raw = storage?.config;
      if (!raw) return;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (raw?.value && typeof raw.value === "object") raw = raw.value;
      if (raw?.language) setLanguage(raw.language as Language);
    } catch { /* ignore */ }
  }
  initLanguage();
  function grabPost(): ScrapeResults {
    const scraper = new NeoScraper();
    return scraper.scrapeDocument(document, true);
  }

  // Fetch content from within the page context so cookies and session data are
  // included automatically. This bypasses CDN hotlink protection (e.g. rule34.xxx)
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
  function xhrFetchBinary(url: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = true;
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

  async function fetchContent(url: string): Promise<{ base64: string; mimeType: string }> {
    // Attempt 1: fetch with full-URL Referer (unsafe-url policy) but no credentials.
    // "unsafe-url" sends the complete page URL as Referer for cross-origin requests,
    // which satisfies CDN hotlink checks that verify the full path (not just origin).
    // Reject HTML responses — CDNs like Gelbooru return 200 OK + HTML error page
    // when the Referer is wrong, which must not be mistaken for the actual media.
    let res: Response | undefined;
    try {
      res = await fetch(url, { referrerPolicy: "unsafe-url" });
      if (!res.ok || isHtmlResponse(res)) res = undefined;
    } catch { res = undefined; }

    // Attempt 2: fetch with credentials + full-URL Referer.
    // Some CDNs (e.g. rule34.xxx in Brave/Chrome) require session cookies AND
    // the correct Referer. Including credentials sends the page's cookies so the
    // CDN can verify the request originates from an authenticated session.
    if (!res) {
      try {
        res = await fetch(url, { credentials: "include", referrerPolicy: "unsafe-url" });
        if (!res.ok || isHtmlResponse(res)) res = undefined;
      } catch { res = undefined; }
    }

    let buffer: ArrayBuffer;
    let rawMime: string;

    if (res) {
      buffer = await res.arrayBuffer();
      rawMime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
    } else {
      // Attempt 3: XHR with credentials (includes cookies + page Referer).
      // XHR bypasses CORS in Firefox content scripts with host_permissions,
      // handling CDNs like rule34.xxx and Gelbooru that lack CORS headers.
      const xhrResult = await xhrFetchBinary(url);
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
    iconEl: HTMLElement;
    textEl: HTMLElement;
    phase: "loading" | "done";
  }

  const toastMap = new Map<string, ToastItem>();

  function getOrCreateContainer(): HTMLElement {
    let c = document.getElementById(TC_ID);
    if (c) return c;

    c = document.createElement("div");
    c.id = TC_ID;
    c.style.cssText = "position:fixed;top:16px;right:16px;width:290px;display:flex;flex-direction:column;gap:7px;z-index:2147483647;pointer-events:none;";

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
      #${TC_ID} .st.success{border-color:rgba(52,199,89,.22)}
      #${TC_ID} .st.error{border-color:rgba(255,69,58,.22)}
      #${TC_ID} .st-prog{
        position:absolute;inset:0;transform-origin:left;transform:scaleX(0);z-index:0;
        transition:transform .38s cubic-bezier(.4,0,.2,1);
        background:linear-gradient(90deg,rgba(99,102,241,.22),rgba(168,85,247,.14));
      }
      #${TC_ID} .st-prog.shimmer{
        transform:scaleX(1);
        background:linear-gradient(90deg,transparent 0%,rgba(99,102,241,.2) 40%,rgba(168,85,247,.14) 60%,transparent 100%);
        background-size:250% 100%;
        animation:szuru-shim 1.9s ease-in-out infinite;
      }
      #${TC_ID} .st.success .st-prog{background:linear-gradient(90deg,rgba(52,199,89,.18),rgba(52,199,89,.08))}
      #${TC_ID} .st.error .st-prog{background:rgba(255,69,58,.14)}
      @keyframes szuru-shim{0%{background-position:250% 0}100%{background-position:-250% 0}}
      #${TC_ID} .st-body{position:relative;z-index:1;display:flex;align-items:center;gap:8px}
      #${TC_ID} .st-icon{flex-shrink:0;width:15px;height:15px;display:flex;align-items:center;justify-content:center}
      #${TC_ID} .st-spin{
        width:13px;height:13px;border:1.8px solid rgba(255,255,255,.2);
        border-top-color:rgba(255,255,255,.85);border-radius:50%;
        animation:szuru-spin .65s linear infinite;
      }
      @keyframes szuru-spin{to{transform:rotate(360deg)}}
      #${TC_ID} .st-text{flex:1;min-width:0;word-break:break-word}
      #${TC_ID} .st a{color:inherit;text-decoration:underline;text-underline-offset:2px}
    `;
    c.appendChild(style);
    document.documentElement.appendChild(c);
    return c;
  }

  function createToast(importId: string): ToastItem {
    const container = getOrCreateContainer();

    const el = document.createElement("div");
    el.className = "st";

    const progressEl = document.createElement("div");
    progressEl.className = "st-prog shimmer";

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
    el.appendChild(bodyEl);
    container.appendChild(el);

    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));

    const item: ToastItem = { el, progressEl, iconEl, textEl, phase: "loading" };
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

  function handleQuickImportStatus(data: any) {
    const importId: string = data.importId ?? "__legacy__";

    if (data.status === "running") {
      createToast(importId);
      return;
    }

    // For hotkey imports the toast is created locally before this point,
    // but guard anyway so progress/success/error always have a toast.
    if (!toastMap.has(importId)) createToast(importId);
    const item = toastMap.get(importId)!;

    if (data.status === "progress") {
      if (typeof data.progress === "number" && item.phase === "loading") {
        item.progressEl.classList.remove("shimmer");
        item.progressEl.style.transform = `scaleX(${Math.min(Math.max(data.progress, 0), 0.98)})`;
      }
      return;
    }

    // Terminal states
    item.phase = "done";
    item.progressEl.classList.remove("shimmer");
    item.progressEl.style.transition = "transform .22s ease-out";
    item.progressEl.style.transform = "scaleX(1)";

    if (data.status === "success") {
      item.el.classList.add("success");
      item.iconEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 6.5l3 3 5-5" stroke="rgba(52,199,89,.95)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      const link = data.postUrl ? `<a href="${data.postUrl}" target="_blank">Post #${data.postId}</a>` : "Post";
      item.textEl.innerHTML = data.alreadyUploaded
        ? t("toast.alreadyUploaded", { link })
        : t("toast.imported", { link });
      dismissToast(importId, 3800);
    } else if (data.status === "error") {
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
        return fetchContent(cmd.data.url);
      case "fetch_head_info":
        return fetchHeadInfo(cmd.data.url);
      case "quick_import_status":
        handleQuickImportStatus(cmd.data);
        return;
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // ── Restore toasts from background after page navigation ─────────
  // The background tracks all in-flight/recently-finished imports.
  // On each new page load we ask for the current state and recreate toasts,
  // so the user always sees what's happening even after navigating away.
  void (async () => {
    try {
      const imports: Array<{
        importId: string;
        status: string;
        progress?: number;
        postId?: number;
        postUrl?: string;
        alreadyUploaded?: boolean;
        message?: string;
      }> = await browser.runtime.sendMessage(new BrowserCommand("get_active_imports"));
      if (!Array.isArray(imports)) return;
      for (const item of imports) {
        if (!item.importId) continue;
        // Always create the toast first (shows as loading with shimmer)
        createToast(item.importId);
        if (item.status === "progress" && typeof item.progress === "number") {
          handleQuickImportStatus({ status: "progress", importId: item.importId, progress: item.progress });
        } else if (item.status === "success") {
          handleQuickImportStatus({ status: "success", importId: item.importId, postId: item.postId, postUrl: item.postUrl, alreadyUploaded: item.alreadyUploaded });
        } else if (item.status === "error") {
          handleQuickImportStatus({ status: "error", importId: item.importId, message: item.message });
        }
        // "running" → toast stays in shimmer/loading state, which is correct
      }
    } catch { /* ignore — content script may load before background is ready */ }
  })();

  // ── Hotkey quick-import ─────────────────────────────────
  type HotkeyConfig = { enabled: boolean; key: string; modifiers: string[] };
  type StoredHotkeyConfig = {
    hotkey?: HotkeyConfig;
    hotkeyLinkLast?: HotkeyConfig;
  };

  async function getHotkeyConfig(): Promise<StoredHotkeyConfig | undefined> {
    try {
      const storage = await browser.storage.local.get("config");
      let raw = storage?.config;
      if (!raw) return undefined;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (raw?.value && typeof raw.value === "object") raw = raw.value;
      return {
        hotkey: raw?.hotkey as HotkeyConfig | undefined,
        hotkeyLinkLast: raw?.hotkeyLinkLast as HotkeyConfig | undefined,
      };
    } catch {
      return undefined;
    }
  }

  function matchesHotkey(e: KeyboardEvent, hk: HotkeyConfig | undefined) {
    if (!hk?.enabled || !hk.key) return false;
    if (e.key.toLowerCase() !== hk.key.toLowerCase()) return false;

    const wantCtrl = hk.modifiers.includes("ctrl");
    const wantAlt = hk.modifiers.includes("alt");
    const wantShift = hk.modifiers.includes("shift");
    return e.ctrlKey === wantCtrl && e.altKey === wantAlt && e.shiftKey === wantShift;
  }

  // Cache the config and refresh on storage changes.
  let _hotkeyConfig: StoredHotkeyConfig | undefined;
  getHotkeyConfig().then((c) => (_hotkeyConfig = c));
  browser.storage.onChanged.addListener((changes) => {
    if (changes.config) {
      getHotkeyConfig().then((c) => (_hotkeyConfig = c));
    }
  });

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    const hotkeyCommand =
      matchesHotkey(e, _hotkeyConfig?.hotkeyLinkLast)
        ? "hotkey_import_link_last"
        : matchesHotkey(e, _hotkeyConfig?.hotkey)
          ? "hotkey_import"
          : undefined;
    if (!hotkeyCommand) return;

    // Don't fire inside input/textarea/contenteditable
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if ((e.target as HTMLElement)?.isContentEditable) return;

    e.preventDefault();
    e.stopPropagation();

    const importId = crypto.randomUUID();
    // Create the toast immediately so the user gets instant feedback
    handleQuickImportStatus({ status: "running", importId });

    browser.runtime.sendMessage(
      new BrowserCommand(hotkeyCommand, new HotkeyImportCommandData(window.location.href, hotkeyCommand === "hotkey_import_link_last", importId)),
    ).catch((ex: any) => {
      handleQuickImportStatus({ status: "error", message: ex?.message ?? String(ex), importId });
    });
  }, true);
})();

import { NeoScraper, ScrapeResults } from "neo-scraper";
import { BrowserCommand } from "~/models";
import { guessMimeTypeFromUrl } from "~/utils";

// Firefox `browser.tabs.executeScript()` requires scripts return a primitive value
(() => {
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
  async function fetchContent(url: string): Promise<{ base64: string; mimeType: string }> {
    // Attempt 1: simple fetch without credentials – only needs
    // Access-Control-Allow-Origin: * from our injected CORS rule.
    // The page-origin Referer is still sent, satisfying most CDN hotlink checks.
    let res: Response | undefined;
    try {
      res = await fetch(url);
      if (!res.ok) res = undefined;
    } catch { res = undefined; }

    // Attempt 2: fetch with credentials (stricter CORS but includes cookies for
    // CDNs that require them, e.g. rule34.xxx).
    if (!res) {
      res = await fetch(url, {
        credentials: "include",
        referrerPolicy: "unsafe-url",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error("Empty response body");
    const rawMime = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
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

  // ── Quick-import in-page status UI ──────────────────────────────
  const STATUS_HOST_ID = "szuru-quick-import-status-host";

  function getOrCreateStatusHost(): HTMLElement {
    let host = document.getElementById(STATUS_HOST_ID);
    if (host) return host;
    host = document.createElement("div");
    host.id = STATUS_HOST_ID;
    host.style.cssText = "position:fixed;top:0;left:0;width:100%;z-index:2147483647;pointer-events:none;";
    document.documentElement.appendChild(host);

    const style = document.createElement("style");
    style.textContent = `
      #${STATUS_HOST_ID} .szuru-bar{position:fixed;top:0;left:0;width:100%;height:4px;z-index:2147483647;pointer-events:none}
      #${STATUS_HOST_ID} .szuru-bar-inner{width:100%;height:100%;background:linear-gradient(90deg,#6366f1,#a855f7);transform-origin:left;will-change:transform,opacity;transition:none}
      #${STATUS_HOST_ID} .szuru-bar-inner.animated{transition:transform .4s cubic-bezier(0.4,0,0.2,1)}
      #${STATUS_HOST_ID} .szuru-bar-inner.finishing{transition:transform .25s ease-out,opacity .4s .15s ease-out}
      #${STATUS_HOST_ID} .szuru-toast{pointer-events:auto;position:fixed;top:16px;right:16px;padding:12px 20px;border-radius:16px;color:rgba(255,255,255,.95);font:600 13.5px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",sans-serif;letter-spacing:-0.01em;opacity:0;transform:translateY(-12px) scale(0.96);transition:opacity .35s cubic-bezier(0.16,1,0.3,1),transform .35s cubic-bezier(0.16,1,0.3,1);z-index:2147483647;max-width:400px;word-break:break-word;-webkit-backdrop-filter:saturate(180%) blur(40px);backdrop-filter:saturate(180%) blur(40px);background:rgba(45,45,48,.55);border:0.5px solid rgba(255,255,255,.18);box-shadow:0 8px 32px rgba(0,0,0,.18),0 1.5px 4px rgba(0,0,0,.12),inset 0 0.5px 0 rgba(255,255,255,.12)}
      #${STATUS_HOST_ID} .szuru-toast.show{opacity:1;transform:translateY(0) scale(1)}
      #${STATUS_HOST_ID} .szuru-toast.success{background:rgba(30,120,60,.45);border-color:rgba(52,199,89,.3)}
      #${STATUS_HOST_ID} .szuru-toast.error{background:rgba(160,30,30,.45);border-color:rgba(255,69,58,.3)}
      #${STATUS_HOST_ID} .szuru-toast a{color:rgba(255,255,255,.95);text-decoration:underline;text-underline-offset:2px}
    `;
    host.appendChild(style);
    return host;
  }

  let _hasRealProgress = false;

  function showProgressBar() {
    _hasRealProgress = false;
    const host = getOrCreateStatusHost();
    // Remove any existing bar (e.g. from a previous import)
    host.querySelector(".szuru-bar")?.remove();

    const bar = document.createElement("div");
    bar.className = "szuru-bar";
    const inner = document.createElement("div");
    inner.className = "szuru-bar-inner";
    inner.style.transform = "scaleX(0)";
    inner.style.opacity = "1";
    bar.appendChild(inner);
    host.appendChild(bar);

    // Initial quick jump to 5%, then slow crawl as fallback if no real progress arrives
    requestAnimationFrame(() => {
      inner.style.transition = "transform .3s ease-out";
      inner.style.transform = "scaleX(0.05)";
    });
  }

  function updateProgressBar(progress: number) {
    const host = document.getElementById(STATUS_HOST_ID);
    const inner = host?.querySelector(".szuru-bar-inner") as HTMLElement | null;
    if (!inner) return;
    _hasRealProgress = true;
    inner.classList.add("animated");
    inner.classList.remove("finishing");
    // Clamp to [0, 0.98] so we never visually "complete" before the success message
    const clamped = Math.min(Math.max(progress, 0), 0.98);
    inner.style.transform = `scaleX(${clamped})`;
  }

  function hideProgressBar() {
    const host = document.getElementById(STATUS_HOST_ID);
    const inner = host?.querySelector(".szuru-bar-inner") as HTMLElement | null;
    if (!inner) {
      host?.querySelector(".szuru-bar")?.remove();
      return;
    }
    // Snap to 100% and fade out, then remove
    inner.classList.remove("animated");
    void inner.offsetWidth;
    inner.classList.add("finishing");
    inner.style.transform = "scaleX(1)";
    inner.style.opacity = "0";
    setTimeout(() => host?.querySelector(".szuru-bar")?.remove(), 600);
  }

  function showToast(type: "success" | "error", html: string, duration = 4000) {
    const host = getOrCreateStatusHost();
    const toast = document.createElement("div");
    toast.className = `szuru-toast ${type}`;
    toast.innerHTML = html;
    host.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 350);
    }, duration);
  }

  function handleQuickImportStatus(data: any) {
    if (data.status === "running") {
      showProgressBar();
    } else if (data.status === "progress") {
      if (typeof data.progress === "number") updateProgressBar(data.progress);
    } else if (data.status === "success") {
      hideProgressBar();
      const link = data.postUrl ? `<a href="${data.postUrl}" target="_blank">Post #${data.postId}</a>` : "Post";
      showToast("success", `✔ ${link} imported successfully`);
    } else if (data.status === "error") {
      hideProgressBar();
      showToast("error", `✘ Import failed: ${data.message ?? "Unknown error"}`, 6000);
    }
  }

  async function messageHandler(cmd: BrowserCommand): Promise<any> {
    switch (cmd.name) {
      case "grab_post":
        return grabPost();
      case "fetch_content":
        return fetchContent(cmd.data.url);
      case "quick_import_status":
        handleQuickImportStatus(cmd.data);
        return;
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // ── Hotkey quick-import ─────────────────────────────────
  type HotkeyConfig = { enabled: boolean; key: string; modifiers: string[] };

  async function getHotkeyConfig(): Promise<HotkeyConfig | undefined> {
    try {
      const storage = await browser.storage.local.get("config");
      let raw = storage?.config;
      if (!raw) return undefined;
      if (typeof raw === "string") raw = JSON.parse(raw);
      if (raw?.value && typeof raw.value === "object") raw = raw.value;
      return raw?.hotkey as HotkeyConfig | undefined;
    } catch {
      return undefined;
    }
  }

  // Cache the config and refresh on storage changes.
  let _hotkeyConfig: HotkeyConfig | undefined;
  getHotkeyConfig().then((c) => (_hotkeyConfig = c));
  browser.storage.onChanged.addListener((changes) => {
    if (changes.config) {
      getHotkeyConfig().then((c) => (_hotkeyConfig = c));
    }
  });

  let _hotkeyImporting = false;

  document.addEventListener("keydown", async (e: KeyboardEvent) => {
    const hk = _hotkeyConfig;
    if (!hk?.enabled || !hk.key) return;

    // Don't fire inside input/textarea/contenteditable
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if ((e.target as HTMLElement)?.isContentEditable) return;

    // Match key
    if (e.key.toLowerCase() !== hk.key.toLowerCase()) return;

    // Match modifiers
    const wantCtrl = hk.modifiers.includes("ctrl");
    const wantAlt = hk.modifiers.includes("alt");
    const wantShift = hk.modifiers.includes("shift");
    if (e.ctrlKey !== wantCtrl || e.altKey !== wantAlt || e.shiftKey !== wantShift) return;

    e.preventDefault();
    e.stopPropagation();

    if (_hotkeyImporting) return;
    _hotkeyImporting = true;

    try {
      handleQuickImportStatus({ status: "running" });
      // Send a message to the background script to trigger the import.
      // We reuse the context menu import path by sending a special command.
      await browser.runtime.sendMessage(
        new BrowserCommand("hotkey_import" as any, { url: window.location.href }),
      );
    } catch (ex: any) {
      handleQuickImportStatus({ status: "error", message: ex?.message ?? String(ex) });
    } finally {
      _hotkeyImporting = false;
    }
  }, true);
})();

// ── Loading a post page out of sight ──────────────────────────────────
// neo-scraper's engines read `document.location` inside `scrapeDocument`, so a
// DOMParser document (location === null) crashes them: the only correct way to
// scrape an arbitrary URL is to load it in a real tab. Both the batch runner
// and the per-thumbnail import buttons need that, so it lives here.
//
// The tab can go into a window of its own — see BatchWindow — which is what
// keeps a 500-post batch from burying whatever the user was doing.

import { getErrorMessage } from "~/utils";

const TAB_LOAD_TIMEOUT_MS = 30_000;

export function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      fn();
    };

    const onUpdated = (updatedTabId: number, changeInfo: any) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve);
      }
    };

    const timer = setTimeout(() => finish(() => reject(new Error("Tab load timed out"))), TAB_LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);

    // The tab may already be "complete" (e.g. served from cache) before the
    // listener attached — check once up front.
    browser.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(resolve);
    }).catch(() => { /* handled by timeout */ });
  });
}

/**
 * The window scrape tabs are driven in.
 *
 * Opening every post in the user's own window buries whatever they were doing
 * under a stream of tabs. One separate, unfocused window keeps the work out of
 * the way and can be closed in a single step when it's finished. It is created
 * lazily (so a batch that skips everything opens nothing) and re-created if the
 * user closes it mid-run.
 *
 * Reference-counted: a hover import that starts while a batch is running shares
 * the window, and whichever finishes first must not close it on the other.
 */
class BatchWindow {
  private windowId: number | undefined;
  private creating: Promise<number | undefined> | undefined;
  private users = 0;
  private enabled = false;

  /** Register a user of the window. */
  acquire(enabled: boolean): void {
    this.users++;
    // Anyone who wants a separate window is enough to justify one.
    if (enabled) this.enabled = true;
  }

  /** Window to put the next tab in, or undefined for "the current one". */
  async targetWindowId(): Promise<number | undefined> {
    if (!this.enabled) return undefined;
    if (typeof this.windowId === "number") {
      // Still there? The user may have closed it while the batch ran.
      try {
        await browser.windows.get(this.windowId);
        return this.windowId;
      } catch {
        this.windowId = undefined;
      }
    }
    // Concurrent callers must not each open their own window.
    this.creating ??= this.create().finally(() => { this.creating = undefined; });
    return this.creating;
  }

  private async create(): Promise<number | undefined> {
    try {
      // The about:blank tab is a placeholder that outlives every post tab:
      // without it the window would close itself the moment the last import
      // finished and its tab was removed.
      const previous = await browser.windows.getLastFocused().catch(() => undefined);
      const win = await browser.windows.create({ url: "about:blank", focused: false });
      this.windowId = win.id;
      // Firefox ignores `focused: false` and pops the new window to the front.
      // Hand focus straight back so this never steals the user's place.
      if (typeof previous?.id === "number" && previous.id !== win.id) {
        await browser.windows.update(previous.id, { focused: true }).catch(() => { /* best effort */ });
      }
      return win.id;
    } catch (ex) {
      // No window API access (or the browser refused) — fall back to tabs in
      // the current window rather than failing the import.
      console.warn("[scrape] could not open a separate window, using the current one:", getErrorMessage(ex));
      return undefined;
    }
  }

  /** Drop a claim; the window closes once the last user is done. */
  async release(): Promise<void> {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;

    this.enabled = false;
    if (typeof this.windowId !== "number") return;
    const id = this.windowId;
    this.windowId = undefined;
    await browser.windows.remove(id).catch(() => { /* already gone */ });
  }
}

export const batchWindow = new BatchWindow();

export interface ScrapeTab {
  tabId: number;
  /** Close the tab. Call only after the in-tab CDN fetch is finished. */
  close: () => Promise<void>;
}

/**
 * Open `url` in a background tab and wait for it to finish loading.
 * `separateWindow` puts it in the shared out-of-the-way window.
 */
export async function openScrapeTab(url: string, separateWindow = false): Promise<ScrapeTab> {
  batchWindow.acquire(separateWindow);
  let tabId: number | undefined;
  try {
    const windowId = await batchWindow.targetWindowId();
    const tab = await browser.tabs.create({ url, active: false, ...(windowId ? { windowId } : {}) });
    tabId = tab.id;
    if (typeof tabId !== "number") throw new Error("Could not open tab");
    await waitForTabComplete(tabId);

    const id = tabId;
    let closed = false;
    return {
      tabId: id,
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.tabs.remove(id).catch(() => { /* already gone */ });
        await batchWindow.release();
      },
    };
  } catch (ex) {
    if (typeof tabId === "number") await browser.tabs.remove(tabId).catch(() => { });
    await batchWindow.release();
    throw ex;
  }
}

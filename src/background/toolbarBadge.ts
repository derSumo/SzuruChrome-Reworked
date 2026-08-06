// ── Toolbar badge ───────────────────────────────────────────────────────
// The global badge shows active + queued imports. A tab-specific check mark
// wins on pages whose source is already in the configured instance.

import { getActiveQueueTask, importQueue } from "./state";

function action() {
  return (browser as any).action as {
    setBadgeText?: (details: { text: string; tabId?: number }) => Promise<void>;
    setBadgeBackgroundColor?: (details: { color: string; tabId?: number }) => Promise<void>;
    setTitle?: (details: { title: string; tabId?: number }) => Promise<void>;
  };
}

function queueSize(): number {
  return importQueue.length + (getActiveQueueTask() ? 1 : 0);
}

/** Refresh the global queue count after every queue state transition. */
export function refreshQueueBadge(): void {
  const count = queueSize();
  const text = count === 0 ? "" : count > 999 ? "999+" : String(count);
  const api = action();
  void api.setBadgeText?.({ text });
  void api.setBadgeBackgroundColor?.({ color: "#5b4bdb" });
  void api.setTitle?.({ title: count === 0 ? "SzuruChrome" : `SzuruChrome — ${count} import${count === 1 ? "" : "s"} queued` });
}

/** Mark the current tab when its source already exists in the instance. */
export function setImportedTabBadge(tabId: number, imported: boolean): void {
  const api = action();
  void api.setBadgeText?.({ tabId, text: imported ? "✓" : "" });
  if (imported) {
    void api.setBadgeBackgroundColor?.({ tabId, color: "#198754" });
    void api.setTitle?.({ tabId, title: "SzuruChrome — already imported" });
  } else {
    void api.setTitle?.({ tabId, title: "SzuruChrome" });
  }
}

/** A navigation invalidates the previous page's import check mark. */
export function installToolbarBadgeListeners(): void {
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") setImportedTabBadge(tabId, false);
  });
  browser.tabs.onRemoved.addListener((tabId) => setImportedTabBadge(tabId, false));
}

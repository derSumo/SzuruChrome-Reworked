// ── Tab messaging with content-script self-healing ────────────────────
// The content script is declared in the manifest, but a tab that was already
// open when the extension updated (or a page still settling after navigation)
// may have no live listener. Every caller that talks to a tab therefore needs
// the same "send → detect missing receiver → inject → send again" dance;
// it lives here instead of in the background, popup and utils separately.

import { BrowserCommand, type BrowserCommandName } from "~/models";
import { getErrorMessage } from "~/utils";

const CONTENT_SCRIPT_FILE = "dist/contentScripts/index.global.js";

/** True when a sendMessage rejection means "no content script in that tab". */
export function isMissingContentScriptError(ex: unknown): boolean {
  const msg = getErrorMessage(ex).toLowerCase();
  return msg.includes("receiving end does not exist")
    || msg.includes("could not establish connection")
    || msg.includes("no matching message handler");
}

/** Pages where no extension may run — injecting there always throws. */
export function isRestrictedTabUrl(url?: string): boolean {
  if (!url) return false;
  const x = url.toLowerCase();
  return x.startsWith("chrome://") || x.startsWith("edge://") || x.startsWith("about:");
}

/** Inject the content script, preferring MV3 `scripting` over the MV2 API. */
export async function ensureContentScriptLoaded(tabId: number): Promise<void> {
  const scripting = (browser as any).scripting;
  if (scripting?.executeScript) {
    await scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
    return;
  }

  // Firefox fallback (MV2 API)
  await browser.tabs.executeScript(tabId, { file: "./" + CONTENT_SCRIPT_FILE });
}

/**
 * Send a command to a tab, injecting the content script once and retrying if
 * the tab had no listener yet. Any other error propagates unchanged.
 */
export async function sendTabCommand<TResult = any>(
  tabId: number,
  name: BrowserCommandName,
  data?: unknown,
): Promise<TResult> {
  const command = new BrowserCommand(name, data);
  try {
    return await browser.tabs.sendMessage(tabId, command);
  } catch (ex) {
    if (!isMissingContentScriptError(ex)) throw ex;
    await ensureContentScriptLoaded(tabId);
    return await browser.tabs.sendMessage(tabId, command);
  }
}

/** The active tab of the focused window, or undefined when there is none. */
export async function getActiveTab() {
  const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
  return activeTabs[0];
}

/** Id of the active tab, or undefined when there is none. */
export async function getActiveTabId(): Promise<number | undefined> {
  return (await getActiveTab())?.id;
}

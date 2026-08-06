// ── Dynamic content-script registration ─────────────────────────────────
//
// Keeping this registration in the worker (rather than `content_scripts` in
// manifest.json) is what keeps neo-scraper off unrelated pages. A registration
// is created only for origins the user explicitly enabled in Options.

import { getGrantedSourceSiteMatchPatterns } from "~/shared/sourceSites";

export const CONTENT_SCRIPT_ID = "szuru-supported-sources";
export const CONTENT_SCRIPT_FILE = "dist/contentScripts/index.global.js";

function getScripting() {
  return (browser as any).scripting as {
    getRegisteredContentScripts?: (filter?: { ids?: string[] }) => Promise<Array<{ id: string }>>;
    registerContentScripts?: (scripts: Array<Record<string, unknown>>) => Promise<void>;
    updateContentScripts?: (scripts: Array<Record<string, unknown>>) => Promise<void>;
    unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
  };
}

/** Reconcile Chrome/Firefox's persistent dynamic registration with current grants. */
export async function syncContentScriptRegistration(): Promise<void> {
  const scripting = getScripting();
  if (!scripting?.registerContentScripts || !scripting?.getRegisteredContentScripts) return;

  const matches = await getGrantedSourceSiteMatchPatterns();
  const existing = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });

  if (matches.length === 0) {
    if (existing.length > 0) {
      await scripting.unregisterContentScripts?.({ ids: [CONTENT_SCRIPT_ID] });
    }
    return;
  }

  const script = {
    id: CONTENT_SCRIPT_ID,
    matches,
    js: [CONTENT_SCRIPT_FILE],
    runAt: "document_idle",
    persistAcrossSessions: true,
  };

  if (existing.length > 0 && scripting.updateContentScripts) {
    await scripting.updateContentScripts([script]);
  } else if (existing.length === 0) {
    await scripting.registerContentScripts([script]);
  }
}

/** Keep registrations in lockstep when the user enables or revokes a site. */
export function installContentScriptPermissionSync(): void {
  browser.permissions.onAdded.addListener(() => void syncContentScriptRegistration().catch(logRegistrationError));
  browser.permissions.onRemoved.addListener(() => void syncContentScriptRegistration().catch(logRegistrationError));
}

function logRegistrationError(ex: unknown): void {
  console.error("Failed to update content-script registration:", ex);
}

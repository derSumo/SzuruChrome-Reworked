// ── Quick-import status broadcasting ──────────────────────────────────
// Every state change of a queued import is pushed to the tab it belongs to
// (which renders the toast) *and* recorded in `activeImports`, so a content
// script that loads on the next page can restore what is still in flight.

import { BrowserCommand } from "~/models";
import { sendTabCommand } from "~/shared/tabs";
import {
  activeImports,
  getActiveQueueTask,
  importQueue,
  persistState,
  scheduleErrorCleanup,
  scheduleSuccessfulImportCleanup,
} from "./state";
import type { ActiveImportEntry } from "./sessionState";

export type QuickImportStatus = "running" | "success" | "error" | "progress" | "heartbeat";

export interface QuickImportStatusData {
  message?: string;
  postId?: number;
  postUrl?: string;
  progress?: number;
  speedBytesPerSecond?: number;
  totalBytes?: number;
  elapsedSeconds?: number;
  alreadyUploaded?: boolean;
  linkedPostIds?: number[];
  duplicateOutcome?: "replaced" | "tags_merged";
  importId?: string;
  queued?: boolean;
}

/** Fold a status update into the restorable `activeImports` entry. */
function recordActiveImport(importId: string, tabId: number | undefined, status: QuickImportStatus, data: QuickImportStatusData) {
  const { progress, speedBytesPerSecond, totalBytes, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome, message, queued } = data;

  switch (status) {
    case "running": {
      const prev = activeImports.get(importId);
      activeImports.set(importId, { tabId, status: "running", queued: queued ?? prev?.queued });
      break;
    }
    case "progress": {
      const entry = activeImports.get(importId);
      if (!entry) {
        activeImports.set(importId, {
          tabId,
          status: "progress",
          progress,
          speedBytesPerSecond,
          lastDownloadSpeedBytesPerSecond: speedBytesPerSecond,
          totalBytes,
        });
        break;
      }
      entry.progress = progress;
      entry.speedBytesPerSecond = speedBytesPerSecond;
      if (typeof totalBytes === "number" && totalBytes > 0) entry.totalBytes = totalBytes;
      if (typeof speedBytesPerSecond === "number" && speedBytesPerSecond > 0) {
        entry.lastDownloadSpeedBytesPerSecond = speedBytesPerSecond;
      }
      entry.queued = false;
      break;
    }
    case "success":
      activeImports.set(importId, {
        tabId, status, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome,
        completedAt: Date.now(), message,
      });
      scheduleSuccessfulImportCleanup();
      break;
    case "error":
      activeImports.set(importId, { tabId, status, postId, postUrl, alreadyUploaded, linkedPostIds, duplicateOutcome, message });
      scheduleErrorCleanup(importId);
      break;
    default:
      // "heartbeat" carries no state the restore path needs.
      return;
  }

  persistState();
}

/**
 * Push a status update to the originating tab. Retries triggered from the
 * options page have no tab; their result surfaces in the statistics tab
 * instead of a toast.
 */
export function sendQuickImportStatus(
  tabId: number | undefined,
  status: QuickImportStatus,
  data: QuickImportStatusData = {},
): Promise<void> {
  const { importId, totalBytes } = data;

  if (importId) recordActiveImport(importId, tabId, status, data);

  const entry = importId ? activeImports.get(importId) : undefined;
  const payload = new BrowserCommand("quick_import_status", {
    status,
    ...data,
    completedAt: entry?.completedAt,
    lastDownloadSpeedBytesPerSecond: entry?.lastDownloadSpeedBytesPerSecond,
    totalBytes: totalBytes ?? entry?.totalBytes,
  });

  if (typeof tabId !== "number") return Promise.resolve();

  // Status feedback is best-effort; never let it break the import flow.
  return sendTabCommand(tabId, payload.name, payload.data).then(() => undefined, () => undefined);
}

/**
 * Everything a freshly-loaded content script in `tabId` should re-render.
 *
 * Successful imports rebuild the compact history menu after a page change.
 * Errors remain transient and should not reappear on a later page just because
 * they are still inside the short retention window.
 */
export function collectActiveImportsForTab(tabId: number): Array<ActiveImportEntry & { importId: string }> {
  const result: Array<ActiveImportEntry & { importId: string }> = [];
  const seen = new Set<string>();

  for (const [importId, entry] of activeImports) {
    if (entry.tabId !== tabId || entry.status === "error") continue;
    result.push({ importId, ...entry });
    seen.add(importId);
  }

  // The queue itself is the source of truth for work that still exists. Include
  // it as well so a content script loaded during a rapid navigation never
  // briefly sees only the active task because one of the earlier queued status
  // broadcasts was missed.
  const activeTask = getActiveQueueTask();
  if (activeTask?.tabId === tabId && !seen.has(activeTask.importId)) {
    result.push({ importId: activeTask.importId, tabId, status: "running", queued: false });
    seen.add(activeTask.importId);
  }
  for (const task of importQueue) {
    if (task.tabId !== tabId || seen.has(task.importId)) continue;
    result.push({ importId: task.importId, tabId, status: "running", queued: true });
    seen.add(task.importId);
  }

  return result;
}

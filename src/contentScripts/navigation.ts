// ── Navigation detection ──────────────────────────────────────────────
// Booru pages navigate in three different ways and every feature here needs to
// know about all of them, so detection is centralised instead of each feature
// attaching its own listeners and its own poll.
//
//  · pageshow / popstate / hashchange are browser-fired window events that
//    reach the content script's isolated world, covering full loads and
//    back/forward/hash jumps instantly and for free.
//  · Danbooru-style pjax navigates via history.pushState in the page's *main*
//    world, which a content script can't hook and which emits no event. A
//    low-frequency poll is the reliable catch-all for that one case.

const POLL_INTERVAL_MS = 2000;

type Listener = () => void;

const navigationListeners = new Set<Listener>();
const bfcacheListeners = new Set<Listener>();

let installed = false;
let lastPolledUrl = "";

function notifyNavigation() {
  for (const listener of navigationListeners) listener();
}

function install() {
  if (installed) return;
  installed = true;
  lastPolledUrl = window.location.href;

  window.addEventListener("pageshow", (event) => {
    notifyNavigation();
    if ((event as PageTransitionEvent).persisted) {
      for (const listener of bfcacheListeners) listener();
    }
  });
  window.addEventListener("popstate", notifyNavigation);
  window.addEventListener("hashchange", notifyNavigation);

  setInterval(() => {
    if (window.location.href === lastPolledUrl) return;
    lastPolledUrl = window.location.href;
    notifyNavigation();
  }, POLL_INTERVAL_MS);
}

/** Run `listener` on every navigation, including in-page history changes. */
export function onNavigation(listener: Listener): void {
  navigationListeners.add(listener);
  install();
}

/** Run `listener` when the page is restored from the back/forward cache. */
export function onBfcacheRestore(listener: Listener): void {
  bfcacheListeners.add(listener);
  install();
}

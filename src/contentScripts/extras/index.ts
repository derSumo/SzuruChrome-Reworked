// ── On-demand listing extras ──────────────────────────────────────────
// A second, separate content-script bundle holding the two features that are
// off by default: the hover zoom preview and endless scroll.
//
// Why a separate bundle rather than a dynamic import: the main content script
// is built as an IIFE (MV3 content scripts cannot be ES modules), and an IIFE
// build cannot code-split — an `import()` would simply be inlined back into the
// one file. So these ship as their own IIFE, and the main script asks the
// background to inject it into the tab when the config says a feature is on.
//
// Consequence to keep in mind: this runs in the same isolated world but its own
// module scope. It shares nothing with the main bundle at runtime, which is why
// both features do their own hover/navigation detection instead of hooking into
// the main script's.

import { installEndlessScroll } from "./endlessScroll";
import { installHoverZoom } from "./hoverZoom";

(() => {
  // The main script may ask for injection more than once (config changes, a
  // second listing in the same tab). Keep the first instance as the owner.
  const flag = "__szuruListingExtrasInitialized__";
  const pageGlobal = globalThis as typeof globalThis & Record<string, boolean | undefined>;
  if (pageGlobal[flag]) return;
  pageGlobal[flag] = true;

  installHoverZoom();
  installEndlessScroll();
})();

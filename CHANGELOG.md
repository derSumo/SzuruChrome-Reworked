# Changelog

## [3.0.3] – August 2026

### Changed

- Thumbnail import buttons are available directly on hover again. The Ctrl-gated enlarged preview is more compact, follows the cursor, and fades in smoothly.

## [3.0.2] – August 2026

### Changed

- Hover tools now require holding **Ctrl**: this applies to both the thumbnail import buttons and the enlarged preview. Import buttons remain clickable after they are revealed.

## [3.0.1] – August 2026

### Changed
- **More transparent listing progress** — Endless scroll prefetches smoothly, reports its active/loading/completed state, and explicitly says when its 40-page safety cap was reached. Batch rows show failed items as they happen instead of only in the final summary.

### Fixed
- **Endless-scroll continuation** — When the observer fired while a page was still loading, it could remain in view without firing again afterwards. The loader now re-checks its actual position after every completed page.
- **Live thumbnail states** — A successful batch immediately marks its matching thumbnail as imported. Stale badge spinners from a navigation or refresh are cleared and queried again instead of staying stuck forever.
- **Thumbnail action buttons** — The import and import-and-link buttons now receive their own click event and are ignored by the batch selection handler.

---

## [3.0.0] – August 2026

### Added
- **Import buttons on every thumbnail** — Hovering a thumbnail on a listing page shows two buttons: import this post, or import it and link it to the previous import as a relation (the link-chain the "import + link last" shortcut builds). The post is loaded, scraped and uploaded in the background; the listing stays where it is and the usual import toast reports the result.
- **Range selection** — Shift-click selects everything between the last plain click and the new one, the way a file manager does; Ctrl/Cmd-click picks a single thumbnail without moving that anchor. Picking 40 posts is two clicks.
- **Endless scroll (opt-in)** — Appends the next listing page as you approach the bottom instead of making you click through the pagination. Selection, "already imported" marks and hover buttons keep working on the appended posts, because it is still the same document.
- **Hover zoom (opt-in)** — Enlarges the image under the cursor, reading the full-size file from the post page's own markup (og:image, data-file-url, …) so the preview is sharp rather than an upscaled 150px thumbnail. Restricted to a site whitelist by default, or "all supported sites". The preview opens beside the thumbnail, never on top of it, and is click-through so it can't swallow a hover.
- **Hover zoom and endless scroll load on demand** — Both ship as a second content-script bundle (30 kB) that the background injects into a tab only once one of them is switched on. Pages of users who leave them off never parse a byte of either.

### Changed
- **Redesigned batch dock** — Rebuilt around a flat inline-SVG icon set: a header with a live count, an action row, labelled search and pool fields, and per-run rows showing imported / skipped / failed separately plus a rough time remaining. Progress bars have a running sheen, panels rise in, selections pop, and every animation is dropped under `prefers-reduced-motion`.
- **"Stop" is now "Stop scanning"** — The old label read as "stop selecting", which is exactly what it did not do: everything the scan found stays selected. The button now also carries a stop icon and an amber state while the scan runs.

### Fixed
- **The thumbnail import buttons stay reachable** — They used to be re-parented onto the zoom preview, which is click-through by design, so they inherited that and stopped responding; and they vanished the moment the pointer left the thumbnail, which made them impossible to reach in the first place. They now stay anchored to the thumbnail, remain visible until another thumbnail is hovered or you click elsewhere, and only dim while the pointer is away.
- **A batch survives a service-worker teardown** — The queue, its options and the results so far are mirrored into session storage and picked back up on the next worker start; anything that was mid-flight is simply queued again, which is safe because a post that did make it through is recognised as already imported. Opening a listing while a batch runs now also re-attaches its progress row instead of showing nothing until the next post finishes.

---

## [2.9.0] – August 2026

### Added
- **Start a new batch while one is running** — The progress panel no longer replaces the picker. Everything lives in one bottom-left dock: running imports sit above, the launcher or open picker below, so the next selection can be put together while the previous batch is still working.
- **One growing queue instead of rival batches** — Importing again while a batch runs appends to that batch rather than starting a competing one, so the counter reads `12/84` instead of four rows each claiming `3/42`. URLs the batch has already queued are dropped on the way in, which makes a double click or an overlapping selection a no-op; the row says how many were added and how many were already there. Only a different pool name starts a separate batch, and that one waits its turn instead of running alongside.
- **Selection survives paging** — The batch selection is no longer bound to one document. It lives per site in the background, so picking a few posts, going to the next page and picking more builds a single list; the picker re-opens by itself on the next listing with everything still selected. The counter says how many of the picks are on the current page, and a "Clear" button empties the basket. Two tabs on the same site merge their picks instead of overwriting each other.
- **"Already imported" marks on listing thumbnails** — Every thumbnail whose post is already in the instance gets a check mark. Only thumbnails that scroll into view are looked up, and a screenful costs a single bulk `source:` query instead of one request per post. While a lookup is out the thumbnail shows a small spinner, so a slow instance reads as "still checking" rather than "none of these are imported"; the spinner only fades in after ~350 ms, so a fast answer never flashes one.
- **Batch skips posts you already have** — Selected posts that are already in the instance are recognised before anything happens: no tab is opened, no page is loaded, no upload is attempted. Re-running a batch over a half-imported listing is now nearly instant. The progress panel reports how many were skipped.
- **Batch runs in its own window** — The batch opens one separate, unfocused browser window, drives all its tabs there and closes it when finished, so the user's window stays clean. Falls back to background tabs in the current window if the window can't be created, and can be turned off in Settings.

### Fixed
- **Duplicate replacement now picks the genuinely better file** — The comparison used the scraped resolution, which most engines never report; a missing value counted as "0 pixels" and lost against every existing post, so an obviously larger re-import was silently discarded. The pixel size is now measured from the downloaded bytes, and an unknown resolution falls back to file size instead of losing outright.

---

## [2.8.0] – August 2026

### Added
- **One-click select all** — The batch launcher gained a second "All" button that opens the picker with every post on the page already selected. Inside the picker, "All" now toggles between selecting and clearing the whole page.
- **"All pages" crawl** — A new button follows the listing's pagination, collects every post it links to and adds them all to the selection, with a live page/found counter and a stop button. Pages are fetched from the content script with the user's own session, so login-gated or filtered listings return exactly what the user sees; parsing happens in an inert document, so no thumbnail is downloaded.
- **Import everything from one user or tag** — A search box in the batch toolbar re-points the crawl at any query (`user:name`, an artist tag, …). The search URL is derived from the listing the user is on, so it works on every supported booru without per-site code.
- **Crawl limits** — Settings → General caps a crawl at 500 posts across 20 pages by default, so a single click on a broad search cannot queue thousands of imports.

---

## [2.7.0] – July 2026

### Added
- **Batch import from listing pages** — A "Batch import" launcher on booru listing and gallery pages: select any number of posts and import them all. Each is opened in a background tab, scraped, uploaded and closed, with a live progress bar.
- **Pool import** — A pool name entered before starting a batch adds every imported post to that szurubooru pool in selection order, creating the pool when it does not exist.

---

## [2.6.0] – July 2026

### Added
- **Configuration export & import** — Settings → Interface exports all settings to a JSON file (with or without auth tokens) and restores them again.
- **Tag suggestions from similar posts** — The popup offers the most common tags of visually similar posts as one-click chips, taken from the reverse-search result already fetched.
- **Per-instance statistics** — The Statistics tab breaks imports, duplicates and failures down per szurubooru instance.

---

## [2.5.0] – July 2026

### Changed
- **Per-site source access** — Automatic content scripts are now dynamically registered only for supported source sites the user explicitly enables in Options. The extension no longer receives permanent access to all websites at install time.
- **Native browser shortcuts** — Quick Import and Import + Link Last now use `commands`, so they can be rebound or disabled in the browser's extension shortcut settings. The page-level `keydown` handler and stored hotkey configuration were removed.
- **Native HTTP client** — Replaced remaining Axios JSON calls with `fetch()` and `AbortController`; Axios is no longer a dependency or part of the bundle.

### Added
- **Toolbar status badge** — The action icon shows the active/queued import count and a per-tab check mark when the current source is already imported.
- **Options-page component boundaries** — Extracted navigation, source-site permission controls, and the popup action bar into focused Vue components.

---

## [2.4.1] – June 2026

### Changed
- **Per-site "upload as content" is now a plain whitelist.** Removed the preloaded recommended-site suggestions and the drag-and-drop quick-add. Add whichever hosts you need manually; nothing is preloaded by default.
- Neutralized store-listing and in-app copy (descriptions, changelog, option hints) to use generic "booru-style image board" wording instead of naming specific sites.

## [2.3.0] – May 2026

### Fixed
- **Hotkey import in Brave/Chrome (MV3)** — Hotkey imports on CDN-protected booru sites now work in Brave and Chrome. Root cause: Axios's fetch adapter in MV3 service workers silently failed on multipart FormData uploads to szurubooru (`/api/uploads`). All temp-file uploads now use native `fetch()` instead.

### Added
- **Multi-strategy CDN fetch in content script** — The content script now tries three approaches to bypass CDN hotlink protection: plain `fetch()` with full Referer (`unsafe-url`), `fetch()` with cookies + Referer, and finally XHR with credentials (Firefox CORS bypass via `host_permissions`).
- **`declarativeNetRequest` CORS injection (Chrome/Brave)** — Session rules are dynamically injected via `declarativeNetRequest.updateSessionRules` to add CORS headers to CDN responses, allowing the content script to read image bytes cross-origin.
- **`webRequest` Referer & CORS injection (Firefox)** — `onBeforeSendHeaders` replaces the Referer with the CDN's own origin for extension-context requests; `onHeadersReceived` injects `Access-Control-Allow-Origin` for CDN-protected booru hosts.
- **Toast restoration after page navigation** — Import status toasts are now restored when navigating to a new page during an active import. The background tracks in-flight/recently finished imports for 15 seconds; new content script instances query and recreate the correct toast state.

---

## [2.2.0] – April 2026

### Added
- **Auto-Relations On/Off toggle** — Auto-Relations can now be fully enabled or disabled via Settings → General. Default: enabled.
- **Animated server picker** — The server selector is now a compact pill that expands on click, showing the active server with status indicator and a dropdown to switch instances.
- **Color-coded format chips** — The file format chip in the popup now uses distinct colors: blue for video, purple for GIF/APNG, green for images.
- **Popup customization options** — The Interface settings section has been reworked with updated options including default tag sort order.
- **Fallback source tag import** — When a fallback source is used during import, tags from the original source are also imported.

### Changed
- Similarity threshold default lowered from 80% to 60%.

---

## [2.1.1] – April 2026

### Added
- **Configurable auto-relation threshold** — The similarity threshold for auto-relations can now be adjusted via a slider in Settings → General (default: 80%).

---

## [2.1.0] – April 2026

### Added
- **Auto-Relations for similar posts** — Posts with ≥80% similarity are automatically linked as relations after upload.
- **Import + Link Last Post hotkey** — A new configurable hotkey uploads the current page and automatically links the new post with the previously uploaded post as a relation.
- **Liquid UI redesign (Options)** — Complete visual overhaul of the options page with frosted glass effects, fluid animations, and a modern translucent design.

### Fixed
- **Auto-Relations timing** — Reverse image search for auto-relations now runs before post creation to avoid single-use content token expiry.

---

## [2.0.1] – April 2026

### Added
- Multi-language support (EN/DE).
- Tag category color picker in settings.
- Fork link in options sidebar.

### Fixed
- "Already uploaded" on quick import now shows "Already uploaded as Post #X" with a link.
- `[object Object]` in DevTools output for API errors.
- Empty tag name error when sending to szurubooru API.

---

## [2.0.0] – April 2026

### Added
- Quick Import via context menu (right-click any booru page).
- Quick Import via configurable hotkey.
- Real upload progress tracking.
- Glassmorphism status toasts.
- Modernized options page with sidebar navigation.

### Fixed
- 403 errors on CDN-protected booru sites (hotlink protection bypass).
- Octet-stream upload errors (ArrayBuffer base64 encoding in MV3 service workers).
- Popup preview images for hotlink-protected content.
- Improved MIME type detection from file extension.
- Filename preservation from URL.

---

## [1.1.24] – Original Release (neobooru/SzuruChrome)

- Initial release with support for importing media from various booru sites.
- Tag autocomplete with category colors.
- Pool support.
- Similar post detection via reverse image search.
- Post merging with tag/safety/source combining.
- Multi-instance support.

# Changelog

## [3.1.0] – August 2026

### Added

- **A running batch can be stopped.** A batch could be started but never cancelled — queueing 500 posts by accident (the default `maxPosts`) left closing the browser as the only way out. The "Stop scanning" button only ever aborted the URL crawl, not the import. Every running batch now has a stop button, both in the page dock and in the popup. Items already uploading run to completion; nothing new is started. Tearing a tab down between the content fetch and `createPost` is what would leave a half-created post, so "stop" deliberately means "stop starting", not "kill".
- **Batch progress in the popup.** The runner lives in the background and keeps going across navigations and closed tabs, but its progress only ever showed in the dock on the booru page it was started from. It now appears in the popup on any tab, with its stop button.
- **Import history.** The last 50 successful imports, each linking to the post it created and the page it came from, under Data. The statistics counted successes but never recorded them individually, so "did I already upload this, and where did it go?" had no answer.
- **Search across all settings.** Roughly 40 settings across seven tabs is past the point where scanning beats searching. Matches on the translated name and description in either language; results say which tab they live on.
- **Settings that differ from their default are marked**, and clicking the mark resets that one setting.
- **Deep links into a setting** — `options.html#tags/tagRules.enabled` opens the tab and points at the switch.
- **Tag rules per instance.** An instance can carry its own blacklist and rewrites instead of sharing one global set, which is what a second, differently-tagged target needs. Instances without an override keep following the global rules.
- **The rule tester can read the open page.** It can pull the tags off whatever booru page is open, so you see what the rules do to a real scrape instead of tag names typed from memory.
- **"Load post details" has a switch.** `fetchPostInfo` existed in the config and was being honoured, but had no UI anywhere — it was reachable only from the devtools console.

### Changed

- **The settings are reorganised into seven tabs that each do one job.** "General" had grown to 9 cards and 26 of the ~40 settings, while "Tags" held only the category colours. Tag rules moved next to those colours, backup moved in with the rest of your data, and the source-site permissions moved in with the instances they belong to. The changelog moved into a new "About" tab and is rendered from data rather than hand-copied markup.

### Fixed

- **Enlarging thumbnails works again.** The hover zoom was scoped to a host whitelist that ships empty, and the scope defaulted to "only the sites listed" — so switching the feature on did nothing whatsoever until a host was typed in by hand, with no hint that anything was missing. The scope now defaults to every supported site, an empty list means "wherever the extension runs" rather than "nowhere", and a config that never had a host in it is migrated over. The content script also says so in the console when the zoom is on but scoped away from the current page. Curated lists keep restricting to exactly their entries.
- **A zoom delay of 0 ms is honoured.** The slider offers 0 ("open immediately"), but any value below 1 was treated as corrupt and replaced by the 350 ms default.
- **Keyboard focus is visible again.** Each toggle hides its real checkbox in a `0×0` box, so the browser drew the focus ring on nothing — tabbing through two dozen switches gave no indication of position. There was no `:focus-visible` rule anywhere in the options stylesheet.
- **Explanatory text meets WCAG AA.** The hint under each setting sat at roughly 3.4:1 against the page background, below the 4.5:1 required for 12px text — on precisely the text that explains what a switch does.
- **The options page honours "reduce motion".** It carries about 20 transitions and had no `prefers-reduced-motion` block; the batch dock in the content script already did this correctly.
- **Configuration backups contain settings only.** Which panels you had collapsed was stored alongside the settings and travelled with every export, next to the instance credentials. It moved to its own storage key; existing state is carried over by the config migration.
- **25 dead translation keys removed** (17 UI, 8 runtime, in both languages), left behind by earlier renames.
- **Dead code removed** — an unused computed in the popup that no SFC type-checker had ever looked at.

### Internal

- `npm run typecheck` (`vue-tsc`) now covers the `.vue` files. Plain `tsc` ignores SFCs entirely, so a broken prop or import path inside a component passed `tsc`, ESLint and Vitest alike; the first run of `vue-tsc` found two such problems.
- The options page is split from one 2652-line SFC into a shell, seven tab components, six composables and a themed stylesheet; the popup's 1118 lines of scoped SCSS moved into their own file. `src/tests/settingsIndex.spec.ts` parses the tab components and fails if a setting is missing from the search index, so it cannot silently go stale.

## [3.0.6] – August 2026

### Fixed

- Tagged builds produce a release again. The pinned toolchain in `pnpm-lock.yaml` had not been re-resolved since 2023, and the version of `unplugin-auto-import` it held injected the auto-imported `browser` polyfill into the middle of a comment — so every tagged build since v3.0.1 failed before it packaged anything, and v3.0.1 through v3.0.5 never got a release. Resolving the lockfile against the ranges `package.json` already declares reaches a working toolchain without changing a single dependency range. This release therefore also carries everything from v3.0.4 and v3.0.5.

## [3.0.5] – August 2026

### Fixed

- The batch selection kept the order it was picked in. Its picks are sent to the background as deltas, but a second delta could be sent while the first was still on its way, and whichever answered first ended up in front — so "All pages" filled the basket in the order the round trips happened to finish. The import order was reversed correctly, only the list underneath it was already out of order: a batch would start with a couple of posts in listing order, then run backwards, then drop a stray chunk at the end. Deltas are now sent one after another, on both sides of the message.

## [3.0.4] – August 2026

### Added

- Batch imports now upload the oldest post first. A booru listing runs newest → oldest while szurubooru shows the newest upload first, so importing a whole artist in listing order left their oldest work sitting on top of the instance. The batch walks the selection back to front instead, which makes the newest post the last upload — and the first one you see afterwards. On by default, switchable under Interface → Batch import. Pools keep their selection order either way.

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

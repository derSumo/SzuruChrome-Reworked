# Changelog

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

# SzuruChrome Reworked

> A fork of [neobooru/SzuruChrome](https://github.com/neobooru/SzuruChrome) with quality-of-life improvements, bug fixes, and a modernized UI.

Browser extension (Chrome / Firefox / Waterfox) for importing media from various booru sites into a self-hosted [szurubooru](https://github.com/rr-/szurubooru) instance.

![Screenshot](./docs/screenshots/Default%20-%20Existing%20post%20found.png)

---

## What's New (vs. Original)

| Feature | Description |
|---|---|
| **Right-Click Quick Import** | Right-click any booru page → "Quick Import to szurubooru" — imports instantly without opening the popup. |
| **Hotkey Import** | Configure a custom keyboard shortcut (e.g. `Ctrl+Shift+I`) to import the current page with one keypress. |
| **Real Upload Progress** | Progress bar shows actual upload progress (via axios `onUploadProgress`) instead of a fake animation. |
| **iOS Glass Toasts** | Status notifications use modern glassmorphism with backdrop blur, translucent backgrounds, and spring animations. |
| **Modernized Options Page** | Redesigned settings with sidebar navigation, card layout, dark/light theme, and a built-in changelog. |
| **403 Fix (rule34.xxx etc.)** | Content uploads now include credentials and Referer headers to bypass CDN hotlink protection. |
| **Octet-Stream Fix** | Binary data is base64-encoded during message passing to prevent ArrayBuffer destruction in MV3 service workers. |
| **Preview Image Fix** | Popup preview images auto-fallback to blob URLs when direct loading fails due to hotlink protection. |
| **MIME Type Detection** | Files with missing/incorrect MIME types (`application/octet-stream`) are auto-detected from the file extension. |
| **Filename Preservation** | Uploaded files retain their original filename from the source URL. |

## Installation

### Firefox / Waterfox

1. Download the `.xpi` from the [Releases](../../releases) tab
2. Open `about:addons` → gear icon → "Install Add-on From File…" → select the `.xpi`
3. Alternatively: `about:debugging` → "This Firefox" → "Load Temporary Add-on" → select the `.xpi`

> **Note:** For unsigned XPIs, set `xpinstall.signatures.required = false` in `about:config`.

### Chrome

1. Build the extension (`npm run build`)
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select the `extension/` folder

## Build

```sh
npm install          # Install dependencies
npm run build        # Production build → ./extension/
npm run pack:xpi     # Build Firefox .xpi → ./extension.xpi
npm run dev          # Dev mode with HMR
```

After building, load the `extension/` folder in your browser:
- **Chrome:** `chrome://extensions/` → "Load unpacked" → select `./extension`
- **Firefox:** `about:debugging` → "Load Temporary Add-on" → select any file in `./extension`

## Tech Stack

- **Vue 3** + Composition API + `<script setup>`
- **Pinia** for state management
- **PrimeVue 3** + PrimeFlex for UI components
- **Vite 5** as build tool
- **webextension-polyfill** for cross-browser compatibility
- **neo-scraper** for booru page scraping

## Credits

This project is a fork of [neobooru/SzuruChrome](https://github.com/neobooru/SzuruChrome) (v1.1.24).
All original credit goes to [neobooru](https://github.com/neobooru) and contributors.

## License

[MIT](./LICENSE)

---

# 🇩🇪 SzuruChrome Reworked — Deutsche Version

> Ein Fork von [neobooru/SzuruChrome](https://github.com/neobooru/SzuruChrome) mit Quality-of-Life-Verbesserungen, Bugfixes und einer modernisierten Oberfläche.

Browser-Extension (Chrome / Firefox / Waterfox) zum Importieren von Medien von verschiedenen Booru-Seiten in eine selbst-gehostete [szurubooru](https://github.com/rr-/szurubooru)-Instanz.

## Was ist neu (vs. Original)

| Feature | Beschreibung |
|---|---|
| **Rechtsklick Quick Import** | Rechtsklick auf jeder Booru-Seite → "Quick Import to szurubooru" — importiert sofort ohne das Popup zu öffnen. |
| **Hotkey Import** | Konfigurierbare Tastenkombination (z.B. `Ctrl+Shift+I`) zum sofortigen Import der aktuellen Seite. |
| **Echter Upload-Fortschritt** | Die Fortschrittsanzeige zeigt den tatsächlichen Upload-Fortschritt (via axios `onUploadProgress`) statt einer Fake-Animation. |
| **iOS-Glas-Toasts** | Status-Benachrichtigungen im modernen Glasmorphismus-Design mit Backdrop-Blur, halbtransparenten Hintergründen und Spring-Animationen. |
| **Modernisierte Einstellungsseite** | Neu gestaltete Settings mit Sidebar-Navigation, Card-Layout, Dark/Light-Theme und integriertem Changelog. |
| **403-Fix (rule34.xxx etc.)** | Content-Uploads enthalten jetzt Credentials und Referer-Header um den CDN-Hotlink-Schutz zu umgehen. |
| **Octet-Stream-Fix** | Binärdaten werden bei der Nachrichtenübermittlung base64-kodiert, um die Zerstörung von ArrayBuffern in MV3 Service Workern zu verhindern. |
| **Vorschaubild-Fix** | Vorschaubilder im Popup fallen automatisch auf Blob-URLs zurück, wenn das direkte Laden durch Hotlink-Schutz fehlschlägt. |
| **MIME-Type-Erkennung** | Dateien mit fehlenden/falschen MIME-Typen (`application/octet-stream`) werden automatisch anhand der Dateiendung erkannt. |
| **Dateinamen-Erhaltung** | Hochgeladene Dateien behalten ihren originalen Dateinamen aus der Quell-URL. |

## Installation

### Firefox / Waterfox

1. `.xpi` aus dem [Releases](../../releases)-Tab herunterladen
2. `about:addons` → Zahnrad-Icon → "Add-on aus Datei installieren…" → `.xpi` auswählen
3. Alternativ: `about:debugging` → "Dieser Firefox" → "Temporäres Add-on laden" → `.xpi` auswählen

> **Hinweis:** Für unsignierte XPIs: `xpinstall.signatures.required = false` in `about:config` setzen.

### Chrome

1. Extension bauen (`npm run build`)
2. `chrome://extensions/` öffnen
3. **Entwicklermodus** aktivieren
4. **Entpackte Erweiterung laden** klicken
5. Den `extension/`-Ordner auswählen

## Build

```sh
npm install          # Dependencies installieren
npm run build        # Production-Build → ./extension/
npm run pack:xpi     # Firefox .xpi bauen → ./extension.xpi
npm run dev          # Dev-Modus mit HMR
```

Nach dem Build den `extension/`-Ordner im Browser laden:
- **Chrome:** `chrome://extensions/` → "Entpackte Erweiterung laden" → `./extension` auswählen
- **Firefox:** `about:debugging` → "Temporäres Add-on laden" → beliebige Datei in `./extension` auswählen

## Tech Stack

- **Vue 3** + Composition API + `<script setup>`
- **Pinia** für State-Management
- **PrimeVue 3** + PrimeFlex für UI-Komponenten
- **Vite 5** als Build-Tool
- **webextension-polyfill** für Cross-Browser-Kompatibilität
- **neo-scraper** zum Scrapen von Booru-Seiten

## Credits

Dieses Projekt ist ein Fork von [neobooru/SzuruChrome](https://github.com/neobooru/SzuruChrome) (v1.1.24).
Alle Credits gehen an [neobooru](https://github.com/neobooru) und die Mitwirkenden.

## Lizenz

[MIT](./LICENSE)

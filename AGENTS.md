# SzuruChrome – Codex Context (v3.0.0)

## Was ist das?
Browser-Extension (**Manifest V3**) zum Importieren von Medien (Bilder, Videos) von Booru-Seiten
(rule34.xxx, Gelbooru, Danbooru, e621, Moebooru, Shimmie2 …) in eine selbst-gehostete
[szurubooru](https://github.com/rr-/szurubooru)-Instanz.

Zwei Build-Targets aus derselben Codebasis:
- **Firefox/Waterfox** – zusätzlich mit `webRequest`/`webRequestBlocking` (Referer-Rewrite + CORS-Fallback)
- **Chrome/Edge/Brave** – ohne blocking `webRequest` (dort Enterprise-only); CORS läuft über
  `declarativeNetRequest`-Session-Rules

## Build & Entwicklung

```bash
export PATH="$PATH:/c/Program Files/nodejs"   # Node.js Pfad (Git Bash auf Windows)

npm install           # Dependencies installieren
npm run build         # Production-Build (Firefox) → ./extension/
npm run build:chrome  # Production-Build (Chrome)  → ./extension/
npm run pack:xpi      # XPI für Firefox/Waterfox   → ./extension.xpi
npm run pack:chrome   # ZIP für den Chrome Web Store → ./extension.zip
npm run dev           # Dev-Modus mit HMR
npm test              # Vitest
npm run lint          # ESLint
npm run typecheck     # vue-tsc — prüft AUCH die .vue-Dateien (tsc allein tut das nicht!)
```

| Skript | Was es tut |
|---|---|
| `build` | clear → build:web (Vite) → build:prepare (manifest) → build:js (content script) → build:extras |
| `build:extras` | zweiter IIFE-Build für `extras/` → `listingExtras.global.js` (on demand injiziert) |
| `build:chrome` | dito, mit `SZ_TARGET=chrome` (anderes Permission-Set, Pfade ohne `./`) |
| `pack:xpi` | `web-ext build` packt `./extension/` als `extension.xpi` |
| `start:firefox` | Live-Test in Firefox |

## Projektstruktur

```
src/
├── shared/             # Kontext-übergreifend (Background + Content + Popup + Options)
│   ├── config.ts       #   Single source of truth für die Config: Defaults, Typ, Reader
│   ├── tabs.ts         #   Tab-Messaging inkl. Content-Script-Nachinjektion
│   ├── host.ts         #   Host-Normalisierung, registrable domain, URL-Bau
│   ├── scrape.ts       #   ScrapeResults-Navigation + config-abhängiges Post-Mapping
│   ├── listing.ts      #   Listen-Seiten: Post-Links, Pagination, Such-URL-Bau
│   ├── media.ts        #   MIME-/Dateinamen-Ableitung aus URLs
│   ├── binary.ts       #   base64 ⇄ ArrayBuffer (Message-Passing zerstört Binärdaten)
│   ├── uiState.ts      #   gemerkte Panel-Zustände — bewusst NICHT in der Config
│   └── async.ts        #   sleep, withTimeout, createWriteChain
├── api/
│   ├── index.ts        # SzurubooruApi – alle API-Calls zur szurubooru-Instanz
│   └── models.ts       # API-Typen (Post, Tag, Pool, …)
├── background/         # MV3 Service Worker
│   ├── main.ts         #   NUR Verdrahtung: Message-Routing, Listener, Start-up
│   ├── settings.ts     #   Config-Zugriff, Instanz-Auflösung, Default-Handling
│   ├── state.ts        #   Queue/Link-Chain/Toast-State + Session-Spiegelung
│   ├── status.ts       #   quick_import_status-Broadcasts an den Tab
│   ├── cdnAccess.ts    #   CORS-Rules + Referer-Rewrite für Hotlink-Schutz
│   ├── importPipeline.ts # Scrape → Content-Token → Reverse-Search → createPost
│   ├── queue.ts        #   sequentielle Import-Queue, Retries, Link-Chains
│   ├── importedCheck.ts#   "Bereits importiert"-Lookup (mit Cache)
│   ├── batch.ts        #   Batch-Runner (öffnet Tabs, scrapt, schließt)
│   ├── batchController.ts# Verdrahtung Batch ↔ Pipeline ↔ Pools ↔ Statistik
│   ├── batchSelection.ts # seiten-übergreifender Auswahl-Korb (pro Site)
│   ├── scrapeTab.ts    #   Post-Seite in Hintergrund-Tab/-Fenster laden
│   ├── pageImport.ts   #   Einzel-Import einer Post-URL (+ Link-Chain)
│   └── sessionState.ts #   storage.session-Persistenz + Keep-Alive
├── contentScripts/     # Läuft auf JEDER Seite → Bundle bewusst klein halten
│   ├── index.ts        #   NUR Verdrahtung: Init-Guard, Message-Routing
│   ├── scraper.ts      #   neo-scraper + Settle-Retry für Hotkey-Presses
│   ├── fetchContent.ts #   Medien-Download aus dem Seiten-Kontext
│   ├── toasts.ts       #   Import-Toasts + Upload-Historie
│   ├── importedBadge.ts#   "Bereits importiert"-Badge (Detailseite)
│   ├── thumbBadges.ts  #   "Bereits importiert"-Häkchen auf Listen-Thumbnails
│   ├── thumbActions.ts #   Hover-Buttons (Import / Import + Verknüpfen)
│   ├── ui/icons.ts     #   Flat-SVG-Icons für die In-Page-UI
│   └── extras/         #   EIGENES Bundle, on demand injiziert (opt-in Features)
│       ├── index.ts    #     Entry: installiert Zoom + Endless Scroll
│       ├── hoverZoom.ts#     Vergrößerte Vorschau (liest Bild-URL aus der Post-Seite)
│       └── endlessScroll.ts# Nächste Listen-Seite anhängen
│   ├── batchUi.ts      #   Auswahl-UI + Dock (laufende Batches stapeln über der Auswahl)
│   ├── batchUi.styles.ts #  dessen injiziertes CSS + die id/class-Konstanten
│   ├── listingCrawl.ts #   "Alle Seiten": Pagination durchlaufen, Post-URLs sammeln
│   ├── hotkeys.ts      #   Quick-Import-Tastenkürzel
│   ├── pageConfig.ts   #   EIN gecachter Config-Read für alle Features
│   └── navigation.ts   #   EIN Navigations-Detektor für alle Features
├── popup/
│   ├── App.vue         # Popup Root (Router)
│   ├── contentToken.ts # Content-Token-Beschaffung für den Popup-Pfad
│   └── pages/
│       ├── PopupMain.vue   # Haupt-Popup: Import, Similar-Search, Tag-Editor
│       ├── PopupMain.scss  #   dessen scoped Styles (via <style src>)
│       └── MergePost.vue   # Post mergen (Tags/Safety/Source zusammenführen)
├── options/
│   ├── App.vue         # NUR Hülle: Sidebar, Tab-Dispatch, Suche, Deep-Links, Color-Mode
│   ├── settingsIndex.ts#   EINE Liste aller Einstellungen → Suche, Deep-Links, "geändert"-Marker
│   ├── changelog.ts    #   Release-Historie als Daten (i18n-Keys), nicht als Markup
│   ├── icons.ts        #   Sidebar-Icons (getrennt vom Content-Script-Icon-Set!)
│   ├── keys.ts         #   Injection-Keys (Highlight-Ziel für SettingRow)
│   ├── components/     #   SettingCard/Row/Toggle/Slider, ChipListEditor, Sidebar
│   │   └── tabs/       #     ein SFC pro Tab: Import, Tags, OnPage,
│   │                   #     Connections, Appearance, Data, About
│   ├── composables/    #   useStatusMessage, useHostList, useConfigBackup,
│   │                   #   useSourceAccess, useImportStats, useSettingsSearch
│   └── styles/         #   options.scss = Index; Partials nach Thema (Reihenfolge = Kaskade!)
├── i18n/
│   ├── index.ts        # Framework-freier Kern (t, setLanguage) – KEIN Vue-Import
│   ├── vue.ts          # useI18n() + Registrierung der UI-Strings
│   └── messages/       # *.runtime.ts (Background/Content) · *.ui.ts (Popup/Options)
├── components/         # Wiederverwendbare Vue-Komponenten
├── stores/index.ts     # Pinia + reaktive `cfg` (nutzt shared/config als Defaults)
├── models/index.ts     # Eigene Typen (ScrapedPostDetails, BrowserCommand, …)
├── tagRules.ts         # Blacklist-/Rewrite-Regel-Engine
├── stats.ts            # Import-Statistik + Fehlerliste
├── utils.ts            # Rest-Helfer (getErrorMessage, Tag-Formatierung, …)
└── tests/              # Vitest-Specs für die reine Logik in shared/ und tagRules
```

### Architektur-Regeln
1. **Kein Logik-Duplikat zwischen Kontexten.** Was Popup *und* Background brauchen, liegt in `src/shared/`.
   (Historisch drifteten Popup- und Background-Import auseinander — Settings wirkten nur auf einem Pfad.)
2. **`main.ts` und `contentScripts/index.ts` enthalten nur Verdrahtung**, keine Fachlogik.
3. **Das Content-Script-Bundle ist heilig.** Es läuft auf jeder Seite im Browser. Nichts importieren,
   was Vue, Pinia oder die UI-Übersetzungen hereinzieht. Aktuell ~119 kB + 30 kB opt-in-Extras, die nur bei Bedarf injiziert werden.
4. **`~/i18n` ist Vue-frei**; Vue-Kontexte importieren `~/i18n/vue`.

## Kommunikation

```
ContentScript ──(tabs.sendMessage "grab_post")──► Popup / Background
Popup         ──(runtime.sendMessage "upload_post")──► Background
Background    ──(HTTP)──► szurubooru API
Background    ──("quick_import_status")──► ContentScript (Toasts)
Background    ──("set_post_upload_info")──► Popup (Status-Updates)
ContentScript ──(keydown → "hotkey_import" / "hotkey_import_link_last")──► Background
```

### BrowserCommands (models/index.ts)
- `grab_post` – ContentScript scrapt die aktuelle Seite (neo-scraper)
- `upload_post` / `update_post` – Background lädt hoch bzw. updated (Merge)
- `fetch` / `fetch_content` / `fetch_head_info` – CORS-Bypass bzw. Seiten-Kontext-Download
- `quick_import_status` / `set_post_upload_info` / `set_exact_post_id` / `set_post_update_info` – Status
- `get_active_imports` – ContentScript stellt Toasts nach Navigation wieder her
- `hotkey_import` / `hotkey_import_link_last` – Hotkey-Import (+ Verknüpfung mit letztem Post)
- `check_imported` – `source:`-Suche für das Badge
- `retry_failed_import` – Options-Seite reiht einen fehlgeschlagenen Import erneut ein
- `stats_mutate` – Statistik-Schreibzugriffe laufen alle über den Background (ein Schreiber)
- `batch_import` / `batch_status` – Batch-/Pool-Import von Listen-Seiten
- `batch_cancel` – laufenden Batch stoppen (Queue schließen; Laufendes läuft aus)
- `batch_selection` – Auswahl-Korb lesen/mutieren (Deltas), überlebt Seitenwechsel
- `batch_active` – läuft gerade ein Batch? (Fortschritts-Zeile nach Seitenwechsel wiederherstellen)
- `import_post_url` – Einzel-Import einer Post-URL aus den Thumbnail-Hover-Buttons
- `inject_listing_extras` – lädt das Extras-Bundle (Zoom/Endless Scroll) in den Tab
- `check_imported_bulk` – gebündelte "Bereits importiert"-Prüfung für Listen-Thumbnails
- `report_progress` – Download-Fortschritt aus dem ContentScript

## Config

`browser.storage.local["config"]`. **Defaults und Typ stehen in `src/shared/config.ts`** — nicht im Store
duplizieren. Der Store (`src/stores/index.ts`) fügt nur Reaktivität und die Migrations-Kette hinzu.

Wichtige Felder: `sites[]`, `selectedSiteId`, `addAllParsedTags`, `alwaysUploadAsContent`,
`uploadAsContentSites[]`, `autoSearchSimilar`, `tagCategories[]`, `hotkey`, `hotkeyLinkLast`,
`tagRules`, `importedBadge`, `queueRetry`, `statsEnabled`, `batchImport`, `autoRelationThreshold`,
`replaceExactDuplicates`.

**Getrennte Storage-Keys:**
- `szuru_stats` (`storage.local`) – Statistik + Fehlerliste, siehe `src/stats.ts`
- `szuru_bg_state` (`storage.session`) – MV3-Queue-Zustand, damit ein Service-Worker-Neustart
  eine laufende Serie nicht abbricht (`src/background/sessionState.ts`)
- `szuru_batch_selection` (`storage.session`) – Batch-Auswahl pro Site, damit sie eine Navigation
  auf die nächste Listen-Seite überlebt (`src/background/batchSelection.ts`)
- `szuru_batch_session` (`storage.session`) – laufender Batch (Queue + Ergebnisse), damit ein
  Service-Worker-Neustart ihn fortsetzen kann (`src/background/batch.ts`)
- `szuru_ui_state` (`storage.local`) – gemerkte Panel-Zustände, getrennt von den Einstellungen,
  damit ein Config-Backup nur Einstellungen enthält (`src/shared/uiState.ts`)

## Nicht-offensichtliche Invarianten

- **Reverse-Search VOR `createPost`.** Content-Tokens sind einmalig und werden von `createPost`
  verbraucht — danach ist keine Auto-Relation mehr möglich.
- **Hotlink-Schutz:** Medien werden bevorzugt aus dem *Seiten*-Kontext geladen (Cookies + echter
  Referer), nicht vom Background. `withCdnAccess()` injiziert dafür temporär CORS-Header.
- **Der Scrape wird beim Enqueue festgehalten**, nicht erst beim Verarbeiten — sonst lädt die Queue
  nach einer Navigation die falsche Seite hoch und blockiert sich mit "already uploaded".
- **`crypto.randomUUID()`, nie `window.crypto`** — im Service Worker gibt es kein `window`.
- **Statistik-Schreibzugriffe nur aus dem Background** (serialisierte Write-Chain in `stats.ts`);
  die Options-Seite schickt `stats_mutate`.
- **`check_imported`-Fehler ⇒ `unavailable`, nie `imported: false`** — ein False Negative würde zu
  einem Duplikat-Upload einladen.
- **Batch-Abbruch stoppt die Queue, nicht die laufenden Uploads.** `cancelBatchImport` setzt nur
  `cancelled` und leert den Cursor; was gerade hochlädt, läuft zu Ende. Einen Tab zwischen
  Content-Fetch und `createPost` abzuschießen erzeugt halb angelegte Posts.
- **`tsc --noEmit` prüft KEINE `.vue`-Dateien.** Für SFCs `npm run typecheck` (vue-tsc) nutzen —
  `tsc`, ESLint und Vitest laufen bei einem kaputten Prop oder Import-Pfad alle grün durch.
- **Jede `SettingRow` mit `path=` muss in `options/settingsIndex.ts` stehen.**
  `src/tests/settingsIndex.spec.ts` erzwingt das in beide Richtungen.
- **Panel-Zustände gehören nach `shared/uiState.ts`, nicht in die Config** — sonst landen sie im
  Config-Backup neben den Zugangsdaten.

## Installation (Waterfox / unsigned XPI)
1. `npm run build && npm run pack:xpi` → `extension.xpi` im Root
2. `about:debugging` → "Dieser Firefox" → "Temporäres Add-on laden" → XPI auswählen
3. Alternativ: `xpinstall.signatures.required = false` in `about:config`

## Tech Stack
- **Vue 3** + Composition API + `<script setup>`, **Pinia**, **vue-router**
- UI ist handgeschrieben (eigene „glass"-Komponenten + `src/styles/main.scss`) —
  **kein PrimeVue/PrimeFlex mehr**; die waren komplett ungenutzt und kosteten ~730 kB CSS.
- **Vite 5** (zwei Configs: Haupt-App + Content-Script als IIFE)
- **webextension-polyfill**, **neo-scraper**, **web-ext**, **Vitest**

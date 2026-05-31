# Privacy Policy — SzuruChrome Reworked

**Last updated:** 2026-05-31
**Extension:** SzuruChrome Reworked
**Source code:** https://github.com/derSumo/SzuruChrome-Reworked

---

## English

### 1. Who we are
SzuruChrome Reworked is an open-source browser extension that imports media (images, videos, tags, pools) from various booru and image sites into a **self-hosted szurubooru instance** that the user operates themselves. It is published as a free, non-commercial side project. The extension has no central server, no analytics backend, and no telemetry endpoint.

### 2. Data we collect and process

| Data | Why | Where it goes |
|---|---|---|
| szurubooru **username** entered by the user | Authenticates the user against their own szurubooru instance | Stored locally in `browser.storage.local`. Transmitted only to the szurubooru instance URL the user configured. |
| szurubooru **API token** entered by the user | Signs upload/update API requests | Stored locally in `browser.storage.local`. Transmitted only to the szurubooru instance URL the user configured. |
| **Scraped booru-page content** (image URL, tags, pools, source, notes) | The core purpose of the extension: turning a booru page into a szurubooru post | Read from the active tab only after an explicit user action (popup click, hotkey, context menu). Transmitted only to the szurubooru instance URL the user configured. |
| **Extension settings** (selected language, tag-category colors, hotkey bindings, instance list, similarity threshold) | Persisting the user's preferences across sessions | Stored locally in `browser.storage.local`. Never transmitted. |

### 3. Data we do NOT collect
- No location data
- No browsing or web history
- No keystrokes, clicks, scroll, or other passive activity tracking
- No financial or payment information
- No health information
- No personal communications
- No personally identifying information beyond the username the user voluntarily enters
- No advertising, marketing, or third-party analytics SDKs

### 4. Who we share data with
**No one.** All user data stays on the user's device and the user's own szurubooru instance. We do not sell, rent, transfer, or share any data with third parties. We do not use data for credit, lending, or creditworthiness purposes. We do not use data for any purpose unrelated to the single advertised purpose of importing media into szurubooru.

### 5. Permissions used (and why)
- `storage` — persist user configuration locally
- `activeTab`, `tabs`, `scripting` — scrape the booru page the user explicitly chose to import
- `contextMenus` — provide the "Quick Import" right-click entry
- `declarativeNetRequestWithHostAccess` — inject temporary CORS headers into CDN responses so image bytes can be read for upload. Rules are session-scoped and removed immediately after each import.
- `host_permissions: <all_urls>` — required because supported booru engines (Danbooru, Shimmie2, Moebooru, Philomena forks) and user-hosted szurubooru instances live under arbitrary domains.

No code is loaded from remote sources. The extension contains no `eval()`, no remote `<script>` tags, no dynamic module loading.

### 6. Data retention and deletion
All data lives in the user's browser storage. Uninstalling the extension or clearing site data removes everything. The user may also clear the configuration via the extension's Options page at any time.

### 7. Children
The extension is not directed at children under 13. Some supported booru sites publish adult content; the extension itself does not filter, recommend, or curate any content — it only transfers what the user actively chooses to import.

### 8. Changes
This policy may be updated alongside extension releases. Material changes will be noted in the GitHub repository changelog.

### 9. Contact
Open an issue at https://github.com/derSumo/SzuruChrome-Reworked/issues

---

## Deutsch

### 1. Wer wir sind
SzuruChrome Reworked ist eine quelloffene Browser-Erweiterung, die Medien (Bilder, Videos, Tags, Pools) von verschiedenen Booru- und Bild-Seiten in eine **vom Nutzer selbst betriebene szurubooru-Instanz** importiert. Sie wird kostenlos und nicht-kommerziell als Nebenprojekt veröffentlicht. Die Erweiterung hat keinen zentralen Server, kein Analyse-Backend und keinen Telemetrie-Endpunkt.

### 2. Daten, die erhoben und verarbeitet werden

| Daten | Wozu | Wohin |
|---|---|---|
| Vom Nutzer eingegebener **szurubooru-Username** | Authentifizierung gegenüber der eigenen szurubooru-Instanz | Lokal in `browser.storage.local` gespeichert. Übertragung ausschließlich an die vom Nutzer konfigurierte szurubooru-Instanz-URL. |
| Vom Nutzer eingegebener **szurubooru-API-Token** | Signiert Upload-/Update-API-Requests | Lokal in `browser.storage.local` gespeichert. Übertragung ausschließlich an die vom Nutzer konfigurierte szurubooru-Instanz-URL. |
| **Gescrapter Booru-Seiten-Inhalt** (Bild-URL, Tags, Pools, Quelle, Notes) | Kernzweck der Erweiterung: Booru-Seite in szurubooru-Post umwandeln | Wird ausschließlich nach expliziter Nutzeraktion (Popup-Klick, Hotkey, Kontextmenü) aus dem aktiven Tab gelesen. Übertragung ausschließlich an die konfigurierte szurubooru-Instanz-URL. |
| **Erweiterungs-Einstellungen** (Sprache, Tag-Kategorien-Farben, Hotkey-Bindings, Instanz-Liste, Ähnlichkeits-Schwelle) | Persistenz der Nutzereinstellungen über Sessions hinweg | Lokal in `browser.storage.local` gespeichert. Nie übertragen. |

### 3. Daten, die NICHT erhoben werden
- Keine Standortdaten
- Kein Browser- oder Web-Verlauf
- Keine Tastatureingaben, Klicks, Scroll-Aktionen oder sonstiges passives Aktivitäts-Tracking
- Keine Finanz- oder Zahlungsinformationen
- Keine Gesundheitsdaten
- Keine persönliche Kommunikation
- Keine personenidentifizierbaren Daten über den vom Nutzer freiwillig eingegebenen Username hinaus
- Keine Werbe-, Marketing- oder Drittanbieter-Analyse-SDKs

### 4. Weitergabe an Dritte
**Keine.** Alle Nutzerdaten verbleiben auf dem Gerät des Nutzers und auf seiner eigenen szurubooru-Instanz. Wir verkaufen, vermieten, übertragen oder teilen keine Daten mit Dritten. Wir verwenden Daten nicht für Bonitätsprüfungen oder Kreditvergabe. Wir verwenden Daten nicht für Zwecke, die nicht mit dem einzigen beworbenen Zweck (Medien-Import in szurubooru) in Verbindung stehen.

### 5. Genutzte Berechtigungen (und warum)
- `storage` — lokale Persistenz der Nutzer-Konfiguration
- `activeTab`, `tabs`, `scripting` — Scrapen der Booru-Seite, die der Nutzer explizit importieren möchte
- `contextMenus` — bietet den „Quick Import"-Eintrag im Rechtsklick-Menü
- `declarativeNetRequestWithHostAccess` — injiziert temporäre CORS-Header in CDN-Antworten, damit Bilddaten für den Upload gelesen werden können. Regeln sind sitzungsgebunden und werden direkt nach jedem Import wieder entfernt.
- `host_permissions: <all_urls>` — erforderlich, da unterstützte Booru-Engines (Danbooru-, Shimmie2-, Moebooru-, Philomena-Forks) und nutzerseitig gehostete szurubooru-Instanzen unter beliebigen Domains laufen.

Es wird kein Code aus externen Quellen geladen. Die Erweiterung enthält kein `eval()`, keine externen `<script>`-Tags, kein dynamisches Modul-Loading.

### 6. Datenaufbewahrung und Löschung
Alle Daten liegen im Browser-Storage des Nutzers. Deinstallation der Erweiterung oder Löschung der Seitendaten entfernt alles. Der Nutzer kann die Konfiguration jederzeit auch über die Optionsseite der Erweiterung löschen.

### 7. Kinder
Die Erweiterung richtet sich nicht an Kinder unter 13 Jahren. Einige der unterstützten Booru-Seiten publizieren Inhalte für Erwachsene; die Erweiterung selbst filtert, empfiehlt oder kuratiert keine Inhalte — sie überträgt ausschließlich, was der Nutzer aktiv zum Import auswählt.

### 8. Änderungen
Diese Richtlinie kann zusammen mit Erweiterungs-Releases aktualisiert werden. Wesentliche Änderungen werden im Changelog des GitHub-Repositories vermerkt.

### 9. Kontakt
Issue eröffnen unter https://github.com/derSumo/SzuruChrome-Reworked/issues

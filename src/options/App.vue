<script setup lang="ts">
import { useColorMode } from "@vueuse/core";
import { cfg } from "~/stores";
import { getErrorMessage } from "~/utils";
import { SzuruSiteConfig, TagCategoryColor, getDefaultTagCategories } from "~/models";
import SzurubooruApi from "~/api";

type StatusType = "success" | "error" | "quiet";

const statusText = ref("");
const statusType = ref<StatusType>("quiet");
const versionInfo = import.meta.env.VITE_SZ_VERSION ?? browser.runtime.getManifest().version;
const activeTab = ref("general");

const tabs = [
  { id: "general", label: "General" },
  { id: "interface", label: "Interface" },
  { id: "instances", label: "Instances" },
  { id: "tags", label: "Tags" },
  { id: "changelog", label: "Changelog" },
];

const selectedSite = computed(() => {
  if (cfg.value.selectedSiteId) {
    return cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId);
  }
});

const mode = useColorMode({ emitAuto: true });

async function testConnection() {
  if (!selectedSite.value?.domain || !selectedSite.value?.username || !selectedSite.value?.authToken) {
    setStatus("Domain, username and authentication token are all required.", "error");
    return;
  }
  const api = new SzurubooruApi(selectedSite.value.domain, selectedSite.value.username, selectedSite.value.authToken);
  try {
    const info = await api.getInfo();
    const instanceName = info?.config.name;
    if (instanceName == undefined) {
      setStatus(`Connected to ${selectedSite.value.domain}, but it is not a szurubooru instance.`, "error");
    } else {
      setStatus(`Connected to "${info.config.name}" at ${selectedSite.value.domain}`, "success");
    }
  } catch (ex) {
    setStatus(`Couldn't connect to ${selectedSite.value.domain}. ${getErrorMessage(ex)}`, "error");
  }
}

function setStatus(text: string, type: StatusType = "success") {
  statusText.value = text;
  statusType.value = type;
}

function addSite() {
  const site = new SzuruSiteConfig();
  cfg.value.sites.push(site);
  cfg.value.selectedSiteId = site.id;
}

function removeSelectedSite() {
  if (selectedSite.value) {
    const idx = cfg.value.sites.indexOf(selectedSite.value);
    cfg.value.sites.splice(idx, 1);
  }
  if (cfg.value.sites.length > 0) {
    cfg.value.selectedSiteId = cfg.value.sites[0].id;
  } else {
    cfg.value.selectedSiteId = undefined;
  }
}

function resetTagCategories() {
  cfg.value.tagCategories.splice(0);
  cfg.value.tagCategories.push(...getDefaultTagCategories());
}

function addTagCategory() {
  cfg.value.tagCategories.push(new TagCategoryColor("category", "#abcdef"));
}

async function importTagCategoriesFromInstance() {
  const szuruConfig = cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId)!;
  const szuru = SzurubooruApi.createFromConfig(szuruConfig);
  const cats = (await szuru.getTagCategories()).results;
  for (const cat of cats) {
    if (cat.name == "default") continue;
    if (!cfg.value.tagCategories.find((x) => x.name == cat.name)) {
      cfg.value.tagCategories.push(new TagCategoryColor(cat.name, cat.color));
    }
  }
}

const wnd = window as any;
wnd.szc_get_config = () => JSON.parse(JSON.stringify(cfg.value));
wnd.szc_set_config_version = (v = 0) => (cfg.value.version = v);

// ── Hotkey recorder ──────────────────────────────────────
const isRecordingHotkey = ref(false);

const hotkeyDisplayText = computed(() => {
  const h = cfg.value.hotkey;
  if (!h.key) return "Not set";
  const parts: string[] = [];
  if (h.modifiers.includes("ctrl")) parts.push("Ctrl");
  if (h.modifiers.includes("alt")) parts.push("Alt");
  if (h.modifiers.includes("shift")) parts.push("Shift");
  parts.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return parts.join(" + ");
});

function startRecordingHotkey() {
  isRecordingHotkey.value = true;
}

function onHotkeyKeydown(e: KeyboardEvent) {
  // Ignore pure modifier presses
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");

  cfg.value.hotkey.key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  cfg.value.hotkey.modifiers = mods;
  isRecordingHotkey.value = false;
}

function clearHotkey() {
  cfg.value.hotkey.key = "";
  cfg.value.hotkey.modifiers = [];
}
</script>

<template>
  <div class="page">
    <div class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-name">SzuruChrome Reworked</span>
        <span class="brand-version">v{{ versionInfo }}</span>
        <span class="brand-fork">Fork by Sumo</span>
      </div>

      <nav class="sidebar-nav">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="nav-item"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

    <main class="content">
      <!-- General Tab -->
      <div v-if="activeTab === 'general'" class="tab-content">
        <h2 class="tab-title">General</h2>

        <div class="card">
          <h3 class="card-title">Import Behavior</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Add page URL to source</span>
              <span class="option-hint">Adds the booru page URL to the source list in addition to the detected source (e.g. Twitter/Pixiv). Always used as fallback when no source is found.</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addPageUrlToSource" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Auto-import all tags</span>
              <span class="option-hint">Automatically imports all tags including their categories on supported pages (Danbooru, Zerochan, etc.).</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addAllParsedTags" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Always upload as content</span>
              <span class="option-hint">Downloads the file and uploads it directly instead of passing the URL to szurubooru. Required for sites with hotlink protection (e.g. rule34.xxx).</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.alwaysUploadAsContent" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Add tag implications</span>
              <span class="option-hint">Automatically adds implied tags when adding a tag.</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.addTagImplications" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">Quick Import Hotkey</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Enable keyboard shortcut</span>
              <span class="option-hint">Press the configured key combo on any page to instantly import to your szurubooru instance.</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.hotkey.enabled" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <template v-if="cfg.hotkey.enabled">
            <div class="option-row">
              <div class="option-info">
                <span class="option-label">Shortcut</span>
                <span class="option-hint">Click the button and press your desired key combination.</span>
              </div>
              <div class="hotkey-recorder">
                <button
                  class="btn hotkey-btn"
                  :class="{ recording: isRecordingHotkey }"
                  @click="startRecordingHotkey"
                  @keydown="isRecordingHotkey && onHotkeyKeydown($event)"
                >
                  {{ isRecordingHotkey ? 'Press keys…' : hotkeyDisplayText }}
                </button>
                <button class="btn btn-secondary hotkey-clear" @click="clearHotkey" v-if="cfg.hotkey.key" title="Clear">✕</button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Interface Tab -->
      <div v-if="activeTab === 'interface'" class="tab-content">
        <h2 class="tab-title">Interface</h2>

        <div class="card">
          <h3 class="card-title">Appearance</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Theme</span>
              <span class="option-hint">Choose between light, dark, or system theme.</span>
            </div>
            <div class="select-wrapper">
              <select v-model="mode">
                <option value="auto">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">Popup</h3>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Auto-search similar posts</span>
              <span class="option-hint">Automatically reverse-searches for similar posts when the popup opens. Hides the "Find Similar" button.</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.autoSearchSimilar" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Show tag usage counts</span>
              <span class="option-hint">Shows how often each tag is used in your szurubooru instance.</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.loadTagCounts" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Show source field</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.popup.showSource" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Show pools section</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.popup.showPools" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>

          <div class="option-row">
            <div class="option-info">
              <span class="option-label">Show instance picker</span>
            </div>
            <label class="toggle">
              <input type="checkbox" v-model="cfg.popup.showInstancePicker" />
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Instances Tab -->
      <div v-if="activeTab === 'instances'" class="tab-content">
        <h2 class="tab-title">Instances</h2>

        <div class="card">
          <h3 class="card-title">Szurubooru Servers</h3>

          <div class="instance-bar">
            <select v-model="cfg.selectedSiteId" class="instance-select">
              <option v-for="site in cfg.sites" :key="site.id" :value="site.id">
                {{ site.username }} @ {{ site.domain }}
              </option>
              <option v-if="cfg.sites.length === 0" disabled value="">No instances configured</option>
            </select>
            <button class="btn btn-primary" @click="addSite">Add</button>
            <button class="btn btn-danger" @click="removeSelectedSite" :disabled="!selectedSite">Remove</button>
          </div>

          <template v-if="selectedSite">
            <div class="divider"></div>

            <div class="form-group">
              <label class="form-label">URL</label>
              <input type="text" placeholder="https://szuru.example.com" v-model="selectedSite.domain" />
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Username</label>
                <input type="text" placeholder="username" v-model="selectedSite.username" />
              </div>
              <div class="form-group">
                <label class="form-label">Authentication Token</label>
                <input type="password" placeholder="token" v-model="selectedSite.authToken" />
              </div>
            </div>

            <div class="connection-test">
              <button class="btn btn-secondary" @click="testConnection">Test Connection</button>
              <span v-if="statusText" class="status-text" :class="`status-${statusType}`">{{ statusText }}</span>
            </div>
          </template>

          <div v-else class="empty-state">
            <span>No instance selected. Click <strong>Add</strong> to configure a server.</span>
          </div>
        </div>
      </div>

      <!-- Tags Tab -->
      <div v-if="activeTab === 'tags'" class="tab-content">
        <h2 class="tab-title">Tag Categories</h2>

        <div class="card">
          <h3 class="card-title">Color Mapping</h3>
          <p class="card-hint">Map szurubooru tag categories to display colors in the popup.</p>

          <div class="tag-table">
            <div class="tag-table-header">
              <span>Category Name</span>
              <span>CSS Color</span>
              <span>Preview</span>
              <span></span>
            </div>
            <div v-for="(cat, index) in cfg.tagCategories" :key="index" class="tag-table-row">
              <input type="text" v-model="cat.name" placeholder="category name" />
              <input type="text" v-model="cat.color" placeholder="#rrggbb" class="color-input" />
              <div class="color-preview-row">
                <span class="color-chip" :style="{ background: cat.color }"></span>
                <span class="color-sample-text" :style="{ color: cat.color }">Tag</span>
              </div>
              <button class="btn-icon btn-remove" @click="cfg.tagCategories.splice(index, 1)" title="Remove">✕</button>
            </div>
            <div v-if="cfg.tagCategories.length === 0" class="tag-table-empty">
              No categories configured.
            </div>
          </div>

          <div class="card-actions">
            <button class="btn btn-primary" @click="addTagCategory">Add Category</button>
            <button class="btn btn-secondary" @click="importTagCategoriesFromInstance">Import from Instance</button>
            <button class="btn btn-danger ml-auto" @click="resetTagCategories">Reset to Default</button>
          </div>
        </div>
      </div>

      <!-- Changelog Tab -->
      <div v-if="activeTab === 'changelog'" class="tab-content">
        <h2 class="tab-title">Changelog</h2>

        <div class="card changelog-card">
          <div class="changelog-entry">
            <div class="changelog-version">v2.0.0</div>
            <div class="changelog-date">April 2026</div>
            <ul class="changelog-list">
              <li><strong>Quick Import via Context Menu</strong> — Right-click any booru page and select "Quick Import" to import directly to szurubooru without opening the popup.</li>
              <li><strong>Quick Import via Hotkey</strong> — Configure a custom keyboard shortcut in Settings → General to instantly import the current page.</li>
              <li><strong>Real Upload Progress Tracking</strong> — The progress bar now shows actual upload progress instead of a fake animation, using axios onUploadProgress throughout the entire pipeline.</li>
              <li><strong>iOS-style Glass Toasts</strong> — Import status notifications now use modern glassmorphism design with backdrop blur, translucent backgrounds, and smooth spring animations.</li>
              <li><strong>Fixed 403 Errors on rule34.xxx</strong> — Content uploads now include proper credentials and Referer headers to bypass CDN hotlink protection.</li>
              <li><strong>Fixed Octet-Stream Upload Errors</strong> — Binary data is now base64-encoded during message passing to prevent ArrayBuffer destruction in Chrome MV3 service workers.</li>
              <li><strong>Fixed Popup Preview Images</strong> — Preview images that fail to load (due to hotlink protection) now automatically fallback to a blob URL via fetch.</li>
              <li><strong>Modernized Options Page</strong> — Complete redesign with sidebar navigation, cleaner card layout, and proper dark/light theme support.</li>
              <li><strong>Improved MIME Type Handling</strong> — Files with missing or incorrect MIME types (application/octet-stream) are now auto-detected from the file extension.</li>
              <li><strong>Filename Preservation</strong> — Uploaded files now retain their original filename derived from the URL, improving organization in szurubooru.</li>
            </ul>
          </div>

          <div class="changelog-entry">
            <div class="changelog-version">v1.1.24</div>
            <div class="changelog-date">Original Release (neobooru/SzuruChrome)</div>
            <ul class="changelog-list">
              <li>Initial release with support for importing media from various booru sites.</li>
              <li>Tag autocomplete with category colors.</li>
              <li>Pool support.</li>
              <li>Similar post detection via reverse image search.</li>
              <li>Post merging with tag/safety/source combining.</li>
              <li>Multi-instance support.</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<style lang="scss">
/* ── Layout ────────────────────────────────────────────── */
.page {
  display: flex;
  min-height: 100vh;
  background: var(--bg-main-color);
  color: var(--text-color);
  font-size: 14px;
}

/* ── Sidebar ───────────────────────────────────────────── */
.sidebar {
  width: 200px;
  flex-shrink: 0;
  background: var(--section-header-bg-color);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  padding: 0;
}

.sidebar-brand {
  padding: 20px 16px 16px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.brand-name {
  font-weight: 700;
  font-size: 15px;
  color: var(--primary-color);
}

.brand-version {
  font-size: 11px;
  color: var(--secondary-text);
}

.brand-fork {
  font-size: 10px;
  color: var(--secondary-text);
  opacity: 0.6;
  font-style: italic;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  gap: 2px;
}

.nav-item {
  display: block;
  width: 100%;
  padding: 9px 16px;
  background: none;
  border: none;
  border-radius: 0;
  color: var(--text-color);
  text-align: left;
  font-size: 13px;
  cursor: pointer;
  height: auto;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;

  &:hover {
    background: var(--tab-color);
  }

  &.active {
    background: var(--primary-color);
    color: #fff;
    font-weight: 600;
  }
}

/* ── Main content ──────────────────────────────────────── */
.content {
  flex: 1;
  padding: 28px 32px;
  max-width: 760px;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.tab-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 4px;
  color: var(--text-color);
}

/* ── Card ──────────────────────────────────────────────── */
.card {
  background: var(--bg-secondary-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--secondary-text);
  margin: 0 0 16px;
}

.card-hint {
  font-size: 12px;
  color: var(--secondary-text);
  margin: -10px 0 14px;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  align-items: center;
}

.divider {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 16px 0;
}

/* ── Option rows (checkbox settings) ──────────────────── */
.option-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);

  &:first-of-type { padding-top: 0; }
  &:last-of-type { border-bottom: none; padding-bottom: 0; }
}

.option-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
}

.option-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-color);
}

.option-hint {
  font-size: 12px;
  color: var(--secondary-text);
  line-height: 1.4;
}

/* ── Toggle switch ─────────────────────────────────────── */
.toggle {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
  margin-top: 1px;

  input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    margin: 0;
  }
}

.toggle-track {
  display: inline-flex;
  align-items: center;
  width: 36px;
  height: 20px;
  background: var(--border-color);
  border-radius: 999px;
  padding: 2px;
  transition: background 0.2s;
  flex-shrink: 0;

  .toggle input:checked ~ & {
    background: var(--primary-color);
  }
}

.toggle-thumb {
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);

  .toggle input:checked ~ .toggle-track & {
    transform: translateX(16px);
  }
}

/* ── Select wrapper (for theme dropdown) ───────────────── */
.select-wrapper select {
  width: auto;
  min-width: 140px;
}

/* ── Instances form ────────────────────────────────────── */
.instance-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.instance-select {
  flex: 1;
  min-width: 0;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.form-row {
  display: flex;
  gap: 16px;
  margin-top: 14px;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--secondary-text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.connection-test {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.status-text {
  font-size: 13px;
  flex: 1;
}

.status-success { color: var(--success-color); }
.status-error   { color: var(--danger-color); }
.status-quiet   { color: var(--secondary-text); }

.empty-state {
  padding: 16px 0 4px;
  color: var(--secondary-text);
  font-size: 13px;
}

/* ── Tag category table ────────────────────────────────── */
.tag-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tag-table-header {
  display: grid;
  grid-template-columns: 1fr 1fr 80px 32px;
  gap: 8px;
  padding: 0 2px 6px;
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--secondary-text);
}

.tag-table-row {
  display: grid;
  grid-template-columns: 1fr 1fr 80px 32px;
  gap: 8px;
  align-items: center;
}

.tag-table-empty {
  padding: 12px 0;
  color: var(--secondary-text);
  font-size: 13px;
}

.color-input {
  font-family: monospace;
}

.color-preview-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-chip {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.color-sample-text {
  font-size: 13px;
  font-weight: 600;
}

/* ── Buttons ───────────────────────────────────────────── */
.btn {
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  &:not(:disabled):hover { opacity: 0.85; }
}

.btn-primary   { background: var(--primary-color); color: #fff; }
.btn-secondary { background: var(--button-bg-color); color: #fff; }
.btn-danger    { background: var(--danger-color); color: #fff; }

.btn-icon {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  color: var(--secondary-text);
  transition: background 0.15s, color 0.15s;

  &:hover { background: var(--danger-color); color: #fff; }
}

.ml-auto { margin-left: auto; }

/* ── Hotkey recorder ───────────────────────────────────── */
.hotkey-recorder {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hotkey-btn {
  min-width: 120px;
  background: var(--button-bg-color);
  color: #fff;
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: center;

  &.recording {
    background: var(--primary-color);
    animation: hotkey-pulse 1s ease-in-out infinite;
  }
}

@keyframes hotkey-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.hotkey-clear {
  width: 30px;
  height: 30px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

/* ── Changelog ─────────────────────────────────────────── */
.changelog-card {
  gap: 0;
}

.changelog-entry {
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color);

  &:first-child { padding-top: 0; }
  &:last-child { border-bottom: none; padding-bottom: 0; }
}

.changelog-version {
  font-size: 16px;
  font-weight: 700;
  color: var(--primary-color);
}

.changelog-date {
  font-size: 12px;
  color: var(--secondary-text);
  margin-bottom: 10px;
}

.changelog-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;

  li {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-color);
  }
}

/* ── Responsive ────────────────────────────────────────── */
@media (max-width: 600px) {
  .page { flex-direction: column; }

  .sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }

  .sidebar-nav { flex-direction: row; padding: 0; overflow-x: auto; }

  .nav-item { padding: 10px 14px; }

  .content { padding: 16px; }

  .form-row { flex-direction: column; gap: 12px; }

  .tag-table-header,
  .tag-table-row { grid-template-columns: 1fr 1fr 56px 32px; }
}
</style>

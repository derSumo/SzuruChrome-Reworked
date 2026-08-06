import fs from "fs-extra";
import type { Manifest } from "webextension-polyfill";
import type PkgType from "../package.json";
import { isDev, port, r } from "../scripts/utils";

export async function getManifest() {
  const pkg = (await fs.readJSON(r("package.json"))) as typeof PkgType;
  const isChromeTarget = process.env.SZ_TARGET === "chrome";

  // Chrome MV3 rejects webRequest blocking (enterprise-only) and warns on the
  // background.scripts fallback that Firefox AMO requires. Strip both for the
  // Chrome Web Store build; Firefox/Waterfox keep the full permission set.
  const permissions = [
    "storage",
    "activeTab",
    "tabs",
    "scripting",
    "contextMenus",
    "declarativeNetRequestWithHostAccess",
    ...(isChromeTarget ? [] : ["webRequest", "webRequestBlocking"]),
  ];

  // Chrome Web Store's upload validator rejects leading "./" in manifest paths
  // (the file is in the zip, but the strict server-side resolver fails). Strip
  // them for the Chrome build; Firefox tolerates either form.
  const p = (path: string) => isChromeTarget ? path.replace(/^\.\//, "") : path;

  const background: Manifest.WebExtensionManifestBackgroundC1Type | Manifest.WebExtensionManifestBackgroundC2Type | Manifest.WebExtensionManifestBackgroundC3Type = isChromeTarget
    ? { service_worker: p("./dist/assets/background.js"), type: "module" }
    : { service_worker: "./dist/assets/background.js", scripts: ["./dist/assets/background.js"], type: "module" } as any;

  const manifest: Manifest.WebExtensionManifest = {
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    version: process.env.VITE_SZ_VERSION || pkg.version,
    manifest_version: 3,
    icons: {
      16: p("./assets/icon-128.png"),
      48: p("./assets/icon-128.png"),
      128: p("./assets/icon-128.png"),
    },
    action: {
      default_title: "__MSG_extName__",
      default_popup: p("./dist/popup/index.html"),
    },
    options_ui: {
      page: p("./dist/options/index.html"),
      open_in_tab: true,
    },
    background,
    permissions,
    commands: {
      "quick-import": {
        suggested_key: {
          default: "Ctrl+Shift+Y",
          mac: "Command+Shift+Y",
        },
        description: "Import the current page",
      },
      "quick-import-link-last": {
        suggested_key: {
          default: "Ctrl+Shift+U",
          mac: "Command+Shift+U",
        },
        description: "Import the current page and link it to the previous import",
      },
    },
  };

  // `webextension-polyfill`'s manifest type still omits this MV3 key. Nothing
  // gets permanent host access at install time; individual booru sources and
  // configured instances are requested from explicit UI actions.
  // The broad optional declaration merely allows a user-entered Szurubooru
  // domain; requests always contain one concrete origin.
  (manifest as any).optional_host_permissions = ["https://*/*", "http://*/*"];

  if (process.env.SZ_GECKO_ID) {
    manifest.browser_specific_settings = {
      gecko: {
        id: `{${process.env.SZ_GECKO_ID}}`,
        strict_min_version: "113.0",
      },
      gecko_android: {
        strict_min_version: "113.0",
      },
    };
  }

  if (isDev) {
    // Firefox caches scripts injected into an already open tab. The dev hook
    // re-injects the latest bundle after navigation, but only on granted source
    // sites (see background/contentScriptHMR.ts).
    manifest.permissions?.push("webNavigation");

    // this is required on dev for Vite script to load
    manifest.content_security_policy = `script-src 'self' http://localhost:${port}; object-src 'self'`;
  }

  return manifest;
}

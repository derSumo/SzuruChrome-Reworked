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
    host_permissions: ["http://*/*", "https://*/*"],
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*"],
        js: [p("./dist/contentScripts/index.global.js")],
      },
    ],
  };

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
    // For content script, as browsers will cache them for each reload,
    // we use a background hook to always inject the latest version.
    delete manifest.content_scripts;
    manifest.permissions?.push("webNavigation");

    // this is required on dev for Vite script to load
    manifest.content_security_policy = `script-src 'self' http://localhost:${port}; object-src 'self'`;
  }

  return manifest;
}

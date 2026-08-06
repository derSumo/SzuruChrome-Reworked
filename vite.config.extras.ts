import { defineConfig } from "vite";
import { sharedConfig } from "./vite.config";
import { isDev, r } from "./scripts/utils";
import packageJson from "./package.json";

// The opt-in listing extras (hover zoom, endless scroll) as their own IIFE.
//
// It has to be a second build, not a chunk of the content script: MV3 content
// scripts cannot be ES modules, an IIFE build cannot code-split, and features
// nobody enabled should not weigh on every page load. The background injects
// this file with `scripting.executeScript` when the config asks for it.
export default defineConfig({
  ...sharedConfig,
  define: {
    __DEV__: isDev,
    "process.env.NODE_ENV": JSON.stringify(isDev ? "development" : "production"),
  },
  build: {
    watch: isDev ? {} : undefined,
    outDir: r("extension/dist/contentScripts"),
    cssCodeSplit: false,
    emptyOutDir: false,
    sourcemap: isDev ? "inline" : false,
    lib: {
      entry: r("src/contentScripts/extras/index.ts"),
      name: `${packageJson.name}Extras`,
      formats: ["iife"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "listingExtras.global.js",
        extend: true,
      },
    },
  },
});

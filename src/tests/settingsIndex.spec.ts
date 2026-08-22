// The settings index is hand-maintained, which normally means it rots the
// first time someone adds a switch and forgets it. These tests parse the tab
// components and the config defaults, so a missing entry is a failing test
// rather than a setting that silently cannot be searched or reset.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_INDEX, readPath, writePath } from "~/options/settingsIndex";
import { defaultConfig } from "~/shared/config";

const TABS_DIR = join(__dirname, "..", "options", "components", "tabs");

/** Every `path="…"` a SettingRow carries, across all tab components. */
function pathsUsedInTabs(): Array<{ path: string; file: string }> {
  const found: Array<{ path: string; file: string }> = [];

  for (const file of readdirSync(TABS_DIR).filter((name) => name.endsWith(".vue"))) {
    const source = readFileSync(join(TABS_DIR, file), "utf8");
    // Matches the static `path="foo.bar"` attribute on <SettingRow>. Bound
    // paths (:path="…") are deliberately not supported — a dynamic path could
    // not be indexed anyway.
    // No `s` flag: it needs target es2018, and `[^>]` already spans newlines,
    // which is all a multi-line <SettingRow …> tag requires.
    for (const match of source.matchAll(/<SettingRow\b[^>]*?\spath="([^"]+)"/g)) {
      found.push({ path: match[1], file });
    }
  }
  return found;
}

describe("settings index", () => {
  const used = pathsUsedInTabs();

  it("finds SettingRows to check", () => {
    // Guards the regex itself: if the components are restructured so that no
    // path is ever matched, the two tests below would pass vacuously.
    expect(used.length).toBeGreaterThan(20);
  });

  it("indexes every setting rendered in a tab", () => {
    const indexed = new Set(SETTINGS_INDEX.map((entry) => entry.path));
    const missing = used.filter((row) => !indexed.has(row.path));
    expect(missing.map((row) => `${row.path} (${row.file})`)).toEqual([]);
  });

  it("has no index entry without a matching SettingRow", () => {
    const rendered = new Set(used.map((row) => row.path));
    const orphans = SETTINGS_INDEX.filter((entry) => !rendered.has(entry.path));
    expect(orphans.map((entry) => entry.path)).toEqual([]);
  });

  it("places each setting on the tab that renders it", () => {
    // "ImportTab.vue" → "import", "OnPageTab.vue" → "onPage".
    const tabOf = (file: string) => {
      const base = file.replace(/Tab\.vue$/, "");
      return base.charAt(0).toLowerCase() + base.slice(1);
    };
    const wrong = used
      .map((row) => ({ row, entry: SETTINGS_INDEX.find((e) => e.path === row.path) }))
      .filter(({ row, entry }) => entry && entry.tab !== tabOf(row.file))
      .map(({ row, entry }) => `${row.path}: index says ${entry!.tab}, rendered in ${row.file}`);
    expect(wrong).toEqual([]);
  });

  it("points every path at a real config default", () => {
    const defaults = defaultConfig();
    const dangling = SETTINGS_INDEX.filter((entry) => readPath(defaults, entry.path) === undefined);
    expect(dangling.map((entry) => entry.path)).toEqual([]);
  });

  it("has unique paths", () => {
    const paths = SETTINGS_INDEX.map((entry) => entry.path);
    expect(paths.length).toBe(new Set(paths).size);
  });
});

describe("path helpers", () => {
  it("reads nested values", () => {
    expect(readPath({ a: { b: { c: 3 } } }, "a.b.c")).toBe(3);
  });

  it("returns undefined instead of throwing on a missing hop", () => {
    expect(readPath({ a: undefined }, "a.b.c")).toBeUndefined();
    expect(readPath(undefined, "a.b")).toBeUndefined();
  });

  it("writes nested values, creating intermediate objects", () => {
    const target: any = {};
    writePath(target, "a.b.c", 7);
    expect(target).toEqual({ a: { b: { c: 7 } } });
  });

  it("round-trips every indexed setting through the defaults", () => {
    const defaults = defaultConfig();
    for (const entry of SETTINGS_INDEX) {
      const target: any = {};
      writePath(target, entry.path, readPath(defaults, entry.path));
      expect(readPath(target, entry.path)).toEqual(readPath(defaults, entry.path));
    }
  });
});

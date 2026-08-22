// ── Sidebar icons ─────────────────────────────────────────────────────
// Inline SVG rather than an icon font or a component per glyph: seven small
// paths do not justify either. `currentColor` throughout so they follow the
// nav item's active/hover colour without extra rules.
//
// Separate from `contentScripts/ui/icons.ts` on purpose — that one is part of
// the bundle injected into every page and must not grow for the options page.

export type OptionsIconName =
  | "import"
  | "tags"
  | "onPage"
  | "connections"
  | "appearance"
  | "data"
  | "about"
  | "search";

const PATHS: Record<OptionsIconName, string> = {
  // Downward arrow into a tray
  import: '<path d="M8 2v7m0 0 3-3m-3 3L5 6" /><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2" />',
  // Price tag
  tags: '<path d="M8.4 2H13a1 1 0 0 1 1 1v4.6a1 1 0 0 1-.3.7l-5.7 5.7a1 1 0 0 1-1.4 0L2.3 9.7a1 1 0 0 1 0-1.4l5.4-6a1 1 0 0 1 .7-.3Z" /><circle cx="10.8" cy="5.2" r="1" />',
  // Browser window with a highlighted thumbnail
  onPage: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M1.5 5.5h13" /><rect x="3.5" y="7.5" width="4" height="4" rx="0.5" />',
  // Two nodes joined by a link
  connections: '<circle cx="4" cy="8" r="2.2" /><circle cx="12" cy="8" r="2.2" /><path d="M6.2 8h3.6" />',
  // Half-filled circle: contrast / theme
  appearance: '<circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 0 0 0 12Z" fill="currentColor" stroke="none" />',
  // Database stack
  data: '<ellipse cx="8" cy="4" rx="5.5" ry="2" /><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4" /><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />',
  // Info circle
  about: '<circle cx="8" cy="8" r="6" /><path d="M8 7.2v4" /><circle cx="8" cy="4.9" r="0.75" fill="currentColor" stroke="none" />',
  // Magnifier
  search: '<circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.5 13.5" />',
};

/** Inline SVG markup for `name`, sized `size`px square. */
export function icon(name: OptionsIconName, size = 16): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true">${PATHS[name]}</svg>`
  );
}

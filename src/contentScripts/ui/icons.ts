// ── Flat icon set for the in-page UI ──────────────────────────────────
// Inline SVG, one line each, drawn on a 16×16 grid with a 1.6 stroke so they
// sit right next to 13px text. No icon font, no sprite sheet: the content
// script must not fetch anything, and the whole set costs less than a request.
//
// `currentColor` throughout — every icon inherits the colour of the control it
// sits in, so hover and disabled states need no icon-specific rules.

function svg(body: string, size = 15): string {
  return `<svg class="szb-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" `
    + `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true">${body}</svg>`;
}

export const ICONS = {
  /** Batch launcher: a post grid. */
  grid: svg(`<rect x="1.8" y="1.8" width="5.4" height="5.4" rx="1.2"/><rect x="8.8" y="1.8" width="5.4" height="5.4" rx="1.2"/>`
    + `<rect x="1.8" y="8.8" width="5.4" height="5.4" rx="1.2"/><rect x="8.8" y="8.8" width="5.4" height="5.4" rx="1.2"/>`),

  /** Select everything on this page. */
  selectAll: svg(`<rect x="1.8" y="1.8" width="12.4" height="12.4" rx="2.4"/><path d="M4.8 8.2l2.2 2.2 4.2-4.4"/>`),

  /** Clear the selection. */
  selectNone: svg(`<rect x="1.8" y="1.8" width="12.4" height="12.4" rx="2.4"/><path d="M5.6 8h4.8"/>`),

  /** Walk the pagination. */
  allPages: svg(`<path d="M4.5 2.2h5l3 3v8.6H4.5z"/><path d="M2 4.6v9.2h7"/>`),

  /** Stop the running scan. */
  stop: svg(`<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2"/>`),

  /** Start the import. */
  play: svg(`<path d="M5 3.2l7 4.8-7 4.8z"/>`),

  /** Empty the basket. */
  trash: svg(`<path d="M2.6 4.4h10.8"/><path d="M6.4 4.4V2.8h3.2v1.6"/><path d="M4 4.4l.7 8.4h6.6l.7-8.4"/>`),

  /** Close / cancel. */
  close: svg(`<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>`),

  /** Search field marker. */
  search: svg(`<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6l3 3"/>`),

  /** Pool field marker. */
  pool: svg(`<path d="M2.4 4.6l5.6-2.4 5.6 2.4-5.6 2.4z"/><path d="M2.4 8l5.6 2.4L13.6 8"/><path d="M2.4 11.4l5.6 2.4 5.6-2.4"/>`),

  /** Collapse the run stack. */
  chevronDown: svg(`<path d="M4 6.2l4 4 4-4"/>`),
  chevronUp: svg(`<path d="M4 9.8l4-4 4 4"/>`),

  /** Import this one post now. */
  upload: svg(`<path d="M8 10.6V2.6"/><path d="M4.8 5.8L8 2.6l3.2 3.2"/><path d="M2.6 10.4v2.2a.8.8 0 00.8.8h9.2a.8.8 0 00.8-.8v-2.2"/>`),

  /** Import and chain to the previous import. */
  link: svg(`<path d="M6.6 9.4a2.8 2.8 0 004 0l2.2-2.2a2.8 2.8 0 10-4-4l-.8.8"/>`
    + `<path d="M9.4 6.6a2.8 2.8 0 00-4 0L3.2 8.8a2.8 2.8 0 104 4l.8-.8"/>`),

  /** Already in the instance. */
  check: svg(`<path d="M3.4 8.4l3 3 6.2-6.6"/>`),

  /** Something went wrong. */
  warn: svg(`<path d="M8 2.6l6 10.8H2z"/><path d="M8 6.6v3"/><path d="M8 11.5v.1"/>`),
} as const;

export type IconName = keyof typeof ICONS;

/** Icon markup by name, empty string for an unknown one (never throws in UI). */
export function icon(name: IconName, size?: number): string {
  const markup = ICONS[name];
  if (!markup) return "";
  return size ? markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`) : markup;
}

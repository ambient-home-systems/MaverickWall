/**
 * The handful of icons the admin uses: Lucide, inlined and first-party.
 *
 * Rule three keeps the served HTML free of a third-party origin, so there is no
 * icon font and nothing is fetched from a CDN — the elements are copied in from
 * the `lucide-static` package (ISC, © Lucide Icons and Contributors, recorded
 * in NOTICE beside the font attributions). Each entry is one icon's children on
 * Lucide's 24 grid, named after its source file so it can be re-sourced;
 * `icon()` wraps them.
 *
 * **They are strokes, not filled outlines**, which is the whole difference from
 * the Material Symbols set they replace and is why `icon()` sets `fill: none`
 * and a stroke width. 1.75 rather than Lucide's own 2: this admin's type is a
 * 650-weight heading over a light body, and a 2px stroke at the 20px these are
 * drawn at reads heavier than any word beside it.
 *
 * The wall's glyphs are a different set for a different medium and are not
 * these — see `src/glyphs.ts`. A stroke vanishes at one bit and reads thin
 * across a kitchen, which is exactly why those are filled silhouettes; this is
 * a pointer's distance on a lit screen, where a stroke is right.
 *
 * ## When an icon is allowed here
 *
 * Only where it is the **primary identifier of a repeated destination or
 * control**: the nav rows, the drawer's own opener, the overflow control, the
 * close control, and the back and chevron affordances. Never beside a heading,
 * never inside a tinted rounded square, and never as decoration in an empty
 * state. `admin-icon-rules.test.ts` holds the last three, and the `.ic` tile
 * they were drawn in — a 34px accent-coloured box on a panel ground, on the
 * Overview's cards and beside two wall names — is gone with them.
 *
 * `arrow` went with it: a right arrow after the word "Open" identifies nothing
 * the word has not already said, which is the same sentence twice and one of
 * them in a language the reader has to learn.
 */
const ICON_PATHS: Readonly<Record<string, string>> = {
  /* layout-dashboard */
  overview:
    '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  /* calendar-days */
  calendars:
    '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/>',
  /* refresh-cw */
  shifts:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  /* list-checks — Lucide's own checklist. What was here was hand-drawn — three items and a
     tick, with a comment saying it had been sized by looking at it at 24px —
     because Material Symbols has no checklist that reads at that size. A set
     drawn by one hand for one grid does not need that, which is the argument
     for swapping the set rather than adding to it. */
  chores:
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
  /* cloud-alert — Weather alerts, so a cloud rather than a bell: what the nav row leads to
     is NWS warnings and the rules that match them. */
  alerts:
    '<path d="M12 12v4"/><path d="M12 20h.01"/><path d="M8.128 16.949A7 7 0 1 1 15.71 8h1.79a1 1 0 0 1 0 9h-1.642"/>',
  /* house */
  homeassistant:
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  /* tv */
  screens:
    '<path d="m17 2-5 5-5-5"/><rect width="20" height="15" x="2" y="7" rx="2"/>',
  /* panels-top-left — The wall editor. A layout, not a screen — `screens` is the hardware. */
  layout:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  /* users */
  people:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  /* server */
  system:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  /* palette */
  palette:
    '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
  /* log-out — Icon-only by design — the nav footer has no room for a word — so the
     glyph is this control's whole identity rather than an ornament on a label. */
  logout:
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  /* store */
  addons:
    '<path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/>',
  /* blocks — An installed module's own nav row, one per module. */
  module:
    '<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2"/><rect x="14" y="2" width="8" height="8" rx="1"/>',
  /* menu — The compact drawer's opener. It is the navigation's own control rather
     than a decoration on it: with no glyph there is no way into the drawer at
     all on a phone. */
  menu:
    '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
  /* arrow-left */
  back:
    '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  /* ellipsis-vertical */
  more:
    '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  /* x */
  close:
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  /* chevron-right — The trailing affordance on a settings row that opens a choice. Direction,
     the same class of thing as `back`, and never a subject. */
  chev:
    '<path d="m9 18 6-6-6-6"/>',
  /* circle-help — Icon-only disclosure beside the orientation control. Its `aria-label` is
     what a screen reader hears; the glyph is what a pointer aims at. */
  help:
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
};

/** An inline icon by key, at a size the caller controls with CSS. */
export function icon(key: string): string {
  const inner = ICON_PATHS[key];
  if (inner === undefined) return '';
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}


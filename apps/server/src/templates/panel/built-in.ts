import type { DisplayTemplate } from '../../api/templates.js';

/**
 * The panel's own default view, as widgets a household can move.
 *
 * A paired e-paper panel with no canvas draws `renderEpaper` — the fixed
 * agenda-and-month layout under a date band — and until now that arrangement
 * was reachable in exactly one way: by having never touched it. There was no
 * card for it, nothing in the gallery resembling it, and the first widget
 * dropped on the canvas replaced it wholesale with an empty page. A household
 * who liked what their panel drew and wanted the month a little larger had to
 * rebuild it from nothing and guess at the proportions.
 *
 * So this is that layout, expressed in the widget vocabulary — and it is an
 * **approximation rather than a copy**, exactly as `classic.ts` is of the
 * retired stacked renderer, for the same reason and with the same honesty. Two
 * things genuinely differ and both are worth knowing before picking it:
 *
 *  - the built-in header is a solid inverted band the freeform renderer has no
 *    widget for, so a Clock stands in for it — the same weekday, day and month,
 *    drawn as type on the panel's ground rather than knocked out of ink;
 *  - the built-in blocks carry the renderer's own margin *and* the frame's,
 *    while widget boxes tile the canvas and the only gutter is the inset each
 *    widget already draws (`classic.ts`'s rule — three stacked whitespaces is
 *    how a third of a wall became gutter).
 *
 * The proportions are the built-in layout's own, read off `epaperBlocks` at
 * every panel size this project supports rather than picked. Landscape splits
 * at 0.54 of the width — `epaperBlocks` uses exactly that constant, and it is
 * the agenda that gets the larger share because event titles need width more
 * than a grid does. Portrait is a band: `epaperBlocks` sizes that split from
 * what square cells need, so it moves with the panel (the agenda measures 0.26
 * of the height on a 13.3" panel and 0.37 on a 7.5" one); a template has one
 * number, and 0.33 is inside that range and is also `classic.ts`'s own agenda
 * band, so the two surfaces do not disagree about what an agenda is worth.
 *
 * Reset is untouched and still returns the panel to the *real* built-in
 * renderer: this is a starting point, not a replacement for it.
 */

/** The landscape split `epaperBlocks` uses, so the card cannot drift from it. */
const LAND_AGENDA_W = 0.54;
/** The date band, as a share of the panel's height. */
const LAND_HEAD_H = 0.15;
const PORT_HEAD_H = 0.1;
/** The portrait agenda band — `classic.ts`'s number, inside the built-in range. */
const PORT_AGENDA_H = 0.33;

const AGENDA = { mode: 'list' } as const;
const MONTH = { mode: 'month' } as const;

export const template: DisplayTemplate = {
  id: 'panel-built-in',
  // Named for the difference rather than for the likeness: the add page's
  // "Starting layout" lists this card directly under the real built-in view,
  // and two options both reading "Built-in" is a choice nobody can make.
  name: 'Built-in, as boxes',
  category: 'home',
  blurb: 'What this panel draws out of the box — the date, what is on today, and the month — as boxes you can move.',
  portrait: {
    aspect: 0.6,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: PORT_HEAD_H },
      { type: 'calendar', x: 0, y: PORT_HEAD_H, w: 1, h: PORT_AGENDA_H, config: AGENDA },
      {
        type: 'calendar',
        x: 0,
        y: PORT_HEAD_H + PORT_AGENDA_H,
        w: 1,
        h: 1 - PORT_HEAD_H - PORT_AGENDA_H,
        config: MONTH,
      },
    ],
  },
  landscape: {
    aspect: 1.6667,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: LAND_HEAD_H },
      {
        type: 'calendar',
        x: 0,
        y: LAND_HEAD_H,
        w: LAND_AGENDA_W,
        h: 1 - LAND_HEAD_H,
        config: AGENDA,
      },
      {
        type: 'calendar',
        x: LAND_AGENDA_W,
        y: LAND_HEAD_H,
        w: 1 - LAND_AGENDA_W,
        h: 1 - LAND_HEAD_H,
        config: MONTH,
      },
    ],
  },
};

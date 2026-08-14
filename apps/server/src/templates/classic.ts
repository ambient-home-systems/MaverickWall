import type { DisplayTemplate } from '../api/templates.js';

/**
 * The Classic layout: the kitchen calendar Maverick Wall has always drawn, now
 * expressed as freeform widgets rather than a bespoke stacked renderer.
 *
 * This is the universal default — what a new or untouched display shows, and
 * what every wall was migrated onto when the "auto" stacked layout was retired
 * (see `backfillClassic`). So, unlike every other template, it sets **no theme
 * and no background**: it must keep whatever theme the wall already has, the way
 * the old stacked layout did. It is a faithful *approximation* of that layout —
 * the clock and today's rota up top, the forecast, an agenda of what's next, and
 * the month grid as the hero — built only from widgets a household could place by
 * hand, so it is a real starting point they can rearrange, not a special case.
 */
export const template: DisplayTemplate = {
  id: 'classic',
  name: 'Classic',
  category: 'home',
  blurb: 'The standard kitchen calendar — clock, rota, weather, what’s next and the month.',
  // No theme, no background: Classic inherits the wall's own theme (see above).
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.03, w: 0.5, h: 0.1 },
      { type: 'shift', x: 0.57, y: 0.03, w: 0.38, h: 0.12 },
      { type: 'weather', x: 0.05, y: 0.16, w: 0.9, h: 0.12 },
      { type: 'calendar', x: 0.05, y: 0.3, w: 0.9, h: 0.2, config: { mode: 'list', count: 8 } },
      {
        type: 'calendar',
        x: 0.05,
        y: 0.52,
        w: 0.9,
        h: 0.45,
        config: { mode: 'month', cellEvents: 'pills' },
      },
    ],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.06, w: 0.26, h: 0.16 },
      { type: 'shift', x: 0.04, y: 0.24, w: 0.26, h: 0.16 },
      { type: 'weather', x: 0.04, y: 0.42, w: 0.26, h: 0.22 },
      { type: 'calendar', x: 0.04, y: 0.66, w: 0.26, h: 0.3, config: { mode: 'list', count: 6 } },
      {
        type: 'calendar',
        x: 0.34,
        y: 0.06,
        w: 0.62,
        h: 0.9,
        config: { mode: 'month', cellEvents: 'pills' },
      },
    ],
  },
};

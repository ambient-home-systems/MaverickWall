import type { DisplayTemplate } from '../../api/templates.js';

/**
 * Seven day columns — the week at a glance, for a panel somebody plans against
 * rather than checks.
 *
 * Landscape only, in effect: the portrait canvas is still authored (a template
 * must carry both, so a panel started from one is never in the letterbox case)
 * but it draws the same week in a taller box, where seven columns of a narrow
 * panel are seven narrow columns. The wall's `weekColumnsFit` swaps an agenda
 * in below its own boundary; the panel has no such fallback and draws the week
 * it was asked for, so this card says landscape in its blurb rather than
 * quietly behaving differently on a panel hung the other way.
 */
export const template: DisplayTemplate = {
  id: 'panel-week',
  name: 'Week ahead',
  category: 'home',
  blurb: 'Seven day columns across the panel. Best on a panel hung landscape, where each day gets real width.',
  portrait: {
    aspect: 0.6,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.1 },
      { type: 'calendar', x: 0, y: 0.1, w: 1, h: 0.9, config: { mode: 'week' } },
    ],
  },
  landscape: {
    aspect: 1.6667,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.14 },
      { type: 'calendar', x: 0, y: 0.14, w: 1, h: 0.86, config: { mode: 'week' } },
    ],
  },
};

import type { DisplayTemplate } from '../../api/templates.js';

/**
 * The month, and almost nothing else — the fridge calendar an e-paper panel is
 * usually bought to be.
 *
 * A grid *fills* its box rather than being drawn at a size and centred in one,
 * so height here is rows of event names on the glass: giving the month 0.86 of
 * a 7.5" panel instead of the built-in layout's 0.83-of-half is the difference
 * between a cell that names one thing and a cell that names two.
 *
 * `cellEvents` is left absent rather than set to `text`. Absence *is* names on
 * both renderers, and writing the value would put a stored key on every panel
 * started from this card for no change in what it draws — the schema's own
 * "absence means the default" rule, which is what keeps a canvas's config
 * byte-identical to the one before a key existed.
 */
export const template: DisplayTemplate = {
  id: 'panel-month',
  name: 'Month',
  category: 'home',
  blurb: 'The month grid over the whole panel, under the date. The most names a panel this size can show.',
  portrait: {
    aspect: 0.6,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.09, config: { align: 'center' } },
      { type: 'calendar', x: 0, y: 0.09, w: 1, h: 0.91, config: { mode: 'month' } },
    ],
  },
  landscape: {
    aspect: 1.6667,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.14, config: { align: 'center' } },
      { type: 'calendar', x: 0, y: 0.14, w: 1, h: 0.86, config: { mode: 'month' } },
    ],
  },
};

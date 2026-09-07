import type { DisplayTemplate } from '../../api/templates.js';

/**
 * What is on, large — the panel by the door rather than the one on the fridge.
 *
 * The whole body is one agenda, so every row is drawn at the size the reader
 * needs and the panel gives up *days* when it runs out rather than points. The
 * counts are deliberately generous and are a ceiling rather than a promise: an
 * agenda draws `min(what was asked for, what its box affords)`, so a 7.5" panel
 * settles at four or five of them and a 13.3" one keeps the lot. Asking for
 * more than fits costs nothing; asking for less is a cap a household cannot see
 * the reason for, which is the fault `AGENDA_COUNT_DEFAULT` was left standing
 * in for on a wall until its box could measure itself.
 */
export const template: DisplayTemplate = {
  id: 'panel-agenda',
  name: 'What is on',
  category: 'home',
  blurb: 'Today and the days after it, filling the panel — the largest this calendar is ever drawn.',
  portrait: {
    aspect: 0.6,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.14 },
      { type: 'calendar', x: 0, y: 0.14, w: 1, h: 0.86, config: { mode: 'list', count: 14 } },
    ],
  },
  landscape: {
    aspect: 1.6667,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.18 },
      { type: 'calendar', x: 0, y: 0.18, w: 1, h: 0.82, config: { mode: 'list', count: 12 } },
    ],
  },
};

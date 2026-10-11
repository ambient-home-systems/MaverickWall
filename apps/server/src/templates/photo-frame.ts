import type { DisplayTemplate } from '../api/templates.js';

/**
 * A picture with the day floating on it (plan item M4.9): the clock, the
 * forecast and a short agenda as small cards, and the rest of the wall the
 * painting behind them.
 *
 * The picture is a rotation of the bundled paintings, an hour each, and it
 * keeps the wall's theme for Classic's reason — pressing a layout is not
 * asking to have the kitchen repainted. A painting is drawn for one tone's
 * ink, so the rotation is authored dark and `applyTemplate` turns it to the
 * light paintings on a light theme (`backgroundForTone`); the gallery's card
 * shows it as authored.
 *
 * The cards are what every widget can already be: rounded, casting the
 * theme's own shadow token, and on the Soft ground every widget gets over a
 * picture unless the household has chosen another. Nothing here tiles —
 * the boxes are where the picture is not, which is the point of the layout.
 * The agenda is a list of four, because a short one is what fits a card.
 */
const CARD = { corners: 'rounded', shadow: true } as const;
const AGENDA = { ...CARD, mode: 'list', count: 4 } as const;
const PAINTINGS = { type: 'rotation', collection: 'painting', tone: 'dark', every: 60, between: 'fade' } as const;

export const template: DisplayTemplate = {
  id: 'photo-frame',
  name: 'Photo Frame',
  category: 'home',
  blurb: 'A painting a day — well, an hour — with the time, the weather and what’s next floating on it.',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.04, w: 0.56, h: 0.13, config: CARD },
      { type: 'weather', x: 0.64, y: 0.04, w: 0.31, h: 0.13, config: CARD },
      { type: 'calendar', x: 0.05, y: 0.69, w: 0.9, h: 0.27, config: AGENDA },
    ],
    background: PAINTINGS,
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.06, w: 0.27, h: 0.22, config: CARD },
      { type: 'weather', x: 0.04, y: 0.31, w: 0.27, h: 0.22, config: CARD },
      { type: 'calendar', x: 0.69, y: 0.06, w: 0.27, h: 0.6, config: AGENDA },
    ],
    background: PAINTINGS,
  },
};

import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'countdown',
  name: 'Countdown',
  category: 'home',
  blurb: 'A big countdown over a month grid — for the one date the household is waiting on.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'countdown', x: 0, y: 0, w: 1, h: 0.45, config: { title: 'Summer holiday' } },
      { type: 'calendar', x: 0, y: 0.45, w: 1, h: 0.55, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#131A26', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'countdown', x: 0, y: 0, w: 0.5, h: 1, config: { title: 'Summer holiday' } },
      { type: 'calendar', x: 0.5, y: 0, w: 0.5, h: 1, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#131A26', angle: 165 },
  },
};

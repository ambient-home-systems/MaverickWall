import type { DisplayTemplate } from '../api/templates.js';

/**
 * A single number nobody can miss, over the month it is counting down within.
 * Set the date in the countdown widget's options after applying. Designed for
 * the Glance (near-black, white) theme.
 */
export const template: DisplayTemplate = {
  id: 'countdown',
  name: 'Countdown',
  category: 'home',
  blurb: 'A big countdown over a month grid — for the one date the household is waiting on.',
  theme: 'glance',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'countdown', x: 0.05, y: 0.05, w: 0.9, h: 0.4, config: { title: 'Summer holiday' } },
      { type: 'calendar', x: 0.05, y: 0.5, w: 0.9, h: 0.46, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#131A26', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'countdown', x: 0.05, y: 0.12, w: 0.42, h: 0.76, config: { title: 'Summer holiday' } },
      { type: 'calendar', x: 0.52, y: 0.06, w: 0.44, h: 0.88, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#131A26', angle: 165 },
  },
};

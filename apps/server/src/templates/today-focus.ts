import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'today-focus',
  name: 'Today Focus',
  category: 'home',
  blurb: 'A large upcoming-agenda with a weather strip and a quiet clock.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.1 },
      { type: 'weather', x: 0, y: 0.1, w: 1, h: 0.14 },
      { type: 'calendar', x: 0, y: 0.24, w: 1, h: 0.76, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F0ECE2', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.34, h: 0.35 },
      { type: 'weather', x: 0, y: 0.35, w: 0.34, h: 0.65 },
      { type: 'calendar', x: 0.34, y: 0, w: 0.66, h: 1, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F0ECE2', angle: 160 },
  },
};

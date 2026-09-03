import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'team-week',
  name: 'Team Week',
  category: 'office',
  blurb: 'The week as day columns, with the time and weather kept small.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.1 },
      { type: 'weather', x: 0, y: 0.1, w: 1, h: 0.14 },
      { type: 'calendar', x: 0, y: 0.24, w: 1, h: 0.76, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#EEF2F4', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.34, h: 0.28 },
      { type: 'weather', x: 0, y: 0.28, w: 0.34, h: 0.72 },
      { type: 'calendar', x: 0.34, y: 0, w: 0.66, h: 1, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#EEF2F4', angle: 160 },
  },
};

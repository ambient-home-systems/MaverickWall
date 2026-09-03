import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'reception',
  name: 'Reception',
  category: 'office',
  blurb: 'A welcoming clock and weather with a notes panel for the day’s message.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.26 },
      { type: 'weather', x: 0, y: 0.26, w: 1, h: 0.2 },
      { type: 'notes', x: 0, y: 0.46, w: 1, h: 0.54 },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F2EEE4', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.46, h: 0.5 },
      { type: 'weather', x: 0, y: 0.5, w: 0.46, h: 0.5 },
      { type: 'notes', x: 0.46, y: 0, w: 0.54, h: 1 },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F2EEE4', angle: 160 },
  },
};

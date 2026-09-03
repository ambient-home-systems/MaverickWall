import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'sky-week',
  name: 'Sky Week',
  category: 'home',
  blurb: 'A month-and-weather rail beside the week as vertical day columns with colour-coded events.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'calendar', x: 0, y: 0, w: 0.5, h: 0.27 },
      { type: 'weather', x: 0.5, y: 0, w: 0.5, h: 0.27 },
      { type: 'calendar', x: 0, y: 0.27, w: 1, h: 0.73, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#EAF1F6', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'calendar', x: 0, y: 0, w: 0.26, h: 0.5 },
      { type: 'weather', x: 0, y: 0.5, w: 0.26, h: 0.5 },
      { type: 'calendar', x: 0.26, y: 0, w: 0.74, h: 1, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#EAF1F6', angle: 165 },
  },
};

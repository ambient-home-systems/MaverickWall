import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'sky-calendar',
  name: 'Sky Calendar',
  category: 'home',
  blurb: 'A bright, near-full-bleed month with colour-coded event pills per family member.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.52, h: 0.12 },
      { type: 'weather', x: 0.52, y: 0, w: 0.48, h: 0.12 },
      { type: 'calendar', x: 0, y: 0.12, w: 1, h: 0.88, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#E8EFF5', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.4, h: 0.15 },
      { type: 'weather', x: 0.4, y: 0, w: 0.6, h: 0.15 },
      { type: 'calendar', x: 0, y: 0.15, w: 1, h: 0.85, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#E8EFF5', angle: 165 },
  },
};

import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'family-hub',
  name: 'Family Hub',
  category: 'home',
  blurb: 'Month grid, clock, weather and a to-do list — the classic kitchen calendar.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.56, h: 0.13 },
      { type: 'weather', x: 0.56, y: 0, w: 0.44, h: 0.13 },
      { type: 'calendar', x: 0, y: 0.13, w: 1, h: 0.56, config: { cellEvents: 'pills' } },
      { type: 'todo', x: 0, y: 0.69, w: 1, h: 0.31 },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#171F29', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.35, h: 0.2 },
      { type: 'weather', x: 0, y: 0.2, w: 0.35, h: 0.35 },
      { type: 'todo', x: 0, y: 0.55, w: 0.35, h: 0.45 },
      { type: 'calendar', x: 0.35, y: 0, w: 0.65, h: 1, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#171F29', angle: 160 },
  },
};

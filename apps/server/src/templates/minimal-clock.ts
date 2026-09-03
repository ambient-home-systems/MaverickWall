import type { DisplayTemplate } from '../api/templates.js';

/*
 * Tiled: the two boxes share an edge and reach the canvas edge. Minimal Clock
 * stays airy without a margin doing the work — the clock centres in its own box,
 * so the breathing room is the widget's, not dead wall.
 */
export const template: DisplayTemplate = {
  id: 'minimal-clock',
  name: 'Minimal Clock',
  category: 'home',
  blurb: 'A big clock with the day’s weather — answers two questions and stops.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.66 },
      { type: 'weather', x: 0, y: 0.66, w: 1, h: 0.34 },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#0F1319', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.62, h: 1 },
      { type: 'weather', x: 0.62, y: 0, w: 0.38, h: 1 },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#0F1319', angle: 160 },
  },
};

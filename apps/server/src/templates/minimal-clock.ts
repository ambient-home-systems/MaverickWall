import type { DisplayTemplate } from '../api/templates.js';

/**
 * The time, big, with the day's weather beneath it — a hallway or bedside wall
 * that answers two questions and stops. Designed for the Panels theme.
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
      { type: 'clock', x: 0.06, y: 0.28, w: 0.88, h: 0.26 },
      { type: 'weather', x: 0.06, y: 0.6, w: 0.88, h: 0.16 },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#0F1319', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.24, w: 0.58, h: 0.44 },
      { type: 'weather', x: 0.66, y: 0.3, w: 0.3, h: 0.4 },
    ],
    background: { type: 'gradient', from: '#07080A', to: '#0F1319', angle: 160 },
  },
};

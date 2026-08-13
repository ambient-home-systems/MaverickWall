import type { DisplayTemplate } from '../api/templates.js';

/**
 * The classic kitchen wall: the month at a glance, the time, the weather, and
 * the chores. Designed for the Board (dark, amber) default theme.
 */
export const template: DisplayTemplate = {
  id: 'family-hub',
  name: 'Family Hub',
  category: 'home',
  blurb: 'Month grid, clock, weather and a to-do list — the classic kitchen calendar.',
  theme: 'board',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.03, w: 0.5, h: 0.11 },
      { type: 'weather', x: 0.56, y: 0.03, w: 0.39, h: 0.13 },
      { type: 'calendar', x: 0.05, y: 0.19, w: 0.9, h: 0.49 },
      { type: 'todo', x: 0.05, y: 0.7, w: 0.9, h: 0.27 },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#171F29', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.06, w: 0.28, h: 0.17 },
      { type: 'weather', x: 0.04, y: 0.26, w: 0.28, h: 0.3 },
      { type: 'todo', x: 0.04, y: 0.6, w: 0.28, h: 0.34 },
      { type: 'calendar', x: 0.35, y: 0.06, w: 0.61, h: 0.88 },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#171F29', angle: 160 },
  },
};

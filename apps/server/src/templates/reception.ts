import type { DisplayTemplate } from '../api/templates.js';

/**
 * A welcoming clock and weather with a notes panel for the day's message —
 * lobby-friendly. Designed for the Paper Almanac theme.
 */
export const template: DisplayTemplate = {
  id: 'reception',
  name: 'Reception',
  category: 'office',
  blurb: 'A welcoming clock and weather with a notes panel for the day’s message.',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.06, w: 0.9, h: 0.2 },
      { type: 'weather', x: 0.05, y: 0.3, w: 0.9, h: 0.16 },
      { type: 'notes', x: 0.05, y: 0.5, w: 0.9, h: 0.45 },
    ],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.1, w: 0.44, h: 0.4 },
      { type: 'weather', x: 0.04, y: 0.54, w: 0.44, h: 0.36 },
      { type: 'notes', x: 0.5, y: 0.08, w: 0.46, h: 0.84 },
    ],
  },
};

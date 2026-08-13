import type { DisplayTemplate } from '../api/templates.js';

/**
 * The whole week as day columns, with the time and weather kept small — a
 * shared-team board for a studio wall. Designed for the Paper Almanac theme.
 */
export const template: DisplayTemplate = {
  id: 'team-week',
  name: 'Team Week',
  category: 'office',
  blurb: 'The week as day columns, with the time and weather kept small.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.03, w: 0.55, h: 0.08 },
      { type: 'weather', x: 0.05, y: 0.13, w: 0.9, h: 0.13 },
      { type: 'calendar', x: 0.05, y: 0.29, w: 0.9, h: 0.68, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#EEF2F4', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.06, w: 0.3, h: 0.16 },
      { type: 'weather', x: 0.04, y: 0.25, w: 0.3, h: 0.28 },
      { type: 'calendar', x: 0.37, y: 0.06, w: 0.59, h: 0.88, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#EEF2F4', angle: 160 },
  },
};

import type { DisplayTemplate } from '../api/templates.js';

/**
 * One big agenda for the day, a weather strip, a quiet clock — for a household
 * that lives off "what's next". Designed for the Paper Almanac theme.
 */
export const template: DisplayTemplate = {
  id: 'today-focus',
  name: 'Today Focus',
  category: 'home',
  blurb: 'A large upcoming-agenda with a weather strip and a quiet clock.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.03, w: 0.6, h: 0.09 },
      { type: 'weather', x: 0.05, y: 0.14, w: 0.9, h: 0.14 },
      { type: 'calendar', x: 0.05, y: 0.31, w: 0.9, h: 0.66, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F0ECE2', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.07, w: 0.3, h: 0.3 },
      { type: 'weather', x: 0.04, y: 0.4, w: 0.3, h: 0.53 },
      { type: 'calendar', x: 0.37, y: 0.06, w: 0.59, h: 0.88, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#FBFAF6', to: '#F0ECE2', angle: 160 },
  },
};

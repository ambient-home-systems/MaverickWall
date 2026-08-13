import type { DisplayTemplate } from '../api/templates.js';

/**
 * A Skylight-style month view: a near-full-bleed calendar with colour-coded
 * event pills per person, and a slim header carrying the day and weather. The
 * front door for a household replacing a commercial family calendar. Designed
 * for the Paper Almanac (white) theme, though it holds on any.
 */
export const template: DisplayTemplate = {
  id: 'sky-calendar',
  name: 'Sky Calendar',
  category: 'home',
  blurb: 'A bright, near-full-bleed month with colour-coded event pills per family member.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.03, w: 0.47, h: 0.09 },
      { type: 'weather', x: 0.53, y: 0.03, w: 0.43, h: 0.09 },
      { type: 'calendar', x: 0.04, y: 0.15, w: 0.92, h: 0.82, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#E8EFF5', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.03, y: 0.05, w: 0.4, h: 0.12 },
      { type: 'weather', x: 0.63, y: 0.05, w: 0.34, h: 0.12 },
      { type: 'calendar', x: 0.03, y: 0.21, w: 0.94, h: 0.76, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#E8EFF5', angle: 165 },
  },
};

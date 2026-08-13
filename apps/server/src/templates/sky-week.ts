import type { DisplayTemplate } from '../api/templates.js';

/**
 * Skylight's other signature view: a left rail with the month at a glance and
 * the weather, beside the week as vertical day columns with colour-coded
 * events. Today's column is picked out. Designed for the Paper Almanac theme.
 */
export const template: DisplayTemplate = {
  id: 'sky-week',
  name: 'Sky Week',
  category: 'home',
  blurb: 'A month-and-weather rail beside the week as vertical day columns with colour-coded events.',
  theme: 'almanac',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'calendar', x: 0.04, y: 0.03, w: 0.45, h: 0.24 },
      { type: 'weather', x: 0.51, y: 0.03, w: 0.45, h: 0.24 },
      { type: 'calendar', x: 0.04, y: 0.3, w: 0.92, h: 0.67, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#EAF1F6', angle: 165 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'calendar', x: 0.03, y: 0.05, w: 0.22, h: 0.46 },
      { type: 'weather', x: 0.03, y: 0.54, w: 0.22, h: 0.41 },
      { type: 'calendar', x: 0.27, y: 0.05, w: 0.7, h: 0.9, config: { mode: 'week' } },
    ],
    background: { type: 'gradient', from: '#FFFFFF', to: '#EAF1F6', angle: 165 },
  },
};

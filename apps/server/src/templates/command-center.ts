import type { DisplayTemplate } from '../api/templates.js';

/**
 * Calendar up top, the house and the rota underneath — the wall for a home that
 * runs on shifts and sensors. Designed for the Kitchen Slate theme.
 */
export const template: DisplayTemplate = {
  id: 'command-center',
  name: 'Command Center',
  category: 'home',
  blurb: 'A month grid over Home Assistant readings and the shift rota.',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.03, w: 0.9, h: 0.08 },
      { type: 'calendar', x: 0.05, y: 0.13, w: 0.9, h: 0.46 },
      { type: 'homeassistant', x: 0.05, y: 0.62, w: 0.43, h: 0.35 },
      { type: 'shift', x: 0.51, y: 0.62, w: 0.44, h: 0.35 },
    ],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'calendar', x: 0.04, y: 0.06, w: 0.57, h: 0.88 },
      { type: 'clock', x: 0.64, y: 0.06, w: 0.32, h: 0.17 },
      { type: 'homeassistant', x: 0.64, y: 0.27, w: 0.32, h: 0.33 },
      { type: 'shift', x: 0.64, y: 0.63, w: 0.32, h: 0.31 },
    ],
  },
};

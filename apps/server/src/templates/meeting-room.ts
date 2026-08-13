import type { DisplayTemplate } from '../api/templates.js';

/**
 * Today's bookings, large, with an oversized clock — the panel outside a room
 * that says what is on now and next. Designed for the Panels theme.
 */
export const template: DisplayTemplate = {
  id: 'meeting-room',
  name: 'Meeting Room',
  category: 'office',
  blurb: 'Today’s schedule, large, with an oversized clock — what’s on now and next.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0.05, y: 0.04, w: 0.9, h: 0.18 },
      { type: 'calendar', x: 0.05, y: 0.27, w: 0.9, h: 0.7, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#181009', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0.04, y: 0.1, w: 0.42, h: 0.52 },
      { type: 'calendar', x: 0.5, y: 0.06, w: 0.46, h: 0.88, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#181009', angle: 160 },
  },
};

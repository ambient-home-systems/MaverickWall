import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'meeting-room',
  name: 'Meeting Room',
  category: 'office',
  blurb: 'Today’s schedule, large, with an oversized clock — what’s on now and next.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.22 },
      { type: 'calendar', x: 0, y: 0.22, w: 1, h: 0.78, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#181009', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 0.46, h: 1 },
      { type: 'calendar', x: 0.46, y: 0, w: 0.54, h: 1, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#181009', angle: 160 },
  },
};

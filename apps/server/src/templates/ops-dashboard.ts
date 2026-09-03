import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'ops-dashboard',
  name: 'Ops Dashboard',
  category: 'office',
  blurb: 'Home Assistant readings and a module panel over a month grid.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'homeassistant', x: 0, y: 0, w: 1, h: 0.28 },
      { type: 'external', x: 0, y: 0.28, w: 1, h: 0.24 },
      { type: 'calendar', x: 0, y: 0.52, w: 1, h: 0.48, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#191713', to: '#23201A', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'homeassistant', x: 0, y: 0, w: 0.36, h: 0.5 },
      { type: 'external', x: 0, y: 0.5, w: 0.36, h: 0.5 },
      { type: 'calendar', x: 0.36, y: 0, w: 0.64, h: 1, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#191713', to: '#23201A', angle: 160 },
  },
};

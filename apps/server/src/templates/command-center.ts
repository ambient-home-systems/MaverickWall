import type { DisplayTemplate } from '../api/templates.js';

/* Tiled: the rectangles share edges and reach the canvas edge (see chore-board). */
export const template: DisplayTemplate = {
  id: 'command-center',
  name: 'Command Center',
  category: 'home',
  blurb: 'A month grid over Home Assistant readings and the shift rota.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.1 },
      { type: 'calendar', x: 0, y: 0.1, w: 1, h: 0.5, config: { cellEvents: 'pills' } },
      { type: 'homeassistant', x: 0, y: 0.6, w: 0.5, h: 0.4 },
      { type: 'shift', x: 0.5, y: 0.6, w: 0.5, h: 0.4 },
    ],
    background: { type: 'gradient', from: '#191713', to: '#262016', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'calendar', x: 0, y: 0, w: 0.6, h: 1, config: { cellEvents: 'pills' } },
      { type: 'clock', x: 0.6, y: 0, w: 0.4, h: 0.2 },
      { type: 'homeassistant', x: 0.6, y: 0.2, w: 0.4, h: 0.45 },
      { type: 'shift', x: 0.6, y: 0.65, w: 0.4, h: 0.35 },
    ],
    background: { type: 'gradient', from: '#191713', to: '#262016', angle: 160 },
  },
};

import type { DisplayTemplate } from '../api/templates.js';

/**
 * Home Assistant readings and a module panel over the calendar — for a workshop
 * or maker-space status wall. Pick the module in its widget's options after
 * applying. Designed for the Kitchen Slate theme.
 */
export const template: DisplayTemplate = {
  id: 'ops-dashboard',
  name: 'Ops Dashboard',
  category: 'office',
  blurb: 'Home Assistant readings and a module panel over a month grid.',
  theme: 'slate',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'homeassistant', x: 0.05, y: 0.03, w: 0.9, h: 0.24 },
      { type: 'external', x: 0.05, y: 0.29, w: 0.9, h: 0.2 },
      { type: 'calendar', x: 0.05, y: 0.51, w: 0.9, h: 0.46, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#191713', to: '#23201A', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'homeassistant', x: 0.04, y: 0.06, w: 0.3, h: 0.42 },
      { type: 'external', x: 0.04, y: 0.52, w: 0.3, h: 0.42 },
      { type: 'calendar', x: 0.37, y: 0.06, w: 0.59, h: 0.88, config: { cellEvents: 'pills' } },
    ],
    background: { type: 'gradient', from: '#191713', to: '#23201A', angle: 160 },
  },
};

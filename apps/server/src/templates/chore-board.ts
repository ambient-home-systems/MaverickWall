import type { DisplayTemplate } from '../api/templates.js';

/**
 * To-dos and notes side by side with a short agenda — the fridge door, made
 * legible from across the room. Designed for the Board theme.
 */
export const template: DisplayTemplate = {
  id: 'chore-board',
  name: 'Chore Board',
  category: 'home',
  blurb: 'A to-do list and notes beside a short agenda — the fridge door, legible from the doorway.',
  theme: 'board',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'calendar', x: 0.05, y: 0.03, w: 0.9, h: 0.3, config: { mode: 'list' } },
      { type: 'todo', x: 0.05, y: 0.36, w: 0.44, h: 0.61 },
      { type: 'notes', x: 0.51, y: 0.36, w: 0.44, h: 0.61 },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#141A22', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'todo', x: 0.04, y: 0.06, w: 0.29, h: 0.88 },
      { type: 'notes', x: 0.35, y: 0.06, w: 0.29, h: 0.88 },
      { type: 'calendar', x: 0.67, y: 0.06, w: 0.29, h: 0.88, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#141A22', angle: 160 },
  },
};

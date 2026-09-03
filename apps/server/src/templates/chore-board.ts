import type { DisplayTemplate } from '../api/templates.js';

/*
 * The rectangles tile the canvas — they share edges and reach the canvas edge,
 * so the only gutter is the space between two boxes' content (twice the `.fw`
 * padding). The same rework Classic got, and the reason: a 5% margin plus a gap
 * plus the box padding is three whitespaces where one will do.
 */
export const template: DisplayTemplate = {
  id: 'chore-board',
  name: 'Chore Board',
  category: 'home',
  blurb: 'A to-do list and notes beside a short agenda — the fridge door, legible from the doorway.',
  theme: 'panels',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'calendar', x: 0, y: 0, w: 1, h: 0.33, config: { mode: 'list' } },
      { type: 'todo', x: 0, y: 0.33, w: 0.5, h: 0.67 },
      { type: 'notes', x: 0.5, y: 0.33, w: 0.5, h: 0.67 },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#141A22', angle: 160 },
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'todo', x: 0, y: 0, w: 0.34, h: 1 },
      { type: 'notes', x: 0.34, y: 0, w: 0.33, h: 1 },
      { type: 'calendar', x: 0.67, y: 0, w: 0.33, h: 1, config: { mode: 'list' } },
    ],
    background: { type: 'gradient', from: '#0B0E11', to: '#141A22', angle: 160 },
  },
};

import type { DisplayTemplate } from '../../api/templates.js';

/**
 * The chore board beside what is on — the panel that hangs where the jobs get
 * argued about.
 *
 * A panel is read-only: `allow_chores` puts a real button on a *browser* wall
 * and an e-paper panel has no input at all, so this board says what is due and
 * what is done and offers no way to tick one off. That is a property of the
 * hardware rather than of this card, and the Chores screen is where a household
 * does the ticking.
 *
 * **A household with no chores defined gets a hole here**, and that is worth
 * stating rather than working around: `keepWidgetsWithSomethingToSay` drops a
 * widget with nothing behind it, and a free-form canvas has nothing to close
 * the gap with. The same is true of the wall's own Chore Board card, and the
 * answer is the same — picking this is asking for a chore board, and the
 * editor flags a box it knows will not draw.
 */
export const template: DisplayTemplate = {
  id: 'panel-chores',
  name: 'Chores & what is on',
  category: 'home',
  blurb: 'Today’s chores beside the next few days. Needs chores set up — the board is empty without them.',
  portrait: {
    aspect: 0.6,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.1 },
      { type: 'calendar', x: 0, y: 0.1, w: 1, h: 0.42, config: { mode: 'list', count: 6 } },
      { type: 'chores', x: 0, y: 0.52, w: 1, h: 0.48 },
    ],
  },
  landscape: {
    aspect: 1.6667,
    widgets: [
      { type: 'clock', x: 0, y: 0, w: 1, h: 0.15 },
      { type: 'calendar', x: 0, y: 0.15, w: 0.5, h: 0.85, config: { mode: 'list', count: 8 } },
      { type: 'chores', x: 0.5, y: 0.15, w: 0.5, h: 0.85 },
    ],
  },
};

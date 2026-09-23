import type { DisplayTemplate } from '../api/templates.js';
import {
  CLASSIC_LANDSCAPE_CALENDARS,
  CLASSIC_LANDSCAPE_STRIP_H,
  CLASSIC_PORTRAIT_CALENDARS,
  CLASSIC_PORTRAIT_STRIP_H,
} from './classic.js';

/**
 * Classic, with its three utilities in one strip a household can move as one
 * (RFC 014 §5.1's first group).
 *
 * The calendar and the agenda are Classic's own boxes, untouched — the split
 * between them was measured against the density tiers and is not re-argued
 * here. What changes is the band above them: Classic places the clock, the
 * rota badge and the forecast as three boxes a household lines up by hand,
 * and this puts the three inside one `group` laid out as a `row`, so the strip
 * is dragged, sized and styled as a single box and its children take equal
 * thirds of it in `z` order. That is the whole of what a group is for, and it
 * is the one template that carries one until the editor can make them.
 *
 * Each child keeps a stored box of its own — thirds of the strip, which is
 * where the row puts them anyway — so an ungroup later has somewhere to put
 * the boxes back. The row **ignores** those fractions and places from order;
 * `widget-schema.ts` says so at the `layout` key.
 *
 * No theme and no background, for Classic's own reason: this is Classic's
 * arrangement, and a household pressing it is asking about the strip, not to
 * have their kitchen repainted. `templates.test.ts` names it beside Classic
 * and Blank as the third card that keeps the wall's theme.
 */

/** The strip's children, in the order the row draws them left to right. */
const strip = (parent: string) =>
  [
    { type: 'clock', parent, x: 0, y: 0, w: 1 / 3, h: 1, z: 0 },
    { type: 'weather', parent, x: 1 / 3, y: 0, w: 1 / 3, h: 1, z: 1 },
    { type: 'shift', parent, x: 2 / 3, y: 0, w: 1 / 3, h: 1, z: 2 },
  ] as const;

export const template: DisplayTemplate = {
  id: 'classic-strip',
  name: 'Classic Strip',
  category: 'home',
  blurb: 'Classic, with the clock, forecast and rota in one strip you can move as one.',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { key: 'strip', type: 'group', x: 0, y: 0, w: 1, h: CLASSIC_PORTRAIT_STRIP_H, config: { layout: 'row' } },
      ...strip('strip'),
      ...CLASSIC_PORTRAIT_CALENDARS,
    ],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { key: 'strip', type: 'group', x: 0, y: 0, w: 1, h: CLASSIC_LANDSCAPE_STRIP_H, config: { layout: 'row' } },
      ...strip('strip'),
      ...CLASSIC_LANDSCAPE_CALENDARS,
    ],
  },
};

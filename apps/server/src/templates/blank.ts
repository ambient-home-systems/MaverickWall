import type { DisplayTemplate } from '../api/templates.js';

/**
 * An empty canvas: nothing placed, both orientations, ready to build on.
 *
 * The gallery had no way to start from nothing. Every card was somebody else's
 * arrangement, so a household who wanted their own had to pick the nearest one
 * and delete its boxes — five deletions and a guess at which of them was load
 * bearing, on a page whose whole job is to hand over a starting point.
 *
 * **It sets no theme, and that is the difference between blank and reset.**
 * `applyTemplate` writes `template.theme` when a card names one, so a Blank
 * that named one would take the household's chosen theme off every wall that
 * followed it — a card called "Blank" repainting the wall is the last thing
 * somebody pressing it expects. Classic names none for the same reason, and
 * this is that rule with nothing else in the file to distract from it.
 *
 * The aspects are the gallery's nominal 9:16 and 16:9, which the apply route
 * replaces with the screen's own where it has one. That matters more here than
 * on a card with boxes on it: an empty canvas is *only* its aspect, so getting
 * it from the hardware is the whole of what is being seeded.
 *
 * What a wall then draws is `renderFreeform`'s "nothing yet" note, which
 * already existed and already says what to do. A panel needs its own card
 * (`panel/blank.ts`) and needed a renderer change to go with it, because there
 * an empty canvas used to mean the built-in view.
 */
export const template: DisplayTemplate = {
  id: 'blank',
  name: 'Blank',
  category: 'home',
  blurb: 'Nothing at all — an empty wall to place your own widgets on.',
  portrait: { aspect: 0.5625, widgets: [] },
  landscape: { aspect: 1.7778, widgets: [] },
};

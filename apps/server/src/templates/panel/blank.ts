import type { DisplayTemplate } from '../../api/templates.js';

/**
 * An empty panel canvas — the wall's Blank card, in this medium.
 *
 * **On a panel this needed the renderer to change, where on a wall it needed
 * nothing.** `renderScreenFrame` decided what to draw with
 * `widgets.length > 0`, so a canvas with no boxes on it drew the *built-in*
 * view — which would have made this card and the Built-in above it the same
 * frame, and "an option that does nothing" is the fault this project has
 * recorded more times than any other. What separates them is whether a canvas
 * exists at all rather than whether it has anything on it: Reset clears
 * `layout_mode` and gets the built-in view back, and this card writes a canvas
 * with nothing in it and gets an empty frame that says so.
 *
 * No theme and no background, like every panel card, because a panel has
 * neither. The aspect is 800x480's, nominal, and the apply route replaces it
 * with the panel's own.
 */
export const template: DisplayTemplate = {
  id: 'panel-blank',
  name: 'Blank',
  category: 'home',
  blurb: 'Nothing at all — an empty panel to place your own widgets on.',
  portrait: { aspect: 0.6, widgets: [] },
  landscape: { aspect: 1.6667, widgets: [] },
};

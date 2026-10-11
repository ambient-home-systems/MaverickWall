import type { DisplayTemplate } from '../api/templates.js';

/**
 * Pictures edge to edge, with the time and the day floating over them (plan
 * item M4.12).
 *
 * The mosaic is three Image widgets meeting at their edges, which takes the
 * wall's gutter to nothing — so the template sets it, the way a template sets
 * a theme. Each tile asks for a picture or an album until the household gives
 * it one; a template cannot name a household's photos.
 *
 * The two cards float over the tiles, higher in the stack, and keep what a
 * card is over a mosaic: their rounded corners, the theme's shadow token, a
 * ground of their own, and room inside. The ground is the wall's Solid
 * setting, written here too, because with no picture behind the canvas a
 * widget's ground is otherwise none and a card would be words straight on a
 * photo. The room is the style lane's inset at the step every wall's widgets
 * have, because at gutter 0 a widget's own padding is nothing.
 */
const TILE = { corners: 'square' } as const;
const CARD = { corners: 'rounded', shadow: true, style: { inset: 4 } } as const;

export const template: DisplayTemplate = {
  id: 'mosaic',
  name: 'Mosaic',
  category: 'home',
  blurb: 'Your photos edge to edge, with the time and what’s next floating on top.',
  gutter: 0,
  widgetGround: 'solid',
  portrait: {
    aspect: 0.5625,
    widgets: [
      { type: 'image', x: 0, y: 0, w: 1, h: 0.5, z: 0, config: TILE },
      { type: 'image', x: 0, y: 0.5, w: 0.5, h: 0.5, z: 1, config: TILE },
      { type: 'image', x: 0.5, y: 0.5, w: 0.5, h: 0.5, z: 2, config: TILE },
      { type: 'clock', x: 0.06, y: 0.04, w: 0.5, h: 0.11, z: 10, config: CARD },
      { type: 'calendar', x: 0.06, y: 0.7, w: 0.88, h: 0.26, z: 11, config: { ...CARD, mode: 'list', count: 4 } },
    ],
  },
  landscape: {
    aspect: 1.7778,
    widgets: [
      { type: 'image', x: 0, y: 0, w: 0.5, h: 1, z: 0, config: TILE },
      { type: 'image', x: 0.5, y: 0, w: 0.5, h: 0.5, z: 1, config: TILE },
      { type: 'image', x: 0.5, y: 0.5, w: 0.5, h: 0.5, z: 2, config: TILE },
      { type: 'clock', x: 0.04, y: 0.06, w: 0.3, h: 0.2, z: 10, config: CARD },
      { type: 'calendar', x: 0.64, y: 0.06, w: 0.32, h: 0.52, z: 11, config: { ...CARD, mode: 'list', count: 4 } },
    ],
  },
};

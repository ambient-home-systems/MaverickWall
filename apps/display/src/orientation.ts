/**
 * Which way up the wall is.
 *
 * Two separate questions that are easy to conflate:
 *
 *   - **Rotation** is physical. The panel is hung sideways and the browser has
 *     no idea; the page has to turn its own output to match. Plenty of screens
 *     cannot rotate in their own settings, and plenty of the ones that can
 *     forget it after a power cut, so doing it here is the only place it
 *     reliably sticks.
 *   - **Orientation** is which layout to draw. It normally follows the shape
 *     of the canvas, but a household can pin it, because a kiosk frame can
 *     report a viewport that has nothing to do with how the thing is mounted
 *     and there is nobody on site to argue with it.
 *
 * Rotating changes the answer to the second question: turn a 1920x1080 panel
 * on its end and the canvas the layout gets is 1080x1920, which is portrait.
 * Keeping this a pure function is what makes that relationship testable
 * without a browser.
 */

export type Orientation = 'auto' | 'portrait' | 'landscape';
export type Rotation = 0 | 90 | 180 | 270;
export type Layout = 'portrait' | 'landscape';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Only quarter turns. Anything else is a value somebody typed wrong. */
export function normaliseRotation(value: unknown): Rotation {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  // Negative and over-large turns are still meaningful: -90 is 270.
  const quarter = ((Math.round(number / 90) % 4) + 4) % 4;
  return (quarter * 90) as Rotation;
}

export function normaliseOrientation(value: unknown): Orientation {
  return value === 'portrait' || value === 'landscape' ? value : 'auto';
}

/**
 * The canvas the layout actually gets, after rotation.
 *
 * A quarter turn swaps the axes; a half turn does not. Everything downstream —
 * which layout, and what one rem is worth — is derived from this rather than
 * from the raw viewport.
 */
export function canvasFor(viewport: Viewport, rotation: Rotation): Viewport {
  return rotation === 90 || rotation === 270
    ? { width: viewport.height, height: viewport.width }
    : viewport;
}

export function resolveLayout(
  viewport: Viewport,
  rotation: Rotation,
  forced: Orientation,
): Layout {
  if (forced !== 'auto') return forced;
  const canvas = canvasFor(viewport, rotation);
  // A square canvas is portrait. The stacked layout degrades better into a
  // narrow column than the two-column one does.
  return canvas.width > canvas.height ? 'landscape' : 'portrait';
}

export interface ScreenGeometry {
  readonly rotation: Rotation;
  readonly layout: Layout;
  /** The rotated frame's own size, in CSS units the page can set. */
  readonly frame: { readonly width: string; readonly height: string };
  /**
   * What one rem is worth: 1% of the canvas height.
   *
   * After a quarter turn the canvas height is the viewport *width*, so the
   * whole type scale has to read from `vw` instead of `vh` or the wall comes
   * out at the wrong size on exactly the screens that needed rotating.
   */
  readonly rootFontSize: string;
}

export function geometryFor(
  viewport: Viewport,
  rotation: Rotation,
  forced: Orientation,
): ScreenGeometry {
  const turned = rotation === 90 || rotation === 270;
  return {
    rotation,
    layout: resolveLayout(viewport, rotation, forced),
    frame: turned ? { width: '100vh', height: '100vw' } : { width: '100vw', height: '100vh' },
    rootFontSize: turned ? 'calc(100vw / 100)' : 'calc(100vh / 100)',
  };
}

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

/**
 * What the household said about the hardware: how large the picture is and how
 * far away somebody stands to read it, in millimetres.
 *
 * Facts, not a size in pixels, and the manifest carries them as facts for the
 * reason this function exists — the server does not know what this browser
 * calls a pixel. It knows a viewport a wall reported once, which a kiosk frame
 * can misreport and a rotation reinterprets. The page is the only place where
 * both halves of the ratio are known at the same time.
 */
export interface PhysicalScreen {
  readonly panelWidthMm: number;
  readonly panelHeightMm: number;
  readonly readDistanceMm: number;
}

/**
 * The three facts, or nothing, out of whatever a manifest happens to hold.
 *
 * The server already refuses a half-measurement, and this refuses it again —
 * for the reason every bound in this bundle is enforced twice: the display has
 * to draw something sane against a server older or newer than itself, and a
 * wall that has been hanging for months may be reading a document written by
 * neither. Two of the three is not half an answer; it derives nothing, so it
 * is the same state as none.
 */
export function physicalScreenFrom(
  panelWidthMm: unknown,
  panelHeightMm: unknown,
  readDistanceMm: unknown,
): PhysicalScreen | undefined {
  if (
    typeof panelWidthMm !== 'number' ||
    typeof panelHeightMm !== 'number' ||
    typeof readDistanceMm !== 'number'
  ) {
    return undefined;
  }
  return { panelWidthMm, panelHeightMm, readDistanceMm };
}

/**
 * One arc-minute at the eye, in radians.
 *
 * A degree is π/180 and a minute is a sixtieth of one, so π/10800 —
 * 0.000290888…, written as the arithmetic rather than as the decimal so
 * nobody has to take it on trust. At these angles the tangent and the angle
 * agree to about one part in ten million, which is nine digits better than a
 * household's guess at how far away they stand.
 */
const ARCMINUTE_RAD = Math.PI / 10_800;

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * How many CSS pixels one arc-minute of the reader's vision is worth.
 *
 * This is the number every legibility decision in the product actually wants
 * and none of them has ever had. Type on a wall is readable or not by the
 * angle it subtends at somebody's eye, so a floor stated in pixels is only
 * ever right on the screen it was measured on: 22px is about six arc-minutes
 * of cap height on a 32" panel at ten feet, which is at the acuity limit for a
 * word somebody already expects and nowhere near fluent reading — while the
 * same 22px on a 7.5" panel at arm's length is enormous.
 *
 * Two traps, and the second is the one worth writing down.
 *
 * **The rotated frame, never the raw viewport.** A screen turned a quarter
 * turn has its canvas height on the viewport's *width* axis — the same trap
 * `rootFontSize` above documents, and getting it wrong here is worse than
 * getting it wrong there, because the wall would come out plausibly sized
 * rather than obviously half-size. So the frame comes from `canvasFor`, which
 * is the one place that reconciliation lives.
 *
 * **The millimetres are reconciled against that frame, not against the
 * rotation.** The columns hold the picture as it is mounted, and a household
 * is not going to re-measure because they turned a wall on its end a year
 * later — nor does the rotation know anything about a panel the operating
 * system turned, which reports no rotation here at all. The frame is the
 * measured truth and the stored way-up is a claim, so the pair is turned to
 * agree with the frame. Without it a 32" television hung sideways divides
 * 398mm by 1920px instead of 708mm by 1920px and every size on the wall comes
 * out 1.78x wrong, silently and in the plausible direction.
 *
 * `undefined` when the household has not said, which is the common case and
 * has to stay the cheap one: nothing derived, nothing changed.
 */
export function pxPerArcminute(
  physical: PhysicalScreen | undefined,
  viewport: Viewport,
  rotation: Rotation,
): number | undefined {
  if (physical === undefined) return undefined;
  const { panelWidthMm, panelHeightMm, readDistanceMm } = physical;
  if (!positive(panelWidthMm) || !positive(panelHeightMm) || !positive(readDistanceMm)) {
    return undefined;
  }
  const frame = canvasFor(viewport, rotation);
  if (!positive(frame.width) || !positive(frame.height)) return undefined;

  // Turned to agree with the frame: same way up, and the stored height is the
  // frame's height; opposite, and it is the stored width. A square frame reads
  // as portrait, exactly as `resolveLayout` reads a square canvas.
  const frameIsLandscape = frame.width > frame.height;
  const storedIsLandscape = panelWidthMm > panelHeightMm;
  const heightMm = frameIsLandscape === storedIsLandscape ? panelHeightMm : panelWidthMm;

  const mmPerPx = heightMm / frame.height;
  if (!positive(mmPerPx)) return undefined;
  return (readDistanceMm * ARCMINUTE_RAD) / mmPerPx;
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
  /**
   * CSS pixels per arc-minute at the reader's eye, when this wall has been
   * measured. Absent otherwise, and absent is the common case.
   */
  readonly pxArcmin?: number;
}

export function geometryFor(
  viewport: Viewport,
  rotation: Rotation,
  forced: Orientation,
  physical?: PhysicalScreen,
): ScreenGeometry {
  const turned = rotation === 90 || rotation === 270;
  const pxArcmin = pxPerArcminute(physical, viewport, rotation);
  return {
    rotation,
    layout: resolveLayout(viewport, rotation, forced),
    frame: turned ? { width: '100vh', height: '100vw' } : { width: '100vw', height: '100vh' },
    rootFontSize: turned ? 'calc(100vw / 100)' : 'calc(100vh / 100)',
    // Spread rather than emitted as `undefined`, so an unmeasured wall's
    // geometry is the object it has always been.
    ...(pxArcmin === undefined ? {} : { pxArcmin }),
  };
}

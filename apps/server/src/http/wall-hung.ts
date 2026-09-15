import type { CanvasBackground, Manifest } from '../api/manifest.js';

/**
 * Which way a browser wall is hung, decided the way the wall decides it
 * (RFC 016 §4.1).
 *
 * A wall carries two canvases and draws the one matching how it is actually
 * mounted; only the wall knows that for certain, because it is a fact about a
 * viewport the server never sees directly. The Walls list has to draw *a*
 * canvas on each card, and drawing portrait unconditionally — which the RFC's
 * own draft did — puts the wrong arrangement on every wall on its side. A
 * household with a landscape television in the hall and a portrait tablet in
 * the kitchen is exactly the one telling walls apart by their pictures.
 *
 * So the pick uses the inputs `apps/display/src/orientation.ts` uses, in its
 * order: the pinned `orientation` column when it is not `auto`; else the
 * viewport the wall last reported, turned through `rotation` the way
 * `canvasFor` turns it, landscape only when wider than tall; else `rotation`
 * alone on a nominal portrait viewport; else portrait. It is the display's own
 * `resolveLayout`, fed the best the row knows.
 *
 * **The four functions below are transcribed from `orientation.ts`, character
 * for character**, and `wall-hung-parity.test.ts` holds them to it — the seam
 * `tier-parity` and `month-spans-parity` already sit at, for the reason they
 * sit there: the display bundle has no bundler and the server cannot import
 * it, and two definitions of "landscape" that agree today is exactly how one of
 * them comes to disagree. The display's `resolveLayout` stays the only
 * definition of what landscape means; this file asks it rather than restating
 * it, and the test is what makes that a fact.
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
 * The viewport a wall that has never reported one is assumed to have.
 *
 * Portrait, because that is what the design is calibrated against and what a
 * new wall is seeded for — and *nominal*, because its only job here is to be
 * turned: a wall with no report and a quarter turn recorded is a wall hung
 * sideways, and the pick has to say landscape for it without a viewport to
 * measure. The numbers are the design's 1080x1920 and nothing reads them
 * beyond which is the longer side.
 */
const NOMINAL_PORTRAIT: Viewport = { width: 1080, height: 1920 };

/** The columns the pick reads off a `screens` row. */
export interface HungRow {
  readonly orientation?: string | null;
  readonly rotation?: number | null;
  readonly reportW?: number | null;
  readonly reportH?: number | null;
}

function reportedViewport(row: HungRow): Viewport | undefined {
  const w = row.reportW;
  const h = row.reportH;
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return { width: w, height: h };
}

/** Which canvas a wall is hung for, from what its row knows. */
export function wallHungAs(row: HungRow): Layout {
  return resolveLayout(
    reportedViewport(row) ?? NOMINAL_PORTRAIT,
    normaliseRotation(row.rotation),
    normaliseOrientation(row.orientation),
  );
}

/** One of a wall's two canvases, as the manifest carries it. */
export interface CardCanvas {
  readonly aspect: number;
  readonly widgets: Manifest['layout']['portrait']['widgets'];
  readonly background?: CanvasBackground;
}

/** What a wall card draws, and which way the wall it pictures is hung. */
export interface WallCardCanvas extends CardCanvas {
  /** How the wall is hung — the pick above. */
  readonly hung: Layout;
  /** Which of its two canvases is drawn: the hung one, or the other letterboxed. */
  readonly canvas: Layout;
}

/**
 * The canvas a wall card draws, picked the way the wall's own `pickCanvas`
 * (`apps/display/src/main.ts`) picks it: the canvas for the orientation the
 * wall is hung in, or — when the household has arranged nothing on that side
 * — the other one, which the wall draws letterboxed. A wall with nothing on
 * either side draws its "nothing yet" note, and so does its card.
 *
 * Transcribed in shape rather than character for character: `pickCanvas` is
 * a private function of the wall's entry module, which runs `start()` on
 * import and cannot be shared without moving it, and moving a function in the
 * wall's own bundle is not this phase's to do (RFC 016 §10). What it decides
 * is small enough to state in the test beside it.
 */
export function wallCardCanvas(row: HungRow, portrait: CardCanvas, landscape: CardCanvas): WallCardCanvas {
  const hung = wallHungAs(row);
  const primary = hung === 'landscape' ? landscape : portrait;
  const secondary = hung === 'landscape' ? portrait : landscape;
  if (primary.widgets.length === 0 && secondary.widgets.length > 0) {
    return { hung, canvas: hung === 'landscape' ? 'portrait' : 'landscape', ...secondary };
  }
  return { hung, canvas: hung, ...primary };
}

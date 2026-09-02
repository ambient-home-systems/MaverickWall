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
  /**
   * The type scale that follows from it — every role's size in CSS pixels.
   *
   * Derived here rather than in the stylesheet so there is **one owner of what
   * a size is worth on this screen**, beside `rootFontSize`, which owns the
   * same question for the rem. A `calc()` in `display.css` would put the cap
   * ratio and eight constants somewhere nothing can unit-test and would need a
   * second CSS Values 4 function for the clock's cap; here the arithmetic is
   * pure, and `orientation.test.ts` works the examples.
   */
  readonly type?: WallTypeScale;
}

export function geometryFor(
  viewport: Viewport,
  rotation: Rotation,
  forced: Orientation,
  physical?: PhysicalScreen,
): ScreenGeometry {
  const turned = rotation === 90 || rotation === 270;
  const pxArcmin = pxPerArcminute(physical, viewport, rotation);
  const type = wallTypeScale(pxArcmin);
  return {
    rotation,
    layout: resolveLayout(viewport, rotation, forced),
    frame: turned ? { width: '100vh', height: '100vw' } : { width: '100vw', height: '100vh' },
    rootFontSize: turned ? 'calc(100vw / 100)' : 'calc(100vh / 100)',
    // Spread rather than emitted as `undefined`, so an unmeasured wall's
    // geometry is the object it has always been.
    ...(pxArcmin === undefined ? {} : { pxArcmin }),
    ...(type === undefined ? {} : { type }),
  };
}

// ---------------------------------------------------------------------------
// The type scale, in arc-minutes of cap height
// ---------------------------------------------------------------------------

/**
 * The eight roles the wall's type is drawn at, each stated as **cap height in
 * arc-minutes at the reader's eye**.
 *
 * This is what `--t-floor: 22px` was standing in for, and the difference is
 * the whole of it: 22px is a measurement taken on one wall and defended on
 * every other. Measured on the shipped Classic seed, the month grid's event
 * text was 22.0px at 480x800, 22.0px at 1920x1080 and 24.8px at 2560x1440 —
 * pinned across a 5.7x range of panel area by a constant that knows nothing
 * about either panel. One mechanism, two opposite failures: on a small panel
 * the floor is *larger* than the cell's row budget, so every row is trimmed
 * and thirteen cells drew "+3" and not one name; on a large one the same floor
 * *caps* the type below what the cell could carry, and a 146x190 cell named 8
 * of its 19 events.
 *
 * An angle at the eye has neither failure, because it is the thing legibility
 * is actually a property of. `pxPerArcminute` above is the conversion and the
 * only screen-dependent term; everything here is a constant.
 *
 * The rungs, and what each is for:
 *
 *     role            cap    used for
 *     event           14'    event names — the floor of the system
 *     event-strong    14'    all-day events and multi-day span bars
 *     time            12'    times beside events
 *     numeral         16'    month-cell date numerals
 *     scaffold        11'    weekday heads, week numbers, "+N"
 *     label           10'    section labels
 *     lede            22'    today's agenda titles
 *     clock           40'    the clock, capped (below)
 *
 * The ratios are the point rather than the absolute values, and two of them
 * carry the hierarchy fix this scale exists for: the numeral is 16/14 = 1.14x
 * the event beside it where a fixed `1.85rem` made it 1.61x, and the clock is
 * 1.8x the agenda's lede where it was 4.4x. Both are now *size-independent* —
 * a household who measures a 7.5" panel and a household who measures a 55"
 * television get the same hierarchy, which is what no pixel constant can give.
 *
 * **Only the size is a role.** Weight, tracking and line-height belong to the
 * treatment each selector already declares: moving one would move an
 * *unmeasured* wall too, and every wall is unmeasured until its household
 * opens the setting. Nothing on a wall that has not been measured may change.
 */
export const WALL_TYPE_ROLES = [
  'event',
  'eventStrong',
  'time',
  'numeral',
  'scaffold',
  'label',
  'lede',
  'clock',
] as const;

/**
 * Derived from the list rather than declared beside it, so the two tables
 * below cannot cover a role the page does not write, or miss one it does.
 */
export type WallTypeRole = (typeof WALL_TYPE_ROLES)[number];

/**
 * Cap height as a fraction of the em, for the faces this wall ships.
 *
 * A role is stated as cap height because that is the part of a letter an eye
 * actually resolves — an em box is mostly leading and descender, and two faces
 * with the same `font-size` do not draw the same size of letter. Roboto,
 * Roboto Condensed and Roboto Flex all sit within a whisker of 0.71 — Roboto
 * Flex is drawn from the same superfamily and holds its cap height across the
 * wdth and opsz range this wall actually drives — and the bundled display
 * faces are close enough that a single ratio is honest at these sizes; a face
 * whose cap ratio genuinely differed would want its own value here rather
 * than a fudge at the call site.
 */
export const CAP_RATIO = 0.71;

/** Each role's cap height, in arc-minutes, before the clock's cap. */
export const WALL_TYPE_CAPS: Readonly<Record<WallTypeRole, number>> = {
  event: 14,
  eventStrong: 14,
  time: 12,
  numeral: 16,
  scaffold: 11,
  label: 10,
  lede: 22,
  clock: 40,
};

/**
 * The most a clock may outsize an agenda title.
 *
 * "A widget the household placed does not get to outsize the fact they put a
 * wall up to read" — `.clock` already carries this cap against `--t-event` in
 * `display.css`, and the scale has to carry it too or the arc-minute wall
 * would quietly undo what the rem one holds. It **binds**: 40' against the
 * lede's 22' is 1.818x, which is over the bar, so this is the line that makes
 * the stated ratio true rather than a comment about one. Written as the ratio
 * rather than as the 39.6' it resolves to, so removing it is one line and the
 * ratio assertion in `wall-density.test.ts` goes red.
 */
export const CLOCK_MAX_LEDE_RATIO = 1.8;

/** The custom property each role is written to. One name, two readers. */
export const WALL_TYPE_PROPERTIES: Readonly<Record<WallTypeRole, string>> = {
  event: '--t-wall-event',
  eventStrong: '--t-wall-event-strong',
  time: '--t-wall-time',
  numeral: '--t-wall-numeral',
  scaffold: '--t-wall-scaffold',
  label: '--t-wall-label',
  lede: '--t-wall-lede',
  clock: '--t-wall-clock',
};

/** Every role's size in CSS pixels, on a wall that has been measured. */
export type WallTypeScale = Readonly<Record<WallTypeRole, number>>;

/**
 * The scale for one screen, or `undefined` when it has not been measured.
 *
 * `font-size = cap arc-minutes x px-per-arc-minute / cap ratio`, which is the
 * whole derivation. Worked, so the arithmetic can be checked without running
 * anything: a 32" panel hung portrait (1920px over 708mm) read at 1200mm has
 * 0.9466 px per arc-minute, so an event name is 14 x 0.9466 / 0.71 = 18.67px
 * and a date numeral 16 x 0.9466 / 0.71 = 21.33px. A 7.5" e-ink panel (480px
 * over 98mm) read at 600mm has 0.8549, so an event name is 16.86px — which is
 * within a pixel of the 16px its bitmap renderer already draws, and is why
 * that panel looks right today while every other one does not.
 *
 * Rounded to hundredths because that is the resolution a browser reports a
 * `font-size` at anyway, and because an inline style reading
 * `18.665352112676056px` is one nobody can check against the table above.
 *
 * `undefined` in, `undefined` out: an unmeasured wall must reach the
 * stylesheet's own fallbacks rather than a scale derived from a guess.
 */
export function wallTypeScale(pxArcmin: number | undefined): WallTypeScale | undefined {
  if (pxArcmin === undefined || !positive(pxArcmin)) return undefined;
  const px = (capArcmin: number): number =>
    Math.round((capArcmin * pxArcmin * 100) / CAP_RATIO) / 100;
  /*
   * The cap is taken against the *drawn* lede and floors, which is not
   * fussiness — it is what makes the ratio survive the rounding above.
   *
   * Each rung rounds to hundredths independently, so a clock capped at 1.8x
   * the lede's own arc-minutes comes out at 1.8005x its rounded pixels on a
   * small enough panel: 12.08 and 21.75 at 0.39 px per arc-minute, which is
   * over a bar this product states absolutely. Rounding cannot be relied on to
   * fall the right way, so the cap floors — the same rule `epaper/metrics.ts`
   * states for a row count, and for the same reason: a limit that is exceeded
   * by a hundredth is not a limit. A unit test holds the ratio at three sizes
   * and this is what it is failing without.
   */
  const lede = px(WALL_TYPE_CAPS.lede);
  return {
    event: px(WALL_TYPE_CAPS.event),
    eventStrong: px(WALL_TYPE_CAPS.eventStrong),
    time: px(WALL_TYPE_CAPS.time),
    numeral: px(WALL_TYPE_CAPS.numeral),
    scaffold: px(WALL_TYPE_CAPS.scaffold),
    label: px(WALL_TYPE_CAPS.label),
    lede,
    clock: Math.min(px(WALL_TYPE_CAPS.clock), Math.floor(CLOCK_MAX_LEDE_RATIO * lede * 100) / 100),
  };
}

/**
 * The analogue clock face on one bit (RFC 014 §4.2).
 *
 * The geometry is the wall's, transcribed: the block between the markers is
 * `apps/display/src/clock-face.ts`'s character for character, and
 * `clock-face-parity.test.ts` holds the two to it — a face that pointed its
 * hands somewhere else on the panel than on the wall it follows would be
 * `shifts[0]` in a clock.
 *
 * What the panel does for itself is only the rasterising, below the block. A
 * hand is at a different angle every minute, so it cannot be a stored cell the
 * way a forecast glyph is (`epaper/glyphs.ts`): it is a polygon, filled by
 * asking of each pixel's centre whether it is inside. That is crisp at one bit
 * with no resampling — a pixel is in or it is out — and it is a function of
 * the box alone, so the face's rectangle is the refresh contract's kind of
 * rectangle: only the ink inside it changes from one minute to the next.
 */

/*
 * clock-face:begin
 *
 * The face, on the 24-unit grid `glyphs.ts` draws on, and in its idiom: filled
 * and never stroked, because a 1.5px stroke is gone at one bit and reads as a
 * grey smudge at ten feet, where a silhouette survives both.
 *
 * **This block is transcribed into `apps/server/src/epaper/clock-face.ts`
 * character for character** and `clock-face-parity.test.ts` compares the two
 * as text — the seam `tiers.ts`, `month-spans.ts` and `glyphs.ts` already sit
 * at, for the reason they do: the display bundle has no bundler and cannot
 * import the server's copy. The panel rasterises these polygons rather than
 * keeping a bitmap, because a hand is at a different angle every minute and a
 * cell per angle is 720 cells.
 *
 * The ring reaches the edge of the grid, so the face is exactly the shorter
 * side of whatever square it is drawn into; the ticks stand a unit clear of it
 * so they do not merge into a thick ring at eight pixels.
 */
export interface FacePoint {
  readonly x: number;
  readonly y: number;
}

export const FACE_CENTRE = 12;
export const FACE_RING_OUTER = 12;
export const FACE_RING_INNER = 10.9;
/** An hour mark, and the four at the quarters that carry the face's orientation. */
export const FACE_TICK = { inner: 8.9, outer: 10.1, halfWidth: 0.4 } as const;
export const FACE_QUARTER_TICK = { inner: 7.9, outer: 10.1, halfWidth: 0.75 } as const;
/**
 * A hand is a wedge: wide at the hub, a point at the tip, and a short tail
 * behind the hub so the two read as hands rather than as rays of a sun.
 */
export const FACE_HOUR_HAND = { length: 6.3, halfWidth: 1.0, tail: 1.4 } as const;
export const FACE_MINUTE_HAND = { length: 9.4, halfWidth: 0.72, tail: 1.8 } as const;
export const FACE_HUB = 1.35;

export interface FaceHand {
  readonly length: number;
  readonly halfWidth: number;
  readonly tail: number;
}

/**
 * Where each hand points, in degrees clockwise from twelve.
 *
 * The hour hand moves half a degree a minute, which is what makes half past
 * three read as half past three rather than as three.
 */
export function handAngles(hour: number, minute: number): { readonly hour: number; readonly minute: number } {
  return { hour: ((hour % 12) * 30 + minute * 0.5) % 360, minute: (minute * 6) % 360 };
}

/**
 * A point given along the hand (`along`, towards the tip) and across it
 * (`across`, to the hand's right), turned to `degrees` about the centre. The
 * grid's y runs down, so twelve o'clock is `-along`.
 */
function turn(degrees: number, across: number, along: number): FacePoint {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    x: round(FACE_CENTRE + across * cos + along * sin),
    y: round(FACE_CENTRE + across * sin - along * cos),
  };
}

/**
 * One hand as a polygon, **tip first** and then clockwise: the tip, the right
 * shoulder at the hub, the tail's two corners, the left shoulder. Clockwise
 * because every silhouette in this idiom is, and tip first so the first point
 * of the path *is* where the hand points.
 */
export function handPolygon(degrees: number, hand: FaceHand): readonly FacePoint[] {
  const tailHalf = hand.halfWidth * 0.6;
  return [
    turn(degrees, 0, hand.length),
    turn(degrees, hand.halfWidth, 0),
    turn(degrees, tailHalf, -hand.tail),
    turn(degrees, -tailHalf, -hand.tail),
    turn(degrees, -hand.halfWidth, 0),
  ];
}

/** The twelve marks, each a clockwise quad, the quarters heavier. */
export function tickPolygons(): readonly (readonly FacePoint[])[] {
  const out: (readonly FacePoint[])[] = [];
  for (let hour = 0; hour < 12; hour++) {
    const tick = hour % 3 === 0 ? FACE_QUARTER_TICK : FACE_TICK;
    const degrees = hour * 30;
    out.push([
      turn(degrees, -tick.halfWidth, tick.outer),
      turn(degrees, tick.halfWidth, tick.outer),
      turn(degrees, tick.halfWidth, tick.inner),
      turn(degrees, -tick.halfWidth, tick.inner),
    ]);
  }
  return out;
}
/* clock-face:end */

/** Is a point inside a convex polygon wound either way? */
function insideConvex(px: number, py: number, points: readonly FacePoint[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross === 0) continue;
    const side = cross > 0 ? 1 : -1;
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

/** Anything that can take a pixel of ink. */
interface Ink {
  set(x: number, y: number, ink?: boolean): void;
}

/**
 * Draw the face into a `size` x `size` square at (`left`, `top`), for a
 * reading of `hour` (0-23) and `minute`.
 *
 * Every pixel is sampled at its centre on the 24 grid, so the face is exactly
 * the square it is given — the ring reaches the square's edge, as it reaches
 * the SVG's on the wall — and it scales with the box rather than by a rung.
 */
export function drawAnalogueFace(
  fb: Ink,
  left: number,
  top: number,
  size: number,
  hour: number,
  minute: number,
): void {
  if (size <= 0) return;
  const angles = handAngles(hour, minute);
  const shapes: readonly (readonly FacePoint[])[] = [
    ...tickPolygons(),
    handPolygon(angles.hour, FACE_HOUR_HAND),
    handPolygon(angles.minute, FACE_MINUTE_HAND),
  ];
  const unit = 24 / size;
  for (let y = 0; y < size; y++) {
    const gy = (y + 0.5) * unit;
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) * unit;
      const dx = gx - FACE_CENTRE;
      const dy = gy - FACE_CENTRE;
      const r = Math.sqrt(dx * dx + dy * dy);
      let ink = (r <= FACE_RING_OUTER && r >= FACE_RING_INNER) || r <= FACE_HUB;
      if (!ink) {
        for (const shape of shapes) {
          if (insideConvex(gx, gy, shape)) {
            ink = true;
            break;
          }
        }
      }
      if (ink) fb.set(left + x, top + y, true);
    }
  }
}

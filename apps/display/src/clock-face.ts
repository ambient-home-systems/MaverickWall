/**
 * The clock's designed variants (RFC 014 §4.2), decided as data.
 *
 * Three drawings of one reading, each a *mode* drawn on purpose rather than a
 * restyling — the Swiss month grid's shape, one widget along:
 *
 *  - **`plain`** is the clock every wall has drawn: the digits, and the date
 *    under them. It is what an absent `variant` means, so a canvas saved before
 *    the key existed sends a byte-identical config and no stored ETag churns.
 *  - **`stacked`** is the time over the date, the weekday and the date each on
 *    a line of their own in the *scaffold* role — the register the agenda's own
 *    weekday and month use, because a date under a clock labels the time rather
 *    than being what anybody walked over to read.
 *  - **`analogue`** is a face: a picture, not type. It takes no type role and
 *    sizes to the shorter side of its box, and its hands are two filled wedges
 *    redrawn on the wall's own fifteen-second tick. There is no seconds hand,
 *    for the reason there is no seconds field: a wall that redraws every
 *    fifteen seconds would be wrong about it far more often than right.
 *
 * Pure, with no DOM, for the reason `widget-options.ts`, `ink.ts` and
 * `ladder.ts` are: the renderer builds nodes and does no thinking, and there is
 * no DOM in this package's test suite, so a hand angle worked out inside a
 * `createElementNS` call is a hand angle nothing can check.
 */

import { DISPLAY_LOCALE } from './viewmodel.js';

/*
 * Which of the three a stored config means is `variantOf('clock', config)` in
 * `variants.ts`, which is this file's `clockVariant` generalised to every type
 * (plan item P4.1): one list per type, the default first, and a value the
 * list does not name — absent, or another type's — read as `plain`.
 */

/* ------------------------------------------------------------ READING --- */

const READINGS = new Map<string, Intl.DateTimeFormat>();
const DATES = new Map<string, Intl.DateTimeFormat>();

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let found = cache.get(timezone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(DISPLAY_LOCALE, { ...options, timeZone: timezone });
    cache.set(timezone, found);
  }
  return found;
}

/**
 * The hour (0-23) and minute the kitchen clock reads, in the household's zone.
 *
 * Minute precision, deliberately: a face whose minute hand crept between the
 * minutes would be reading a finer clock than the digits beside it on the
 * next wall, and the two are one reading. `% 24` because some engines spell
 * midnight "24" under `hour12: false`.
 */
export function wallClockReading(at: number, timezone: string): { readonly hour: number; readonly minute: number } {
  const parts = formatter(READINGS, timezone, { hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(
    new Date(at),
  );
  const find = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { hour: find('hour') % 24, minute: find('minute') % 60 };
}

/**
 * The stacked clock's two date lines: the weekday, and the day and month.
 *
 * Spelled out rather than the model's short `todayLabel`, because the stacked
 * form gives each its own line and a line holding "Wed" is a line spent on an
 * abbreviation. Read off the same instant as the digits above them, so the
 * three lines turn over at the same midnight.
 */
export function stackedDateLines(at: number, timezone: string): { readonly weekday: string; readonly date: string } {
  const parts = formatter(DATES, timezone, { weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(
    new Date(at),
  );
  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return { weekday: find('weekday'), date: `${find('day')} ${find('month')}` };
}

/* --------------------------------------------------------------- FACE --- */

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

/** A polygon as path data. */
export function polygonPath(points: readonly FacePoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('') + 'Z';
}

/** A disc as path data, clockwise or not — `glyphs.ts`'s two literals, as a function. */
function discPath(r: number, clockwise: boolean): string {
  const sweep = clockwise ? 1 : 0;
  const left = FACE_CENTRE - r;
  return `M${left} ${FACE_CENTRE}a${r} ${r} 0 1 ${sweep} ${2 * r} 0a${r} ${r} 0 1 ${sweep} ${-2 * r} 0Z`;
}

/**
 * The face's scaffolding: the ring (a clockwise disc with an anticlockwise one
 * cut out of it, the counter rule `glyphs.ts` states) and the twelve marks.
 * It never changes, so it is built once.
 */
export const FACE_DIAL_PATH = discPath(FACE_RING_OUTER, true) + discPath(FACE_RING_INNER, false) + tickPolygons().map(polygonPath).join('');

/** The hub the two hands turn about. */
export const FACE_HUB_PATH = discPath(FACE_HUB, true);

/** What the renderer draws for one reading: two hand paths, and their angles. */
export interface AnalogueFace {
  readonly hourAngle: number;
  readonly minuteAngle: number;
  readonly hourPath: string;
  readonly minutePath: string;
}

export function analogueFace(hour: number, minute: number): AnalogueFace {
  const angles = handAngles(hour, minute);
  return {
    hourAngle: angles.hour,
    minuteAngle: angles.minute,
    hourPath: polygonPath(handPolygon(angles.hour, FACE_HOUR_HAND)),
    minutePath: polygonPath(handPolygon(angles.minute, FACE_MINUTE_HAND)),
  };
}

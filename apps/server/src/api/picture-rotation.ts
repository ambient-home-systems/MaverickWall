/**
 * Which picture a rotating background shows, and when it changes (plan items
 * M4.10 and M1.4).
 *
 * **Transcribed**, character for character between the markers, into
 * `apps/display/src/picture-rotation.ts`: the wall works out its picture from
 * its own clock so it keeps rotating offline, and the server works out the same
 * count when a household presses Next picture. Two renderers holding one rule is
 * this project's most repeated bug, so `picture-rotation-parity.test.ts` reads
 * both files and compares them.
 *
 * A rotation is counted in **steps**. With nobody having pressed Next, the step
 * is the number of whole periods since the epoch — or, for a daily rotation,
 * the number of the day in the wall's own time zone, so it changes at the
 * wall's midnight and a clock change does not move it. Next records the moment
 * it was pressed and the step it moved to, and counting starts again from
 * there, which is what restarts that picture's countdown. The picture is the
 * step modulo the collection's size, so the count needs nothing about the
 * pictures themselves — which is why the server can move a wall on without
 * knowing which pictures it draws.
 */

/* rotation-parity:start */
/** How often a rotating background may change, in minutes: a few, an hour, a day. */
export const ROTATION_EVERY = [5, 15, 60, 1440] as const;
export type RotationEvery = (typeof ROTATION_EVERY)[number];
const DAY_MINUTES = 1440;

/** The number of the day `at` falls on in `timezone`, counted from 1970-01-01; UTC for a zone `Intl` does not know. */
export function localEpochDay(at: number, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(at));
  } catch {
    return Math.floor(at / 86_400_000);
  }
  const part = (type: string): number => Number(parts.find((one) => one.type === type)?.value);
  const day = Date.UTC(part('year'), part('month') - 1, part('day'));
  return Number.isFinite(day) ? Math.floor(day / 86_400_000) : Math.floor(at / 86_400_000);
}

/**
 * How many steps a rotation has taken at `now`: from the epoch when nobody has
 * pressed Next, else from the step Next moved it to, counted from when it was
 * pressed.
 */
export function rotationSteps(
  every: number,
  now: number,
  timezone: string,
  pressedAt: number | undefined,
  step: number,
): number {
  if (every === DAY_MINUTES) {
    const today = localEpochDay(now, timezone);
    return pressedAt === undefined ? today : step + today - localEpochDay(pressedAt, timezone);
  }
  const period = every * 60_000;
  return pressedAt === undefined ? Math.floor(now / period) : step + Math.floor((now - pressedAt) / period);
}

/** Which of `count` pictures `steps` lands on. */
export function rotationIndex(count: number, steps: number): number {
  if (!(count > 0) || !Number.isFinite(steps)) return 0;
  return ((Math.floor(steps) % count) + count) % count;
}
/* rotation-parity:end */

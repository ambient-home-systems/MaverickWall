/**
 * Civil date arithmetic on `YYYY-MM-DD` strings.
 *
 * A calendar date is not an instant and has no timezone. Shift rotations,
 * effective ranges and day cells all live in this space, and keeping them out
 * of instant-space entirely is what stops a rotation from sliding by a day
 * twice a year. Conversion to instants happens once, at the display edge.
 */

const DAY_MS = 86_400_000;

export type CivilDate = string;

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCivilDate(value: string): boolean {
  const match = SHAPE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Round-tripping catches impossible dates such as 2026-02-30, which Date.UTC
  // silently rolls forward into March rather than rejecting.
  const epoch = toEpochDay(value);
  return epoch !== undefined && fromEpochDay(epoch) === value;
}

/** Days since 1970-01-01, or undefined if the shape is wrong. */
export function toEpochDay(date: CivilDate): number | undefined {
  const match = SHAPE.exec(date);
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / DAY_MS);
}

export function fromEpochDay(epochDay: number): CivilDate {
  const d = new Date(epochDay * DAY_MS);
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const epoch = toEpochDay(date);
  if (epoch === undefined) throw new RangeError(`not a civil date: ${date}`);
  return fromEpochDay(epoch + days);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: CivilDate, to: CivilDate): number {
  const a = toEpochDay(from);
  const b = toEpochDay(to);
  if (a === undefined || b === undefined) throw new RangeError('not a civil date');
  return b - a;
}

/** 0 = Sunday, matching RFC 5545's WKST default and every calendar UI. */
export function dayOfWeek(date: CivilDate): number {
  const epoch = toEpochDay(date);
  if (epoch === undefined) throw new RangeError(`not a civil date: ${date}`);
  // 1970-01-01 was a Thursday.
  return (((epoch + 4) % 7) + 7) % 7;
}

/** Inclusive on both ends. */
export function eachDate(from: CivilDate, to: CivilDate): CivilDate[] {
  const start = toEpochDay(from);
  const end = toEpochDay(to);
  if (start === undefined || end === undefined) throw new RangeError('not a civil date');
  const out: CivilDate[] = [];
  for (let day = start; day <= end; day++) out.push(fromEpochDay(day));
  return out;
}

/** True modulo: the result carries the sign of the divisor, never the dividend. */
export function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * Which week of the year a date falls in, and the year that week belongs to.
 *
 * Two schemes, because there are genuinely two answers and the difference is
 * not cosmetic:
 *
 * - **`iso`** — ISO 8601. Weeks start Monday and week 1 is the one containing
 *   the first Thursday of January, so a week is never split across years and
 *   1 January can land in week 52 or 53 of the year before. `weekYear` is
 *   therefore not always the date's own year, which is the whole reason it is
 *   returned rather than assumed.
 * - **`simple`** — week 1 is the one containing 1 January, and weeks start on
 *   whichever day the household's calendar does. Every date is in its own
 *   calendar year, and week 1 can be a stub of one day.
 *
 * **The scheme has to match the grid it labels.** A number on a row of a wall
 * calendar is a claim that the row *is* that week — so labelling a
 * Sunday-start row with an ISO number, which starts on the Monday inside it,
 * puts a number on a row that spans two of them. Callers pick `simple` for a
 * Sunday-start household for that reason, not as a preference.
 */
export type WeekScheme = 'iso' | 'simple';

export interface WeekNumber {
  readonly week: number;
  /** The year the *week* belongs to, which under `iso` may not be the date's. */
  readonly weekYear: number;
}

/** How many days `date` sits past the most recent `weekStart` (0 = Sunday). */
function daysIntoWeek(date: CivilDate, weekStart: number): number {
  return floorMod(dayOfWeek(date) - weekStart, 7);
}

export function weekNumber(
  date: CivilDate,
  scheme: WeekScheme = 'iso',
  /** 0 = Sunday, 1 = Monday. Ignored under `iso`, which is Monday by definition. */
  weekStart = 1,
): WeekNumber {
  const epoch = toEpochDay(date);
  if (epoch === undefined) throw new RangeError(`not a civil date: ${date}`);

  if (scheme === 'iso') {
    /*
     * The Thursday of this date's week decides everything: it is always in the
     * week's majority year, so it names the week-year, and week 1 is by
     * definition the week holding 4 January.
     */
    const thursday = epoch - daysIntoWeek(date, 1) + 3;
    const weekYear = Number(fromEpochDay(thursday).slice(0, 4));
    const jan4 = `${weekYear}-01-04`;
    const firstWeekStart = (toEpochDay(jan4) as number) - daysIntoWeek(jan4, 1);
    return { week: Math.floor((thursday - firstWeekStart) / 7) + 1, weekYear };
  }

  const weekYear = Number(date.slice(0, 4));
  const jan1 = `${weekYear}-01-01`;
  // Week 1 starts on the `weekStart` on or before 1 January, so 1 January is
  // always in week 1 however far into its week it falls.
  const firstWeekStart = (toEpochDay(jan1) as number) - daysIntoWeek(jan1, weekStart);
  const thisWeekStart = epoch - daysIntoWeek(date, weekStart);
  return { week: Math.floor((thisWeekStart - firstWeekStart) / 7) + 1, weekYear };
}

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

import type { WallClock } from './types.js';

/**
 * Wall-clock <-> instant conversion backed entirely by `Intl`.
 *
 * Why not ical.js's VTIMEZONE handling: a feed's embedded VTIMEZONE is whatever
 * the producer shipped, sometimes years stale, sometimes absent, and Outlook
 * often names zones in Windows rather than IANA terms. `Intl` gives us the
 * platform's live IANA database, which the OS keeps current. So we expand
 * recurrences in pure wall-clock space (which is what RFC 5545 actually
 * specifies) and resolve each instance to an instant here, once.
 *
 * That split is the whole reason a weekly 09:00 event stays at 09:00 across a
 * DST boundary instead of drifting to 08:00 or 10:00.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, created);
  return created;
}

/**
 * Memoised for the same reason `formatterCache` above it is: constructing an
 * `Intl.DateTimeFormat` is one of the most expensive things ICU does, and a
 * feed asks this question twice per event (DTSTART and DTEND) while naming only
 * a handful of distinct zones. Uncached it was the single largest cost in
 * parsing a large feed. A zone's validity is a fact about the platform's ICU
 * build, so it cannot go stale inside one process.
 */
const validityCache = new Map<string, boolean>();
const VALIDITY_CACHE_LIMIT = 1_000;

/** True if this platform's ICU recognises the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  const cached = validityCache.get(timeZone);
  if (cached !== undefined) return cached;

  let valid: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    valid = true;
  } catch {
    valid = false;
  }
  // Bounded, and cleared wholesale rather than evicted one at a time, matching
  // `wallClockMemo` below. A feed naming tens of thousands of distinct zones is
  // hostile, not real.
  if (validityCache.size >= VALIDITY_CACHE_LIMIT) validityCache.clear();
  validityCache.set(timeZone, valid);
  return valid;
}

/** Build a UTC epoch ms from wall-clock fields, safe for years 0-99. */
export function utcMsFromWallClock(wc: WallClock): number {
  const d = new Date(0);
  d.setUTCFullYear(wc.year, wc.month - 1, wc.day);
  d.setUTCHours(wc.hour, wc.minute, wc.second, 0);
  return d.getTime();
}

/**
 * Memo keyed on the exact instant, so it cannot go stale or disagree with a
 * fresh computation. Resolving one wall clock probes several nearby instants,
 * and consecutive occurrences of a recurring event probe overlapping ones, so
 * the hit rate is high: measured 27us -> 2.7us per resolution.
 */
const wallClockMemo = new Map<string, WallClock>();
const WALL_CLOCK_MEMO_LIMIT = 40_000;

/** What the clock on the wall in `timeZone` reads at this instant. */
export function wallClockInZone(instantMs: number, timeZone: string): WallClock {
  const key = `${timeZone}|${instantMs}`;
  const memoized = wallClockMemo.get(key);
  if (memoized) return memoized;

  const computed = computeWallClockInZone(instantMs, timeZone);
  // Crude eviction, deliberately. A bounded map with a cheap clear beats an LRU
  // whose bookkeeping would cost more than the lookups it saves.
  if (wallClockMemo.size >= WALL_CLOCK_MEMO_LIMIT) wallClockMemo.clear();
  wallClockMemo.set(key, computed);
  return computed;
}

function computeWallClockInZone(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        // Some ICU versions render midnight as hour 24 under hour12:false,
        // while keeping the correct date. Normalising to 0 is what we want.
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

/** Offset in ms to add to an instant to get its local wall clock. */
export function offsetMsAt(instantMs: number, timeZone: string): number {
  return utcMsFromWallClock(wallClockInZone(instantMs, timeZone)) - instantMs;
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

export type ResolutionKind = 'exact' | 'ambiguous' | 'nonexistent';

export interface ZonedResolution {
  readonly instantMs: number;
  readonly kind: ResolutionKind;
}

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

/**
 * Resolve a wall clock in a zone to an instant.
 *
 * Two local readings are pathological and both happen twice a year in most of
 * the world, so neither may throw:
 *
 * - Ambiguous (clocks go back): the reading happens twice. We take the first,
 *   matching RFC 5545 readers and every calendar UI users already know.
 * - Nonexistent (clocks go forward): the reading never happens. We shift
 *   forward by the size of the gap, so an 02:30 alarm fires at 03:30 rather
 *   than vanishing. A vanished school run is a support ticket we cannot answer.
 */
export function resolveZonedWallClock(
  wc: WallClock,
  timeZone: string,
  prefer: 'earlier' | 'later' = 'earlier',
): ZonedResolution {
  const naive = utcMsFromWallClock(wc);

  // Probe either side of the reading so we see both offsets around any
  // transition, not just the one in force at the naive guess.
  const offsets = new Set<number>([
    offsetMsAt(naive - TWELVE_HOURS, timeZone),
    offsetMsAt(naive, timeZone),
    offsetMsAt(naive + TWELVE_HOURS, timeZone),
  ]);

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (sameWallClock(wallClockInZone(candidate, timeZone), wc)) {
      valid.push(candidate);
    }
  }

  if (valid.length === 0) {
    // Gap. Subtracting the smaller (more negative / pre-transition) offset
    // lands us just past the gap by exactly its width.
    let smallest = Number.POSITIVE_INFINITY;
    for (const offset of offsets) smallest = Math.min(smallest, offset);
    return { instantMs: naive - smallest, kind: 'nonexistent' };
  }

  valid.sort((a, b) => a - b);
  const chosen = prefer === 'later' ? valid[valid.length - 1]! : valid[0]!;
  return { instantMs: chosen, kind: valid.length > 1 ? 'ambiguous' : 'exact' };
}

/** Convenience wrapper when the caller does not care why. */
export function zonedWallClockToUtcMs(wc: WallClock, timeZone: string): number {
  return resolveZonedWallClock(wc, timeZone).instantMs;
}

function pad(n: number, width: number): string {
  return String(Math.abs(n)).padStart(width, '0');
}

/** `20260314T090000` — the canonical key for a recurrence instance. */
export function formatWallClockBasic(wc: WallClock): string {
  return (
    `${pad(wc.year, 4)}${pad(wc.month, 2)}${pad(wc.day, 2)}` +
    `T${pad(wc.hour, 2)}${pad(wc.minute, 2)}${pad(wc.second, 2)}`
  );
}

/** `2026-03-14` */
export function formatIsoDate(wc: WallClock): string {
  return `${pad(wc.year, 4)}-${pad(wc.month, 2)}-${pad(wc.day, 2)}`;
}

/** The calendar date an instant falls on, in the given zone. */
export function localDateOf(instantMs: number, timeZone: string): string {
  return formatIsoDate(wallClockInZone(instantMs, timeZone));
}

/** Shift a calendar date by whole days without touching the clock. */
export function addDaysToWallClock(wc: WallClock, days: number): WallClock {
  const base = utcMsFromWallClock(wc);
  const shifted = new Date(base + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Whole days between two calendar dates, ignoring any clock component. */
export function wholeDaysBetween(from: WallClock, to: WallClock): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

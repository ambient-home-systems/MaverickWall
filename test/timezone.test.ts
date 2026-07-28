import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  localDateOf,
  offsetMsAt,
  resolveZonedWallClock,
  wallClockInZone,
} from '../src/timezone.js';
import type { WallClock } from '../src/types.js';

/**
 * These exercise the primitive everything else rests on. They run without
 * ical.js, so they are the first thing to check when the suite goes red: if
 * these pass and the rest fail, the bug is in parsing or expansion, not in the
 * timezone maths.
 */

const wc = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): WallClock =>
  ({ year, month, day, hour, minute, second });

const iso = (w: WallClock, zone: string): string =>
  new Date(resolveZonedWallClock(w, zone).instantMs).toISOString();

describe('zone validation', () => {
  it('accepts IANA names and rejects everything else', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('wall clock to instant', () => {
  it('holds local time steady across US spring-forward', () => {
    expect(iso(wc(2026, 3, 7, 9), 'America/Chicago')).toBe('2026-03-07T15:00:00.000Z');
    expect(iso(wc(2026, 3, 8, 9), 'America/Chicago')).toBe('2026-03-08T14:00:00.000Z');
  });

  it('holds local time steady across European spring-forward, three weeks later', () => {
    expect(iso(wc(2026, 3, 28, 9), 'Europe/Berlin')).toBe('2026-03-28T08:00:00.000Z');
    expect(iso(wc(2026, 3, 29, 9), 'Europe/Berlin')).toBe('2026-03-29T07:00:00.000Z');
  });

  it('handles fractional-offset zones', () => {
    expect(iso(wc(2026, 6, 1, 9), 'Asia/Kolkata')).toBe('2026-06-01T03:30:00.000Z');
    expect(iso(wc(2026, 6, 1, 9), 'Asia/Kathmandu')).toBe('2026-06-01T03:15:00.000Z');
  });

  it('picks the first instant for an ambiguous reading, and can be asked for the second', () => {
    const earlier = resolveZonedWallClock(wc(2026, 11, 1, 1, 30), 'America/Chicago', 'earlier');
    const later = resolveZonedWallClock(wc(2026, 11, 1, 1, 30), 'America/Chicago', 'later');
    expect(earlier.kind).toBe('ambiguous');
    expect(new Date(earlier.instantMs).toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(new Date(later.instantMs).toISOString()).toBe('2026-11-01T07:30:00.000Z');
  });

  it('shifts a nonexistent reading forward past the gap rather than dropping it', () => {
    const result = resolveZonedWallClock(wc(2026, 3, 8, 2, 30), 'America/Chicago');
    expect(result.kind).toBe('nonexistent');
    expect(wallClockInZone(result.instantMs, 'America/Chicago')).toMatchObject({
      day: 8,
      hour: 3,
      minute: 30,
    });
  });

  it('survives a zone whose transition lands on midnight', () => {
    // Santiago moves its clock at 00:00, so local midnight does not exist that
    // day. An all-day event anchored there must still resolve to something.
    const result = resolveZonedWallClock(wc(2026, 9, 6, 0, 0), 'America/Santiago');
    expect(Number.isFinite(result.instantMs)).toBe(true);
    expect(localDateOf(result.instantMs, 'America/Santiago')).toBe('2026-09-06');
  });

  it('handles southern-hemisphere transitions, which run the other way', () => {
    const result = resolveZonedWallClock(wc(2026, 4, 5, 2, 30), 'Australia/Sydney');
    expect(result.kind).toBe('ambiguous');
    expect(new Date(result.instantMs).toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });
});

describe('round trip', () => {
  it('is lossless for every unambiguous hour of 2026 in a DST zone', () => {
    const zone = 'America/Chicago';
    let mismatches = 0;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
      const back = resolveZonedWallClock(wallClockInZone(t, zone), zone, 'earlier').instantMs;
      // Ambiguous readings legitimately resolve to the earlier of two instants.
      if (back !== t && offsetMsAt(back, zone) === offsetMsAt(t, zone)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('is lossless across a European year too', () => {
    const zone = 'Europe/Berlin';
    let mismatches = 0;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3_600_000) {
      const back = resolveZonedWallClock(wallClockInZone(t, zone), zone, 'earlier').instantMs;
      if (back !== t && offsetMsAt(back, zone) === offsetMsAt(t, zone)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

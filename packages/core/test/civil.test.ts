import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  daysBetween,
  eachDate,
  floorMod,
  fromEpochDay,
  isCivilDate,
  toEpochDay,
} from '../src/time/civil.js';

describe('civil date arithmetic', () => {
  it('crosses month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('measures signed distance between dates', () => {
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
    expect(daysBetween('2026-03-01', '2026-01-01')).toBe(-59);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('is unaffected by daylight saving transitions', () => {
    // A civil date has no timezone, so the day either side of a transition is
    // exactly one day. Doing this arithmetic in instant-space is how rotations
    // slide by a day twice a year.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2026-10-25', '2026-11-08')).toBe(14);
  });

  it('reports day of week with Sunday as zero', () => {
    expect(dayOfWeek('2026-01-01')).toBe(4); // Thursday
    expect(dayOfWeek('2026-03-01')).toBe(0); // Sunday
    expect(dayOfWeek('1970-01-01')).toBe(4);
  });

  it('rejects impossible dates that Date.UTC would silently roll forward', () => {
    expect(isCivilDate('2026-02-30')).toBe(false);
    expect(isCivilDate('2026-13-01')).toBe(false);
    expect(isCivilDate('2026-00-10')).toBe(false);
    expect(isCivilDate('2026-1-1')).toBe(false);
    expect(isCivilDate('not a date')).toBe(false);
    expect(isCivilDate('2024-02-29')).toBe(true);
    expect(isCivilDate('2026-12-31')).toBe(true);
  });

  it('round-trips through epoch days', () => {
    for (const date of ['1970-01-01', '2026-07-28', '1999-12-31', '2100-03-01']) {
      expect(fromEpochDay(toEpochDay(date)!)).toBe(date);
    }
  });

  it('enumerates inclusive ranges', () => {
    expect(eachDate('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(eachDate('2026-01-01', '2026-01-01')).toEqual(['2026-01-01']);
  });

  it('takes the sign of the divisor, not the dividend', () => {
    // Dates before a cycle anchor produce negative offsets. JavaScript's %
    // would return a negative index and read off the end of the cycle array.
    expect(floorMod(-3, 70)).toBe(67);
    expect(floorMod(-70, 70)).toBe(0);
    expect(floorMod(-71, 70)).toBe(69);
    expect(floorMod(3, 70)).toBe(3);
  });
});

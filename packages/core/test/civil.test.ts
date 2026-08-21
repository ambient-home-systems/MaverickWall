import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  weekNumber,
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

/*
 * Week numbers.
 *
 * The values below come from the ISO 8601 definition, not from running the
 * implementation and writing down what it said — which is the only way this
 * kind of test is worth anything. The awkward ones are the year edges, where
 * a week belongs to a year that is not the date's own.
 */
describe('week numbers', () => {
  describe('ISO 8601', () => {
    it.each([
      ['2026-01-01', 1, 2026],   // a Thursday, so its week is week 1
      ['2025-12-29', 1, 2026],   // the Monday of that same week — previous year
      ['2026-08-21', 34, 2026],
      ['2026-12-31', 53, 2026],  // 2026 starts on a Thursday: a 53-week year
      ['2027-01-03', 53, 2026],  // still the Sunday of 2026-W53
      ['2027-01-04', 1, 2027],
      ['2021-01-01', 53, 2020],  // a Friday, so it belongs to the year before
      ['2019-12-30', 1, 2020],
      ['2015-12-28', 53, 2015],
      ['2016-01-04', 1, 2016],
    ])('%s is week %i of %i', (date, week, weekYear) => {
      expect(weekNumber(date, 'iso')).toEqual({ week, weekYear });
    });

    it('ignores the household week start, being Monday by definition', () => {
      expect(weekNumber('2026-08-21', 'iso', 0)).toEqual(weekNumber('2026-08-21', 'iso', 1));
    });

    it('gives every day of a week the same number', () => {
      // 2026-08-17 is a Monday; its whole week must read 34.
      for (let day = 17; day <= 23; day++) {
        expect(weekNumber(`2026-08-${day}`, 'iso').week).toBe(34);
      }
      expect(weekNumber('2026-08-24', 'iso').week).toBe(35);
    });
  });

  describe('the simple scheme', () => {
    it('puts 1 January in week 1 whatever day it falls on', () => {
      // 2026-01-01 is a Thursday. Under ISO its Sunday-start row would carry
      // two different week numbers; here the row is simply week 1.
      expect(weekNumber('2026-01-01', 'simple', 0)).toEqual({ week: 1, weekYear: 2026 });
      expect(weekNumber('2026-01-03', 'simple', 0)).toEqual({ week: 1, weekYear: 2026 });
      // The Sunday after is the start of week 2.
      expect(weekNumber('2026-01-04', 'simple', 0)).toEqual({ week: 2, weekYear: 2026 });
    });

    it('keeps every date in its own calendar year', () => {
      // The opposite of ISO: no date is ever attributed to the year before.
      expect(weekNumber('2021-01-01', 'simple', 0).weekYear).toBe(2021);
      expect(weekNumber('2021-01-01', 'simple', 0).week).toBe(1);
    });

    it('follows the household week start', () => {
      // 2026-08-23 is a Sunday: the last day of a Monday week, the first of a
      // Sunday one, so the two schemes must disagree by one here and nowhere
      // else in that week.
      const sundayStart = weekNumber('2026-08-23', 'simple', 0).week;
      const mondayStart = weekNumber('2026-08-23', 'simple', 1).week;
      expect(sundayStart).toBe(mondayStart + 1);
    });

    it('gives every day of a week the same number', () => {
      const first = weekNumber('2026-08-23', 'simple', 0).week;
      for (let day = 23; day <= 29; day++) {
        expect(weekNumber(`2026-08-${day}`, 'simple', 0).week).toBe(first);
      }
    });
  });

  it('refuses a string that is not a date', () => {
    expect(() => weekNumber('not-a-date')).toThrow(RangeError);
    expect(() => weekNumber('2026-08')).toThrow(RangeError);
  });

  it('rolls an out-of-range month rather than refusing it, like its neighbours', () => {
    // `toEpochDay` validates shape, not calendar sense — "2026-13-01" rolls
    // into 2027-01-01, exactly as `dayOfWeek` and `addDays` treat it.
    // `isCivilDate` is the round-trip check, and callers that need one use it.
    // Pinned so this reads as the module's contract rather than an oversight.
    expect(weekNumber('2026-13-01', 'iso')).toEqual(weekNumber('2027-01-01', 'iso'));
  });
});

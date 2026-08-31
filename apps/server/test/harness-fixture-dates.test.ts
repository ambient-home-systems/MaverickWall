/**
 * The harness dates its fixtures from the wall's today, not the runner's.
 *
 * This is the assertion that could not be made by running the suite, because
 * the fault it guards is only reachable for part of the day. `browser-harness`
 * stamped `day: 0` from `Date.now()` read in UTC while the household it seeds
 * is on `Europe/London`, so from 23:00 UTC through British Summer Time — an
 * hour every night — the wall's today was already tomorrow and every fixture
 * landed a day early.
 *
 * What that cost was two wall tests failing every night for an hour with the
 * same two assertions and the same numbers: `browser-grid-calendar` counting 1
 * event in today's cell where it seeds 2 (the all-day one slides off today, the
 * timed one does not), and `browser-classic-proportions` measuring a shift chip
 * at 20.6px against its 22px floor, because an agenda holding a different day's
 * events settles at a different fit. Both were read as flakes, and both were
 * the clock.
 *
 * So the instant is a parameter here and every case names one. A test that can
 * only fail between 23:00 and midnight is a test that reports the truth once a
 * day and passes twenty-three times over it.
 */
import { describe, expect, it } from 'vitest';
import { fixtureDate } from './browser-harness.js';

describe('fixture dates are the wall clock, not the runner clock', () => {
  /**
   * The hour the suite was actually failing in.
   *
   * 23:30 UTC on 31 August: London is on BST, so it is already 00:30 on the
   * 1st there. `day: 0` means the day the household would call today, which is
   * the 1st — the UTC reading, the 31st, is yesterday's wall.
   */
  it('reads the household day, not the UTC day, in the hour they disagree', () => {
    const inThatHour = new Date('2026-08-31T23:30:00Z');
    expect(fixtureDate('Europe/London', 0, inThatHour)).toBe('20260901');
    // Named rather than implied: this is precisely the value the old stamping
    // produced, and the one that put an all-day event on yesterday's cell.
    expect(fixtureDate('Europe/London', 0, inThatHour)).not.toBe('20260831');
  });

  it('agrees with UTC the rest of the day', () => {
    expect(fixtureDate('Europe/London', 0, new Date('2026-08-31T12:00:00Z'))).toBe('20260831');
  });

  /** The same disagreement the other way round: a zone behind UTC. */
  it('reads a zone behind UTC as its own earlier day', () => {
    const justAfterMidnightUtc = new Date('2026-09-01T02:00:00Z');
    expect(fixtureDate('America/New_York', 0, justAfterMidnightUtc)).toBe('20260831');
    expect(fixtureDate('Etc/UTC', 0, justAfterMidnightUtc)).toBe('20260901');
  });

  /** `day` is a count of days, so it carries over a month end. */
  it('counts days across a month boundary', () => {
    const inThatHour = new Date('2026-08-31T23:30:00Z');
    expect(fixtureDate('Europe/London', 1, inThatHour)).toBe('20260902');
    expect(fixtureDate('Europe/London', 30, inThatHour)).toBe('20261001');
  });

  /**
   * And a day is not always 24 hours.
   *
   * British Summer Time ends at 02:00 on 25 October 2026, so the 25th is a
   * 25-hour day. Adding `days * 86_400_000` to an instant lands inside the 25th
   * rather than on the 26th; civil arithmetic on a date cannot.
   */
  it('crosses a daylight-saving change without losing a day', () => {
    const beforeTheChange = new Date('2026-10-24T12:00:00Z');
    expect(fixtureDate('Europe/London', 1, beforeTheChange)).toBe('20261025');
    expect(fixtureDate('Europe/London', 2, beforeTheChange)).toBe('20261026');
  });
});

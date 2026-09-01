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
import { HARNESS_HOUR, HOUSEHOLD_CALENDARS, fixtureDate, fixtureNow } from './browser-harness.js';

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

/**
 * The hour the wall is drawn at, which is the other half of the same fault.
 *
 * Dating the *fixtures* from the wall's day fixed the hour every night when
 * London and UTC disagree about which day it is. It left the suite depending on
 * what o'clock it ran at in a second, quieter way: an event that is *running*
 * when the wall is drawn puts a progress bar in the agenda, `.dr-ev-bar` is an
 * in-flow grid item, and the row it costs takes `fitToBox`'s scale down enough
 * to put a 22.08px rota chip under this product's 22px floor. So
 * `browser-classic-proportions` failed for as long as a fixture event ran —
 * 09:15 to 10:00 on the run that found this — and passed the rest of the day.
 * Same shape as the 23:00 bug, same reading as a flake, and not one.
 *
 * `fixtureNow` is what removes it: the wall is drawn at 11:00 in the
 * household's own zone, which is an hour clear of every `day: 0` fixture in
 * this suite. The date still moves with the calendar; only the hour is pinned.
 */
describe('the wall is drawn at a pinned hour of the household day', () => {
  /** What a zone's clock reads at an instant, as `YYYY-MM-DD HH:MM`. */
  const reading = (zone: string, at: number): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
      .format(new Date(at))
      .replace(',', '');

  /**
   * The hour the two wall tests were actually failing in, and the hour they
   * were passing in, have to produce the identical wall.
   *
   * This is the whole assertion: the same day, drawn at the same hour, from
   * two runs of the suite started 45 minutes apart across a fixture event's
   * start. Before this the second one drew a running event and the first did
   * not, and one of them measured a rota chip at 21.7px.
   */
  it('draws the same instant whatever o clock the runner started at', () => {
    const beforeAssembly = fixtureNow('Europe/London', new Date('2026-09-01T07:48:00Z'));
    const duringAssembly = fixtureNow('Europe/London', new Date('2026-09-01T08:33:00Z'));
    expect(beforeAssembly).toBe(duringAssembly);
    expect(reading('Europe/London', beforeAssembly)).toBe('2026-09-01 11:00');
  });

  /**
   * And it is 11:00 *there*, not 11:00 UTC.
   *
   * A fixture event is written `TZID=Europe/London`, so an hour that is quiet
   * in UTC and busy in the household's zone is no pinning at all.
   */
  it('reads eleven in the household zone, not in UTC', () => {
    const at = fixtureNow('America/New_York', new Date('2026-09-01T12:00:00Z'));
    expect(reading('America/New_York', at)).toBe(`2026-09-01 ${String(HARNESS_HOUR).padStart(2, '0')}:00`);
    expect(reading('Etc/UTC', at)).toBe('2026-09-01 15:00');
  });

  /** Still the household's own day in the hour it disagrees with the runner's. */
  it('takes the day from the zone in the hour they disagree', () => {
    const inThatHour = new Date('2026-08-31T23:30:00Z');
    expect(reading('Europe/London', fixtureNow('Europe/London', inThatHour))).toBe('2026-09-01 11:00');
  });

  /**
   * The correction has to be applied twice, and this is the one day in 2026
   * that proves it — which is the reason it is named here rather than reasoned
   * about.
   *
   * Adak is UTC-10 in winter and puts its clocks forward at 02:00 on 8 March
   * 2026. Guessing 11:00 as though it were UTC lands at 01:00 that morning
   * there, which is still -10; correcting by ten hours lands at 12:00, which is
   * now -9. **One pass draws the wall an hour late.** Two lands on 11:00, and a
   * third changes nothing — checked against all 418 zones `Intl` knows for every
   * day of 2026, where one pass differs from two on this date and this zone
   * alone, and two never differs from three.
   *
   * The first draft of this case was Auckland, reasoned out rather than
   * measured, and it passed with the second correction deleted. A case that
   * cannot go red is not a case.
   */
  it('corrects twice, so a guess across a daylight-saving change still lands', () => {
    // Any instant whose Adak date is already the 8th: 22:00 UTC is 13:00 there.
    const at = fixtureNow('America/Adak', new Date('2026-03-08T22:00:00Z'));
    expect(reading('America/Adak', at)).toBe('2026-03-08 11:00');
  });

  /**
   * And it is 11:00 every day of a year, in zones that change their clocks in
   * both directions and one that does not.
   *
   * A property rather than a handful of instants, because the failure mode
   * being guarded is "right for most of the year", which is exactly what a
   * handful of instants reports as fine.
   */
  it('lands on the hour on every day of a year, in four zones', () => {
    // Adak is in the list because it is the zone that breaks a single
    // correction pass; Kolkata because a half-hour offset is its own arithmetic.
    const zones = ['Europe/London', 'America/New_York', 'America/Adak', 'Asia/Kolkata'];
    const wrong: string[] = [];
    for (const zone of zones) {
      for (let day = 0; day < 365; day += 1) {
        const from = new Date(Date.UTC(2026, 0, 1, 3, 0) + day * 86_400_000);
        const drawn = reading(zone, fixtureNow(zone, from));
        if (!drawn.endsWith(' 11:00')) wrong.push(`${zone} ${drawn}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The pinned hour is quiet, and that is a fact about the fixtures rather
   * than about the arithmetic — so it is asserted against them.
   *
   * `HOUSEHOLD_CALENDARS` is what both density ratchets measure. If somebody
   * adds a `day: 0` event that straddles eleven o'clock, every baseline in
   * both files moves and nothing else would say why.
   */
  it('lands in an hour with no fixture event running', () => {
    const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(2));
    const pinned = HARNESS_HOUR * 60;
    const live = HOUSEHOLD_CALENDARS.flatMap((calendar) =>
      calendar.events.filter(
        (event) =>
          event.day === 0 &&
          event.from !== undefined &&
          event.to !== undefined &&
          minutes(event.from) <= pinned &&
          minutes(event.to) > pinned,
      ).map((event) => event.title),
    );
    expect(live).toEqual([]);
  });
});

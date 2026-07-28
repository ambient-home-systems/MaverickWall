import { describe, expect, it } from 'vitest';
import { byUid, expandOk, startsOf } from './support/helpers.js';

const NY = 'America/New_York';
const WIDE_1997 = {
  windowStart: new Date('1997-01-01T00:00:00Z'),
  windowEnd: new Date('1998-01-01T00:00:00Z'),
};

describe('R1 — RRULE parts', () => {
  it('[R1] FREQ=DAILY with COUNT produces exactly COUNT instances', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY }),
      'freq-daily@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-01-05T14:00:00.000Z',
      '2026-01-06T14:00:00.000Z',
      '2026-01-07T14:00:00.000Z',
    ]);
  });

  it('[R1] INTERVAL and BYDAY together skip alternate weeks', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY }),
      'interval-byday@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-01-05T16:00:00.000Z',
      '2026-01-07T16:00:00.000Z',
      '2026-01-19T16:00:00.000Z',
      '2026-01-21T16:00:00.000Z',
      '2026-02-02T16:00:00.000Z',
      '2026-02-04T16:00:00.000Z',
    ]);
  });

  it('[R1] BYMONTHDAY lands on the same date each month, adjusting for DST', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY }),
      'bymonthday@synthetic',
    );
    // 14:00 local is 19:00Z under EST and 18:00Z under EDT. March is past the
    // 8th, so the third instance shifts by an hour in UTC while staying at
    // 14:00 on the wall.
    expect(startsOf(events)).toEqual([
      '2026-01-15T19:00:00.000Z',
      '2026-02-15T19:00:00.000Z',
      '2026-03-15T18:00:00.000Z',
    ]);
  });

  it('[R1] BYSETPOS=-1 selects the last weekday of each month', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY }),
      'bysetpos@synthetic',
    );
    // Jan 31 and Feb 28 2026 are Saturdays, so the last weekday falls earlier;
    // Mar 31 is a Tuesday.
    expect(startsOf(events)).toEqual([
      '2026-01-30T21:00:00.000Z',
      '2026-02-27T21:00:00.000Z',
      '2026-03-31T20:00:00.000Z',
    ]);
  });

  it('[R1] UNTIL is inclusive and compared in the correct timezone', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY }),
      'until@synthetic',
    );
    // UNTIL is 2026-01-27T13:00:00Z, exactly the fourth instance, which RFC 5545
    // includes.
    expect(startsOf(events)).toEqual([
      '2026-01-06T13:00:00.000Z',
      '2026-01-13T13:00:00.000Z',
      '2026-01-20T13:00:00.000Z',
      '2026-01-27T13:00:00.000Z',
    ]);
  });

  it('[R1] WKST=MO matches the worked example in RFC 5545 section 3.8.5.3', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY, ...WIDE_1997 }),
      'wkst-mo@synthetic',
    );
    // The RFC's own answer: August 5, 10, 19, 24 1997.
    expect(startsOf(events)).toEqual([
      '1997-08-05T13:00:00.000Z',
      '1997-08-10T13:00:00.000Z',
      '1997-08-19T13:00:00.000Z',
      '1997-08-24T13:00:00.000Z',
    ]);
  });

  it('[R1] WKST=SU changes the result, per the same RFC example', () => {
    const events = byUid(
      expandOk('synthetic/rrule-comprehensive.ics', { targetTimezone: NY, ...WIDE_1997 }),
      'wkst-su@synthetic',
    );
    // Same rule, different week start: August 5, 17, 19, 31 1997. If this
    // matches the WKST=MO case above, WKST is being ignored.
    expect(startsOf(events)).toEqual([
      '1997-08-05T14:00:00.000Z',
      '1997-08-17T14:00:00.000Z',
      '1997-08-19T14:00:00.000Z',
      '1997-08-31T14:00:00.000Z',
    ]);
  });
});

describe('R2 — EXDATE exclusions', () => {
  it('[R2] a single EXDATE removes exactly one instance', () => {
    const events = byUid(expandOk('synthetic/exdate.ics'), 'exdate-single@synthetic');
    expect(startsOf(events)).toEqual([
      '2026-06-01T13:00:00.000Z',
      '2026-06-02T13:00:00.000Z',
      '2026-06-04T13:00:00.000Z',
      '2026-06-05T13:00:00.000Z',
    ]);
  });

  it('[R2] a multi-value EXDATE on one line removes every date it lists', () => {
    const events = byUid(expandOk('synthetic/exdate.ics'), 'exdate-multi@synthetic');
    expect(startsOf(events)).toEqual([
      '2026-07-01T13:00:00.000Z',
      '2026-07-03T13:00:00.000Z',
      '2026-07-05T13:00:00.000Z',
    ]);
  });

  it('[R2] EXDATE works on an all-day series', () => {
    const events = byUid(expandOk('synthetic/exdate.ics'), 'exdate-allday@synthetic');
    expect(events).toHaveLength(3);
    expect(startsOf(events)).toEqual([
      '2026-08-10T05:00:00.000Z',
      '2026-08-11T05:00:00.000Z',
      '2026-08-13T05:00:00.000Z',
    ]);
  });
});

describe('R3 — RDATE additions', () => {
  it('[R3] RDATE adds an instance outside the RRULE pattern', () => {
    const events = byUid(expandOk('synthetic/rdate.ics'), 'rdate-extra@synthetic');
    expect(startsOf(events)).toEqual([
      '2026-06-01T13:00:00.000Z',
      '2026-06-08T13:00:00.000Z',
      '2026-06-19T13:00:00.000Z',
    ]);
  });

  it('[R3] RDATE works with no RRULE at all', () => {
    const events = byUid(expandOk('synthetic/rdate.ics'), 'rdate-only@synthetic');
    expect(startsOf(events)).toEqual([
      '2026-09-01T17:00:00.000Z',
      '2026-09-03T17:00:00.000Z',
      '2026-09-05T17:00:00.000Z',
    ]);
  });
});

describe('R4 — RECURRENCE-ID overrides', () => {
  it('[R4] a moved instance appears at its new time and nowhere else', () => {
    const events = byUid(
      expandOk('synthetic/recurrence-id-overrides.ics'),
      'standup@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-06-01T13:00:00.000Z',
      '2026-06-02T19:00:00.000Z',
      '2026-06-03T13:00:00.000Z',
      '2026-06-05T13:00:00.000Z',
    ]);
  });

  it('[R4] a retitled instance carries the override title and duration', () => {
    const events = byUid(
      expandOk('synthetic/recurrence-id-overrides.ics'),
      'standup@synthetic',
    );
    const retitled = events.find(
      (event) => event.startUtc.toISOString() === '2026-06-03T13:00:00.000Z',
    );
    expect(retitled?.title).toBe('Standup - retro instead');
    expect(retitled?.endUtc.toISOString()).toBe('2026-06-03T14:00:00.000Z');
  });

  it('[R4] a cancelled instance is removed while the rest of the series survives', () => {
    const events = byUid(
      expandOk('synthetic/recurrence-id-overrides.ics'),
      'standup@synthetic',
    );
    expect(startsOf(events)).not.toContain('2026-06-04T13:00:00.000Z');
    expect(events).toHaveLength(4);
  });

  it('[R4] overridden instances keep the recurrence id of the slot they replaced', () => {
    const events = byUid(
      expandOk('synthetic/recurrence-id-overrides.ics'),
      'standup@synthetic',
    );
    const moved = events.find(
      (event) => event.startUtc.toISOString() === '2026-06-02T19:00:00.000Z',
    );
    // The identity is the original slot, not the new time, so per-instance
    // state such as "dismissed" survives a reschedule.
    expect(moved?.recurrenceId).toBe('20260602T080000');
    expect(moved?.isRecurringInstance).toBe(true);
  });
});

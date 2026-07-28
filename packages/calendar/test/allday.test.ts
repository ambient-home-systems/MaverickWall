import { describe, expect, it } from 'vitest';
import { byUid, daysCovered, expandOk } from './support/helpers.js';

const CHI = 'America/Chicago';

describe('R10 — all-day events with exclusive DTEND', () => {
  it('[R10] a one-day all-day event on 2026-03-15 appears on the 15th and only the 15th', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-one@synthetic')[0];
    expect(event?.allDay).toBe(true);
    // DTEND is 2026-03-16, exclusive. The classic off-by-one is to let this
    // bleed into the 16th and put a birthday on the wrong day.
    expect(daysCovered(event!, CHI)).toEqual(['2026-03-15']);
  });

  it('[R10] endUtc is local midnight after the last day, not on it', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-one@synthetic')[0];
    expect(event?.startUtc.toISOString()).toBe('2026-03-15T05:00:00.000Z');
    expect(event?.endUtc.toISOString()).toBe('2026-03-16T05:00:00.000Z');
  });

  it('[R10] an omitted DTEND implies exactly one day', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-no-dtend@synthetic')[0];
    expect(daysCovered(event!, CHI)).toEqual(['2026-03-20']);
  });

  it('[R10] all-day events anchor to the target zone, not to UTC', () => {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      const event = byUid(
        expandOk('synthetic/allday.ics', { targetTimezone: zone }),
        'allday-one@synthetic',
      )[0];
      expect(daysCovered(event!, zone), zone).toEqual(['2026-03-15']);
    }
  });

  it('[R10] a recurring all-day event keeps the one-day span on every instance', () => {
    const events = byUid(
      expandOk('synthetic/allday.ics', {
        windowStart: new Date('2026-01-01T00:00:00Z'),
        windowEnd: new Date('2028-01-01T00:00:00Z'),
      }),
      'allday-recurring@synthetic',
    );
    expect(events).toHaveLength(2);
    expect(daysCovered(events[0]!, CHI)).toEqual(['2026-04-15']);
    expect(daysCovered(events[1]!, CHI)).toEqual(['2027-04-15']);
  });
});

describe('R11 — all-day events on the last day of a month', () => {
  it('[R11] 2026-02-28 does not spill into March', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-month-end@synthetic')[0];
    expect(daysCovered(event!, CHI)).toEqual(['2026-02-28']);
    expect(event?.startUtc.toISOString()).toBe('2026-02-28T06:00:00.000Z');
  });

  it('[R11] 2026-03-31 does not spill into April', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-month-end-31@synthetic')[0];
    expect(daysCovered(event!, CHI)).toEqual(['2026-03-31']);
    // March 31 is on summer time, so local midnight is 05:00Z rather than 06:00Z.
    expect(event?.startUtc.toISOString()).toBe('2026-03-31T05:00:00.000Z');
  });

  it('[R11] 2026-12-31 does not spill into the next year', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-year-end@synthetic')[0];
    expect(daysCovered(event!, CHI)).toEqual(['2026-12-31']);
  });
});

describe('R12 — multi-day spanning events', () => {
  it('[R12] a four-day span covers every day it touches and no more', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-multiday@synthetic')[0];
    expect(daysCovered(event!, CHI)).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
  });

  it('[R12] the span stays four days even though it crosses a DST change', () => {
    const event = byUid(expandOk('synthetic/allday.ics'), 'allday-multiday@synthetic')[0];
    // Four calendar days, but only 95 real hours: the 8th is an hour short.
    expect(event?.startUtc.toISOString()).toBe('2026-03-06T06:00:00.000Z');
    expect(event?.endUtc.toISOString()).toBe('2026-03-10T05:00:00.000Z');
    const elapsedHours =
      (event!.endUtc.getTime() - event!.startUtc.getTime()) / 3_600_000;
    expect(elapsedHours).toBe(95);
  });

  it('[R12] a timed event crossing midnight covers both days', () => {
    const event = byUid(
      expandOk('synthetic/window-straddle.ics', {
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-07-01T00:00:00Z'),
      }),
      'straddle-start@synthetic',
    )[0];
    expect(daysCovered(event!, 'UTC')).toEqual(['2026-06-14', '2026-06-15']);
  });
});

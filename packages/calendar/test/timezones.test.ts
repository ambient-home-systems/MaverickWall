import { describe, expect, it } from 'vitest';
import { byUid, expandOk, expandRaw, inZone, startsOf } from './support/helpers.js';

const NY = 'America/New_York';
const BERLIN = 'Europe/Berlin';

describe('R5 — VTIMEZONE definitions and TZID references', () => {
  it('[R5] a TZID referencing an embedded VTIMEZONE resolves either side of the transition', () => {
    const events = expandOk('synthetic/vtimezone-custom.ics');
    const summer = byUid(events, 'vtz-referenced@synthetic')[0];
    const winter = byUid(events, 'vtz-winter@synthetic')[0];
    // Same TZID, same wall time, one hour apart in UTC.
    expect(summer?.startUtc.toISOString()).toBe('2026-06-15T14:30:00.000Z');
    expect(winter?.startUtc.toISOString()).toBe('2026-01-15T15:30:00.000Z');
  });

  it('[R5] sourceTzid reports the zone the event was authored in', () => {
    const events = expandOk('synthetic/vtimezone-custom.ics');
    expect(events.every((event) => event.sourceTzid === 'America/Chicago')).toBe(true);
  });

  it('[R5] Windows zone names from Outlook feeds are mapped to IANA', () => {
    const events = expandOk('synthetic/windows-timezones.ics');
    expect(byUid(events, 'outlook-eastern@synthetic')[0]?.startUtc.toISOString()).toBe(
      '2026-06-15T13:00:00.000Z',
    );
    expect(byUid(events, 'outlook-eastern@synthetic')[0]?.sourceTzid).toBe('America/New_York');
    expect(byUid(events, 'outlook-gmt@synthetic')[0]?.startUtc.toISOString()).toBe(
      '2026-06-15T08:00:00.000Z',
    );
  });

  it('[R5] a producer-prefixed TZID is unwrapped', () => {
    const events = expandOk('synthetic/windows-timezones.ics');
    const event = byUid(events, 'mozilla-prefixed@synthetic')[0];
    expect(event?.sourceTzid).toBe('America/Chicago');
    expect(event?.startUtc.toISOString()).toBe('2026-06-15T14:00:00.000Z');
  });

  it('[R5] an unresolvable TZID falls back to the target zone and warns', () => {
    const result = expandRaw('synthetic/windows-timezones.ics');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.value.find((candidate) => candidate.uid === 'unknown-zone@synthetic');
    expect(event?.startUtc.toISOString()).toBe('2026-06-15T14:00:00.000Z');
    expect(event?.sourceTzid).toBe('America/Chicago');
    expect(result.meta.warnings.some((w) => w.code === 'UNRESOLVED_TIMEZONE')).toBe(true);
  });
});

describe('R6 — floating times resolved against targetTimezone', () => {
  it('[R6] the same floating event lands at different instants in different target zones', () => {
    const chicago = byUid(
      expandOk('synthetic/floating-times.ics', { targetTimezone: 'America/Chicago' }),
      'floating-single@synthetic',
    )[0];
    const berlin = byUid(
      expandOk('synthetic/floating-times.ics', { targetTimezone: BERLIN }),
      'floating-single@synthetic',
    )[0];
    expect(chicago?.startUtc.toISOString()).toBe('2026-06-14T13:00:00.000Z');
    expect(berlin?.startUtc.toISOString()).toBe('2026-06-14T06:00:00.000Z');
  });

  it('[R6] a floating recurrence follows the target zone across its DST change', () => {
    const events = byUid(
      expandOk('synthetic/floating-times.ics', { targetTimezone: NY }),
      'floating-recurring@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-03-04T14:00:00.000Z',
      '2026-03-11T13:00:00.000Z',
      '2026-03-18T13:00:00.000Z',
    ]);
    expect(events.every((event) => inZone(event.startUtc, NY).endsWith('09:00'))).toBe(true);
  });

  it('[R6] an explicit UTC time is unaffected by the target zone', () => {
    for (const zone of ['America/Chicago', BERLIN, 'Australia/Sydney']) {
      const event = byUid(
        expandOk('synthetic/floating-times.ics', { targetTimezone: zone }),
        'utc-explicit@synthetic',
      )[0];
      expect(event?.startUtc.toISOString(), zone).toBe('2026-06-14T08:00:00.000Z');
      expect(event?.sourceTzid, zone).toBe('UTC');
    }
  });
});

describe('R7 — weekly recurrence across US spring-forward', () => {
  it('[R7] instances stay at 09:00 local while the UTC offset shifts', () => {
    const events = byUid(
      expandOk('synthetic/dst-us.ics', { targetTimezone: NY }),
      'us-spring-forward@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-03-04T14:00:00.000Z',
      '2026-03-11T13:00:00.000Z',
      '2026-03-18T13:00:00.000Z',
    ]);
    expect(events.map((event) => inZone(event.startUtc, NY))).toEqual([
      '2026-03-04 09:00',
      '2026-03-11 09:00',
      '2026-03-18 09:00',
    ]);
  });

  it('[R7] an event spanning the missing hour keeps its wall-clock duration', () => {
    const event = byUid(
      expandOk('synthetic/dst-us.ics', { targetTimezone: NY }),
      'us-spans-transition@synthetic',
    )[0];
    // 01:00 to 04:00 on the wall, but only two real hours elapse because 02:00
    // never happens. Wall-clock duration is what users mean and what mainstream
    // clients do.
    expect(event?.startUtc.toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(event?.endUtc.toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });
});

describe('R8 — weekly recurrence across US fall-back', () => {
  it('[R8] instances stay at 09:00 local across the November transition', () => {
    const events = byUid(
      expandOk('synthetic/dst-us.ics', { targetTimezone: NY }),
      'us-fall-back@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-10-28T13:00:00.000Z',
      '2026-11-04T14:00:00.000Z',
      '2026-11-11T14:00:00.000Z',
    ]);
    expect(events.map((event) => inZone(event.startUtc, NY))).toEqual([
      '2026-10-28 09:00',
      '2026-11-04 09:00',
      '2026-11-11 09:00',
    ]);
  });
});

describe('R9 — weekly recurrence across European DST dates', () => {
  it('[R9] Berlin transitions on 2026-03-29, three weeks after the United States', () => {
    const events = byUid(
      expandOk('synthetic/dst-europe.ics', { targetTimezone: BERLIN }),
      'eu-spring-forward@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-03-25T08:00:00.000Z',
      '2026-04-01T07:00:00.000Z',
      '2026-04-08T07:00:00.000Z',
    ]);
  });

  it('[R9] on 2026-03-25 the US is already on summer time and Europe is not', () => {
    // The single assertion that proves the engine is not applying one
    // hardcoded DST rule to every zone.
    const usEvents = byUid(
      expandOk('synthetic/dst-us.ics', { targetTimezone: NY }),
      'us-spring-forward@synthetic',
    );
    const euEvents = byUid(
      expandOk('synthetic/dst-europe.ics', { targetTimezone: BERLIN }),
      'eu-spring-forward@synthetic',
    );
    // 2026-03-18 09:00 New York is EDT: UTC-4.
    expect(usEvents[2]?.startUtc.toISOString()).toBe('2026-03-18T13:00:00.000Z');
    // 2026-03-25 09:00 Berlin is still CET: UTC+1.
    expect(euEvents[0]?.startUtc.toISOString()).toBe('2026-03-25T08:00:00.000Z');
  });

  it('[R9] Berlin transitions back on 2026-10-25, a week before the United States', () => {
    const events = byUid(
      expandOk('synthetic/dst-europe.ics', { targetTimezone: BERLIN }),
      'eu-fall-back@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-10-21T07:00:00.000Z',
      '2026-10-28T08:00:00.000Z',
      '2026-11-04T08:00:00.000Z',
    ]);
  });

  it('[R9] London follows the European dates but a different offset', () => {
    const events = byUid(
      expandOk('synthetic/dst-europe.ics', { targetTimezone: 'Europe/London' }),
      'uk-spring-forward@synthetic',
    );
    expect(startsOf(events)).toEqual([
      '2026-03-25T09:00:00.000Z',
      '2026-04-01T08:00:00.000Z',
      '2026-04-08T08:00:00.000Z',
    ]);
  });
});

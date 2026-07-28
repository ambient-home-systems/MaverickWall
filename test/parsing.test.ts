import { describe, expect, it } from 'vitest';
import { expandCalendar } from '../src/index.js';
import { byUid, expandOk, expandRaw, loadFixture } from './support/helpers.js';

const WINDOW = {
  windowStart: new Date('2026-01-01T00:00:00Z'),
  windowEnd: new Date('2027-01-01T00:00:00Z'),
};

describe('R13 — STATUS:CANCELLED is filtered out', () => {
  it('[R13] a cancelled master removes the entire series', () => {
    const events = expandOk('synthetic/cancelled.ics');
    expect(byUid(events, 'cancelled-master@synthetic')).toHaveLength(0);
  });

  it('[R13] confirmed, tentative and status-absent events all survive', () => {
    const events = expandOk('synthetic/cancelled.ics');
    expect(events.map((event) => event.uid)).toEqual([
      'confirmed@synthetic',
      'tentative@synthetic',
      'no-status@synthetic',
    ]);
  });

  it('[R13] a missing STATUS is reported as CONFIRMED', () => {
    const events = expandOk('synthetic/cancelled.ics');
    expect(byUid(events, 'no-status@synthetic')[0]?.status).toBe('CONFIRMED');
    expect(byUid(events, 'tentative@synthetic')[0]?.status).toBe('TENTATIVE');
  });

  it('[R13] no returned event ever carries CANCELLED status', () => {
    const events = expandOk('synthetic/cancelled.ics');
    expect(events.some((event) => event.status === 'CANCELLED')).toBe(false);
  });
});

describe('R14 — RFC 5545 line unfolding', () => {
  it('[R14] a summary folded with a space unfolds to one continuous string', () => {
    const event = byUid(expandOk('synthetic/line-folding.ics'), 'folded-summary@synthetic')[0];
    expect(event?.title).toBe(
      'This summary is deliberately longer than seventy-five octets so that it must be folded across a continuation line per RFC 5545 section 3.1',
    );
  });

  it('[R14] a continuation line beginning with a tab unfolds identically', () => {
    const event = byUid(expandOk('synthetic/line-folding.ics'), 'folded-tab@synthetic')[0];
    expect(event?.title).toBe(
      'Continuation lines may begin with a horizontal tab rather than a space and must unfold identically',
    );
  });

  it('[R14] a value folded across three lines rejoins without stray spaces', () => {
    const event = byUid(expandOk('synthetic/line-folding.ics'), 'folded-thrice@synthetic')[0];
    expect(event?.title).toBe(
      'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three',
    );
  });

  it('[R14] unfolding and unescaping compose correctly in one value', () => {
    const event = byUid(expandOk('synthetic/line-folding.ics'), 'folded-summary@synthetic')[0];
    expect(event?.location).toBe(
      '1600 Pennsylvania Avenue Northwest, Washington, DC 20500, United States of America',
    );
  });
});

describe('R15 — escaped characters in TEXT values', () => {
  it('[R15] escaped commas become literal commas', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-comma@synthetic')[0];
    expect(event?.title).toBe('Pick up milk, eggs, and bread');
  });

  it('[R15] escaped semicolons become literal semicolons', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-comma@synthetic')[0];
    expect(event?.location).toBe('Aisle 3; back of the store');
  });

  it('[R15] escaped newlines become real newlines', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-newline@synthetic')[0];
    expect(event?.location).toBe('Room A\nBuilding 2');
  });

  it('[R15] escaped backslashes survive as single backslashes', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-backslash@synthetic')[0];
    expect(event?.title).toBe('Path is C:\\Users\\family\\calendar');
  });

  it('[R15] all four escape forms decode correctly in one value', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-mixed@synthetic')[0];
    expect(event?.title).toBe('Semicolons; commas, newlines\n and backslashes \\ together');
  });
});

describe('description handling', () => {
  it('strips DESCRIPTION by default', () => {
    const event = byUid(expandOk('synthetic/escaped-text.ics'), 'escaped-newline@synthetic')[0];
    expect(event?.description).toBeUndefined();
  });

  it('includes DESCRIPTION only when asked, with escapes decoded', () => {
    const event = byUid(
      expandOk('synthetic/escaped-text.ics', { includeDescription: true }),
      'escaped-newline@synthetic',
    )[0];
    expect(event?.description).toBe('First line\nSecond line\nThird line');
  });
});

describe('R18 — an empty calendar is not an error', () => {
  it('[R18] a valid VCALENDAR with no VEVENTs yields an empty array', () => {
    const result = expandRaw('synthetic/empty-calendar.ics');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(result.meta.truncated).toBe(false);
  });

  it('[R18] calendar metadata still comes through on an empty feed', () => {
    const result = expandRaw('synthetic/empty-calendar.ics');
    expect(result.ok && result.meta.calendarName).toBe('Nothing scheduled');
  });

  it('[R18] a window containing no events yields an empty array, not an error', () => {
    const result = expandRaw('synthetic/allday.ics', {
      windowStart: new Date('2030-01-01T00:00:00Z'),
      windowEnd: new Date('2030-02-01T00:00:00Z'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});

describe('R19 — malformed input returns a typed error and never throws', () => {
  const malformed = [
    'synthetic/malformed-garbage.ics',
    'synthetic/malformed-html.ics',
    'synthetic/malformed-truncated.ics',
  ];

  it.each(malformed)('[R19] %s never throws', (fixture) => {
    expect(() =>
      expandCalendar({ icsText: loadFixture(fixture), targetTimezone: 'America/Chicago', ...WINDOW }),
    ).not.toThrow();
  });

  it('[R19] plain text with an .ics extension is reported as PARSE_FAILED', () => {
    const result = expandRaw('synthetic/malformed-garbage.ics');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PARSE_FAILED');
    expect(result.error.message).toBeTruthy();
  });

  it('[R19] an HTML error page returned by a dead feed is reported as PARSE_FAILED', () => {
    const result = expandRaw('synthetic/malformed-html.ics');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PARSE_FAILED');
  });

  it('[R19] a truncated download either fails cleanly or yields no bogus events', () => {
    const result = expandRaw('synthetic/malformed-truncated.ics');
    if (result.ok) {
      // Tolerant parsers may salvage the shell. What must never happen is an
      // event with a nonsense start time reaching the wall.
      expect(result.value.every((event) => Number.isFinite(event.startUtc.getTime()))).toBe(true);
    } else {
      expect(result.error.code).toBe('PARSE_FAILED');
    }
  });

  it('[R19] arbitrary hostile strings never throw', () => {
    const inputs = ['', '   ', '\u0000\u0001\u0002', 'BEGIN:VCALENDAR', 'BEGIN:VEVENT\r\nEND:VEVENT'];
    for (const icsText of inputs) {
      expect(() =>
        expandCalendar({ icsText, targetTimezone: 'America/Chicago', ...WINDOW }),
      ).not.toThrow();
    }
  });

  it('[R19] a partially damaged feed still renders the events that are intact', () => {
    const result = expandRaw('synthetic/partial-damage.ics');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const uids = result.value.map((event) => event.uid);
    expect(uids).toContain('survivor@synthetic');
    expect(uids).toContain('orphan-override@synthetic');
    expect(result.meta.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['MISSING_UID', 'MISSING_DTSTART', 'ORPHAN_OVERRIDE']),
    );
  });

  it('[R19] one unparseable event costs only itself, not the whole feed', () => {
    // ical.js validates property values at parse time, so a single malformed
    // RRULE rejects the entire document. This is the blast-radius test: a feed
    // is not allowed to vanish because one event out of many is broken.
    const good = (n: number) =>
      [
        'BEGIN:VEVENT',
        `UID:good-${n}@blast`,
        `SUMMARY:Good event ${n}`,
        `DTSTART;TZID=America/Chicago:2026060${n}T080000`,
        `DTEND;TZID=America/Chicago:2026060${n}T090000`,
        'END:VEVENT',
      ].join('\r\n');

    const poison = [
      'BEGIN:VEVENT',
      'UID:poison@blast',
      'SUMMARY:Malformed recurrence rule',
      'DTSTART;TZID=America/Chicago:20260605T080000',
      'DTEND;TZID=America/Chicago:20260605T090000',
      'RRULE:FREQ=FORTNIGHTLY;COUNT=banana',
      'END:VEVENT',
    ].join('\r\n');

    const icsText = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Maverick Wall//Blast Radius//EN',
      'X-WR-CALNAME:Mostly fine',
      good(1),
      good(2),
      poison,
      good(3),
      good(4),
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    const result = expandCalendar({ icsText, targetTimezone: 'America/Chicago', ...WINDOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((event) => event.uid)).toEqual([
      'good-1@blast',
      'good-2@blast',
      'good-3@blast',
      'good-4@blast',
    ]);
    expect(result.meta.warnings.some((warning) => warning.code === 'EVENT_SKIPPED')).toBe(true);
    // Calendar metadata survives the salvage path too.
    expect(result.meta.calendarName).toBe('Mostly fine');
  });

  it('[R19] warnings never leak event content', () => {
    const result = expandRaw('synthetic/partial-damage.ics');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.meta.warnings);
    expect(serialised).not.toContain('This one is fine');
    expect(serialised).not.toContain('Nonsense RRULE');
  });
});

describe('input validation', () => {
  it('rejects an unknown target timezone with a typed error', () => {
    const result = expandCalendar({
      icsText: loadFixture('synthetic/allday.ics'),
      targetTimezone: 'Middle/Earth',
      ...WINDOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_TIMEZONE');
  });

  it('rejects an inverted window', () => {
    const result = expandCalendar({
      icsText: loadFixture('synthetic/allday.ics'),
      targetTimezone: 'America/Chicago',
      windowStart: new Date('2027-01-01T00:00:00Z'),
      windowEnd: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_WINDOW');
  });

  it('rejects an invalid date object', () => {
    const result = expandCalendar({
      icsText: loadFixture('synthetic/allday.ics'),
      targetTimezone: 'America/Chicago',
      windowStart: new Date('nonsense'),
      windowEnd: new Date('2027-01-01T00:00:00Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_WINDOW');
  });

  it('rejects a non-positive maxEvents', () => {
    const result = expandCalendar({
      icsText: loadFixture('synthetic/allday.ics'),
      targetTimezone: 'America/Chicago',
      maxEvents: 0,
      ...WINDOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_OPTION');
  });

  it('rejects an oversized feed before parsing it', () => {
    const result = expandCalendar({
      icsText: loadFixture('synthetic/allday.ics'),
      targetTimezone: 'America/Chicago',
      maxBytes: 32,
      ...WINDOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOO_LARGE');
  });
});

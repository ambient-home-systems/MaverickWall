import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandCalendar, type NormalizedEvent } from '@maverick-wall/calendar';
import { CTAG_BODY, calendarQueryBody, splitCalendarData } from '../src/caldav/query.js';

/**
 * One resource per event, and the recurrence parity that refusing server
 * expansion is *for* (RFC 013 §6.4, §6.5, §11).
 *
 * The parity assertion is the one that matters and it is written to go red for
 * exactly one change: somebody adding `<C:expand>` to the REPORT template as an
 * optimisation. `packages/calendar` is this repository's most heavily tested
 * package and every rule in it is a decision a provider's expander makes
 * differently — recurrence on wall-clock then anchored, `DTEND` exclusive,
 * zones from `Intl` rather than from a feed's stale VTIMEZONE. If the server
 * expands, a household's birthday lands on a different day depending on which
 * provider they use.
 */

const ZONE = 'America/New_York';
const WINDOW_START = new Date('2026-02-01T00:00:00Z');
const WINDOW_END = new Date('2026-05-01T00:00:00Z');

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/caldav/synthetic/${name}`, import.meta.url)),
    'utf8',
  );
}

/** The rows a wall would draw, in the order the manifest sorts them. */
function rowsOf(events: readonly NormalizedEvent[]): readonly string[] {
  return [...events]
    .map(
      (event) =>
        `${event.startUtc.toISOString()}|${event.endUtc.toISOString()}|${event.allDay}|` +
        `${event.uid}|${event.recurrenceId ?? ''}|${event.sourceTzid}|${event.title}`,
    )
    .sort();
}

function expand(icsText: string): readonly NormalizedEvent[] {
  const result = expandCalendar({
    icsText,
    targetTimezone: ZONE,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  if (!result.ok) throw new Error(`expected an expansion, got ${result.error.code}`);
  return result.value;
}

describe('the REPORT template', () => {
  it('carries a time-range filter and no expand element', () => {
    const body = calendarQueryBody(WINDOW_START, WINDOW_END);

    // The filter is used: it cuts which *resources* come back without touching
    // how they are interpreted.
    expect(body).toContain('<C:time-range start="20260201T000000Z" end="20260501T000000Z"/>');
    expect(body).toContain('<C:comp-filter name="VEVENT">');
    expect(body).toContain('<C:calendar-data/>');

    /*
     * The absence, asserted rather than commented. This is the line that goes
     * red when somebody turns server expansion on, and it is the cheapest guard
     * in the phase — `expand` is a substring of nothing else in this document.
     */
    expect(body).not.toContain('expand');
    expect(CTAG_BODY).not.toContain('expand');
  });

  it('writes its timestamps in the basic UTC form, whatever zone the runner is in', () => {
    // This suite runs under TZ=Pacific/Chatham, whose offset is +12:45 — the
    // half-hour-plus-quarter case that catches an implementation reading local
    // fields. A server is entitled to refuse the extended form, and a refused
    // REPORT is an empty calendar rather than an error anybody sees.
    const body = calendarQueryBody(
      new Date('2026-03-08T07:00:00Z'),
      new Date('2026-03-09T07:00:00Z'),
    );
    expect(body).toContain('start="20260308T070000Z" end="20260309T070000Z"');
    expect(body).not.toContain('-03-');
    expect(body).not.toContain('.000');
  });
});

describe('splitting a multistatus into resources', () => {
  const result = splitCalendarData(fixture('report-calendar-query.xml'));

  it('answers one whole VCALENDAR per resource, with its ETag', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resources.map((resource) => resource.href)).toEqual([
      '/dav/calendars/REDACTED/personal/weekly-dst-0001.ics',
      '/dav/calendars/REDACTED/personal/oneoff-0002.ics',
      '/dav/calendars/REDACTED/personal/allday-0003.ics',
    ]);
    expect(result.resources.map((resource) => resource.etag)).toEqual([
      '"ctag-a1"',
      '"ctag-b2"',
      '"ctag-c3"',
    ]);
    for (const resource of result.resources) {
      // Byte for byte, CRLF intact: ICS folding lands on exact octet
      // boundaries and unfolding is `packages/calendar`'s job.
      expect(resource.calendarData.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
      expect(resource.calendarData.endsWith('END:VCALENDAR\r\n')).toBe(true);
    }
  });

  it('passes a document that is not a multistatus straight back as an error', () => {
    const refused = splitCalendarData('<html><body>Sign in</body></html>');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('not-multistatus');
  });

  it('refuses a DOCTYPE here too, since it is the same reader', () => {
    const refused = splitCalendarData(fixture('hostile-xxe-external-entity.xml'));
    expect(!refused.ok && refused.error.code).toBe('doctype-refused');
  });
});

describe('one malformed resource costs one event', () => {
  it('parses the good resources either side of a broken one', () => {
    /*
     * §6.5, and the first row of CLAUDE.md's bug table — "one malformed event
     * killed a whole feed", found by a hostile synthetic fixture. Per-resource
     * parsing makes that structurally impossible for a CalDAV source, and this
     * is the assertion that says so rather than the prose.
     */
    const split = splitCalendarData(fixture('report-one-bad-resource.xml'));
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.resources).toHaveLength(3);

    const outcomes = split.resources.map((resource) =>
      expandCalendar({
        icsText: resource.calendarData,
        targetTimezone: ZONE,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    );

    // The middle one fails or yields nothing; either is a resource that said
    // nothing, which is the outcome being asserted rather than the mechanism.
    const survived = outcomes.flatMap((outcome) => (outcome.ok ? outcome.value : []));
    expect(survived.some((event) => event.title === 'Standup')).toBe(true);
    expect(survived.some((event) => event.title === 'Dentist')).toBe(true);
    // And the whole-feed alternative is the counterfactual: the same three
    // bodies concatenated is what an ICS feed would have been.
    expect(outcomes[1]?.ok === true ? outcomes[1].value.length : 0).toBe(0);
  });
});

describe('recurrence parity across kinds', () => {
  /*
   * §11: "the same weekly event, with a DST crossing in the window, through ICS
   * and through CalDAV, asserted to produce identical rows."
   *
   * The series is weekly at 09:00 America/New_York from 2026-02-24, which
   * crosses US spring-forward on 2026-03-08 — so every instance after it is a
   * different UTC instant from every instance before it, and an expander that
   * anchored once rather than per instance would disagree on exactly those.
   */
  it('gives identical rows per resource and whole feed', () => {
    const split = splitCalendarData(fixture('report-calendar-query.xml'));
    expect(split.ok).toBe(true);
    if (!split.ok) return;

    const perResource = split.resources.flatMap((resource) => [...expand(resource.calendarData)]);
    const wholeFeed = expand(fixture('same-events-whole-feed.ics'));

    expect(rowsOf(perResource)).toEqual(rowsOf(wholeFeed));
    // Not vacuously: eight weekly instances, a one-off and an all-day span.
    expect(perResource).toHaveLength(10);
  });

  it('crosses the DST boundary, which is why the fixture is this one', () => {
    const wholeFeed = expand(fixture('same-events-whole-feed.ics'));
    const standups = wholeFeed
      .filter((event) => event.title === 'Standup')
      .sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());

    // 09:00 in New York is 14:00 UTC on standard time and 13:00 UTC on
    // daylight time. A series that read one offset for all eight instances
    // would draw four of them an hour wrong on a kitchen wall.
    expect(standups[0]?.startUtc.toISOString()).toBe('2026-02-24T14:00:00.000Z');
    expect(standups[1]?.startUtc.toISOString()).toBe('2026-03-03T14:00:00.000Z');
    expect(standups[2]?.startUtc.toISOString()).toBe('2026-03-10T13:00:00.000Z');
    expect(standups[7]?.startUtc.toISOString()).toBe('2026-04-14T13:00:00.000Z');
    // The instants differ and the wall clock does not, which is the whole of
    // "recurrence is computed on wall-clock, then anchored".
    expect(new Set(standups.map((event) => event.startUtc.getTime())).size).toBe(8);
  });

  it('keeps DTEND exclusive on the all-day span, in both shapes', () => {
    // The single most common ICS bug, and the one a server-side expander is
    // most likely to disagree about. A seven-day half term ends at local
    // midnight *after* the 22nd.
    const split = splitCalendarData(fixture('report-calendar-query.xml'));
    if (!split.ok) return;
    const fromResource = expand(split.resources[2]!.calendarData)[0];
    const fromFeed = expand(fixture('same-events-whole-feed.ics')).find(
      (event) => event.title === 'Half term',
    );

    expect(fromResource?.allDay).toBe(true);
    expect(fromResource?.startUtc.toISOString()).toBe(fromFeed?.startUtc.toISOString());
    expect(fromResource?.endUtc.toISOString()).toBe(fromFeed?.endUtc.toISOString());
    expect(fromResource?.endUtc.toISOString()).toBe('2026-03-23T04:00:00.000Z');
  });
});

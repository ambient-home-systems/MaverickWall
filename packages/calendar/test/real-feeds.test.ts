import { describe, expect, it } from 'vitest';
import { byUid, daysCovered, expandRaw } from './support/helpers.js';

/**
 * Tests against real producer output rather than fixtures we designed.
 *
 * The synthetic corpus only finds bugs we already thought to look for. Every
 * assertion here corresponds to something an actual calendar system emitted
 * that we did not anticipate.
 */

const NY = 'America/New_York';
const FCPS = 'real/fcps-school-district.ics';
const SCHOOL_YEAR = {
  targetTimezone: NY,
  windowStart: new Date('2026-01-01T00:00:00Z'),
  windowEnd: new Date('2028-01-01T00:00:00Z'),
};

describe('FCPS school district feed', () => {
  it('parses without error', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(10);
  });

  it('strips invisible characters that web editors paste into titles', () => {
    // Two SUMMARY values in this feed begin with U+200B. String.trim() does not
    // remove it, so without normalisation the title sorts under the wrong
    // letter and never compares equal to the identical-looking string.
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(byUid(result.value, '75100039')[0]?.title).toBe('Schools closed');
    expect(byUid(result.value, '75100012')[0]?.title).toBe('Autumn begins');
    for (const event of result.value) {
      expect(/^[\s\u200B-\u200D\u2060\uFEFF]/.test(event.title)).toBe(false);
      expect(/[\s\u200B-\u200D\u2060\uFEFF]$/.test(event.title)).toBe(false);
    }
  });

  it('trims a trailing space the producer left in a title', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(byUid(result.value, '75102542')[0]?.title).toBe('Eid al-Fitr');
  });

  it('places single-day all-day events on exactly one local date', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A school closure landing on the wrong day is the failure that makes
    // someone stop trusting the wall.
    expect(daysCovered(byUid(result.value, '75100039')[0]!, NY)).toEqual(['2026-09-21']);
    expect(daysCovered(byUid(result.value, '75102448')[0]!, NY)).toEqual(['2027-01-18']);
    expect(daysCovered(byUid(result.value, '75102218')[0]!, NY)).toEqual(['2026-10-16']);
  });

  it('handles all-day events on month and year boundaries', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // DTEND crosses into the next year; the event belongs to the old one.
    expect(daysCovered(byUid(result.value, '75102393')[0]!, NY)).toEqual(['2026-12-31']);
    // DTEND crosses into the next month.
    expect(daysCovered(byUid(result.value, '75102702')[0]!, NY)).toEqual(['2027-05-31']);
  });

  it('anchors all-day events to the correct side of a DST boundary', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2027 US DST begins March 14. These two all-day events sit either side of
    // it and so have different UTC anchors despite both being local midnight.
    expect(byUid(result.value, '75102542')[0]?.startUtc.toISOString()).toBe(
      '2027-03-10T05:00:00.000Z',
    );
    expect(byUid(result.value, '75102678')[0]?.startUtc.toISOString()).toBe(
      '2027-05-13T04:00:00.000Z',
    );
  });

  it('handles a timed event given in bare UTC with no TZID', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const event = byUid(result.value, '75100036')[0];
    expect(event?.allDay).toBe(false);
    expect(event?.sourceTzid).toBe('UTC');
    expect(event?.startUtc.toISOString()).toBe('2026-09-11T13:49:00.000Z');
    expect(event?.endUtc.toISOString()).toBe('2026-09-11T14:49:00.000Z');
  });

  it('unescapes commas in titles', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(byUid(result.value, '75102448')[0]?.title).toBe('Martin Luther King, Jr. Day');
  });

  it('keeps ampersands in titles and locations intact', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(byUid(result.value, '75102252')[0]?.title).toBe('ES & MS Teacher Conferences');
    expect(byUid(result.value, '75102678')[0]?.location).toBe('Baker Park & FHS');
  });

  it('reassembles a description folded across many lines', () => {
    const result = expandRaw(FCPS, { ...SCHOOL_YEAR, includeDescription: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const description = byUid(result.value, '75102722')[0]?.description ?? '';
    expect(description).toContain('Maryland law requires 180 instructional days');
    expect(description).toContain('six inclement weather make-up days');
  });

  it('leaves HTML in descriptions alone rather than guessing at it', () => {
    // This producer stores rich text in DESCRIPTION. Decoding entities or
    // stripping tags here would corrupt a description that legitimately
    // contains those characters. It is the consumer's decision, not ours,
    // and descriptions are stripped by default anyway.
    const result = expandRaw(FCPS, { ...SCHOOL_YEAR, includeDescription: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(byUid(result.value, '75102218')[0]?.description).toBe(
      'Professional Learning Day<br>',
    );
  });

  it('accepts a non-IANA TZID emitted by DDay.iCal', () => {
    // This feed declares TZID:US Eastern, which is neither an IANA name nor a
    // Windows one. No VEVENT here references it, but plenty of feeds from the
    // same producer do.
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.warnings.some((w) => w.code === 'UNRESOLVED_TIMEZONE')).toBe(false);
  });

  it('reads the calendar name even when it is unhelpful', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok && result.meta.calendarName).toBe('Calendar');
  });

  it('returns events sorted by start', () => {
    const result = expandRaw(FCPS, SCHOOL_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const starts = result.value.map((event) => event.startUtc.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

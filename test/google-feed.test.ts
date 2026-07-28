import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandRaw, FIXTURE_DIR } from './support/helpers.js';

/**
 * A real Google Calendar export, scrubbed.
 *
 * The FCPS fixture contains no recurrence at all, so until this one arrived the
 * recurrence engine had never met real producer output. These assertions are
 * deliberately content-independent: they hold no matter whose calendar it is,
 * which means the fixture can be replaced or refreshed without rewriting tests.
 *
 * Skipped automatically when the fixture is absent, so a fresh clone without it
 * still runs green.
 */

const FIXTURE = 'real/google-personal.ics';
const present = existsSync(join(FIXTURE_DIR, FIXTURE));

/**
 * The feed's full span, not a single year.
 *
 * A one-year window exercised about 9% of this export: most events sit in
 * earlier years, and the majority of its recurring rules carry an UNTIL that
 * expired before 2023, so they expanded to nothing at all. Covering 2015-2028
 * puts every rule through its actual active lifetime and gives the
 * local-time-drift check below roughly 28 DST transitions to work against
 * rather than two.
 */
const FULL_SPAN = {
  targetTimezone: 'America/New_York',
  windowStart: new Date('2015-01-01T00:00:00Z'),
  windowEnd: new Date('2029-01-01T00:00:00Z'),
  maxEvents: 200_000,
} as const;

const YEAR = FULL_SPAN;

describe.skipIf(!present)('Google Calendar feed', () => {
  it('parses a multi-megabyte real export without error', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
  });

  it('expands completely, without hitting any cap', () => {
    // Every assertion below is weaker if the result was truncated, so check it
    // explicitly rather than trusting the cap to be generous enough.
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.truncated).toBe(false);
    expect(result.value.length).toBe(result.meta.totalBeforeCap);
  });

  it('produces no warnings', () => {
    // Google is a well-behaved producer. Any warning here is either a real
    // defect in the feed or, more likely, a gap in our parsing.
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.warnings.map((w) => `${w.code}: ${w.message}`)).toEqual([]);
  });

  it('expands recurring series into multiple instances', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const recurring = result.value.filter((event) => event.isRecurringInstance);
    expect(recurring.length).toBeGreaterThan(0);

    // More instances than series means expansion actually happened rather than
    // each master passing through once.
    const seriesUids = new Set(recurring.map((event) => event.uid));
    expect(recurring.length).toBeGreaterThan(seriesUids.size);
  });

  it('gives every instance in a series a distinct recurrence id', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byUid = new Map<string, string[]>();
    for (const event of result.value) {
      if (!event.isRecurringInstance || !event.recurrenceId) continue;
      const list = byUid.get(event.uid) ?? [];
      list.push(event.recurrenceId);
      byUid.set(event.uid, list);
    }

    for (const [uid, ids] of byUid) {
      // A duplicate here would mean one calendar slot rendered twice, which on
      // a wall display looks like a scheduling error rather than a bug.
      expect(new Set(ids).size, `duplicate recurrence ids for ${uid}`).toBe(ids.length);
    }
  });

  it('never emits two events with the same identity', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.map((event) => `${event.uid}|${event.recurrenceId ?? ''}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every instance inside the requested window', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const start = YEAR.windowStart.getTime();
    const end = YEAR.windowEnd.getTime();
    for (const event of result.value) {
      const s = event.startUtc.getTime();
      const e = event.endUtc.getTime();
      expect(s, `${event.uid} starts after window end`).toBeLessThan(end);
      expect(Math.max(e, s + 1), `${event.uid} ends before window start`).toBeGreaterThan(start);
    }
  });

  it('returns events sorted by start', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const starts = result.value.map((event) => event.startUtc.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('never produces an end before its start', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const event of result.value) {
      expect(
        event.endUtc.getTime(),
        `${event.uid} ${event.recurrenceId ?? ''} ends before it starts`,
      ).toBeGreaterThanOrEqual(event.startUtc.getTime());
    }
  });

  it('anchors every all-day event to local midnight', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    for (const event of result.value) {
      if (!event.allDay) continue;
      const local = formatter.format(event.startUtc).replace('24:', '00:');
      expect(local, `${event.uid} all-day does not start at local midnight`).toBe('00:00');
    }
  });

  it('holds recurring instances at a constant local time across DST', () => {
    const result = expandRaw(FIXTURE, YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    // Group timed instances by series and count how often each local start
    // time occurs. A weekly series must read the same on the kitchen clock in
    // January and in July.
    const times = new Map<string, Map<string, number>>();
    for (const event of result.value) {
      if (event.allDay || !event.isRecurringInstance) continue;
      const counts = times.get(event.uid) ?? new Map<string, number>();
      const local = formatter.format(event.startUtc);
      counts.set(local, (counts.get(local) ?? 0) + 1);
      times.set(event.uid, counts);
    }

    // Counting distinct times would be wrong: RECURRENCE-ID overrides move
    // individual instances on purpose, and this feed has 82 of them. Instead
    // require one time to dominate. Correct wall-clock expansion puts nearly
    // every instance at the same local time; expansion against a fixed UTC
    // offset would split a year-round series roughly in half by DST season,
    // which lands far below this threshold.
    let checked = 0;
    for (const [uid, counts] of times) {
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      if (total < 10) continue;
      checked++;
      const dominant = Math.max(...counts.values());
      expect(
        dominant / total,
        `series ${uid}: most common local time covers only ${dominant}/${total} instances`,
      ).toBeGreaterThan(0.75);
    }

    // Guard against the assertion above passing because nothing qualified.
    expect(checked, 'no series had enough instances to check for drift').toBeGreaterThan(0);
  });

  it('expands the full span within the performance budget', () => {
    // A separate budget from R20: this parses 3.2 MB of real ICS and expands
    // fourteen years of it, which is a heavier job than the synthetic feed.
    // Tighten this to roughly twice the observed figure once it has run.
    const budget = Number(process.env['CALENDAR_GOOGLE_BUDGET_MS'] ?? 400);
    const started = process.hrtime.bigint();
    const result = expandRaw(FIXTURE, YEAR);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // eslint-disable-next-line no-console
    console.log(
      `[google] ${result.value.length.toLocaleString()} instances over ` +
        `2015-2028 in ${ms.toFixed(0)}ms (budget ${budget}ms)`,
    );
    expect(ms).toBeLessThan(budget);
  });
});

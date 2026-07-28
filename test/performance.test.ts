import { describe, expect, it } from 'vitest';
import { expandCalendar } from '../src/index.js';
import { generateLargeFeed } from './support/generate-large.js';

/**
 * Stated budget for requirement 20.
 *
 * The wall display refreshes a feed every few minutes, not every frame, and the
 * target hardware is a Raspberry Pi or a low-power NAS — call it five to eight
 * times slower than a developer laptop. A 2.5 second ceiling here leaves that
 * hardware comfortably inside a refresh interval even in the worst case.
 *
 * Override with CALENDAR_BENCH_BUDGET_MS when running on constrained CI.
 */
const BUDGET_MS = Number(process.env['CALENDAR_BENCH_BUDGET_MS'] ?? 1200);

const WINDOW_START = new Date('2026-01-01T00:00:00Z');
const WINDOW_END = new Date('2027-01-01T00:00:00Z');

function measure<T>(work: () => T): { result: T; ms: number } {
  const started = process.hrtime.bigint();
  const result = work();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

describe('R20 — a 5000-event feed completes within budget', () => {
  it('[R20] expands 5000 events inside the stated budget', () => {
    const icsText = generateLargeFeed({ eventCount: 5000 });

    const { result, ms } = measure(() =>
      expandCalendar({
        icsText,
        targetTimezone: 'America/Chicago',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        maxEvents: 100_000,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Recorded so the budget can be tightened against real numbers rather than
    // guesses. Roughly a quarter of the source events recur, so the expanded
    // count is several times the input count.
    // eslint-disable-next-line no-console
    console.log(
      `[R20] ${icsText.length.toLocaleString()} bytes, ` +
        `${result.value.length.toLocaleString()} instances in ${ms.toFixed(0)}ms ` +
        `(budget ${BUDGET_MS}ms)`,
    );

    expect(result.value.length).toBeGreaterThan(5000);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[R20] the result is fully sorted even at scale', () => {
    const icsText = generateLargeFeed({ eventCount: 5000 });
    const result = expandCalendar({
      icsText,
      targetTimezone: 'America/Chicago',
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      maxEvents: 100_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let previous = Number.NEGATIVE_INFINITY;
    for (const event of result.value) {
      const current = event.startUtc.getTime();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('[R20] the default cap keeps a huge feed cheap for a caller who forgets to set one', () => {
    const icsText = generateLargeFeed({ eventCount: 5000 });
    const { result, ms } = measure(() =>
      expandCalendar({
        icsText,
        targetTimezone: 'America/Chicago',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2000);
    expect(result.meta.truncated).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[R20] a pathological recurrence rule cannot hang the expansion', () => {
    const hostile = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Maverick Wall//Hostile//EN',
      'BEGIN:VEVENT',
      'UID:dense@hostile',
      'SUMMARY:Every second, forever',
      'DTSTART;TZID=UTC:20260101T000000',
      'DTEND;TZID=UTC:20260101T000001',
      'RRULE:FREQ=SECONDLY',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');

    const { result, ms } = measure(() =>
      expandCalendar({
        icsText: hostile,
        targetTimezone: 'America/Chicago',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.truncated).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

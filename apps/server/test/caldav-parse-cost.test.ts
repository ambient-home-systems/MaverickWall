import { describe, expect, it } from 'vitest';
import { expandCalendar } from '@maverick-wall/calendar';

/**
 * What N small parse calls cost against one feed (RFC 013 §6.5).
 *
 * §6.5 says the cost of per-resource parsing "should be measured rather than
 * assumed", and this is the measurement. It is deliberately **not a budget**.
 * `packages/calendar/test/performance.test.ts` explains at length why a
 * wall-clock ceiling measures the runner rather than the code, and this
 * repository has now written one three times and taken it out twice — the
 * second time when `google-feed.test.ts` failed CI at 408ms against a 400ms
 * ceiling with the browser suite running beside it, and passed three times out
 * of three on the same tree on an idle machine.
 *
 * So the number is printed every run and asserted on only in the one form that
 * is honest on hardware nobody knows: a **ratio** against the identical events
 * as a single feed. A ratio is immune to machine speed — a slow runner makes
 * both halves slower — and it is the form that still fails on the thing that
 * would actually be worth knowing, which is per-resource parsing turning out to
 * be an order of magnitude worse rather than a constant factor.
 *
 * The ceiling is set where a *regression* has to be a change of kind rather
 * than a bad afternoon on a shared runner. The measured figure goes in the PR
 * body.
 */

const ZONE = 'America/New_York';
const WINDOW_START = new Date('2026-01-01T00:00:00Z');
const WINDOW_END = new Date('2027-01-01T00:00:00Z');
const RESOURCES = 500;

/**
 * One resource is a complete `VCALENDAR` holding a master `VEVENT` and its
 * overrides — which is what CalDAV stores and is the whole reason a bad one
 * costs one event rather than a feed.
 *
 * A third of them recur, which is roughly what a household's calendar looks
 * like and is what stops this timing the parser alone.
 */
function resourceAt(index: number): string {
  const day = String((index % 28) + 1).padStart(2, '0');
  const month = String((index % 12) + 1).padStart(2, '0');
  const recurs = index % 3 === 0;
  return (
    'BEGIN:VCALENDAR\r\n' +
    'VERSION:2.0\r\n' +
    'PRODID:-//Example Corp//CalDAV Server//EN\r\n' +
    'BEGIN:VEVENT\r\n' +
    `UID:resource-${index}@example.org\r\n` +
    'DTSTAMP:20260101T120000Z\r\n' +
    `DTSTART;TZID=America/New_York:2026${month}${day}T090000\r\n` +
    `DTEND;TZID=America/New_York:2026${month}${day}T093000\r\n` +
    (recurs ? 'RRULE:FREQ=WEEKLY;COUNT=12\r\n' : '') +
    `SUMMARY:Event ${index}\r\n` +
    'LOCATION:Somewhere\r\n' +
    'END:VEVENT\r\n' +
    'END:VCALENDAR\r\n'
  );
}

function wholeFeed(resources: readonly string[]): string {
  const bodies = resources
    .map((resource) =>
      resource
        .replace(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:[^\r]*\r\n/, '')
        .replace(/END:VCALENDAR\r\n$/, ''),
    )
    .join('');
  return (
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example Corp//CalDAV Server//EN\r\n' +
    bodies +
    'END:VCALENDAR\r\n'
  );
}

function measure<T>(work: () => T): { result: T; ms: number } {
  const started = process.hrtime.bigint();
  const result = work();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/**
 * Best-of-three, **interleaved** — the discipline `performance.test.ts` sets.
 *
 * Best-of rather than mean because timing noise is one-sided: another process
 * on the box can only ever make a run slower, so the fastest observation is the
 * one closest to the code. Interleaved because the thing being measured is a
 * ratio, and running one side to completion before the other hands whichever
 * went first a cold JIT and whichever went second a warm one.
 */
function bestOfThreeInterleaved(
  left: () => number,
  right: () => number,
): { readonly left: number; readonly right: number; readonly events: [number, number] } {
  let bestLeft = Number.POSITIVE_INFINITY;
  let bestRight = Number.POSITIVE_INFINITY;
  let events: [number, number] = [0, 0];
  for (let round = 0; round < 3; round++) {
    const a = measure(left);
    const b = measure(right);
    if (a.ms < bestLeft) bestLeft = a.ms;
    if (b.ms < bestRight) bestRight = b.ms;
    events = [a.result, b.result];
  }
  return { left: bestLeft, right: bestRight, events };
}

describe('N small parse calls against one feed', () => {
  it('costs a constant factor rather than a different order', () => {
    const resources = Array.from({ length: RESOURCES }, (_, index) => resourceAt(index));
    const feed = wholeFeed(resources);

    const timing = bestOfThreeInterleaved(
      () => {
        let total = 0;
        for (const resource of resources) {
          const result = expandCalendar({
            icsText: resource,
            targetTimezone: ZONE,
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
          });
          if (result.ok) total += result.value.length;
        }
        return total;
      },
      () => {
        const result = expandCalendar({
          icsText: feed,
          targetTimezone: ZONE,
          windowStart: WINDOW_START,
          windowEnd: WINDOW_END,
          // The whole-feed side needs a cap above what it yields, or it is
          // being timed doing less work than the other half.
          maxEvents: 20_000,
        });
        return result.ok ? result.value.length : 0;
      },
    );

    // Both halves must have produced the same events, or the ratio compares
    // nothing. This is the assertion that catches a fixture drifting apart.
    expect(timing.events[0]).toBe(timing.events[1]);
    expect(timing.events[0]).toBeGreaterThan(RESOURCES);

    const ratio = timing.left / timing.right;
    // eslint-disable-next-line no-console
    console.log(
      `[caldav parse cost] ${RESOURCES} resources (${timing.events[0]} events): ` +
        `${timing.left.toFixed(1)}ms per-resource vs ${timing.right.toFixed(1)}ms whole-feed ` +
        `— ${ratio.toFixed(2)}x, ${((timing.left / RESOURCES) * 1000).toFixed(0)}us each`,
    );

    /*
     * Measured on this machine, interleaved, across eight runs: **1.04 to
     * 1.42**, so per-resource parsing costs within half again what one feed
     * costs for the same events — §6.5's "should be measured rather than
     * assumed", answered, and the answer is that the isolation is close to
     * free.
     *
     * Four is where a regression has to be a change of *kind* rather than a bad
     * afternoon on a shared runner: nearly three times the worst observation,
     * and nowhere near what an accidentally quadratic per-resource path would
     * measure at 500 resources. Deliberately not tightened to the measurement —
     * that is how `google-feed.test.ts` came to fail CI at 408ms against a
     * 400ms ceiling while passing three times out of three on an idle machine.
     */
    expect(ratio).toBeLessThan(4);
  });
});

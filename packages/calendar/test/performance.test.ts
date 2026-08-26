import { beforeAll, describe, expect, it } from 'vitest';
import { expandCalendar } from '../src/index.js';
import { generateLargeFeed } from './support/generate-large.js';

/**
 * Requirement 20 is "a large feed stays cheap". This file used to state that as
 * a wall-clock ceiling — 1200ms for 5,000 events — and a wall-clock ceiling
 * measures the runner, not the code. It failed on any ordinary four-core
 * machine while passing on the laptop it was calibrated against, so the first
 * `pnpm test` a contributor ran was red for a reason that had nothing to do
 * with their change. CLAUDE.md already records that lesson once; this is the
 * second time.
 *
 * So the assertion is about **shape** instead: double the input and the cost
 * must not much more than double. That is immune to machine speed — a slow
 * runner makes both halves slower and the ratio unmoved — and it is the only
 * form that still fails on the regression this file exists to catch, which is
 * an accidental O(n^2) somewhere in parsing or expansion. Raising the old
 * ceiling until it passed would have turned a real assertion into one that
 * passes on anything.
 *
 * It earned that immediately. Written this way it found a live quadratic: on a
 * feed that names zones by TZID and ships no VTIMEZONE blocks, which is most of
 * them, every date property re-scanned every component in the calendar looking
 * for a zone definition that was never there. 5,000 events parsed in 1.4s and
 * 10,000 in 6.0s — 4.3x for a doubled input, sailing under the old absolute
 * budget on a fast enough machine. See `collectVevents` in `src/parse.ts`.
 *
 * What this deliberately does NOT catch is a change that is uniformly slower at
 * every size, because a constant factor cancels out of a ratio. Set
 * CALENDAR_BENCH_BUDGET_MS to add an absolute ceiling on top, on hardware you
 * know; it is off by default because there is no number that is honest on
 * hardware you do not.
 */

/**
 * Doubling the feed must cost less than this.
 *
 * Linear measures ~2.0 (the doubled input) and, on this machine, min-of-three
 * trials landed between 1.96 and 2.15 across eight runs. Quadratic measures
 * ~3.9. Three sits well clear of both.
 */
const DOUBLING_CEILING = 3;

/**
 * Absolute ceiling, asserted only when the environment asks for one. Anything
 * that is not a finite number reads as unset rather than as NaN, so a stray
 * value cannot produce a failure whose message is "expected 412 to be less
 * than NaN".
 */
const rawBudget = Number(process.env['CALENDAR_BENCH_BUDGET_MS']);
const ABSOLUTE_BUDGET_MS = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined;

const BASE_EVENTS = 5000;
const DOUBLED_EVENTS = BASE_EVENTS * 2;

const WINDOW_START = new Date('2026-01-01T00:00:00Z');
const WINDOW_END = new Date('2027-01-01T00:00:00Z');

function measure<T>(work: () => T): { result: T; ms: number } {
  const started = process.hrtime.bigint();
  const result = work();
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/**
 * Best-of-N, interleaved.
 *
 * Best-of rather than mean because timing noise is one-sided: another process
 * on the box can only ever make a run slower, so the fastest observation is the
 * closest to the real cost. Interleaved rather than all-of-one-then-all-of-the-
 * other so a burst of load part way through inflates both sizes rather than
 * whichever happened to be running, which is what would otherwise turn
 * background noise into a failed build.
 */
function doublingRatio(
  smaller: () => unknown,
  larger: () => unknown,
  reps = 3,
): { smallMs: number; largeMs: number; ratio: number } {
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let rep = 0; rep < reps; rep++) {
    smallMs = Math.min(smallMs, measure(smaller).ms);
    largeMs = Math.min(largeMs, measure(larger).ms);
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs };
}

function expand(icsText: string, maxEvents?: number) {
  return expandCalendar({
    icsText,
    targetTimezone: 'America/Chicago',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...(maxEvents === undefined ? {} : { maxEvents }),
  });
}

let baseFeed = '';
let doubledFeed = '';

describe('R20 — a large feed stays cheap as it grows', () => {
  beforeAll(() => {
    baseFeed = generateLargeFeed({ eventCount: BASE_EVENTS });
    doubledFeed = generateLargeFeed({ eventCount: DOUBLED_EVENTS });
    // Warm the JIT before anything is timed. Without this the first measurement
    // in the file carries the compile cost of every function under it, which
    // inflates the smaller half of the very first ratio and so reports a
    // flatteringly low number — the one direction of error a scaling assertion
    // cannot afford.
    for (let i = 0; i < 2; i++) expand(baseFeed, 100_000);
  }, 120_000);

  it('[R20] expands 5000 events, and doubling the feed does not more than double the cost', () => {
    const { result } = measure(() => expand(baseFeed, 100_000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Roughly a seventh of the source events recur, so the expanded count is
    // several times the input count.
    expect(result.value.length).toBeGreaterThan(BASE_EVENTS);

    const { smallMs, largeMs, ratio } = doublingRatio(
      () => expand(baseFeed, 100_000),
      () => expand(doubledFeed, 100_000),
    );

    // eslint-disable-next-line no-console
    console.log(
      `[R20] ${BASE_EVENTS} events -> ${result.value.length.toLocaleString()} instances ` +
        `in ${smallMs.toFixed(0)}ms; ${DOUBLED_EVENTS} events in ${largeMs.toFixed(0)}ms ` +
        `(${ratio.toFixed(2)}x, ceiling ${DOUBLING_CEILING}x)`,
    );

    expect(ratio).toBeLessThan(DOUBLING_CEILING);
  }, 300_000);

  it('[R20] the result is fully sorted even at scale', () => {
    const result = expand(baseFeed, 100_000);
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
    const result = expand(baseFeed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2000);
    expect(result.meta.truncated).toBe(true);

    // The cap bounds what is *collected*, but the whole document is still
    // parsed, so this path is linear rather than flat. It is measured
    // separately from the uncapped one because a quadratic could hide in
    // either and the collection ceiling short-circuits the expansion loop.
    // Two reps rather than three: this ratio measures ~1.3 against a ceiling of
    // three, so the margin does not need the extra sample that the uncapped
    // measurement above, at ~2.0, does.
    const { smallMs, largeMs, ratio } = doublingRatio(
      () => expand(baseFeed),
      () => expand(doubledFeed),
      2,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[R20] default cap: ${BASE_EVENTS} events in ${smallMs.toFixed(0)}ms, ` +
        `${DOUBLED_EVENTS} in ${largeMs.toFixed(0)}ms (${ratio.toFixed(2)}x)`,
    );

    expect(ratio).toBeLessThan(DOUBLING_CEILING);
  }, 300_000);

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

    const oneYear = () =>
      expandCalendar({
        icsText: hostile,
        targetTimezone: 'America/Chicago',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
      });
    const tenYears = () =>
      expandCalendar({
        icsText: hostile,
        targetTimezone: 'America/Chicago',
        windowStart: WINDOW_START,
        windowEnd: new Date('2036-01-01T00:00:00Z'),
      });

    const result = oneYear();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.truncated).toBe(true);

    // "Cannot hang" is a claim about the per-event iteration cap, and the way
    // to state it without naming a number of milliseconds is that the window
    // does not matter: FREQ=SECONDLY exhausts MAX_ITERATIONS_PER_EVENT about
    // five hours in, so a ten-year window costs the same as a one-year one.
    // Remove the cap and this is where it shows up — a tenfold window would
    // cost tenfold. Measured flat here, at 0.97.
    const { smallMs, largeMs, ratio } = doublingRatio(oneYear, tenYears, 2);

    // eslint-disable-next-line no-console
    console.log(
      `[R20] hostile rule: 1 year in ${smallMs.toFixed(0)}ms, ` +
        `10 years in ${largeMs.toFixed(0)}ms (${ratio.toFixed(2)}x)`,
    );

    expect(ratio).toBeLessThan(2);
  }, 300_000);

  it.runIf(ABSOLUTE_BUDGET_MS !== undefined)(
    '[R20] expands 5000 events inside CALENDAR_BENCH_BUDGET_MS',
    () => {
      const { result, ms } = measure(() => expand(baseFeed, 100_000));
      expect(result.ok).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[R20] absolute: ${ms.toFixed(0)}ms (budget ${ABSOLUTE_BUDGET_MS}ms)`);
      expect(ms).toBeLessThan(ABSOLUTE_BUDGET_MS as number);
    },
    300_000,
  );
});

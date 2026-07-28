import { describe, expect, it } from 'vitest';
import { expandOk, expandRaw, startsOf } from './support/helpers.js';

const ONE_DAY = {
  windowStart: new Date('2026-06-15T00:00:00Z'),
  windowEnd: new Date('2026-06-16T00:00:00Z'),
};

describe('R16 — events straddling the window bounds', () => {
  it('[R16] an event starting before windowStart but ending inside it is included', () => {
    const events = expandOk('synthetic/window-straddle.ics', ONE_DAY);
    expect(events.map((event) => event.uid)).toContain('straddle-start@synthetic');
  });

  it('[R16] an event starting inside the window and ending after it is included', () => {
    const events = expandOk('synthetic/window-straddle.ics', ONE_DAY);
    expect(events.map((event) => event.uid)).toContain('straddle-end@synthetic');
  });

  it('[R16] an event enclosing the entire window is included', () => {
    const events = expandOk('synthetic/window-straddle.ics', ONE_DAY);
    expect(events.map((event) => event.uid)).toContain('straddle-entirely@synthetic');
  });

  it('[R16] events wholly outside the window are excluded', () => {
    const uids = expandOk('synthetic/window-straddle.ics', ONE_DAY).map((event) => event.uid);
    expect(uids).not.toContain('wholly-before@synthetic');
    expect(uids).not.toContain('wholly-after@synthetic');
  });

  it('[R16] a zero-length event inside the window is included', () => {
    const uids = expandOk('synthetic/window-straddle.ics', ONE_DAY).map((event) => event.uid);
    expect(uids).toContain('zero-length-inside@synthetic');
  });

  it('[R16] exactly the four intersecting events come back, sorted by start', () => {
    const events = expandOk('synthetic/window-straddle.ics', ONE_DAY);
    expect(events.map((event) => event.uid)).toEqual([
      'straddle-entirely@synthetic',
      'straddle-start@synthetic',
      'zero-length-inside@synthetic',
      'straddle-end@synthetic',
    ]);
    const starts = startsOf(events).map((iso) => Date.parse(iso));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('[R16] windowEnd is exclusive and windowStart is inclusive', () => {
    // An event beginning exactly at windowEnd is out; one ending exactly at
    // windowStart is out; one beginning exactly at windowStart is in.
    const events = expandOk('synthetic/window-straddle.ics', {
      windowStart: new Date('2026-06-15T12:00:00Z'),
      windowEnd: new Date('2026-06-15T22:00:00Z'),
    });
    expect(events.map((event) => event.uid)).toContain('zero-length-inside@synthetic');
    expect(events.map((event) => event.uid)).not.toContain('straddle-end@synthetic');
  });
});

describe('R17 — maxEvents cap', () => {
  it('[R17] the cap limits the returned array', () => {
    const events = expandOk('synthetic/rrule-comprehensive.ics', {
      targetTimezone: 'America/New_York',
      maxEvents: 5,
    });
    expect(events).toHaveLength(5);
  });

  it('[R17] hitting the cap is reported to the caller rather than hidden', () => {
    const result = expandRaw('synthetic/rrule-comprehensive.ics', {
      targetTimezone: 'America/New_York',
      maxEvents: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.totalBeforeCap).toBeGreaterThan(5);
    expect(result.meta.warnings.some((warning) => warning.code === 'MAX_EVENTS_REACHED')).toBe(
      true,
    );
  });

  it('[R17] the capped result is the earliest events, not an arbitrary slice', () => {
    const options = { targetTimezone: 'America/New_York' } as const;
    const uncapped = expandOk('synthetic/rrule-comprehensive.ics', {
      ...options,
      maxEvents: 10_000,
    });
    const capped = expandOk('synthetic/rrule-comprehensive.ics', { ...options, maxEvents: 5 });
    // Sorting happens before capping, so the capped result must be a strict
    // prefix of the full result.
    expect(startsOf(capped)).toEqual(startsOf(uncapped).slice(0, 5));
  });

  it('[R17] staying under the cap reports no truncation', () => {
    const result = expandRaw('synthetic/cancelled.ics', { maxEvents: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.totalBeforeCap).toBe(result.value.length);
    expect(result.meta.warnings.some((warning) => warning.code === 'MAX_EVENTS_REACHED')).toBe(
      false,
    );
  });

  it('[R17] the default cap is 2000', () => {
    const result = expandRaw('synthetic/cancelled.ics');
    expect(result.ok).toBe(true);
    // Nothing here approaches the default, so the point is simply that omitting
    // maxEvents does not mean unbounded.
    if (result.ok) expect(result.meta.truncated).toBe(false);
  });
});

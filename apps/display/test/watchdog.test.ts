import { describe, expect, it } from 'vitest';
import { assess, DEFAULT_LIMITS, type WatchdogState } from '../src/watchdog.js';

/**
 * The watchdog.
 *
 * The failures worth catching are the quiet ones — a loop that threw once and
 * never rescheduled, a renderer that stopped after a bad document. All of them
 * look exactly like a working wall showing a very old day.
 */

const AT = 1_700_000_000_000;
const healthy = (over: Partial<WatchdogState> = {}): WatchdogState => ({
  lastDrawAt: AT,
  lastContactAt: AT,
  startedAt: AT - 10 * 60_000,
  reloads: 0,
  ...over,
});

describe('leaving a working wall alone', () => {
  it('waits while everything is current', () => {
    expect(assess(healthy(), AT)).toEqual({ action: 'wait' });
  });

  it('waits through a server being down, which is not our fault', () => {
    // The stored manifest handles this case gracefully. Reloading every few
    // minutes would replace a useful stale wall with a flickering one.
    const state = healthy({ lastContactAt: AT - 30 * 60_000 });
    expect(assess(state, AT)).toEqual({ action: 'wait' });
  });

  it('waits during the grace period after a page starts', () => {
    // Reloading during startup is how a boot loop begins.
    const state = healthy({ startedAt: AT - 5_000, lastDrawAt: AT - 5 * 60_000 });
    expect(assess(state, AT)).toEqual({ action: 'wait' });
  });
});

describe('noticing that it has stopped', () => {
  it('reloads when draws have stopped landing', () => {
    const state = healthy({ lastDrawAt: AT - 2 * 60_000 });
    const verdict = assess(state, AT);
    expect(verdict.action).toBe('reload');
    expect(verdict).toHaveProperty('reason', 'the renderer stopped drawing');
  });

  it('reloads after hours of silence from the server', () => {
    const state = healthy({ lastContactAt: AT - 3 * 60 * 60_000 });
    expect(assess(state, AT).action).toBe('reload');
  });

  it('stops trying after a few goes', () => {
    // A reload loop is worse than the fault it is treating: a wall showing an
    // old day beats one that blanks itself every minute for ever.
    const state = healthy({ lastDrawAt: AT - 2 * 60_000, reloads: DEFAULT_LIMITS.maxReloads });
    expect(assess(state, AT)).toEqual({ action: 'wait' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  nextRunAfterFailure,
  nextRunAfterRetryAfter,
  nextRunAfterSuccess,
  runDueJobs,
  type JobFinish,
  type JobRecord,
  type JobStore,
  type JobTiming,
} from '../src/domain/scheduler.js';

const NOW = 1_000_000;
const TIMING: JobTiming = {
  intervalMs: 900_000,
  jitterRatio: 0.1,
  backoffInitialMs: 60_000,
  backoffMaxMs: 3_600_000,
};
const TIMINGS = { sync: TIMING };

/** An in-memory store, so the loop can be tested without a database. */
function makeStore(jobs: (JobRecord & Partial<JobFinish>)[]) {
  const state = new Map(jobs.map((job) => [job.key, { ...job } as Record<string, unknown>]));
  const finished: string[] = [];
  const store: JobStore = {
    due: (now, staleBefore) =>
      [...state.values()].filter(
        (job) =>
          (job['nextRunAt'] as number) <= now &&
          (job['runningSince'] == null || (job['runningSince'] as number) < staleBefore),
      ) as unknown as JobRecord[],
    claim: (key, now, staleBefore) => {
      const job = state.get(key);
      if (!job) return false;
      if (job['runningSince'] != null && (job['runningSince'] as number) >= staleBefore) {
        return false;
      }
      job['runningSince'] = now;
      return true;
    },
    finish: (key, update) => {
      Object.assign(state.get(key)!, update, { runningSince: null });
      finished.push(key);
    },
  };
  return { store, state, finished };
}

describe('scheduling a healthy job', () => {
  it('centres on the interval and spreads either side of it', () => {
    // Without jitter, ten sources added in one sitting would forever hit their
    // upstreams in the same second of the same minute.
    expect(nextRunAfterSuccess(TIMING, NOW, () => 0.5) - NOW).toBe(900_000);
    expect(nextRunAfterSuccess(TIMING, NOW, () => 0) - NOW).toBe(810_000);
    expect(nextRunAfterSuccess(TIMING, NOW, () => 1) - NOW).toBe(990_000);
  });

  it('stays inside the band across many draws', () => {
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 2000; i++) {
      const delay = nextRunAfterSuccess(TIMING, NOW) - NOW;
      lowest = Math.min(lowest, delay);
      highest = Math.max(highest, delay);
    }
    expect(lowest).toBeGreaterThanOrEqual(810_000);
    expect(highest).toBeLessThan(990_001);
  });
});

describe('backing off after failure', () => {
  it('doubles each time and then caps', () => {
    const at = (failures: number) => nextRunAfterFailure(TIMING, failures, NOW, () => 1) - NOW;
    expect([at(1), at(2), at(3), at(4)]).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(at(20)).toBe(3_600_000);
  });

  it('never retries instantly', () => {
    // Equal jitter: half the delay is fixed. Full jitter would sometimes retry
    // almost immediately, which is the opposite of what a struggling upstream
    // needs.
    for (const failures of [1, 2, 3, 10]) {
      expect(nextRunAfterFailure(TIMING, failures, NOW, () => 0) - NOW).toBeGreaterThan(0);
    }
    expect(nextRunAfterFailure(TIMING, 1, NOW, () => 0) - NOW).toBe(30_000);
  });

  it('honours Retry-After when it asks for longer than we chose', () => {
    // A 429 or 503 carrying Retry-After is a server saying exactly what it
    // wants. Backing off further is fine; backing off less is not.
    expect(nextRunAfterRetryAfter(TIMING, 3600, 1, NOW, () => 0) - NOW).toBe(3_600_000);
    expect(nextRunAfterRetryAfter(TIMING, 1, 5, NOW, () => 1)).toBe(
      nextRunAfterFailure(TIMING, 5, NOW, () => 1),
    );
  });
});

describe('the run loop', () => {
  const random = () => 0.5;

  it('runs what is due and leaves the rest alone', async () => {
    const { store, state } = makeStore([
      { key: 'a', kind: 'sync', nextRunAt: NOW - 1, consecutiveFailures: 0 },
      { key: 'b', kind: 'sync', nextRunAt: NOW + 60_000, consecutiveFailures: 0 },
    ]);
    const seen: string[] = [];
    const report = await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      handlers: {
        sync: async (job) => {
          seen.push(job.key);
          return { status: 'ok' };
        },
      },
    });
    expect(seen).toEqual(['a']);
    expect([report.considered, report.ran, report.succeeded]).toEqual([1, 1, 1]);
    expect(state.get('a')?.['runningSince']).toBe(null);
    expect(state.get('a')?.['nextRunAt']).toBeGreaterThan(NOW);
  });

  it('records a failure and backs off', async () => {
    const { store, state } = makeStore([
      { key: 'a', kind: 'sync', nextRunAt: NOW - 1, consecutiveFailures: 2 },
    ]);
    await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      handlers: { sync: async () => ({ status: 'failed', error: 'upstream down' }) },
    });
    expect(state.get('a')?.['consecutiveFailures']).toBe(3);
    expect(state.get('a')?.['lastError']).toBe('upstream down');
  });

  it('treats a throwing handler as a failure rather than a crash', async () => {
    // The scheduler is the one component that absolutely cannot take the
    // process down with it.
    const { store, state } = makeStore([
      { key: 'a', kind: 'sync', nextRunAt: NOW - 1, consecutiveFailures: 0 },
    ]);
    const errors: string[] = [];
    const report = await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      onError: (key) => errors.push(key),
      handlers: {
        sync: async () => {
          throw new Error('handler exploded');
        },
      },
    });
    expect(report.failed).toBe(1);
    expect(errors).toEqual(['a']);
    expect(state.get('a')?.['lastError']).toBe('handler exploded');
    expect(state.get('a')?.['nextRunAt']).toBeGreaterThan(NOW);
  });

  it('does not start a job that is already running', async () => {
    const { store } = makeStore([
      { key: 'a', kind: 'sync', nextRunAt: NOW - 1, consecutiveFailures: 0, runningSince: NOW - 1000 },
    ]);
    const report = await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      handlers: { sync: async () => ({ status: 'ok' }) },
    });
    expect([report.considered, report.ran]).toEqual([0, 0]);
  });

  it('reclaims a job whose process died mid-run', async () => {
    const { store } = makeStore([
      {
        key: 'a',
        kind: 'sync',
        nextRunAt: NOW - 1,
        consecutiveFailures: 0,
        runningSince: NOW - 3_600_000,
      },
    ]);
    const report = await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      staleRunMs: 900_000,
      handlers: { sync: async () => ({ status: 'ok' }) },
    });
    expect(report.succeeded).toBe(1);
  });

  it('leaves an unknown job kind untouched', async () => {
    // A job row outliving the code that serviced it. A future version may know
    // what it is, so deleting or failing it would be presumptuous.
    const { store, finished } = makeStore([
      { key: 'a', kind: 'mystery', nextRunAt: NOW - 1, consecutiveFailures: 0 },
    ]);
    const report = await runDueJobs({ store, timings: TIMINGS, now: NOW, random, handlers: {} });
    expect([report.skipped, report.failed]).toEqual([1, 0]);
    expect(finished).toEqual([]);
  });

  it('runs jobs concurrently so one slow feed does not delay the others', async () => {
    const { store } = makeStore(
      ['a', 'b', 'c'].map((key) => ({ key, kind: 'sync', nextRunAt: NOW - 1, consecutiveFailures: 0 })),
    );
    let inFlight = 0;
    let peak = 0;
    const report = await runDueJobs({
      store,
      timings: TIMINGS,
      now: NOW,
      random,
      handlers: {
        sync: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
          return { status: 'ok' };
        },
      },
    });
    expect(report.succeeded).toBe(3);
    expect(peak).toBe(3);
  });
});

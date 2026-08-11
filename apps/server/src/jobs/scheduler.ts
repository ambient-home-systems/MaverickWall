import { runDueJobs, type JobHandler, type JobStore, type JobTiming } from '@maverick-wall/core';

/**
 * The tick.
 *
 * Everything interesting — when to run, how far to back off, how to avoid
 * running the same job twice — lives in core and is tested without a clock.
 * This is the wrapper that calls it on an interval, and it is deliberately the
 * dullest file in the application.
 */

const DEFAULT_TICK_MS = 30_000;

export interface SchedulerOptions {
  readonly store: JobStore;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly timings: Readonly<Record<string, JobTiming>>;
  readonly tickMs?: number;
  readonly onError?: (key: string, error: unknown) => void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** Run one tick immediately. Used on boot and by tests. */
  tick(): Promise<void>;
  readonly running: boolean;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Ticks must not overlap. A tick that runs long — a slow feed, a big backup —
  // would otherwise stack up behind itself. Per-job overlap is handled by
  // `claim`; this guards the loop itself.
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await runDueJobs({
        store: options.store,
        handlers: options.handlers,
        timings: options.timings,
        now: Date.now(),
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
      });
    } catch (error) {
      // runDueJobs is supposed to swallow handler failures itself, so anything
      // arriving here is a defect in the scheduler rather than in a job. It
      // still must not stop the loop: a wall display with a dead scheduler
      // shows a calendar that silently stops updating, which is worse than one
      // that says it is struggling.
      options.onError?.('scheduler', error);
    } finally {
      ticking = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, tickMs);
      // Do not hold the process open on the scheduler's account. The HTTP
      // server is what keeps it alive, and a shutdown should not wait out a
      // tick interval.
      timer.unref?.();
      void tick();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    tick,

    get running(): boolean {
      return timer !== undefined;
    },
  };
}

/**
 * Timings per job kind.
 *
 * Calendar syncs are the only ones that touch somebody else's server, so they
 * are the only ones whose interval is a politeness question as much as a
 * freshness one. Fifteen minutes is well inside what a household notices and
 * well outside what any provider would object to.
 */
export const JOB_TIMINGS: Readonly<Record<string, JobTiming>> = {
  'ics-sync': {
    intervalMs: 15 * 60_000,
    jitterRatio: 0.15,
    backoffInitialMs: 60_000,
    backoffMaxMs: 60 * 60_000,
  },
  retention: {
    intervalMs: 24 * 60 * 60_000,
    jitterRatio: 0.05,
    backoffMaxMs: 60 * 60_000,
  },
  backup: {
    intervalMs: 24 * 60 * 60_000,
    jitterRatio: 0.05,
    backoffMaxMs: 60 * 60_000,
  },
  'weather-sync': {
    // NWS updates about hourly and asks clients not to poll harder.
    intervalMs: 60 * 60_000,
    jitterRatio: 0.2,
    backoffInitialMs: 5 * 60_000,
    backoffMaxMs: 6 * 60 * 60_000,
  },
  'ha-calendar-sync': {
    // More often than an ICS feed: this is the household's own machine on
    // their own network, so politeness to a stranger's server is not the
    // constraint. Five minutes is what makes an event added on a phone show up
    // on the wall while somebody is still standing there.
    intervalMs: 5 * 60_000,
    jitterRatio: 0.15,
    backoffInitialMs: 60_000,
    backoffMaxMs: 30 * 60_000,
  },
  'ha-sync': {
    /*
     * Thirty seconds, which the tick then bounds.
     *
     * The scheduler ticks every thirty seconds too, so a reading is in
     * practice between thirty and sixty seconds old. Backoff is short and
     * capped low: a Home Assistant that comes back after a reboot should be
     * noticed in minutes, not after an hour of exponential patience.
     */
    intervalMs: 30_000,
    jitterRatio: 0.1,
    backoffInitialMs: 60_000,
    backoffMaxMs: 10 * 60_000,
  },
  'alerts-sync': {
    /*
     * Sixty seconds, conditionally.
     *
     * A quiet zone costs one 304, which is what makes a minute defensible
     * against a public service. Backoff starts at five minutes and is allowed
     * to climb to thirty: NWS reliability varies during major events, which is
     * exactly when this matters, and a thousand kitchen walls retrying every
     * sixty seconds is a small part of why it was struggling. The alerts
     * already on the wall stay up throughout.
     */
    intervalMs: 60_000,
    jitterRatio: 0.2,
    backoffInitialMs: 5 * 60_000,
    backoffMaxMs: 30 * 60_000,
  },
  'external-modules': {
    // A few minutes: third-party modules are on the household's own network, so
    // the constraint is freshness rather than politeness to a stranger. A slow
    // or failing module backs off on its own without dragging the others.
    intervalMs: 5 * 60_000,
    jitterRatio: 0.15,
    backoffInitialMs: 60_000,
    backoffMaxMs: 30 * 60_000,
  },
  'update-check': {
    // Once a day. Anything more often is a household's address book of
    // requests to somebody else's server for a number that changes monthly.
    intervalMs: 24 * 60 * 60_000,
    jitterRatio: 0.25,
    backoffInitialMs: 60 * 60_000,
    backoffMaxMs: 24 * 60 * 60_000,
  },
  optimize: {
    intervalMs: 6 * 60 * 60_000,
    jitterRatio: 0.1,
    backoffMaxMs: 60 * 60_000,
  },
};

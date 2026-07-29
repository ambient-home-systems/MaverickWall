/**
 * The scheduler.
 *
 * One in-process loop, no queue library, no Redis. A household runs a handful
 * of jobs — sync each calendar, trim old rows, snapshot the database, let
 * SQLite tidy its statistics — and every one of them is idempotent and cheap.
 * Reaching for a job queue here would add a moving part that has to be operated
 * by someone with no terminal.
 *
 * The timing policy and the run loop live in core behind a store port, so both
 * can be tested without a database or a clock. Only the `setInterval` wrapper
 * and the SQLite adapter need a runtime.
 */

export interface JobRecord {
  /** e.g. `ics-sync:<sourceId>`. Unique, and stable across restarts. */
  readonly key: string;
  /** Selects the handler. e.g. `ics-sync`, `backup`, `retention`. */
  readonly kind: string;
  readonly nextRunAt: number;
  readonly consecutiveFailures: number;
  /** Set while running. A value older than the stale threshold means a crash. */
  readonly runningSince?: number | undefined;
}

export interface JobTiming {
  /** Normal spacing between runs. */
  readonly intervalMs: number;
  /**
   * Random spread applied to every scheduled run, as a fraction of the
   * interval. Without it, ten calendar sources added in one sitting would
   * forever hit their upstreams in the same second of the same minute.
   */
  readonly jitterRatio?: number;
  /** First retry delay. Defaults to a tenth of the interval. */
  readonly backoffInitialMs?: number;
  /** Ceiling on the retry delay. Defaults to one hour. */
  readonly backoffMaxMs?: number;
}

const DEFAULT_JITTER_RATIO = 0.1;
const DEFAULT_BACKOFF_MAX_MS = 60 * 60_000;

/** A job running longer than this is assumed dead, and may be re-claimed. */
export const DEFAULT_STALE_RUN_MS = 15 * 60_000;

function jitter(amountMs: number, ratio: number, random: () => number): number {
  const spread = amountMs * ratio;
  return Math.round(amountMs - spread + random() * spread * 2);
}

/** When to run next after a job succeeds. */
export function nextRunAfterSuccess(
  timing: JobTiming,
  now: number,
  random: () => number = Math.random,
): number {
  const ratio = timing.jitterRatio ?? DEFAULT_JITTER_RATIO;
  return now + Math.max(1_000, jitter(timing.intervalMs, ratio, random));
}

/**
 * When to retry after a failure.
 *
 * Exponential, capped, with equal jitter: half the delay is fixed and half is
 * random. Full jitter would sometimes retry almost immediately, which is the
 * opposite of what a struggling upstream needs; no jitter at all would line up
 * every failing source into a synchronised retry storm.
 */
export function nextRunAfterFailure(
  timing: JobTiming,
  consecutiveFailures: number,
  now: number,
  random: () => number = Math.random,
): number {
  const initial = timing.backoffInitialMs ?? Math.max(30_000, Math.round(timing.intervalMs / 10));
  const cap = timing.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const exponent = Math.min(consecutiveFailures, 16);
  const ceiling = Math.min(cap, initial * 2 ** Math.max(0, exponent - 1));
  const half = ceiling / 2;
  return now + Math.round(half + random() * half);
}

/**
 * Honour an upstream's own retry hint when it gives one.
 *
 * A 429 or 503 with `Retry-After` is a server telling us exactly what it wants.
 * Backing off further than asked is fine; backing off less is not.
 */
export function nextRunAfterRetryAfter(
  timing: JobTiming,
  retryAfterSeconds: number,
  consecutiveFailures: number,
  now: number,
  random: () => number = Math.random,
): number {
  const ourChoice = nextRunAfterFailure(timing, consecutiveFailures, now, random);
  return Math.max(ourChoice, now + retryAfterSeconds * 1_000);
}

export type JobResult =
  | { readonly status: 'ok' }
  /** Ran, nothing to do. Treated as success, kept distinct for diagnostics. */
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string; readonly retryAfterSeconds?: number };

export type JobHandler = (job: JobRecord) => Promise<JobResult>;

export interface JobStore {
  /** Jobs whose `nextRunAt` has passed and which are not already running. */
  due(now: number, staleBefore: number): readonly JobRecord[];
  /**
   * Mark a job running. Returns false if someone else got there first.
   *
   * Must be atomic: this is the only thing stopping a slow job from being
   * started twice by overlapping ticks.
   */
  claim(key: string, now: number, staleBefore: number): boolean;
  finish(key: string, update: JobFinish): void;
}

export interface JobFinish {
  readonly lastRunAt: number;
  readonly lastDurationMs: number;
  readonly nextRunAt: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

export interface RunOptions {
  readonly store: JobStore;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  /** Timing per job kind. Unknown kinds are skipped rather than guessed at. */
  readonly timings: Readonly<Record<string, JobTiming>>;
  readonly now: number;
  readonly staleRunMs?: number;
  readonly random?: () => number;
  /** Reported rather than thrown, so a tick never takes the process down. */
  readonly onError?: (key: string, error: unknown) => void;
}

export interface TickReport {
  readonly considered: number;
  readonly ran: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * Run everything that is due, once.
 *
 * Jobs run concurrently — there are only a handful, they are mostly waiting on
 * the network, and serialising them would mean one slow feed delaying every
 * other. Overlap between *ticks* is prevented per key by `claim`, not by
 * blocking the loop.
 *
 * Never throws. A handler that blows up is recorded as a failure on its own
 * job and nothing else is affected: the scheduler is the one component that
 * absolutely cannot take the process down with it.
 */
export async function runDueJobs(options: RunOptions): Promise<TickReport> {
  const staleRunMs = options.staleRunMs ?? DEFAULT_STALE_RUN_MS;
  const random = options.random ?? Math.random;
  const staleBefore = options.now - staleRunMs;

  const due = options.store.due(options.now, staleBefore);
  let ran = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  await Promise.all(
    due.map(async (job) => {
      const handler = options.handlers[job.kind];
      const timing = options.timings[job.kind];
      if (!handler || !timing) {
        // An unknown kind means a job row outlived the code that serviced it.
        // Leaving it alone is right: a future version may know what it is.
        skipped++;
        return;
      }

      if (!options.store.claim(job.key, options.now, staleBefore)) {
        skipped++;
        return;
      }

      ran++;
      const startedAt = options.now;
      let result: JobResult;
      try {
        result = await handler(job);
      } catch (error) {
        options.onError?.(job.key, error);
        result = {
          status: 'failed',
          error: error instanceof Error ? error.message : 'unknown error',
        };
      }

      const finishedAt = Date.now();
      const durationMs = Math.max(0, finishedAt - startedAt);

      if (result.status === 'failed') {
        failed++;
        const failures = job.consecutiveFailures + 1;
        const nextRunAt =
          result.retryAfterSeconds !== undefined
            ? nextRunAfterRetryAfter(timing, result.retryAfterSeconds, failures, finishedAt, random)
            : nextRunAfterFailure(timing, failures, finishedAt, random);
        options.store.finish(job.key, {
          lastRunAt: startedAt,
          lastDurationMs: durationMs,
          nextRunAt,
          consecutiveFailures: failures,
          lastError: result.error,
        });
        return;
      }

      succeeded++;
      options.store.finish(job.key, {
        lastRunAt: startedAt,
        lastDurationMs: durationMs,
        nextRunAt: nextRunAfterSuccess(timing, finishedAt, random),
        consecutiveFailures: 0,
        lastError: null,
      });
    }),
  );

  return { considered: due.length, ran, succeeded, failed, skipped };
}

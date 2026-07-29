import type { JobFinish, JobRecord, JobStore } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';

/**
 * `job_state` as a JobStore.
 *
 * Thin by design: all the scheduling policy lives in core and is tested without
 * a database. This is only the part that has to touch SQLite.
 */
export function createJobStore(db: SqliteDatabase): JobStore {
  const dueStatement = db.prepare(
    `SELECT key, kind, next_run_at AS nextRunAt,
            consecutive_failures AS consecutiveFailures,
            running_since AS runningSince
       FROM job_state
      WHERE next_run_at <= ?
        AND (running_since IS NULL OR running_since < ?)
      ORDER BY next_run_at`,
  );

  // A single statement, so SQLite makes it atomic. This is the only thing
  // stopping a slow job from being started twice by overlapping ticks, and a
  // read-then-write would leave exactly the window that allows it.
  const claimStatement = db.prepare(
    `UPDATE job_state
        SET running_since = ?
      WHERE key = ?
        AND (running_since IS NULL OR running_since < ?)`,
  );

  const finishStatement = db.prepare(
    `UPDATE job_state
        SET last_run_at = ?, last_duration_ms = ?, next_run_at = ?,
            consecutive_failures = ?, last_error = ?,
            running_since = NULL, updated_at = ?
      WHERE key = ?`,
  );

  return {
    due(now: number, staleBefore: number): readonly JobRecord[] {
      return dueStatement.all(now, staleBefore) as JobRecord[];
    },

    claim(key: string, now: number, staleBefore: number): boolean {
      return claimStatement.run(now, key, staleBefore).changes === 1;
    },

    finish(key: string, update: JobFinish): void {
      finishStatement.run(
        update.lastRunAt,
        update.lastDurationMs,
        update.nextRunAt,
        update.consecutiveFailures,
        update.lastError,
        Date.now(),
        key,
      );
    },
  };
}

/**
 * Register a job, leaving an existing one alone.
 *
 * Called on every boot for every known job. Existing rows keep their schedule,
 * which is the whole point of persisting `next_run_at`: restarting the
 * container must not re-run every job immediately, or a household that
 * restarts often turns into a self-inflicted hammering of whatever their feeds
 * point at.
 */
export function ensureJob(
  db: SqliteDatabase,
  key: string,
  kind: string,
  firstRunAt: number,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run(key, kind, firstRunAt, now, now);
}

/** Drop jobs whose subject is gone, e.g. a deleted calendar source. */
export function removeJobsNotIn(
  db: SqliteDatabase,
  kind: string,
  keepKeys: readonly string[],
): number {
  if (keepKeys.length === 0) {
    return db.prepare('DELETE FROM job_state WHERE kind = ?').run(kind).changes;
  }
  const placeholders = keepKeys.map(() => '?').join(', ');
  return db
    .prepare(`DELETE FROM job_state WHERE kind = ? AND key NOT IN (${placeholders})`)
    .run(kind, ...keepKeys).changes;
}

/** Everything in the table, for the diagnostics overlay. */
export function listJobs(db: SqliteDatabase): unknown[] {
  return db
    .prepare(
      `SELECT key, kind, next_run_at AS nextRunAt, last_run_at AS lastRunAt,
              last_duration_ms AS lastDurationMs, last_error AS lastError,
              consecutive_failures AS consecutiveFailures,
              running_since AS runningSince
         FROM job_state ORDER BY next_run_at`,
    )
    .all();
}

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDueJobs } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createJobStore, ensureJob, listJobs, removeJobsNotIn } from '../src/jobs/store.js';
import { JOB_TIMINGS, createScheduler } from '../src/jobs/scheduler.js';

/**
 * The store against real SQLite.
 *
 * The scheduling policy is tested in core without a database. What can only be
 * checked here is that `claim` is genuinely atomic and that `next_run_at`
 * survives a restart, which is the whole reason it is persisted.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDatabase() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-jobs-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, dataDir };
}

describe('registering jobs', () => {
  it('adds a job once and leaves its schedule alone thereafter', () => {
    // The point of persisting next_run_at: restarting the container must not
    // re-run every job immediately, or a household that restarts often turns
    // into a self-inflicted hammering of whatever their feeds point at.
    const { db } = freshDatabase();
    ensureJob(db, 'ics-sync:one', 'ics-sync', 5_000);
    ensureJob(db, 'ics-sync:one', 'ics-sync', 999_999);
    const jobs = listJobs(db) as { key: string; nextRunAt: number }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.nextRunAt).toBe(5_000);
  });

  it('removes jobs whose subject is gone', () => {
    const { db } = freshDatabase();
    ensureJob(db, 'ics-sync:a', 'ics-sync', 1);
    ensureJob(db, 'ics-sync:b', 'ics-sync', 1);
    ensureJob(db, 'backup', 'backup', 1);
    expect(removeJobsNotIn(db, 'ics-sync', ['ics-sync:a'])).toBe(1);
    const keys = (listJobs(db) as { key: string }[]).map((job) => job.key).sort();
    expect(keys).toEqual(['backup', 'ics-sync:a']);
  });
});

describe('claiming', () => {
  it('lets exactly one caller win', () => {
    // A single UPDATE, so SQLite makes it atomic. A read-then-write would
    // leave the window that allows a slow job to be started twice.
    const { db } = freshDatabase();
    ensureJob(db, 'job', 'ics-sync', 0);
    const store = createJobStore(db);
    expect(store.claim('job', 1000, 0)).toBe(true);
    expect(store.claim('job', 1001, 0)).toBe(false);
    expect(store.claim('job', 1002, 0)).toBe(false);
  });

  it('reclaims a job abandoned by a crashed process', () => {
    const { db } = freshDatabase();
    ensureJob(db, 'job', 'ics-sync', 0);
    const store = createJobStore(db);
    expect(store.claim('job', 1_000_000, 0)).toBe(true);
    // Nothing cleared running_since, because the process died. Once it is
    // older than the stale threshold it becomes available again.
    expect(store.claim('job', 2_000_000, 1_500_000)).toBe(true);
  });

  it('hides a running job from the due list', () => {
    const { db } = freshDatabase();
    ensureJob(db, 'job', 'ics-sync', 0);
    const store = createJobStore(db);
    expect(store.due(1000, 0)).toHaveLength(1);
    store.claim('job', 1000, 0);
    expect(store.due(1001, 0)).toHaveLength(0);
  });
});

describe('a full cycle against the database', () => {
  it('records success and reschedules into the future', async () => {
    const { db } = freshDatabase();
    ensureJob(db, 'ics-sync:one', 'ics-sync', 0);
    const store = createJobStore(db);

    const report = await runDueJobs({
      store,
      timings: JOB_TIMINGS,
      handlers: { 'ics-sync': async () => ({ status: 'ok' }) },
      now: Date.now(),
    });

    expect(report.succeeded).toBe(1);
    const job = (listJobs(db) as { nextRunAt: number; runningSince: number | null; lastError: string | null }[])[0];
    expect(job?.runningSince).toBe(null);
    expect(job?.lastError).toBe(null);
    expect(job?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('records a failure with its message and backs off', async () => {
    const { db } = freshDatabase();
    ensureJob(db, 'ics-sync:one', 'ics-sync', 0);
    const store = createJobStore(db);

    await runDueJobs({
      store,
      timings: JOB_TIMINGS,
      handlers: { 'ics-sync': async () => ({ status: 'failed', error: 'feed unreachable' }) },
      now: Date.now(),
    });

    const job = (listJobs(db) as { consecutiveFailures: number; lastError: string }[])[0];
    expect(job?.consecutiveFailures).toBe(1);
    expect(job?.lastError).toBe('feed unreachable');
  });
});

describe('the tick loop', () => {
  it('runs on demand and does not overlap itself', async () => {
    const { db } = freshDatabase();
    ensureJob(db, 'ics-sync:one', 'ics-sync', 0);

    let started = 0;
    const scheduler = createScheduler({
      store: createJobStore(db),
      timings: JOB_TIMINGS,
      handlers: {
        'ics-sync': async () => {
          started++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { status: 'ok' };
        },
      },
    });

    // Three ticks fired at once. The first claims the job; the others find it
    // running and leave it alone.
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    expect(started).toBe(1);
    expect(scheduler.running).toBe(false);
  });

  it('stops cleanly', () => {
    const { db } = freshDatabase();
    const scheduler = createScheduler({
      store: createJobStore(db),
      timings: JOB_TIMINGS,
      handlers: {},
      tickMs: 60_000,
    });
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });
});

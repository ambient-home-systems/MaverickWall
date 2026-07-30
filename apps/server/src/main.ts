import { serve } from '@hono/node-server';
import { DEFAULT_SHIFT_TYPES } from '@maverick-wall/core';
import { openDatabase, optimize } from './db/open.js';
import { describeOutcome, runMigrations } from './db/migrate.js';
import { createKeyring, loadOrCreateMasterKey } from './secrets/keyring.js';
import { createFetcher } from './net/fetcher.js';
import { createJobStore, ensureJob, removeJobsNotIn } from './jobs/store.js';
import { JOB_TIMINGS, createScheduler } from './jobs/scheduler.js';
import { createIcsSyncHandler } from './jobs/ics-sync.js';
import { createApp } from './http/app.js';
import { countUsers, readHousehold } from './api/queries.js';
import { formatShortCode, issueSetupToken } from './auth/tokens.js';
import type { ManifestNotice } from './api/manifest.js';

/**
 * Boot.
 *
 * Ordered so that each step can fail without preventing the next. Rule nine
 * governs everything here: a wall display that refuses to start shows a black
 * rectangle to a household who cannot read logs, so every recoverable problem
 * becomes a notice on screen rather than a non-zero exit.
 */

const APP_VERSION = '0.1.0';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function main(): Promise<void> {
  const dataDir = env('DATA_DIR', '/data');
  const port = Number(env('PORT', '8080'));
  const notices: ManifestNotice[] = [];

  const { db, path, warnings } = openDatabase({ dataDir });
  console.log(`[boot] database ${path}`);
  for (const warning of warnings) {
    console.warn(`[boot] ${warning}`);
    notices.push({ level: 'warn', code: 'storage', message: warning });
  }

  const outcome = runMigrations(db, {
    dataDir,
    migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  });
  const migrationMessage = describeOutcome(outcome);
  if (migrationMessage) {
    console.warn(`[boot] ${migrationMessage}`);
    notices.push({
      level: outcome.status === 'failed' ? 'error' : 'warn',
      code: `migration-${outcome.status}`,
      message: migrationMessage,
    });
  }
  if (outcome.status === 'failed') {
    // Deliberately continues. Whatever schema exists may still be enough to
    // show yesterday's calendar, and that beats a restart loop.
    console.error('[boot] continuing with the schema as it stands');
  }

  const master = loadOrCreateMasterKey(dataDir);
  if (master.created) console.log('[boot] generated a new encryption key');
  if (master.permissionWarning) {
    console.warn(`[boot] ${master.permissionWarning}`);
    notices.push({ level: 'warn', code: 'key-permissions', message: master.permissionWarning });
  }
  const keyring = createKeyring(master.key);

  seedDefaults(db);

  const fetcher = createFetcher();
  const household = readHousehold(db);

  const scheduler = createScheduler({
    store: createJobStore(db),
    timings: JOB_TIMINGS,
    handlers: {
      'ics-sync': createIcsSyncHandler({
        db,
        fetcher,
        keyring,
        timezone: () => readHousehold(db).timezone,
      }),
      optimize: async () => {
        optimize(db);
        return { status: 'ok' };
      },
    },
    onError: (key, error) => {
      console.error(`[job] ${key}:`, error instanceof Error ? error.message : error);
    },
  });

  registerJobs(db);
  scheduler.start();
  console.log(`[boot] scheduler started, timezone ${household.timezone}`);

  if (countUsers(db) === 0) {
    // Nobody has a terminal on a wall display and there is no public signup.
    // The token is short-lived and dies as soon as an account exists, unlike
    // credentials seeded from the environment which persist for the life of
    // the container.
    const setup = issueSetupToken();
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  No account yet. Finish setup within 30 minutes:    │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log(`     http://<this-host>:${port}/setup?token=${setup.token}`);
    console.log(`     or enter code:  ${formatShortCode(setup.shortCode)}`);
    console.log('');
  }

  const app = createApp({ db, appVersion: APP_VERSION, bootNotices: notices });
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  console.log(`[boot] listening on http://0.0.0.0:${port}`);

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal}`);
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not wait forever for a hung connection.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Rows that must exist for the application to have anything to read.
 *
 * Idempotent, and run on every boot rather than only the first, so a row
 * deleted by accident comes back rather than causing a puzzling empty screen.
 */
function seedDefaults(db: ReturnType<typeof openDatabase>['db']): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at)
     VALUES ('singleton', ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);

  const insertShiftType = db.prepare(
    `INSERT INTO shift_types (id, key, label, short_code, color_token, is_working, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  DEFAULT_SHIFT_TYPES.forEach((type, index) => {
    insertShiftType.run(
      `shift-${type.key}`, type.key, type.label, type.shortCode, type.colorToken,
      type.isWorking ? 1 : 0, index, now, now,
    );
  });
}

/**
 * Reconcile job rows with the sources that exist.
 *
 * Existing rows keep their `next_run_at`, which is the point of persisting it:
 * a restart must not re-run every sync immediately. New sources get a run a few
 * seconds out rather than instantly, so a boot that adds several does not fire
 * them all at once.
 */
function registerJobs(db: ReturnType<typeof openDatabase>['db']): void {
  const sources = db.prepare('SELECT id FROM calendar_sources WHERE enabled = 1').all() as {
    id: string;
  }[];

  const keys: string[] = [];
  sources.forEach((source, index) => {
    const key = `ics-sync:${source.id}`;
    keys.push(key);
    ensureJob(db, key, 'ics-sync', Date.now() + 5_000 + index * 2_000);
  });
  removeJobsNotIn(db, 'ics-sync', keys);

  ensureJob(db, 'optimize', 'optimize', Date.now() + 60_000);
}

main().catch((error: unknown) => {
  // Anything reaching here is a defect rather than an operational problem, so
  // it is worth failing loudly: the container will restart and try again.
  console.error('[boot] failed to start:', error);
  process.exit(1);
});

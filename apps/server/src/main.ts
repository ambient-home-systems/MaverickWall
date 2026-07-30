import { serve } from '@hono/node-server';
import { DEFAULT_SHIFT_TYPES } from '@maverick-wall/core';
import { optimize, type SqliteDatabase } from './db/open.js';
import { openAndMigrate } from './db/bootstrap.js';
import { createKeyring, loadOrCreateMasterKey } from './secrets/keyring.js';
import { createFetcher } from './net/fetcher.js';
import { createJobStore, ensureJob, removeJobsNotIn } from './jobs/store.js';
import { JOB_TIMINGS, createScheduler } from './jobs/scheduler.js';
import { createIcsSyncHandler } from './jobs/ics-sync.js';
import { createApp } from './http/app.js';
import { countUsers, readHousehold } from './api/queries.js';
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

  const { db, path, dataDir: resolved, migration, warnings } = openAndMigrate(dataDir);
  console.log(`[boot] data directory ${resolved}`);
  console.log(`[boot] database ${path}`);
  if (dataDir !== resolved) {
    // A relative DATA_DIR resolves against the working directory, and
    // `pnpm --filter` sets that to the package rather than the repository root.
    console.warn(
      `[boot] DATA_DIR was relative ("${dataDir}"). Set it to an absolute path ` +
        'to be sure every tool opens the same database.',
    );
  }
  for (const warning of warnings) {
    console.warn(`[boot] ${warning}`);
    notices.push({
      level: migration.status === 'failed' ? 'error' : 'warn',
      code: 'storage',
      message: warning,
    });
  }
  if (migration.status === 'failed') {
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
    // The account setup flow does not exist yet, so this deliberately does not
    // print a link to it. Advertising a URL that answers 404 is worse than
    // saying plainly what is and is not available: somebody following the
    // instruction has no way to tell a missing feature from a broken one.
    const screens = db.prepare('SELECT COUNT(*) AS total FROM screens').get() as { total: number };
    console.log('');
    console.log('  No account has been created. The admin interface is not built yet,');
    console.log('  so use the command line tools for now:');
    console.log('');
    console.log('    add-source "Family" "<ics-url>"   subscribe to a calendar');
    console.log('    add-screen "Kitchen"              pair a display');
    console.log('    add-screen --list                 show paired displays');
    console.log('');
    if (screens.total === 0) {
      console.log('  No displays are paired, so /d/manifest will answer 401.');
      console.log('');
    }
  }

  const app = createApp({ db, appVersion: APP_VERSION, bootNotices: notices });
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });

  // Reported only once the socket is actually bound. Announcing it before
  // binding meant a failed start still claimed to be listening, which is worse
  // than saying nothing.
  server.on?.('listening', () => {
    console.log(`[boot] listening on http://0.0.0.0:${port}`);
  });

  server.on?.('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      // The likeliest cause by a distance is a previous instance still running,
      // usually one started before a rebuild. A stack trace here tells nobody
      // anything they can act on.
      console.error('');
      console.error(`  Port ${port} is already in use.`);
      console.error('');
      console.error('  Something else is listening there, most likely an older');
      console.error('  copy of this server. To find and stop it:');
      console.error('');
      console.error(`    lsof -ti:${port} | xargs kill`);
      console.error('');
      console.error(`  Or choose a different port:  PORT=8081 node dist/main.js`);
      console.error('');
    } else {
      console.error(`[boot] could not listen on ${port}:`, error.message);
    }
    scheduler.stop();
    db.close();
    process.exit(1);
  });

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
function seedDefaults(db: SqliteDatabase): void {
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
function registerJobs(db: SqliteDatabase): void {
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

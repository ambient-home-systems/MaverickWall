import { serve } from '@hono/node-server';
import { DEFAULT_SHIFT_TYPES } from '@maverick-wall/core';
import { optimize, type SqliteDatabase } from './db/open.js';
import { openAndMigrate } from './db/bootstrap.js';
import { createKeyring, deriveKey, loadOrCreateMasterKey } from './secrets/keyring.js';
import { createFetcher } from './net/fetcher.js';
import { createJobStore, ensureJob, removeJobsNotIn } from './jobs/store.js';
import { JOB_TIMINGS, createScheduler } from './jobs/scheduler.js';
import { createIcsSyncHandler } from './jobs/ics-sync.js';
import { createHaCalendarSyncHandler } from './jobs/ha-calendar-sync.js';
import { createAlertJobHandler } from './modules/weather/alert-job.js';
import { seedDefaultRules } from './api/rules.js';
import { createApp, MODULES } from './http/app.js';
import { defaultDisplayDir } from './http/static.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogBuffer } from './logbuffer.js';
import { applyStagedRestore } from './db/restore.js';
import { createSetupTokenHolder } from './http/setup.js';
import { countUsers, readHousehold, readUpdateState, recordUpdateCheck } from './api/queries.js';
import { checkForUpdate } from './api/update-check.js';
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
  const startedAt = Date.now();
  const dataDir = env('DATA_DIR', '/data');
  const port = Number(env('PORT', '8080'));
  const notices: ManifestNotice[] = [];

  /*
   * Capturing before anything else runs.
   *
   * The lines worth reading are the ones about a start that went badly, and a
   * buffer installed later would miss exactly those.
   */
  const log = createLogBuffer();
  log.capture();

  /*
   * A staged restore is applied here, before anything opens the database.
   *
   * The upload only wrote the file aside; this is the swap. Doing it at boot
   * means no process has the old file open and the operation cannot land
   * half-done under a live reader.
   */
  const restored = applyStagedRestore(dataDir);
  if (restored.status === 'restored') {
    console.log(`[boot] restored a database backup; the previous one is at ${restored.keptAt}`);
    notices.push({
      level: 'info',
      code: 'restored',
      message: 'A backup was restored. Check your calendars look right.',
    });
  } else if (restored.status === 'failed') {
    console.error(`[boot] could not restore the staged backup: ${restored.error}`);
    notices.push({ level: 'error', code: 'restore-failed', message: restored.error });
  }

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
  /*
   * The shipped weather rules, inserted once and never overwritten.
   *
   * A household who turned the Extreme rule off keeps that decision across
   * every future restart — a seed that overwrote would quietly undo somebody's
   * settings on upgrade and they would have no way to know why.
   */
  seedDefaultRules(db);

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
      /*
       * The same job with a different way of getting the bytes.
       *
       * Its own kind rather than a branch inside `ics-sync`, so the two back
       * off independently: a Home Assistant that is rebooting must not push
       * a household's Google feed into an hour-long retry.
       */
      'ha-calendar-sync': createHaCalendarSyncHandler({
        db,
        fetcher,
        keyring,
        timezone: () => readHousehold(db).timezone,
      }),
      /*
       * Every sixty seconds, conditionally.
       *
       * Its own job rather than part of the weather module's, because the
       * forecast is hourly and this is not — and because during the weather
       * that makes it matter, a failing forecast must not carry the alerts
       * into backoff with it.
       */
      'alerts-sync': createAlertJobHandler({ db, fetcher }),
      optimize: async () => {
        optimize(db);
        return { status: 'ok' };
      },
      /*
       * Only when the household asked for it.
       *
       * The job exists whether or not it is enabled, and checks the setting
       * each time it fires. That is the safe way round: a switch that
       * registers a job would leave a stale one running after somebody turned
       * it off, and the thing being turned off is a request to a third party.
       */
      /*
       * One handler per module job, from the same list the manifest reads.
       *
       * Spread in rather than listed, so a new module is a single entry in
       * MODULES and not a second edit here that somebody forgets.
       */
      ...Object.fromEntries(
        MODULES.filter((module) => module.job !== undefined).map((module) => [
          (module.job as { kind: string }).kind,
          async () => {
            await (module.job as { run: (c: unknown) => Promise<void> }).run({
              db,
              fetcher,
              keyring,
              now: Date.now(),
              timezone: readHousehold(db).timezone,
            });
            return { status: 'ok' as const };
          },
        ]),
      ),
      'update-check': async () => {
        if (!readUpdateState(db).enabled) return { status: 'ok' };
        const result = await checkForUpdate(fetcher, APP_VERSION);
        recordUpdateCheck(
          db,
          Date.now(),
          result.status === 'ok' ? result.latest : null,
          result.status === 'ok' ? null : result.message,
        );
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

  // Derived from the master key rather than read from the environment, so
  // sessions survive a restart without anyone having to set a variable — and so
  // there is no default credential to leave unchanged. Its own purpose, so it
  // is not the key that encrypts calendar URLs.
  const authSecret = deriveKey(master.key, 'session').toString('base64');
  const baseUrl = env('BASE_URL', `http://localhost:${port}`);

  /*
   * The bootstrap code, printed here and nowhere else.
   *
   * This is the only way into a fresh installation, and reaching the container
   * log is what stands in for proving you are the person who installed it.
   * Re-issued on expiry, so the log always carries a usable one rather than a
   * dead one from three hours ago.
   */
  const setupToken = createSetupTokenHolder((token) => {
    console.log('');
    console.log('  Nobody has set this up yet. Open:');
    console.log('');
    console.log(`    ${baseUrl}/setup?token=${token.token}`);
    console.log('');
    console.log(`  Or go to ${baseUrl}/setup and enter this code:  ${token.shortCode}`);
    console.log('');
    console.log('  It is valid for 30 minutes. A new one is printed here when it expires.');
    console.log('');
  });
  if (countUsers(db) === 0) setupToken.current();

  const app = createApp({
    db,
    appVersion: APP_VERSION,
    bootNotices: notices,
    auth: { secret: authSecret, baseUrl },
    keyring,
    fetcher,
    setupToken,
    dataDir: resolved,
    startedAt,
    log,
  });
  /*
   * Said out loud, like the database path.
   *
   * A wall with no bundle draws "the bundle is missing" and nothing else, and
   * the cause is always a layout the relative fallback did not expect. One
   * line here turns that from a puzzle into a fact — rule eleven, since
   * nobody can reach the household's machine.
   */
  const displayDir = defaultDisplayDir();
  if (!existsSync(join(displayDir, 'index.html'))) {
    console.warn(`[boot] no display bundle at ${displayDir}`);
    console.warn('[boot] set DISPLAY_DIR to where index.html and assets/ live');
    notices.push({
      level: 'error',
      code: 'display-missing',
      message: 'The wall bundle is missing from this installation.',
    });
  } else {
    console.log(`[boot] display bundle ${displayDir}`);
  }

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
  const sources = db.prepare('SELECT id, kind FROM calendar_sources WHERE enabled = 1').all() as {
    id: string;
    kind: string;
  }[];

  // One list per kind, because `removeJobsNotIn` reconciles a kind at a time —
  // reconciling both against one list would delete every job of the other.
  const icsKeys: string[] = [];
  const haKeys: string[] = [];
  sources.forEach((source, index) => {
    const at = Date.now() + 5_000 + index * 2_000;
    if (source.kind === 'homeassistant') {
      const key = `ha-calendar-sync:${source.id}`;
      haKeys.push(key);
      ensureJob(db, key, 'ha-calendar-sync', at);
    } else {
      const key = `ics-sync:${source.id}`;
      icsKeys.push(key);
      ensureJob(db, key, 'ics-sync', at);
    }
  });
  removeJobsNotIn(db, 'ics-sync', icsKeys);
  removeJobsNotIn(db, 'ha-calendar-sync', haKeys);

  ensureJob(db, 'optimize', 'optimize', Date.now() + 60_000);
  // Soon, but not instantly: a restart during a storm should get back into
  // rhythm rather than stampede.
  ensureJob(db, 'alerts-sync', 'alerts-sync', Date.now() + 15_000);
  // Registered always, gated by the setting when it fires. Ten minutes out so
  // a restart is never the thing that makes an outbound request.
  ensureJob(db, 'update-check', 'update-check', Date.now() + 10 * 60_000);
  // Module jobs, a minute out so a restart never stampedes an upstream.
  for (const module of MODULES) {
    if (module.job !== undefined) {
      ensureJob(db, module.job.kind, module.job.kind, Date.now() + 60_000);
    }
  }
}

main().catch((error: unknown) => {
  // Anything reaching here is a defect rather than an operational problem, so
  // it is worth failing loudly: the container will restart and try again.
  console.error('[boot] failed to start:', error);
  process.exit(1);
});

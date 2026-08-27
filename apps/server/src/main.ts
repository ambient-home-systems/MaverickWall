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
import { backfillClassic, reseedClassicForSetUp } from './api/templates.js';
import { householdSetUp } from './modules/index.js';
import { createApp, MODULES } from './http/app.js';
import { defaultDisplayDir } from './http/static.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogBuffer } from './logbuffer.js';
import { applyStagedRestore } from './db/restore.js';
import { createSetupTokenHolder } from './http/setup.js';
import { normalizeBaseUrl } from './validation.js';
import { detectWallAddress } from './net/supervisor.js';
import {
  countUsers,
  readHousehold,
  readScreens,
  readUpdateState,
  recordUpdateCheck,
  type ScreenRow,
} from './api/queries.js';
import { checkForUpdate } from './api/update-check.js';
import { readPackageVersion, resolveAppVersion } from './version.js';
import { pollExternalModules } from './modules/external/index.js';
import { manifestEtag, type Manifest, type ManifestNotice } from './api/manifest.js';
import { PushHub, PUSH_PATH } from './net/push-hub.js';
import { startMdnsAdvertiser, MDNS_DEFAULT_NAME, type MdnsHandle } from './net/mdns.js';

/**
 * Boot.
 *
 * Ordered so that each step can fail without preventing the next. Rule nine
 * governs everything here: a wall display that refuses to start shows a black
 * rectangle to a household who cannot read logs, so every recoverable problem
 * becomes a notice on screen rather than a non-zero exit.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/*
 * The real version of this process, not a constant somebody has to remember to
 * bump.
 *
 * It was hardcoded `'0.1.1'` for four releases, so every `/healthz`, every
 * screen's reported version, and — the one that bites — the update check's
 * baseline all lied. `MW_VERSION` is set in the image from the release tag the
 * build already receives (`VERSION` in the Dockerfile), with the `v` stripped.
 *
 * A build with no tag — a checkout, which is what the README documents for
 * development — used to report `0.0.0` and told the same three lies again.
 * It now reports the package's own version with `-dev` on it, and that suffix
 * is what suppresses the update check (`isReleaseVersion`): comparing an
 * unreleased build against the latest release can only ever answer "there is
 * an update", every day, for ever.
 */
const APP = resolveAppVersion(process.env.MW_VERSION, readPackageVersion());
const APP_VERSION = APP.version;

/**
 * How often the push server checks each screen for changes.
 *
 * The wall polls every sixty seconds, so anything faster than that is pure win
 * on interrupt latency; five seconds keeps a tornado warning near-instant
 * without spinning. The tick returns immediately when nobody is connected, so
 * this costs nothing on a wall that never opens the socket.
 */
const PUSH_TICK_MS = 5_000;

/**
 * Start the boot holder: a separate process that owns the port and serves a
 * "booting" page while this process runs its (synchronous) migrations and
 * setup. It has to be a separate process — a single event loop cannot answer a
 * request while better-sqlite3 is mid-migration — and it is handed the port
 * back just before we bind, so nothing proxies in steady state.
 *
 * Purely additive. If it cannot spawn or cannot bind (a leftover already on the
 * port), it steps aside and boot proceeds exactly as it did before the holder
 * existed — the real server's own bind is still the one that reports a conflict.
 */
function startBootHolder(port: number): ChildProcess | undefined {
  try {
    const holderPath = fileURLToPath(new URL('./boot-holder.js', import.meta.url));
    const child = spawn(process.execPath, [holderPath, String(port)], { stdio: 'inherit' });
    // A spawn error (binary missing, permissions) must never take down boot.
    child.on('error', () => {});
    return child;
  } catch {
    return undefined;
  }
}

/**
 * Hand the port back from the holder, then wait for it to actually exit so the
 * socket is free before we bind. `SIGTERM` first; `SIGKILL` after a grace so a
 * holder that somehow will not close cannot leave us binding onto a held port
 * (which would exit the process). Resolves only on the child's real `exit`.
 */
async function stopBootHolder(holder: ChildProcess | undefined): Promise<void> {
  if (holder === undefined || holder.exitCode !== null || holder.killed) return;
  await new Promise<void>((resolve) => {
    holder.once('exit', () => resolve());
    // Exited between the check above and attaching the listener: don't wait for
    // an event that has already fired.
    if (holder.exitCode !== null) return resolve();
    holder.kill('SIGTERM');
    const force = setTimeout(() => {
      try {
        holder.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 1_500);
    force.unref();
  });
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

  // Hold the port with a "booting" page before anything blocking runs, so a
  // screen or a browser arriving during a restart gets a clear, self-refreshing
  // message instead of a connection refusal. Handed back just before we bind.
  const bootHolder = startBootHolder(port);
  if (bootHolder !== undefined) {
    // Never leave the holder serving "booting" forever if this process exits
    // before the handover — a fatal migration, a thrown boot. In a container
    // the stop kills it anyway; this covers a bare process too.
    process.once('exit', () => {
      try {
        bootHolder.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    });
  }

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
  if (master.unusableKeyWarning) {
    console.error(`[boot] ${master.unusableKeyWarning}`);
    notices.push({ level: 'error', code: 'key-unusable', message: master.unusableKeyWarning });
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
  /*
   * Migrate every wall off the retired "auto" stacked layout onto the Classic
   * free-form template, exactly once. Guarded by `layout_backfilled`, so a
   * household that has already been migrated (or has arranged its own canvas) is
   * left alone. Reuses `applyTemplate`, the tested transactional writer.
   */
  const setUp = householdSetUp(db);
  backfillClassic(db, setUp);
  /*
   * And move a wall that is *still exactly the one we seeded* onto the variant
   * matching what the household has set up now.
   *
   * A canvas is chosen once, at seeding, and a fresh install is seeded before
   * anybody has configured anything — so a location added a week later has
   * nowhere to be drawn, because the box was never placed. This re-makes that
   * choice, and only for a canvas that prints byte-identical to one this build
   * seeds. A wall somebody arranged matches nothing and is never written to.
   */
  reseedClassicForSetUp(db, setUp);

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
      /*
       * Third-party modules, all in one poll (docs/rfc-001-module-framework.md).
       *
       * One shared job rather than one per module: they are on the household's
       * own network, a handful at most, and a single pass keeps the scheduler
       * from filling with `ext:*` job rows. Each module's own failure is caught
       * inside and surfaced on its card; the wall keeps its calendar regardless.
       */
      'external-modules': async () => {
        await pollExternalModules(db, fetcher, keyring);
        return { status: 'ok' };
      },
      'update-check': async () => {
        if (!readUpdateState(db).enabled) return { status: 'ok' };
        /*
         * A build that is not a release has nothing to compare.
         *
         * `isNewer` reads `0.54.2-dev` as 0.54.2 and the latest release as
         * 0.54.2, so this would report "up to date" — right by luck, and wrong
         * the moment a checkout is behind or ahead of what is published. The
         * honest answer is that this question does not apply to a build nobody
         * released, and the settings page says so in place of the result.
         *
         * Nothing is recorded either: a stale `latestVersion` written here
         * would keep the phantom update on screen after the household stopped
         * being on a dev build.
         */
        if (!APP.isRelease) return { status: 'ok' };
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

  /*
   * Ask the supervisor where the wall actually lives, so a household does not
   * have to type it. On the add-on this fills in the mapped host port and the
   * box's address; on a plain `docker run` there is no supervisor and it returns
   * nothing, leaving the manual path exactly as it was. It cannot fail the boot
   * — every branch degrades to "unknown" — see the module.
   */
  const detection = await detectWallAddress(fetcher, process.env, port);
  const explicitBaseUrl = (process.env['BASE_URL'] ?? '').trim() !== '';
  if (!explicitBaseUrl && detection.baseUrl !== undefined) {
    console.log(`[boot] detected wall address ${detection.baseUrl}`);
  }
  if (detection.mappedPort === null) {
    console.log(
      '[boot] the wall display port is not mapped — turn it on in the add-on ' +
        'Network settings before pairing a screen',
    );
  }

  // Normalised rather than trusted: a bare IP is the obvious thing to type and
  // is not a URL, and passing it straight to Better Auth exits the process on
  // its first line — the refusal to start rule nine forbids. The detected
  // address is the fallback when nobody set one, in place of the old localhost
  // guess that is nowhere from a wall screen; an explicit BASE_URL still wins.
  const base = normalizeBaseUrl(
    process.env['BASE_URL'],
    detection.baseUrl ?? `http://localhost:${port}`,
  );
  const baseUrl = base.url;
  if (base.warning !== undefined) console.log(`[boot] ${base.warning}`);

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

  /*
   * The push server needs the very same per-screen manifest the poll route
   * builds. `createApp` hands it over here rather than us rebuilding it, so the
   * socket and the poll can never compute two different walls — the drift this
   * project keeps being bitten by, designed out rather than tested against.
   */
  let buildScreenManifest: ((screen: ScreenRow) => Manifest) | undefined;

  const app = createApp({
    db,
    appVersion: APP_VERSION,
    bootNotices: notices,
    auth: { secret: authSecret, baseUrl },
    keyring,
    fetcher,
    setupToken,
    dataDir: resolved,
    wallAddress: {
      detected: detection.baseUrl,
      portMapped: detection.mappedPort,
      explicit: explicitBaseUrl,
    },
    startedAt,
    log,
    onManifestBuilder: (build) => {
      buildScreenManifest = build;
    },
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

  // Take the port back from the holder and wait for it to release the socket,
  // then bind the real server. A brief gap here (holder closed, not yet bound)
  // is milliseconds against a multi-second boot.
  await stopBootHolder(bootHolder);
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });

  /*
   * The self-hosted push channel (RFC 003 §8). Optional everywhere: a wall that
   * never opens it still gets every interrupt on its sixty-second poll, so this
   * only shortens the gap between an alert landing and the wall reacting. No
   * cloud, no relay — the household's own server talking to its own screens.
   *
   * `buildScreenManifest` is set synchronously inside `createApp` above, so it
   * is defined by now; the guard is for the impossible case rather than a real
   * one, and keeps a socket from ever pushing an undefined wall.
   */
  const pushHub = new PushHub({
    screens: () => readScreens(db),
    evaluate: (screen) => {
      if (buildScreenManifest === undefined) {
        throw new Error('manifest builder not wired');
      }
      const manifest = buildScreenManifest(screen);
      return { etag: manifestEtag(manifest), interrupts: manifest.interrupts };
    },
    log: (message) => console.log(message),
  });

  /*
   * Route only `/d/push` into the hub; anything else upgrading is refused.
   *
   * A wall connects here with its display token — a cookie set at pairing, or a
   * bearer from the native app — exactly the credential the poll uses. Under
   * Home Assistant ingress `ingress_stream: true` is already set for this.
   */
  server.on?.('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      // A malformed request-target: refuse rather than guess.
    }
    if (pathname === PUSH_PATH) {
      pushHub.handleUpgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  /*
   * Every few seconds, push what changed. Far tighter than the sixty-second
   * poll — a tornado warning reaches the wall in seconds — and cheap: a
   * household has a handful of screens and the tick does nothing when none are
   * connected. Unref'd so it never holds the process open on its own.
   */
  const pushTimer = setInterval(() => pushHub.tick(), PUSH_TICK_MS);
  pushTimer.unref?.();

  /*
   * Advertise the wall on the LAN so the Android app finds it with no typed
   * address (RFC 003 §8). A convenience, never load-bearing — the app always
   * has manual host entry, so this only removes a step and can never brick a
   * wall (rule nine): `startMdnsAdvertiser` catches every failure and returns.
   *
   * The port advertised is the one a *screen* reaches, which is the mapped host
   * port under the add-on, not the container-internal one. When the supervisor
   * says that port is turned off (`mappedPort === null`) there is nothing
   * discoverable to point at, so we do not advertise a dead address; on a plain
   * `docker run` there is no supervisor and the listen port is the right answer.
   * `MDNS_DISABLE` turns it off for a household fronting the box with a proxy.
   */
  let mdns: MdnsHandle | undefined;
  const mdnsDisabled = env('MDNS_DISABLE', '') !== '';
  const advertisePort =
    detection.mappedPort === null
      ? undefined
      : typeof detection.mappedPort === 'number'
        ? detection.mappedPort
        : port;
  if (mdnsDisabled) {
    console.log('[mdns] disabled by MDNS_DISABLE');
  } else if (advertisePort === undefined) {
    console.log('[mdns] not advertising — the wall display port is turned off');
  } else {
    mdns = startMdnsAdvertiser({
      port: advertisePort,
      name: env('MDNS_NAME', MDNS_DEFAULT_NAME),
      version: APP_VERSION,
      log: (message) => console.log(message),
    });
  }

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
    clearInterval(pushTimer);
    // Close the sockets before the HTTP server, so a held-open push connection
    // is not what keeps `server.close` waiting.
    pushHub.close();
    // Withdraw the mDNS record so an app drops us promptly instead of waiting
    // out the TTL and offering a server that has gone.
    mdns?.stop();
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
  // Third-party module poll, registered always; does nothing when there are no
  // modules. Half a minute out so a restart never stampedes them.
  ensureJob(db, 'external-modules', 'external-modules', Date.now() + 30_000);
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

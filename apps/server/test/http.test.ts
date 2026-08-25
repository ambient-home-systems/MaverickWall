import { afterAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { createApp } from '../src/http/app.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { randomBytes } from 'node:crypto';

/**
 * The routes, exercised through Hono's fetch interface.
 *
 * Real routing, real status codes, real conditional requests — no network and
 * no browser. Anything that only works because a test reached inside the
 * handler would not be tested at all.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * `wrapDb` is how a test reaches the two catches on `/d/manifest`, and it is
 * deliberately the *app's* handle that is wrapped rather than the one the
 * harness seeds through: the fixture is written with a healthy database and
 * only the request meets the fault.
 */
function harness(wrapDb: (db: SqliteDatabase) => SqliteDatabase = (db) => db) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-http-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const now = Date.now();
  // A household that finished the wizard. Without `setup_completed_at` every
  // route here would answer with a redirect to `/setup`, which is the gate
  // doing its job rather than these routes misbehaving.
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'America/New_York', 'board', ?, ?, ?)`,
  ).run(now, now, now);

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('screen1', 'Kitchen', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, now, now, now);

  // Auth is required rather than defaulted: a fallback signing secret would be
  // a default credential, and rule ten says to assume this port is reachable.
  const app = createApp({
    db: wrapDb(db),
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'h'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    dataDir,
  });
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { headers }));

  return { db, app, call, token: issued.token, dataDir };
}

/**
 * A real `SqliteError`, produced by really scrambling a database.
 *
 * Corruption is the case the degraded manifest matters most for — an SD card
 * that came out of a power cut is persistent, unfixable from the wall, and
 * leaves no better data anywhere — and it is also the one that cannot be
 * induced through an open connection: SQLite serves the pages it already has.
 * So the *error* is genuine, written by better-sqlite3 reading a genuinely
 * malformed file, and only its delivery into the route is arranged. Inventing
 * an object with a `code` on it would be testing the test's idea of what
 * SQLite says.
 */
function realCorruptionError(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'mw-corrupt-'));
  roots.push(dir);
  const file = join(dir, 'wall.db');
  const seed = new Database(file);
  // Not WAL: the point is to scramble the pages the next reader will read.
  seed.pragma('journal_mode = DELETE');
  seed.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
  seed.close();
  const bytes = readFileSync(file);
  // Past the 100-byte header, so the file still opens and fails on its pages.
  bytes.fill(0xab, 100);
  writeFileSync(file, bytes);
  try {
    new Database(file).prepare('SELECT a FROM t').all();
  } catch (error) {
    return error;
  }
  throw new Error('the scrambled database read cleanly — this helper is not doing its job');
}

/**
 * A real `SqliteError` from a real lock.
 *
 * Two connections over one WAL file, the second holding a read snapshot that
 * the first then moves — which is what a CLI tool run against a household's
 * `DATA_DIR` does to a server mid-request. Taken from the real thing because
 * the *code* is the point: SQLite's extended one, which is not the primary
 * name anybody would write down from memory.
 */
function realBusyError(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'mw-busy-'));
  roots.push(dir);
  const file = join(dir, 'wall.db');
  const writer = new Database(file);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)');

  const reader = new Database(file);
  reader.pragma('busy_timeout = 0');
  reader.exec('BEGIN');
  reader.prepare('SELECT v FROM t').all();
  writer.exec('UPDATE t SET v = 2');
  try {
    reader.prepare('UPDATE t SET v = 3').run();
  } catch (error) {
    return error;
  } finally {
    reader.close();
    writer.close();
  }
  throw new Error('the contended write succeeded — this helper is not doing its job');
}

/**
 * A real `SqliteError` that is neither damage nor a lock.
 *
 * A write to a connection opened read-only. It stands for the whole open set
 * of codes SQLite can raise that this route has never been told about: what is
 * under test is the *default*, which has to be the answer that costs a wall
 * nothing.
 */
function realUnclassifiedError(): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'mw-ro-'));
  roots.push(dir);
  const file = join(dir, 'wall.db');
  const seed = new Database(file);
  seed.exec('CREATE TABLE t (v INTEGER)');
  seed.close();
  const readonly = new Database(file, { readonly: true });
  try {
    readonly.prepare('INSERT INTO t VALUES (1)').run();
  } catch (error) {
    return error;
  } finally {
    readonly.close();
  }
  throw new Error('the read-only write succeeded — this helper is not doing its job');
}

/**
 * The same database, with one query made to throw.
 *
 * The route has two catches and they cover different reads, so reaching either
 * one deliberately means choosing a statement rather than breaking the whole
 * connection. Everything else is delegated untouched, so the request is the
 * real one right up to the read under test.
 */
function dbWithFailingQuery(db: SqliteDatabase, matches: RegExp, error: unknown): SqliteDatabase {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'prepare' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string, ...rest: unknown[]) => {
        if (matches.test(sql)) throw error;
        return (value as (...args: unknown[]) => unknown).call(target, sql, ...rest);
      };
    },
  }) as SqliteDatabase;
}

/**
 * The same installation, with a clock that throws from a chosen call onwards.
 *
 * A stand-in for "something in the build threw that is not the database",
 * which is a class rather than a specific bug — and it is a *reachable* class,
 * so the clock here stands in for something real rather than for a
 * hypothetical. `formatterFor` in `packages/calendar` has no try/catch and
 * `readHousehold` returns the stored zone unvalidated, so a backup restored
 * onto a host with older ICU throws a code-less `RangeError` from inside the
 * build. `now` is injected because it is the one seam `createApp` already
 * offers into that code; what is under test is what the route does with the
 * exception, not where it came from. A plain `Error` is the point of it: it
 * carries no SQLite code, so the route must read it as ours.
 *
 * `failOnCall` picks which failure this is, and the numbers are measured
 * rather than guessed. A healthy request makes exactly two `now()` calls and
 * the first is before the build starts, so **2** breaks the build and leaves
 * the route's own fallback a working clock — which is the whole point of
 * throwing on that one call and no others. A clock that stays broken would
 * take the fallback down too, and then a 5xx proves nothing about the
 * narrowing: it is what a *wrongly* degraded request would answer as well.
 *
 * With `breakSchema` the build gets as far as that second call and *then*
 * fails on the missing column, and `degradedManifest` makes calls three and
 * four — so **3** is a database failure whose fallback is broken too, which is
 * the only way to reach the safety net's own catch.
 */
function harnessWithBrokenBuild(options: { failOnCall: number; breakSchema?: boolean }) {
  const { failOnCall, breakSchema = false } = options;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-http-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'America/New_York', 'board', ?, ?, ?)`,
  ).run(at, at, at);
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('screen1', 'Kitchen', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, at, at, at);

  if (breakSchema) {
    db.exec('ALTER TABLE household_settings DROP COLUMN layout_landscape_background');
  }

  let calls = 0;
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'h'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    dataDir,
    now: () => {
      calls += 1;
      if (calls === failOnCall) throw new Error('something in the build went wrong');
      return at;
    },
  });
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://localhost${path}`, { headers }));

  return { db, app, call, token: issued.token, dataDir };
}

describe('/healthz', () => {
  it('answers without a credential', async () => {
    // A monitoring check that needs a token is a monitoring check nobody sets
    // up. This is the endpoint a Docker healthcheck hits.
    const { call } = harness();
    const response = await call('/healthz');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['version']).toBe('0.1.0-test');
    expect(typeof body['serverTime']).toBe('number');
  });

  it('reveals nothing about the household', async () => {
    // It is unauthenticated, so it must not name calendars, people or screens.
    const { call } = harness();
    const text = await (await call('/healthz')).text();
    expect(text).not.toContain('Kitchen');
    expect(text).not.toContain('America/New_York');
  });

  it('reports the schema as migrated', async () => {
    const { call } = harness();
    const body = (await (await call('/healthz')).json()) as Record<string, number>;
    expect(body['schemaVersion']).toBeGreaterThan(0);
  });
});

describe('/d/manifest', () => {
  it('refuses an unpaired screen', async () => {
    const { call } = harness();
    expect((await call('/d/manifest')).status).toBe(401);
    expect((await call('/d/manifest', { authorization: 'Bearer nonsense' })).status).toBe(401);
  });

  it('serves a manifest to a paired screen', async () => {
    const { call, token } = harness();
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest['manifestVersion']).toBe(1);
    expect(manifest['timezone']).toBe('America/New_York');
    expect(Array.isArray(manifest['days'])).toBe(true);
    expect((manifest['days'] as unknown[]).length).toBeGreaterThan(30);
  });

  it('accepts the pairing cookie as well as a bearer token', async () => {
    // A kiosk browser loading / cannot set headers.
    const { call, token } = harness();
    const response = await call('/d/manifest', { cookie: `mw_display=${token}` });
    expect(response.status).toBe(200);
  });

  it('answers 304 when nothing has changed', async () => {
    const { call, token } = harness();
    const first = await call('/d/manifest', { authorization: `Bearer ${token}` });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await call('/d/manifest', {
      authorization: `Bearer ${token}`,
      'if-none-match': etag ?? '',
    });
    expect(second.status).toBe(304);
  });

  it('carries server time on a 304 as well as a 200', async () => {
    // Clock sync must not depend on the body being sent, or a display that is
    // correctly getting 304s would never correct its drift.
    const { call, token } = harness();
    const first = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(first.headers.get('x-server-time')).toBeTruthy();

    const second = await call('/d/manifest', {
      authorization: `Bearer ${token}`,
      'if-none-match': first.headers.get('etag') ?? '',
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('x-server-time')).toBeTruthy();
  });

  it('records when the screen was last seen', async () => {
    const { call, token, db } = harness();
    await call('/d/manifest', { authorization: `Bearer ${token}` });
    const screen = db.prepare("SELECT last_seen_at FROM screens WHERE id = 'screen1'").get() as {
      last_seen_at: number | null;
    };
    expect(screen.last_seen_at).toBeGreaterThan(0);
  });

  /*
   * Rule nine, for the poll a wall makes every thirty seconds (RFC 009, 1.9).
   *
   * Boot already continues past a failed or partial migration and pushes a
   * `ManifestNotice` explaining it — but `readScreens` is written against the
   * newest schema with no tolerance, so a database boot could not fully
   * upgrade threw before that notice ever reached a wall: `requireScreen`'s
   * unguarded read turned into an unhandled exception, and `app.onError` sent
   * back a bare JSON 500. Simulated here by dropping a column the query
   * needs, which is what a database stuck one migration behind actually
   * looks like.
   */
  it('degrades to a 200 carrying notices when the schema cannot be fully read', async () => {
    const { call, token, db } = harness();
    db.exec('ALTER TABLE screens DROP COLUMN layout_landscape_background');

    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest['manifestVersion']).toBe(1);
    expect(Array.isArray(manifest['days'])).toBe(true);
    const notices = manifest['notices'] as { level: string; code: string; message: string }[];
    expect(notices.some((n) => n.code === 'schema-degraded' && n.level === 'error')).toBe(true);
  });

  /*
   * A build that fails for any *other* reason must not blank the wall.
   *
   * The degraded manifest is the right answer for a database that could not be
   * read: there is no better data anywhere and the notice is what lets the
   * household read the reason. It is the wrong answer for everything else,
   * because it is a **200 carrying a valid, empty manifest** — which the
   * display accepts as `fresh`. So it does not merely blank the wall for one
   * poll: `main.ts` then awaits `store.save(...)`, overwriting the IndexedDB
   * last-good copy, so even a reload cannot get the calendar back. A 5xx costs
   * nothing at all — the display's `failed` branch deliberately keeps the last
   * manifest and never touches the store, and the banner says how old it is.
   */
  it('does not hand a wall an empty manifest when the build fails for another reason', async () => {
    const { call, token } = harnessWithBrokenBuild({ failOnCall: 2 });
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });

    expect(
      response.status,
      'a 200 here is a fresh manifest as far as the display is concerned',
    ).toBeGreaterThanOrEqual(500);

    /*
     * And the refusal has to be recognisable as *ours*.
     *
     * The display reads this header's presence to tell a reply from this
     * server apart from a captive portal's 200 or a proxy's own error page,
     * and that decides three things on the wall: whether it says "not reaching
     * the server", whether it advances its contact clock, and whether it arms
     * a two-hour watchdog against a server it is talking to every minute.
     * Dropping it here breaks all three silently and nothing else would fail,
     * because it is the *other* package that reads it.
     */
    expect(response.headers.get('x-server-time'), 'the mark a display looks for').not.toBeNull();

    // And specifically not a body a wall would draw over its own calendar.
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['manifestVersion'], 'nothing here may pass isRenderableManifest').toBeUndefined();
    expect(body['days']).toBeUndefined();
  });

  /*
   * And a schema failure that surfaces during the *build* still degrades.
   *
   * `readScreens` reads one table. A database stuck a migration behind can have
   * every column that query wants and be missing one the manifest needs, so the
   * partial-upgrade case reaches the second catch as often as the first — and
   * RFC 009 1.9's guarantee has to hold on both paths, or it holds by accident.
   */
  it('still degrades when the schema is what failed during the build', async () => {
    const { call, token, db } = harness();
    db.exec('ALTER TABLE household_settings DROP COLUMN layout_landscape_background');

    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);

    // Every answer this route gives carries the mark, the stand-in included:
    // a display reads its absence as "this did not come from my server".
    expect(response.headers.get('x-server-time'), 'the mark a display looks for').not.toBeNull();

    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest['manifestVersion']).toBe(1);
    const notices = manifest['notices'] as { level: string; code: string }[];
    expect(notices.some((n) => n.code === 'schema-degraded' && n.level === 'error')).toBe(true);
  });

  /*
   * And a database that is not merely behind — one that is scrambled.
   *
   * This is the case the degraded manifest matters most for and the one a
   * "missing column" reading of it silently excluded. An SD card that came out
   * of a power cut corrupt is exactly as persistent as a half-finished
   * migration, there is no better data anywhere, and a wall that has never
   * cached a manifest has nothing at all to fall back on — so answering 503
   * for ever would leave a freshly loaded screen on "waiting", with no cause
   * on it, reloading every ninety seconds until somebody unplugs it. That is
   * RFC 009 1.1's black screen wearing a different hat.
   */
  it('degrades for a database that is corrupt, not only for one that is behind', async () => {
    const corrupt = realCorruptionError();
    expect((corrupt as { code?: string }).code, 'the premise of this test').toBe('SQLITE_CORRUPT');

    // The screens read still works — that is the shape of a file whose damage
    // lands on some pages and not others, and it is what carries the request
    // as far as the build.
    const { call, token } = harness((db) => dbWithFailingQuery(db, /calendar_sources/, corrupt));
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    const manifest = (await response.json()) as Record<string, unknown>;
    const notices = manifest['notices'] as { level: string; code: string }[];
    expect(notices.some((n) => n.code === 'schema-degraded' && n.level === 'error')).toBe(true);
  });

  /*
   * And the screen-lookup catch is narrowed the same way the build's is.
   *
   * It covers `authenticateScreen` as well as the read, so it is not only a
   * database that can throw inside it — and a token the minimal lookup still
   * recognises would otherwise be answered with the same 200 empty manifest
   * that destroys a wall's cached copy. The asymmetry was an accident of
   * fixing one catch: the argument for narrowing is identical on both.
   */
  it('does not hand a wall an empty manifest when the screen read fails for a reason of ours', async () => {
    const ours = new Error('the screen row could not be assembled');
    // The full `readScreens` query and nothing else — the minimal fallback
    // lookup names only `token_hash`, so this screen is still recognised and
    // the request reaches the degrade decision rather than a 401.
    const { call, token } = harness((db) =>
      dbWithFailingQuery(db, /layout_landscape_background/, ours),
    );

    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status).toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['manifestVersion'], 'nothing here may pass isRenderableManifest').toBeUndefined();
    expect(body['error']).toBe('unavailable');
  });

  /*
   * And a lock is not damage, however SQLite spells it.
   *
   * `better-sqlite3` reports SQLite's *extended* code, so the family a lock
   * arrives as is wider than the primary name suggests: a WAL reader whose
   * snapshot moved under it — which is what a CLI tool run against the same
   * `DATA_DIR` looks like — raises `SQLITE_BUSY_SNAPSHOT`, saying "database is
   * locked". Treating that as damage would blank a wall and overwrite its
   * cached copy for something that clears itself in a second, which is the
   * whole fault this route was just narrowed against, arriving by the door
   * left open behind it. The error here is a real one, taken from two real
   * connections contending over a real WAL file.
   */
  it('keeps a wall drawing through a lock, which is not a database it cannot read', async () => {
    const busy = realBusyError();
    expect((busy as { code?: string }).code, 'the premise of this test').toMatch(/^SQLITE_BUSY/);
    expect((busy as { code?: string }).code, 'and it is an extended code, not the bare one').not.toBe(
      'SQLITE_BUSY',
    );

    const { call, token } = harness((db) => dbWithFailingQuery(db, /calendar_sources/, busy));
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });

    expect(response.status, 'a lock is temporary — the wall keeps what it has').toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['manifestVersion'], 'nothing here may pass isRenderableManifest').toBeUndefined();
  });

  /*
   * And a database this damaged must never tell a wall it is not paired.
   *
   * 401 is not a refusal as far as a display is concerned: it reads it as
   * `unpaired`, drops the manifest it is holding and draws the code-entry
   * form. So damage that reaches even the one-column fallback lookup — which
   * is what corruption looks like, rather than the partial damage the test
   * above arranges — would put a pairing form on every screen in the house.
   * The check did not run, so it may not say no.
   */
  it('says "not now" rather than "not paired" when the token check cannot run at all', async () => {
    const corrupt = realCorruptionError();
    const { call, token } = harness((db) => dbWithFailingQuery(db, /FROM screens/, corrupt));

    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    expect(response.status, 'a 401 here draws a pairing form over a working wall').toBe(503);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('unavailable');
  });

  /*
   * And a code this route has never heard of takes the cheap answer.
   *
   * The two answers are not equally cheap: degrading blanks a wall for that
   * poll, a 503 costs it nothing. So the classification is an allowlist — a
   * code has to be *known* persistent to buy the expensive answer — and this
   * is the assertion that keeps it one. Written the other way round, as
   * "everything degrades unless it is a lock", the next transient class
   * SQLite grows blanks every wall in the house until somebody notices.
   */
  it('keeps a wall drawing for a database error it has never been told about', async () => {
    const unclassified = realUnclassifiedError();
    expect((unclassified as { code?: string }).code).toBe('SQLITE_READONLY');

    const { call, token } = harness((db) => dbWithFailingQuery(db, /calendar_sources/, unclassified));
    const response = await call('/d/manifest', { authorization: `Bearer ${token}` });

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['manifestVersion'], 'nothing here may pass isRenderableManifest').toBeUndefined();
  });

  /*
   * And a safety net that can throw is not one.
   *
   * `degradedManifest` calls `now()` and `buildManifest`, so a failure systemic
   * enough to reach either takes the fallback down too — and the household then
   * gets Hono's bare JSON 500, which is the exact unhandled-exception shape
   * RFC 009 1.9 set out to remove, one layer further in. So this needs *both*
   * halves: a database failure, which is the only thing that reaches the
   * fallback at all, and a clock that is still broken when it gets there.
   *
   * The first version of this test had only the second half, and passed
   * without ever calling `degradedManifest` — the route answered 503 one
   * branch earlier and the assertions could not tell the difference. So the
   * log line is asserted too: it is the only evidence from outside that the
   * safety net was entered and caught, and without it this test goes on
   * passing if the call counts above ever drift.
   */
  it('answers "not now" rather than an unhandled 500 when the fallback fails too', async () => {
    const { call, token } = harnessWithBrokenBuild({ failOnCall: 3, breakSchema: true });
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    let response: Response;
    try {
      response = await call('/d/manifest', { authorization: `Bearer ${token}` });
    } finally {
      spy.mockRestore();
    }

    expect(
      logged.some((line) => line.includes('degraded manifest failed too')),
      'the fallback itself has to have been reached and caught, not skipped',
    ).toBe(true);

    expect(response.status).toBe(503);
    // Even here, where the clock is what failed: the stamp is read through a
    // guard precisely so the last-resort path cannot be taken down by it.
    expect(response.headers.get('x-server-time'), 'the mark a display looks for').not.toBeNull();

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toBe('unavailable');
    expect(
      body['message'],
      'and it says what the screen will do, not what the server could not',
    ).toContain('will try again shortly');
  });

  it('still refuses a request with no credential at all when the schema cannot be read', async () => {
    // The degrade path must not turn into an open door for the ordinary
    // case — an unpaired browser polling with nothing to present — which
    // needs no database read to refuse and so is never at the mercy of one.
    const { call, db } = harness();
    db.exec('ALTER TABLE screens DROP COLUMN layout_landscape_background');

    const response = await call('/d/manifest');
    expect(response.status).toBe(401);
  });

  it('still refuses a token nothing recognises when the schema cannot be fully read', async () => {
    // The degraded path is the benefit of the doubt for a *real* screen's
    // token, not an open door: a bearer value that matches no screen must
    // still be refused, even though the query that would normally prove
    // that is exactly the one that is failing.
    const { call, db } = harness();
    db.exec('ALTER TABLE screens DROP COLUMN layout_landscape_background');

    const response = await call('/d/manifest', { authorization: 'Bearer nonsense' });
    expect(response.status).toBe(401);
    /*
     * And a 401 carries the mark too, which is not decoration. It is the most
     * destructive answer a display acts on — the manifest is dropped, the
     * code-entry form goes up and latches — so the wall only obeys a 401 it can
     * tell came from its own server. Unmarked, this one would be read as a
     * hotel portal and ignored, and a revoked screen would go on drawing.
     */
    expect(response.headers.get('x-server-time'), 'the mark a display looks for').not.toBeNull();
  });
});

describe('/pair', () => {
  it('exchanges a token for a cookie and redirects', async () => {
    // So the token appears once at pairing and never again in a URL, a log, or
    // a browser history entry someone later screenshots.
    const { call, token } = harness();
    const response = await call(`/pair?token=${token}`);
    expect(response.status).toBe(302);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mw_display=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('rejects a token that matches no screen', async () => {
    const { call } = harness();
    expect((await call('/pair?token=nope')).status).toBe(401);
  });

  it('explains a link with no token in it', async () => {
    const { call } = harness();
    expect((await call('/pair')).status).toBe(400);
  });
});

describe('everything else', () => {
  it('serves something rather than nothing at the root', async () => {
    // A blank screen is the one outcome to avoid, even before the display
    // bundle exists.
    const { call } = harness();
    const response = await call('/');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Maverick Wall');
  });

  it('404s an unknown path without leaking anything', async () => {
    const { call } = harness();
    const response = await call('/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, string>;
    expect(body['error']).toBe('not-found');
  });
});

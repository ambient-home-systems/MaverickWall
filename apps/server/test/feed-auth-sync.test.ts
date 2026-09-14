import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDueJobs } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring, loadOrCreateMasterKey } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createIcsSyncHandler, AUTH_FAILURE_HOLD_SECONDS } from '../src/jobs/ics-sync.js';
import { createJobStore } from '../src/jobs/store.js';
import { JOB_TIMINGS } from '../src/jobs/scheduler.js';
import { updateSource } from '../src/api/queries.js';
import { redactLogText } from '../src/api/redact.js';

/**
 * Syncing a feed whose sign-in is refused.
 *
 * Against a real server rather than a stub outcome, because the two things
 * being asserted are both properties of a round trip: that the credential goes
 * out on the wire at all, and that the 401 that comes back does *not* take the
 * retry ladder.
 *
 * The password is one a person would choose — a word and a year — and that is
 * the point rather than colour. `looksLikeSecret` is tuned to catch a
 * *generated* token by vowel density, length and case-flips, and admits a real
 * miss rate on those; `Fluffy2019!` is not shaped like one at all and it has no
 * reason to catch it. So the no-password-in-logs guarantee cannot rest on the
 * redactor. It has to be **structural** — the password is never formatted into
 * a message in the first place — and the check has to be a grep for the literal
 * string rather than the redactor's opinion of it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TZ = 'Europe/London';
const USER = 'jane@example.com';
const PASSWORD = 'Fluffy2019!';
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64')}`;

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:one@test',
  'SUMMARY:Dentist',
  `DTSTART;VALUE=DATE:${stamp(3)}`,
  `DTEND;VALUE=DATE:${stamp(4)}`,
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

function stamp(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

const roots: string[] = [];
let server: Server;
let base = '';
/** Flipped to stand in for the household rotating their app password. */
let accepted = GOOD;
const sawAuthorization: (string | undefined)[] = [];

function serve(req: IncomingMessage, res: ServerResponse): void {
  sawAuthorization.push(req.headers.authorization);
  if (req.headers.authorization !== accepted) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
    res.end('Unauthorized');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/calendar' });
  res.end(ICS);
}

beforeAll(async () => {
  server = createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-feedauth-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const keyring = createKeyring(loadOrCreateMasterKey(dataDir).key);
  const url = `${base}/cal.ics`;
  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, url_encrypted, url_host, allow_loopback, allow_http,
        auth_username, auth_password_encrypted, created_at, updated_at)
     VALUES ('src1', 'Nextcloud', ?, '127.0.0.1', 1, 1, ?, ?, 0, 0)`,
  ).run(
    keyring.encrypt(url, 'calendar-source-url'),
    USER,
    keyring.encrypt(PASSWORD, 'feed-password'),
  );
  db.prepare(
    `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
     VALUES ('ics-sync:src1', 'ics-sync', 0, 0, 0, 0)`,
  ).run();

  const handler = createIcsSyncHandler({ db, fetcher: createFetcher(), keyring, timezone: () => TZ });
  const store = createJobStore(db);

  /** One real scheduler tick, so `next_run_at` is written by the policy rather than by us. */
  const tick = async (now: number) =>
    runDueJobs({
      store,
      handlers: { 'ics-sync': handler },
      timings: JOB_TIMINGS,
      now,
      // Fixed, so the jitter cannot make an assertion about an interval flaky.
      random: () => 0.5,
    });

  const job = () =>
    db.prepare(`SELECT * FROM job_state WHERE key = 'ics-sync:src1'`).get() as Record<string, unknown>;
  const source = () =>
    db.prepare(`SELECT * FROM calendar_sources WHERE id = 'src1'`).get() as Record<string, unknown>;
  const events = () =>
    db.prepare('SELECT title FROM calendar_events_cache').all() as { title: string }[];

  return { db, keyring, tick, job, source, events };
}

describe('a feed whose sign-in is refused', () => {
  it('signs in, and keeps yesterday’s calendar when the password stops working', async () => {
    accepted = GOOD;
    const h = harness();
    sawAuthorization.length = 0;

    const at = Date.now();
    await h.tick(at);
    // The credential really went out — the half a stub cannot see.
    expect(sawAuthorization).toEqual([GOOD]);
    expect(h.events().map((row) => row.title)).toEqual(['Dentist']);

    // The household rotates their app password and has not told us yet.
    accepted = 'Basic somethingelse';
    const second = at + 60 * 60_000;
    await h.tick(second);

    // Rule nine: the wall keeps the calendar it already had.
    expect(h.events().map((row) => row.title)).toEqual(['Dentist']);
    expect(h.source()['event_count']).toBe(1);

    // And the sentence names the fix rather than leaving "401" to speak.
    const error = h.source()['last_error'] as string;
    expect(error).toContain('Enter a new one on the Calendars page.');
    // The username, which is already on the settings row and is often the whole
    // diagnosis — a feed signing in as the wrong account looks identical to one
    // signing in with the wrong password.
    expect(error).toContain(USER);
  });

  it('does not come back at the ordinary interval', async () => {
    accepted = 'Basic nobody';
    const h = harness();
    const at = Date.now();
    await h.tick(at);

    const nextRunAt = h.job()['next_run_at'] as number;
    const waitMs = nextRunAt - at;

    /*
     * The ordinary ladder would have this back inside the hour. That is not a
     * retry, it is a wrong password on a fixed interval against the household's
     * own server — Nextcloud's brute-force protection and Apple's CalDAV
     * lockout both count exactly that.
     */
    expect(waitMs).toBeGreaterThan(JOB_TIMINGS['ics-sync']!.backoffMaxMs!);
    expect(waitMs).toBeGreaterThanOrEqual(AUTH_FAILURE_HOLD_SECONDS * 1000);
  });

  it('comes back as soon as the password is edited', async () => {
    accepted = 'Basic nobody';
    const h = harness();
    const at = Date.now();
    await h.tick(at);
    expect(h.job()['next_run_at'] as number).toBeGreaterThan(at);

    /*
     * The other half of the hold, and the half that makes it a hold rather
     * than a wall: entering a new password is what recovers this, so it has to
     * be what re-arms the job. Without it a household fixes their password and
     * watches nothing happen for a week.
     */
    const sealed = h.keyring.encrypt('new-app-password', 'feed-password');
    accepted = `Basic ${Buffer.from(`${USER}:new-app-password`, 'utf8').toString('base64')}`;
    updateSource(h.db, 'src1', {
      name: 'Nextcloud',
      color: '#4C7FD1',
      personId: null,
      enabled: true,
      showInGrid: true,
      allowPrivateNetwork: false,
      allowLoopback: true,
      allowHttp: true,
      authPasswordEncrypted: sealed,
    });
    expect(h.job()['next_run_at']).toBe(0);
    // Failures reset too, or the next tick would resume the backoff ladder
    // partway up for a credential that is now correct.
    expect(h.job()['consecutive_failures']).toBe(0);

    await h.tick(at + 1000);
    expect(h.source()['last_error']).toBe(null);
    expect(h.events().map((row) => row.title)).toEqual(['Dentist']);
  });

  it('does not drag a sync forward when nothing about the credential changed', async () => {
    // Saving a colour is not a credential change, and a screen full of
    // calendars saved one at a time would otherwise be a self-inflicted
    // hammering of whatever they point at.
    accepted = GOOD;
    const h = harness();
    const at = Date.now();
    await h.tick(at);
    const before = h.job()['next_run_at'] as number;

    updateSource(h.db, 'src1', {
      name: 'Nextcloud',
      color: '#AA3311',
      personId: null,
      enabled: true,
      showInGrid: true,
      allowPrivateNetwork: false,
      allowLoopback: true,
      allowHttp: true,
    });
    expect(h.job()['next_run_at']).toBe(before);
    // And an absent password field leaves the stored one exactly where it was,
    // which is §4.5's whole reading of "I did not touch this field".
    expect(h.source()['auth_password_encrypted']).not.toBe(null);
    expect(h.source()['auth_username']).toBe(USER);
  });

  it('removes the password when the household asks, and only then', async () => {
    accepted = GOOD;
    const h = harness();
    updateSource(h.db, 'src1', {
      name: 'Nextcloud',
      color: '#4C7FD1',
      personId: null,
      enabled: true,
      showInGrid: true,
      allowPrivateNetwork: false,
      allowLoopback: true,
      allowHttp: true,
      authUsername: null,
      authPasswordEncrypted: null,
    });
    expect(h.source()['auth_password_encrypted']).toBe(null);
    expect(h.source()['auth_username']).toBe(null);

    // And the feed now signs in as nobody, which is the request the server sees.
    sawAuthorization.length = 0;
    await h.tick(Date.now());
    expect(sawAuthorization).toEqual([undefined]);
  });
});

describe('the password itself', () => {
  it('reaches no log line and no text column, as a literal string', async () => {
    /*
     * The structural guarantee, checked as a grep rather than through the
     * redactor. `looksLikeSecret` has no reason to catch `Fluffy2019!` — it is
     * a word and a year, not a generated token — so a guarantee resting on the
     * redactor would be a guarantee resting on nothing for exactly the
     * passwords people actually choose.
     */
    accepted = 'Basic nobody';
    const h = harness();

    const lines: string[] = [];
    await h.tick(Date.now());

    // Whatever the sync had to say about the failure, in both forms: raw, and
    // through the redactor, because the redactor cannot be the thing that saves
    // this and must not be the thing that hides a failure to save it.
    lines.push(String(h.source()['last_error'] ?? ''));
    lines.push(String(h.job()['last_error'] ?? ''));
    for (const line of [...lines]) lines.push(redactLogText(line));

    for (const line of lines) {
      expect(line).not.toContain(PASSWORD);
      // Not the encoded form either: a base64 `authorization` value in a log
      // is the password with an extra step.
      expect(line).not.toContain(Buffer.from(PASSWORD, 'utf8').toString('base64'));
      expect(line).not.toContain(GOOD.slice('Basic '.length));
    }

    // Every text column in every table, which is the half a message-by-message
    // review cannot cover: the leak that matters is the one nobody thought to
    // look at.
    const tables = (
      h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((row) => row.name);
    let scanned = 0;
    for (const table of tables) {
      if (table.startsWith('sqlite_')) continue;
      for (const row of h.db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          scanned++;
          // The envelope is the one place it is allowed to be, and it is
          // ciphertext there — which this assertion proves rather than assumes.
          expect(value, `${table}.${column}`).not.toContain(PASSWORD);
        }
      }
    }
    // A scan of nothing passes; this says the scan actually ran.
    expect(scanned).toBeGreaterThan(3);
  });
});

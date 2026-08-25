import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, databasePath, backupTo } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring, loadOrCreateMasterKey } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createLogBuffer } from '../src/logbuffer.js';
import { buildDiagnostics } from '../src/api/diagnostics.js';
import { applyStagedRestore, stagedKeyPath, stagedPath } from '../src/db/restore.js';
import { addCalendarSource } from '../src/api/sources.js';
import { createIcsSyncHandler } from '../src/jobs/ics-sync.js';
import { checkForUpdate, isNewer } from '../src/api/update-check.js';
import { readUpdateState, recordUpdateCheck, setUpdateCheckEnabled } from '../src/api/queries.js';
import type { FetchOutcome, Fetcher, JobRecord } from '@maverick-wall/core';

/** A fetcher that answers once with whatever the test wants, and never leaves. */
function stubFetcher(outcome: FetchOutcome): Fetcher {
  return { fetch: async () => outcome };
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;
afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Maverick Wall//test//EN',
  'BEGIN:VEVENT',
  'UID:restore-1@example.com',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260715T140000Z',
  'DTEND:20260715T150000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** A real feed on a real socket, the one thing a stub cannot exercise. */
async function icsServer(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/calendar' });
    response.end(FEED);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/feed.ics`;
}

/** A household with things in it that must never leave the house. */
function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-sys-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'Europe/London', 'board', ?, ?, ?)`,
  ).run(at, at, at);
  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, url_encrypted, url_host, created_at, updated_at)
     VALUES ('s1', 'Mum''s work rota', 'mw1.SUPERSECRETCIPHERTEXT', 'calendar.google.com', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO calendar_events_cache
       (id, source_id, uid, title, starts_at, ends_at, start_local_date, end_local_date,
        source_tzid, synced_at)
     VALUES ('e1', 's1', 'u1', 'Divorce lawyer', ?, ?, '2026-08-05', '2026-08-05', 'UTC', ?)`,
  ).run(at, at + 3_600_000, at);
  db.prepare(
    `INSERT INTO people (id, name, color, created_at, updated_at) VALUES ('p1', 'Ellie', '#fff', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1', 'Household', 'private.person@example.com', 0, ?, ?)`,
  ).run(at, at);

  const log = createLogBuffer();
  const app = createApp({
    db,
    appVersion: '9.9.9-test',
    bootNotices: [],
    auth: { secret: 's'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.3.0.${++nextAddress}`,
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
    startedAt: at - 120_000,
    log,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  return { db, dataDir, log, call, jar, at };
}

async function signedIn(h: ReturnType<typeof harness>) {
  // The account already exists, so sign in rather than through the wizard.
  h.db.prepare('DELETE FROM user').run();
  await h.call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'f@h.local', password: 'correct-horse-battery', name: 'F' }),
  });
  return h;
}

describe('diagnostics', () => {
  it('carries nothing that belongs to the household', async () => {
    // The whole value of this file is that it can be handed over without
    // thinking. This test is the feature.
    const h = harness();
    const report = buildDiagnostics({
      db: h.db,
      appVersion: '9.9.9-test',
      startedAt: h.at - 1000,
      now: h.at,
      log: h.log.lines(),
      databaseSizeBytes: 1234,
    });
    const text = JSON.stringify(report);

    expect(text).not.toContain('SUPERSECRETCIPHERTEXT');
    expect(text).not.toContain('Divorce lawyer');
    expect(text).not.toContain('private.person@example.com');
    expect(text).not.toContain("Mum's work rota");
    expect(text).not.toContain('Ellie');
    // The host is the one thing kept, because a failing feed fails at a host.
    expect(text).toContain('calendar.google.com');
  });

  it('carries what a bug report actually needs', async () => {
    const h = harness();
    h.log.record('error', 'ics-sync failed for calendar.google.com');
    const report = buildDiagnostics({
      db: h.db, appVersion: '9.9.9-test', startedAt: h.at - 60_000, now: h.at,
      log: h.log.lines(), databaseSizeBytes: 4096,
    });

    expect(report.appVersion).toBe('9.9.9-test');
    expect(report.uptimeSeconds).toBe(60);
    expect(report.database.integrityOk).toBe(true);
    expect(report.counts).toMatchObject({ calendars: 1, events: 1, people: 1, users: 1 });
    expect(report.sources[0]).toMatchObject({ host: 'calendar.google.com', eventCount: 0 });
    expect(report.log.map((line) => line.text)).toContain('ics-sync failed for calendar.google.com');
  });

  it('downloads as a file behind the session gate', async () => {
    const h = await signedIn(harness());
    const response = await h.call('/admin/system/diagnostics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('diagnostics');

    h.jar.clear();
    expect((await h.call('/admin/system/diagnostics')).status).toBe(302);
  });
});

describe('backup', () => {
  it('downloads a real SQLite file that opens', async () => {
    const h = await signedIn(harness());
    const response = await h.call('/admin/system/backup');
    expect(response.status).toBe(200);

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    // The point of a backup is that it opens somewhere else.
    const elsewhere = mkdtempSync(join(tmpdir(), 'mw-restore-'));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, 'wall.db'), bytes);
    const reopened = openDatabase({ dataDir: elsewhere });
    expect(
      reopened.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get(),
    ).toEqual({ n: 1 });
    reopened.db.close();
  });

  it('offers the key separately, because it is a credential', async () => {
    const h = await signedIn(harness());
    writeFileSync(join(h.dataDir, '.secret'), randomBytes(32));

    const response = await h.call('/admin/system/key');
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(32);

    // And the page says so rather than leaving somebody to work it out.
    const page = await (await h.call('/admin/system')).text();
    expect(page).toContain('credential');
    expect(page).toContain('never attach it to a support request');
  });
});

describe('restore', () => {
  it('refuses a file that is not a database', async () => {
    const h = await signedIn(harness());
    const form = new FormData();
    form.set('backup', new File([Buffer.from('this is a photo of a cat')], 'cat.jpg'));

    const response = await h.call('/admin/system/restore', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect(existsSync(stagedPath(h.dataDir))).toBe(false);
  });

  it('stages a real backup rather than applying it live', async () => {
    // Swapping the file under a process that has it open, mid-sync, is how a
    // restore turns into a corruption.
    const h = await signedIn(harness());
    const backup = Buffer.from(await (await h.call('/admin/system/backup')).arrayBuffer());

    const form = new FormData();
    form.set('backup', new File([backup], 'wall.db'));
    const response = await h.call('/admin/system/restore', { method: 'POST', body: form });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Restart');
    expect(existsSync(stagedPath(h.dataDir))).toBe(true);
    // The live database is untouched until boot applies it.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 1 });
  });

  it('applies at boot and keeps the database it replaced', async () => {
    const h = harness();
    h.db.close();

    const marker = mkdtempSync(join(tmpdir(), 'mw-src-'));
    roots.push(marker);
    const other = openDatabase({ dataDir: marker });
    runMigrations(other.db, { dataDir: marker, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    other.db.prepare(
      `INSERT INTO people (id, name, color, created_at, updated_at) VALUES ('x', 'Restored', '#fff', 1, 1)`,
    ).run();
    other.db.close();
    writeFileSync(stagedPath(h.dataDir), readFileSync(databasePath(marker)));

    const outcome = applyStagedRestore(h.dataDir);
    expect(outcome.status).toBe('restored');
    expect(existsSync(stagedPath(h.dataDir))).toBe(false);
    // Frightening and reversible, rather than frightening and final.
    expect(existsSync((outcome as { keptAt: string }).keptAt)).toBe(true);

    const reopened = openDatabase({ dataDir: h.dataDir });
    expect(reopened.db.prepare('SELECT name FROM people').get()).toEqual({ name: 'Restored' });
    reopened.db.close();
  });

  it('does nothing when nothing is staged', () => {
    const h = harness();
    expect(applyStagedRestore(h.dataDir).status).toBe('none');
  });

  it('sets an empty staged file aside rather than destroying the database', () => {
    const h = harness();
    writeFileSync(stagedPath(h.dataDir), '');
    expect(applyStagedRestore(h.dataDir).status).toBe('failed');
    expect(statSync(databasePath(h.dataDir)).size).toBeGreaterThan(0);
  });

  /*
   * End to end (RFC 009, 1.6): back up, wipe, restore both files, and a feed
   * still syncs.
   *
   * The database alone is not a backup — the feed address is encrypted, and
   * without the matching key it comes back as ciphertext nothing can read.
   * Before this fix there was nowhere to upload the key at all, so this is
   * the scenario that was previously impossible.
   */
  it('restores the key alongside the database, and a feed decrypts and syncs again', async () => {
    const original = mkdtempSync(join(tmpdir(), 'mw-restore-orig-'));
    roots.push(original);
    const { db: originalDb } = openDatabase({ dataDir: original });
    runMigrations(originalDb, { dataDir: original, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

    // A real master key, persisted to disk exactly as boot creates one — not
    // the harness's disk-detached random keyring above, because this test is
    // about whether the *file* System → Backup hands over is the one that
    // decrypts what System → Backup also hands over.
    const originalKeyring = createKeyring(loadOrCreateMasterKey(original).key);

    const feedUrl = await icsServer();
    const added = addCalendarSource(originalDb, originalKeyring, {
      name: 'Family', url: feedUrl, allowLoopback: true, allowHttp: true,
    });
    if (!added.ok) throw new Error(added.message);

    // Proves the source is real and reachable before anything is backed up —
    // otherwise a restore that "does nothing" and a restore of a feed that
    // never worked look identical.
    const firstSync = createIcsSyncHandler({
      db: originalDb, fetcher: createFetcher(), keyring: originalKeyring, timezone: () => 'UTC',
    });
    const job: JobRecord = {
      key: `ics-sync:${added.id}`, kind: 'ics-sync', nextRunAt: 0, consecutiveFailures: 0,
    };
    expect(await firstSync(job)).toMatchObject({ status: 'ok' });
    expect(
      originalDb.prepare('SELECT COUNT(*) AS n FROM calendar_events_cache').get(),
    ).toEqual({ n: 1 });

    // The two downloads System → Backup offers, captured the same way the
    // real endpoints produce them.
    const backupPath = join(original, 'snapshot.db');
    backupTo(originalDb, backupPath);
    const backupBytes = readFileSync(backupPath);
    const keyBytes = readFileSync(join(original, '.secret'));
    originalDb.close();

    // The wipe: a household onto a fresh install, or a fresh volume — not the
    // same directory, so there is no question of anything surviving by
    // accident.
    const fresh = mkdtempSync(join(tmpdir(), 'mw-restore-fresh-'));
    roots.push(fresh);
    writeFileSync(stagedPath(fresh), backupBytes);
    writeFileSync(stagedKeyPath(fresh), keyBytes, { mode: 0o600 });

    const outcome = applyStagedRestore(fresh);
    expect(outcome.status).toBe('restored');
    expect(existsSync(stagedPath(fresh))).toBe(false);
    expect(existsSync(stagedKeyPath(fresh))).toBe(false);

    const restoredMaster = loadOrCreateMasterKey(fresh);
    expect(restoredMaster.key.equals(keyBytes)).toBe(true);
    const restoredKeyring = createKeyring(restoredMaster.key);

    const { db: restoredDb } = openDatabase({ dataDir: fresh });
    // A fresh sync, on the restored database with the restored keyring —
    // this is the assertion that matters: the feed address decrypted, and
    // the feed synced, not merely that a file exists on disk.
    const secondSync = createIcsSyncHandler({
      db: restoredDb, fetcher: createFetcher(), keyring: restoredKeyring, timezone: () => 'UTC',
    });
    const result = await secondSync({ ...job, nextRunAt: 0, consecutiveFailures: 0 });
    expect(result).toMatchObject({ status: 'ok' });
    expect(
      restoredDb.prepare('SELECT COUNT(*) AS n FROM calendar_events_cache').get(),
    ).toEqual({ n: 1 });
    restoredDb.close();
  });
});

describe('the log tail', () => {
  it('keeps the newest lines and drops the oldest', () => {
    const log = createLogBuffer(3);
    for (const text of ['one', 'two', 'three', 'four']) log.record('info', text);
    expect(log.lines().map((line) => line.text)).toEqual(['two', 'three', 'four']);
  });

  it('captures console without swallowing it', () => {
    // Somebody with a terminal should not lose output just because somebody
    // else can now read it in a browser.
    const log = createLogBuffer();
    const seen: unknown[][] = [];
    const fake = {
      log: (...args: unknown[]) => seen.push(args),
      warn: () => {},
      error: () => {},
    };
    log.capture(fake);
    fake.log('[boot] listening on 8080');

    expect(log.lines().map((line) => line.text)).toContain('[boot] listening on 8080');
    expect(seen).toHaveLength(1);
  });

  it('shows on the system page', async () => {
    const h = await signedIn(harness());
    h.log.record('warn', 'a feed is failing');
    expect(await (await h.call('/admin/system')).text()).toContain('a feed is failing');
  });
});

describe('the update check', () => {
  it('compares versions the way release tags are actually written', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
    // A pre-release suffix is ignored rather than ordered.
    expect(isNewer('v0.2.0-rc1', '0.1.0')).toBe(true);
    expect(isNewer('not-a-version', '0.1.0')).toBe(false);
  });

  it('reads a release feed and reports what it found', async () => {
    const fetcher = stubFetcher({
      status: 'ok', contentType: 'application/json', finalUrl: 'x', byteSize: 10,
      body: JSON.stringify({ tag_name: 'v0.4.0' }),
    });
    expect(await checkForUpdate(fetcher, '0.1.0', 'https://example.test/r')).toEqual({
      status: 'ok', latest: 'v0.4.0', newer: true,
    });
  });

  it('does not tell a kitchen about a draft or a pre-release', async () => {
    for (const flag of [{ draft: true }, { prerelease: true }]) {
      const fetcher = stubFetcher({
        status: 'ok', contentType: 'application/json', finalUrl: 'x', byteSize: 10,
        body: JSON.stringify({ tag_name: 'v9.9.9', ...flag }),
      });
      const result = await checkForUpdate(fetcher, '0.1.0', 'https://example.test/r');
      expect(result).toMatchObject({ status: 'ok', newer: false });
    }
  });

  it('explains a failure in words rather than a code', async () => {
    // `dns-failed` is a *rejection*: the guard never got a packet out. Getting
    // that wrong here is only visible now the tests are typechecked.
    const fetcher = stubFetcher({ status: 'rejected', code: 'dns-failed', message: 'ENOTFOUND' });
    const result = await checkForUpdate(fetcher, '0.1.0', 'https://example.test/r');
    expect(result.status).toBe('failed');
    expect((result as { message: string }).message).toContain('no internet access');
  });

  it('survives a reply that is not a release', async () => {
    const fetcher = stubFetcher({
      status: 'ok', contentType: 'application/json', finalUrl: 'x', byteSize: 4, body: 'null',
    });
    expect((await checkForUpdate(fetcher, '0.1.0', 'https://example.test/r')).status).toBe('failed');
  });
});

describe('the update check setting', () => {
  it('is off on a fresh household, and says so plainly', async () => {
    const h = await signedIn(harness());
    expect(readUpdateState(h.db).enabled).toBe(false);

    const page = await (await h.call('/admin/system')).text();
    expect(page).toContain('does not contact anyone unless you switch this on');
    expect(page).toContain('Off. Maverick Wall is not contacting anyone.');
  });

  it('names the host, what leaks, and what it will never do', async () => {
    // The disclosure is the feature. Somebody should be able to decide from
    // this paragraph without trusting whoever wrote it.
    const h = await signedIn(harness());
    const page = await (await h.call('/admin/system')).text();

    expect(page).toContain('api.github.com');
    expect(page).toContain("your home's IP address");
    expect(page).toContain('There is no identifier and no ');
    expect(page).toContain('download or install anything');
  });

  it('switching it on does not itself make a request', async () => {
    // Consent and an outbound request in the same click would mean somebody
    // exploring the settings contacts a third party before reading the switch.
    const h = await signedIn(harness());
    await h.call('/admin/system/updates', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'update_check_enabled=1',
    });

    expect(readUpdateState(h.db).enabled).toBe(true);
    expect(readUpdateState(h.db).lastCheckedAt).toBeNull();
  });

  it('refuses to check while it is switched off', async () => {
    const h = await signedIn(harness());
    const response = await h.call('/admin/system/check-now', { method: 'POST' });
    expect(response.status).toBe(400);
    expect(readUpdateState(h.db).lastCheckedAt).toBeNull();
  });

  it('lists a stored zone this build’s Intl has never heard of', async () => {
    /*
     * A database restored from an image with different tzdata — or one running
     * the ten-zone fallback used when `Intl.supportedValuesOf` is missing — can
     * hold a zone the offered list does not contain. Listing only the offered
     * ones leaves *nothing* selected; the browser picks whatever sorts first
     * (`Africa/Abidjan`), `looksEdited` correctly reports a form that differs
     * from its markup, and one press of the now-live Save re-anchors every
     * all-day event and the whole shift rotation to west Africa.
     */
    const h = await signedIn(harness());
    h.db
      .prepare(`UPDATE household_settings SET timezone = 'Mars/Olympus_Mons' WHERE id = 'singleton'`)
      .run();
    const html = await (await h.call('/admin/system')).text();

    const selected = [...html.matchAll(/<option value="([^"]+)" selected>/g)].map((m) => m[1]);
    expect(selected, 'exactly one, and it is the household’s own zone').toEqual([
      'Mars/Olympus_Mons',
    ]);

    // And the handler accepts what the page offered. A list drawing an option
    // the endpoint refuses would answer "Choose a timezone from the list"
    // about something that is on the list.
    const kept = await h.call('/admin/system/timezone', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'timezone=Mars%2FOlympus_Mons',
    });
    expect(kept.status).toBe(302);
    expect(kept.headers.get('location')).toBe('/admin/system?saved=timezone');
  });

  it('keeps the stored zone selected when it refuses a choice', async () => {
    /*
     * A closed list is not a text field, and echoing a rejected value back into
     * one is worse than not echoing at all: the value reaches that branch
     * *because* it is not offered, so nothing is `selected` and the browser
     * preselects whatever sorts first — `Africa/Abidjan` — with a live Save
     * over it. One press and the household's timezone is silently somewhere in
     * west Africa. `setup.ts`'s `detectedTimezoneOption` already says never
     * "nothing"; this is the same rule on the other screen.
     */
    const h = await signedIn(harness());
    const refused = await h.call('/admin/system/timezone', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'timezone=Mars%2FOlympus_Mons',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('Choose a timezone from the list');

    const selected = [...html.matchAll(/<option value="([^"]+)" selected>/g)].map((m) => m[1]);
    expect(selected, 'exactly one zone selected, and it is the stored one').toEqual([
      'Europe/London',
    ]);
    // And the form is honestly clean: the select shows what is stored, so there
    // is nothing unsaved and Save says so.
    expect(html).not.toContain('data-dirty="dirty"');
  });

  it('does not draw a green "checked" strip over a red "check failed"', async () => {
    /*
     * A check that could not reach the host is not a thing that happened. The
     * page already answers that case properly — `updateSection()` draws
     * "Last check failed: …" in the danger box — so an ok-coloured
     * "Checked for a newer version." above it is the confirmation strip
     * contradicting the page it sits on.
     *
     * Asserted as a *correspondence* rather than by forcing a failure: whether
     * this box can reach api.github.com is not this test's business (a CI
     * runner behind a proxy can, a developer offline cannot), and a test that
     * assumed either would be green for the wrong reason on the other. The
     * property is that the token follows the outcome.
     */
    const h = await signedIn(harness());
    setUpdateCheckEnabled(h.db, true);
    const response = await h.call('/admin/system/check-now', { method: 'POST' });
    expect(response.status).toBe(302);

    const failed = readUpdateState(h.db).lastError !== null;
    expect(
      response.headers.get('location'),
      failed ? 'a failed check must claim nothing' : 'a check that worked should say so',
    ).toBe(failed ? '/admin/system' : '/admin/system?saved=update-checked');
  });

  it('forgets what it found when it is switched off', async () => {
    const h = await signedIn(harness());
    setUpdateCheckEnabled(h.db, true);
    recordUpdateCheck(h.db, h.at, 'v9.9.9', null);
    expect(readUpdateState(h.db).latestVersion).toBe('v9.9.9');

    setUpdateCheckEnabled(h.db, false);
    const after = readUpdateState(h.db);
    expect(after.enabled).toBe(false);
    expect(after.latestVersion).toBeNull();
    expect(after.lastCheckedAt).toBeNull();
  });

  it('says a newer version exists without pretending to install it', async () => {
    const h = await signedIn(harness());
    setUpdateCheckEnabled(h.db, true);
    // The harness reports 9.9.9-test, so the offered version has to beat it.
    recordUpdateCheck(h.db, h.at, 'v10.0.0', null);

    const page = await (await h.call('/admin/system')).text();
    expect(page).toContain('Version v10.0.0 is available');
    expect(page).toContain('Nothing has been ');
  });
});

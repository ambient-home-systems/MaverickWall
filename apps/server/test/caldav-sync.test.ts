import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring, loadOrCreateMasterKey } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { createCaldavSyncHandler } from '../src/jobs/caldav-sync.js';
import {
  addCaldavCalendar,
  createCaldavAccount,
  removeCaldavAccount,
  removeCaldavCalendar,
  rotateCaldavPassword,
} from '../src/api/caldav-accounts.js';
import { startCalDavFake, type CalDavFake } from './caldav-fake.js';

/**
 * The CalDAV sync, against a real server on loopback (RFC 013 §6.5, §6.6, §11).
 *
 * A real `node:http` server and the real `createFetcher`, so the SSRF guard,
 * the method allowlist and the byte ceiling are all on the path — §11's
 * complaint about a stub that answers 200 with a fixture is that it proves
 * nothing about any of them, and that applies to a sync exactly as it applies
 * to discovery.
 *
 * The assertions that matter are the two the section names: **one malformed
 * resource costs one event**, and **three calendars on one account all survive
 * a password change**. The second is the entire argument of §6.2.1 — under a
 * flat scheme it fails on two of the three, so it is the test that would have
 * to be deleted rather than adjusted if somebody later flattened the schema.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TZ = 'America/New_York';
const USERNAME = 'jane@example.org';
const PASSWORD = 'app-specific-pw';
const credentialFor = (password: string): string =>
  `Basic ${Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64')}`;

const roots: string[] = [];
const servers: CalDavFake[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** One whole `VCALENDAR`, the way a CalDAV resource actually arrives. */
function resource(href: string, uid: string, summary: string, day: string): string {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${nextDay(day)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return (
    ` <d:response>\n  <d:href>${href}</d:href>\n  <d:propstat>\n` +
    `   <d:prop><d:getetag>&quot;${uid}-1&quot;</d:getetag>` +
    `<cal:calendar-data>${ics}</cal:calendar-data></d:prop>\n` +
    `   <d:status>HTTP/1.1 200 OK</d:status>\n  </d:propstat>\n </d:response>\n`
  );
}

/**
 * A resource whose `VCALENDAR` is cut off mid-event.
 *
 * Deliberately between two good ones in every fixture that uses it: §6.5's
 * claim is that a bad resource costs one event, and a bad resource at the *end*
 * of a document would pass just as happily on a reader that stopped at the
 * first failure.
 */
function brokenResource(href: string): string {
  const truncated = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:cut-off@test'].join(
    '\r\n',
  );
  return (
    ` <d:response>\n  <d:href>${href}</d:href>\n  <d:propstat>\n` +
    `   <d:prop><d:getetag>&quot;broken-1&quot;</d:getetag>` +
    `<cal:calendar-data>${truncated}</cal:calendar-data></d:prop>\n` +
    `   <d:status>HTTP/1.1 200 OK</d:status>\n  </d:propstat>\n </d:response>\n`
  );
}

function multistatus(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ` +
    `xmlns:cs="http://calendarserver.org/ns/">\n${body}</d:multistatus>\n`
  );
}

function stamp(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}
function nextDay(day: string): string {
  const date = new Date(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`,
  );
  return new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

const PERSONAL = '/dav/calendars/REDACTED/personal/';
const SCHOOL = '/dav/calendars/REDACTED/school-run/';
const SHOPPING = '/dav/calendars/REDACTED/shopping/';

/** Two good events with a truncated resource between them (§6.5). */
const PERSONAL_REPORT = multistatus(
  resource(`${PERSONAL}a.ics`, 'good-one@test', 'Dentist', stamp(2)) +
    brokenResource(`${PERSONAL}b.ics`) +
    resource(`${PERSONAL}c.ics`, 'good-two@test', 'Bin day', stamp(3)),
);
const SCHOOL_REPORT = multistatus(
  resource(`${SCHOOL}a.ics`, 'school-one@test', 'Sports day', stamp(4)),
);
const SHOPPING_REPORT = multistatus(
  resource(`${SHOPPING}a.ics`, 'shop-one@test', 'Market', stamp(5)),
);

function database(): {
  db: ReturnType<typeof openDatabase>['db'];
  keyring: ReturnType<typeof createKeyring>;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-caldav-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, keyring: createKeyring(loadOrCreateMasterKey(dataDir).key) };
}

const fetcher = createFetcher();
const job = (id: string): JobRecord => ({
  key: `caldav-sync:${id}`,
  kind: 'caldav-sync',
  nextRunAt: 0,
  consecutiveFailures: 0,
});

describe('the CalDAV sync', () => {
  let server: CalDavFake;
  let password = PASSWORD;

  beforeEach(async () => {
    password = PASSWORD;
    server = await startCalDavFake({
      // A function would be neater; the fake compares a fixed string, so the
      // rotation case starts a second server rather than mutating this one.
      credential: credentialFor(PASSWORD),
      reports: { [PERSONAL]: PERSONAL_REPORT, [SCHOOL]: SCHOOL_REPORT, [SHOPPING]: SHOPPING_REPORT },
    });
    servers.push(server);
  });

  function setUp(
    db: ReturnType<typeof openDatabase>['db'],
    keyring: ReturnType<typeof createKeyring>,
    paths: readonly string[] = [PERSONAL],
  ): { accountId: string; ids: string[] } {
    const accountId = createCaldavAccount(
      db,
      keyring,
      {
        serverUrl: server.base,
        username: USERNAME,
        password,
        principalUrl: `${server.base}/dav/principals/REDACTED/`,
        homeSetUrl: `${server.base}/dav/calendars/REDACTED/`,
        allowLoopback: true,
        allowHttp: true,
      },
      1_000,
    );
    const ids = paths.map((path, index) =>
      addCaldavCalendar(
        db,
        keyring,
        { accountId, name: `Calendar ${index}`, url: `${server.base}${path}` },
        1_000,
      ),
    );
    return { accountId, ids };
  }

  const handlerFor = (
    db: ReturnType<typeof openDatabase>['db'],
    keyring: ReturnType<typeof createKeyring>,
  ) => createCaldavSyncHandler({ db, fetcher, keyring, timezone: () => TZ });

  const titles = (db: ReturnType<typeof openDatabase>['db'], id: string): string[] =>
    (
      db
        .prepare('SELECT title FROM calendar_events_cache WHERE source_id = ? ORDER BY starts_at')
        .all(id) as { title: string }[]
    ).map((row) => row.title);

  it('one malformed resource costs one event, not the calendar (§6.5)', async () => {
    const { db, keyring } = database();
    const { ids } = setUp(db, keyring);
    const outcome = await handlerFor(db, keyring)(job(ids[0] as string));

    expect(outcome.status).toBe('ok');
    // The two good ones either side of the truncated one. This is the first row
    // of CLAUDE.md's bug table made structurally impossible for this kind.
    expect(titles(db, ids[0] as string)).toEqual(['Dentist', 'Bin day']);
    // And it is not reported as a failed sync: the calendar is on the wall.
    const row = db
      .prepare('SELECT last_error AS e, event_count AS n FROM calendar_sources WHERE id = ?')
      .get(ids[0] as string) as { e: string | null; n: number };
    expect(row.e).toBeNull();
    expect(row.n).toBe(2);
  });

  it('an unchanged CTag costs one PROPFIND and no REPORT (§6.6)', async () => {
    const { db, keyring } = database();
    const { ids } = setUp(db, keyring);
    const handler = handlerFor(db, keyring);

    await handler(job(ids[0] as string));
    server.reset();
    const second = await handler(job(ids[0] as string));

    expect(second.status).toBe('ok');
    expect(server.seen.map((r) => r.method)).toEqual(['PROPFIND']);
    // Still there: an unchanged calendar keeps its events rather than replacing
    // them with nothing.
    expect(titles(db, ids[0] as string)).toEqual(['Dentist', 'Bin day']);
  });

  it('a changed CTag does the REPORT again', async () => {
    const { db, keyring } = database();
    const { ids } = setUp(db, keyring);
    const handler = handlerFor(db, keyring);

    await handler(job(ids[0] as string));
    server.setCtag(PERSONAL, 'ctag-home-2');
    server.reset();
    await handler(job(ids[0] as string));

    expect(server.seen.map((r) => r.method)).toEqual(['PROPFIND', 'REPORT']);
  });

  it('keeps yesterday’s events when the server refuses the sign-in, and does not retry soon', async () => {
    const { db, keyring } = database();
    const { ids, accountId } = setUp(db, keyring);
    const handler = handlerFor(db, keyring);
    await handler(job(ids[0] as string));
    expect(titles(db, ids[0] as string)).toHaveLength(2);

    // The password stopped being accepted, which is what a regenerated
    // app-specific password looks like from here.
    rotateCaldavPassword(db, keyring, accountId, 'no-longer-right', 2_000);
    server.setCtag(PERSONAL, 'ctag-home-3');
    const outcome = await handler(job(ids[0] as string));

    expect(outcome.status).toBe('failed');
    // Rule nine: the wall keeps the calendar it had.
    expect(titles(db, ids[0] as string)).toEqual(['Dentist', 'Bin day']);
    // §4.6 — a hold rather than the backoff ladder, because no amount of
    // waiting turns a wrong password right and Apple locks an account out.
    expect(outcome.status === 'failed' ? outcome.retryAfterSeconds : 0).toBe(7 * 24 * 60 * 60);
    // Said on the account, because it is the fault that hits every calendar at
    // once and the account is where the one control that fixes it lives.
    const account = db
      .prepare('SELECT last_error AS e FROM caldav_accounts WHERE id = ?')
      .get(accountId) as { e: string | null };
    expect(account.e).toContain('app-specific password');
    expect(account.e).not.toContain('no-longer-right');
  });

  it('never puts the password in last_error, on either row', async () => {
    const { db, keyring } = database();
    const { ids, accountId } = setUp(db, keyring);
    rotateCaldavPassword(db, keyring, accountId, 'Fluffy2019!', 2_000);
    await handlerFor(db, keyring)(job(ids[0] as string));

    /*
     * §11 asks for this as a grep rather than as the redactor's opinion, and it
     * is right: `looksLikeSecret` is tuned for a *generated* token — vowel
     * density, length, case-flips — and a password a person chose is not shaped
     * like one at all. The guarantee has to be structural, meaning the password
     * is never formatted into a message in the first place.
     */
    const text = JSON.stringify([
      db.prepare('SELECT last_error FROM calendar_sources').all(),
      db.prepare('SELECT last_error, username FROM caldav_accounts').all(),
    ]);
    expect(text).not.toContain('Fluffy2019!');
  });
});

describe('an account and its calendars (RFC 013 §6.2.1)', () => {
  let server: CalDavFake;
  beforeEach(async () => {
    server = await startCalDavFake({
      credential: credentialFor(PASSWORD),
      reports: { [PERSONAL]: PERSONAL_REPORT, [SCHOOL]: SCHOOL_REPORT, [SHOPPING]: SHOPPING_REPORT },
    });
    servers.push(server);
  });

  function threeCalendars(): {
    db: ReturnType<typeof openDatabase>['db'];
    keyring: ReturnType<typeof createKeyring>;
    accountId: string;
    ids: string[];
  } {
    const { db, keyring } = database();
    const accountId = createCaldavAccount(
      db,
      keyring,
      {
        serverUrl: server.base,
        username: USERNAME,
        password: PASSWORD,
        principalUrl: `${server.base}/dav/principals/REDACTED/`,
        homeSetUrl: `${server.base}/dav/calendars/REDACTED/`,
        allowLoopback: true,
        allowHttp: true,
      },
      1_000,
    );
    const ids = [PERSONAL, SCHOOL, SHOPPING].map((path, index) =>
      addCaldavCalendar(
        db,
        keyring,
        { accountId, name: `Calendar ${index}`, url: `${server.base}${path}` },
        1_000,
      ),
    );
    return { db, keyring, accountId, ids };
  }

  it('rotating the password once syncs all three (the reason the table exists)', async () => {
    const { db, keyring, accountId, ids } = threeCalendars();
    const handler = createCaldavSyncHandler({ db, fetcher, keyring, timezone: () => TZ });

    // A second server, standing in for the same one after the household
    // regenerated their app-specific password: the old credential is refused.
    const rotated = await startCalDavFake({
      credential: credentialFor('regenerated-pw'),
      reports: { [PERSONAL]: PERSONAL_REPORT, [SCHOOL]: SCHOOL_REPORT, [SHOPPING]: SHOPPING_REPORT },
    });
    servers.push(rotated);
    db.prepare('UPDATE calendar_sources SET url_encrypted = ? WHERE id = ?');
    for (const [index, path] of [PERSONAL, SCHOOL, SHOPPING].entries()) {
      db.prepare('UPDATE calendar_sources SET url_encrypted = ? WHERE id = ?').run(
        keyring.encrypt(`${rotated.base}${path}`, 'calendar-source-url'),
        ids[index] as string,
      );
    }
    db.prepare('UPDATE caldav_accounts SET server_url_encrypted = ? WHERE id = ?').run(
      keyring.encrypt(rotated.base, 'calendar-source-url'),
      accountId,
    );

    // Every one of them is refused first, which is what makes the next line an
    // assertion rather than a coincidence.
    for (const id of ids) expect((await handler(job(id))).status).toBe('failed');

    // **One edit.** Under a flat scheme this would be three, and missing one
    // presents as "one of my calendars stopped updating".
    expect(rotateCaldavPassword(db, keyring, accountId, 'regenerated-pw', 3_000)).toBe(true);

    for (const id of ids) expect((await handler(job(id))).status).toBe('ok');
    const counts = ids.map(
      (id) =>
        (
          db
            .prepare('SELECT count(*) AS n FROM calendar_events_cache WHERE source_id = ?')
            .get(id) as { n: number }
        ).n,
    );
    expect(counts).toEqual([2, 1, 1]);
  });

  it('removing the last calendar removes the account and its credential', () => {
    const { db, keyring, accountId } = threeCalendars();
    const id = addCaldavCalendar(
      db,
      keyring,
      { accountId: createOwnAccount(db, keyring), name: 'Only one', url: `${server.base}${PERSONAL}` },
      1_000,
    );
    const lone = db
      .prepare('SELECT caldav_account_id AS a FROM calendar_sources WHERE id = ?')
      .get(id) as { a: string };

    expect(removeCaldavCalendar(db, id)).toBe(true);
    // The row is gone rather than the constraint having fired, which is what
    // the code-side delete is for: the declared cascade is not in the database.
    expect(
      db.prepare('SELECT count(*) AS n FROM caldav_accounts WHERE id = ?').get(lone.a),
    ).toEqual({ n: 0 });
    // And the first account, which still has three, is untouched.
    expect(
      db.prepare('SELECT count(*) AS n FROM caldav_accounts WHERE id = ?').get(accountId),
    ).toEqual({ n: 1 });
  });

  it('removing one of three leaves the account and the other two', () => {
    const { db, accountId, ids } = threeCalendars();
    expect(removeCaldavCalendar(db, ids[0] as string)).toBe(true);

    expect(
      db.prepare('SELECT count(*) AS n FROM caldav_accounts WHERE id = ?').get(accountId),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare('SELECT count(*) AS n FROM calendar_sources WHERE caldav_account_id = ?')
        .get(accountId),
    ).toEqual({ n: 2 });
    // Its job row went with it, so the scheduler is not left calling a handler
    // for a source that is not there.
    expect(
      db.prepare('SELECT count(*) AS n FROM job_state WHERE key = ?').get(`caldav-sync:${ids[0]}`),
    ).toEqual({ n: 0 });
  });

  it('removing the account takes its calendars and their events', async () => {
    const { db, keyring, accountId, ids } = threeCalendars();
    const handler = createCaldavSyncHandler({ db, fetcher, keyring, timezone: () => TZ });
    await handler(job(ids[0] as string));
    expect(
      db.prepare('SELECT count(*) AS n FROM calendar_events_cache').get(),
    ).toEqual({ n: 2 });

    expect(removeCaldavAccount(db, accountId)).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
    // Explicit rather than cascaded: SQLite would have refused the account
    // delete outright, because drizzle-kit drops the FK action from an ADD
    // COLUMN. Measured, not read off the schema.
    expect(db.prepare('SELECT count(*) AS n FROM calendar_events_cache').get()).toEqual({ n: 0 });
  });

  function createOwnAccount(
    db: ReturnType<typeof openDatabase>['db'],
    keyring: ReturnType<typeof createKeyring>,
  ): string {
    return createCaldavAccount(
      db,
      keyring,
      {
        serverUrl: server.base,
        username: 'second@example.org',
        password: PASSWORD,
        principalUrl: `${server.base}/dav/principals/REDACTED/`,
        homeSetUrl: `${server.base}/dav/calendars/REDACTED/`,
        allowLoopback: true,
        allowHttp: true,
      },
      1_000,
    );
  }
});

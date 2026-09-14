import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { clearPendingCaldav } from '../src/api/caldav-pending.js';
import { createCaldavSyncHandler } from '../src/jobs/caldav-sync.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { startCalDavFake, type CalDavFake } from './caldav-fake.js';

/**
 * Adding a CalDAV account through the real app (RFC 013 §6.3.1, §6.7).
 *
 * The assertion this file exists for is the one §6.3.1 makes a mechanism out
 * of: **the password crosses the confirmation round trip without being
 * echoed**, because it does not cross it at all. That is a claim about what is
 * in the response HTML, and it is exactly the kind of claim that stops being
 * true the day somebody adds a convenient hidden field — so it is checked on
 * every page of the flow rather than on the one where it was first true.
 *
 * Driven against a real loopback CalDAV server through the real app, with a
 * real session from the real wizard, for the reason `admin-calendars.test.ts`
 * is: the two auth bugs this project has already found were in the seam between
 * pieces that were each correct.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const USERNAME = 'jane@example.org';
/*
 * A password a *person* chose, not a generated token, which is §11's own point:
 * `looksLikeSecret` is tuned for vowel density and case-flips and has no reason
 * to catch this one. The guarantee has to be structural, and the check has to
 * be the literal string.
 */
const PASSWORD = 'Fluffy2019!';
const CREDENTIAL = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, 'utf8').toString('base64')}`;

const roots: string[] = [];
const servers: CalDavFake[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearPendingCaldav();
});

async function harness() {
  const address = `10.6.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-caldav-admin-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  /*
   * Held rather than inlined, because the CalDAV sync has to be run with the
   * *same* keyring the screens sealed the rows with — a fresh one decrypts
   * nothing, and the failure reads as a broken sync rather than as a test
   * holding the wrong key.
   */
  const keyring = createKeyring(randomBytes(32));
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
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
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  return { db, call, form, keyring };
}

/** A REPORT answer holding one whole VCALENDAR, dated near today. */
function multistatusWithEvent(): string {
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const next = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    'UID:live@test',
    'SUMMARY:Quarterly review',
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${next}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ` +
    `xmlns:cs="http://calendarserver.org/ns/">\n` +
    ` <d:response>\n  <d:href>/dav/calendars/REDACTED/personal/live.ics</d:href>\n` +
    `  <d:propstat>\n   <d:prop><d:getetag>&quot;live-1&quot;</d:getetag>` +
    `<cal:calendar-data>${ics}</cal:calendar-data></d:prop>\n` +
    `   <d:status>HTTP/1.1 200 OK</d:status>\n  </d:propstat>\n </d:response>\n` +
    `</d:multistatus>\n`
  );
}

/** The value of a hidden input, read out of the markup the household received. */
function hidden(html: string, name: string): string | undefined {
  const match = new RegExp(
    `<input type="hidden" name="${name}" value="([^"]*)"`,
  ).exec(html);
  return match?.[1];
}

/** Every checkbox the picker drew, as name → value. */
function checkboxes(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of html.matchAll(
    /<input type="checkbox" name="(calendar_\d+)" value="([^"]*)"/g,
  )) {
    out[match[1] as string] = match[2] as string;
  }
  return out;
}

describe('adding a CalDAV account', () => {
  it('finds the calendars and offers them, on a server that never moves host', async () => {
    const server = await startCalDavFake({ credential: CREDENTIAL });
    servers.push(server);
    const { form } = await harness();

    const response = await form('/admin/calendars/caldav', {
      server_url: server.base,
      caldav_username: USERNAME,
      caldav_password: PASSWORD,
      allow_loopback: '1',
      allow_http: '1',
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    // Straight to the picker: a chain that stays on one host asks nothing,
    // which is §6.3.1's "same host is silent" and is every self-hosted server.
    expect(html).toContain('Which calendars?');
    expect(html).not.toContain('Is that the right server?');
    const boxes = checkboxes(html);
    expect(Object.keys(boxes)).toHaveLength(2);
    expect(html).toContain('School &amp; clubs');
    // And the shopping list, which is VTODO-only, is not offered as a calendar.
    expect(html).not.toContain('Shopping');
  });

  it('never puts the password in the markup, on any page of the flow', async () => {
    const second = await startCalDavFake({ credential: CREDENTIAL });
    const first = await startCalDavFake({
      credential: CREDENTIAL,
      homeSetUrl: `${second.base}/dav/calendars/REDACTED/`,
      serveCollections: false,
    });
    servers.push(second, first);
    const { form, db } = await harness();

    // 1 — the submission that runs discovery and is stopped by the host policy.
    const asked = await form('/admin/calendars/caldav', {
      server_url: first.base,
      caldav_username: USERNAME,
      caldav_password: PASSWORD,
      allow_loopback: '1',
      allow_http: '1',
    });
    const confirmPage = await asked.text();
    expect(confirmPage).toContain('Is that the right server?');
    // The host is named in prose, which is the whole of the question.
    expect(confirmPage).toContain(new URL(second.base).host);
    expect(confirmPage).not.toContain(PASSWORD);

    // §11's assertion: the credential has not gone to the second host yet.
    expect(second.signedIn()).toHaveLength(0);

    // 2 — Continue, carrying the opaque id and the host and nothing else.
    const pending = hidden(confirmPage, 'pending');
    expect(pending).toBeDefined();
    expect(pending).not.toContain(PASSWORD);
    const picked = await form('/admin/calendars/caldav/confirm', {
      pending: pending as string,
      host: new URL(second.base).host,
    });
    const pickPage = await picked.text();
    expect(pickPage).toContain('Which calendars?');
    expect(pickPage).not.toContain(PASSWORD);
    // Now it has gone, because the household said so.
    expect(second.signedIn().length).toBeGreaterThan(0);

    // 3 — tick them, which is the first thing that writes a row.
    const boxes = checkboxes(pickPage);
    const fields: Record<string, string> = { pending: hidden(pickPage, 'pending') as string };
    for (const [name, value] of Object.entries(boxes)) fields[name] = value;
    for (const match of pickPage.matchAll(/name="(name_\d+)" value="([^"]*)"/g)) {
      fields[match[1] as string] = match[2] as string;
    }
    for (const match of pickPage.matchAll(/name="(ctag_\d+)" value="([^"]*)"/g)) {
      fields[match[1] as string] = match[2] as string;
    }
    const saved = await form('/admin/calendars/caldav/add', fields);
    expect(saved.status).toBe(302);

    const account = db
      .prepare('SELECT username, confirmed_host AS host, password_encrypted AS pw FROM caldav_accounts')
      .all() as { username: string; host: string; pw: string }[];
    expect(account).toHaveLength(1);
    expect(account[0]?.username).toBe(USERNAME);
    // The host stored is the one the household was shown and pressed Continue
    // on, rather than one read back off a record they never saw.
    expect(account[0]?.host).toBe(new URL(second.base).host);
    // Sealed, not stored.
    expect(account[0]?.pw).not.toContain(PASSWORD);
    expect(
      db.prepare(`SELECT count(*) AS n FROM calendar_sources WHERE kind = 'caldav'`).get(),
    ).toEqual({ n: 2 });
    // And its jobs exist, so the calendars actually sync rather than merely
    // existing -- the fault `api/sources.ts`'s own docstring names.
    expect(
      db.prepare(`SELECT count(*) AS n FROM job_state WHERE kind = 'caldav-sync'`).get(),
    ).toEqual({ n: 2 });
  });

  it('says what went wrong without losing the address and the username', async () => {
    const server = await startCalDavFake({ credential: CREDENTIAL });
    servers.push(server);
    const { form } = await harness();

    const response = await form('/admin/calendars/caldav', {
      server_url: server.base,
      caldav_username: USERNAME,
      caldav_password: 'not-the-password',
      allow_loopback: '1',
      allow_http: '1',
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('not accepted');
    // Echoed, so a mistyped password does not also cost the two fields above it.
    expect(html).toContain(server.base);
    expect(html).toContain(USERNAME);
    // Never the password, on the failure branch either.
    expect(html).not.toContain('not-the-password');
  });

  it('shows the account with its calendars, and changes one password for all of them', async () => {
    const server = await startCalDavFake({ credential: CREDENTIAL });
    servers.push(server);
    const { form, call, db } = await harness();

    const pick = await (
      await form('/admin/calendars/caldav', {
        server_url: server.base,
        caldav_username: USERNAME,
        caldav_password: PASSWORD,
        allow_loopback: '1',
        allow_http: '1',
      })
    ).text();
    const fields: Record<string, string> = { pending: hidden(pick, 'pending') as string };
    for (const [name, value] of Object.entries(checkboxes(pick))) fields[name] = value;
    for (const match of pick.matchAll(/name="(name_\d+)" value="([^"]*)"/g)) {
      fields[match[1] as string] = match[2] as string;
    }
    await form('/admin/calendars/caldav/add', fields);

    const page = await (await call('/admin/calendars')).text();
    expect(page).toContain('CalDAV accounts');
    expect(page).toContain(USERNAME);
    expect(page).toContain('2 calendars');
    expect(page).toContain('Change password');
    // The stored password is never on the page that offers to change it.
    expect(page).not.toContain(PASSWORD);

    const id = (db.prepare('SELECT id FROM caldav_accounts').get() as { id: string }).id;
    const before = (
      db.prepare('SELECT password_encrypted AS pw FROM caldav_accounts WHERE id = ?').get(id) as {
        pw: string;
      }
    ).pw;

    // Blank keeps, which is §4.5's reading one table along.
    await form(`/admin/calendars/caldav/${id}/password`, { caldav_password: '' });
    expect(
      (
        db.prepare('SELECT password_encrypted AS pw FROM caldav_accounts WHERE id = ?').get(id) as {
          pw: string;
        }
      ).pw,
    ).toBe(before);

    // And one edit changes it for every calendar on the account, which is the
    // entire argument of §6.2.1.
    await form(`/admin/calendars/caldav/${id}/password`, { caldav_password: 'regenerated' });
    expect(
      (
        db.prepare('SELECT password_encrypted AS pw FROM caldav_accounts WHERE id = ?').get(id) as {
          pw: string;
        }
      ).pw,
    ).not.toBe(before);
  });

  it('removing the last calendar removes the account, through the screen', async () => {
    const server = await startCalDavFake({ credential: CREDENTIAL });
    servers.push(server);
    const { form, db } = await harness();

    const pick = await (
      await form('/admin/calendars/caldav', {
        server_url: server.base,
        caldav_username: USERNAME,
        caldav_password: PASSWORD,
        allow_loopback: '1',
        allow_http: '1',
      })
    ).text();
    // One only, so removing it is removing the last.
    const boxes = Object.entries(checkboxes(pick)).slice(0, 1);
    const fields: Record<string, string> = { pending: hidden(pick, 'pending') as string };
    for (const [name, value] of boxes) fields[name] = value;
    fields['name_0'] = 'Home';
    await form('/admin/calendars/caldav/add', fields);

    const sourceId = (
      db.prepare(`SELECT id FROM calendar_sources WHERE kind = 'caldav'`).get() as { id: string }
    ).id;
    const removed = await form(`/admin/calendars/${sourceId}/delete`, {});
    expect(removed.status).toBe(302);

    // Rule six: an orphaned credential is a stored secret nothing uses.
    expect(db.prepare('SELECT count(*) AS n FROM caldav_accounts').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM job_state WHERE kind = 'caldav-sync'`).get()).toEqual({
      n: 0,
    });
  });

  it('puts the events on a wall, and no address or credential with them', async () => {
    /*
     * The end of the whole path, through the document a paired wall actually
     * polls.
     *
     * Rule six one layer out from the row, and the same promise RFC 012 makes
     * about Home Assistant: the wall receives **resolved values** and never the
     * thing that fetched them. A collection href matters here for the reason
     * `urlEncrypted`'s own comment gives — it is encrypted because it says
     * where a household's family calendar lives — and a display token is on a
     * tablet anybody in the house can pick up.
     *
     * Asserted by searching the serialisation rather than by listing the fields
     * it ought to have: a field added later fails this, and an approved list
     * would not.
     *
     * **What it can and cannot see, measured rather than assumed.** Leaking
     * `url_encrypted` itself into the manifest does *not* redden this, and
     * correctly so — that column is a sealed envelope, so the plaintext href
     * never appears however carelessly it is copied. What does redden it is a
     * **resolved** value passed through to a field the manifest reads, which is
     * exactly the hole RFC 012 found one feature along: the to-do widget stored
     * an entity id that travelled in the *layout* while being kept out of the
     * panel. That is the vector this guards, and it was confirmed by writing
     * the decrypted collection href into a source's name and watching this go
     * red.
     */
    const server = await startCalDavFake({
      credential: CREDENTIAL,
      reports: {
        '/dav/calendars/REDACTED/personal/': multistatusWithEvent(),
      },
    });
    servers.push(server);
    const { form, call, db, keyring } = await harness();

    const pick = await (
      await form('/admin/calendars/caldav', {
        server_url: server.base,
        caldav_username: USERNAME,
        caldav_password: PASSWORD,
        allow_loopback: '1',
        allow_http: '1',
      })
    ).text();
    const fields: Record<string, string> = { pending: hidden(pick, 'pending') as string };
    for (const [name, value] of Object.entries(checkboxes(pick))) fields[name] = value;
    for (const match of pick.matchAll(/name="(name_\d+)" value="([^"]*)"/g)) {
      fields[match[1] as string] = match[2] as string;
    }
    await form('/admin/calendars/caldav/add', fields);

    // Run the sync the scheduler would run, against the same real server.
    const sources = db
      .prepare(`SELECT id FROM calendar_sources WHERE kind = 'caldav'`)
      .all() as { id: string }[];
    const handler = createCaldavSyncHandler({
      db,
      fetcher: createFetcher(),
      keyring,
      timezone: () => 'Europe/London',
    });
    for (const source of sources) {
      await handler({
        key: `caldav-sync:${source.id}`,
        kind: 'caldav-sync',
        nextRunAt: 0,
        consecutiveFailures: 0,
      });
    }

    const issued = issueDisplayToken();
    const stamp = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('scr-dav', 'Kitchen', ?, ?, ?, ?)`,
    ).run(issued.tokenHash, stamp, stamp, stamp);

    const manifest = await (
      await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } })
    ).text();

    // What it carries.
    expect(manifest).toContain('Quarterly review');
    // And what it must not: the server, the collection path, and the credential.
    expect(manifest).not.toContain(new URL(server.base).port);
    expect(manifest).not.toContain('/dav/calendars');
    expect(manifest).not.toContain(PASSWORD);
    expect(manifest).not.toContain(USERNAME);
  });

  it('refuses a pending id that has expired rather than half-saving', async () => {
    const { form, db } = await harness();
    const response = await form('/admin/calendars/caldav/add', { pending: 'not-a-real-id' });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('was not kept');
    expect(db.prepare('SELECT count(*) AS n FROM caldav_accounts').get()).toEqual({ n: 0 });
  });
});

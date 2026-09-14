import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

/**
 * Adding and editing a calendar that has to sign in, through the real app.
 *
 * The assertions that matter here are about what is **not** in the response.
 * A password is the one field on this screen that exists to be kept out of the
 * response HTML and out of a browser's own form-autofill memory, so the
 * echo-on-400 rule every other field follows is deliberately reversed for it
 * (RFC 013 §4.5) — and a rule stated as an absence is exactly the sort
 * somebody reinstates while tidying.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;

const USER = 'jo@example';
const PASSWORD = 'Fluffy2019!';
const GOOD = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64')}`;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function icsBody(): string {
  const at = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 19).replace(/[-:]/g, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maverick Wall//test//EN',
    'BEGIN:VEVENT', 'UID:cred-1@example.com', 'DTSTAMP:20260101T000000Z',
    `DTSTART:${at}Z`, `DTEND:${at}Z`, 'SUMMARY:Dentist',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

/** A server that answers 401 unless the right Basic credential arrives. */
async function guardedServer(): Promise<string> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.headers.authorization !== GOOD) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="calendars"' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(icsBody());
  };
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/remote.php/dav/calendars/jo/personal?export`;
}

async function harness() {
  const address = `10.7.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-cred-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
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
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const source = () =>
    db.prepare('SELECT * FROM calendar_sources ORDER BY created_at LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;

  return { db, keyring, call, form, source };
}

describe('adding a calendar that has to sign in', () => {
  it('stores the account and a sealed password, and fetches with them', async () => {
    const h = await harness();
    const url = await guardedServer();
    const response = await h.form('/admin/calendars', {
      name: 'Nextcloud',
      url,
      allow_loopback: '1',
      allow_http: '1',
      auth_username: USER,
      auth_password: PASSWORD,
      action: 'save',
    });
    // A 302 means the feed was fetched, parsed and stored — which against this
    // server is only possible with the credential on the request.
    expect(response.status).toBe(302);

    const row = h.source() as Record<string, unknown>;
    expect(row['auth_username']).toBe(USER);
    // Sealed, not stored: the column is an envelope and the plaintext is
    // nowhere in it.
    expect(String(row['auth_password_encrypted'])).toMatch(/^mw1\./);
    expect(String(row['auth_password_encrypted'])).not.toContain(PASSWORD);
    expect(
      h.keyring.decrypt(String(row['auth_password_encrypted']), 'feed-password'),
    ).toEqual({ ok: true, value: PASSWORD });
  });

  it('refuses the feed with the three-form diagnosis when the password is wrong', async () => {
    const h = await harness();
    const url = await guardedServer();
    const response = await h.form('/admin/calendars', {
      name: 'Nextcloud', url, allow_loopback: '1', allow_http: '1',
      auth_username: USER, auth_password: 'wrong', action: 'save',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('The username or password was not accepted.');
    expect(h.source()).toBeUndefined();
  });

  it('stores neither half when only a username was given', async () => {
    // Half a credential composes no header, so storing the username alone would
    // put an account on the settings row for a feed that signs in as nobody.
    const h = await harness();
    const plain = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end(icsBody());
    });
    servers.push(plain);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const addr = plain.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const response = await h.form('/admin/calendars', {
      name: 'Open', url: `http://127.0.0.1:${port}/cal.ics`,
      allow_loopback: '1', allow_http: '1', auth_username: USER, action: 'save',
    });
    expect(response.status).toBe(302);
    const row = h.source() as Record<string, unknown>;
    expect(row['auth_username']).toBe(null);
    expect(row['auth_password_encrypted']).toBe(null);
  });
});

describe('the password is never echoed back', () => {
  it('is absent from a rejected add, while the account comes back', async () => {
    const h = await harness();
    const response = await h.form('/admin/calendars', {
      // No name and a save: rejected before anything is fetched.
      url: 'https://calendar.example/cal.ics',
      auth_username: USER,
      auth_password: PASSWORD,
      action: 'save',
    });
    expect(response.status).toBe(400);
    const html = await response.text();

    // The one field that must not come back, on any branch.
    expect(html).not.toContain(PASSWORD);
    // And the account does, so a wrong address does not cost it.
    expect(html).toContain(`value="${USER}"`);
    // The control is drawn and it is a password field with autofill off.
    expect(html).toContain('name="auth_password"');
    expect(html).toMatch(/name="auth_password"[^>]*autocomplete="off"/);
    expect(html).toMatch(/type="password"[^>]*name="auth_password"/);
  });

  it('is absent from a rejected settings save of a stored calendar', async () => {
    const h = await harness();
    const url = await guardedServer();
    await h.form('/admin/calendars', {
      name: 'Nextcloud', url, allow_loopback: '1', allow_http: '1',
      auth_username: USER, auth_password: PASSWORD, action: 'save',
    });
    const id = String((h.source() as Record<string, unknown>)['id']);

    // A cleared name is the ordinary way to be refused here.
    const response = await h.form(`/admin/calendars/${id}/settings`, {
      name: '', color: '#4C7FD1', enabled: '1',
      auth_username: USER, auth_password: 'a-new-app-password',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('a-new-app-password');
    // The stored one is untouched by a refused save.
    const row = h.source() as Record<string, unknown>;
    expect(h.keyring.decrypt(String(row['auth_password_encrypted']), 'feed-password')).toEqual({
      ok: true,
      value: PASSWORD,
    });
  });

  it('is absent from the wizard’s own step 3', async () => {
    const h = await harness();
    const response = await h.form('/setup/calendar', {
      name: 'Nextcloud',
      url: 'https://calendar.example/nope.ics',
      auth_username: USER,
      auth_password: PASSWORD,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain(PASSWORD);
    expect(html).toContain(`value="${USER}"`);
    expect(html).toContain('name="auth_password"');
  });
});

describe('rotating a stored password', () => {
  async function withStored() {
    const h = await harness();
    const url = await guardedServer();
    await h.form('/admin/calendars', {
      name: 'Nextcloud', url, allow_loopback: '1', allow_http: '1',
      auth_username: USER, auth_password: PASSWORD, action: 'save',
    });
    const id = String((h.source() as Record<string, unknown>)['id']);
    return { ...h, id };
  }

  const settings = (extra: Record<string, string> = {}): Record<string, string> => ({
    name: 'Nextcloud',
    color: '#4C7FD1',
    enabled: '1',
    show_in_grid: '1',
    allow_loopback: '1',
    allow_http: '1',
    auth_username: USER,
    ...extra,
  });

  it('keeps what is stored when the field is left blank', async () => {
    const h = await withStored();
    const response = await h.form(`/admin/calendars/${h.id}/settings`, settings());
    expect(response.status).toBe(302);
    const row = h.source() as Record<string, unknown>;
    expect(h.keyring.decrypt(String(row['auth_password_encrypted']), 'feed-password')).toEqual({
      ok: true,
      value: PASSWORD,
    });
  });

  it('replaces it when one is typed', async () => {
    const h = await withStored();
    await h.form(`/admin/calendars/${h.id}/settings`, settings({ auth_password: 'rotated-2027' }));
    const row = h.source() as Record<string, unknown>;
    expect(h.keyring.decrypt(String(row['auth_password_encrypted']), 'feed-password')).toEqual({
      ok: true,
      value: 'rotated-2027',
    });
  });

  it('removes it only when the switch says so, and takes the username with it', async () => {
    /*
     * Blank cannot also mean "delete it": that is indistinguishable from "I
     * have nothing to say about the password", which is what a blank field
     * means on every other save. The username follows, because an account name
     * on a row with no password composes no header — a state a household reads
     * as configured and the wire does not.
     */
    const h = await withStored();
    await h.form(`/admin/calendars/${h.id}/settings`, settings({ auth_password_remove: '1' }));
    const row = h.source() as Record<string, unknown>;
    expect(row['auth_password_encrypted']).toBe(null);
    expect(row['auth_username']).toBe(null);
  });

  it('offers the remove switch only when there is something to remove', async () => {
    const h = await withStored();
    const withOne = await (await h.call('/admin/calendars')).text();
    expect(withOne).toContain('name="auth_password_remove"');
    expect(withOne).toContain('Change password');
    /*
     * The account sits beside the *host*, and this assertion says so rather
     * than saying the words appear somewhere on the page.
     *
     * Its first draft was `toContain('as jo@example')`, which no edit could
     * turn red: the sign-in disclosure's own summary reads "Signs in as
     * jo@example", so deleting the host line entirely left it green. Reading
     * `<p class="host">` back is what separates the two.
     */
    const host = /<p class="host">([^<]*)<\/p>/.exec(withOne)?.[1] ?? '';
    expect(host).toContain('127.0.0.1');
    expect(host).toContain(`as ${USER}`);

    await h.form(`/admin/calendars/${h.id}/settings`, settings({ auth_password_remove: '1' }));
    const without = await (await h.call('/admin/calendars')).text();
    expect(without).not.toContain('name="auth_password_remove"');
    // And the row stops claiming an account it no longer has.
    expect(/<p class="host">([^<]*)<\/p>/.exec(without)?.[1] ?? '').not.toContain('as ');
    // A control that cannot do anything is worse than a control not offered.
    expect(without).toContain('name="auth_password"');
  });
});

describe('the route through Home Assistant', () => {
  it('is on the Calendars page with no Home Assistant connected', async () => {
    /*
     * The whole point of this copy, and the thing today's screen would have got
     * wrong by default: the calendar picker beside it only appears once a
     * household has a live Home Assistant connection, which is right for a
     * control that needs one to do anything. This is the opposite case — a
     * household with *no* connection is exactly who needs telling that making
     * one is the way to reach Google and iCloud. Gated on the same condition,
     * the sentence would only ever be read by households who had already solved
     * the problem it describes.
     */
    const h = await harness();
    const html = await (await h.call('/admin/calendars')).text();

    // Nothing here has connected Home Assistant, which is the state under test.
    expect(html).not.toContain('From Home Assistant');

    expect(html).toContain('Google, iCloud and Microsoft 365');
    // Named rather than gestured at: §12 decides that naming Home Assistant's
    // own integrations is more useful and ages worse, and takes the useful half.
    expect(html).toContain('Google Calendar');
    expect(html).toContain('CalDAV');
    expect(html).toContain('Remote Calendar');
    // The two caveats that have to be in the copy rather than in a footnote.
    expect(html).toContain('once a day');
    expect(html).toContain('hours behind');
    expect(html).toContain('Home Assistant failing is all of them');
  });

  it('links relatively, so an ingress household stays inside the add-on', async () => {
    // An absolute `/admin/home-assistant` under the supervisor's ingress prefix
    // lands in Home Assistant's own UI. The single `<base>` is what carries a
    // relative one, which is why every link in this admin is relative.
    const h = await harness();
    const html = await (await h.call('/admin/calendars')).text();
    expect(html).toContain('href="admin/home-assistant"');
    expect(html).not.toContain('href="/admin/home-assistant"');
  });
});

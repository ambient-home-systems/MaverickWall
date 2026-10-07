import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { createOAuthSyncHandler } from '../src/jobs/oauth-sync.js';
import { AUTH_FAILURE_HOLD_SECONDS } from '../src/jobs/ics-sync.js';
import { forgetAllAccessTokens } from '../src/oauth/accounts.js';
import { clearPendingOAuth } from '../src/api/oauth-pending.js';
import { googleRedirectUri } from '../src/http/admin-oauth.js';
import { deleteSource } from '../src/api/queries.js';
import { parseGoogleEvents, parseGraphEvents } from '../src/oauth/calendars.js';
import { fakeOAuth, type FakeOAuth } from './fake-oauth.js';

/**
 * Signing in to Google Calendar and Microsoft 365 (plan item M5.11), against
 * the real app, a real database, the real fetcher and a loopback stand-in for
 * both providers built from their documentation.
 *
 * Held, first, what never happens: a client secret, a device code, a refresh
 * token or a calendar id on a page or in the manifest; a refresh token stored
 * in clear; a sign-in finished from a `state` this wall did not mint; Google
 * offered on an install Google will not send a sign-in back to. Then the two
 * journeys a household takes — a code at microsoft.com/devicelogin, a trip to
 * Google's consent page — each to events on the wall; then the seven-day
 * expiry, said on the account and held for a week, and signing in again.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const fakes: FakeOAuth[] = [];
let n = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(fakes.map((fake) => fake.close()));
});

beforeEach(() => {
  forgetAllAccessTokens();
  clearPendingOAuth();
});

const PUBLIC = 'https://wall.example.com';
const TZ = 'Europe/London';

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fake: FakeOAuth;
  readonly form: (path: string, fields: Record<string, string> | URLSearchParams) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly manifest: () => Promise<string>;
  readonly sync: (sourceId: string) => Promise<unknown>;
}

async function harness(baseUrl = PUBLIC): Promise<Harness> {
  n++;
  const fake = await fakeOAuth();
  fakes.push(fake);
  const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (offset: number, hour: number): string =>
    `${day(offset)}T${String(hour).padStart(2, '0')}:00:00`;
  fake.google.calendars.push(
    { id: 'family@example.com', summary: 'Family', primary: true },
    { id: 'abc123@group.calendar.google.com', summary: 'School' },
  );
  fake.google.events['family@example.com'] = [
    { id: 'g1', status: 'confirmed', summary: 'Dentist', location: 'High Street', start: { dateTime: `${at(1, 9)}Z` }, end: { dateTime: `${at(1, 10)}Z` } },
    { id: 'g2', status: 'confirmed', summary: 'Half term', start: { date: day(3) }, end: { date: day(5) } },
    { id: 'g3', status: 'cancelled', summary: 'Called off', start: { dateTime: `${at(2, 9)}Z` }, end: { dateTime: `${at(2, 10)}Z` } },
    { id: 'g4_20261010T090000Z', status: 'confirmed', start: { dateTime: `${at(4, 9)}Z` }, end: { dateTime: `${at(4, 10)}Z` }, recurringEventId: 'g4' },
  ];
  fake.google.events['abc123@group.calendar.google.com'] = [];
  fake.microsoft.calendars.push(
    { id: 'AAMkAGI2-cal-1', name: 'Calendar', isDefaultCalendar: true },
    { id: 'AAMkAGI2-cal-2', name: 'Birthdays' },
  );
  fake.microsoft.events['AAMkAGI2-cal-1'] = [
    { id: 'm1', subject: 'Standup', start: { dateTime: `${at(1, 8)}.0000000`, timeZone: 'UTC' }, end: { dateTime: `${at(1, 8)}.0000000`.replace('T08', 'T09'), timeZone: 'UTC' }, isAllDay: false, isCancelled: false, showAs: 'busy', type: 'occurrence', location: { displayName: '' } },
    { id: 'm2', subject: 'Bank holiday', start: { dateTime: `${day(2)}T00:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `${day(3)}T00:00:00.0000000`, timeZone: 'UTC' }, isAllDay: true, isCancelled: false, showAs: 'free', type: 'singleInstance' },
    { id: 'm3', subject: 'Cancelled thing', start: { dateTime: `${at(2, 8)}.0000000`, timeZone: 'UTC' }, end: { dateTime: `${at(2, 9)}.0000000`, timeZone: 'UTC' }, isAllDay: false, isCancelled: true },
  ];
  fake.microsoft.events['AAMkAGI2-cal-2'] = [];

  const dataDir = mkdtempSync(join(tmpdir(), 'mw-signin-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const fetcher = createFetcher();
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl },
    keyring,
    fetcher,
    clientAddress: () => `10.41.${n}.1`,
    setupToken,
    dataDir,
    oauth: fake.endpoints,
  });
  const origin = new URL(baseUrl).origin;
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`${origin}${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string> | URLSearchParams): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `signin${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: TZ });
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  const handler = createOAuthSyncHandler({ db, fetcher, keyring, timezone: () => TZ, endpoints: fake.endpoints });
  return {
    db,
    keyring,
    fake,
    form,
    get: (path) => call(path),
    manifest: async () =>
      (await app.fetch(new Request(`${origin}/d/manifest`, { headers: { authorization: `Bearer ${display.token}` } }))).text(),
    sync: (sourceId) =>
      handler({ key: `oauth-sync:${sourceId}`, kind: 'oauth-sync', nextRunAt: 0, consecutiveFailures: 0 }),
  };
}

/** Microsoft, from the code to the picker, with the household finishing at Microsoft in between. */
async function signInMicrosoft(h: Harness): Promise<string> {
  const started = await h.form('/admin/calendars/microsoft/start', { client_id: h.fake.microsoft.clientId, tenant: '' });
  expect(started.status).toBe(200);
  const pending = /name="pending" value="([0-9a-f]{64})"/.exec(await started.text())?.[1] ?? '';
  h.fake.microsoft.approved = true;
  const polled = await h.form('/admin/calendars/microsoft/poll', { pending });
  expect(polled.status).toBe(200);
  return polled.text();
}

/** Google, from the form to the picker, with the consent page standing in for the browser's trip. */
async function signInGoogle(h: Harness): Promise<string> {
  const started = await h.form('/admin/calendars/google/start', {
    client_id: h.fake.google.clientId,
    client_secret: h.fake.google.clientSecret,
  });
  expect(started.status).toBe(302);
  const consent = h.fake.consent(started.headers.get('location') ?? '');
  const back = await h.get(`/admin/calendars/google/callback?state=${consent.state}&code=${consent.code}&scope=x`);
  expect(back.status).toBe(200);
  return back.text();
}

function pendingOf(page: string): string {
  return /name="pending" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? '';
}

function sourcesOf(h: Harness): { id: string; kind: string; name: string; url_encrypted: string; oauth_account_id: string }[] {
  return h.db
    .prepare(`SELECT id, kind, name, url_encrypted, oauth_account_id FROM calendar_sources ORDER BY created_at, name`)
    .all() as { id: string; kind: string; name: string; url_encrypted: string; oauth_account_id: string }[];
}

describe('where Google can send a sign-in back to', () => {
  it('is a public https address and nothing else', () => {
    expect(googleRedirectUri('https://wall.example.com')).toBe('https://wall.example.com/admin/calendars/google/callback');
    expect(googleRedirectUri('https://example.com/wall/')).toBe('https://example.com/wall/admin/calendars/google/callback');
    for (const refused of [
      'http://wall.example.com',
      'http://localhost:8080',
      'https://localhost',
      'https://192.168.1.10:8080',
      'https://[::1]',
      'https://wall.local',
      'https://wall.home.arpa',
      'https://nas',
      'not a url',
    ]) {
      expect(googleRedirectUri(refused), refused).toBeUndefined();
    }
  });

  it('says so on an install without one, offers no form, and refuses a hand-posted start', async () => {
    const h = await harness('http://localhost');
    const page = await (await h.get('/admin/calendars/new/google')).text();
    expect(page).toContain('This wall needs a public https address first');
    expect(page).toContain('admin/calendars/new/address');
    expect(page).not.toContain('action="admin/calendars/google/start"');
    const refused = await h.form('/admin/calendars/google/start', {
      client_id: h.fake.google.clientId,
      client_secret: h.fake.google.clientSecret,
    });
    expect(refused.status).toBe(400);
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe('Microsoft 365, by a code', () => {
  it('walks through the app registration, and refuses a client ID that is not one with it echoed back', async () => {
    const h = await harness();
    const page = await (await h.get('/admin/calendars/new/microsoft')).text();
    expect(page).toContain('Allow public client flows');
    expect(page).toContain('Calendars.ReadBasic');
    const refused = await h.form('/admin/calendars/microsoft/start', { client_id: 'not-a-guid', tenant: 'common' });
    expect(refused.status).toBe(400);
    const echoed = await refused.text();
    expect(echoed).toContain('value="not-a-guid"');
    expect(h.fake.requests).toHaveLength(0);
  });

  it('shows the code and Microsoft’s address, and never the device code', async () => {
    const h = await harness();
    const started = await h.form('/admin/calendars/microsoft/start', { client_id: h.fake.microsoft.clientId, tenant: 'common' });
    const page = await started.text();
    expect(page).toContain('FAKE1234');
    expect(page).toMatch(/href="https:\/\/microsoft\.com\/devicelogin" target="_blank" rel="noopener noreferrer"/);
    expect(page).not.toMatch(/device-[0-9a-f]{24}/);
    const asked = h.fake.requests.find((request) => request.path === '/ms/common/oauth2/v2.0/devicecode');
    expect(asked?.contentType).toBe('application/x-www-form-urlencoded');
    expect(asked?.form['scope']).toBe('openid profile offline_access Calendars.ReadBasic');
  });

  it('says plainly when the household has not finished yet, and keeps the code', async () => {
    const h = await harness();
    const started = await h.form('/admin/calendars/microsoft/start', { client_id: h.fake.microsoft.clientId, tenant: 'common' });
    const pending = pendingOf(await started.text());
    const early = await h.form('/admin/calendars/microsoft/poll', { pending });
    const page = await early.text();
    expect(page).toContain('Microsoft has not seen the sign-in finish yet');
    expect(page).toContain('FAKE1234');
    expect(pendingOf(page)).toBe(pending);
  });

  it('names the switch to turn on when Microsoft refuses a code flow, and says a declined sign-in added nothing', async () => {
    const h = await harness();
    const started = await h.form('/admin/calendars/microsoft/start', { client_id: h.fake.microsoft.clientId, tenant: 'common' });
    h.fake.microsoft.deviceError = 'authorization_declined';
    const declined = await h.form('/admin/calendars/microsoft/poll', { pending: pendingOf(await started.text()) });
    expect(declined.status).toBe(400);
    expect(await declined.text()).toContain('declined at Microsoft');
    const wrong = await h.form('/admin/calendars/microsoft/start', {
      client_id: '9a2b3c4d-1111-2222-3333-444455556666',
      tenant: 'common',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Microsoft did not recognise the app’s client ID');
    expect(sourcesOf(h)).toHaveLength(0);
  });

  it('adds the ticked calendars, seals the sign-in, and reads its events — UTC asked for, cancelled left out', async () => {
    const h = await harness();
    const picker = await signInMicrosoft(h);
    expect(picker).toContain('Signed in to Microsoft 365 as jane@contoso.example.');
    // The default calendar is ticked, the other is not.
    expect(picker).toMatch(/name="calendar"[^>]*value="0"[^>]*checked|checked[^>]*name="calendar"[^>]*value="0"/);
    expect(picker).not.toContain('AAMkAGI2');
    for (const token of h.fake.refresh.keys()) expect(picker).not.toContain(token);

    const added = await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    expect(added.headers.get('location')).toContain('saved=calendar-added');
    const [source] = sourcesOf(h);
    expect(source?.kind).toBe('microsoft');
    expect(source?.name).toBe('Calendar');
    expect(source?.url_encrypted).not.toContain('AAMkAGI2');
    const account = JSON.stringify(h.db.prepare('SELECT * FROM oauth_accounts').get());
    for (const token of h.fake.refresh.keys()) expect(account).not.toContain(token);
    expect(h.db.prepare('SELECT key FROM job_state WHERE kind = ?').all('oauth-sync')).toEqual([{ key: `oauth-sync:${source?.id}` }]);

    expect(await h.sync(source?.id ?? '')).toEqual({ status: 'ok' });
    const view = h.fake.requests.find((request) => request.path.endsWith('/calendarView'));
    expect(view?.prefer).toBe('outlook.timezone="UTC"');
    const events = h.db
      .prepare('SELECT title, all_day AS allDay FROM calendar_events_cache WHERE source_id = ? ORDER BY starts_at')
      .all(source?.id) as { title: string; allDay: number }[];
    expect(events).toEqual([
      { title: 'Standup', allDay: 0 },
      { title: 'Bank holiday', allDay: 1 },
    ]);
  });

  it('stores the refresh token Microsoft rotates to, so the next sync after a restart still signs in', async () => {
    const h = await harness();
    const picker = await signInMicrosoft(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const id = sourcesOf(h)[0]?.id ?? '';
    const before = (h.db.prepare('SELECT refresh_token_encrypted AS sealed FROM oauth_accounts').get() as { sealed: string }).sealed;
    expect(await h.sync(id)).toEqual({ status: 'ok' });
    const after = (h.db.prepare('SELECT refresh_token_encrypted AS sealed FROM oauth_accounts').get() as { sealed: string }).sealed;
    expect(after).not.toBe(before);
    // The old one no longer works at the fake, as at Microsoft; a restart forgets the access token.
    forgetAllAccessTokens();
    expect(await h.sync(id)).toEqual({ status: 'ok' });
  });

  it('pages through a long calendar view, and only on Graph’s own origin', async () => {
    const h = await harness();
    h.fake.pageSize = 1;
    const picker = await signInMicrosoft(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const id = sourcesOf(h)[0]?.id ?? '';
    expect(await h.sync(id)).toEqual({ status: 'ok' });
    expect(h.fake.requests.filter((request) => request.path.endsWith('/calendarView'))).toHaveLength(3);
    expect(h.db.prepare('SELECT count(*) AS n FROM calendar_events_cache WHERE source_id = ?').get(id)).toEqual({ n: 2 });
  });
});

describe('Google Calendar, by its consent page', () => {
  it('names the exact redirect address to register, and the seven-day sign-out before it happens', async () => {
    const h = await harness();
    const page = await (await h.get('/admin/calendars/new/google')).text();
    expect(page).toContain('https://wall.example.com/admin/calendars/google/callback');
    expect(page).toContain('While the app is in Testing, Google signs this wall out every seven days.');
    // Google refuses to be drawn in a frame; the sidebar is one.
    expect(page).toContain('action="admin/calendars/google/start" target="_top"');
  });

  it('sends the browser to Google asking for read-only calendars, a lasting sign-in and PKCE — the secret never in the URL', async () => {
    const h = await harness();
    const started = await h.form('/admin/calendars/google/start', {
      client_id: h.fake.google.clientId,
      client_secret: h.fake.google.clientSecret,
    });
    const location = new URL(started.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(h.fake.endpoints.googleAuth);
    expect(location.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.readonly');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
    expect(location.searchParams.get('redirect_uri')).toBe('https://wall.example.com/admin/calendars/google/callback');
    expect(location.toString()).not.toContain(h.fake.google.clientSecret);
  });

  it('refuses a callback carrying a state this wall did not mint, and adds nothing', async () => {
    const h = await harness();
    const forged = await h.get(`/admin/calendars/google/callback?state=${'a'.repeat(64)}&code=code-x`);
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain('not one this wall started');
    expect(h.fake.requests).toHaveLength(0);
  });

  it('says a cancelled sign-in added nothing', async () => {
    const h = await harness();
    const started = await h.form('/admin/calendars/google/start', {
      client_id: h.fake.google.clientId,
      client_secret: h.fake.google.clientSecret,
    });
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state');
    const cancelled = await h.get(`/admin/calendars/google/callback?state=${state}&error=access_denied`);
    expect(cancelled.status).toBe(400);
    expect(await cancelled.text()).toContain('cancelled at Google');
  });

  it('exchanges the code with the verifier, adds the calendars, and reads its events with all-day dates intact', async () => {
    const h = await harness();
    const picker = await signInGoogle(h);
    expect(picker).toContain('Signed in to Google as family@example.com.');
    expect(picker).not.toContain(h.fake.google.clientSecret);
    const exchange = h.fake.requests.find((request) => request.form['grant_type'] === 'authorization_code');
    expect(exchange?.contentType).toBe('application/x-www-form-urlencoded');
    expect(exchange?.form['code_verifier']).toMatch(/^[A-Za-z0-9_-]{64}$/);

    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const [source] = sourcesOf(h);
    expect(source?.kind).toBe('google');
    const secret = JSON.stringify(h.db.prepare('SELECT * FROM oauth_accounts').get());
    expect(secret).not.toContain(h.fake.google.clientSecret);
    expect(await h.sync(source?.id ?? '')).toEqual({ status: 'ok' });
    const events = h.db
      .prepare(
        `SELECT title, all_day AS allDay, location FROM calendar_events_cache WHERE source_id = ? ORDER BY starts_at`,
      )
      .all(source?.id) as { title: string; allDay: number; location: string | null }[];
    expect(events.map((event) => event.title)).toEqual(['Dentist', 'Half term', '(No title)']);
    expect(events[0]?.location).toBe('High Street');
    expect(events[1]?.allDay).toBe(1);

    // The manifest names the events and nothing that signs in or finds the calendar.
    const manifest = await h.manifest();
    expect(manifest).toContain('Half term');
    expect(manifest).not.toContain('family@example.com');
    for (const token of [...h.fake.refresh.keys(), ...h.fake.access]) expect(manifest).not.toContain(token);
    expect(manifest).not.toContain(h.fake.google.clientSecret);
  });

  it('holds a revoked sign-in for a week, says the seven-day reason on the account, and signing in again lifts it', async () => {
    const h = await harness();
    const picker = await signInGoogle(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const id = sourcesOf(h)[0]?.id ?? '';
    h.fake.google.revoked = true;
    expect(await h.sync(id)).toEqual({
      status: 'failed',
      error: expect.stringContaining('seven days') as unknown as string,
      retryAfterSeconds: AUTH_FAILURE_HOLD_SECONDS,
    });
    const list = await (await h.get('/admin/calendars')).text();
    expect(list).toContain('Signed-in accounts');
    expect(list).toContain('A Google app left in Testing signs everybody out after seven days');
    expect(list).toContain('Sign in again');

    h.fake.google.revoked = false;
    h.db.prepare(`UPDATE job_state SET next_run_at = 9999999999999 WHERE key = ?`).run(`oauth-sync:${id}`);
    const accountId = (h.db.prepare('SELECT id FROM oauth_accounts').get() as { id: string }).id;
    const again = await h.form('/admin/calendars/google/start', { account: accountId });
    const consent = h.fake.consent(again.headers.get('location') ?? '');
    const back = await h.get(`/admin/calendars/google/callback?state=${consent.state}&code=${consent.code}`);
    expect(back.headers.get('location')).toContain('saved=calendar-signed-in');
    expect(h.db.prepare('SELECT count(*) AS n FROM oauth_accounts').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT last_error AS e FROM oauth_accounts').get()).toEqual({ e: null });
    expect(h.db.prepare('SELECT next_run_at AS at FROM job_state WHERE key = ?').get(`oauth-sync:${id}`)).toEqual({ at: 0 });
    expect(await h.sync(id)).toEqual({ status: 'ok' });
  });

  it('adds another calendar from the account without signing in again, offering only the ones not yet added', async () => {
    const h = await harness();
    const picker = await signInGoogle(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const accountId = (h.db.prepare('SELECT id FROM oauth_accounts').get() as { id: string }).id;
    const more = await (await h.get(`/admin/calendars/oauth/${accountId}/more`)).text();
    expect(more).toContain('School');
    expect(more).not.toContain('Family (main calendar)');
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(more), calendar: '0' });
    expect(sourcesOf(h).map((source) => source.name)).toEqual(['Family', 'School']);
    expect(h.db.prepare('SELECT count(*) AS n FROM oauth_accounts').get()).toEqual({ n: 1 });
  });

  it('adds nothing for an index the page never offered', async () => {
    const h = await harness();
    const picker = await signInGoogle(h);
    const added = await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '7' });
    expect(added.headers.get('location')).not.toContain('saved=');
    expect(sourcesOf(h)).toHaveLength(0);
    expect(h.db.prepare('SELECT count(*) AS n FROM oauth_accounts').get()).toEqual({ n: 0 });
  });
});

describe('removing', () => {
  it('forgets the account with its last calendar, and removing the account takes every calendar, event and job', async () => {
    const h = await harness();
    const picker = await signInMicrosoft(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const first = sourcesOf(h)[0]?.id ?? '';
    await h.sync(first);
    deleteSource(h.db, first);
    expect(h.db.prepare('SELECT count(*) AS n FROM oauth_accounts').get()).toEqual({ n: 0 });
    expect(h.db.prepare(`SELECT count(*) AS n FROM job_state WHERE kind = 'oauth-sync'`).get()).toEqual({ n: 0 });

    const second = await signInGoogle(h);
    const body = new URLSearchParams([
      ['pending', pendingOf(second)],
      ['calendar', '0'],
      ['calendar', '1'],
    ]);
    await h.form('/admin/calendars/oauth/add', body);
    const accountId = (h.db.prepare('SELECT id FROM oauth_accounts').get() as { id: string }).id;
    const confirm = await (await h.get(`/admin/calendars/oauth/${accountId}/delete`)).text();
    expect(confirm).toContain('Remove family@example.com?');
    const removed = await h.form(`/admin/calendars/oauth/${accountId}/delete`, {});
    expect(removed.headers.get('location')).toContain('saved=calendar-removed');
    expect(sourcesOf(h)).toHaveLength(0);
    expect(h.db.prepare('SELECT count(*) AS n FROM calendar_events_cache').get()).toEqual({ n: 0 });
    expect(h.db.prepare(`SELECT count(*) AS n FROM job_state WHERE kind = 'oauth-sync'`).get()).toEqual({ n: 0 });
  });
});

describe('the Calendars screens', () => {
  it('asks for a signed-in calendar at once when Sync now is pressed', async () => {
    const h = await harness();
    const picker = await signInMicrosoft(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const id = sourcesOf(h)[0]?.id ?? '';
    h.db.prepare(`UPDATE job_state SET next_run_at = 9999999999999 WHERE key = ?`).run(`oauth-sync:${id}`);
    const pressed = await h.form(`/admin/calendars/${id}/sync`, {});
    expect(pressed.headers.get('location')).toContain('saved=calendar-sync');
    expect(h.db.prepare('SELECT next_run_at AS at FROM job_state WHERE key = ?').get(`oauth-sync:${id}`)).toEqual({ at: 0 });
  });

  it('offer both sign-ins on the chooser, and a signed-in calendar’s row names its account and offers no password', async () => {
    const h = await harness();
    const chooser = await (await h.get('/admin/calendars/new')).text();
    expect(chooser).toContain('href="admin/calendars/new/google"');
    expect(chooser).toContain('href="admin/calendars/new/microsoft"');
    const picker = await signInMicrosoft(h);
    await h.form('/admin/calendars/oauth/add', { pending: pendingOf(picker), calendar: '0' });
    const list = await (await h.get('/admin/calendars')).text();
    expect(list).toContain('Microsoft 365 · jane@contoso.example');
    const row = list.slice(list.indexOf('Microsoft 365 · jane@contoso.example'), list.indexOf('Signed-in accounts'));
    expect(row).not.toContain('name="auth_password"');
    expect(row).not.toContain('name="allow_lan"');
  });
});

describe('reading what the providers send', () => {
  it('reads an Outlook all-day event whether Graph sends its midnight as-is or converted to UTC', () => {
    const asIs = parseGraphEvents(
      JSON.stringify({
        value: [
          { id: 'a', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-10-12T00:00:00.0000000' }, end: { dateTime: '2026-10-13T00:00:00.0000000' } },
          // London's midnight in summer time, read in UTC: the evening before.
          { id: 'b', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-10-11T23:00:00.0000000' }, end: { dateTime: '2026-10-12T23:00:00.0000000' } },
        ],
      }),
      TZ,
    ).events;
    expect(asIs.map((event) => event.startUtc.toISOString())).toEqual([
      '2026-10-11T23:00:00.000Z',
      '2026-10-11T23:00:00.000Z',
    ]);
    expect(asIs.map((event) => event.endUtc.toISOString())).toEqual([
      '2026-10-12T23:00:00.000Z',
      '2026-10-12T23:00:00.000Z',
    ]);
  });

  it('lets one malformed event cost itself and not the page, on both providers', () => {
    const google = parseGoogleEvents(
      JSON.stringify({ items: [{ id: 'x', start: {}, end: {} }, { summary: 'no id' }, { id: 'ok', summary: 'Kept', start: { date: '2026-10-12' }, end: { date: '2026-10-13' } }] }),
      TZ,
    );
    expect(google.events.map((event) => event.title)).toEqual(['Kept']);
    const graph = parseGraphEvents(
      JSON.stringify({ value: [{ id: 'x', start: { dateTime: 'never' }, end: { dateTime: 'never' } }, { id: 'ok', subject: null, start: { dateTime: '2026-10-12T09:00:00.0000000' }, end: { dateTime: '2026-10-12T10:00:00.0000000' } }] }),
      TZ,
    );
    expect(graph.events.map((event) => [event.title, event.startUtc.toISOString()])).toEqual([
      ['(No title)', '2026-10-12T09:00:00.000Z'],
    ]);
  });
});

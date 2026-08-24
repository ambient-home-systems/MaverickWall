import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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
import { INGRESS_HEADER } from '../src/http/ingress.js';
import type { SetupToken } from '../src/auth/tokens.js';
import { readRules, seedDefaultRules } from '../src/api/rules.js';
import { DEFAULT_ALERT_RULES } from '@maverick-wall/core';

/**
 * The first-run wizard, driven the way a household drives it.
 *
 * Real form posts, real redirects, real cookies, and for the calendar step a
 * real HTTP server handing over real ICS bytes. The wizard is the one flow
 * where every gate in the application is in a different state on each request,
 * and both auth bugs this project has found so far were in exactly that kind
 * of seam rather than in any single piece.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

let nextAddress = 0;

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Maverick Wall//test//EN',
  'BEGIN:VEVENT',
  'UID:wizard-1@example.com',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260715T140000Z',
  'DTEND:20260715T150000Z',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** A real feed on a real socket. A stub would not exercise the fetcher at all. */
async function icsServer(body: string = ICS, contentType = 'text/calendar'): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/feed.ics`;
}

function harness() {
  const address = `10.7.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wizard-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  // Seeded exactly as boot seeds it: a settings row with setup unfinished.
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const issued: SetupToken[] = [];
  const setupToken = createSetupTokenHolder((token) => issued.push(token));

  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'w'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  /** Reaching the app at a given origin, which is not always the configured one. */
  const callAt = async (origin: string, path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`${origin}${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    callAt('http://localhost', path, init);

  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  return { db, call, callAt, form, setupToken, issued, jar };
}

/** Walk steps one and two, leaving setup complete and the household signed in. */
async function completeThroughTimezone(h: ReturnType<typeof harness>, timezone = 'Europe/London') {
  const token = h.setupToken.current();
  await h.call(`/setup?token=${token.token}`);
  await h.form('/setup/account', {
    name: 'Household',
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  return h.form('/setup/household', { timezone });
}

describe('the gate before setup finishes', () => {
  it('holds back the application but not the wizard, the display or health', async () => {
    const { call } = harness();

    expect((await call('/')).status).toBe(302);
    expect((await call('/setup')).status).toBe(200);
    expect((await call('/healthz')).status).toBe(200);
    // Unpaired rather than redirected: the display keeps its own answer.
    expect((await call('/d/manifest')).status).toBe(401);
  });

  it('tells an API caller why rather than redirecting it', async () => {
    const { call } = harness();
    const response = await call('/api/sources');
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, string>;
    expect(body['error']).toBe('setup-incomplete');
    expect(body['next']).toBe('/setup');
  });
});

describe('step 1 — the account', () => {
  it('asks for the code when there is no token', async () => {
    const { call } = harness();
    const body = await (await call('/setup')).text();
    expect(body).toContain('Enter the setup code');
  });

  it('never prints the code into the page', async () => {
    // Reaching the container log is what stands in for proving you installed
    // this. A code shown on the page it protects would prove nothing.
    const { call, setupToken } = harness();
    const token = setupToken.current();
    const body = await (await call('/setup')).text();
    expect(body).not.toContain(token.shortCode);
    expect(body).not.toContain(token.token);
  });

  it('exchanges a token in the link for a cookie and drops it from the URL', async () => {
    const { call, setupToken } = harness();
    const token = setupToken.current();

    const response = await call(`/setup?token=${token.token}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/setup');
    expect(response.headers.getSetCookie().join()).toContain('mw_setup=');

    // The cookie is now doing the work, with no token in the address.
    expect(await (await call('/setup')).text()).toContain('Create your account');
  });

  it('accepts the short code typed in by hand', async () => {
    const { call, form, setupToken } = harness();
    const token = setupToken.current();

    const response = await form('/setup/token', { code: token.shortCode });
    expect(response.status).toBe(302);
    expect(await (await call('/setup')).text()).toContain('Create your account');
  });

  it('refuses a wrong code and a wrong token', async () => {
    const { call, form } = harness();
    expect((await form('/setup/token', { code: 'NOPE99' })).status).toBe(400);
    expect(await (await call('/setup?token=not-the-token')).text()).toContain('expired');
  });

  it('refuses to create an account without the token', async () => {
    // The hole this closes: before the wizard, the first sign-up was open to
    // anyone who could reach the port.
    const { form, db } = harness();
    const response = await form('/setup/account', {
      name: 'Intruder',
      email: 'intruder@example.com',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
    expect(response.status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 0 });
  });

  it('creates the account and signs the household straight in', async () => {
    const { call, form, db, setupToken } = harness();
    await call(`/setup?token=${setupToken.current().token}`);

    const response = await form('/setup/account', {
      name: 'Household',
      email: 'family@home.local',
      password: 'correct-horse-battery',
      confirm: 'correct-horse-battery',
    });
    expect(response.status).toBe(302);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });

    // Signed in already: sending somebody to a sign-in form seconds after
    // choosing a password would be its own small insult.
    expect(await (await call('/setup')).text()).toContain('Where is this wall?');
  });

  it('rejects a short password and a mismatch without losing what was typed', async () => {
    const { call, form, setupToken } = harness();
    await call(`/setup?token=${setupToken.current().token}`);

    const short = await form('/setup/account', {
      name: 'Household', email: 'family@home.local', password: 'short', confirm: 'short',
    });
    expect(short.status).toBe(400);
    const shortBody = await short.text();
    expect(shortBody).toContain('at least 10 characters');
    // Re-typing an email address after a password error is a small cruelty.
    expect(shortBody).toContain('family@home.local');

    const mismatch = await form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-batteryX',
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain('do not match');
  });

  it('refuses a second account even with a still-valid token', async () => {
    const h = harness();
    await completeThroughTimezone(h);

    const response = await h.form('/setup/account', {
      name: 'Second', email: 'second@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    // Sent back to the finished wizard rather than being allowed through.
    expect(response.headers.get('location')).toBe('/setup/done');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });
  });
});

describe('reached at an address BASE_URL does not name', () => {
  /**
   * The case a household actually hits.
   *
   * `BASE_URL` defaults to localhost, and nobody browses to localhost from the
   * sofa — they type the box's LAN address. Better Auth refused that with
   * "Missing or null Origin", which is not a sentence anybody in a kitchen can
   * act on, and it only showed up when the wizard was driven over a real
   * socket rather than at the configured origin.
   */
  it('still completes the wizard', async () => {
    const h = harness();
    const at = (path: string, init: RequestInit = {}): Promise<Response> =>
      h.callAt('http://192.168.1.10:8080', path, init);
    const formAt = (path: string, fields: Record<string, string>): Promise<Response> =>
      at(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // What a browser stamps on a form post, and it is not BASE_URL.
          origin: 'http://192.168.1.10:8080',
        },
        body: new URLSearchParams(fields).toString(),
      });

    await at(`/setup?token=${h.setupToken.current().token}`);
    const created = await formAt('/setup/account', {
      name: 'Household', email: 'lan@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    expect(created.status).toBe(302);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 1 });

    const saved = await formAt('/setup/household', { timezone: 'Europe/London' });
    expect(saved.status).toBe(302);
  });

  it('still refuses a form posted from somewhere else', async () => {
    // Trusting the address the browser used must not become trusting anybody.
    const h = harness();
    await h.call(`/setup?token=${h.setupToken.current().token}`);

    const response = await h.callAt('http://192.168.1.10:8080', '/setup/account', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
      },
      body: new URLSearchParams({
        name: 'Intruder', email: 'intruder@evil.example',
        password: 'correct-horse-battery', confirm: 'correct-horse-battery',
      }).toString(),
    });

    expect(response.status).not.toBe(302);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 0 });
  });
});

describe('step 2 — the timezone', () => {
  it('completes setup and unlocks the application', async () => {
    const h = harness();
    expect((await h.call('/')).status).toBe(302);

    const response = await completeThroughTimezone(h, 'Europe/London');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/setup/calendar');

    const row = h.db
      .prepare(`SELECT timezone, setup_completed_at FROM household_settings WHERE id = 'singleton'`)
      .get() as { timezone: string; setup_completed_at: number | null };
    expect(row.timezone).toBe('Europe/London');
    expect(row.setup_completed_at).toBeGreaterThan(0);

    // The gate is open now.
    expect((await h.call('/')).status).toBe(200);
  });

  it('refuses a zone Intl does not know', async () => {
    // A zone that cannot be resolved would fail later, when recurrence is
    // anchored — a long way from the form that accepted it.
    const h = harness();
    const token = h.setupToken.current();
    await h.call(`/setup?token=${token.token}`);
    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });

    const response = await h.form('/setup/household', { timezone: 'Mars/Olympus_Mons' });
    expect(response.status).toBe(400);
    const row = h.db
      .prepare(`SELECT setup_completed_at FROM household_settings WHERE id = 'singleton'`)
      .get() as { setup_completed_at: number | null };
    expect(row.setup_completed_at).toBeNull();
  });

  it('cannot be driven by somebody who is not signed in', async () => {
    const h = harness();
    const token = h.setupToken.current();
    await h.call(`/setup?token=${token.token}`);
    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });

    // Drop the session but keep the setup cookie: the token must not stand in
    // for a session once an account exists.
    h.jar.delete('better-auth.session_token');

    const response = await h.form('/setup/household', { timezone: 'Europe/London' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in');
  });

  it('never renders with nothing selected, even when detection lands on UTC', async () => {
    // `docker run` with no TZ set is exactly this: `resolvedOptions().timeZone`
    // returns 'UTC', and neither 'UTC' nor 'Etc/UTC' is among the 418 zones
    // `Intl.supportedValuesOf('timeZone')` offers — so a browser with nothing
    // marked `selected` picks the first option alphabetically instead.
    const h = harness();
    const token = h.setupToken.current();
    await h.call(`/setup?token=${token.token}`);
    await h.form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });

    const originalTz = process.env.TZ;
    process.env.TZ = '';
    let html: string;
    try {
      const response = await h.call('/setup');
      expect(response.status).toBe(200);
      html = await response.text();
    } finally {
      process.env.TZ = originalTz;
    }

    const selectedOptions = [...html.matchAll(/<option value="([^"]*)" selected>/g)];
    expect(selectedOptions).toHaveLength(1);
    const value = selectedOptions[0]?.[1];

    // A preselected value the form's own schema then refuses is the same bug
    // read from the other side.
    const submit = await h.form('/setup/household', { timezone: value ?? '' });
    expect(submit.status).toBe(302);
  });
});

describe('step 3 — the calendar', () => {
  it('tests a real feed, stores it encrypted, and schedules the sync', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    const url = await icsServer();

    const response = await h.form('/setup/calendar', {
      name: 'Family',
      url,
      allow_loopback: '1',
      allow_http: '1',
    });
    expect(response.status).toBe(302);
    // On to step 4 — a location and a first person — rather than straight to
    // the last page (RFC 009 Phase 2).
    expect(response.headers.get('location')).toBe('/setup/place');

    const source = h.db
      .prepare('SELECT name, url_encrypted, url_host FROM calendar_sources')
      .get() as { name: string; url_encrypted: string; url_host: string };
    expect(source.name).toBe('Family');
    expect(source.url_host).toBe('127.0.0.1');
    // Rule six, and the path is the credential.
    expect(source.url_encrypted).not.toContain('feed.ics');
    expect(source.url_encrypted.startsWith('mw1.')).toBe(true);

    const job = h.db.prepare(`SELECT COUNT(*) AS n FROM job_state WHERE kind = 'ics-sync'`).get();
    expect(job).toEqual({ n: 1 });
  });

  it('refuses a loopback feed unless the box is ticked, and says what to do', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    const url = await icsServer();

    // Plain http is ticked but loopback is not, so loopback is the thing being
    // refused. Leaving both off refuses the http first and tests nothing here.
    const response = await h.form('/setup/calendar', { name: 'Family', url, allow_http: '1' });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('allow loopback');
    // Nothing stored on a failure. A source that exists but has never worked
    // is worse than none: the wizard claims success and the wall stays empty.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
  });

  it('explains a web page offered in place of a calendar', async () => {
    // The mistake everyone makes: Google shows a public HTML link and a secret
    // iCal link side by side.
    const h = harness();
    await completeThroughTimezone(h);
    const url = await icsServer('<!doctype html><h1>Not a calendar</h1>', 'text/html');

    const response = await h.form('/setup/calendar', {
      name: 'Family', url, allow_loopback: '1', allow_http: '1',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('.ics');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
  });

  it('can be skipped, and setup stays complete', async () => {
    const h = harness();
    await completeThroughTimezone(h);

    // Skipping is a plain link to the last page — no calendar required, because
    // a feed failing is not a reason to leave a household stuck in a wizard.
    const done = await h.call('/setup/done');
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('No calendars yet');
    expect((await h.call('/')).status).toBe(200);
  });
});

/*
 * Step 4 — where the wall is, and who lives there (RFC 009 Phase 2).
 *
 * The two prerequisites for the two widgets the default canvas already draws.
 * Optional throughout, which is most of what is asserted here: what a household
 * who skips it is left with has to be a coherent wall rather than a half-armed
 * one.
 */
describe('step 4 — where and who', () => {
  it('stores a location and the first person, and finishes', async () => {
    const h = harness();
    await completeThroughTimezone(h);

    const response = await h.form('/setup/place', {
      latitude: '38.8894',
      longitude: '-97.7431',
      person: 'Sam',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/setup/done');

    expect(
      h.db
        .prepare(`SELECT latitude, longitude FROM household_settings WHERE id = 'singleton'`)
        .get(),
    ).toEqual({ latitude: 38.8894, longitude: -97.7431 });
    expect(h.db.prepare('SELECT name, color FROM people').all()).toEqual([
      { name: 'Sam', color: '#4C7FD1' },
    ]);
  });

  it('refuses half a location without losing the other half or the name', async () => {
    const h = harness();
    await completeThroughTimezone(h);

    // Half a location stores as none, so it is refused rather than dropped.
    const response = await h.form('/setup/place', { latitude: '38.8894', person: 'Sam' });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('both numbers');
    // Echoed back, the way every other step in this wizard does it.
    expect(body).toContain('38.8894');
    expect(body).toContain('Sam');
    // And nothing written on a refusal — not the person either, or a retry
    // would leave two of them.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 0 });
    expect(
      h.db.prepare(`SELECT latitude FROM household_settings WHERE id = 'singleton'`).get(),
    ).toEqual({ latitude: null });
  });

  it('takes a person on their own, with no location', async () => {
    const h = harness();
    await completeThroughTimezone(h);

    const response = await h.form('/setup/place', { latitude: '', longitude: '', person: 'Sam' });
    expect(response.status).toBe(302);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
    expect(
      h.db.prepare(`SELECT latitude FROM household_settings WHERE id = 'singleton'`).get(),
    ).toEqual({ latitude: null });
  });

  it('is skippable, and a household who skips it has no armed weather rule', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    seedDefaultRules(h.db);

    // Skip is a plain link, like step 3's.
    expect((await h.call('/setup/done')).status).toBe(200);

    /*
     * The whole point of the step existing. The shipped National Weather
     * Service ladder is switched on in the database — that is deliberate, so a
     * household who sets a location later inherits it — and it is *armed*
     * only once there is somewhere to watch. Five rules reporting themselves
     * as working against zero zones is a safety-adjacent feature that is inert
     * and does not say so.
     */
    const armed = readRules(h.db).filter((rule) => rule.source === 'nws' && rule.enabled);
    expect(armed).toEqual([]);
    // Stored on, all the same: nothing rewrote the household's own switches.
    const stored = h.db
      .prepare(`SELECT COUNT(*) AS n FROM interrupt_rules WHERE trigger = 'nws' AND enabled = 1`)
      .get();
    expect(stored).toEqual({ n: 4 });
  });

  it('arms the shipped weather ladder the moment a location exists', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    seedDefaultRules(h.db);

    await h.form('/setup/place', { latitude: '38.8894', longitude: '-97.7431' });

    const armed = readRules(h.db).filter((rule) => rule.source === 'nws' && rule.enabled);
    expect(armed.map((rule) => rule.id).sort()).toEqual(
      DEFAULT_ALERT_RULES.filter((rule) => rule.enabled).map((rule) => rule.id).sort(),
    );
  });

  it('cannot be driven by somebody who is not signed in', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    h.jar.clear();

    const shown = await h.call('/setup/place');
    expect(shown.status).toBe(302);
    expect(shown.headers.get('location')).toBe('/admin/sign-in');

    const posted = await h.form('/setup/place', { latitude: '1', longitude: '1' });
    expect(posted.status).toBe(302);
    expect(posted.headers.get('location')).toBe('/admin/sign-in');
    expect(
      h.db.prepare(`SELECT latitude FROM household_settings WHERE id = 'singleton'`).get(),
    ).toEqual({ latitude: null });
  });
});

describe('after setup', () => {
  it('sends the wizard to the last page rather than starting again', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    const response = await h.call('/setup');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/setup/done');
  });

  it('signs in again from the sign-in form', async () => {
    const h = harness();
    await completeThroughTimezone(h);
    h.jar.clear();

    expect((await h.call('/admin')).status).toBe(302);
    // The form itself must be reachable, or the redirect is a loop.
    expect((await h.call('/admin/sign-in')).status).toBe(200);

    const response = await h.form('/admin/sign-in', {
      email: 'family@home.local',
      password: 'correct-horse-battery',
    });
    expect(response.status).toBe(302);
    expect((await h.call('/admin')).status).not.toBe(302);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    // Otherwise this tells anyone who can reach the port which address is the
    // household's.
    const h = harness();
    await completeThroughTimezone(h);
    h.jar.clear();

    const wrongPassword = await h.form('/admin/sign-in', {
      email: 'family@home.local', password: 'not-the-password',
    });
    const unknownEmail = await h.form('/admin/sign-in', {
      email: 'nobody@home.local', password: 'not-the-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);

    // The pages differ only where they echo back what was typed, which is not
    // a signal. What must match is the reason given.
    const reason = (body: string): string =>
      body.slice(body.indexOf('<strong>'), body.indexOf('</strong>'));
    expect(reason(await wrongPassword.text())).toBe(reason(await unknownEmail.text()));
  });
});

/**
 * Skipping the bootstrap code under trusted Home Assistant ingress.
 *
 * On the add-on the supervisor has already authenticated the household, so
 * reaching `/setup` from its socket source is itself proof of owning the box —
 * the same argument the post-setup gate already makes. These prove the skip
 * fires only for a genuine supervisor request and fails closed to demanding the
 * code for everything else: a plain docker run, a forged header from a LAN
 * device, or no ingress at all. Driven with a real socket source, the one thing
 * a header cannot forge.
 */
const INGRESS = '/api/hassio_ingress/SESSIONTOKEN';

function ingressHarness(opts: { isAddon?: boolean } = {}) {
  const idx = ++nextAddress;
  // Distinct per harness: a distinct database, and a distinct supervisor address
  // so each account creation lands in its own rate-limit bucket (the buckets are
  // module-global and outlive the database — a documented trap in this codebase).
  const sup = `172.30.${idx}.2`;
  const base = `10.8.${idx}.1`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wizard-ing-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  let source: string | undefined = base;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'w'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => source,
    ingressTrust: { isAddon: opts.isAddon ?? true, sources: [sup] },
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (
    path: string,
    init: RequestInit & { from?: string; ingress?: string } = {},
  ): Promise<Response> => {
    source = init.from ?? base;
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    if (init.ingress !== undefined) headers.set(INGRESS_HEADER, init.ingress);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const post = (
    path: string,
    fields: Record<string, string>,
    init: { from?: string; ingress?: string } = {},
  ): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      ...init,
    });

  const userCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n;

  return { db, call, post, jar, sup, userCount };
}

const ACCOUNT = {
  name: 'Household',
  email: 'ingress@home.local',
  password: 'correct-horse-battery',
  confirm: 'correct-horse-battery',
};

describe('first run under trusted Home Assistant ingress', () => {
  it('shows the account form, not the code, when the supervisor forwards it', async () => {
    const h = ingressHarness();
    const body = await (await h.call('/setup', { from: h.sup, ingress: INGRESS })).text();
    expect(body).toContain('Create your account');
    expect(body).not.toContain('Enter the setup code');
    expect(body).toContain('reached this through Home Assistant');
  });

  it('creates the only account with no code and no cookie', async () => {
    const h = ingressHarness();
    const res = await h.post('/setup/account', ACCOUNT, { from: h.sup, ingress: INGRESS });
    expect(res.status).toBe(302);
    expect(h.userCount()).toBe(1);
  });

  it('still demands the code for a plain docker run (not an add-on)', async () => {
    const h = ingressHarness({ isAddon: false });
    const body = await (await h.call('/setup', { from: h.sup, ingress: INGRESS })).text();
    expect(body).toContain('Enter the setup code');
    const res = await h.post('/setup/account', ACCOUNT, { from: h.sup, ingress: INGRESS });
    expect(res.status).toBe(403);
    expect(h.userCount()).toBe(0);
  });

  it('still demands the code when the ingress header is forged from a LAN device', async () => {
    const h = ingressHarness();
    // Right header, wrong socket source — the exact forgery the pin defends.
    const body = await (await h.call('/setup', { from: '10.0.0.9', ingress: INGRESS })).text();
    expect(body).toContain('Enter the setup code');
    const res = await h.post('/setup/account', ACCOUNT, { from: '10.0.0.9', ingress: INGRESS });
    expect(res.status).toBe(403);
    expect(h.userCount()).toBe(0);
  });

  it('still demands the code with no ingress header, even from the supervisor address', async () => {
    const h = ingressHarness();
    const body = await (await h.call('/setup', { from: h.sup })).text();
    expect(body).toContain('Enter the setup code');
    const res = await h.post('/setup/account', ACCOUNT, { from: h.sup });
    expect(res.status).toBe(403);
    expect(h.userCount()).toBe(0);
  });

  it('does not create a second account, even from the supervisor', async () => {
    const h = ingressHarness();
    expect((await h.post('/setup/account', ACCOUNT, { from: h.sup, ingress: INGRESS })).status).toBe(302);
    h.jar.clear();
    const res = await h.post(
      '/setup/account',
      { ...ACCOUNT, email: 'second@home.local' },
      { from: h.sup, ingress: INGRESS },
    );
    expect(res.status).toBe(403);
    expect(h.userCount()).toBe(1);
  });
});

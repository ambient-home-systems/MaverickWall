import { afterAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueCompanionToken } from '../src/api/companion.js';
import { createFixedWindow, createSignInLimits, createSignInLog, SIGN_IN_LOG_SIZE } from '../src/auth/lockouts.js';
import { addressWords, leftWords } from '../src/http/admin-lockouts.js';

/**
 * The Lockouts screen (plan item M8.3), against the real app, the real Better
 * Auth and a temporary database.
 *
 * Every lock here is reached the way a household meets it — wrong passwords
 * typed at the sign-in page, wrong pairing codes, a phone shortcut with an old
 * token, wrong codes at the second step — and every release is proved by the
 * next request through the very door that refused, not by the screen saying
 * so. The screen's promise of "addresses only" is read off its own HTML: the
 * email typed at a refused sign-in is never on it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SECRET = 'b'.repeat(32);
const PASSWORD = 'correct-horse-battery';
const roots: string[] = [];
let household = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Call = (path: string, init?: RequestInit & { from?: string }) => Promise<Response>;

interface Person {
  readonly call: Call;
  readonly form: (path: string, fields: Record<string, string>, from?: string) => Promise<Response>;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly person: () => Person;
  readonly admin: Person;
  readonly adminEmail: string;
  readonly adminId: string;
  readonly address: () => string;
}

async function harness(): Promise<Harness> {
  const n = ++household;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-lockouts-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);

  let addresses = 0;
  const address = (): string => `10.60.${n}.${(++addresses % 250) + 1}`;
  let source: string | undefined;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: SECRET, baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => source,
    setupToken,
    dataDir,
  });

  const person = (): Person => {
    const jar = new Map<string, string>();
    const call: Call = async (path, init = {}) => {
      source = init.from ?? address();
      const headers = new Headers(init.headers);
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie !== '') headers.set('cookie', cookie);
      const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const [name, ...rest] = (pair ?? '').split('=');
        if (name === undefined || name === '') continue;
        const value = rest.join('=');
        if (value === '' || /max-age=0/i.test(raw)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const form = (path: string, fields: Record<string, string>, from?: string): Promise<Response> =>
      call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        ...(from === undefined ? {} : { from }),
      });
    return { call, form };
  };

  const admin = person();
  const adminEmail = `admin${n}@home.local`;
  await admin.call(`/setup?token=${setupToken.current().token}`);
  await admin.form('/setup/account', { name: 'Sam', email: adminEmail, password: PASSWORD, confirm: PASSWORD });
  await admin.form('/setup/household', { timezone: 'Europe/London' });
  const adminId = (db.prepare('SELECT id FROM user WHERE email = ?').get(adminEmail) as { id: string }).id;
  return { db, person, admin, adminEmail, adminId, address };
}

/** RFC 6238, from the key the setup page shows: what a code app computes. */
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.replace(/[\s=]/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', bytes).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

/** The "Locked now" section of the page, so a row in the attempts table cannot pass for a lock. */
function lockedNow(html: string): string {
  const start = html.indexOf('<h2>Locked now</h2>');
  const end = html.indexOf('<h2>Recent sign-in attempts</h2>');
  return start < 0 || end < 0 ? '' : html.slice(start, end);
}

describe('the screen is behind the session (M8.3)', () => {
  it('sends a signed-out browser to sign in, and does not open a path that merely starts like the sign-in page', async () => {
    const h = await harness();
    const stranger = h.person();
    const page = await stranger.call('/admin/lockouts');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toContain('sign-in');
    // `/admin/sign-in` is open; a path that only begins with those letters is not.
    const lookalike = await stranger.call('/admin/sign-ins');
    expect(lookalike.status).toBe(302);
    expect(lookalike.headers.get('location')).toContain('sign-in?next=');
    // And the real second step still is, with no session.
    expect((await stranger.call('/admin/sign-in/code')).status).toBe(200);
  });

  it('shows a view-only account the screen and refuses it the release', async () => {
    const h = await harness();
    const add = await h.admin.form('/admin/accounts', {
      name: 'Alex',
      email: 'viewer@home.local',
      password: PASSWORD,
      role: 'viewer',
    });
    expect(add.status).toBe(302);
    const viewer = h.person();
    expect((await viewer.form('/admin/sign-in', { email: 'viewer@home.local', password: PASSWORD })).status).toBe(302);
    expect((await viewer.call('/admin/lockouts')).status).toBe(200);
    expect((await viewer.form('/admin/lockouts/release', { kind: 'sign-in', key: '10.0.0.1' })).status).toBe(403);
  });
});

describe('sign-in attempts and the sign-in limit (M8.3)', () => {
  it('lists each attempt by address and outcome, and never the email typed', async () => {
    const h = await harness();
    const visitor = h.person();
    const typed = 'someone-else@example.org';
    expect((await visitor.form('/admin/sign-in', { email: typed, password: 'wrong-password-1' }, '10.9.9.9')).status).toBe(401);
    expect((await visitor.form('/admin/sign-in', { email: h.adminEmail, password: PASSWORD }, '10.9.9.8')).status).toBe(302);

    const html = await (await h.admin.call('/admin/lockouts')).text();
    expect(html).toContain('10.9.9.9');
    expect(html).toContain('10.9.9.8');
    expect(html).toContain('Refused');
    expect(html).toContain('Signed in');
    expect(html).not.toContain(typed);
    expect(html).not.toContain(h.adminEmail);
    expect(html).not.toContain('wrong-password-1');
  });

  it('lists an address told to wait, and a release lets its very next sign-in through', async () => {
    const h = await harness();
    const visitor = h.person();
    const from = '10.7.7.7';
    for (let i = 0; i < 3; i += 1) {
      expect((await visitor.form('/admin/sign-in', { email: h.adminEmail, password: 'not-it-at-all' }, from)).status).toBe(401);
    }
    const waited = await visitor.form('/admin/sign-in', { email: h.adminEmail, password: PASSWORD }, from);
    expect(waited.status).toBe(429);

    const before = await (await h.admin.call('/admin/lockouts')).text();
    expect(lockedNow(before)).toContain('Signing in');
    expect(lockedNow(before)).toContain(from);
    expect(before).toContain('Told to wait');

    const released = await h.admin.form('/admin/lockouts/release', { kind: 'sign-in', key: from });
    expect(released.status).toBe(302);
    expect(released.headers.get('location')).toContain('saved=lockout-released');
    expect(lockedNow(await (await h.admin.call('/admin/lockouts')).text())).not.toContain(from);

    // Inside the same ten seconds, the right password from the same address now signs in.
    expect((await visitor.form('/admin/sign-in', { email: h.adminEmail, password: PASSWORD }, from)).status).toBe(302);
  });

  it('says so when what it was asked to release had already run out', async () => {
    const h = await harness();
    const answer = await h.admin.form('/admin/lockouts/release', { kind: 'pairing', key: '10.1.2.3' });
    expect(answer.headers.get('location')).toContain('saved=lockout-already-free');
    expect((await h.admin.form('/admin/lockouts/release', { kind: 'door', key: 'x' })).status).toBe(400);
  });
});

describe('the other doors (M8.3)', () => {
  it('lists a phone told to wait, refused even with the right token, and lets it back in on release', async () => {
    const h = await harness();
    const token = issueCompanionToken(h.db, createKeyring(randomBytes(32)), h.adminId, Date.now());
    const phone = h.person();
    const from = '10.5.5.5';
    const send = (bearer: string): Promise<Response> =>
      phone.call('/companion/messages', {
        method: 'POST',
        from,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Back at 6', minutes: 30 }),
      });
    for (let i = 0; i < 20; i += 1) expect((await send('mwc_wrongwrongwrongwrong')).status).toBe(401);
    expect((await send(token)).status).toBe(429);

    const html = await (await h.admin.call('/admin/lockouts')).text();
    expect(lockedNow(html)).toContain('The phone token');
    expect(lockedNow(html)).toContain(from);
    expect(html).not.toContain(token);

    await h.admin.form('/admin/lockouts/release', { kind: 'phone-token', key: from });
    expect((await send(token)).status).toBe(200);
  });

  it('lists a wall told to stop guessing pairing codes, and lets it type again on release', async () => {
    const h = await harness();
    const wall = h.person();
    const from = '10.4.4.4';
    for (let i = 0; i < 20; i += 1) expect((await wall.form('/pair', { code: 'ABCD-1234' }, from)).status).toBe(400);
    expect((await wall.form('/pair', { code: 'ABCD-1234' }, from)).status).toBe(429);

    const html = await (await h.admin.call('/admin/lockouts')).text();
    expect(lockedNow(html)).toContain('Pairing a wall');
    expect(lockedNow(html)).toContain(from);

    await h.admin.form('/admin/lockouts/release', { kind: 'pairing', key: from });
    expect((await wall.form('/pair', { code: 'ABCD-1234' }, from)).status).toBe(400);
  });

  it('lists an account whose two-step codes are locked, and a release lets the right code through', async () => {
    const h = await harness();
    const start = await h.admin.form('/admin/account/two-step/start', { password: PASSWORD });
    const key = (/Key: <code>([A-Z2-7 ]+)<\/code>/.exec(await start.text())?.[1] ?? '').replace(/\s/g, '');
    expect(key).not.toBe('');
    expect((await h.admin.form('/admin/account/two-step/confirm', { code: totp(key) })).status).toBe(302);

    const phone = h.person();
    const wrong = totp(key) === '000000' ? '111111' : '000000';
    /*
     * The plugin allows five codes to one sign-in and then wants the password
     * again, so ten wrong codes in a row — what locks the account — is two
     * sign-ins' worth. Each request from its own address, so the per-address
     * limit is never what stops it.
     */
    for (let round = 0; round < 2; round += 1) {
      expect((await phone.form('/admin/sign-in', { email: h.adminEmail, password: PASSWORD })).status).toBe(302);
      for (let i = 0; i < 5; i += 1) expect((await phone.form('/admin/sign-in/code', { code: wrong })).status).toBe(401);
    }
    expect((await phone.form('/admin/sign-in', { email: h.adminEmail, password: PASSWORD })).status).toBe(302);
    const locked = await phone.form('/admin/sign-in/code', { code: totp(key) });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain('Try again in 15 minutes');

    const html = await (await h.admin.call('/admin/lockouts')).text();
    expect(lockedNow(html)).toContain('Two-step codes for Sam');

    await h.admin.form('/admin/lockouts/release', { kind: 'two-step', key: h.adminId });
    expect(
      h.db.prepare('SELECT failed_verification_count AS n, locked_until AS until FROM two_factor WHERE user_id = ?').get(h.adminId),
    ).toEqual({ n: 0, until: null });
    expect((await phone.form('/admin/sign-in/code', { code: totp(key) })).status).toBe(302);
  });
});

describe('the parts (M8.3)', () => {
  it('counts the sign-in limit the way the library does, and releases by address', async () => {
    let at = 1_000_000;
    const limits = createSignInLimits(() => at);
    const rule = { window: 10, max: 3 };
    for (let i = 0; i < 3; i += 1) expect((await limits.consume('10.0.0.1|/sign-in/email', rule)).allowed).toBe(true);
    const refused = await limits.consume('10.0.0.1|/sign-in/email', rule);
    expect(refused).toEqual({ allowed: false, retryAfter: 10 });
    // A refused request does not move the window.
    at += 9_000;
    expect((await limits.consume('10.0.0.1|/sign-in/email', rule)).allowed).toBe(false);
    expect(limits.held(at)).toEqual([{ address: '10.0.0.1', until: 1_010_000 }]);
    at += 1_000;
    expect((await limits.consume('10.0.0.1|/sign-in/email', rule)).allowed).toBe(true);

    for (let i = 0; i < 3; i += 1) await limits.consume('fe80::1|/two-factor/verify-totp', rule);
    expect(limits.held(at).map((held) => held.address)).toEqual(['fe80::1']);
    expect(limits.release('fe80::1')).toBe(true);
    expect(limits.release('fe80::1')).toBe(false);
    expect((await limits.consume('fe80::1|/two-factor/verify-totp', rule)).allowed).toBe(true);
  });

  it('holds a fixed window from the count that would refuse the next try, and forgets what has passed', () => {
    const window = createFixedWindow(60_000, 2);
    expect(window.hit('a', 0)).toBe(false);
    expect(window.held(0)).toEqual([]);
    expect(window.hit('a', 1)).toBe(false);
    expect(window.held(1)).toEqual([{ key: 'a', until: 60_000 }]);
    expect(window.hit('a', 2)).toBe(true);
    expect(window.held(60_001)).toEqual([]);
    expect(window.release('a')).toBe(false);
  });

  it('keeps the newest hundred attempts of the last day', () => {
    const log = createSignInLog();
    for (let i = 0; i < SIGN_IN_LOG_SIZE + 5; i += 1) {
      log.record({ at: i, address: `10.0.0.${i % 250}`, step: 'password', outcome: 'refused' });
    }
    expect(log.recent(1_000)).toHaveLength(SIGN_IN_LOG_SIZE);
    expect(log.recent(1_000)[0]?.at).toBe(SIGN_IN_LOG_SIZE + 4);
    expect(log.recent(25 * 60 * 60_000)).toEqual([]);
  });

  it('says an address it cannot read, and how long is left', () => {
    expect(addressWords(undefined)).toBe('an address that could not be read');
    expect(addressWords('no-trusted-ip')).toBe('an address that could not be read');
    expect(addressWords('shared')).toBe('an address that could not be read');
    expect(addressWords('192.168.1.40')).toBe('192.168.1.40');
    expect(leftWords(8_000)).toBe('under a minute');
    expect(leftWords(61_000)).toBe('2 minutes');
    expect(leftWords(60_000)).toBe('1 minute');
  });
});

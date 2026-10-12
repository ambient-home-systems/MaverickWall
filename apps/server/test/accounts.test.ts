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
import { clearTwoFactor, deleteAccount, ingressAccount, setRole } from '../src/api/accounts.js';
import { viewerMay } from '../src/auth/roles.js';
import { recoveryCodeStore } from '../src/auth/two-factor.js';
import { secretOf } from '../src/http/admin-accounts.js';

/**
 * Accounts (plan items M8.1 and M8.2), against the real app, the real Better
 * Auth and a temporary database: several people, each with their own cookie
 * jar, signing in through the same forms a household uses.
 *
 * The two promises are the ones a household is given. A view-only account can
 * look at everything and change nothing — so the assertions read the database
 * after each refused write, because a 403 over a change that went through
 * anyway is the fault that matters. And two-step sign-in asks for a code after
 * the password and keeps its recovery codes as hashes — so the column is read
 * for the codes the page showed, and none is in it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SECRET = 'a'.repeat(32);
const SUPERVISOR = '172.30.32.2';
const PASSWORD = 'correct-horse-battery';
const roots: string[] = [];
let household = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Call = (path: string, init?: RequestInit & { from?: string; ingress?: string }) => Promise<Response>;

interface Person {
  readonly call: Call;
  readonly form: (path: string, fields: Record<string, string>, from?: string) => Promise<Response>;
  readonly jar: Map<string, string>;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly person: () => Person;
  readonly admin: Person;
  readonly adminEmail: string;
  readonly adminId: string;
  /** A fresh address each time, so Better Auth's per-address limits are never what a test meets. */
  readonly address: () => string;
}

async function harness(): Promise<Harness> {
  const n = ++household;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-accounts-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);

  let addresses = 0;
  const address = (): string => `10.40.${n}.${(++addresses % 250) + 1}`;
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
    ingressTrust: { isAddon: true, sources: [SUPERVISOR] },
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
      if (init.ingress !== undefined) headers.set('x-ingress-path', init.ingress);
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
    return { call, form, jar };
  };

  const admin = person();
  const adminEmail = `admin${n}@home.local`;
  await admin.call(`/setup?token=${setupToken.current().token}`);
  await admin.form('/setup/account', { name: 'Sam', email: adminEmail, password: PASSWORD, confirm: PASSWORD });
  await admin.form('/setup/household', { timezone: 'Europe/London' });
  const adminId = (db.prepare('SELECT id FROM user WHERE email = ?').get(adminEmail) as { id: string }).id;
  return { db, person, admin, adminEmail, adminId, address };
}

async function signIn(p: Person, email: string, password = PASSWORD): Promise<Response> {
  return p.form('/admin/sign-in', { email, password });
}

async function addAccount(h: Harness, email: string, role: 'admin' | 'viewer', name = 'Alex'): Promise<string> {
  const response = await h.admin.form('/admin/accounts', { name, email, password: PASSWORD, role });
  expect(response.status, await response.clone().text()).toBe(302);
  return (h.db.prepare('SELECT id FROM user WHERE email = ?').get(email) as { id: string }).id;
}

/** RFC 6238, from the secret the setup page shows: what a code app computes. */
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

describe('roles (M8.1)', () => {
  it('makes the wizard’s account the admin, and adds a view-only account through the screen', async () => {
    const h = await harness();
    expect(h.db.prepare('SELECT role FROM user WHERE id = ?').get(h.adminId)).toEqual({ role: 'admin' });
    const id = await addAccount(h, 'viewer@home.local', 'viewer');
    expect(h.db.prepare('SELECT role, name FROM user WHERE id = ?').get(id)).toEqual({ role: 'viewer', name: 'Alex' });

    const list = await (await h.admin.call('/admin/accounts')).text();
    expect(list).toContain('viewer@home.local');
    expect(list).toContain('View only');
    // The add form refuses a short password and hands the rest back, never the password.
    const refused = await h.admin.form('/admin/accounts', {
      name: 'Pat',
      email: 'pat@home.local',
      password: 'short',
      role: 'viewer',
    });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('pat@home.local');
    expect(page).not.toContain('value="short"');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM user').get()).toEqual({ n: 2 });
  });

  it('lets a view-only account look at everything and change nothing', async () => {
    const h = await harness();
    await addAccount(h, 'viewer@home.local', 'viewer');
    const viewer = h.person();
    expect((await signIn(viewer, 'viewer@home.local')).status).toBe(302);

    for (const path of ['/admin', '/admin/calendars', '/admin/walls', '/admin/system', '/admin/accounts']) {
      const response = await viewer.call(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain('You are signed in with a view-only account.');
      expect(html, path).toContain('<small>View only</small>');
    }

    const before = h.db.prepare(`SELECT timezone FROM household_settings`).get();
    const write = await viewer.form('/admin/system/timezone', { timezone: 'America/Chicago' });
    expect(write.status).toBe(403);
    expect(await write.text()).toContain('can look at everything but not change anything');
    expect(h.db.prepare(`SELECT timezone FROM household_settings`).get()).toEqual(before);

    const add = await viewer.form('/admin/accounts', {
      name: 'Mallory',
      email: 'mallory@home.local',
      password: PASSWORD,
      role: 'admin',
    });
    expect(add.status).toBe(403);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM user WHERE email = 'mallory@home.local'`).get()).toEqual({ n: 0 });

    // The reads that hand out a key are refused too.
    for (const path of ['/admin/system/key', '/admin/system/backup', '/admin/companion', '/admin/walls/any/pair', '/admin/epaper/any/url']) {
      expect((await viewer.call(path)).status, path).toBe(403);
    }
    // An admin is never refused by the gate.
    expect((await h.admin.call('/admin/companion')).status).toBe(200);
    expect((await h.admin.form('/admin/system/timezone', { timezone: 'America/Chicago' })).status).toBe(302);
  });

  it('lets a view-only account change its own password', async () => {
    const h = await harness();
    await addAccount(h, 'viewer@home.local', 'viewer');
    const viewer = h.person();
    await signIn(viewer, 'viewer@home.local');
    const changed = await viewer.form('/admin/account/password', { current: PASSWORD, password: 'a-new-long-password' });
    expect(changed.status).toBe(302);
    expect(changed.headers.get('location')).toContain('saved=account-password-changed');
    expect((await signIn(h.person(), 'viewer@home.local', 'a-new-long-password')).status).toBe(302);
    expect((await signIn(h.person(), 'viewer@home.local')).status).toBe(401);
  });

  it('reads the role on every request, so a change takes effect on the next page', async () => {
    const h = await harness();
    const id = await addAccount(h, 'viewer@home.local', 'viewer');
    const viewer = h.person();
    await signIn(viewer, 'viewer@home.local');
    expect((await viewer.form('/admin/system/timezone', { timezone: 'Asia/Tokyo' })).status).toBe(403);
    expect((await h.admin.form(`/admin/accounts/${id}/role`, { role: 'admin' })).status).toBe(302);
    expect((await viewer.form('/admin/system/timezone', { timezone: 'Asia/Tokyo' })).status).toBe(302);
    expect(h.db.prepare(`SELECT timezone FROM household_settings`).get()).toEqual({ timezone: 'Asia/Tokyo' });
  });

  it('refuses a view-only account’s companion token, and brings it back with the role', async () => {
    const h = await harness();
    const id = await addAccount(h, 'viewer@home.local', 'viewer');
    const token = issueCompanionToken(h.db, createKeyring(randomBytes(32)), id, Date.now());
    const phone = h.person();
    const ask = (): Promise<Response> =>
      phone.call('/companion/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Back at 6', minutes: 30 }),
      });
    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('view-only');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    setRole(h.db, id, 'admin');
    expect((await ask()).status).toBe(200);
  });

  it('always leaves an admin, and never lets an admin remove themselves', async () => {
    const h = await harness();
    const viewerId = await addAccount(h, 'viewer@home.local', 'viewer');
    expect(setRole(h.db, h.adminId, 'viewer')).toMatchObject({ ok: false });
    expect(deleteAccount(h.db, h.adminId, viewerId)).toMatchObject({ ok: false });
    expect(deleteAccount(h.db, h.adminId, h.adminId)).toMatchObject({ ok: false });
    const second = await addAccount(h, 'second@home.local', 'admin', 'Jo');
    // With two admins the last-admin guard no longer refuses, so this is the
    // self rule alone.
    expect(deleteAccount(h.db, h.adminId, h.adminId)).toMatchObject({ ok: false });
    expect(setRole(h.db, h.adminId, 'viewer')).toEqual({ ok: true });
    expect(setRole(h.db, second, 'viewer')).toMatchObject({ ok: false });
  });

  it('signs a removed account out everywhere', async () => {
    const h = await harness();
    const id = await addAccount(h, 'viewer@home.local', 'viewer');
    const viewer = h.person();
    await signIn(viewer, 'viewer@home.local');
    expect((await viewer.call('/admin')).status).toBe(200);
    expect((await h.admin.form(`/admin/accounts/${id}/remove`, {})).status).toBe(302);
    const after = await viewer.call('/admin');
    expect(after.status).toBe(302);
    expect(after.headers.get('location')).toContain('/admin/sign-in');
    for (const table of ['user', 'session', 'account']) {
      const column = table === 'user' ? 'id' : 'user_id';
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id), table).toEqual({ n: 0 });
    }
  });

  it('keeps a public sign-up closed once an account exists', async () => {
    const h = await harness();
    const response = await h.person().call('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ name: 'X', email: 'x@home.local', password: PASSWORD }),
    });
    expect(response.status).toBe(403);
  });
});

describe('Home Assistant’s sidebar with several accounts (M8.1, MQ6)', () => {
  const PREFIX = '/api/hassio_ingress/SESSIONTOKEN';

  it('signs in as the one account, as before, and asks for a password once there are two', async () => {
    const h = await harness();
    const visitor = h.person();
    expect((await visitor.call('/admin', { from: SUPERVISOR, ingress: PREFIX })).status).toBe(200);
    expect(ingressAccount(h.db)?.id).toBe(h.adminId);

    await addAccount(h, 'viewer@home.local', 'viewer');
    const refused = await visitor.call('/admin', { from: SUPERVISOR, ingress: PREFIX });
    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toContain('sign-in');
  });

  it('signs in as the account named, with that account’s role', async () => {
    const h = await harness();
    const id = await addAccount(h, 'viewer@home.local', 'viewer');
    expect((await h.admin.form('/admin/accounts/sidebar', { account: id })).status).toBe(302);
    const visitor = h.person();
    const page = await visitor.call('/admin', { from: SUPERVISOR, ingress: PREFIX });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<b>Alex</b>');
    const write = await visitor.form('/admin/system/timezone', { timezone: 'Asia/Tokyo' }, SUPERVISOR);
    // Without the ingress header the same address is a stranger with no cookie,
    // sent to sign in; with it, it is the sidebar, and refused as view-only.
    expect(write.status).toBe(302);
    expect(write.headers.get('location')).toContain('sign-in');
    const viaSidebar = await visitor.call('/admin/system/timezone', {
      method: 'POST',
      from: SUPERVISOR,
      ingress: PREFIX,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'timezone=Asia%2FTokyo',
    });
    expect(viaSidebar.status).toBe(403);
    expect(h.db.prepare(`SELECT timezone FROM household_settings`).get()).toEqual({ timezone: 'Europe/London' });

    // Removing the named account names nobody, rather than falling back to whoever is left.
    expect((await h.admin.form(`/admin/accounts/${id}/remove`, {})).status).toBe(302);
    expect(h.db.prepare(`SELECT ingress_user_id AS id FROM household_settings`).get()).toEqual({ id: null });
  });
});

describe('two-step sign-in (M8.2)', () => {
  /** Turn it on from the account page as a household does, and hand back the key and the codes it showed. */
  async function turnOn(h: Harness, p: Person): Promise<{ key: string; codes: string[] }> {
    const start = await p.form('/admin/account/two-step/start', { password: PASSWORD });
    expect(start.status, await start.clone().text()).toBe(200);
    const html = await start.text();
    expect(html).toContain('<div class="qr"><svg');
    const key = (/Key: <code>([A-Z2-7 ]+)<\/code>/.exec(html)?.[1] ?? '').replace(/\s/g, '');
    expect(key.length).toBeGreaterThanOrEqual(16);
    const codes = [...html.matchAll(/<li><code>([A-Za-z0-9]{5}-[A-Za-z0-9]{5})<\/code><\/li>/g)].map((m) => m[1] ?? '');
    expect(codes).toHaveLength(10);
    // Not on until a code from the app has matched.
    expect(h.db.prepare('SELECT two_factor_enabled AS on_ FROM user WHERE id = ?').get(h.adminId)).toEqual({ on_: 0 });
    const wrong = await p.form('/admin/account/two-step/confirm', { code: '000000' === totp(key) ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    // A mistyped code draws the same setup again, so the QR need not be scanned twice.
    expect(await wrong.text()).toContain(codes[0]);
    const confirmed = await p.form('/admin/account/two-step/confirm', { code: totp(key) });
    expect(confirmed.status).toBe(302);
    expect(confirmed.headers.get('location')).toContain('saved=account-two-step-on');
    expect(h.db.prepare('SELECT two_factor_enabled AS on_ FROM user WHERE id = ?').get(h.adminId)).toEqual({ on_: 1 });
    return { key, codes };
  }

  it('asks for the code after the password, and keeps the recovery codes as hashes', async () => {
    const h = await harness();
    const { key, codes } = await turnOn(h, h.admin);

    const stored = (h.db.prepare('SELECT backup_codes AS codes FROM two_factor WHERE user_id = ?').get(h.adminId) as {
      codes: string;
    }).codes;
    for (const code of codes) expect(stored).not.toContain(code);
    expect(JSON.parse(stored)).toHaveLength(10);
    for (const entry of JSON.parse(stored) as string[]) expect(entry).toMatch(/^h:[0-9a-f]{64}$/);

    const fresh = h.person();
    const password = await signIn(fresh, h.adminEmail);
    expect(password.status).toBe(302);
    expect(password.headers.get('location')).toBe('/admin/sign-in/code');
    // The password alone is not a session.
    expect((await fresh.call('/admin')).status).toBe(302);

    expect((await fresh.form('/admin/sign-in/code', { code: totp(key, Date.now() + 10 * 60_000) })).status).toBe(401);
    const signedIn = await fresh.form('/admin/sign-in/code', { code: totp(key) });
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('location')).toBe('/admin');
    expect((await fresh.call('/admin')).status).toBe(200);
  });

  it('signs in once with each recovery code, typed with or without its hyphen', async () => {
    const h = await harness();
    const { codes } = await turnOn(h, h.admin);
    const first = codes[0] ?? '';

    const once = h.person();
    await signIn(once, h.adminEmail);
    expect((await once.form('/admin/sign-in/recovery', { code: first.replace('-', '') })).status).toBe(302);
    expect((await once.call('/admin')).status).toBe(200);

    const again = h.person();
    await signIn(again, h.adminEmail);
    expect((await again.form('/admin/sign-in/recovery', { code: first })).status).toBe(401);
    expect(JSON.parse((h.db.prepare('SELECT backup_codes AS c FROM two_factor').get() as { c: string }).c)).toHaveLength(9);
    expect((await again.form('/admin/sign-in/recovery', { code: codes[1] ?? '' })).status).toBe(302);
  });

  it('refuses a recovery code sent straight to the library, raw or hashed', async () => {
    const h = await harness();
    const { codes } = await turnOn(h, h.admin);
    const raw = h.person();
    await signIn(raw, h.adminEmail);
    const direct = await raw.call('/api/auth/two-factor/verify-backup-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ code: codes[0] }),
    });
    expect(direct.status).toBe(404);
    expect((await raw.call('/admin')).status).toBe(302);
  });

  it('sends a code page with no password step back to the password', async () => {
    const h = await harness();
    await turnOn(h, h.admin);
    const stranger = h.person();
    const response = await stranger.form('/admin/sign-in/code', { code: '123456' });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Sign in again');
  });

  it('lets an admin turn off another account’s two-step sign-in, and the CLI’s function do the same', async () => {
    const h = await harness();
    const id = await addAccount(h, 'second@home.local', 'admin', 'Jo');
    const jo = h.person();
    await signIn(jo, 'second@home.local');
    const start = await jo.form('/admin/account/two-step/start', { password: PASSWORD });
    const key = (/Key: <code>([A-Z2-7 ]+)<\/code>/.exec(await start.text())?.[1] ?? '').replace(/\s/g, '');
    expect((await jo.form('/admin/account/two-step/confirm', { code: totp(key) })).status).toBe(302);
    expect(h.db.prepare('SELECT two_factor_enabled AS on_ FROM user WHERE id = ?').get(id)).toEqual({ on_: 1 });

    expect((await h.admin.form(`/admin/accounts/${id}/two-step-off`, {})).status).toBe(302);
    expect(h.db.prepare('SELECT two_factor_enabled AS on_ FROM user WHERE id = ?').get(id)).toEqual({ on_: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM two_factor WHERE user_id = ?').get(id)).toEqual({ n: 0 });
    const back = h.person();
    const signedIn = await signIn(back, 'second@home.local');
    expect(signedIn.headers.get('location')).toBe('/admin');

    expect(clearTwoFactor(h.db, 'nobody')).toMatchObject({ ok: false });
  });

  it('turns it off with the password, from your own account', async () => {
    const h = await harness();
    await turnOn(h, h.admin);
    expect((await h.admin.form('/admin/account/two-step/off', { password: 'wrong-password!!' })).status).toBe(400);
    expect((await h.admin.form('/admin/account/two-step/off', { password: PASSWORD })).status).toBe(302);
    expect(h.db.prepare('SELECT two_factor_enabled AS on_ FROM user WHERE id = ?').get(h.adminId)).toEqual({ on_: 0 });
  });
});

describe('the pure parts', () => {
  it('hashes each recovery code once, however many times the list is written', async () => {
    const store = recoveryCodeStore(SECRET);
    const once = await store.encrypt(JSON.stringify(['abcde-12345', 'fghij-67890']));
    expect(await store.encrypt(once)).toBe(once);
    expect(await store.decrypt(once)).toBe(once);
    expect(once).not.toContain('abcde');
  });

  it('reads the key out of the address a code app is given, in groups of four', () => {
    expect(secretOf('otpauth://totp/Maverick%20Wall:a@b?secret=ABCDEFGHIJKLMNOP&issuer=Maverick%20Wall')).toBe(
      'ABCD EFGH IJKL MNOP',
    );
  });

  it('lets a view-only account make only its own account’s writes, and refuses the reads that hand out a key', () => {
    expect(viewerMay('GET', '/admin/calendars')).toBe(true);
    expect(viewerMay('POST', '/admin/calendars')).toBe(false);
    expect(viewerMay('POST', '/admin/account/password')).toBe(true);
    expect(viewerMay('POST', '/admin/accounts')).toBe(false);
    expect(viewerMay('POST', '/admin/sign-out')).toBe(true);
    expect(viewerMay('GET', '/admin/system/key')).toBe(false);
    expect(viewerMay('GET', '/admin/system/diagnostics')).toBe(true);
    expect(viewerMay('GET', '/admin/walls/abc/pair')).toBe(false);
    expect(viewerMay('GET', '/admin/walls/abc')).toBe(true);
  });
});

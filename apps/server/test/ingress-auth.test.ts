import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { INGRESS_HEADER, isTrustedIngress, normaliseSource } from '../src/http/ingress.js';

/**
 * Trusting a Home Assistant login in place of ours — safely.
 *
 * The settings should not ask for a second sign-in when the supervisor has
 * already authenticated the household. The danger is that ingress and the wall
 * displays share one LAN-exposed port, so the `X-Ingress-Path` header is
 * forgeable by anything on the network. What is not forgeable is the socket
 * source, and these prove the gate turns on the source and nothing else — the
 * supervisor gets in without a cookie, and a device merely setting the header
 * still meets the login.
 */

const SUPERVISOR = '172.30.32.2';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness(opts: { isAddon?: boolean; sources?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ingress-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  // The socket source the app sees, set per request. A distinct default per
  // harness, because the rate-limit buckets are module-global and outlive the
  // database — a shared address 429s the later sign-ups and setup never
  // finishes, which is a documented trap in this codebase.
  const base = `10.10.${++n}.1`;
  let source: string | undefined = base;

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'i'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => source,
    ingressTrust: { isAddon: opts.isAddon ?? true, sources: opts.sources ?? [SUPERVISOR] },
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
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  // Complete the wizard so an account exists and setup is done. This also signs
  // the cookie session in — cleared before the ingress cases, which is the
  // whole point of them.
  await call(`/setup?token=${setupToken.current().token}`);
  await post('/setup/account', {
    name: 'Household', email: `h${++n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await post('/setup/household', { timezone: 'Europe/London' });

  return { db, call, jar };
}

const PREFIX = '/api/hassio_ingress/SESSIONTOKEN';

describe('the supervisor is trusted without a cookie', () => {
  it('lets an ingress request from the supervisor into the settings', async () => {
    const h = await harness();
    h.jar.clear(); // no session cookie at all

    const response = await h.call('/admin', { from: SUPERVISOR, ingress: PREFIX });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Signed in as Household');
    // No sign-out button under ingress — the supervisor would hand it back.
    expect(html).toContain('Signed in through Home Assistant');
    expect(html).not.toContain('action="admin/sign-out"');
  });
});

describe('a forged ingress header is not enough', () => {
  it('still asks a LAN device to sign in, header or no header', async () => {
    const h = await harness();
    h.jar.clear();

    // Same request, but from an address that is not the supervisor.
    const response = await h.call('/admin', { from: '192.168.1.66', ingress: PREFIX });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/sign-in');
  });

  it('does not trust the supervisor address without the ingress header', async () => {
    const h = await harness();
    h.jar.clear();

    const response = await h.call('/admin', { from: SUPERVISOR });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/sign-in');
  });

  it('does nothing outside the add-on, even from the supervisor address', async () => {
    const h = await harness({ isAddon: false });
    h.jar.clear();

    const response = await h.call('/admin', { from: SUPERVISOR, ingress: PREFIX });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/sign-in');
  });
});

describe('an ambiguous account set fails closed', () => {
  it('will not guess which user an ingress visitor is when there are several', async () => {
    const h = await harness();
    // A second account: there is no mapping from a Home Assistant user to one
    // of them, so trusting the login can no longer name who is asking.
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
         VALUES ('u2', 'Other', 'other@home.local', 0, ?, ?)`,
      )
      .run(at, at);
    h.jar.clear();

    const response = await h.call('/admin', { from: SUPERVISOR, ingress: PREFIX });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/sign-in');
  });
});

describe('isTrustedIngress, the pure decision', () => {
  const ctx = (ingress: string | undefined): Context =>
    ({ req: { header: (k: string) => (k === INGRESS_HEADER ? ingress : undefined) } }) as unknown as Context;
  const trusted = new Set([SUPERVISOR]);

  it('maps an IPv4-in-IPv6 socket address to its bare form', () => {
    expect(normaliseSource(`::ffff:${SUPERVISOR}`)).toBe(SUPERVISOR);
    expect(normaliseSource(SUPERVISOR)).toBe(SUPERVISOR);
  });

  it('is true only for the supervisor address, under ingress, as an add-on', () => {
    expect(isTrustedIngress(ctx(PREFIX), SUPERVISOR, { isAddon: true, sources: trusted })).toBe(true);
    expect(isTrustedIngress(ctx(PREFIX), `::ffff:${SUPERVISOR}`, { isAddon: true, sources: trusted })).toBe(true);
  });

  it('is false for a forged header, a missing header, a foreign source, or no socket', () => {
    expect(isTrustedIngress(ctx(PREFIX), '10.0.0.5', { isAddon: true, sources: trusted })).toBe(false);
    expect(isTrustedIngress(ctx(undefined), SUPERVISOR, { isAddon: true, sources: trusted })).toBe(false);
    expect(isTrustedIngress(ctx(PREFIX), undefined, { isAddon: true, sources: trusted })).toBe(false);
    expect(isTrustedIngress(ctx(PREFIX), SUPERVISOR, { isAddon: false, sources: trusted })).toBe(false);
  });
});

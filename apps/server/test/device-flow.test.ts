import { afterAll, describe, expect, it } from 'vitest';
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

/**
 * Frictionless pairing — the device-authorization flow — driven end to end
 * through the real app (RFC 003 Phase 3).
 *
 * This is the flow a keyboard-less screen uses: it starts a flow, shows a short
 * code, the household approves it from behind their login, and the token lands
 * on the screen with nobody typing it. The tests here touch the two real
 * clients at once — a *session-less* screen polling on the port, and a
 * *signed-in* household approving — against one app instance, because the whole
 * security argument is that split: the code is only ~38 bits, and it is safe
 * because approval is impossible without the session a LAN attacker cannot get.
 *
 * A stubbed store would prove none of that, which is the `requireSession`
 * lesson. So the store is the shipping one and the session is a real one, walked
 * through the wizard exactly as `screen-pairing.test.ts` does.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness(baseUrl = 'http://localhost') {
  const address = `10.8.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-device-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  // The household's browser: a cookie jar that keeps the session across calls.
  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(url, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  // A screen: no cookies, ever — a fresh device that holds no credential, which
  // is the whole premise of the flow. Its calls never touch the household jar.
  const screenPost = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const screenGet = (url: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(url, { headers }));

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household', email: `family${nextAddress}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  return { db, call, post, screenPost, screenGet };
}

interface StartReply {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  pollIntervalSec: number;
  expiresInSec: number;
}

interface PollReply {
  status: string;
  token?: string;
  screenName?: string;
}

const PORT = 'http://192.168.1.10:8080';

async function startFlow(h: Awaited<ReturnType<typeof harness>>, headers: Record<string, string> = {}) {
  const res = await h.screenPost(`${PORT}/d/pair/device-start`, {}, headers);
  return (await res.json()) as StartReply;
}

async function poll(h: Awaited<ReturnType<typeof harness>>, deviceCode: string): Promise<PollReply> {
  return (await (await h.screenPost(`${PORT}/d/pair/device-poll`, { deviceCode })).json()) as PollReply;
}

describe('device-authorization pairing, end to end', () => {
  it('walks a keyboard-less screen from start to a working manifest', async () => {
    const h = await harness();

    // 1. The screen begins the flow — no session, on the port.
    const startRes = await h.screenPost(`${PORT}/d/pair/device-start`, {});
    expect(startRes.status).toBe(200);
    const start = (await startRes.json()) as StartReply;
    expect(start.deviceCode.length).toBeGreaterThan(20);
    expect(start.userCode).toMatch(/^[234679ACDEFGHJKMNPQRTUVWXYZ]{8}$/);
    // The verify link carries the reachable port origin and the code to approve.
    expect(start.verifyUrl).toBe(`${PORT}/admin/screens/approve?code=${start.userCode}`);

    // 2. Nothing approved yet: the screen's poll says so.
    expect(await poll(h, start.deviceCode)).toEqual({ status: 'pending' });

    // 3. The household opens the approve link (behind their session) and sees it.
    const prompt = await h.call(start.verifyUrl);
    expect(prompt.status).toBe(200);
    const promptHtml = await prompt.text();
    expect(promptHtml).toContain('A screen wants to pair');
    expect(promptHtml).toContain(start.userCode);

    // 4. They name it and approve.
    const approved = await h.post(`${PORT}/admin/screens/approve`, {
      code: start.userCode, name: 'Living room TV', action: 'approve',
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('Living room TV is paired');

    // A screen row now exists under that name.
    const row = h.db.prepare('SELECT name FROM screens').get() as { name: string } | undefined;
    expect(row?.name).toBe('Living room TV');

    // 5. The screen's next poll receives the token, exactly once.
    const deliver = await poll(h, start.deviceCode);
    expect(deliver.status).toBe('approved');
    expect(deliver.screenName).toBe('Living room TV');
    expect(typeof deliver.token).toBe('string');

    // 6. The token is real: it authorises the manifest a wall polls. The whole
    //    point proven, not asserted — the same end-to-end check the QR and code
    //    paths get, one door over.
    const manifest = await h.screenGet(`${PORT}/d/manifest`, {
      authorization: `Bearer ${deliver.token as string}`,
    });
    expect(manifest.status).toBe(200);
  });

  it('delivers the token only once — a second poll is spent', async () => {
    const h = await harness();
    const start = await startFlow(h);
    await h.post(`${PORT}/admin/screens/approve`, { code: start.userCode, name: 'TV', action: 'approve' });

    expect((await poll(h, start.deviceCode)).status).toBe('approved');
    // Consumed. A replayed poll (a copied device code) reads as a dead flow.
    expect((await poll(h, start.deviceCode)).status).toBe('expired');
  });

  it('lets the household decline, and no screen is created', async () => {
    const h = await harness();
    const start = await startFlow(h);

    const declined = await h.post(`${PORT}/admin/screens/approve`, {
      code: start.userCode, name: 'Unwanted', action: 'deny',
    });
    expect(declined.status).toBe(200);
    expect(await declined.text()).toContain('declined');

    expect((await poll(h, start.deviceCode)).status).toBe('denied');
    const count = (h.db.prepare('SELECT count(*) AS n FROM screens').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('refuses to approve without the household session', async () => {
    // The load-bearing security property: the short code is safe *because*
    // approving it needs the login. A session-less caller — anyone on the LAN —
    // is bounced to sign-in and pairs nothing, however many codes they try.
    const h = await harness();
    const start = await startFlow(h);

    // A session-less POST, standing in for a LAN attacker with the code.
    const attempt = await h.screenPost(`${PORT}/admin/screens/approve`, {
      code: start.userCode, name: 'Rogue', action: 'approve',
    });
    expect([302, 303, 401, 403]).toContain(attempt.status);

    // Still pending, nothing created.
    expect((await poll(h, start.deviceCode)).status).toBe('pending');
    const count = (h.db.prepare('SELECT count(*) AS n FROM screens').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('treats an unknown device code as a flow to start over', async () => {
    const h = await harness();
    expect((await poll(h, 'nope')).status).toBe('expired');
  });

  it('builds the verify link from base_url under ingress, not the internal host', async () => {
    // A screen reaches the box on the LAN, never through ingress — so a verify
    // link built from the ingress request origin would point at the supervisor's
    // internal Docker network and scan as a dead end. Same fix as the QR page.
    const h = await harness('http://192.168.1.50:8080');
    // The request genuinely arrives on the supervisor's internal Docker host, so
    // a link built from its origin would carry that host. It must not.
    const res = await h.screenPost(
      'http://a0d7b954-maverick-wall:8080/d/pair/device-start',
      {},
      { [INGRESS_HEADER]: '/api/hassio_ingress/SESSION123' },
    );
    const start = (await res.json()) as StartReply;
    expect(start.verifyUrl).toContain('http://192.168.1.50:8080/admin/screens/approve');
    expect(start.verifyUrl).not.toContain('a0d7b954-maverick-wall');
  });

  it('rate-limits a burst of device-start calls from one address', async () => {
    const h = await harness();
    // Twenty are allowed per window; the twenty-first is turned away, so a script
    // cannot flood the pending map from the port.
    for (let i = 0; i < 20; i++) {
      expect((await h.screenPost(`${PORT}/d/pair/device-start`, {})).status).toBe(200);
    }
    expect((await h.screenPost(`${PORT}/d/pair/device-start`, {})).status).toBe(429);
  });
});

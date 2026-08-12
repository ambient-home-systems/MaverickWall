import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { createApp } from '../src/http/app.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * Sitting behind a TLS-terminating reverse proxy.
 *
 * The thing under test is that the *scheme* the browser used reaches the two
 * places that must know it — the cross-origin guard and the display cookie's
 * `Secure` — and that it does so **only** when the request's real socket source
 * is a proxy the household configured. A forged `X-Forwarded-Proto` from
 * anything else on the LAN must buy nothing, and a plain-http wall must keep a
 * cookie with no `Secure` or it can never pair (rule nine). Driven through the
 * real app with an injected socket address, because the whole point is a
 * decision that must not trust a header.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PROXY = '172.20.0.9'; // the reverse proxy's address on the docker network

function harness(opts: { clientAddr?: string; trustedProxySources?: readonly string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-fwd-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const now = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, timezone, theme, setup_completed_at, created_at, updated_at)
     VALUES ('singleton', 'America/New_York', 'board', ?, ?, ?)`,
  ).run(now, now, now);

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('screen1', 'Kitchen', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, now, now, now);

  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'h'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    dataDir,
    // The real socket peer, injected — a test cannot vary the address any other
    // way, and an untrusted source is the whole defence being proven.
    clientAddress: () => opts.clientAddr ?? '203.0.113.7',
    ...(opts.trustedProxySources !== undefined
      ? { trustedProxySources: opts.trustedProxySources }
      : {}),
  });

  const fetch = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(new Request(`http://localhost${path}`, init));

  return { db, fetch, token: issued.token };
}

/** A form POST carrying an Origin, the shape a browser sends cross-scheme. */
function postPair(
  h: ReturnType<typeof harness>,
  headers: Record<string, string>,
): Promise<Response> {
  return h.fetch('/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ code: 'ZZZZ-ZZZZ' }).toString(),
  });
}

describe('the cross-origin guard behind a TLS proxy', () => {
  it('lets an https form post through when the trusted proxy says https', async () => {
    // The browser used https; the container sees http; the proxy reports the
    // truth and is trusted by socket source. The guard must not refuse this.
    const h = harness({ clientAddr: PROXY, trustedProxySources: [PROXY] });
    const res = await postPair(h, {
      origin: 'https://localhost',
      'x-forwarded-proto': 'https',
    });
    expect(res.status).not.toBe(403);
    // It reached the handler — a bad code, not a cross-origin refusal.
    expect(res.status).toBe(400);
  });

  it('refuses a forged X-Forwarded-Proto from an untrusted source', async () => {
    // Same headers, but the socket is some device on the LAN, not the proxy.
    // The header is ignored, the effective origin stays http, and the https
    // Origin no longer matches — so the post is turned away.
    const h = harness({ clientAddr: '192.168.1.66', trustedProxySources: [PROXY] });
    const res = await postPair(h, {
      origin: 'https://localhost',
      'x-forwarded-proto': 'https',
    });
    expect(res.status).toBe(403);
  });

  it('still refuses a genuinely foreign origin under the proxy', async () => {
    // The scheme fix must not become an origin bypass: another site's post is
    // refused whatever the forwarded scheme says.
    const h = harness({ clientAddr: PROXY, trustedProxySources: [PROXY] });
    const res = await postPair(h, {
      origin: 'https://evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(res.status).toBe(403);
  });
});

describe('the display cookie Secure attribute', () => {
  it('adds Secure when a trusted proxy reports https', async () => {
    const h = harness({ clientAddr: PROXY, trustedProxySources: [PROXY] });
    const res = await h.fetch(`/pair?token=${h.token}`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mw_display=');
    expect(cookie).toContain('Secure');
  });

  it('never adds Secure on a plain-http wall, or the screen cannot pair', async () => {
    // The ordinary LAN case: no proxy trust. An unconditional Secure here would
    // strip the cookie and brick pairing (rule nine).
    const h = harness();
    const res = await h.fetch(`/pair?token=${h.token}`);
    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mw_display=');
    expect(cookie).not.toContain('Secure');
  });

  it('ignores a forged https header from an untrusted source', async () => {
    // A device on the LAN claiming https must not flip Secure on — that would
    // strip the cookie from a wall that is really on http.
    const h = harness({ clientAddr: '192.168.1.66', trustedProxySources: [PROXY] });
    const res = await h.fetch(`/pair?token=${h.token}`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('mw_display=');
    expect(cookie).not.toContain('Secure');
  });
});

describe('HSTS', () => {
  it('is never set, even behind a trusted https proxy', async () => {
    // On a self-signed or reverse-proxied LAN box HSTS is a self-inflicted
    // brick with no in-product recovery. Nothing here may set it.
    const h = harness({ clientAddr: PROXY, trustedProxySources: [PROXY] });
    const res = await h.fetch(`/pair?token=${h.token}`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.headers.get('strict-transport-security')).toBeNull();
    const health = await h.fetch('/healthz');
    expect(health.headers.get('strict-transport-security')).toBeNull();
  });
});

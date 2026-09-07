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
import { createRevealStore } from '../src/http/reveal.js';
import { INGRESS_HEADER } from '../src/http/ingress.js';

/**
 * A secret is shown once, on a page that is safe to reload — and a typed
 * pairing code that is wrong is corrected where it was typed.
 *
 * Two faults from the admin review, both about the page a household lands on
 * after pressing a button. The pairing link and the e-paper frame URL were
 * printed as the POST's own answer, so a reload resubmitted the form (a second
 * wall, or a retired link) and Back could not return to them. And a mistyped
 * pairing code — or an empty one — was answered with a 404 page saying the
 * code had "expired", with nowhere to type it again.
 *
 * Driven through the real app with a real session, the way the household
 * would, rather than through the pages' builders — the first fault was never
 * in a builder, it was in which request the page answered.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.24.24.${++clientNumber}`;
/** Where a wall reaches the box: the port, never the admin's own origin. */
const PORT = 'http://192.168.1.10:8080';

async function harness(baseUrl = 'http://localhost') {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-once-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = nextClientAddress();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const target = url.startsWith('http') ? url : `${PORT}${url}`;
    const response = await app.fetch(new Request(target, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (
    url: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  // A wall: no cookies, ever. Its calls never touch the household's jar.
  const wallPost = async (path: string, fields: Record<string, string>): Promise<Response> =>
    app.fetch(
      new Request(`${PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const manifest = async (token: string): Promise<Response> =>
    app.fetch(new Request(`${PORT}/d/manifest`, { headers: { authorization: `Bearer ${token}` } }));

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await form('http://localhost/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('http://localhost/setup/household', { timezone: 'Europe/London' });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  const screenId = (): string =>
    (db.prepare(`SELECT id FROM screens WHERE revoked_at IS NULL ORDER BY created_at LIMIT 1`).get() as { id: string }).id;
  const screenCount = (): number =>
    (db.prepare(`SELECT count(*) AS n FROM screens`).get() as { n: number }).n;
  return { db, call, form, wallPost, manifest, screenId, screenCount };
}

const pairToken = (html: string): string | undefined => /\/pair\?token=([A-Za-z0-9_-]+)/.exec(html)?.[1];
const frameUrl = (html: string): string | undefined => /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];

describe('the reveal store', () => {
  it('hands a value over exactly once, and forgets an unread one after the TTL', () => {
    const store = createRevealStore<string>(1000);
    store.put('a', 'first', 0);
    expect(store.take('a', 1)).toBe('first');
    expect(store.take('a', 2)).toBeUndefined();

    store.put('b', 'unread', 0);
    expect(store.take('b', 1000)).toBeUndefined();

    // A later put supersedes an earlier one under the same key — a regenerate
    // must never hand over the link the database has stopped honouring.
    store.put('c', 'old', 0);
    store.put('c', 'new', 1);
    expect(store.take('c', 2)).toBe('new');
    expect(store.take('c', 3)).toBeUndefined();
  });
});

describe('pairing a browser wall', () => {
  it('redirects from the POST to a page that shows the link once, and never caches it', async () => {
    const h = await harness();
    const made = await h.form('/admin/screens', { name: 'Kitchen' });
    expect(made.status).toBe(303);
    const location = made.headers.get('location') ?? '';
    expect(location).toBe(`/admin/walls/${h.screenId()}/pair`);
    // The POST's own answer carries no secret.
    expect(await made.text()).not.toContain('/pair?token=');

    const shown = await h.call(location);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    const html = await shown.text();
    expect(html).toContain('Pair Kitchen');
    expect(html).toContain('<div class="qr">');
    const token = pairToken(html);
    expect(token).toBeDefined();
    expect((await h.manifest(token as string)).status).toBe(200);
    expect(h.screenCount()).toBe(1);
  });

  it('a second visit — a reload, or Back — says the link was shown and offers a new one', async () => {
    const h = await harness();
    const made = await h.form('/admin/screens', { name: 'Kitchen' });
    const location = made.headers.get('location') ?? '';
    const token = pairToken(await (await h.call(location)).text()) as string;

    const again = await h.call(location);
    expect(again.status).toBe(410);
    expect(again.headers.get('cache-control')).toBe('no-store');
    const html = await again.text();
    expect(html).toContain('has been shown already');
    expect(html).not.toContain('/pair?token=');
    expect(html).not.toContain('<div class="qr">');
    // The same regenerate the wall's own menu carries, with its warning, and
    // the way on to the layout.
    const id = h.screenId();
    expect(html).toContain(`action="admin/screens/${id}/regenerate"`);
    expect(html).toContain('Make a new pairing link');
    expect(html).toContain(`href="admin/walls/${id}"`);
    // Looking at the spent page rotated nothing: the link that was shown
    // still pairs, and no second wall appeared.
    expect((await h.manifest(token)).status).toBe(200);
    expect(h.screenCount()).toBe(1);
  });

  it('regenerating takes the same one hop, retires the old link and is shown once', async () => {
    const h = await harness();
    const first = pairToken(
      await (await h.call((await h.form('/admin/screens', { name: 'Kitchen' })).headers.get('location') ?? '')).text(),
    ) as string;
    const id = h.screenId();

    const made = await h.form(`/admin/screens/${id}/regenerate`, {});
    expect(made.status).toBe(303);
    expect(made.headers.get('location')).toBe(`/admin/walls/${id}/pair`);
    const html = await (await h.call(`/admin/walls/${id}/pair`)).text();
    const second = pairToken(html) as string;
    expect(second).not.toBe(first);
    expect((await h.manifest(first)).status).toBe(401);
    expect((await h.manifest(second)).status).toBe(200);
    expect((await h.call(`/admin/walls/${id}/pair`)).status).toBe(410);
  });

  it('carries the ingress prefix on the redirect, so the sidebar lands on the page too', async () => {
    const h = await harness('http://192.168.1.50:8080');
    const prefix = '/api/hassio_ingress/SESSION123';
    const made = await h.form(
      'http://a0d7b954-maverick-wall:8080/admin/screens',
      { name: 'Ingress' },
      { [INGRESS_HEADER]: prefix },
    );
    expect(made.status).toBe(303);
    const location = made.headers.get('location') ?? '';
    expect(location.startsWith(`${prefix}/admin/walls/`)).toBe(true);
    // The supervisor strips the prefix before forwarding; the page then
    // builds its link from base_url, as the pairing page always has.
    const html = await (
      await h.call(`http://a0d7b954-maverick-wall:8080${location.slice(prefix.length)}`, {
        headers: { [INGRESS_HEADER]: prefix },
      })
    ).text();
    expect(html).toContain('http://192.168.1.50:8080/pair?token=');
  });

  it('sends an unknown wall, or an e-paper panel, back to the list', async () => {
    const h = await harness();
    expect((await h.call('/admin/walls/nope/pair')).status).toBe(302);
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const panel = await h.call(`/admin/walls/${h.screenId()}/pair`);
    expect(panel.status).toBe(302);
    expect(panel.headers.get('location')).toBe('/admin/walls');
  });
});

describe('adding an e-paper panel', () => {
  it('redirects from the POST to a page that shows the frame URL once', async () => {
    const h = await harness();
    const made = await h.form('/admin/epaper', { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' });
    expect(made.status).toBe(303);
    const id = h.screenId();
    expect(made.headers.get('location')).toBe(`/admin/epaper/${id}/url`);
    expect(await made.text()).not.toContain('/d/epaper/');

    const shown = await h.call(`/admin/epaper/${id}/url`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('cache-control')).toBe('no-store');
    const html = await shown.text();
    expect(html).toContain('Hallway');
    expect(html).toContain('800×480');
    const url = frameUrl(html);
    expect(url).toBeDefined();
    expect((await h.call(url as string)).status).toBe(200);
    expect(h.screenCount()).toBe(1);
  });

  it('a second visit says the URL was shown, offers regeneration, and rotates nothing', async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId();
    const url = frameUrl(await (await h.call(`/admin/epaper/${id}/url`)).text()) as string;

    const again = await h.call(`/admin/epaper/${id}/url`);
    expect(again.status).toBe(410);
    const html = await again.text();
    expect(html).toContain('has been shown already');
    expect(frameUrl(html)).toBeUndefined();
    expect(html).toContain(`action="admin/epaper/${id}/regenerate"`);
    expect(html).toContain(`href="admin/walls/${id}"`);
    expect((await h.call(url)).status).toBe(200);
  });

  it('regenerating takes the same hop and retires the old URL', async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId();
    const first = frameUrl(await (await h.call(`/admin/epaper/${id}/url`)).text()) as string;

    const made = await h.form(`/admin/epaper/${id}/regenerate`, {});
    expect(made.status).toBe(303);
    expect(made.headers.get('location')).toBe(`/admin/epaper/${id}/url`);
    const second = frameUrl(await (await h.call(`/admin/epaper/${id}/url`)).text()) as string;
    expect(second).not.toBe(first);
    expect((await h.call(first)).status).toBe(404);
    expect((await h.call(second)).status).toBe(200);
    expect((await h.call(`/admin/epaper/${id}/url`)).status).toBe(410);
  });
});

describe('a typed pairing code', () => {
  /** A wall part-way through its own pairing: the code the household types. */
  const pending = async (h: Awaited<ReturnType<typeof harness>>): Promise<string> => {
    const started = await h.wallPost('/d/pair/device-start', {});
    expect(started.status).toBe(200);
    return ((await started.json()) as { userCode: string }).userCode;
  };
  const field = (html: string): string | undefined =>
    /<input class="field-input" type="text" name="code"(?: value="([^"]*)")?/.exec(html)?.[1] ?? (html.includes('name="code"') ? '' : undefined);

  it('with nothing typed, asks for the code beside the field rather than saying it expired', async () => {
    const h = await harness();
    const res = await h.call('/admin/screens/approve?code=');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Type the code the wall is showing.');
    expect(html).toContain('field-error');
    expect(field(html)).toBe('');
    expect(html).not.toContain('Nothing to approve');
    expect(html).not.toContain('expired');
  });

  it('with a code no wall is showing, says so and hands the typed code back to correct', async () => {
    const h = await harness();
    const res = await h.call('/admin/screens/approve?code=ZZZZ-ZZZZ');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('No wall is waiting with that code');
    expect(html).toContain('10 minutes');
    expect(field(html)).toBe('ZZZZ-ZZZZ');
    expect(html).toContain('field-error');
    expect(html).not.toContain('Nothing to approve');
  });

  it('with a code already approved, says that and offers the field for the next one', async () => {
    const h = await harness();
    const code = await pending(h);
    expect((await h.form('/admin/screens/approve', { code, name: 'TV', action: 'approve' })).status).toBe(200);

    const res = await h.call(`/admin/screens/approve?code=${code}`);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('already been approved or declined');
    expect(field(html)).toBe(code);
    expect(html).not.toContain('A wall wants to pair');
  });

  it('with a live code, still opens the approve prompt', async () => {
    const h = await harness();
    const code = await pending(h);
    const res = await h.call(`/admin/screens/approve?code=${code}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('A wall wants to pair');
  });

  it('with no code at all, is the form and not an error', async () => {
    const h = await harness();
    const res = await h.call('/admin/screens/approve');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(field(html)).toBe('');
    expect(html).not.toContain('field-error');
    expect(html).toContain('action="admin/screens/approve"');
  });

  it('approving a code that stopped being pending lands back on the field, not a dead end', async () => {
    const h = await harness();
    const code = await pending(h);
    await h.form('/admin/screens/approve', { code, name: 'TV', action: 'deny' });

    const res = await h.form('/admin/screens/approve', { code, name: 'TV', action: 'approve' });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('nothing was paired');
    expect(field(html)).toBe(code);
    expect(h.screenCount()).toBe(0);
  });
});

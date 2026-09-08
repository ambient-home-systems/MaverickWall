import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * The e-paper endpoint, driven through the real app.
 *
 * A stub would prove nothing the interesting way — the whole point is that a
 * device with no cookie, doing a plain GET with a token in the path, gets a
 * real PNG back and a `304` when nothing changed. So this pairs a screen the
 * way the admin does, mints a real token, and fetches the frame over it. It is
 * the same "touch something real" the pairing and ingress tests hold to.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-epaper-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.8.0.${++nextAddress}`,
    setupToken,
    dataDir,
  });

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
  const post = (url: string, fields: Record<string, string>) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `epaper${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  // Pair a screen exactly as the admin does, and pull its token out of the link.
  // The POST redirects to the page that shows the link once; follow it.
  const made = await post('http://localhost:8080/admin/screens', { name: 'eInk' });
  const html = await (await call(`http://localhost:8080${made.headers.get('location') ?? ''}`)).text();
  const token = /\/pair\?token=([^<\s"]+)/.exec(html)?.[1];
  if (token === undefined) throw new Error('no pairing token in the admin page');
  const screenId = (db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

  return { db, call, token, screenId };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe('the e-paper frame', () => {
  it('serves a real PNG over a token in the path, no cookie', async () => {
    const h = await harness();
    const res = await h.call(`http://localhost:8080/d/epaper/${h.token}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    const body = await bytesOf(res);
    expect([...body.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(body.length).toBeGreaterThan(100);
  });

  it('answers 304 when the ETag matches, so the panel skips a refresh', async () => {
    const h = await harness();
    const first = await h.call(`http://localhost:8080/d/epaper/${h.token}.png`);
    const etag = first.headers.get('etag')!;
    const again = await h.call(`http://localhost:8080/d/epaper/${h.token}.png`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect((await bytesOf(again)).length).toBe(0);
  });

  it('serves the raw 1-bit packing at .bin, sized to the panel', async () => {
    const h = await harness();
    // Default geometry is the Seeed 7.5": 800×480 → 100 bytes/row × 480.
    const res = await h.call(`http://localhost:8080/d/epaper/${h.token}.bin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect((await bytesOf(res)).length).toBe(100 * 480);
  });

  it('honours a screen\'s own panel geometry', async () => {
    const h = await harness();
    h.db
      .prepare(`UPDATE screens SET kind = 'epaper', panel_width = 400, panel_height = 240 WHERE id = ?`)
      .run(h.screenId);
    const res = await h.call(`http://localhost:8080/d/epaper/${h.token}.bin`);
    // ceil(400/8) = 50 bytes/row × 240 rows.
    expect((await bytesOf(res)).length).toBe(50 * 240);
  });

  it('rejects an unknown token as 404, leaking nothing', async () => {
    const h = await harness();
    const res = await h.call('http://localhost:8080/d/epaper/not-a-real-token.png');
    expect(res.status).toBe(404);
  });

  it('rejects an unknown extension', async () => {
    const h = await harness();
    const res = await h.call(`http://localhost:8080/d/epaper/${h.token}.gif`);
    expect(res.status).toBe(404);
  });

  it('draws the free-form canvas, and an edit to it reaches the panel', async () => {
    const h = await harness();
    const at = Date.now();
    const addWidget = (id: string, type: string, y: number, config: string | null): void => {
      h.db
        .prepare(
          `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES (?, ?, 'landscape', ?, 0.1, ?, 0.8, 0.3, 0, ?, ?, ?)`,
        )
        .run(id, h.screenId, type, y, config, at, at);
    };

    // A paired screen is *seeded* with the Classic canvas (RFC 005 — pairing no
    // longer dead-ends), so it is already free-form with widgets here. This
    // comment used to say "the fixed layout, before any canvas exists", which
    // was never true and made the assertions below read as proving more than
    // they did. Empty it deliberately to reach the fixed layout.
    h.db.prepare(`DELETE FROM layout_widgets WHERE screen_id = ?`).run(h.screenId);
    h.db.prepare(`UPDATE screens SET layout_mode = NULL WHERE id = ?`).run(h.screenId);
    const auto = (await h.call(`http://localhost:8080/d/epaper/${h.token}.png`)).headers.get('etag');

    /*
     * A canvas authored with nothing on it, which is what the Blank card
     * writes: the mode says free-form while nothing is placed.
     *
     * **This used to assert the opposite and the reversal is deliberate.** The
     * old contract was `widgets.length > 0`, so an empty canvas drew the
     * built-in layout — which was harmless while nothing could author one, and
     * became a control that lies the moment the gallery grew a Blank card:
     * Blank and Built-in would have been the same frame. `undefined` is no
     * canvas and `[]` is an empty one now, and they are two frames.
     *
     * Rule nine is unmoved and is asserted twice over. Reset is the state above
     * — it clears `layout_mode`, so a reset panel has *no* canvas and still
     * draws the built-in view — and a canvas emptied by the omission rather
     * than by the household is the case below.
     */
    h.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(h.screenId);
    const emptyCanvas = (await h.call(`http://localhost:8080/d/epaper/${h.token}.png`)).headers.get('etag');
    expect(emptyCanvas).not.toBe(auto);

    /*
     * The empty that rule nine actually protects, and it never reaches this
     * renderer: a canvas holding only a widget the household has nothing set up
     * behind. `keepWidgetsWithSomethingToSay` hands its input back rather than
     * an empty list, so this panel draws the Weather box saying "No weather
     * yet" — a frame of its own, and not the built-in view.
     *
     * Worth asserting here because a helper was written for the case this rules
     * out, and only running it showed the case cannot happen.
     */
    addWidget('w0', 'weather', 0.05, null);
    const onlyUnconfigured = (await h.call(`http://localhost:8080/d/epaper/${h.token}.png`)).headers.get('etag');
    expect(onlyUnconfigured).not.toBe(auto);
    expect(onlyUnconfigured).not.toBe(emptyCanvas);
    h.db.prepare(`DELETE FROM layout_widgets WHERE id = 'w0'`).run();

    // Now place one: the canvas replaces the fixed layout (default geometry is
    // 800×480, so the panel shows the landscape canvas).
    addWidget('w1', 'clock', 0.05, null);
    const oneWidget = (await h.call(`http://localhost:8080/d/epaper/${h.token}.png`)).headers.get('etag');
    expect(oneWidget).not.toBe(auto);

    // Add a second widget — the ETag moves again, so a household's edit is not
    // stranded until the calendar happens to change.
    addWidget('w2', 'calendar', 0.4, JSON.stringify({ mode: 'month' }));
    const twoWidgets = (await h.call(`http://localhost:8080/d/epaper/${h.token}.png`)).headers.get('etag');
    expect(twoWidgets).not.toBe(oneWidget);

    // And it is still a real PNG.
    const res = await h.call(`http://localhost:8080/d/epaper/${h.token}.png`);
    expect(res.status).toBe(200);
    expect([...(await bytesOf(res)).slice(0, 8)]).toEqual(PNG_SIGNATURE);
  });
});

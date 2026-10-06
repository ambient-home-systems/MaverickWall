import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { issueCompanionToken } from '../src/api/companion.js';
import type { Manifest } from '../src/api/manifest.js';
import { startLayoutOverride } from '../src/api/wall-commands.js';

/**
 * Telling walls what to do from elsewhere (plan items M1.2, M1.3 and M2.3):
 * reload, and show one wall's layout on every other wall for a while — from
 * the admin and from a phone with the companion token.
 *
 * Both are facts the manifest carries rather than messages, so every assertion
 * here is about the document a wall receives: which walls are told, what they
 * are told, and when they stop being told it. Two walls with different layouts
 * and an e-paper panel, because "every wall" means the browser walls and only
 * those, and "show this layout" means another wall's and not your own.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let household = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const START = Date.UTC(2026, 9, 6, 9, 0, 0);

interface Harness {
  readonly db: SqliteDatabase;
  readonly clock: { at: number };
  readonly phone: (path: string, body: unknown) => Promise<Response>;
  readonly admin: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifest: (wall: 'kitchen' | 'hall' | 'panel') => Promise<{ body: Manifest; etag: string }>;
}

async function harness(): Promise<Harness> {
  const n = ++household;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wallcmd-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    START,
    START,
  );
  // The wizard on the real clock, because the bootstrap code is stamped by it.
  const clock = { at: Date.now() };
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'g'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.18.${n}.1`,
    setupToken,
    dataDir,
    now: () => clock.at,
  });

  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
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
    admin(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `walls${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  clock.at = START;
  const token = issueCompanionToken(db, keyring, userId, clock.at);

  // Two browser walls with different layouts, and a panel.
  const tokens: Record<string, string> = {};
  for (const [id, name, kind] of [
    ['kitchen', 'Kitchen', 'browser'],
    ['hall', 'Hall', 'browser'],
    ['panel', 'Landing', 'epaper'],
  ] as const) {
    const issued = issueDisplayToken();
    tokens[id] = issued.token;
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, kind, layout_mode, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'freeform', ?, ?, ?)`,
    ).run(id, name, issued.tokenHash, kind === 'browser' ? 'panels' : null, kind, START, START, START);
  }
  const place = (screen: string, id: string, type: string, config: unknown): void => {
    db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, 'portrait', ?, 0.1, 0.1, 0.8, 0.3, 0, ?, ?, ?)`,
    ).run(id, screen, type, JSON.stringify(config), START, START);
  };
  place('kitchen', 'k-notes', 'notes', { text: 'Party time' });
  place('hall', 'h-clock', 'clock', {});

  return {
    db,
    clock,
    phone: async (path, body) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    admin,
    form,
    manifest: async (wall) => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${tokens[wall]}` } }),
      );
      return { body: (await response.json()) as Manifest, etag: response.headers.get('etag') ?? '' };
    },
  };
}

const portraitTypes = (layout: Manifest['layout'] | undefined): string[] =>
  (layout?.portrait.widgets ?? []).map((widget) => widget.type);

describe('refreshing walls', () => {
  it('tells one wall, by name, and no other — and a wall nobody asked carries nothing', async () => {
    const h = await harness();
    expect((await h.manifest('hall')).body.screen).not.toHaveProperty('refreshRequestedAt');

    const response = await h.phone('/companion/walls/refresh', { wall: 'hall' });
    expect(await response.json()).toEqual({ ok: true, refreshed: 1, message: 'Hall reloads within a minute.' });
    expect((await h.manifest('hall')).body.screen).toMatchObject({ refreshRequestedAt: START });
    expect((await h.manifest('kitchen')).body.screen).not.toHaveProperty('refreshRequestedAt');
  });

  it('tells every browser wall when none is named, and never a panel', async () => {
    const h = await harness();
    const response = await h.phone('/companion/walls/refresh', {});
    expect(await response.json()).toEqual({
      ok: true,
      refreshed: 2,
      message: 'Every browser wall reloads within a minute.',
    });
    expect(
      h.db.prepare('SELECT id, refresh_requested_at AS at FROM screens ORDER BY id').all(),
    ).toEqual([
      { id: 'hall', at: START },
      { id: 'kitchen', at: START },
      { id: 'panel', at: null },
    ]);
  });

  it('answers a wall that is not there, a panel, and a name two walls share with sentences', async () => {
    const h = await harness();
    const missing = await h.phone('/companion/walls/refresh', { wall: 'Garage' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe(
      'No wall is called that. The walls are “Hall”, “Kitchen”.',
    );
    expect((await h.phone('/companion/walls/refresh', { wall: 'Landing' })).status).toBe(404);
    h.db.prepare(`UPDATE screens SET name = 'Kitchen' WHERE id = 'hall'`).run();
    // 'KITCHEN' rather than 'kitchen', which is also the first wall's id and would match it by that.
    expect((await h.phone('/companion/walls/refresh', { wall: 'KITCHEN' })).status).toBe(409);
    expect((await h.phone('/companion/walls/refresh', { wall: 'Hall', colour: 'red' })).status).toBe(400);
    expect(h.db.prepare('SELECT count(*) AS n FROM screens WHERE refresh_requested_at IS NOT NULL').get()).toEqual({
      n: 0,
    });
  });
});

describe('showing one wall’s layout on every wall', () => {
  it('carries the lending wall’s layout beside every other wall’s own, until it stops', async () => {
    const h = await harness();
    const before = await h.manifest('hall');
    expect(before.body).not.toHaveProperty('layoutOverride');

    const response = await h.phone('/companion/walls/show', { wall: 'Kitchen', minutes: 30 });
    expect(await response.json()).toEqual({
      ok: true,
      until: START + 30 * 60_000,
      message: 'Kitchen’s layout is on every other wall for 30 minutes.',
    });

    const hall = await h.manifest('hall');
    expect(hall.body.layoutOverride?.from).toBe('Kitchen');
    expect(hall.body.layoutOverride?.until).toBe(START + 30 * 60_000);
    expect(portraitTypes(hall.body.layoutOverride?.layout)).toEqual(['notes']);
    // Its own layout is still there, to go back to.
    expect(portraitTypes(hall.body.layout)).toEqual(['clock']);
    expect(hall.etag).not.toBe(before.etag);
    // The lending wall is not told to borrow its own, and a panel borrows nothing.
    expect((await h.manifest('kitchen')).body).not.toHaveProperty('layoutOverride');
    expect((await h.manifest('panel')).body).not.toHaveProperty('layoutOverride');

    h.clock.at = START + 30 * 60_000;
    expect((await h.manifest('hall')).body).not.toHaveProperty('layoutOverride');
  });

  it('lasts ten minutes when nobody says, and refuses no time, too long, or a panel', async () => {
    const h = await harness();
    expect(((await (await h.phone('/companion/walls/show', { wall: 'Hall' })).json()) as { until: number }).until).toBe(
      START + 10 * 60_000,
    );
    expect((await h.phone('/companion/walls/show', { wall: 'Hall', minutes: 0 })).status).toBe(400);
    expect((await h.phone('/companion/walls/show', { wall: 'Hall', minutes: 121 })).status).toBe(400);
    expect((await h.phone('/companion/walls/show', {})).status).toBe(400);
    expect((await h.phone('/companion/walls/show', { wall: 'Landing' })).status).toBe(404);
    // And the store refuses a panel itself, whatever a later caller forgets to check.
    expect(startLayoutOverride(h.db, 'panel', 10, START)).toEqual({
      ok: false,
      message: 'Only a browser wall’s layout can be shown on every wall.',
    });
  });

  it('stops early, and says when there was nothing to stop', async () => {
    const h = await harness();
    await h.phone('/companion/walls/show', { wall: 'Kitchen' });
    expect(await (await h.phone('/companion/walls/show/end', {})).json()).toEqual({
      ok: true,
      message: 'Every wall goes back to its own layout within a minute.',
    });
    expect((await h.manifest('hall')).body).not.toHaveProperty('layoutOverride');
    expect((await h.phone('/companion/walls/show/end', {})).status).toBe(404);
  });

  it('ends when the lending wall is unpaired, and goes with it when it is forgotten', async () => {
    const h = await harness();
    await h.phone('/companion/walls/show', { wall: 'Kitchen', minutes: 60 });
    h.db.prepare(`UPDATE screens SET revoked_at = ? WHERE id = 'kitchen'`).run(START);
    expect((await h.manifest('hall')).body).not.toHaveProperty('layoutOverride');
    // Nor does anything else go on saying it is shown: not the Walls list, and
    // not the stop, which has nothing to stop.
    expect(await (await h.admin('/admin/walls')).text()).not.toContain('Showing Kitchen’s layout');
    expect((await h.phone('/companion/walls/show/end', {})).status).toBe(404);
    expect((await h.form('/admin/screens/kitchen/forget', {})).status).toBe(302);
    expect(h.db.prepare('SELECT count(*) AS n FROM layout_override').get()).toEqual({ n: 0 });
  });
});

describe('in the admin', () => {
  it('offers both on a wall’s own menu, and Refresh every wall under the list', async () => {
    const h = await harness();
    const wall = await (await h.admin('/admin/walls/hall')).text();
    expect(wall).toContain('action="admin/screens/hall/refresh"');
    expect(wall).toContain('href="admin/screens/hall/show"');
    const list = await (await h.admin('/admin/walls')).text();
    expect(list).toContain('action="admin/screens/refresh-all"');
    expect(list).not.toContain('Stop now');

    const all = await h.form('/admin/screens/refresh-all', {});
    expect(all.headers.get('location')).toContain('saved=walls-refreshed');
    const one = await h.form('/admin/screens/hall/refresh', {});
    expect(one.headers.get('location')).toContain('/admin/walls/hall');
    expect(one.headers.get('location')).toContain('saved=wall-refreshed');
  });

  it('shows a layout for the time chosen, says whose and until when, and stops it', async () => {
    const h = await harness();
    const page = await (await h.admin('/admin/screens/kitchen/show')).text();
    expect(page).toMatch(/<option value="10" selected>/);
    expect((await h.form('/admin/screens/kitchen/show', { minutes: '60' })).headers.get('location')).toContain(
      'saved=layout-shown',
    );
    const list = await (await h.admin('/admin/walls')).text();
    expect(list).toContain('Showing Kitchen’s layout on every wall');
    // The household's own zone: 09:00 UTC on 6 October is 10:00 in London, an hour on is 11:00.
    expect(list).toContain('Until 11:00');
    expect((await h.form('/admin/screens/show-end', {})).headers.get('location')).toContain('saved=layout-show-ended');
    expect((await h.form('/admin/screens/show-end', {})).headers.get('location')).not.toContain('saved=');
    // A panel has no layout to lend.
    expect((await h.admin('/admin/screens/panel/show')).status).toBe(302);
    expect((await h.form('/admin/screens/kitchen/show', { minutes: '999' })).status).toBe(400);
  });

  it('says on the token page what the token can now do', async () => {
    const h = await harness();
    const page = await (await h.admin('/admin/companion')).text();
    expect(page).toContain('reload your walls');
    expect(page).toContain('/companion/walls/show/end');
  });
});

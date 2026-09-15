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
import { deleteScreen, livePanelCanvasOwner, panelCanvasOwner } from '../src/api/queries.js';

/**
 * Forgetting a wall: the first hard delete of a screen this application has
 * ever made (RFC 016 phase 1, §3.5), driven through the real app against a
 * real better-sqlite3 database.
 *
 * `revokeScreen` was the whole lifecycle, and its argument for keeping the row
 * stands — so the first thing asserted is the refusal: a wall that is still
 * paired cannot be forgotten however the POST is spelled, because the list
 * only *offers* Forget on revoked walls and the POST is the boundary.
 *
 * The rest is what a delete has to sweep that no foreign key sweeps for it.
 * `layout_widgets.screen_id` and `screens.layout_follows` are plain columns,
 * so the wall's widgets in **both** orientations go with the row, and a panel
 * following it goes back to its built-in view — decided, rather than fallen
 * into, because a follow whose target is gone reads as `[]`, and `[]` is the
 * Blank frame now. Every frame here is decoded bytes rather than a status:
 * "the panel draws its built-in view" is the same PNG it drew before it
 * followed anything.
 *
 * And the case one state earlier, which was already wrong: a panel following a
 * *revoked* wall kept drawing that wall's arrangement, because
 * `panelCanvasOwner` reads only the panel's row. Revoking leaves the widgets
 * where they are — that is the point of revoking — so the frame did not move.
 * `livePanelCanvasOwner` asks the database, and the frame does.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const B = 'http://localhost:8080';

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-forget-'));
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
    auth: { secret: 'g'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.16.0.${++nextAddress}`,
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
    email: `forget${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  const idNamed = (name: string): string =>
    (db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;
  const widgetCount = (id: string, orientation: 'portrait' | 'landscape'): number =>
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM layout_widgets WHERE screen_id = ? AND orientation = ?')
        .get(id, orientation) as { n: number }
    ).n;
  const panelRow = (id: string): { mode: string | null; follows: string | null } =>
    db
      .prepare('SELECT layout_mode AS mode, layout_follows AS follows FROM screens WHERE id = ?')
      .get(id) as { mode: string | null; follows: string | null };
  const bytes = async (url: string): Promise<Buffer> => {
    const response = await call(url);
    expect(response.status).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  };

  /** A wall with a clock on each of its two canvases, and its pairing token. */
  const wall = async (name: string, x: number): Promise<{ id: string; token: string }> => {
    const made = await post(`${B}/admin/screens`, { name, theme: 'panels' });
    expect(made.status).toBe(303);
    const shown = await (await call(`${B}${made.headers.get('location') ?? ''}`)).text();
    const token = /\/pair\?token=([^<\s"&]+)/.exec(shown)?.[1];
    if (token === undefined) throw new Error('the pairing page printed no token');
    const id = idNamed(name);
    for (const orientation of ['portrait', 'landscape'] as const) {
      const saved = await call(`${B}/admin/layout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: id,
          orientation,
          mode: 'freeform',
          aspect: orientation === 'portrait' ? 0.5625 : 1.667,
          widgets: [{ id: `${name}-${orientation}`, type: 'clock', x, y: 0.1, w: 0.4, h: 0.3, z: 0 }],
          background: null,
        }),
      });
      expect(saved.status).toBe(200);
    }
    return { id, token: decodeURIComponent(token) };
  };

  /** An e-paper panel, and its frame URL. */
  const panel = async (name: string): Promise<{ id: string; frame: string }> => {
    const made = await post(`${B}/admin/epaper`, { name, preset: 'seeed-7in5', rotation: '0' });
    expect(made.status).toBe(303);
    const html = await (await call(`${B}${made.headers.get('location') ?? ''}`)).text();
    const frame = /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];
    if (frame === undefined) throw new Error('no frame URL on the panel page');
    return { id: idNamed(name), frame };
  };

  return { db, call, post, idNamed, widgetCount, panelRow, bytes, wall, panel };
}

describe('forgetting a wall', () => {
  it('refuses a wall that is still paired, however it is asked', async () => {
    const h = await harness();
    const { id } = await h.wall('Kitchen', 0.05);
    // Through the function — the transaction itself says no.
    expect(deleteScreen(h.db, id)).toBe(false);
    expect(deleteScreen(h.db, 'nosuchwall')).toBe(false);
    // And through the POST, which is the boundary: a 400 with the reason on
    // the list, and the row and both canvases exactly where they were.
    const refused = await h.post(`${B}/admin/screens/${id}/forget`, {});
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('still paired');
    expect(h.idNamed('Kitchen')).toBe(id);
    expect(h.widgetCount(id, 'portrait')).toBe(1);
    expect(h.widgetCount(id, 'landscape')).toBe(1);
    // The confirmation is not even offered for it.
    const confirm = await h.call(`${B}/admin/screens/${id}/forget`);
    expect(confirm.status).toBe(302);
    expect(confirm.headers.get('location')).toBe('/admin/walls');
    // An id that is nothing at all is a 404, not a refusal about pairing.
    expect((await h.post(`${B}/admin/screens/nosuchwall/forget`, {})).status).toBe(404);
  });

  it('a panel following a revoked wall draws its built-in view, not the revoked canvas', async () => {
    const h = await harness();
    const { id: wallId } = await h.wall('Kitchen', 0.05);
    const p = await h.panel('Porch');
    const builtIn = await h.bytes(p.frame);
    const previewBuiltIn = await h.bytes(`${B}/admin/epaper/${p.id}/preview.png`);

    const set = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });
    expect(set.status).toBe(302);
    const followed = await h.bytes(p.frame);
    expect(followed.equals(builtIn), 'following changed nothing, so nothing below can').toBe(false);
    expect((await h.bytes(`${B}/admin/epaper/${p.id}/preview.png`)).equals(previewBuiltIn)).toBe(false);

    /*
     * Revoke — not forget — the wall. Its widgets stay (that is what revoking
     * is for), the panel's row still says `follow`, and the frame must not go
     * on drawing an arrangement the household has unpaired. Both renderers of
     * a panel's frame — the glass and the design page — read one resolver.
     */
    expect((await h.post(`${B}/admin/screens/${wallId}/revoke`, {})).status).toBe(302);
    expect(h.widgetCount(wallId, 'portrait')).toBe(1);
    expect(h.panelRow(p.id)).toEqual({ mode: 'follow', follows: wallId });
    expect((await h.bytes(p.frame)).equals(builtIn)).toBe(true);
    expect((await h.bytes(`${B}/admin/epaper/${p.id}/preview.png`)).equals(previewBuiltIn)).toBe(true);

    // The pure resolver still names the wall; the live one is what changed.
    const row = { id: p.id, layoutMode: 'follow', layoutFollows: wallId };
    expect(panelCanvasOwner(row)).toBe(wallId);
    expect(livePanelCanvasOwner(h.db, row)).toBeUndefined();
    // And a target that does not exist at all is no canvas either — never `[]`.
    expect(livePanelCanvasOwner(h.db, { ...row, layoutFollows: 'gone' })).toBeUndefined();
    // A panel on its own canvas is untouched by any of this.
    expect(livePanelCanvasOwner(h.db, { id: p.id, layoutMode: 'freeform', layoutFollows: wallId })).toBe(p.id);
  });

  it('deletes the row and both canvases, sends a following panel back to its built-in view, and the token stays dead', async () => {
    const h = await harness();
    const kitchen = await h.wall('Kitchen', 0.05);
    const study = await h.wall('Study', 0.55);
    const p = await h.panel('Porch');
    const builtIn = await h.bytes(p.frame);
    expect((await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${kitchen.id}` })).status).toBe(302);
    // A second panel on its own canvas but with a stale follow name pointing
    // at the wall — the row `panelCanvasOwner` already ignores the name on.
    const own = await h.panel('Landing');
    h.db.prepare(`UPDATE screens SET layout_mode = 'freeform', layout_follows = ? WHERE id = ?`).run(kitchen.id, own.id);

    expect((await h.post(`${B}/admin/screens/${kitchen.id}/revoke`, {})).status).toBe(302);
    // Both canvases are still there to be swept.
    expect(h.widgetCount(kitchen.id, 'portrait')).toBe(1);
    expect(h.widgetCount(kitchen.id, 'landscape')).toBe(1);

    // The confirmation names it, and the POST does it.
    const confirm = await h.call(`${B}/admin/screens/${kitchen.id}/forget`);
    expect(confirm.status).toBe(200);
    const page = await confirm.text();
    expect(page).toContain('Forget “Kitchen”?');
    expect(page).toContain(`action="admin/screens/${kitchen.id}/forget"`);
    expect(page).toContain('Forget it');
    const forgot = await h.post(`${B}/admin/screens/${kitchen.id}/forget`, {});
    expect(forgot.status).toBe(302);
    expect(forgot.headers.get('location')).toBe('/admin/walls?saved=wall-forgotten');

    // The row and both orientations' widgets are gone; nobody else's are.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM screens WHERE id = ?').get(kitchen.id)).toEqual({ n: 0 });
    expect(h.widgetCount(kitchen.id, 'portrait')).toBe(0);
    expect(h.widgetCount(kitchen.id, 'landscape')).toBe(0);
    expect(h.widgetCount(study.id, 'portrait')).toBe(1);
    expect(h.widgetCount(study.id, 'landscape')).toBe(1);

    // The following panel draws its built-in view, and says so in its row.
    expect(h.panelRow(p.id)).toEqual({ mode: null, follows: null });
    expect((await h.bytes(p.frame)).equals(builtIn)).toBe(true);
    // The panel on its own canvas keeps its mode and only loses the stale name.
    expect(h.panelRow(own.id)).toEqual({ mode: 'freeform', follows: null });

    // The forgotten wall's token is refused exactly as a never-issued one is —
    // 401 on the manifest, 404 on the frame path — and the live wall's still works.
    const dead = await h.call(`${B}/d/manifest`, { headers: { authorization: `Bearer ${kitchen.token}` } });
    const never = await h.call(`${B}/d/manifest`, { headers: { authorization: `Bearer ${'0'.repeat(43)}` } });
    expect(dead.status).toBe(401);
    expect(dead.status).toBe(never.status);
    expect((await h.call(`${B}/d/epaper/${kitchen.token}.png`)).status).toBe(404);
    expect((await h.call(`${B}/d/manifest`, { headers: { authorization: `Bearer ${study.token}` } })).status).toBe(200);

    // And the list has nothing left to fold away.
    expect(await (await h.call(`${B}/admin/walls`)).text()).not.toContain('wall-revoked');
  });

  it('forgets every revoked wall at once, and says nothing when there are none', async () => {
    const h = await harness();
    const a = await h.wall('Attic', 0.05);
    const b = await h.wall('Bedroom', 0.15);
    const c = await h.wall('Cellar', 0.25);
    for (const id of [a.id, b.id]) expect((await h.post(`${B}/admin/screens/${id}/revoke`, {})).status).toBe(302);

    const confirm = await h.call(`${B}/admin/screens/forget-revoked`);
    expect(confirm.status).toBe(200);
    const page = await confirm.text();
    expect(page).toContain('Forget all 2 unpaired walls?');
    expect(page).toContain('Attic');
    expect(page).toContain('Bedroom');
    expect(page).not.toContain('Cellar');

    const forgot = await h.post(`${B}/admin/screens/forget-revoked`, {});
    expect(forgot.status).toBe(302);
    expect(forgot.headers.get('location')).toBe('/admin/walls?saved=walls-forgotten');
    expect(h.db.prepare('SELECT name FROM screens ORDER BY name').all()).toEqual([{ name: 'Cellar' }]);
    expect(h.widgetCount(a.id, 'portrait') + h.widgetCount(a.id, 'landscape')).toBe(0);
    expect(h.widgetCount(b.id, 'portrait') + h.widgetCount(b.id, 'landscape')).toBe(0);
    expect(h.widgetCount(c.id, 'portrait') + h.widgetCount(c.id, 'landscape')).toBe(2);

    // Nothing left: no confirmation to draw, and no claim of having done anything.
    const empty = await h.call(`${B}/admin/screens/forget-revoked`);
    expect(empty.status).toBe(302);
    expect(empty.headers.get('location')).toBe('/admin/walls');
    const again = await h.post(`${B}/admin/screens/forget-revoked`, {});
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/admin/walls');
  });
});

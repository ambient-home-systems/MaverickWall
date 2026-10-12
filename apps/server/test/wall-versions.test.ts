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
import { deleteScreen, revokeScreen } from '../src/api/queries.js';
import { applyTemplate } from '../src/api/templates.js';
import { TEMPLATES } from '../src/templates/index.js';
import {
  readWallState,
  SNAPSHOT_COALESCE_MS,
  SNAPSHOTS_KEPT,
  snapshotWall,
  wallStateSchema,
} from '../src/api/wall-state.js';

/**
 * A wall's versions, its layout as a file, and a copy of it (plan items
 * M8.4–M8.6), through the real app and a real database.
 *
 * What matters is what each refuses and what each carries: a snapshot taken
 * before every save and not on every request of one Save; a restore that
 * puts back every layout, the hours and the look, and keeps the wall as it
 * was first; a file with no Wi-Fi password in it and no pairing, opened
 * through the same schemas a save goes through and refused whole; and a copy
 * with fresh widget ids, the same look, and nothing it may press.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-versions-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  let clock = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(clock, clock);
  const address = `10.71.0.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'v'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
    now: () => clock,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  const postJson = (path: string, payload: unknown) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const importFile = (wall: string, text: string) => {
    const form = new FormData();
    form.set('layout', new File([text], 'layout.json', { type: 'application/json' }));
    return call(`/admin/walls/${wall}/import`, { method: 'POST', body: form });
  };

  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H',
    email: `v${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });

  const addWall = (id: string, name: string, kind: 'browser' | 'epaper' = 'browser') => {
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, kind, layout_mode, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'freeform', ?, ?, ?)`,
    ).run(id, name, `seed-${id}`, kind === 'epaper' ? null : 'panels', kind, at, at, at);
  };
  addWall('w1', 'Kitchen');
  addWall('w2', 'Hall');

  const widgets = (screen: string) =>
    db
      .prepare(
        `SELECT id, orientation, slot, type, parent_id AS parentId, config, custom_css AS source,
                custom_css_scoped AS scoped
           FROM layout_widgets WHERE screen_id = ? ORDER BY orientation, slot, type, z`,
      )
      .all(screen) as {
      id: string;
      orientation: string;
      slot: string | null;
      type: string;
      parentId: string | null;
      config: string | null;
      source: string | null;
      scoped: string | null;
    }[];
  const snapshots = (screen: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM layout_snapshots WHERE screen_id = ?').get(screen) as { n: number }).n;

  return {
    db,
    call,
    bare: (path: string) => app.fetch(new Request(`http://localhost${path}`)),
    postForm,
    postJson,
    importFile,
    addWall,
    widgets,
    snapshots,
    now: () => clock,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const PORTRAIT = {
  screen: 'w1',
  mode: 'freeform',
  aspect: 0.5625,
  orientation: 'portrait',
  background: { type: 'solid', color: '#223344' },
  widgets: [
    { id: 'g1', type: 'group', x: 0, y: 0, w: 1, h: 0.3, z: 0, config: { layout: 'row' } },
    { id: 'c1', type: 'clock', x: 0, y: 0, w: 0.5, h: 1, z: 0, parentId: 'g1' },
    {
      id: 'q1',
      type: 'qr',
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1,
      z: 1,
      parentId: 'g1',
      config: { ssid: 'Guests', wifiPassword: 'hunter2hunter2' },
    },
    { id: 'k1', type: 'calendar', x: 0, y: 0.3, w: 1, h: 0.7, z: 1 },
  ],
};

/** A wall with every kind of thing a state carries: a group, a named layout and its hours, CSS and a look. */
async function furnish(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  expect((await h.postJson('/admin/layout', PORTRAIT)).status).toBe(200);
  h.tick(SNAPSHOT_COALESCE_MS + 1);
  expect(
    (
      await h.postJson('/admin/layout', {
        screen: 'w1',
        mode: 'freeform',
        aspect: 1.7778,
        orientation: 'landscape',
        widgets: [{ id: 'l1', type: 'weather', x: 0, y: 0, w: 1, h: 1, z: 0 }],
      })
    ).status,
  ).toBe(200);
  h.tick(SNAPSHOT_COALESCE_MS + 1);
  expect(
    (
      await h.postJson('/admin/layout', {
        screen: 'w1',
        mode: 'freeform',
        aspect: 0.5625,
        slot: 'morning',
        // A background is per orientation, whichever layout is saved, so the
        // morning layout's save carries the one the everyday layout set.
        background: PORTRAIT.background,
        widgets: [{ id: 'm1', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 0, config: { text: 'Lunches' } }],
      })
    ).status,
  ).toBe(200);
  h.tick(SNAPSHOT_COALESCE_MS + 1);
  expect(
    (await h.postJson('/admin/layout/schedule', { screen: 'w1', rules: [{ slot: 'morning', from: '06:30', to: '08:30' }] }))
      .status,
  ).toBe(200);
  h.db
    .prepare(`UPDATE screens SET layout_gutter = 2, widget_ground = 'solid', motion = 0, theme = 'almanac' WHERE id = 'w1'`)
    .run();
  h.tick(SNAPSHOT_COALESCE_MS + 1);
  expect(
    (
      await h.postForm('/admin/walls/w1/css', {
        css_form: '1',
        css_wall: '.fw { letter-spacing: 0.02em }',
        css_w_c1: '.clock { font-weight: 300 }',
      })
    ).status,
  ).toBe(302);
  h.tick(SNAPSHOT_COALESCE_MS + 1);
}

describe('earlier versions (M8.4)', () => {
  it('keeps the wall as it was before a save, once per Save, and not when nothing changed', async () => {
    const h = await harness();
    expect(h.snapshots('w1')).toBe(0);
    // The first save: the wall as it was (empty) is kept.
    await h.postJson('/admin/layout', PORTRAIT);
    expect(h.snapshots('w1')).toBe(1);
    // The rest of the same Save: inside the burst, nothing more.
    h.tick(2_000);
    await h.postJson('/admin/layout', { ...PORTRAIT, orientation: 'landscape' });
    expect(h.snapshots('w1')).toBe(1);
    // A later Save is a new version.
    h.tick(SNAPSHOT_COALESCE_MS);
    await h.postJson('/admin/layout', { ...PORTRAIT, widgets: PORTRAIT.widgets.slice(3) });
    expect(h.snapshots('w1')).toBe(2);
    // A save that changes nothing is not one: the wall is what the last version holds only if
    // nothing changed since it was taken, so save twice with the same canvas and then again.
    h.tick(SNAPSHOT_COALESCE_MS);
    await h.postJson('/admin/layout', { ...PORTRAIT, widgets: PORTRAIT.widgets.slice(3) });
    expect(h.snapshots('w1')).toBe(3);
    h.tick(SNAPSHOT_COALESCE_MS);
    await h.postJson('/admin/layout', { ...PORTRAIT, widgets: PORTRAIT.widgets.slice(3) });
    expect(h.snapshots('w1')).toBe(3);
  });

  it('keeps the newest twenty, takes none of a panel, and goes with the wall', async () => {
    const h = await harness();
    const first = h.now();
    for (let i = 0; i < SNAPSHOTS_KEPT + 5; i++) {
      await h.postJson('/admin/layout', { ...PORTRAIT, aspect: 0.5 + i / 100 });
      h.tick(SNAPSHOT_COALESCE_MS + 1);
    }
    expect(h.snapshots('w1')).toBe(SNAPSHOTS_KEPT);
    const reasons = h.db
      .prepare('SELECT created_at AS at FROM layout_snapshots WHERE screen_id = ? ORDER BY created_at')
      .all('w1') as { at: number }[];
    // The oldest five went, not the newest.
    expect(reasons[0]?.at).toBeGreaterThan(first + 4 * SNAPSHOT_COALESCE_MS);

    h.addWall('p1', 'Panel', 'epaper');
    expect(snapshotWall(h.db, 'p1', 'x', Date.now())).toBe(false);
    expect(readWallState(h.db, 'p1')).toBeUndefined();

    revokeScreen(h.db, 'w1');
    expect(deleteScreen(h.db, 'w1')).toBe(true);
    expect(h.snapshots('w1')).toBe(0);
  });

  it('restores every layout, the hours and the look, and keeps how it looked first', async () => {
    const h = await harness();
    await furnish(h);
    const before = readWallState(h.db, 'w1');
    expect(before).toBeDefined();
    expect(wallStateSchema.safeParse(before).success).toBe(true);
    const widgetsBefore = h.widgets('w1');

    // Something replaces it all: Reset to Classic.
    const reset = await h.postForm('/admin/displays/w1/reset-layout', {});
    expect(reset.status).toBe(302);
    expect(h.widgets('w1')).not.toEqual(widgetsBefore);
    h.tick(SNAPSHOT_COALESCE_MS + 1);

    const latest = h.db
      .prepare('SELECT id, reason FROM layout_snapshots WHERE screen_id = ? ORDER BY created_at DESC LIMIT 1')
      .get('w1') as { id: string; reason: string };
    expect(latest.reason).toBe('Before the layout was reset');
    const count = h.snapshots('w1');

    const page = await (await h.call('/admin/walls/w1/versions')).text();
    expect(page).toContain('Before the layout was reset');
    expect(page).toContain(`admin/walls/w1/versions/${latest.id}/restore`);

    const restored = await h.call(`/admin/walls/w1/versions/${latest.id}/restore`, { method: 'POST' });
    expect(restored.status).toBe(302);
    expect(restored.headers.get('location')).toContain('saved=wall-restored');
    expect(readWallState(h.db, 'w1')).toEqual(before);
    // The same ids, and the CSS scoped again for them.
    expect(h.widgets('w1')).toEqual(widgetsBefore);
    const clock = h.widgets('w1').find((w) => w.id === 'c1');
    expect(clock?.scoped).toContain('[data-widget-id="c1"]');
    expect(h.snapshots('w1')).toBe(count + 1);
    const kept = h.db
      .prepare('SELECT reason FROM layout_snapshots WHERE screen_id = ? ORDER BY created_at DESC LIMIT 1')
      .get('w1') as { reason: string };
    expect(kept.reason).toBe('Before an earlier version was restored');
  });

  it('reads every shipped template back as a state a restore and an import will take', async () => {
    const h = await harness();
    for (const template of TEMPLATES) {
      applyTemplate(h.db, 'w1', template);
      const state = readWallState(h.db, 'w1');
      const parsed = wallStateSchema.safeParse(state);
      expect(parsed.success, `${template.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
      if (template.id !== 'blank') expect(state?.canvases.length, template.id).toBeGreaterThan(0);
    }
  });

  it('refuses a version that is not this wall’s', async () => {
    const h = await harness();
    await furnish(h);
    const theirs = h.db.prepare('SELECT id FROM layout_snapshots WHERE screen_id = ? LIMIT 1').get('w1') as { id: string };
    const res = await h.call(`/admin/walls/w2/versions/${theirs.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(h.widgets('w2')).toEqual([]);
  });
});

describe('a layout as a file (M8.5)', () => {
  it('downloads every layout and the look, without the Wi-Fi password, the pairing or the switches', async () => {
    const h = await harness();
    await furnish(h);
    const res = await h.call('/admin/walls/w1/export.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="kitchen-layout.json"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const file = JSON.parse(text) as { format: string; version: number; state: { canvases: unknown[]; schedule: unknown[]; theme: string } };
    expect(file.format).toBe('maverick-wall-layout');
    expect(file.version).toBe(1);
    expect(file.state.canvases).toHaveLength(3);
    expect(file.state.schedule).toEqual([{ slot: 'morning', from: '06:30', to: '08:30' }]);
    expect(file.state.theme).toBe('almanac');
    expect(text).toContain('Guests');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('wifiPassword');
    for (const secret of ['seed-w1', 'token', 'allow', 'pairing']) expect(text).not.toContain(secret);
    // Behind the session, like everything else here.
    const bare = await h.bare('/admin/walls/w1/export.json');
    expect(bare.status).toBe(302);
    expect(bare.headers.get('location')).toContain('sign-in');
  });

  it('opens a file onto another wall with fresh ids, its groups re-linked and its CSS scoped to them', async () => {
    const h = await harness();
    await furnish(h);
    const text = await (await h.call('/admin/walls/w1/export.json')).text();
    const res = await h.importFile('w2', text);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('saved=wall-imported');

    const one = h.widgets('w1');
    const two = h.widgets('w2');
    expect(two.map((w) => [w.orientation, w.slot, w.type])).toEqual(one.map((w) => [w.orientation, w.slot, w.type]));
    const ids = new Set(one.map((w) => w.id));
    expect(two.some((w) => ids.has(w.id))).toBe(false);
    const group = two.find((w) => w.type === 'group');
    expect(two.filter((w) => w.parentId !== null).every((w) => w.parentId === group?.id)).toBe(true);
    const clock = two.find((w) => w.type === 'clock');
    expect(clock?.source).toBe('.clock { font-weight: 300 }');
    expect(clock?.scoped).toContain(`[data-widget-id="${clock?.id}"]`);
    expect(clock?.scoped).not.toContain('c1');
    const state = readWallState(h.db, 'w2');
    expect(state?.theme).toBe('almanac');
    expect(state?.gutter).toBe(2);
    expect(state?.widgetGround).toBe('solid');
    expect(state?.motion).toBe(false);
    expect(state?.portrait.background).toEqual({ type: 'solid', color: '#223344' });
    expect(state?.schedule).toEqual([{ slot: 'morning', from: '06:30', to: '08:30' }]);
    expect(state?.customCss).toBe('.fw { letter-spacing: 0.02em }');
    // How Hall looked before is kept.
    expect(h.snapshots('w2')).toBe(1);
  });

  it('refuses a file whole, and changes nothing, for anything a save would refuse', async () => {
    const h = await harness();
    await furnish(h);
    const good = JSON.parse(await (await h.call('/admin/walls/w1/export.json')).text()) as {
      state: { canvases: { widgets: Record<string, unknown>[] }[]; schedule: unknown[]; customCss: string | null };
    };
    const variants: [string, (file: typeof good) => unknown][] = [
      ['a website widget', (f) => { (f.state.canvases[0]?.widgets[0] as Record<string, unknown>)['type'] = 'iframe'; return f; }],
      ['a key no schema names', (f) => { (f.state.canvases[0]?.widgets[0] as Record<string, unknown>)['onclick'] = 'x'; return f; }],
      ['a stray top-level key', (f) => ({ ...f, token: 'abc' })],
      ['hours for a layout not in it', (f) => { f.state.schedule = [{ slot: 'evening', from: '18:00', to: '20:00' }]; return f; }],
      ['a parent that is not a group', (f) => { (f.state.canvases[0]?.widgets[1] as Record<string, unknown>)['parentId'] = 'nope'; return f; }],
      ['CSS that fetches', (f) => { f.state.customCss = '@import url(https://evil.example/x.css);'; return f; }],
      ['another format', (f) => ({ ...f, format: 'something-else' })],
    ];
    const before = h.widgets('w2');
    for (const [label, mutate] of variants) {
      const copy = JSON.parse(JSON.stringify(good)) as typeof good;
      const res = await h.importFile('w2', JSON.stringify(mutate(copy)));
      expect(res.status, label).toBe(400);
      expect(await res.text(), label).toContain('could not be opened');
      expect(h.widgets('w2'), label).toEqual(before);
    }
    expect((await h.importFile('w2', 'not json')).status).toBe(400);
    expect((await h.importFile('w2', ' '.repeat(300 * 1024))).status).toBe(400);
    expect(h.snapshots('w2')).toBe(0);
  });

  it('keeps the wall’s own theme when the file’s is not on this install', async () => {
    const h = await harness();
    await furnish(h);
    const file = JSON.parse(await (await h.call('/admin/walls/w1/export.json')).text()) as { state: { theme: string } };
    file.state.theme = 'custom:not-here';
    const res = await h.importFile('w2', JSON.stringify(file));
    expect(res.headers.get('location')).toContain('saved=wall-imported-theme-kept');
    expect(readWallState(h.db, 'w2')?.theme).toBe('panels');
  });
});

describe('duplicating a wall (M8.6)', () => {
  it('makes a new wall with the same look and fresh ids, that needs its own pairing and may press nothing', async () => {
    const h = await harness();
    await furnish(h);
    h.db.prepare(`UPDATE screens SET allow_todo = 1, allow_control = 1, rotation = 1, panel_width_mm = 700 WHERE id = 'w1'`).run();
    const res = await h.call('/admin/walls/w1/duplicate', { method: 'POST' });
    expect(res.status).toBe(303);
    const location = res.headers.get('location') ?? '';
    const id = /\/admin\/walls\/([0-9a-f]+)\/pair$/.exec(location)?.[1];
    expect(id).toBeDefined();
    const pair = await h.call(`/admin/walls/${id}/pair`);
    expect(pair.status).toBe(200);
    expect(await pair.text()).toContain('Kitchen (copy)');

    const row = h.db
      .prepare(
        `SELECT name, theme, token_hash AS hash, allow_todo AS todo, allow_control AS control, rotation,
                panel_width_mm AS width FROM screens WHERE id = ?`,
      )
      .get(id) as { name: string; theme: string; hash: string; todo: number; control: number; rotation: number; width: number | null };
    expect(row.name).toBe('Kitchen (copy)');
    expect(row.theme).toBe('almanac');
    expect(row.hash).not.toBe('seed-w1');
    expect(row.todo).toBe(0);
    expect(row.control).toBe(0);
    expect(row.rotation).toBe(0);
    expect(row.width).toBeNull();

    const one = readWallState(h.db, 'w1');
    const copy = readWallState(h.db, id as string);
    // The same wall, but for the ids.
    const strip = (s: typeof one) => JSON.stringify(s).replace(/"(id|parentId)":"[^"]+"/g, '"$1":"-"').replace(/data-widget-id[^\]]*\]/g, '');
    expect(strip(copy)).toBe(strip(one));
    const ids = new Set(h.widgets('w1').map((w) => w.id));
    expect(h.widgets(id as string).some((w) => ids.has(w.id))).toBe(false);
  });
});

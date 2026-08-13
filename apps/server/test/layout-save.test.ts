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
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * Saving a free-form layout from the editor.
 *
 * The route is the boundary the editor posts through, so the tests that matter
 * are the ones about what it must refuse: a widget type the wall cannot draw —
 * a web embed above all, which rule three forbids on the wall — and a
 * coordinate off the canvas. The happy path is proven end to end: what is saved
 * comes back in the manifest a real screen polls.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-layoutsave-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = `10.7.0.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'l'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
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
  const saveLayout = (payload: unknown) =>
    call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H', email: `l${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });

  // The editor saves the portrait canvas (Phase 0), so that is where round-tripped
  // widgets land; the manifest carries both canvases.
  const manifestLayout = async (): Promise<{ mode: string; widgets: { type: string }[] }> => {
    const issued = issueDisplayToken();
    const at = Date.now();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('s1','Wall',?,?,?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
    ).run(issued.tokenHash, at, at, at);
    const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
    const m = (await res.json()) as {
      layout: { mode: string; portrait: { widgets: { type: string }[] } };
    };
    return { mode: m.layout.mode, widgets: m.layout.portrait.widgets };
  };

  // A save with no session cookie, to prove the gate.
  const saveBare = (payload: unknown) =>
    app.fetch(
      new Request('http://localhost/admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );

  // A GET with no session cookie, to prove a gate.
  const getBare = (path: string) => app.fetch(new Request(`http://localhost${path}`));

  return { db, call, saveLayout, saveBare, getBare, manifestLayout };
}

const validLayout = {
  mode: 'freeform',
  aspect: 0.5625,
  widgets: [
    { id: 'a', type: 'clock', x: 0.05, y: 0.05, w: 0.4, h: 0.15, z: 0 },
    { id: 'b', type: 'calendar', x: 0.05, y: 0.25, w: 0.9, h: 0.5, z: 1 },
  ],
};

describe('saving a layout', () => {
  it('round-trips to the manifest a screen polls', async () => {
    const h = await harness();
    const res = await h.saveLayout(validLayout);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const layout = await h.manifestLayout();
    expect(layout.mode).toBe('freeform');
    expect(layout.widgets.map((w) => w.type)).toEqual(['clock', 'calendar']);
  });

  it('replaces the whole layout, it does not merge', async () => {
    const h = await harness();
    await h.saveLayout(validLayout);
    await h.saveLayout({ mode: 'freeform', aspect: 1, widgets: [{ id: 'c', type: 'weather', x: 0, y: 0, w: 0.5, h: 0.5, z: 0 }] });
    const layout = await h.manifestLayout();
    expect(layout.widgets.map((w) => w.type)).toEqual(['weather']);
  });

  it('carries per-widget config through to the manifest', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'cal', type: 'calendar', x: 0.05, y: 0.05, w: 0.9, h: 0.5, z: 0,
          config: { mode: 'list', calendars: ['fam'], count: 5,
            title: 'This week', showTitle: true, align: 'center',
            background: '#111820', opacity: 80, corners: 'rounded', shadow: true } },
        { id: 'ha', type: 'homeassistant', x: 0.05, y: 0.6, w: 0.9, h: 0.3, z: 1,
          config: { readings: ['Front door'] } },
      ],
    });
    expect(res.status).toBe(200);

    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { type: string; config?: unknown }[] } } };
    const byType = Object.fromEntries(layout.layout.portrait.widgets.map((w) => [w.type, w.config]));
    expect(byType['calendar']).toEqual({
      mode: 'list', calendars: ['fam'], count: 5,
      title: 'This week', showTitle: true, align: 'center',
      background: '#111820', opacity: 80, corners: 'rounded', shadow: true,
    });
    expect(byType['homeassistant']).toEqual({ readings: ['Front door'] });
  });

  it('accepts the week mode and month pills, and round-trips them (RFC 005)', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'wk', type: 'calendar', x: 0, y: 0, w: 1, h: 0.5, z: 0, config: { mode: 'week', calendars: ['fam'] } },
        { id: 'mo', type: 'calendar', x: 0, y: 0.5, w: 1, h: 0.5, z: 1, config: { cellEvents: 'pills' } },
      ],
    });
    expect(res.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { id: string; config?: unknown }[] } } };
    const byId = Object.fromEntries(layout.layout.portrait.widgets.map((w) => [w.id, w.config]));
    expect(byId['wk']).toEqual({ mode: 'week', calendars: ['fam'] });
    expect(byId['mo']).toEqual({ cellEvents: 'pills' });
  });

  it('rejects a calendar mode or cellEvents value it cannot draw (rule five)', async () => {
    const h = await harness();
    for (const config of [{ mode: 'agenda' }, { cellEvents: 'bars' }]) {
      const res = await h.saveLayout({
        mode: 'freeform', aspect: 0.5625,
        widgets: [{ id: 'x', type: 'calendar', x: 0, y: 0, w: 0.5, h: 0.5, z: 0, config }],
      });
      expect(res.status, JSON.stringify(config)).toBe(400);
    }
  });

  it('carries notes text and to-do items through to the manifest (RFC 005 palette)', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [
        { id: 'n', type: 'notes', x: 0, y: 0, w: 0.9, h: 0.4, z: 0, config: { text: 'Grandma\nSunday' } },
        { id: 't', type: 'todo', x: 0, y: 0.5, w: 0.9, h: 0.4, z: 1, config: { items: ['Milk', 'Dog'] } },
      ],
    });
    expect(res.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { type: string; config?: unknown }[] } } };
    const byType = Object.fromEntries(layout.layout.portrait.widgets.map((w) => [w.type, w.config]));
    expect(byType['notes']).toEqual({ text: 'Grandma\nSunday' });
    expect(byType['todo']).toEqual({ items: ['Milk', 'Dog'] });
  });

  it('carries a canvas background through, and rejects a bad colour (RFC 005 Phase 3)', async () => {
    const h = await harness();
    const ok = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      background: { type: 'gradient', from: '#0B0E11', to: '#242D38', angle: 90 },
      widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    expect(ok.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { background?: unknown } } };
    expect(layout.layout.portrait.background).toEqual({
      type: 'gradient', from: '#0B0E11', to: '#242D38', angle: 90,
    });

    // A colour the wall would not draw is a 400, not a coerced default (rule five).
    const bad = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      background: { type: 'solid', color: 'red' },
      widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    expect(bad.status).toBe(400);
  });

  it('uploads a picture, lists it, and carries an image background and widget through (RFC 005 Phase 3b)', async () => {
    const h = await harness();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    const form = new FormData();
    form.append('image', new File([png], 'wall.png', { type: 'image/png' }));
    const up = await h.call('/admin/media/upload', { method: 'POST', body: form });
    expect(up.status).toBe(200);
    const { name } = (await up.json()) as { name: string };
    expect(name).toMatch(/^[a-f0-9]{64}\.png$/);

    const list = (await (await h.call('/admin/media/list')).json()) as { images: { name: string }[] };
    expect(list.images.some((i) => i.name === name)).toBe(true);

    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      background: { type: 'image', image: name },
      widgets: [{ id: 'img', type: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, config: { image: name } }],
    });
    expect(res.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { background?: unknown; widgets: { type: string; config?: unknown }[] } } };
    expect(layout.layout.portrait.background).toEqual({ type: 'image', image: name });
    expect(layout.layout.portrait.widgets[0]).toMatchObject({ type: 'image', config: { image: name } });
  });

  it('rejects an image reference that is not a stored name — no path, ever (rule three/five)', async () => {
    const h = await harness();
    const bg = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      background: { type: 'image', image: '../secret.png' },
      widgets: [{ id: 'a', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    expect(bg.status).toBe(400);
    const widget = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, z: 0, config: { image: 'photo.png' } }],
    });
    expect(widget.status).toBe(400);
  });

  it('rejects a background that is not a hex colour', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'x', type: 'clock', x: 0.1, y: 0.1, w: 0.4, h: 0.2, z: 0,
        config: { background: 'red' } }],
    });
    expect(res.status).toBe(400);
  });

  it('carries a countdown target and label through to the manifest', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'cd', type: 'countdown', x: 0.1, y: 0.1, w: 0.4, h: 0.3, z: 0,
        config: { target: '2026-12-25', title: 'Christmas' } }],
    });
    expect(res.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { type: string; config?: unknown }[] } } };
    expect(layout.layout.portrait.widgets[0]?.config).toEqual({ target: '2026-12-25', title: 'Christmas' });
  });

  it('carries an external-module widget reference through to the manifest', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'ext', type: 'external', x: 0.1, y: 0.1, w: 0.4, h: 0.3, z: 0,
        config: { module: 'abc123' } }],
    });
    expect(res.status).toBe(200);
    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { type: string; config?: unknown }[] } } };
    expect(layout.layout.portrait.widgets[0]).toMatchObject({ type: 'external', config: { module: 'abc123' } });
  });

  it('rejects a countdown date that is not YYYY-MM-DD', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'cd', type: 'countdown', x: 0.1, y: 0.1, w: 0.4, h: 0.3, z: 0,
        config: { target: '25 December' } }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown config key rather than dropping it (rule five)', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'x', type: 'calendar', x: 0.1, y: 0.1, w: 0.4, h: 0.2, z: 0,
        config: { website: 'https://evil.example' } }],
    });
    expect(res.status).toBe(400);
    expect((h.db.prepare('SELECT count(*) c FROM layout_widgets').get() as { c: number }).c).toBe(0);
  });
});

describe('saving each orientation on its own (RFC 005)', () => {
  it('writes the orientation asked for, leaving the other canvas untouched', async () => {
    const h = await harness();
    // Portrait first (no orientation field defaults to portrait, back-compatible).
    await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'p', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    // Then landscape explicitly.
    await h.saveLayout({
      mode: 'freeform', orientation: 'landscape', aspect: 1.7778,
      widgets: [{ id: 'l', type: 'calendar', x: 0, y: 0, w: 1, h: 1, z: 0 }],
    });

    const layout = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as {
      layout: {
        portrait: { aspect: number; widgets: { type: string }[] };
        landscape: { aspect: number; widgets: { type: string }[] };
      };
    };
    expect(layout.layout.portrait.widgets.map((w) => w.type)).toEqual(['clock']);
    expect(layout.layout.portrait.aspect).toBe(0.5625);
    expect(layout.layout.landscape.widgets.map((w) => w.type)).toEqual(['calendar']);
    expect(layout.layout.landscape.aspect).toBe(1.7778);

    // Re-saving portrait must not disturb the landscape canvas.
    await h.saveLayout({
      mode: 'freeform', orientation: 'portrait', aspect: 0.5625,
      widgets: [{ id: 'p2', type: 'weather', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    const after = (await (
      await h.call('/admin/layout/preview.json')
    ).json()) as { layout: { portrait: { widgets: { type: string }[] }; landscape: { widgets: { type: string }[] } } };
    expect(after.layout.portrait.widgets.map((w) => w.type)).toEqual(['weather']);
    expect(after.layout.landscape.widgets.map((w) => w.type)).toEqual(['calendar']);
  });

  it('rejects an orientation it does not know (rule five)', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', orientation: 'sideways', aspect: 1,
      widgets: [{ id: 'x', type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('the editor preview manifest', () => {
  it('is the real manifest, carrying the layout, behind the session', async () => {
    const h = await harness();
    await h.saveLayout(validLayout);

    const res = await h.call('/admin/layout/preview.json');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      layout: { mode: string; portrait: { widgets: { type: string }[] } };
      days: unknown[];
    };
    // The same document a wall polls: it has the days grid and the saved layout.
    expect(Array.isArray(manifest.days)).toBe(true);
    expect(manifest.layout.mode).toBe('freeform');
    expect(manifest.layout.portrait.widgets.map((w) => w.type)).toEqual(['clock', 'calendar']);
  });

  it('is not served without a session', async () => {
    const h = await harness();
    const res = await h.getBare('/admin/layout/preview.json');
    expect([302, 401]).toContain(res.status);
  });
});

describe('what the boundary refuses', () => {
  it('rejects a web-embed type — rule three, on the wall', async () => {
    const h = await harness();
    for (const type of ['website', 'iframe', 'video', 'html']) {
      const res = await h.saveLayout({
        mode: 'freeform', aspect: 0.5625,
        widgets: [{ id: 'x', type, x: 0.1, y: 0.1, w: 0.4, h: 0.2, z: 0 }],
      });
      expect(res.status, `type ${type}`).toBe(400);
    }
    // Nothing was written.
    expect((h.db.prepare('SELECT count(*) c FROM layout_widgets').get() as { c: number }).c).toBe(0);
  });

  it('rejects a coordinate off the canvas', async () => {
    const h = await harness();
    const res = await h.saveLayout({
      mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'x', type: 'clock', x: 2, y: 0.1, w: 0.4, h: 0.2, z: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    const h = await harness();
    const res = await h.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('is behind the session gate', async () => {
    const h = await harness();
    const res = await h.saveBare(validLayout);
    expect([302, 401]).toContain(res.status);
    // And nothing was written by the unauthenticated attempt.
    expect((h.db.prepare('SELECT count(*) c FROM layout_widgets').get() as { c: number }).c).toBe(0);
  });
});

describe('a per-wall layout', () => {
  it('is drawn by that wall, while another inherits the default', async () => {
    const h = await harness();
    const at = Date.now();
    const tokens: Record<string, string> = {};
    for (const [id, name] of [['wA', 'Kitchen'], ['wB', 'Hall']] as const) {
      const issued = issueDisplayToken();
      tokens[id] = issued.token;
      h.db
        .prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, issued.tokenHash, at, at, at);
    }

    // Default: a clock. wA (Kitchen): its own calendar. wB (Hall): left alone.
    await h.saveLayout({
      screen: null, mode: 'freeform', aspect: 0.5625,
      widgets: [{ id: 'd', type: 'clock', x: 0.05, y: 0.05, w: 0.4, h: 0.15, z: 0 }],
    });
    await h.saveLayout({
      screen: 'wA', mode: 'freeform', aspect: 1,
      widgets: [{ id: 'k', type: 'calendar', x: 0.05, y: 0.05, w: 0.9, h: 0.8, z: 0 }],
    });

    const manifestFor = async (token: string) => {
      const res = await h.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } });
      return (await res.json()) as { layout: { mode: string; portrait: { widgets: { type: string }[] } } };
    };

    const kitchen = await manifestFor(tokens['wA']!);
    const hall = await manifestFor(tokens['wB']!);

    // The Kitchen draws its own calendar; the Hall, untouched, draws the default.
    expect(kitchen.layout.portrait.widgets.map((w) => w.type)).toEqual(['calendar']);
    expect(hall.layout.portrait.widgets.map((w) => w.type)).toEqual(['clock']);
  });
});

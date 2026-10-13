import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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
import { pollExternalModules } from '../src/modules/external/index.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { moduleVariantKey } from '../src/api/module-variant.js';
import { renderFreeformEpaper } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import type { Manifest } from '../src/api/manifest.js';
import { bitString } from './epaper-frame.js';

/**
 * A Module widget's own settings (plan item M7.6), end to end.
 *
 * One recipe installed once, placed on two walls with different settings, and
 * polled by the real job through the real fetcher at a real loopback feed that
 * counts what it is asked. What matters:
 *
 *   - each distinct request is fetched once, however many widgets ask for it,
 *     and a widget whose settings come to the install's request costs nothing;
 *   - the wall is handed a handle for its panel, never the settings, and never
 *     a Home Assistant entity id a setting names;
 *   - a reading's *value* is what reaches the feed;
 *   - a panel finds the same panel the wall does, on a real manifest.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

/** A weather-ish feed that answers by city and counts every request. */
async function feed(): Promise<{ base: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    asked.push(url.search);
    const city = url.searchParams.get('city') ?? '';
    const units = url.searchParams.get('units') ?? '';
    const t = url.searchParams.get('t') ?? '';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ city, units, t, reading: `${city.toUpperCase()}-${units}` }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, asked };
}

const recipe = (base: string): Record<string, unknown> => ({
  name: 'Weather by city',
  contract: 1,
  config: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      options: [
        { value: 'london', label: 'London' },
        { value: 'york', label: 'York' },
        { value: 'leeds', label: 'Leeds' },
      ],
      default: 'london',
    },
    { key: 'units', label: 'Units', type: 'boolean', default: 'true' },
    { key: 'days', label: 'Days', type: 'number', min: 1, max: 7, default: '3' },
    { key: 'outside', label: 'Outside temperature', type: 'ha_reading' },
  ],
  // `days` is in no request: two widgets differing only in it ask one thing.
  fetch: { url: `${base}/w?city={city}&units={units}&t={outside}`, allowLan: true, intervalSeconds: 600 },
  panel: { kind: 'text', title: 'Weather', text: '{reading}' },
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly wall: (id: string) => Promise<string>;
  readonly place: (screen: string, id: string, config: Record<string, unknown>) => void;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-variants-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const fetcher = createFetcher();
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'v'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.76.0.${++n}`,
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
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'H',
    email: `v${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const tokens = new Map<string, string>();
  const ensureScreen = (id: string): string => {
    const known = tokens.get(id);
    if (known !== undefined) return known;
    const issued = issueDisplayToken();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'panels', ?, 'freeform', ?, ?)`,
    ).run(id, id, issued.tokenHash, stamp, stamp, stamp);
    tokens.set(id, issued.token);
    return issued.token;
  };
  let z = 0;
  return {
    db,
    form,
    call,
    poll: () => pollExternalModules(db, fetcher, keyring),
    wall: async (id: string) => {
      const res = await call('/d/manifest', { headers: { authorization: `Bearer ${ensureScreen(id)}` } });
      expect(res.status).toBe(200);
      return res.text();
    },
    place: (screen: string, id: string, config: Record<string, unknown>) => {
      ensureScreen(screen);
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'external', 0, ${(z % 4) * 0.25}, 1, 0.25, ?, ?, ?, ?)`,
      ).run(id, screen, z++, JSON.stringify(config), stamp, stamp);
    },
  };
}

async function installed(h: Harness, base: string, config: Record<string, string> = {}): Promise<string> {
  const res = await h.form('/admin/modules/recipe', {
    manifest: JSON.stringify(recipe(base)),
    config: JSON.stringify(config),
  });
  expect(res.status).toBe(302);
  return (h.db.prepare(`SELECT id FROM external_modules LIMIT 1`).get() as { id: string }).id;
}

const variants = (db: SqliteDatabase): string[] =>
  (db.prepare(`SELECT variant_key FROM external_module_variants ORDER BY variant_key`).all() as { variant_key: string }[]).map(
    (row) => row.variant_key,
  );

describe('a Module widget’s own settings', () => {
  it('reads each distinct request once, however many widgets ask for it', async () => {
    const h = await harness();
    const f = await feed();
    const id = await installed(h, f.base);

    h.place('kitchen', 'a', { module: id, settings: { city: 'york' } });
    h.place('hall', 'b', { module: id, settings: { city: 'york' } });
    // Differs from York only in a setting no request reads: one fetch for both.
    h.place('hall', 'c', { module: id, settings: { city: 'york', days: '5' } });
    h.place('kitchen', 'd', { module: id, settings: { city: 'leeds', units: 'false' } });
    // Settings that come to the install's own request cost nothing more.
    h.place('kitchen', 'e', { module: id, settings: { city: 'london' } });
    h.place('kitchen', 'f', { module: id });

    await h.poll();
    expect(f.asked.sort()).toEqual(
      ['?city=leeds&units=false&t=', '?city=london&units=true&t=', '?city=york&units=true&t='].sort(),
    );
    // A variant row per distinct set of settings, whichever fetch fed it.
    expect(variants(h.db)).toHaveLength(4);

    // Within the recipe's interval, nothing is asked again.
    await h.poll();
    expect(f.asked).toHaveLength(3);
  });

  it('hands the wall a handle for its panel, and never the settings', async () => {
    const h = await harness();
    const f = await feed();
    const id = await installed(h, f.base);
    h.place('kitchen', 'a', { module: id, settings: { city: 'york' } });
    h.place('kitchen', 'b', { module: id });

    // Before the first read, the variant has no panel: the widget waits rather
    // than drawing the install's city under York's box.
    const before = JSON.parse(await h.wall('kitchen')) as Manifest;
    const key = moduleVariantKey(id, { city: 'york' });
    expect(before.panels[`ext:${id}~${key}`]).toBeUndefined();

    await h.poll();
    const text = await h.wall('kitchen');
    const manifest = JSON.parse(text) as Manifest;
    const widgets = manifest.layout.portrait.widgets;
    const a = widgets.find((w) => w.id === 'a')?.config as Record<string, unknown>;
    const b = widgets.find((w) => w.id === 'b')?.config as Record<string, unknown>;
    expect(a).toEqual({ module: id, variant: key });
    expect(b).toEqual({ module: id });
    expect(text).not.toContain('"settings"');
    expect(manifest.panels[`ext:${id}~${key}`]).toEqual({ kind: 'text', title: 'Weather', text: 'YORK-true' });
    expect(manifest.panels[`ext:${id}`]).toEqual({ kind: 'text', title: 'Weather', text: 'LONDON-true' });
  });

  it('sends a reading’s value to the feed, and its entity id to nobody', async () => {
    const h = await harness();
    const f = await feed();
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO ha_entity_cache (entity_id, friendly_name, state, watched, fetched_at)
         VALUES ('sensor.outside_temp', 'Outside', '12.5', 1, ?), ('sensor.not_watched', 'Loft', '99', 0, ?)`,
      )
      .run(stamp, stamp);
    const id = await installed(h, f.base);
    h.place('kitchen', 'a', { module: id, settings: { outside: 'sensor.outside_temp' } });
    h.place('kitchen', 'b', { module: id, settings: { city: 'leeds', outside: 'sensor.not_watched' } });
    await h.poll();
    expect(f.asked).toContain('?city=london&units=true&t=12.5');
    // A reading the household does not watch sends nothing.
    expect(f.asked).toContain('?city=leeds&units=true&t=');
    expect(f.asked.join('\n')).not.toContain('sensor.');
    const text = await h.wall('kitchen');
    expect(text).not.toContain('sensor.outside_temp');
    expect(text).not.toContain('sensor.not_watched');
  });

  it('forgets a variant no widget names, and every variant with its module', async () => {
    const h = await harness();
    const f = await feed();
    const id = await installed(h, f.base);
    h.place('kitchen', 'a', { module: id, settings: { city: 'york' } });
    h.place('kitchen', 'b', { module: id, settings: { city: 'leeds' } });
    await h.poll();
    expect(variants(h.db)).toHaveLength(2);

    h.db.prepare(`DELETE FROM layout_widgets WHERE id = 'b'`).run();
    await h.poll();
    expect(variants(h.db)).toEqual([moduleVariantKey(id, { city: 'york' })]);
    expect(Object.keys((JSON.parse(await h.wall('kitchen')) as Manifest).panels).filter((k) => k.includes('~'))).toEqual([
      `ext:${id}~${moduleVariantKey(id, { city: 'york' })}`,
    ]);

    // Removing the module takes its variants with it: the cascade is real.
    const removed = await h.form(`/admin/modules/${id}/remove`, {});
    expect([302, 303]).toContain(removed.status);
    expect(h.db.prepare(`SELECT count(*) AS c FROM external_modules`).get()).toEqual({ c: 0 });
    expect(variants(h.db)).toEqual([]);
  });

  it('refuses a pasted setting its recipe would not take, and adds nothing', async () => {
    const h = await harness();
    const f = await feed();
    for (const [config, says] of [
      [{ days: '9' }, '“Days” needs a number from 1 to 7.'],
      [{ city: 'paris' }, '“City” needs one of its choices.'],
      [{ units: 'yes' }, '“Units” is on or off.'],
      [{ outside: 'not an entity' }, '“Outside temperature” needs one of the readings you watch.'],
    ] as const) {
      const res = await h.form('/admin/modules/recipe', {
        manifest: JSON.stringify(recipe(f.base)),
        config: JSON.stringify(config),
      });
      expect(res.status).toBe(400);
      // The page escapes the sentence's quotes or not; the words are what count.
      const page = (await res.text()).replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”');
      expect(page).toContain(says);
    }
    expect(h.db.prepare(`SELECT count(*) AS c FROM external_modules`).get()).toEqual({ c: 0 });
  });

  it('draws on a panel the variant the wall draws, from a real manifest', async () => {
    const h = await harness();
    const f = await feed();
    const id = await installed(h, f.base);
    h.place('kitchen', 'a', { module: id, settings: { city: 'york' } });
    await h.poll();
    const manifest = JSON.parse(await h.wall('kitchen')) as Manifest;
    const frame = (config: Record<string, unknown>): string => {
      const fb = renderFreeformEpaper(
        buildEpaperModel(manifest),
        manifest,
        [{ type: 'external', x: 0, y: 0, w: 1, h: 1, z: 0, config }],
        { width: 400, height: 240 },
      );
      return bitString(fb);
    };
    const york = frame({ module: id, settings: { city: 'york' } });
    const london = frame({ module: id });
    const none = frame({ module: 'nothing-installed' });
    // Each finds its own panel, and neither is the "No data yet" a panel drew
    // for every Module widget while it read panels by the bare id.
    expect(york).not.toBe(london);
    expect(london).not.toBe(none);
    expect(york).not.toBe(none);
  });
});

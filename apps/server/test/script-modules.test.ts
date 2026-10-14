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
import { runScript } from '../src/modules/external/sandbox.js';
import { scriptSha256 } from '../src/modules/external/script.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { catalogSchema } from '../src/http/catalog.js';
import { entry as moonPhase } from '../src/catalog/moon-phase.js';
import type { Manifest } from '../src/api/manifest.js';
import { modulePicture } from '../src/modules/external/images.js';
import { moduleImageHandle } from '../src/api/module-image-handle.js';

/**
 * Script modules end to end (RFC 017, plan item M7.12): pasted through the
 * admin behind the household's consent, run by the real job in the real
 * sandbox through the real fetcher at a loopback host, and drawn on a wall.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

async function feed(): Promise<{ base: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ bins: [{ kind: 'Recycling', in: 3 }, { kind: 'Garden', in: 1 }, { kind: 'Rubbish', in: 8 }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, asked };
}

const MANIFEST = { name: 'Next bin', contract: 1, hosts: ['127.0.0.1'], allowLan: true, intervalSeconds: 600, config: [{ key: 'base', label: 'Base', type: 'string' }] };

/** Which of three bins goes out next: a sort a recipe cannot do. */
const SOURCE = `export default async function run(ctx) {
  const res = await ctx.fetch(ctx.config.base + '/bins');
  const bins = (await res.json()).bins.slice().sort((a, b) => a.in - b.in);
  const next = bins[0];
  return {
    panel: { kind: 'stat', title: 'Next bin', value: next.kind, caption: 'in ' + next.in + (next.in === 1 ? ' day' : ' days') },
    signals: next.in <= 1 ? [{ key: 'bin-' + next.kind, title: next.kind + ' goes out tonight', severity: 'Minor' }] : [],
  };
}
`;

interface Harness {
  readonly db: SqliteDatabase;
  readonly dataDir: string;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly wall: () => Promise<Manifest>;
}

async function harness(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-scripts-'));
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
    auth: { secret: 's'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.77.0.${++n}`,
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
  await form('/setup/account', { name: 'H', email: `s${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);
  return {
    db,
    dataDir,
    form,
    call,
    poll: () => pollExternalModules(db, fetcher, keyring),
    wall: async () => {
      const res = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
      expect(res.status).toBe(200);
      return (await res.json()) as Manifest;
    },
  };
}

const consentOf = (html: string): string => /name="consent" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? '';
const count = (db: SqliteDatabase): number => (db.prepare(`SELECT count(*) AS n FROM external_modules`).get() as { n: number }).n;

/** Paste the script and agree to what the page says it may reach. */
async function paste(h: Harness, base: string, source = SOURCE, manifest: Record<string, unknown> = MANIFEST): Promise<string> {
  const fields = { manifest: JSON.stringify(manifest), source, config: JSON.stringify({ base }) };
  const check = await h.form('/admin/modules/script', fields);
  expect(check.status).toBe(200);
  const added = await h.form('/admin/modules/script', { ...fields, consent: consentOf(await check.text()) });
  expect(added.status).toBe(302);
  return (h.db.prepare(`SELECT id FROM external_modules ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { id: string }).id;
}

const place = (h: Harness, id: string, module: string): void => {
  const stamp = Date.now();
  h.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, 'kitchen', 'portrait', 'external', 0, 0, 1, 0.3, 0, ?, ?, ?)`,
    )
    .run(id, JSON.stringify({ module }), stamp, stamp);
};

describe('pasting a script', () => {
  it('shows what it may reach and the code’s hash before anything is added, and adds it only on that page', async () => {
    const h = await harness();
    const f = await feed();
    const fields = { manifest: JSON.stringify(MANIFEST), source: SOURCE, config: JSON.stringify({ base: f.base }) };
    const check = await h.form('/admin/modules/script', fields);
    const html = await check.text();
    expect(check.status).toBe(200);
    expect(html).toContain('127.0.0.1');
    expect(html).toContain('including addresses on your own network');
    expect(html).toContain(`data-script-sha>${scriptSha256(SOURCE)}`);
    expect(count(h.db)).toBe(0);

    // Agreed to one script, and pasted another: asked again, and nothing added.
    const changed = await h.form('/admin/modules/script', {
      ...fields,
      source: SOURCE.replace('Next bin', 'Next bin!'),
      consent: consentOf(html),
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain('Before it runs');
    // So is another host.
    await h.form('/admin/modules/script', {
      ...fields,
      manifest: JSON.stringify({ ...MANIFEST, hosts: ['127.0.0.1', 'example.com'] }),
      consent: consentOf(html),
    });
    expect(count(h.db)).toBe(0);
    expect(f.asked).toEqual([]);

    const added = await h.form('/admin/modules/script', { ...fields, consent: consentOf(html) });
    expect(added.status).toBe(302);
    const row = h.db.prepare(`SELECT kind, script, url FROM external_modules`).get() as { kind: string; script: string; url: string };
    expect(row).toEqual({ kind: 'script', script: SOURCE, url: 'https://127.0.0.1' });
  });

  it('refuses a manifest or a script that is not one, and names the field', async () => {
    const h = await harness();
    const bad = await h.form('/admin/modules/script', {
      manifest: JSON.stringify({ ...MANIFEST, secrets: [{ key: 'k', label: 'K', host: 'elsewhere.example' }] }),
      source: SOURCE,
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('secrets.0.host');
    const noDefault = await h.form('/admin/modules/script', { manifest: JSON.stringify(MANIFEST), source: 'function run() {}' });
    expect(noDefault.status).toBe(400);
    expect(await noDefault.text()).toContain('no export default');
    expect(count(h.db)).toBe(0);
  });

  it('runs once for real, after the consent, and adds nothing', async () => {
    const h = await harness();
    const f = await feed();
    const fields = { manifest: JSON.stringify(MANIFEST), source: SOURCE, config: JSON.stringify({ base: f.base }) };
    // Without the consent, the page only asks.
    const asked = await h.form('/admin/modules/script/run', fields);
    expect(await asked.text()).toContain('Before it runs');
    expect(f.asked).toEqual([]);
    const consent = consentOf(await (await h.form('/admin/modules/script', fields)).text());
    const ran = await h.form('/admin/modules/script/run', { ...fields, consent });
    const html = await ran.text();
    expect(ran.status).toBe(200);
    expect(html).toContain('&quot;value&quot;: &quot;Garden&quot;');
    expect(html).toContain('data-script-timing');
    expect(f.asked).toEqual(['/bins']);
    expect(count(h.db)).toBe(0);
  });
});

describe('the poll runs a script, and a failing one costs its own panel only', () => {
  it('draws what it returns, raises its signals, and keeps the last good panel when it breaks', async () => {
    const h = await harness();
    const f = await feed();
    const id = await paste(h, f.base);
    place(h, 'w1', id);
    await h.poll();

    const row = () =>
      h.db.prepare(`SELECT panel, signals, last_error FROM external_modules WHERE id = ?`).get(id) as {
        panel: string | null;
        signals: string | null;
        last_error: string | null;
      };
    expect(JSON.parse(row().panel ?? 'null')).toEqual({ kind: 'stat', title: 'Next bin', value: 'Garden', caption: 'in 1 day' });
    expect(JSON.parse(row().signals ?? 'null')).toEqual({ signals: [{ key: 'bin-Garden', title: 'Garden goes out tonight', severity: 'Minor' }] });
    expect(row().last_error).toBeNull();
    const wall = await h.wall();
    expect(wall.panels[`ext:${id}`]).toEqual({ kind: 'stat', title: 'Next bin', value: 'Garden', caption: 'in 1 day' });

    // A second script, polled after the first breaks.
    const other = await paste(h, f.base, SOURCE.replace("title: 'Next bin'", "title: 'Other'"));

    h.db.prepare(`UPDATE external_modules SET script = ?, last_polled_at = 0 WHERE id = ?`).run(
      'export default async function run() { for (;;) {} }',
      id,
    );
    await h.poll();
    expect(row().last_error).toMatch(/^The module’s code worked for too long and was stopped\. InternalError: interrupted$/);
    expect(JSON.parse(row().panel ?? 'null')).toMatchObject({ value: 'Garden' });
    expect(JSON.parse(row().signals ?? 'null')).toMatchObject({ signals: [{ key: 'bin-Garden' }] });
    const second = h.db.prepare(`SELECT panel, last_error FROM external_modules WHERE id = ?`).get(other) as {
      panel: string;
      last_error: string | null;
    };
    expect(second.last_error).toBeNull();
    expect(JSON.parse(second.panel)).toMatchObject({ title: 'Other' });

    // Its card says what it may contact and which code it is running.
    const store = await (await h.call('/admin/modules')).text();
    expect(store).toContain('May contact 127.0.0.1');
    expect(store).toContain(scriptSha256('export default async function run() { for (;;) {} }'));
  });

  it('clears its signals when a run names none, and polls again only after its interval', async () => {
    const h = await harness();
    const f = await feed();
    const id = await paste(h, f.base);
    await h.poll();
    expect(f.asked).toHaveLength(1);
    await h.poll();
    expect(f.asked).toHaveLength(1);
    h.db.prepare(`UPDATE external_modules SET script = ?, last_polled_at = 0 WHERE id = ?`).run(
      SOURCE.replace('next.in <= 1', 'false'),
      id,
    );
    await h.poll();
    const signals = (h.db.prepare(`SELECT signals FROM external_modules WHERE id = ?`).get(id) as { signals: string }).signals;
    expect(JSON.parse(signals)).toEqual({ signals: [] });
  });

  it('refuses a stored script the schema no longer takes, and says so', async () => {
    const h = await harness();
    const f = await feed();
    const id = await paste(h, f.base);
    h.db.prepare(`UPDATE external_modules SET recipe = ? WHERE id = ?`).run(JSON.stringify({ ...MANIFEST, hosts: ['NOT A HOST'] }), id);
    await h.poll();
    expect((h.db.prepare(`SELECT last_error FROM external_modules WHERE id = ?`).get(id) as { last_error: string }).last_error).toBe(
      'This module is not valid.',
    );
    expect(f.asked).toEqual([]);
  });
});

describe('a script reaches the house and the wall only as data', () => {
  it('is handed a reading’s value, never its entity id', async () => {
    const h = await harness();
    const f = await feed();
    const stamp = Date.now();
    h.db
      .prepare(`INSERT INTO ha_entity_cache (entity_id, friendly_name, state, watched, fetched_at) VALUES ('sensor.outside', 'Outside', '12.5', 1, ?)`)
      .run(stamp);
    const manifest = { ...MANIFEST, config: [...MANIFEST.config, { key: 'outside', label: 'Outside', type: 'ha_reading' }] };
    const source = `export default async function run(ctx) {
      await ctx.fetch(ctx.config.base + '/bins?t=' + ctx.config.outside);
      return { panel: { kind: 'text', text: 'outside ' + JSON.stringify(ctx.config) } };
    }`;
    const fields = { manifest: JSON.stringify(manifest), source, config: JSON.stringify({ base: f.base, outside: 'sensor.outside' }) };
    const check = await h.form('/admin/modules/script', fields);
    expect((await h.form('/admin/modules/script', { ...fields, consent: consentOf(await check.text()) })).status).toBe(302);
    await h.poll();
    expect(f.asked).toEqual(['/bins?t=12.5']);
    const panel = (h.db.prepare(`SELECT panel FROM external_modules`).get() as { panel: string }).panel;
    expect(panel).toContain('12.5');
    expect(panel).not.toContain('sensor.outside');
  });

  it('shows a picture only from a host it declared', async () => {
    const h = await harness();
    // A real 1x1 PNG, from two hosts: one declared, one not.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const pictures: string[] = [];
    const picture = async (address: string): Promise<string> => {
      const server = createServer((request, response) => {
        pictures.push(`${address}${request.url ?? ''}`);
        response.setHeader('content-type', 'image/png');
        response.end(png);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, address, resolve));
      const at = server.address();
      if (at === null || typeof at === 'string') throw new Error('no port');
      return `http://${address}:${at.port}/p.png`;
    };
    const declared = await picture('127.0.0.1');
    const undeclared = await picture('127.0.0.2');
    const source = (url: string) => `export default function run() { return { panel: { kind: 'image', url: '${url}' } }; }`;
    const a = await paste(h, '', source(declared));
    const b = await paste(h, '', source(undeclared));
    await h.poll();
    const context = { db: h.db, fetcher: createFetcher(), dataDir: h.dataDir };
    expect((await modulePicture(context, moduleImageHandle(a, declared)))?.contentType).toBe('image/png');
    expect(await modulePicture(context, moduleImageHandle(b, undeclared))).toBeUndefined();
    expect(pictures).toEqual([`127.0.0.1/p.png`]);
  });
});

describe('the store’s script', () => {
  it('installs from the store with its consent on the page, and draws the moon', async () => {
    const h = await harness();
    const store = await (await h.call('/admin/modules')).text();
    expect(store).toContain('Moon phase');
    expect(store).toContain('admin/modules/script/install/moon-phase');
    const page = await (await h.call('/admin/modules/script/install/moon-phase')).text();
    expect(page).toContain('It contacts nothing');
    expect(page).toContain(scriptSha256(moonPhase.kind === 'script' ? moonPhase.source : ''));
    expect((await h.form('/admin/modules/script/install/moon-phase', { name: 'Moon' })).status).toBe(302);
    await h.poll();
    const row = h.db.prepare(`SELECT name, panel, last_error FROM external_modules`).get() as {
      name: string;
      panel: string;
      last_error: string | null;
    };
    expect(row.last_error).toBeNull();
    expect(row.name).toBe('Moon');
    expect(JSON.parse(row.panel)).toMatchObject({ kind: 'timeline' });
  });

  it('names every quarter of January 2024 within a day of the almanac', async () => {
    if (moonPhase.kind !== 'script') throw new Error('the moon is a script');
    const outcome = await runScript({
      source: moonPhase.source,
      config: {},
      now: Date.parse('2024-01-01T00:00:00Z'),
      timeZone: 'Europe/London',
      fetch: async () => {
        throw new Error('it fetches nothing');
      },
    });
    if (!outcome.ok) throw new Error(outcome.detail);
    const panel = outcome.panel as { title: string; items: { at: string; label: string }[] };
    // The almanac's own instants, in UTC (HM Nautical Almanac Office / USNO).
    const almanac: [string, string][] = [
      ['Last quarter', '2024-01-04T03:30:00Z'],
      ['New moon', '2024-01-11T11:57:00Z'],
      ['First quarter', '2024-01-18T03:52:00Z'],
      ['Full moon', '2024-01-25T17:54:00Z'],
    ];
    expect(panel.items.map((item) => item.label)).toEqual(almanac.map(([label]) => label));
    panel.items.forEach((item, i) => {
      expect(Math.abs(Date.parse(item.at) - Date.parse(almanac[i]![1]))).toBeLessThan(24 * 3_600_000);
    });
    // On the night of 31 December 2023 the moon was a waning gibbous, about four-fifths lit.
    expect(panel.title).toMatch(/^Moon: waning gibbous, (7[5-9]|8\d)% lit$/);
  });

  it('may not reach the household’s network from the store', () => {
    const moon = moonPhase;
    if (moon.kind !== 'script') throw new Error('the moon is a script');
    const parse = (allowLan: boolean) =>
      catalogSchema.safeParse({ version: 1, modules: [{ ...moon, manifest: { ...moon.manifest, allowLan } }] }).success;
    expect(parse(false)).toBe(true);
    expect(parse(true)).toBe(false);
  });
});

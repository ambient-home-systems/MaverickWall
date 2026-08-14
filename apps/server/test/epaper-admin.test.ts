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
 * The eInk Displays admin page, driven through the real app.
 *
 * The point worth proving end to end: the URL the page hands the household is
 * not decoration — the token in it renders a real frame over `/d/epaper`. So
 * this creates a screen the way the sidebar does, pulls the URL out of the
 * config page, and fetches it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-epadmin-'));
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
    clientAddress: () => `10.7.0.${++nextAddress}`,
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
    email: `epadmin${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

const B = 'http://localhost:8080';
const frameUrl = (html: string): string | undefined => /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];

describe('the eInk Displays page', () => {
  it('shows the add form', async () => {
    const h = await harness();
    const html = await (await h.call(`${B}/admin/epaper`)).text();
    expect(html).toContain('Add an eInk screen');
    expect(html).toContain('Seeed 7.5'); // the preset option (the quote is HTML-escaped)
  });

  it('creates a Seeed 7.5" screen and hands over a working URL and both recipes', async () => {
    const h = await harness();
    const res = await h.post(`${B}/admin/epaper`, { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The recipes are both present, pre-filled.
    expect(html).toContain('online_image'); // ESPHome
    expect(html).toContain('opendisplay.upload_image'); // Home Assistant

    // The row is a real epaper screen with the preset's geometry.
    const row = h.db.prepare(`SELECT kind, panel_width AS w, panel_height AS h FROM screens LIMIT 1`).get() as {
      kind: string;
      w: number;
      h: number;
    };
    expect(row).toEqual({ kind: 'epaper', w: 800, h: 480 });

    // The URL it printed actually renders a frame — the whole point.
    const url = frameUrl(html);
    expect(url).toBeDefined();
    const frame = await h.call(url!);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/png');
  });

  it('accepts a custom size and rejects a silly one', async () => {
    const h = await harness();
    const ok = await h.post(`${B}/admin/epaper`, {
      name: 'Tiny',
      preset: 'custom',
      width: '296',
      height: '128',
      rotation: '90',
    });
    expect(ok.status).toBe(200);
    const row = h.db.prepare(`SELECT panel_width AS w, panel_height AS h, rotation FROM screens LIMIT 1`).get() as {
      w: number;
      h: number;
      rotation: number;
    };
    expect(row).toEqual({ w: 296, h: 128, rotation: 90 });

    const bad = await h.post(`${B}/admin/epaper`, {
      name: 'Silly',
      preset: 'custom',
      width: '5',
      height: '999999',
      rotation: '0',
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('between 64 and 2000');
  });

  it('removing a screen drops it from the list and kills its URL', async () => {
    const h = await harness();
    const html = await (await h.post(`${B}/admin/epaper`, { name: 'Gone', preset: 'seeed-7in5', rotation: '0' })).text();
    const url = frameUrl(html)!;
    expect((await h.call(url)).status).toBe(200);

    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;
    await h.post(`${B}/admin/epaper/${id}/revoke`, {});

    expect((await h.call(url)).status).toBe(404); // token no longer resolves
    expect(await (await h.call(`${B}/admin/epaper`)).text()).not.toContain('Gone');
  });
});

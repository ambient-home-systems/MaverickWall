import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
import type { Manifest } from '../src/api/manifest.js';
import { PRESSES_PER_MINUTE, resetOperateLimits } from '../src/modules/homeassistant/control.js';

/**
 * Webhook buttons (RFC 018 §9, phase 5), against the real app, a real database
 * and a real HTTP server on loopback standing in for whatever the household's
 * button calls.
 *
 * What is held here is mostly what never happens: the wall never sends or
 * receives an address, the admin never shows a path or a header's value, a
 * press sends no body and no header but the one the household set, a redirect
 * is never followed, and a button nobody marked cannot be pressed.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

beforeEach(() => resetOperateLimits());

interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** What the button calls: records every request, and answers what it is told to. */
async function receiver(): Promise<{
  base: string;
  readonly received: Received[];
  answer: { status: number; location?: string };
}> {
  const state = { base: '', received: [] as Received[], answer: { status: 200 } as { status: number; location?: string } };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      state.received.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (state.answer.location !== undefined) headers['location'] = state.answer.location;
      response.writeHead(state.answer.status, headers);
      response.end('a body nothing reads');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return state;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly press: (fields: Record<string, string>) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; text: string }>;
  readonly allowControl: (on?: boolean) => void;
  readonly widget: (config: Record<string, unknown>, type?: string) => string;
  /** The id of the button with this name. */
  readonly idOf: (name: string) => string;
}

async function harness(): Promise<Harness> {
  const address = `10.19.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-webhook-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
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
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `button${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Hall wall', ?, 'panels', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  let widgets = 0;
  return {
    db,
    form,
    get: (path) => call(path),
    press: (fields) =>
      call('/d/buttons/press', {
        method: 'POST',
        headers: { authorization: `Bearer ${issued.token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    manifest: async () => {
      const response = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
      const text = await response.text();
      return { body: JSON.parse(text) as Manifest, text };
    },
    allowControl: (on = true) => {
      db.prepare('UPDATE screens SET allow_control = ? WHERE id = ?').run(on ? 1 : 0, 'wall');
    },
    widget: (config, type = 'buttons') => {
      const id = `b-${++widgets}`;
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, 'wall', 'portrait', ?, 0, 0, 1, 0.2, ?, ?, ?, ?)`,
      ).run(id, type, widgets, JSON.stringify(config), stamp, stamp);
      return id;
    },
    idOf: (name) => (db.prepare('SELECT id FROM webhook_targets WHERE name = ?').get(name) as { id: string }).id,
  };
}

/** A button on loopback, added through the real form, pressable and on an acting widget. */
async function readyButton(
  h: Harness,
  base: string,
  extra: Record<string, string> = {},
): Promise<{ button: string; widget: string }> {
  expect(
    (await h.form('/admin/buttons', {
      name: 'Chime',
      url: `${base}/hooks/chime-secret-path`,
      allow_lan: '1',
      allow_http: '1',
      ...extra,
    })).status,
  ).toBe(302);
  const button = h.idOf('Chime');
  expect((await h.form(`/admin/buttons/${button}/pressable`, { pressable: '1' })).status).toBe(302);
  h.allowControl();
  return { button, widget: h.widget({ tapAction: 'act' }) };
}

describe('the Buttons screen', () => {
  it('seals the address, shows only its host, and never writes the header’s value into a page', async () => {
    const h = await harness();
    const at = await receiver();
    await h.form('/admin/buttons', {
      name: 'Chime',
      url: `${at.base}/hooks/chime-secret-path`,
      header_name: 'X-Token',
      header_value: 'header-secret-value',
      allow_lan: '1',
      allow_http: '1',
    });
    const page = await (await h.get('/admin/buttons')).text();
    expect(page).toContain('Chime');
    expect(page).toContain(new URL(at.base).host);
    expect(page).toContain('sends X-Token');
    expect(page).not.toContain('chime-secret-path');
    expect(page).not.toContain('header-secret-value');
    const table = JSON.stringify(h.db.prepare('SELECT * FROM webhook_targets').all());
    expect(table).not.toContain('chime-secret-path');
    expect(table).not.toContain('header-secret-value');
  });

  it.each([
    [{ name: '', url: 'https://example.com/hook' }, 'Give the button a name'],
    [{ name: 'A', url: 'not an address' }, 'That is not an address'],
    [{ name: 'A', url: 'ftp://example.com/hook' }, 'only call an http or https'],
    [{ name: 'A', url: 'http://example.com/hook' }, 'Allow plain http'],
    [{ name: 'A', url: 'https://example.com/hook', header_name: 'X-Token' }, 'both a name and a value'],
    [{ name: 'A', url: 'https://example.com/hook', header_name: 'Host', header_value: 'x' }, 'cannot be used'],
  ])('refuses %j, and says why', async (fields, sentence) => {
    const h = await harness();
    const response = await h.form('/admin/buttons', fields as Record<string, string>);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(sentence);
    expect(h.db.prepare('SELECT count(*) AS n FROM webhook_targets').get()).toEqual({ n: 0 });
  });

  it('warns that a Home Assistant webhook is a script by another name', async () => {
    const h = await harness();
    await h.form('/admin/buttons', { name: 'Doorbell', url: 'https://ha.example/api/webhook/abc123' });
    expect(await (await h.get('/admin/buttons')).text()).toContain('a script by another name');
  });

  it('starts every button not pressable, and says what the switch does when saved', async () => {
    const h = await harness();
    await h.form('/admin/buttons', { name: 'Chime', url: 'https://example.com/hook' });
    const id = h.idOf('Chime');
    expect((h.db.prepare('SELECT pressable FROM webhook_targets').get() as { pressable: number }).pressable).toBe(0);
    const on = await h.form(`/admin/buttons/${id}/pressable`, { pressable: '1' });
    expect(on.headers.get('location')).toContain('saved=button-pressable');
    const off = await h.form(`/admin/buttons/${id}/pressable`, {});
    expect(off.headers.get('location')).toContain('saved=button-not-pressable');
  });
});

describe('the manifest', () => {
  it('carries no buttons panel until a first button exists, so nobody else’s ETag moves', async () => {
    const h = await harness();
    const { body, text } = await h.manifest();
    expect(body.panels['buttons']).toBeUndefined();
    expect(text).not.toContain('"buttons"');
  });

  it('carries each button’s id and name, and `press` only on one marked pressable — never an address', async () => {
    const h = await harness();
    const at = await receiver();
    await readyButton(h, at.base);
    await h.form('/admin/buttons', { name: 'Garden lights', url: `${at.base}/hooks/garden` , allow_lan: '1', allow_http: '1'});
    const { body, text } = await h.manifest();
    const panel = body.panels['buttons'] as { buttons: { key: string; label: string; actions?: string[] }[] };
    expect(panel.buttons).toEqual([
      { key: h.idOf('Chime'), label: 'Chime', actions: ['press'] },
      { key: h.idOf('Garden lights'), label: 'Garden lights' },
    ]);
    expect(text).not.toContain('/hooks/');
    expect(text).not.toContain('127.0.0.1');
  });
});

describe('a press', () => {
  it('posts nothing but itself: an empty body, no header but the household’s, and records it', async () => {
    const h = await harness();
    const at = await receiver();
    const { button, widget } = await readyButton(h, at.base, { header_name: 'X-Token', header_value: 's3cret' });
    const response = await h.press({ button, widget });
    expect(response.status).toBe(200);
    expect(at.received).toHaveLength(1);
    const [request] = at.received;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe('/hooks/chime-secret-path');
    expect(request?.body).toBe('');
    expect(request?.headers['x-token']).toBe('s3cret');
    // No cookie, no authorization, and nothing the wall could have chosen.
    expect(request?.headers['cookie']).toBeUndefined();
    expect(request?.headers['authorization']).toBeUndefined();
    const page = await (await h.get('/admin/buttons')).text();
    expect(page).toContain('Recent presses from walls');
    expect(page).toContain('Hall wall');
  });

  it('refuses in RFC 018’s order, and sends nothing for any refusal', async () => {
    const h = await harness();
    const at = await receiver();
    const { button, widget } = await readyButton(h, at.base);
    const showsOnly = h.widget({});
    const elsewhere = h.widget({ tapAction: 'act', buttons: ['wh-000000000000'] });
    const homeAssistant = h.widget({ tapAction: 'act' }, 'homeassistant');

    h.allowControl(false);
    expect((await h.press({ button, widget })).status).toBe(403);
    h.allowControl(true);
    expect((await h.press({ button: 'not-a-button', widget })).status).toBe(400);
    expect((await h.press({ button: 'wh-000000000000', widget })).status).toBe(404);
    for (const other of [showsOnly, elsewhere, homeAssistant, 'no-such-widget']) {
      expect((await h.press({ button, widget: other })).status, other).toBe(403);
    }
    await h.form(`/admin/buttons/${button}/pressable`, {});
    expect((await h.press({ button, widget })).status).toBe(403);
    expect(at.received).toEqual([]);
  });

  it('shares the wall’s twenty presses a minute', async () => {
    const h = await harness();
    const at = await receiver();
    const { button, widget } = await readyButton(h, at.base);
    for (let i = 0; i < PRESSES_PER_MINUTE; i++) expect((await h.press({ button, widget })).status).toBe(200);
    const response = await h.press({ button, widget });
    expect(response.status).toBe(429);
    expect(at.received).toHaveLength(PRESSES_PER_MINUTE);
  });

  it.each([
    [{ status: 500 }, 'refused the press (500)'],
    [{ status: 302, location: 'https://example.com/elsewhere' }, 'never follows one'],
  ])('says what the address answered — %j', async (answer, sentence) => {
    const h = await harness();
    const at = await receiver();
    const { button, widget } = await readyButton(h, at.base);
    at.answer = answer;
    const response = await h.press({ button, widget });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).toContain(sentence);
    // Asked once, and never at the address it was sent to.
    expect(at.received).toHaveLength(1);
  });

  it('cannot reach the household’s own network unless the button says it may', async () => {
    const h = await harness();
    const at = await receiver();
    await h.form('/admin/buttons', { name: 'Chime', url: `${at.base}/hooks/x`, allow_http: '1' });
    const button = h.idOf('Chime');
    await h.form(`/admin/buttons/${button}/pressable`, { pressable: '1' });
    h.allowControl();
    const widget = h.widget({ tapAction: 'act' });
    const response = await h.press({ button, widget });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).toContain('not one a wall button may call');
    expect(at.received).toEqual([]);
  });
});

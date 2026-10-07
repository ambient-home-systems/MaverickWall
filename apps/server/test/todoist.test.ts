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
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { issueCompanionToken } from '../src/api/companion.js';
import { todoListHandle, type Manifest } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { todoListChoices } from '../src/http/admin.js';
import { disconnectHa } from '../src/modules/homeassistant/store.js';
import { pollTodoistList, readHaTodoLists, readTodoistLists } from '../src/modules/todo/index.js';
import { TODOIST_MAX_ITEMS, type TodoistEndpoint } from '../src/modules/todoist/client.js';
import { fakeTodoist, type FakeTodoist } from './fake-todoist.js';

/**
 * Todoist as a source of to-do lists (plan items M5.7 and M2.2's remainder),
 * against the real app, a real database, the real fetcher and a stand-in
 * Todoist on loopback built from Todoist's own API description.
 *
 * What is held is mostly what never happens: a token Todoist refused is not
 * stored, a stored one is sealed and never shown, the wall is handed no
 * project id, task id or token, a wall that is not allowed cannot tick, a tick
 * that Todoist refused leaves the cache as it was, and nothing outside the five
 * calls leaves the server. Then the pieces a household sees: a project read
 * flat and in order, a tick that closes and an untick that reopens, and an add
 * from a phone.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const fakes: FakeTodoist[] = [];
let n = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(fakes.map((fake) => fake.close()));
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fake: FakeTodoist;
  readonly endpoint: TodoistEndpoint;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly admin: (path: string) => Promise<Response>;
  readonly wall: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly phone: (path: string, body: unknown) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; text: string }>;
  readonly allowTodo: () => void;
}

async function harness(): Promise<Harness> {
  n++;
  const fake = await fakeTodoist();
  fakes.push(fake);
  fake.projects.push(
    { id: '6Jf8VQXxpwv56VQ7', name: 'Groceries', is_archived: false },
    { id: '6Jf8VQXxpwv56VQ8', name: 'Hardware', is_archived: false },
    { id: '6Jf8VQXxpwv56VQ9', name: 'Old stuff', is_archived: true },
  );
  fake.tasks.push(
    { id: '101', project_id: '6Jf8VQXxpwv56VQ7', content: 'Bread', checked: false, parent_id: null, child_order: 2, due: null },
    { id: '102', project_id: '6Jf8VQXxpwv56VQ7', content: 'Milk', checked: false, parent_id: null, child_order: 1, due: { date: '2026-10-07', string: 'tomorrow', is_recurring: false } },
    { id: '103', project_id: '6Jf8VQXxpwv56VQ7', content: 'Semi-skimmed', checked: false, parent_id: '102', child_order: 1, due: null },
    { id: '104', project_id: '6Jf8VQXxpwv56VQ7', content: 'Eggs', checked: true, parent_id: null, child_order: 3, due: null },
    { id: '201', project_id: '6Jf8VQXxpwv56VQ8', content: 'Screws', checked: false, parent_id: null, child_order: 1, due: null },
  );
  const endpoint: TodoistEndpoint = {
    base: fake.base,
    policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-todoist-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher: createFetcher(),
    clientAddress: () => `10.29.${n}.1`,
    setupToken,
    dataDir,
    todoist: endpoint,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
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
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `todoist${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;
  const companion = issueCompanionToken(db, keyring, userId, Date.now());
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  return {
    db,
    keyring,
    fake,
    endpoint,
    form,
    admin: (path) => call(path),
    wall: async (path, fields) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${display.token}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
        }),
      ),
    phone: async (path, body) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${companion}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    manifest: async () => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${display.token}` } }),
      );
      const text = await response.text();
      return { body: JSON.parse(text) as Manifest, text };
    },
    allowTodo: () => db.prepare(`UPDATE screens SET allow_todo = 1 WHERE id = 'wall'`).run(),
  };
}

/** Connect, then add the Groceries project. */
async function connected(h: Harness): Promise<void> {
  expect((await h.form('/admin/todoist/connect', { token: h.fake.token })).headers.get('location')).toContain(
    'saved=todoist-connected',
  );
  expect((await h.form('/admin/todoist/lists', { project: '6Jf8VQXxpwv56VQ7' })).headers.get('location')).toContain(
    'saved=todoist-list-added',
  );
}

const groceries = 'todoist:6Jf8VQXxpwv56VQ7';

describe('connecting', () => {
  it('stores a token only once Todoist has accepted it, sealed, and never shows it again', async () => {
    const h = await harness();
    const refused = await h.form('/admin/todoist/connect', { token: 'not-the-token' });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('Todoist did not accept the token.');
    expect(page).not.toContain('not-the-token');
    expect(h.db.prepare('SELECT count(*) AS n FROM todoist_connection').get()).toEqual({ n: 0 });

    expect((await h.form('/admin/todoist/connect', { token: h.fake.token })).status).toBe(302);
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM todoist_connection').get());
    expect(stored).not.toContain(h.fake.token);
    expect(await (await h.admin('/admin/todoist')).text()).not.toContain(h.fake.token);
  });

  it('offers the account’s open projects, less the ones already on walls, and adds one only after it reads', async () => {
    const h = await harness();
    await h.form('/admin/todoist/connect', { token: h.fake.token });
    const offered = await (await h.admin('/admin/todoist/lists/new')).text();
    expect(offered).toContain('Groceries');
    expect(offered).toContain('Hardware');
    expect(offered).not.toContain('Old stuff');
    expect((await h.form('/admin/todoist/lists', { project: '6Jf8VQXxpwv56VQ7' })).status).toBe(302);
    expect(await (await h.admin('/admin/todoist/lists/new')).text()).not.toContain('Groceries');
    // A project the account does not have is refused, whatever was posted.
    expect((await h.form('/admin/todoist/lists', { project: 'NOTAPROJECT' })).status).toBe(400);
    // One that does not read is not kept: the project is real and its tasks do not come.
    h.fake.failTasks = 503;
    const failed = await h.form('/admin/todoist/lists', { project: '6Jf8VQXxpwv56VQ8' });
    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain('Todoist refused it (503).');
    h.fake.failTasks = undefined;
    // And a Todoist that is down when the project is chosen says so, and adds nothing either.
    h.fake.failWith = 503;
    expect((await h.form('/admin/todoist/lists', { project: '6Jf8VQXxpwv56VQ8' })).status).toBe(400);
    h.fake.failWith = undefined;
    expect(readTodoistLists(h.db).map((list) => list.entityId)).toEqual([groceries]);
  });
});

describe('a Todoist list on the wall', () => {
  it('is read flat and in Todoist’s order, open items only, and the wall is handed no id of Todoist’s', async () => {
    const h = await harness();
    await connected(h);
    const { body, text } = await h.manifest();
    const panel = body.panels['todo'] as { lists: { key: string; name: string; canTick: boolean; items: { summary: string; due: string | null }[] }[] };
    const list = panel.lists[0]!;
    expect(list.key).toBe(todoListHandle(groceries));
    expect(list.name).toBe('Groceries');
    expect(list.canTick).toBe(true);
    // Milk before Bread by `child_order`; the subtask and the completed Eggs are not drawn.
    expect(list.items.map((item) => item.summary)).toEqual(['Milk', 'Bread']);
    expect(list.items[0]?.due).toBe('2026-10-07');
    for (const secret of ['6Jf8VQXxpwv56VQ7', '"101"', '"102"', h.fake.token, 'todoist:']) expect(text).not.toContain(secret);
    // The editor's picker says which source a list is from: a household may have a "Shopping" in both.
    expect(todoListChoices(h.db)).toEqual([{ id: groceries, name: 'Groceries (Todoist)', key: todoListHandle(groceries) }]);
  });

  it('ticks an item by closing it in Todoist, unticks by reopening it, and only on a wall that is allowed', async () => {
    const h = await harness();
    await connected(h);
    const milk = (h.db.prepare(`SELECT id FROM ha_todo_items WHERE uid = '102'`).get() as { id: string }).id;
    expect((await h.wall('/d/todo/tick', { item: milk })).status).toBe(403);
    expect(h.fake.requests.some((r) => r.path.endsWith('/close'))).toBe(false);

    h.allowTodo();
    expect((await h.wall('/d/todo/tick', { item: milk })).status).toBe(200);
    const close = h.fake.requests.find((r) => r.path === '/api/v1/tasks/102/close');
    expect(close?.method).toBe('POST');
    expect(close?.authorization).toBe(`Bearer ${h.fake.token}`);
    expect(h.db.prepare(`SELECT status FROM ha_todo_items WHERE id = ?`).get(milk)).toEqual({ status: 'completed' });

    expect((await h.wall('/d/todo/tick', { item: milk, done: '0' })).status).toBe(200);
    expect(h.fake.requests.some((r) => r.path === '/api/v1/tasks/102/reopen')).toBe(true);
    expect(h.fake.tasks.find((task) => task.id === '102')?.checked).toBe(false);
  });

  it('leaves the cache as it was when Todoist refuses a tick, and says why', async () => {
    const h = await harness();
    await connected(h);
    h.allowTodo();
    const bread = (h.db.prepare(`SELECT id FROM ha_todo_items WHERE uid = '101'`).get() as { id: string }).id;
    h.fake.tasks.splice(h.fake.tasks.findIndex((task) => task.id === '101'), 1);
    const answer = await h.wall('/d/todo/tick', { item: bread });
    expect(answer.status).toBe(502);
    expect(((await answer.json()) as { message: string }).message).toBe('That is not in Todoist any more.');
    expect(h.db.prepare(`SELECT status FROM ha_todo_items WHERE id = ?`).get(bread)).toEqual({ status: 'needs_action' });
  });

  it('keeps its last good items when a read fails, and refuses a list too long to read', async () => {
    const h = await harness();
    await connected(h);
    const context = { db: h.db, fetcher: createFetcher(), keyring: h.keyring, now: Date.now() };
    h.fake.token = 'rotated';
    expect(await pollTodoistList(context, groceries, h.endpoint)).toEqual({
      ok: false,
      message: 'Todoist did not accept the token. Paste a new one on the Todoist screen.',
    });
    expect(h.db.prepare(`SELECT count(*) AS n FROM ha_todo_items WHERE entity_id = ?`).get(groceries)).toEqual({ n: 2 });
    expect(readTodoistLists(h.db)[0]?.lastError).toContain('did not accept the token');
  });

  it('reads a long list across pages, and refuses one past the cap whole', async () => {
    const h = await harness();
    await connected(h);
    const project = '6Jf8VQXxpwv56VQ7';
    for (let i = 0; i < 7; i++) {
      h.fake.tasks.push({ id: `p${i}`, project_id: project, content: `Item ${i}`, checked: false, parent_id: null, child_order: 10 + i, due: null });
    }
    h.fake.pageSize = 3;
    const context = { db: h.db, fetcher: createFetcher(), keyring: h.keyring, now: Date.now() + 1 };
    expect(await pollTodoistList(context, groceries, h.endpoint)).toEqual({ ok: true });
    expect(h.db.prepare(`SELECT count(*) AS n FROM ha_todo_items WHERE entity_id = ?`).get(groceries)).toEqual({ n: 9 });
    expect(h.fake.requests.filter((r) => r.path === '/api/v1/tasks').length).toBeGreaterThan(3);

    h.fake.pageSize = undefined;
    for (let i = 0; i < TODOIST_MAX_ITEMS; i++) {
      h.fake.tasks.push({ id: `q${i}`, project_id: project, content: `More ${i}`, checked: false, parent_id: null, child_order: 100 + i, due: null });
    }
    const refused = await pollTodoistList({ ...context, now: Date.now() + 2 }, groceries, h.endpoint);
    expect(refused.ok).toBe(false);
    expect(h.db.prepare(`SELECT count(*) AS n FROM ha_todo_items WHERE entity_id = ?`).get(groceries)).toEqual({ n: 9 });
  });
});

describe('adding from a phone', () => {
  it('adds a task to the project by its name, and reads the list back', async () => {
    const h = await harness();
    await connected(h);
    const answer = await h.phone('/companion/todo/add', { list: 'groceries', item: 'Oat milk' });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, list: 'Groceries', message: 'Added to Groceries.' });
    const create = h.fake.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/tasks');
    expect(JSON.parse(create?.body ?? '{}')).toEqual({ content: 'Oat milk', project_id: '6Jf8VQXxpwv56VQ7' });
    expect(h.db.prepare(`SELECT count(*) AS n FROM ha_todo_items WHERE summary = 'Oat milk'`).get()).toEqual({ n: 1 });
  });
});

describe('the boundaries', () => {
  it('speaks five calls to Todoist and nothing else', async () => {
    const h = await harness();
    await connected(h);
    h.allowTodo();
    const milk = (h.db.prepare(`SELECT id FROM ha_todo_items WHERE uid = '102'`).get() as { id: string }).id;
    await h.wall('/d/todo/tick', { item: milk });
    await h.wall('/d/todo/tick', { item: milk, done: '0' });
    await h.phone('/companion/todo/add', { list: 'Groceries', item: 'Tea' });
    const allowed = [
      /^GET \/api\/v1\/projects$/,
      /^GET \/api\/v1\/tasks$/,
      /^POST \/api\/v1\/tasks\/[^/]+\/(close|reopen)$/,
      /^POST \/api\/v1\/tasks$/,
    ];
    for (const request of h.fake.requests) {
      expect(allowed.some((pattern) => pattern.test(`${request.method} ${request.path}`)), `${request.method} ${request.path}`).toBe(true);
    }
  });

  it('keeps each connection’s lists when the other is disconnected', async () => {
    const h = await harness();
    await connected(h);
    h.db
      .prepare(`INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at) VALUES ('todo.shopping', 'Shopping', NULL, 1, 9, 1, 1)`)
      .run();
    disconnectHa(h.db);
    expect(readTodoistLists(h.db)).toHaveLength(1);
    h.db
      .prepare(`INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at) VALUES ('todo.shopping', 'Shopping', NULL, 1, 9, 1, 1)`)
      .run();
    expect((await h.form('/admin/todoist/disconnect', {})).headers.get('location')).toContain('saved=todoist-disconnected');
    expect(readTodoistLists(h.db)).toEqual([]);
    expect(readHaTodoLists(h.db).map((list) => list.entityId)).toEqual(['todo.shopping']);
    expect(h.db.prepare('SELECT count(*) AS n FROM todoist_connection').get()).toEqual({ n: 0 });
  });

  it('lets a widget name a Todoist list, and nothing shaped otherwise', () => {
    expect(widgetConfigBody.safeParse({ list: groceries }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ list: 'todo.shopping' }).success).toBe(true);
    for (const bad of ['todoist:', 'todoist:../x', 'todoist:a b', 'todolist:abc']) {
      expect(widgetConfigBody.safeParse({ list: bad }).success, bad).toBe(false);
    }
  });
});

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
import { buildDiagnostics } from '../src/api/diagnostics.js';
import { displayConfig, manifestEtag, todoListHandle, type Manifest } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { omissionFacts, todoListChoices, widgetsNotDrawn } from '../src/http/admin.js';
import type { PlacedWidgetRow } from '../src/api/manifest.js';
import { MODULES } from '../src/modules/index.js';
import {
  MAX_WATCHED_LISTS,
  TODO_CACHE_ITEMS,
  buildTodoPanel,
  parseItemsResponse,
  parseTodoEntities,
  pollTodoList,
  readTodoLists,
  todoModule,
  watchTodoList,
  type TodoPanel,
} from '../src/modules/todo/index.js';
import {
  closeFakeHomeAssistants,
  fakeHomeAssistant,
  statesBody,
  TOKEN,
  type FakeHa,
} from './fake-home-assistant.js';

/**
 * Home Assistant to-do lists, driven against the fake house (RFC 012 phase 1).
 *
 * Every read here goes over a socket to a process answering the shapes Home
 * Assistant answers with — the `?return_response` envelope keyed by entity id,
 * the state document that carries `supported_features`, the 400 with the
 * diagnosis in the prose — because the things that have been wrong in this
 * integration were never the client calling itself correctly. They were the
 * path, the header, the exclusive end date and the cache write.
 *
 * Three properties carry the phase and each has its own describe: the handle
 * survives a poll, the manifest carries nothing a wall could ask Home Assistant
 * a question with, and the ETag moves for a change on the list and for nothing
 * else.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; etag: string }>;
  /** The module's own job, exactly as the scheduler runs it, at `now`. */
  readonly poll: (now?: number) => Promise<void>;
  readonly panel: () => TodoPanel | null;
}

async function harness(): Promise<Harness> {
  const address = `10.12.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-todo-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
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
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Wall', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  return {
    db,
    keyring,
    call,
    form,
    manifest: async () => {
      const response = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
      return { body: (await response.json()) as Manifest, etag: response.headers.get('etag') ?? '' };
    },
    poll: (now = Date.now()) =>
      (todoModule.job as { run: (c: unknown) => Promise<void> }).run({
        db, fetcher, keyring, now, timezone: 'Europe/London',
      }),
    panel: () => buildTodoPanel(db),
  };
}

/** Connect through the form, the way a household with a mouse would. */
async function connect(h: Harness, ha: FakeHa): Promise<void> {
  const response = await h.form('/admin/home-assistant/connect', {
    base_url: ha.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
  expect(response.status).toBe(302);
}

/** Watch a list through the form, which also runs its first read. */
async function show(h: Harness, entityId: string, label = ''): Promise<Response> {
  return h.form('/admin/home-assistant/lists', { entity_id: entityId, label });
}

const rows = (db: SqliteDatabase, entityId: string): { id: string; uid: string; summary: string; status: string }[] =>
  db
    .prepare('SELECT id, uid, summary, status FROM ha_todo_items WHERE entity_id = ? ORDER BY position')
    .all(entityId) as { id: string; uid: string; summary: string; status: string }[];

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

describe('what Home Assistant hands us', () => {
  it('finds the to-do lists in /api/states, and reads bit 4 as a boolean', () => {
    const lists = parseTodoEntities(statesBody());
    expect(lists.map((list) => list.entityId)).toEqual(['todo.read_only', 'todo.shopping']);
    // 15 has bit 4; 1 has not. The wall only ever sees the boolean.
    expect(lists.find((list) => list.entityId === 'todo.shopping')?.supportsUpdate).toBe(true);
    expect(lists.find((list) => list.entityId === 'todo.read_only')?.supportsUpdate).toBe(false);
    // And nothing that is a reading, which is the readings picker's half.
    expect(lists.some((list) => list.entityId.startsWith('sensor.'))).toBe(false);
  });

  it('reads the ?return_response envelope, keyed by the entity it asked for', () => {
    const body = JSON.stringify({
      changed_states: [],
      service_response: {
        'todo.shopping': {
          items: [
            { uid: 'a', summary: 'Milk', status: 'needs_action', due: null, description: 'semi' },
            { uid: 'b', summary: 'Bread', status: 'completed', due: '2026-09-20' },
          ],
        },
      },
    });
    const parsed = parseItemsResponse(body, 'todo.shopping');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toEqual([
      { uid: 'a', summary: 'Milk', status: 'needs_action', due: null },
      { uid: 'b', summary: 'Bread', status: 'completed', due: '2026-09-20' },
    ]);
  });

  it('rejects rather than coerces: a wrong type, a third status, the wrong entity, a list too long', () => {
    const envelope = (items: unknown[], entity = 'todo.shopping'): string =>
      JSON.stringify({ changed_states: [], service_response: { [entity]: { items } } });
    // A number for a uid is an item this module cannot identify — not "42".
    expect(parseItemsResponse(envelope([{ uid: 42, summary: 'Milk', status: 'needs_action' }]), 'todo.shopping').ok).toBe(false);
    expect(parseItemsResponse(envelope([{ uid: 'a', summary: 'Milk', status: 'in_progress' }]), 'todo.shopping').ok).toBe(false);
    expect(parseItemsResponse(envelope([{ uid: 'a', summary: 'Milk', status: 'needs_action' }], 'todo.other'), 'todo.shopping').ok).toBe(false);
    expect(parseItemsResponse('not json', 'todo.shopping').ok).toBe(false);
    const many = Array.from({ length: TODO_CACHE_ITEMS + 1 }, (_, i) => ({ uid: `u${i}`, summary: 'x', status: 'needs_action' }));
    const capped = parseItemsResponse(envelope(many), 'todo.shopping');
    expect(capped.ok).toBe(false);
    // And the refusal names no item: the sentence is stored where a household reads it.
    if (!capped.ok) expect(capped.message).not.toContain('x');
    // Exactly at the cap is fine.
    expect(parseItemsResponse(envelope(many.slice(0, TODO_CACHE_ITEMS)), 'todo.shopping').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The module and its job
// ---------------------------------------------------------------------------

describe('the module', () => {
  it('is registered, keyed todo, with a job and no signals', () => {
    expect(MODULES.some((module) => module.key === 'todo')).toBe(true);
    expect(todoModule.job?.kind).toBe('todo-sync');
    expect(todoModule.job?.intervalMs).toBe(60_000);
    // A shopping list that raises an interrupt is a wall that nags.
    expect(todoModule.signals).toBeUndefined();
  });

  it('is ready when a list is watched, and asks for no credential to say so', async () => {
    const h = await harness();
    expect(todoModule.ready(h.db)).toBe(false);
    // Written straight to the table with no connection at all: `ready` is
    // about the rows, and the manifest path must stay free of the keyring.
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at)
         VALUES ('todo.shopping', 'Shopping', NULL, 1, 0, ?, ?)`,
      )
      .run(at, at);
    expect(todoModule.ready(h.db)).toBe(true);
    expect(todoModule.contribute({
      db: h.db, fetcher: createFetcher(), keyring: h.keyring, now: at, timezone: 'Europe/London',
    })).toEqual({
      lists: [{ key: todoListHandle('todo.shopping'), name: 'Shopping', canTick: true, open: 0, items: [] }],
    });
  });

  it('reads a list through the one door, asking for both statuses by name', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const added = await show(h, 'todo.shopping', 'Shopping');
    expect(added.status).toBe(302);
    expect(added.headers.get('location')).toBe('/admin/home-assistant?saved=todo-list-added');

    // The read: the state for `supported_features`, then the items with the
    // status filter spelled out — Home Assistant's default is `needs_action`
    // alone, and a reader relying on it could never draw a completed item.
    expect(ha.paths.some((path) => path === '/api/states/todo.shopping')).toBe(true);
    const post = ha.posts.find((entry) => entry.path === '/api/services/todo/get_items');
    expect(post).toBeDefined();
    expect(post?.query).toBe('return_response');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({
      entity_id: 'todo.shopping',
      status: ['needs_action', 'completed'],
    });
    // Nothing else was posted: the write is the next phase.
    expect(ha.posts.map((entry) => entry.path)).toEqual(['/api/services/todo/get_items']);

    const cached = rows(h.db, 'todo.shopping');
    expect(cached.map((row) => [row.uid, row.summary, row.status])).toEqual([
      ['i-1', 'Milk', 'needs_action'],
      ['i-2', 'Milk', 'needs_action'],
      ['i-3', 'Bread', 'completed'],
    ]);
    const list = readTodoLists(h.db)[0];
    expect(list).toMatchObject({ entityId: 'todo.shopping', name: 'Shopping', label: 'Shopping', supportsUpdate: true, lastError: null });
    expect(list?.lastFetchedAt).not.toBeNull();
  });

  it('keeps an item’s handle across a poll whose payload is unchanged', async () => {
    /*
     * The whole reason the items are a table. The handle is what a wall will
     * post back in phase 2, and a handle that changed every minute would be a
     * tick that lands on nothing — so the upsert is on `(entity_id, uid)` and
     * never touches `id`.
     */
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    const before = rows(h.db, 'todo.shopping');

    await h.poll();
    await h.poll();

    const after = rows(h.db, 'todo.shopping');
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after).toEqual(before);
  });

  it('tells the two Milks apart by uid, and only by uid', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    const milks = rows(h.db, 'todo.shopping').filter((row) => row.summary === 'Milk');
    expect(milks).toHaveLength(2);
    expect(milks[0]?.id).not.toBe(milks[1]?.id);
    // The second Milk is ticked on the phone; the first is untouched.
    const second = ha.todo['todo.shopping']?.items.find((item) => item.uid === 'i-2');
    if (second !== undefined) second.status = 'completed';
    await h.poll();
    const again = rows(h.db, 'todo.shopping').filter((row) => row.summary === 'Milk');
    expect(again.map((row) => [row.uid, row.status])).toEqual([['i-1', 'needs_action'], ['i-2', 'completed']]);
    // Same handles as before the tick.
    expect(again.map((row) => row.id)).toEqual(milks.map((row) => row.id));
  });

  it('deletes what vanished and adds what appeared, keeping the survivors’ handles', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    const before = rows(h.db, 'todo.shopping');

    const list = ha.todo['todo.shopping'];
    if (list === undefined) throw new Error('fixture');
    list.items = [
      { uid: 'i-1', summary: 'Milk', status: 'needs_action' },
      { uid: 'i-9', summary: 'Butter', status: 'needs_action' },
    ];
    await h.poll();

    const after = rows(h.db, 'todo.shopping');
    expect(after.map((row) => row.uid)).toEqual(['i-1', 'i-9']);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(before.some((row) => row.id === after[1]?.id)).toBe(false);
  });

  it('keeps the last good rows and records the client’s own sentence when a poll fails', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    const before = rows(h.db, 'todo.shopping');
    expect(before).toHaveLength(3);

    ha.down = true;
    await h.poll();

    expect(rows(h.db, 'todo.shopping')).toEqual(before);
    const list = readTodoLists(h.db)[0];
    expect(list?.lastError).toBeTruthy();
    // The sentence is the client's, about the connection — never an item, never
    // the address, never the token.
    for (const secret of ['Milk', 'Bread', ha.base, TOKEN]) {
      expect(list?.lastError ?? '').not.toContain(secret);
    }
    // And the next good poll clears it.
    ha.down = false;
    await h.poll();
    expect(readTodoLists(h.db)[0]?.lastError).toBeNull();
  });

  it('refuses a list Home Assistant no longer has, and says so without naming an item', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    delete ha.todo['todo.shopping'];
    await h.poll();
    const list = readTodoLists(h.db)[0];
    expect(list?.lastError).toMatch(/not a to-do list Home Assistant knows/);
    // Still watched, still showing its last good rows: a deleted list is the
    // household's to remove, not this job's.
    expect(rows(h.db, 'todo.shopping')).toHaveLength(3);
  });

  it('reads the read-only list as one that cannot be ticked', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.read_only');
    expect(readTodoLists(h.db)[0]?.supportsUpdate).toBe(false);
    expect(h.panel()?.lists[0]?.canTick).toBe(false);
  });

  it('costs a broken list itself and not the one beside it', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.read_only');
    await show(h, 'todo.shopping');
    delete ha.todo['todo.read_only'];
    const list = ha.todo['todo.shopping'];
    if (list !== undefined) list.items.push({ uid: 'i-4', summary: 'Tea', status: 'needs_action' });
    await h.poll();
    const lists = readTodoLists(h.db);
    expect(lists.find((row) => row.entityId === 'todo.read_only')?.lastError).toBeTruthy();
    expect(lists.find((row) => row.entityId === 'todo.shopping')?.lastError).toBeNull();
    expect(rows(h.db, 'todo.shopping').map((row) => row.summary)).toContain('Tea');
  });
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

describe('the manifest', () => {
  it('carries the lists as handles and words, and nothing a wall could ask with', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping', 'Shopping');
    await show(h, 'todo.read_only');

    const { body } = await h.manifest();
    const document = JSON.stringify(body);
    // Rule 12's surviving clause, with a watched list in the database.
    expect(document).not.toContain('todo.shopping');
    expect(document).not.toContain('todo.read_only');
    expect(document).not.toContain('i-1');
    expect(document).not.toContain('i-2');
    expect(document).not.toContain('supported_features');
    expect(document).not.toContain('supportsUpdate');
    expect(document).not.toContain('fetchedAt');
    expect(document).not.toContain('lastFetchedAt');
    expect(document).not.toContain(TOKEN);
    expect(document).not.toContain(ha.base);

    const panel = body.panels['todo'] as TodoPanel;
    expect(panel.lists.map((list) => [list.key, list.name, list.canTick, list.open])).toEqual([
      [todoListHandle('todo.shopping'), 'Shopping', true, 2],
      [todoListHandle('todo.read_only'), 'Read only', false, 1],
    ]);
    // Open items first in the list's own order, then the completed ones.
    expect(panel.lists[0]?.items.map((item) => [item.summary, item.done])).toEqual([
      ['Milk', false], ['Milk', false], ['Bread', true],
    ]);
    for (const item of panel.lists[0]?.items ?? []) {
      expect(item.id).toMatch(/^[0-9a-f]{16}$/);
      expect(Object.keys(item).sort()).toEqual(['done', 'due', 'id', 'position', 'summary']);
    }
  });

  it('turns a widget’s entity id into the same handle the panel is keyed by', () => {
    expect(displayConfig('todo', { list: 'todo.shopping', showDone: true })).toEqual({
      list: todoListHandle('todo.shopping'),
      showDone: true,
    });
    // Absent and empty are untouched, and so is every other type — a config
    // saved before the key existed leaves byte for byte as it always did.
    const typed = { items: ['Milk'] };
    expect(displayConfig('todo', typed)).toBe(typed);
    const empty = { items: ['Milk'], list: '' };
    expect(displayConfig('todo', empty)).toBe(empty);
    const notes = { list: 'todo.shopping' };
    expect(displayConfig('notes', notes)).toBe(notes);
    expect(displayConfig('todo', undefined)).toBeUndefined();
    // Stable, and not the id.
    expect(todoListHandle('todo.shopping')).toBe(todoListHandle('todo.shopping'));
    expect(todoListHandle('todo.shopping')).not.toBe(todoListHandle('todo.read_only'));
    expect(todoListHandle('todo.shopping')).not.toContain('todo');
  });

  it('carries a placed widget’s list as the handle, so the layout holds no entity id either', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-list', 'wall', 'portrait', 'todo', 0.1, 0.1, 0.4, 0.4, 0, ?, ?, ?)`,
      )
      .run(JSON.stringify({ list: 'todo.shopping', items: ['Typed'] }), at, at);
    h.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = 'wall'`).run();

    const { body } = await h.manifest();
    expect(JSON.stringify(body)).not.toContain('todo.shopping');
    const widget = body.layout.portrait.widgets.find((one) => one.id === 'w-list');
    expect((widget?.config as { list?: string })?.list).toBe(todoListHandle('todo.shopping'));
  });

  it('has one ETag for identical rows at two clocks, and another once an item moves', async () => {
    /*
     * The pin. `lastFetchedAt` moves every minute and must not travel: if it
     * did, the manifest ETag and the e-paper frame ETag would change on every
     * poll with nothing on the list changed, and a battery panel would
     * re-download a full frame each time. Built directly rather than through
     * the route, because the route stamps its own `generatedAt` — which
     * `manifestEtag` already drops — and the question is about the panel.
     */
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');

    const at = Date.now();
    const context = (now: number) => ({
      db: h.db, fetcher: createFetcher(), keyring: h.keyring, now, timezone: 'Europe/London',
    });
    const one = todoModule.contribute(context(at));
    await h.poll(at + 60_000);
    const two = todoModule.contribute(context(at + 60_000));
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));

    const first = await h.manifest();
    const second = await h.manifest();
    expect(first.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(second.etag).toBe(first.etag);

    const item = ha.todo['todo.shopping']?.items.find((candidate) => candidate.uid === 'i-1');
    if (item !== undefined) item.status = 'completed';
    await h.poll(at + 120_000);
    const third = await h.manifest();
    expect(third.etag).not.toBe(first.etag);
    expect(manifestEtag(third.body)).not.toBe(manifestEtag(first.body));
  });

  it('is absent until a list is watched', async () => {
    const h = await harness();
    const { body } = await h.manifest();
    expect(body.panels['todo']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The admin
// ---------------------------------------------------------------------------

describe('the Home Assistant page', () => {
  it('offers the to-do lists from the live house, and says the wall cannot tick yet', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    const html = await (await h.call('/admin/home-assistant')).text();
    expect(html).toContain('<datalist id="ha-todo-lists">');
    expect(html).toContain('value="todo.shopping"');
    expect(html).toContain('value="todo.read_only"');
    expect(html).toContain('read-only in Home Assistant');
    expect(html).toContain('cannot tick anything off it yet');
    expect(html).toContain('No to-do lists are shown yet.');
    // A list is not a reading: the readings datalist does not offer it.
    const readings = /<datalist id="ha-entities">([\s\S]*?)<\/datalist>/.exec(html)?.[1] ?? '';
    expect(readings).not.toContain('todo.');
  });

  it('shows a watched list as a row with its state, and stops offering it', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping', 'Groceries');
    await show(h, 'todo.read_only');
    const html = await (await h.call('/admin/home-assistant')).text();
    expect(html).toContain('Groceries');
    expect(html).toContain('Can be ticked');
    expect(html).toContain('Read-only');
    const offered = /<datalist id="ha-todo-lists">([\s\S]*?)<\/datalist>/.exec(html)?.[1] ?? '';
    expect(offered).toBe('');
    expect(html).toContain('Every to-do list Home Assistant has is already shown.');
  });

  it('refuses a list that is not one, and one Home Assistant has not got', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    expect((await show(h, 'sensor.kitchen_temperature')).status).toBe(400);
    const missing = await show(h, 'todo.nonexistent');
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('no to-do list by that name');
    expect(readTodoLists(h.db)).toEqual([]);
    // A house that cannot be reached is said as that, not as "no such list".
    ha.down = true;
    const unreachable = await show(h, 'todo.shopping');
    expect(unreachable.status).toBe(400);
    expect(await unreachable.text()).not.toContain('no to-do list by that name');
    expect(readTodoLists(h.db)).toEqual([]);
  });

  it('stores a list whose first read fails, and says so instead of "added"', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    ha.refuseItems = true;
    const response = await show(h, 'todo.shopping');
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('could not be read');
    expect(html).not.toContain('List added');
    expect(readTodoLists(h.db)[0]?.lastError).toBeTruthy();
    expect(html).toContain('Not reading');
  });

  it('refuses a ninth list with a sentence', async () => {
    const h = await harness();
    const at = Date.now();
    for (let i = 0; i < MAX_WATCHED_LISTS; i++) {
      const result = watchTodoList(h.db, { entityId: `todo.list_${i}`, name: `List ${i}`, label: null, supportsUpdate: true }, at);
      expect(result.ok).toBe(true);
    }
    const ninth = watchTodoList(h.db, { entityId: 'todo.one_more', name: 'One more', label: null, supportsUpdate: true }, at);
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.message).toContain(`at most ${MAX_WATCHED_LISTS}`);
    // Re-adding one already watched is not a ninth.
    expect(watchTodoList(h.db, { entityId: 'todo.list_0', name: 'List 0', label: 'Renamed', supportsUpdate: true }, at).ok).toBe(true);
    expect(readTodoLists(h.db)).toHaveLength(MAX_WATCHED_LISTS);
    expect(readTodoLists(h.db).find((list) => list.entityId === 'todo.list_0')?.label).toBe('Renamed');
    // And the page says so rather than drawing a form that would be refused.
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    const html = await (await h.call('/admin/home-assistant')).text();
    expect(html).toContain(`at most ${MAX_WATCHED_LISTS} lists`);
    expect(html).not.toContain('<datalist id="ha-todo-lists">');
  });

  it('removes a list after asking, and reorders from the ⋮', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await show(h, 'todo.shopping');
    await show(h, 'todo.read_only');

    const confirm = await h.call('/admin/home-assistant/lists/todo.shopping/remove');
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Stop showing');

    const moved = await h.form('/admin/home-assistant/lists/todo.read_only/move', { dir: 'up' });
    expect(moved.headers.get('location')).toBe('/admin/home-assistant?saved=order-saved');
    expect(readTodoLists(h.db).map((list) => list.entityId)).toEqual(['todo.read_only', 'todo.shopping']);

    const removed = await h.call('/admin/home-assistant/lists/todo.shopping/remove', { method: 'POST' });
    expect(removed.headers.get('location')).toBe('/admin/home-assistant?saved=todo-list-removed');
    expect(readTodoLists(h.db).map((list) => list.entityId)).toEqual(['todo.read_only']);
    expect(rows(h.db, 'todo.shopping')).toEqual([]);
    // Gone is gone: a second POST announces nothing.
    const again = await h.call('/admin/home-assistant/lists/todo.shopping/remove', { method: 'POST' });
    expect(again.headers.get('location')).toBe('/admin/home-assistant');
  });

  it('draws nothing of it while Home Assistant is not connected', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/home-assistant')).text();
    expect(html).not.toContain('To-do lists');
  });
});

// ---------------------------------------------------------------------------
// The editor's flags
// ---------------------------------------------------------------------------

describe('what the editor is told about a box (RFC 012 §6.2)', () => {
  /*
   * The seed and the facts, from the server. The editor re-derives the flags
   * from the facts on every change, which is why a seed keyed by type again
   * turned nothing red until this test existed: the browser tests read the
   * derived answer and never the seed. Both are asserted here, on the rows
   * the page hands over, because an older bundle reads only the seed.
   */
  const widget = (id: string, type: string, config: unknown): PlacedWidgetRow => ({
    id, type, x: 0, y: 0, w: 0.5, h: 0.5, z: 0, config,
  });

  it('flags a to-do box by its own list, per box, and a weather box by its type', async () => {
    const h = await harness();
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at)
         VALUES ('todo.shopping', 'Shopping', NULL, 1, 0, ?, ?)`,
      )
      .run(at, at);
    const flagged = widgetsNotDrawn(h.db, [
      widget('typed', 'todo', { items: ['Milk'] }),
      widget('shown', 'todo', { list: 'todo.shopping' }),
      widget('gone', 'todo', { list: 'todo.read_only' }),
      widget('forecast', 'weather', undefined),
      widget('time', 'clock', undefined),
    ]);
    expect(flagged.map((row) => row.id)).toEqual(['gone', 'forecast']);
    expect(flagged.find((row) => row.id === 'gone')?.why).toContain('Home Assistant');
  });

  it('hands over the facts the flags were decided from, and the lists for the picker', async () => {
    const h = await harness();
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, created_at, updated_at)
         VALUES ('todo.shopping', 'Shopping', 'Groceries', 1, 0, ?, ?)`,
      )
      .run(at, at);
    const facts = omissionFacts(h.db);
    expect(facts.todoLists).toEqual(['todo.shopping']);
    // Per type with no config: a to-do box is drawable in the abstract, a
    // weather box on this household is not, and the sentence table is per type.
    expect(facts.drawn['todo']).toBe(true);
    expect(facts.drawn['weather']).toBe(false);
    expect(facts.drawn['clock']).toBe(true);
    expect(facts.why['todo']).toContain('Home Assistant');
    expect(todoListChoices(h.db)).toEqual([
      { id: 'todo.shopping', name: 'Groceries', key: todoListHandle('todo.shopping') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Content hygiene
// ---------------------------------------------------------------------------

describe('an item is household content', () => {
  it('never reaches the diagnostics export', async () => {
    const h = await harness();
    const at = Date.now();
    h.db
      .prepare(
        `INSERT INTO ha_todo_lists (entity_id, name, label, supports_update, sort_order, last_error, created_at, updated_at)
         VALUES ('todo.private', 'Private', 'Things to sort', 1, 0, 'Could not reach Home Assistant.', ?, ?)`,
      )
      .run(at, at);
    h.db
      .prepare(
        `INSERT INTO ha_todo_items (id, entity_id, uid, summary, status, due, position, fetched_at)
         VALUES ('h1', 'todo.private', 'u1', 'Book the counsellor', 'needs_action', NULL, 0, ?)`,
      )
      .run(at);
    const text = JSON.stringify(
      buildDiagnostics({ db: h.db, appVersion: '0.1.0-test', startedAt: at - 1000, now: at, log: [], databaseSizeBytes: 0 }),
    );
    expect(text).not.toContain('Book the counsellor');
    expect(text).not.toContain('Things to sort');
    expect(text).not.toContain('todo.private');
  });
});

// ---------------------------------------------------------------------------
// The widget schema
// ---------------------------------------------------------------------------

describe('the widget config', () => {
  it('takes a list and a showDone, and refuses a list that is not one', () => {
    expect(widgetConfigBody.safeParse({ list: 'todo.shopping', showDone: true }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ list: 'todo.shopping', items: ['Milk'] }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ list: 'sensor.kitchen' }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ list: 'todo.Shopping List' }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ showDone: 'yes' }).success).toBe(false);
    // And neither is offered on the ink lane: a list is the widget's identity.
    expect(widgetConfigBody.safeParse({ ink: { list: 'todo.shopping' } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { showDone: true } }).success).toBe(false);
  });
});

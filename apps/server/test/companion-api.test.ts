import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
import { createLogBuffer } from '../src/logbuffer.js';
import { buildDiagnostics } from '../src/api/diagnostics.js';
import { redactLogText } from '../src/api/redact.js';
import { issueCompanionToken } from '../src/api/companion.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

/**
 * The companion API (plan items M2.1 and M2.2): a phone or an automation adds
 * to a household's Home Assistant to-do list with a token, never a session.
 *
 * Against a real app, a real database and a fake Home Assistant over a socket,
 * because both auth faults this project has found lived in the seam between a
 * credential and the code reading it. Most of what follows is what the endpoint
 * refuses: a missing or replaced token, a wall's token, a session cookie, a
 * list nobody added, a list that cannot be added to, a body that is not what it
 * says — and in every one of those, nothing reaches Home Assistant at all.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextHousehold = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly ha: FakeHa;
  /** A signed-in admin request, with the session cookie. */
  readonly admin: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  /** A request as a phone sends it: no cookie, from an address of its own. */
  readonly phone: (path: string, init?: RequestInit, address?: string) => Promise<Response>;
  /** Make a token through the admin and read it back off the page, as a household does. */
  readonly makeToken: () => Promise<string>;
  readonly displayToken: string;
  readonly userId: string;
  readonly addPosts: () => { path: string; body: string }[];
}

async function harness(options: { readonly lists?: readonly string[] } = {}): Promise<Harness> {
  const household = ++nextHousehold;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-companion-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    // Each caller says where it is, so the per-address limit can be asked
    // about one address without spending another's.
    clientAddress: (c) => c.req.header('x-test-address') ?? `10.15.${household}.1`,
    setupToken,
    dataDir,
    log: createLogBuffer(),
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
  const phone = async (path: string, init: RequestInit = {}, address?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (address !== undefined) headers.set('x-test-address', address);
    return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  };

  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `companion${household}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const userId = (db.prepare('SELECT id FROM user').get() as { id: string }).id;

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Wall', ?, 'panels', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  const ha = await fakeHomeAssistant();
  expect(
    (await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' }))
      .status,
  ).toBe(302);
  for (const list of options.lists ?? ['todo.shopping', 'todo.read_only']) {
    await form('/admin/home-assistant/lists', { entity_id: list, label: '' });
  }

  return {
    db,
    keyring,
    ha,
    admin,
    form,
    phone,
    displayToken: issued.token,
    userId,
    makeToken: async () => {
      expect((await form('/admin/companion', {})).status).toBe(302);
      const page = await (await admin('/admin/companion')).text();
      const value = /id="companion-token"[^>]*value="(mwc_[A-Za-z0-9_-]+)"|value="(mwc_[A-Za-z0-9_-]+)"[^>]*id="companion-token"/.exec(page);
      const token = value?.[1] ?? value?.[2];
      expect(token, 'the page shows the token in its field').toBeDefined();
      return token!;
    },
    addPosts: () => ha.posts.filter((post) => post.path === '/api/services/todo/add_item'),
  };
}

const json = (token: string | undefined, body: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
});

describe('the companion token in the admin', () => {
  it('is made, shown, sealed at rest, and checked by its hash', async () => {
    const h = await harness();
    const empty = await (await h.admin('/admin/companion')).text();
    expect(empty).toContain('No token yet');
    expect(empty).not.toContain('mwc_');

    const token = await h.makeToken();
    expect(token).toMatch(/^mwc_[A-Za-z0-9_-]{43}$/);
    const row = h.db.prepare('SELECT * FROM companion_tokens').get() as Record<string, unknown>;
    expect(row['user_id']).toBe(h.userId);
    // Neither column is the token: one is its hash, the other a sealed envelope.
    for (const value of Object.values(row)) expect(String(value)).not.toContain(token.slice(4));
    expect(String(row['token_encrypted'])).toMatch(/^mw1/);

    const page = await (await h.admin('/admin/companion')).text();
    // Behind a disclosure, and the copy button hidden until its script reveals it.
    expect(page).toMatch(/<details class="token-show"><summary>Show the token<\/summary>/);
    expect(page).toMatch(/<button type="button" class="secondary" data-copy="companion-token" hidden>/);
    expect(page).toContain('src="assets/copy-button.js"');
    expect(page).toContain('Not used yet.');
    // Making another while one exists is not a way round the confirmation.
    expect((await h.form('/admin/companion', {})).status).toBe(302);
    expect((await (await h.admin('/admin/companion')).text())).toContain(token);
  });

  it('is linked from System, and the page is behind the session', async () => {
    const h = await harness();
    expect(await (await h.admin('/admin/system')).text()).toContain('href="admin/companion"');
    const anonymous = await h.phone('/admin/companion');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toContain('/admin/sign-in');
    expect((await h.phone('/admin/companion', { method: 'POST' })).status).toBe(302);
    expect(h.db.prepare('SELECT count(*) AS n FROM companion_tokens').get()).toEqual({ n: 0 });
  });

  it('replaced, stops the old token at once; turned off, stops every token', async () => {
    const h = await harness();
    const first = await h.makeToken();
    expect((await h.phone('/companion/todo/add', json(first, { list: 'Shopping', item: 'Eggs' }))).status).toBe(200);

    expect(await (await h.admin('/admin/companion/replace')).text()).toContain('Replace the token?');
    expect((await h.form('/admin/companion/replace', {})).status).toBe(302);
    const second = /value="(mwc_[A-Za-z0-9_-]+)"/.exec(await (await h.admin('/admin/companion')).text())?.[1];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect((await h.phone('/companion/todo/add', json(first, { list: 'Shopping', item: 'Eggs' }))).status).toBe(401);
    expect((await h.phone('/companion/todo/add', json(second, { list: 'Shopping', item: 'Eggs' }))).status).toBe(200);

    expect((await h.form('/admin/companion/remove', {})).status).toBe(302);
    expect((await h.phone('/companion/todo/add', json(second, { list: 'Shopping', item: 'Eggs' }))).status).toBe(401);
    expect(await (await h.admin('/admin/companion')).text()).toContain('No token yet');
    // A second press claims nothing it did not do.
    const again = await h.form('/admin/companion/remove', {});
    expect(again.headers.get('location')).not.toContain('saved=');
  });
});

describe('POST /companion/todo/add', () => {
  it('adds the item to the list Home Assistant holds, through todo.add_item, and reads the list back', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const response = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: '  Eggs ' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, list: 'Shopping', message: 'Added to Shopping.' });

    expect(h.addPosts()).toEqual([
      { path: '/api/services/todo/add_item', query: '', body: JSON.stringify({ entity_id: 'todo.shopping', item: 'Eggs' }) },
    ]);
    expect(h.ha.todo['todo.shopping']!.items.map((item) => item.summary)).toContain('Eggs');
    // The cache has it already, so a wall shows it on its next poll rather than the minute after.
    const cached = h.db
      .prepare(`SELECT summary FROM ha_todo_items WHERE entity_id = 'todo.shopping'`)
      .all() as { summary: string }[];
    expect(cached.map((row) => row.summary)).toContain('Eggs');
    expect(
      (h.db.prepare('SELECT last_used_at AS at FROM companion_tokens').get() as { at: number | null }).at,
    ).not.toBeNull();
    expect(await (await h.admin('/admin/companion')).text()).toContain('Last used');
  });

  it('finds a list by the name on the To-do lists screen, without case, or by its entity id', async () => {
    const h = await harness();
    const token = await h.makeToken();
    h.db.prepare(`UPDATE ha_todo_lists SET label = 'Groceries' WHERE entity_id = 'todo.shopping'`).run();
    expect((await h.phone('/companion/todo/add', json(token, { list: 'groceries', item: 'Tea' }))).status).toBe(200);
    expect((await h.phone('/companion/todo/add', json(token, { list: 'todo.read_only', item: 'Note' }))).status).toBe(200);
    // Home Assistant's own name is not what the household sees once there is a label.
    const shopping = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Tea' }));
    expect(shopping.status).toBe(404);
    expect(((await shopping.json()) as { message: string }).message).toBe(
      'No list is called that. The lists are “Groceries”, “Read only”.',
    );
    expect(h.addPosts().map((post) => JSON.parse(post.body) as { entity_id: string })).toEqual([
      { entity_id: 'todo.shopping', item: 'Tea' },
      { entity_id: 'todo.read_only', item: 'Note' },
    ]);
  });

  it('takes the token as ?key= and a form body, for an iOS Shortcut', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const response = await h.phone(`/companion/todo/add?key=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ list: 'Shopping', item: 'Bread rolls' }).toString(),
    });
    expect(response.status).toBe(200);
    expect(h.addPosts()).toHaveLength(1);
  });

  it('needs no list name when exactly one list is watched, and asks which when there are several', async () => {
    const one = await harness({ lists: ['todo.shopping'] });
    const token = await one.makeToken();
    expect((await one.phone('/companion/todo/add', json(token, { item: 'Butter' }))).status).toBe(200);

    const two = await harness();
    const other = await two.makeToken();
    const asked = await two.phone('/companion/todo/add', json(other, { item: 'Butter' }));
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { message: string }).message).toBe('Say which list: “Shopping”, “Read only”.');
    expect(two.addPosts()).toEqual([]);
  });

  it('reaches only a list the household added, never an entity named by the caller', async () => {
    const h = await harness({ lists: ['todo.shopping'] });
    const token = await h.makeToken();
    // Home Assistant has this list; the household never added it.
    const response = await h.phone('/companion/todo/add', json(token, { list: 'todo.read_only', item: 'x' }));
    expect(response.status).toBe(404);
    expect(h.addPosts()).toEqual([]);
  });

  it('refuses a list Home Assistant will not add to, before asking it to', async () => {
    const h = await harness();
    const token = await h.makeToken();
    h.ha.todoFeatures['todo.shopping'] = 4; // UPDATE only: no CREATE_TODO_ITEM.
    const response = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Eggs' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'refused',
      message: 'That list does not let anything be added from here.',
    });
    expect(h.addPosts()).toEqual([]);
  });

  it.each([
    ['no item', { list: 'Shopping' }, 'Say what to add, as “item”.'],
    ['an empty item', { list: 'Shopping', item: '   ' }, 'Say what to add, as “item”.'],
    ['an item too long', { list: 'Shopping', item: 'x'.repeat(256) }, 'An item can be at most 255 characters.'],
    ['a control character', { list: 'Shopping', item: 'Eggs\u0007' }, 'An item cannot carry control characters.'],
    ['a key it does not know', { list: 'Shopping', item: 'Eggs', due: 'tomorrow' }, undefined],
    ['a number for an item', { list: 'Shopping', item: 7 }, undefined],
  ])('refuses %s, and sends nothing', async (_name, body, message) => {
    const h = await harness();
    const token = await h.makeToken();
    const response = await h.phone('/companion/todo/add', json(token, body));
    expect(response.status).toBe(400);
    const answer = (await response.json()) as { error: string; message: string };
    expect(answer.error).toBe('bad-body');
    if (message !== undefined) expect(answer.message).toBe(message);
    expect(h.addPosts()).toEqual([]);
  });

  it('refuses a body that is not JSON when it says it is', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const response = await h.phone('/companion/todo/add', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"item": "Eggs"',
    });
    expect(response.status).toBe(400);
    expect(h.addPosts()).toEqual([]);
  });

  it('says what went wrong in the house as a sentence', async () => {
    const h = await harness();
    const token = await h.makeToken();
    h.ha.down = true;
    const down = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Eggs' }));
    expect(down.status).toBe(502);
    const answer = (await down.json()) as { message: string };
    expect(answer.message.length).toBeGreaterThan(10);
    expect(answer.message).not.toContain(h.ha.base);

    // A token sealed with a key this server no longer has — a backup restored
    // without its key — leaves the lists watched and the house unreachable.
    h.ha.down = false;
    h.db.prepare(`UPDATE ha_settings SET token_encrypted = ? WHERE id = 'singleton'`).run(
      createKeyring(randomBytes(32)).encrypt(TOKEN, 'ha-token'),
    );
    const disconnected = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Eggs' }));
    expect(disconnected.status).toBe(503);
    expect(await disconnected.json()).toEqual({
      ok: false,
      error: 'connection',
      message: 'The stored Home Assistant token could not be read.',
    });
    expect(h.addPosts()).toEqual([]);
  });

  it('says the lists are missing when none has been added', async () => {
    const h = await harness({ lists: [] });
    const token = await h.makeToken();
    const response = await h.phone('/companion/todo/add', json(token, { item: 'Eggs' }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe(
      'No to-do lists have been added yet. Add one under Home Assistant › To-do lists first.',
    );
  });
});

describe('who may call it', () => {
  it('refuses no token, a wrong one, a wall’s token, and a session cookie — and none reaches the house', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const body = { list: 'Shopping', item: 'Eggs' };

    const none = await h.phone('/companion/todo/add', json(undefined, body));
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: string }).error).toBe('no-token');

    const wrong = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await h.phone('/companion/todo/add', json(wrong, body))).status).toBe(401);
    expect((await h.phone('/companion/todo/add', json(h.displayToken, body))).status).toBe(401);
    expect((await h.phone('/companion/todo/add', json(`mwc_${h.displayToken}`, body))).status).toBe(401);
    // Signed in to the admin is not the same as holding the token.
    expect((await h.admin('/companion/todo/add', json(undefined, body))).status).toBe(401);
    // A token for the wrong thing in the header is not rescued by a right one in the address.
    expect((await h.phone(`/companion/todo/add?key=${token}`, json(wrong, body))).status).toBe(401);

    expect(h.addPosts()).toEqual([]);
  });

  it('answers in JSON before setup has finished, rather than a page a shortcut cannot read', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-companion-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const app = createApp({
      db,
      appVersion: '0.1.0-test',
      bootNotices: [],
      auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
      keyring: createKeyring(randomBytes(32)),
      fetcher: createFetcher(),
      clientAddress: () => '10.16.0.1',
      setupToken: createSetupTokenHolder(() => {}),
      dataDir,
    });
    const response = await app.fetch(
      new Request('http://localhost/companion/todo/add', json('mwc_anything', { item: 'Eggs' })),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('setup-incomplete');
  });
});

describe('rate limits', () => {
  it('tells an address that keeps guessing to wait, even once it has the right token, and only that address', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const body = { list: 'Shopping', item: 'Eggs' };
    for (let i = 0; i < 20; i++) {
      expect((await h.phone('/companion/todo/add', json(`mwc_guess${i}`, body), '203.0.113.9')).status).toBe(401);
    }
    const blocked = await h.phone('/companion/todo/add', json(token, body), '203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.phone('/companion/todo/add', json(token, body), '203.0.113.10')).status).toBe(200);
  });

  it('holds one account to thirty a minute, so a looping automation cannot hammer the house', async () => {
    const h = await harness();
    const token = await h.makeToken();
    for (let i = 0; i < 30; i++) {
      expect((await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: `Item ${i}` }))).status).toBe(200);
    }
    const thirtyFirst = await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'One more' }));
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.headers.get('retry-after')).not.toBeNull();
    expect(h.addPosts()).toHaveLength(30);
  });
});

describe('what is written down', () => {
  it('logs neither the token nor the item, on success or refusal', async () => {
    const h = await harness();
    const token = await h.makeToken();
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Pregnancy test' }));
    await h.phone(`/companion/todo/add?key=${token}`, json(undefined, { list: 'Nowhere', item: 'Pregnancy test' }));
    await h.phone('/companion/todo/add', json(token, { list: 'Shopping', item: 'Pregnancy test\u0007' }));
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).not.toContain('Pregnancy test');
    }
  });

  it('is redacted from a log line wherever it appears, and so from the diagnostics export', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-companion-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const at = Date.now();
    db.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Household', 'h@home.local', 0, ?, ?)`,
    ).run(at, at);
    const keyring = createKeyring(randomBytes(32));
    const token = issueCompanionToken(db, keyring, 'u1', at);

    const log = createLogBuffer();
    const noop = (..._args: unknown[]): void => {};
    const fake = { log: noop, warn: noop, error: noop };
    log.capture(fake);
    fake.log(`[proxy] POST http://192.168.1.10:8080/companion/todo/add?key=${token} 200`);
    fake.warn(`a token was pasted: ${token}`);
    fake.error(`Authorization: Bearer ${token}`);

    const report = buildDiagnostics({
      db, appVersion: '9.9.9-test', startedAt: at - 1000, now: at, log: log.lines(), databaseSizeBytes: 1,
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain(token.slice(4));
    // The line is kept, and still says what kind of thing was there.
    expect(report.log[1]?.text).toBe('a token was pasted: mwc_[redacted]');
    expect(report.log[0]?.text).toContain('192.168.1.10:8080/companion/todo/add?key=');
    // And the rule is the prefix's, not the entropy rule's: a token that reads
    // like words is redacted too.
    expect(redactLogText('mwc_ThisLooksLikeOrdinaryWordsInARow')).toBe('mwc_[redacted]');
  });
});

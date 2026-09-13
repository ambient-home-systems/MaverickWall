import { afterAll, describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
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
import type { Manifest } from '../src/api/manifest.js';
import { todoModule } from '../src/modules/todo/index.js';
import {
  closeFakeHomeAssistants,
  fakeHomeAssistant,
  TOKEN,
  type FakeHa,
} from './fake-home-assistant.js';

/**
 * Ticking an item off a Home Assistant to-do list, from a wall (RFC 012 phase 2).
 *
 * `chores-tick.test.ts` one widget along, and most of it is the same file for
 * the same reason: the display token lives on a wall where anybody in the house
 * — or on the network — can reach it, so almost every assertion here is about
 * what the endpoint refuses to take from the caller.
 *
 * What is **not** the same is the half worth reading. A chore's completion is a
 * row in this database and the unique index makes the press idempotent with no
 * client queue; a to-do item's status belongs to Home Assistant, and this
 * endpoint is a proxy for the one write rule 12 permits. So three things here
 * have no counterpart next door: the item is named by its `uid` and never by
 * its summary, the cache is written only after the upstream has said yes, and a
 * failure comes back as a sentence somebody standing in a kitchen can act on.
 *
 * `TZ=Pacific/Chatham` against a household in Europe/London, as next door — not
 * because a tick has a day in it (it has not, which is itself a difference) but
 * because the manifest assembly around it does.
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
  readonly ha: FakeHa;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  /** POST /d/todo/tick as the wall does, with the display token. */
  readonly tick: (fields: Record<string, string>, bearer?: string) => Promise<Response>;
  readonly manifest: (bearer?: string) => Promise<{ body: Manifest; etag: string }>;
  /** The module's own job, exactly as the scheduler runs it. */
  readonly poll: () => Promise<void>;
  /** Let this wall tick, the way the wall's settings switch does. */
  readonly allowTicking: (on?: boolean) => void;
  /** A second paired wall, for the household-wide assertions. */
  readonly pairAnother: () => string;
  /** One e-paper frame, by its own token — the path a dumb panel pulls. */
  readonly frame: (bearer: string) => Promise<Response>;
  /** The cached rows of one list, in the order the panel reads them. */
  readonly rows: (entityId: string) => { id: string; uid: string; summary: string; status: string }[];
}

async function harness(): Promise<Harness> {
  const address = `10.14.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-todotick-'));
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
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
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
    email: `tick${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Wall', ?, ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  // The real forms, in the order a household would use them: connect, then
  // watch both lists — the tickable one and the one core would refuse.
  const ha = await fakeHomeAssistant();
  expect(
    (await form('/admin/home-assistant/connect', {
      base_url: ha.base,
      token: TOKEN,
      allow_lan: '1',
      accept_http: '1',
    })).status,
  ).toBe(302);
  await form('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: '' });
  await form('/admin/home-assistant/lists', { entity_id: 'todo.read_only', label: '' });

  let others = 0;
  return {
    db,
    keyring,
    ha,
    form,
    tick: (fields, bearer = issued.token) =>
      call('/d/todo/tick', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields).toString(),
      }),
    manifest: async (bearer = issued.token) => {
      const response = await call('/d/manifest', { headers: { authorization: `Bearer ${bearer}` } });
      return { body: (await response.json()) as Manifest, etag: response.headers.get('etag') ?? '' };
    },
    poll: () =>
      (todoModule.job as { run: (c: unknown) => Promise<void> }).run({
        db, fetcher, keyring, now: Date.now(), timezone: 'Europe/London',
      }),
    allowTicking: (on = true) => {
      db.prepare('UPDATE screens SET allow_todo = ? WHERE id = ?').run(on ? 1 : 0, 'wall');
    },
    pairAnother: () => {
      const other = issueDisplayToken();
      const id = `wall-${++others}`;
      db.prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, `Hall ${others}`, other.tokenHash, stamp, stamp, stamp);
      return other.token;
    },
    frame: (bearer) => call(`/d/epaper/${bearer}.png`),
    rows: (entityId) =>
      db
        .prepare('SELECT id, uid, summary, status FROM ha_todo_items WHERE entity_id = ? ORDER BY position')
        .all(entityId) as { id: string; uid: string; summary: string; status: string }[],
  };
}

/**
 * How many pixels of a 1-bit PNG are inked.
 *
 * Decoded rather than eyeballed or weighed — the rule this repository learned
 * by shipping a QR code that passed every structural check and scanned as
 * nothing, and re-learned here when a 359-byte PNG turned out to be a drawn
 * frame rather than an empty one.
 */
function inkPixels(png: Uint8Array): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4] as number, png[offset + 5] as number,
      png[offset + 6] as number, png[offset + 7] as number,
    );
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const head = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = head.getUint32(0);
      height = head.getUint32(4);
    } else if (type === 'IDAT') idat.push(data.slice());
    offset += 12 + length;
  }
  const merged = new Uint8Array(idat.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of idat) {
    merged.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;
  let black = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1; // +1 skips the per-row filter byte
    for (let x = 0; x < width; x++) {
      if ((((raw[row + (x >> 3)] as number) >> (7 - (x & 7))) & 1) === 0) black++;
    }
  }
  return black;
}

/** The handle the wall would have been shown for one item, by its uid. */
function handleOf(h: Harness, entityId: string, uid: string): string {
  const row = h.rows(entityId).find((candidate) => candidate.uid === uid);
  expect(row, `no cached row for ${uid}`).toBeDefined();
  return (row as { id: string }).id;
}

// ---------------------------------------------------------------------------
// The per-wall gate
// ---------------------------------------------------------------------------

describe('the per-wall gate', () => {
  it('is off by default, so a newly paired wall ticks nothing', async () => {
    /*
     * Off by default, and its own switch rather than a share of the chore one.
     * Clearing a warning says the household has read something; ticking a chore
     * records a claim in this database; this changes a list the household's
     * phones are synced to, where nobody standing at the wall can undo it.
     */
    const h = await harness();
    const response = await h.tick({ item: handleOf(h, 'todo.shopping', 'i-1') });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'not-allowed',
      message: 'This wall cannot tick things off.',
    });
    // Nothing reached Home Assistant, which is the half a status code alone
    // does not say: a refusal that still posts is a refusal in name only.
    expect(h.ha.posts.filter((post) => post.path.endsWith('/update_item'))).toEqual([]);
    expect(h.rows('todo.shopping').map((row) => row.status)).toEqual([
      'needs_action',
      'needs_action',
      'completed',
    ]);
  });

  it('needs a paired wall at all, not merely the switch', async () => {
    // `/d/*` is behind the display token; this only proves the tick did not
    // somehow land outside that gate.
    const h = await harness();
    h.allowTicking();
    const response = await h.tick(
      { item: handleOf(h, 'todo.shopping', 'i-1') },
      'not-a-real-token',
    );
    expect(response.status).toBe(401);
  });

  it('travels in the manifest, so the wall knows whether to draw a box', async () => {
    /*
     * **Absent when it is off, rather than `false`.** The flag is off on every
     * wall in the world until a household opens the setting, and `manifestEtag`
     * hashes the serialisation — so emitting it everywhere would churn every
     * stored ETag at one image pull, and every e-paper frame with them. That is
     * `panelWidthMm`'s own rule, and `wall-sizing.test.ts` holds the whole
     * `screen` block to it by key.
     */
    const h = await harness();
    const off = (await h.manifest()).body.screen as Record<string, unknown>;
    expect('allowTodo' in off).toBe(false);
    expect(off['allowChores']).toBe(false);

    h.allowTicking();
    const on = (await h.manifest()).body.screen as Record<string, unknown>;
    expect(on['allowTodo']).toBe(true);
  });

  it('is a different switch from the chore one, at the wall and in the manifest', async () => {
    /*
     * The assertion the "one input switch" simplification would fail. A
     * household who lets a hall television tick chores off has not thereby let
     * it edit the shopping list.
     */
    const h = await harness();
    h.db.prepare('UPDATE screens SET allow_chores = 1 WHERE id = ?').run('wall');
    const screen = (await h.manifest()).body.screen as Record<string, unknown>;
    expect(screen['allowChores']).toBe(true);
    expect('allowTodo' in screen).toBe(false);
    expect((await h.tick({ item: handleOf(h, 'todo.shopping', 'i-1') })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// What the endpoint refuses to take from the wall
// ---------------------------------------------------------------------------

describe('what the endpoint refuses to take from the wall', () => {
  it('refuses a handle nobody minted, and one with no handle at all', async () => {
    const h = await harness();
    h.allowTicking();
    const made = await h.tick({ item: 'deadbeefdeadbeef' });
    expect(made.status).toBe(404);
    expect(await made.json()).toEqual({
      error: 'no-such-item',
      message: 'That is not on the list any more.',
    });
    expect((await h.tick({ item: '' })).status).toBe(400);
    expect((await h.tick({ item: 'x'.repeat(200) })).status).toBe(400);
    expect(h.ha.posts.filter((post) => post.path.endsWith('/update_item'))).toEqual([]);
  });

  it('refuses an item that has left the list since the wall drew it', async () => {
    /*
     * §7.4's common case, and the reason it gets its own sentence: somebody
     * deletes the milk on their phone thirty seconds after the wall drew it.
     * The handle was real, the row is gone with the poll that did not see it,
     * and "That is not on the list any more." is true, useful, and corrects
     * itself on the next poll.
     */
    const h = await harness();
    h.allowTicking();
    const stale = handleOf(h, 'todo.shopping', 'i-1');

    const list = h.ha.todo['todo.shopping'];
    expect(list).toBeDefined();
    list!.items = list!.items.filter((item) => item.uid !== 'i-1');
    await h.poll();

    const response = await h.tick({ item: stale });
    expect(response.status).toBe(404);
    expect((await response.json() as { message: string }).message).toBe(
      'That is not on the list any more.',
    );
  });

  it('refuses a list that cannot be updated, and posts nothing to find out', async () => {
    /*
     * Two layers, and this is the second. `todo.read_only` has bit 4 clear, so
     * the widget draws no box on it — and the display token is on the wall, so
     * the endpoint asks again. Asking Home Assistant instead would work (it
     * answers 400 for exactly this) and would be wrong twice over: a round trip
     * for an answer already in the cache, and a household reading Home
     * Assistant's wording for a refusal this server could have explained.
     */
    const h = await harness();
    h.allowTicking();
    const response = await h.tick({ item: handleOf(h, 'todo.read_only', 'r-1') });
    expect(response.status).toBe(409);
    expect((await response.json() as { message: string }).message).toContain('does not let');
    // The fake saw no write at all — not a refused one.
    expect(h.ha.posts.filter((post) => post.path.endsWith('/update_item'))).toEqual([]);
    expect(h.rows('todo.read_only').map((row) => row.status)).toEqual(['needs_action']);
  });

  it('takes no entity id and no uid from the caller, whatever it sends', async () => {
    /*
     * Rule 12's surviving clause (3), asserted from the other side. A wall
     * holding a handle can tick only what it has been shown; a wall that made
     * one up, or that knew an entity id from somewhere, reaches nothing.
     */
    const h = await harness();
    h.allowTicking();
    for (const body of [
      { item: 'todo.shopping' },
      { item: 'i-2' },
      { item: 'todo.read_only', entity_id: 'todo.shopping', uid: 'i-1' },
    ]) {
      expect((await h.tick(body)).status).toBe(404);
    }
    expect(h.ha.posts.filter((post) => post.path.endsWith('/update_item'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tick itself
// ---------------------------------------------------------------------------

describe('the tick itself', () => {
  it('names the item by its uid, so the second Milk is the one that moves', async () => {
    /*
     * The assertion this whole phase turns on, and it is untestable on a
     * well-behaved fixture. `_find_by_uid_or_summary` matches
     * `value in (item.uid, item.summary)` and returns the **first** hit, so a
     * household with "Milk" on the list twice, ticked by name, ticks whichever
     * one their integration happens to return first — a bug nobody can
     * reproduce on their own list.
     *
     * Reverting `tickTodoItem` to send `item.summary` turns this red on both
     * halves: the fake receives "Milk" rather than "i-2", and `i-1` is the
     * item that moves.
     */
    const h = await harness();
    h.allowTicking();
    const second = handleOf(h, 'todo.shopping', 'i-2');

    const response = await h.tick({ item: second });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, done: true });

    // What Home Assistant was actually told, read off the socket.
    const write = h.ha.posts.filter((post) => post.path.endsWith('/update_item')).at(-1);
    expect(write).toBeDefined();
    expect(JSON.parse(write!.body)).toEqual({
      entity_id: 'todo.shopping',
      item: 'i-2',
      status: 'completed',
    });
    // And the house agrees: the first Milk is untouched.
    expect(h.ha.todo['todo.shopping']?.items.map((item) => item.status)).toEqual([
      'needs_action',
      'completed',
      'completed',
    ]);
  });

  it('writes the cached row itself once Home Assistant has said yes', async () => {
    /*
     * §7.3. Not an optimistic tick — the 200 is in hand before anything is
     * written — but the wall must not wait out the sixty-second poll to see the
     * box fill, which is "pressing OK on a wall and watching nothing happen".
     */
    const h = await harness();
    h.allowTicking();
    const milk = handleOf(h, 'todo.shopping', 'i-1');
    expect(h.rows('todo.shopping').find((row) => row.uid === 'i-1')?.status).toBe('needs_action');

    await h.tick({ item: milk });
    expect(h.rows('todo.shopping').find((row) => row.uid === 'i-1')?.status).toBe('completed');
    // And the handle is the same row: a tick must not mint a new one, or the
    // next press on the same item would 404.
    expect(handleOf(h, 'todo.shopping', 'i-1')).toBe(milk);
  });

  it('touches nothing when Home Assistant refuses, and says why', async () => {
    /*
     * The other half of the write-through, and the one that would be silently
     * wrong: a cache written before the upstream answered would show an item
     * ticked that nothing ticked, and the next poll would flip it back.
     */
    const h = await harness();
    h.allowTicking();
    const milk = handleOf(h, 'todo.shopping', 'i-1');
    h.ha.down = true;

    const response = await h.tick({ item: milk });
    expect(response.status).toBe(502);
    const said = (await response.json()) as { message: string };
    // A kitchen sentence, not a status line — and never the address.
    expect(said.message.length).toBeGreaterThan(0);
    expect(said.message).not.toContain(h.ha.base);
    expect(h.rows('todo.shopping').find((row) => row.uid === 'i-1')?.status).toBe('needs_action');
  });

  it('says so when Home Assistant is gone outright, rather than hanging', async () => {
    // Not "down" — gone. A refused connection is a different failure from a
    // 502, and it is the one a household gets when they reboot the box.
    const h = await harness();
    h.allowTicking();
    const milk = handleOf(h, 'todo.shopping', 'i-1');
    await h.ha.close();

    const response = await h.tick({ item: milk });
    expect(response.status).toBe(502);
    const said = (await response.json()) as { message: string };
    expect(said.message).toContain('Home Assistant');
    expect(said.message).not.toContain('ECONNREFUSED');
    expect(h.rows('todo.shopping').find((row) => row.uid === 'i-1')?.status).toBe('needs_action');
  });

  it('is idempotent: two presses on one item are one completed item', async () => {
    /*
     * The one property that survives the authority inverting for free. Setting
     * `completed` twice is `completed`, so two walls pressed at once, or one
     * retrying on a flaky network, still cost one item — which is why there is
     * no queue and no reconciliation on the wall.
     */
    const h = await harness();
    h.allowTicking();
    const milk = handleOf(h, 'todo.shopping', 'i-1');
    await Promise.all([h.tick({ item: milk }), h.tick({ item: milk }), h.tick({ item: milk })]);

    expect(
      h.ha.todo['todo.shopping']?.items.filter((item) => item.status === 'completed').length,
    ).toBe(2); // the Bread the fixture starts with, and this one
    expect(h.rows('todo.shopping').filter((row) => row.status === 'completed').map((row) => row.uid))
      .toEqual(['i-1', 'i-3']);
  });

  it('un-ticks on done=0, which the endpoint honours whatever the wall offers', async () => {
    // The wall draws the control on open items only; the endpoint takes the
    // correction, because idempotence and a later undo both need it and a
    // branch nothing exercises is a branch nobody can trust.
    const h = await harness();
    h.allowTicking();
    const bread = handleOf(h, 'todo.shopping', 'i-3');
    const response = await h.tick({ item: bread, done: '0' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, done: false });
    expect(h.ha.todo['todo.shopping']?.items.find((item) => item.uid === 'i-3')?.status).toBe(
      'needs_action',
    );
    expect(h.rows('todo.shopping').find((row) => row.uid === 'i-3')?.status).toBe('needs_action');
  });

  it('is household-wide: one wall ticks and the other sees it', async () => {
    /*
     * The same call `/d/interrupts/dismiss` and `/d/chores/tick` made, and here
     * it is not even a decision — Home Assistant owns the list, so every wall
     * in the house is reading one upstream. What is asserted is that the ETag
     * the *other* wall is holding moves, or it would be handed a 304 and carry
     * on drawing the milk until something unrelated changed.
     */
    const h = await harness();
    h.allowTicking();
    const other = h.pairAnother();
    const before = await h.manifest(other);
    expect(before.etag).toMatch(/^"[0-9a-f]{32}"$/);
    // Nothing changed: the same document, and that wall would get a 304.
    expect((await h.manifest(other)).etag).toBe(before.etag);

    await h.tick({ item: handleOf(h, 'todo.shopping', 'i-1') });

    const after = await h.manifest(other);
    expect(after.etag).not.toBe(before.etag);
    const lists = (after.body.panels as { todo?: { lists: { items: { done: boolean }[] }[] } }).todo;
    expect(lists?.lists[0]?.items.filter((item) => item.done).length).toBe(2);
  });

  it('leaves a panel following this wall drawing exactly what it drew', async () => {
    /*
     * A panel draws the list and cannot tick it (RFC 012 §11), so the whole of
     * phase 2 must be invisible to one — the box absent rather than inert,
     * which is what the read-only row phase 1 shipped already draws.
     *
     * `allow_todo` is a fact about a *screen* rather than a widget key, so it
     * is in neither honours table; the reason is written at the `PANEL_IGNORES`
     * declaration. This is the assertion that it is not quietly in the frame
     * anyway: the same panel, the same canvas, the switch flipped on the panel
     * *and* on the wall it follows, and the same bytes and the same ETag every
     * time. A frame that moved would cost every battery panel in the house a
     * full re-download for a control it cannot offer.
     *
     * `epaper-todo-widget.test.ts` pins the other half — those same rows
     * against hashes rendered in a clean worktree of the commit before this
     * phase, so "byte-identical to before this PR" is measured rather than
     * asserted from this tree against itself.
     */
    const h = await harness();
    const panelToken = h.pairAnother();
    const panel = (
      h.db.prepare("SELECT id FROM screens WHERE name = 'Hall 1'").get() as { id: string }
    ).id;
    h.db
      .prepare(
        `UPDATE screens SET kind = 'epaper', panel_width = 800, panel_height = 480,
                            layout_mode = 'follow', layout_follows = 'wall' WHERE id = ?`,
      )
      .run(panel);

    // A list-backed to-do box on the wall this panel follows, so the frame
    // genuinely contains the thing under discussion.
    const at = Date.now();
    h.db.prepare("UPDATE screens SET layout_mode = 'freeform' WHERE id = 'wall'").run();
    h.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-list', 'wall', 'landscape', 'todo', 0.05, 0.05, 0.5, 0.6, 0, ?, ?, ?)`,
      )
      .run(JSON.stringify({ list: 'todo.shopping' }), at, at);

    const read = async (): Promise<{ bytes: string; etag: string; ink: number }> => {
      const response = await h.frame(panelToken);
      expect(response.status).toBe(200);
      const png = new Uint8Array(await response.arrayBuffer());
      return {
        bytes: Buffer.from(png).toString('base64'),
        etag: response.headers.get('etag') ?? '',
        ink: inkPixels(png),
      };
    };
    const allow = (screen: string, column: 'allow_todo' | 'allow_chores', on: boolean): void => {
      h.db.prepare(`UPDATE screens SET ${column} = ? WHERE id = ?`).run(on ? 1 : 0, screen);
    };

    const readings: { bytes: string; etag: string; ink: number }[] = [];
    for (const [wallOn, panelOn] of [
      [false, false],
      [true, false],
      [true, true],
      [false, true],
    ] as const) {
      allow('wall', 'allow_todo', wallOn);
      allow(panel, 'allow_todo', panelOn);
      readings.push(await read());
    }

    /*
     * **Not one pixel moves, in any of the four states.** That is the claim
     * this phase has to make about panels, and it is decoded rather than
     * weighed: the first draft asserted the PNG was over a thousand bytes and
     * failed at 359, because a sparse 1-bit frame compresses to almost nothing
     * and a blank one and a drawn one weigh the same. Four identical answers
     * would be trivially true of four blank frames, so what makes this an
     * assertion is that there is ink in them — the QR rule, one image along.
     */
    expect(readings[0]?.ink).toBeGreaterThan(500);
    expect(new Set(readings.map((one) => one.bytes)).size).toBe(1);

    /*
     * And the **ETag** is unchanged when the wall this panel follows flips its
     * own switch, which is the only one of the four a household can actually
     * reach: the e-paper settings page offers none of the three `allow_*`
     * controls, for the reason a sleeping ESP32 cannot honour a tap. So a
     * household ticking the shopping off on their kitchen tablet must not cost
     * the hall panel a full re-download, and this is what says it does not.
     */
    allow(panel, 'allow_todo', false);
    allow('wall', 'allow_todo', false);
    const wallOff = await read();
    allow('wall', 'allow_todo', true);
    expect((await read()).etag).toBe(wallOff.etag);

    /*
     * The panel's *own* column does move it, and that is the manifest's shape
     * rather than anything this phase introduced — `manifestEtag` hashes the
     * whole document bar `generatedAt`, and the `screen` block carries all
     * three flags. Measured here against `allow_chores`, which has behaved this
     * way since it shipped: if the two ever disagree, one of them has been
     * given a special case and this says which.
     */
    allow(panel, 'allow_chores', false);
    const both = await read();
    allow(panel, 'allow_chores', true);
    const choresOn = await read();
    allow(panel, 'allow_chores', false);
    allow(panel, 'allow_todo', true);
    const todoOn = await read();
    expect(choresOn.etag).not.toBe(both.etag);
    expect(todoOn.etag).not.toBe(both.etag);
    // Same pixels either way: the flags are in the document, not in the frame.
    expect(choresOn.bytes).toBe(both.bytes);
    expect(todoOn.bytes).toBe(both.bytes);
  });

  it('carries no entity id, no uid and no address in the manifest, with a tick in flight', async () => {
    /*
     * The test that needed no change when the write landed, which is the point
     * of having had it — asserted here again *around* a tick, because a write
     * path is exactly where a handle would be traded for the thing it stands
     * for.
     */
    const h = await harness();
    h.allowTicking();
    await h.tick({ item: handleOf(h, 'todo.shopping', 'i-2') });

    const text = JSON.stringify((await h.manifest()).body);
    expect(text).not.toContain('todo.shopping');
    expect(text).not.toContain('todo.read_only');
    for (const uid of ['i-1', 'i-2', 'i-3', 'r-1']) expect(text).not.toContain(`"${uid}"`);
    expect(text).not.toContain(h.ha.base);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('supported_features');
  });
});

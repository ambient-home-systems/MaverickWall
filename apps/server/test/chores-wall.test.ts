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
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { completionDates, createChore, localToday, readChores, setChoreDone } from '../src/api/chores.js';
import { buildChoreBoard, choresModule } from '../src/modules/chores/index.js';

/**
 * Chores reaching a wall and a panel (RFC 008 phase 2).
 *
 * Read-only throughout: the board says what is due and what is done, and
 * nothing here or on either renderer records a completion. The tick is phase 3.
 *
 * The suite runs under `TZ=Pacific/Chatham` (UTC+12:45) while the household is
 * in Europe/London, which is not decoration — every "what day is it" in here is
 * answered in the household's zone and would be a day out if anything reached
 * for the process clock instead.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HOUSEHOLD_TZ = 'Europe/London';

function database(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-choreswall-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return db;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

describe('the chores module', () => {
  const context = (db: SqliteDatabase) => ({
    db,
    fetcher: createFetcher(),
    keyring: createKeyring(randomBytes(32)),
    now: Date.now(),
    timezone: HOUSEHOLD_TZ,
  });

  it('has nothing to say until there is a chore', () => {
    // An empty chore board is a hole in the wall, not a feature — the same
    // argument as a weather panel with nowhere to be.
    const db = database();
    expect(choresModule.ready(db)).toBe(false);
    createChore(db, { name: 'Bins', personId: null, schedule: { kind: 'daily' }, dueTime: null });
    expect(choresModule.ready(db)).toBe(true);
  });

  it('carries today and the six days after it, empties included', () => {
    const db = database();
    createChore(db, {
      name: 'Bins',
      personId: null,
      schedule: { kind: 'weekdays', days: [2] },
      dueTime: null,
    });
    const today = localToday(HOUSEHOLD_TZ);
    const board = buildChoreBoard(db, today);

    expect(board.today).toBe(today);
    expect(board.days).toHaveLength(7);
    expect(board.days[0]?.date).toBe(today);
    // Exactly one Tuesday in any seven consecutive days.
    expect(board.days.filter((day) => day.items.length > 0)).toHaveLength(1);
    // The empty days are kept: a caller drawing a grid needs them to line up.
    expect(board.days.some((day) => day.items.length === 0)).toBe(true);
  });

  it('reports a chore as done for the day it was recorded against', () => {
    const db = database();
    const id = createChore(db, {
      name: 'Bins',
      personId: null,
      schedule: { kind: 'daily' },
      dueTime: null,
    });
    const today = localToday(HOUSEHOLD_TZ);
    expect(buildChoreBoard(db, today).days[0]?.items[0]?.done).toBe(false);

    setChoreDone(db, id, today, true);
    const board = buildChoreBoard(db, today);
    expect(board.days[0]?.items[0]?.done).toBe(true);
    // And only that day. Tomorrow's instance of a daily chore is still to do.
    expect(board.days[1]?.items[0]?.done).toBe(false);
  });

  it('carries the person and their colour, so the wall needs no second lookup', () => {
    const db = database();
    const at = Date.now();
    db.prepare(
      `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
       VALUES ('p1', 'Sam', '#35916A', 0, 0, ?, ?)`,
    ).run(at, at);
    createChore(db, {
      name: 'Bins',
      personId: 'p1',
      schedule: { kind: 'daily' },
      dueTime: '19:00',
    });
    const item = buildChoreBoard(db, localToday(HOUSEHOLD_TZ)).days[0]?.items[0];
    expect(item?.person).toBe('Sam');
    expect(item?.color).toBe('#35916A');
    expect(item?.dueTime).toBe('19:00');
  });

  it('contributes nothing when every chore falls outside the week', () => {
    // Nothing to draw is better said by drawing nothing than by an empty box.
    const db = database();
    createChore(db, {
      name: 'Smoke alarms',
      personId: null,
      schedule: { kind: 'once', date: '2099-01-04' },
      dueTime: null,
    });
    expect(choresModule.ready(db)).toBe(true);
    expect(choresModule.contribute(context(db))).toBeNull();
  });

  it('raises no signals and registers no job, deliberately', () => {
    /*
     * A chore that raises an interrupt is a wall that nags, and interrupts are
     * reserved for a tornado warning and a garage left open at midnight. The
     * job is absent for a different reason: there is nothing to keep fresh, and
     * the obvious midnight sweeper would be a job that destroys history and
     * misfires in the hour the clocks go back.
     */
    expect(choresModule.signals).toBeUndefined();
    expect(choresModule.job).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The wall, end to end
// ---------------------------------------------------------------------------

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-choresapp-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'c'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.9.0.${++nextAddress}`,
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
    email: `chores${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: HOUSEHOLD_TZ });

  const html = await (await post('http://localhost:8080/admin/screens', { name: 'Wall' })).text();
  const token = /\/pair\?token=([^<\s"]+)/.exec(html)?.[1];
  if (token === undefined) throw new Error('no pairing token in the admin page');
  const screenId = (db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

  /**
   * Put *one* widget on this screen's canvas, the way the editor's save would.
   *
   * The clear is the point. A newly paired screen arrives with a starter canvas
   * already on it — six widgets in landscape — so "place a widget and measure
   * the ink" measured seven of them, and the first version of these tests
   * asserted against a frame mostly drawn by the calendar. Anything holding ink
   * to a box has to own the whole canvas first.
   */
  const placeWidget = (
    type: string,
    config: unknown,
    box: { x: number; y: number; w: number; h: number } = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    orientation = 'landscape',
  ): void => {
    const at = Date.now();
    db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screenId);
    db.prepare('DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = ?').run(
      screenId,
      orientation,
    );
    db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      randomBytes(8).toString('hex'), screenId, orientation, type,
      box.x, box.y, box.w, box.h, JSON.stringify(config), at, at,
    );
  };

  const manifest = async (): Promise<Record<string, unknown>> => {
    const response = await call('http://localhost:8080/d/manifest', {
      headers: { cookie: '' },
    });
    return (await response.json()) as Record<string, unknown>;
  };

  return { db, call, post, token, screenId, placeWidget, manifest };
}

describe('the chore panel in a real manifest', () => {
  it('is absent until the household has a chore, then present with its day', async () => {
    const h = await harness();
    const before = await (
      await h.call(`http://localhost:8080/d/manifest`, {
        headers: { authorization: `Bearer ${h.token}` },
      })
    ).json();
    expect((before as { panels: Record<string, unknown> }).panels['chores']).toBeUndefined();

    createChore(h.db, {
      name: 'Put the bins out',
      personId: null,
      schedule: { kind: 'daily' },
      dueTime: null,
    });

    const after = (await (
      await h.call(`http://localhost:8080/d/manifest`, {
        headers: { authorization: `Bearer ${h.token}` },
      })
    ).json()) as { panels: Record<string, { today: string; days: { items: unknown[] }[] }> };

    const panel = after.panels['chores'];
    expect(panel).toBeDefined();
    // The household's day, not the runner's — this suite runs in Pacific/Chatham.
    expect(panel?.today).toBe(localToday(HOUSEHOLD_TZ));
    expect(panel?.days).toHaveLength(7);
    expect(panel?.days[0]?.items).toHaveLength(1);
  });

  it('changes the manifest ETag when a chore is ticked, so a wall sees it', async () => {
    /*
     * `manifestEtag` drops `generatedAt`, so a poll that changes nothing is a
     * 304 and transfers no body. A completion has to be one of the things that
     * *does* change it, or a household would tick a chore and watch the wall
     * carry on saying it was outstanding until something unrelated moved.
     */
    const h = await harness();
    const id = createChore(h.db, {
      name: 'Bins',
      personId: null,
      schedule: { kind: 'daily' },
      dueTime: null,
    });
    const etagOf = async (): Promise<string> =>
      (
        await h.call(`http://localhost:8080/d/manifest`, {
          headers: { authorization: `Bearer ${h.token}` },
        })
      ).headers.get('etag') ?? '';

    const before = await etagOf();
    expect(before).toMatch(/^"[0-9a-f]{32}"$/);
    // Nothing changed: still the same document, and a wall would get a 304.
    expect(await etagOf()).toBe(before);

    setChoreDone(h.db, id, localToday(HOUSEHOLD_TZ), true);
    expect(await etagOf()).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * The black pixels in a PNG, and where they are.
 *
 * Decoded rather than eyeballed — the QR rule, which this repository learned by
 * shipping a code that passed every structural check and scanned as nothing.
 * "The frame changed" proves a byte moved; it passes just as happily when every
 * widget draws in the corner, so the bounds are checked too.
 */
function ink(png: Uint8Array): { x: number; y: number; w: number; h: number; pixels: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!,
    );
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
    } else if (type === 'IDAT') idat.push(data.slice());
    offset += 12 + length;
  }
  const merged = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of idat) {
    merged.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1; // +1 skips the per-row filter byte
    for (let x = 0; x < width; x++) {
      if (((raw[row + (x >> 3)]! >> (7 - (x & 7))) & 1) !== 0) continue; // 0 is black
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, pixels: 0 };
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
    pixels,
  };
}

describe('the chore board on an e-paper panel', () => {
  const frame = async (h: Awaited<ReturnType<typeof harness>>): Promise<Uint8Array> => {
    const response = await h.call(`http://localhost:8080/d/epaper/${h.token}.png`);
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
  };

  const seed = (h: Awaited<ReturnType<typeof harness>>): string[] => {
    const at = Date.now();
    for (const [id, name, color] of [
      ['p1', 'Sam', '#35916A'],
      ['p2', 'Ella', '#4C7FD1'],
    ] as const) {
      h.db
        .prepare(
          `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
           VALUES (?, ?, ?, 0, 0, ?, ?)`,
        )
        .run(id, name, color, at, at);
    }
    return [
      createChore(h.db, { name: 'Put the bins out', personId: 'p1', schedule: { kind: 'daily' }, dueTime: null }),
      createChore(h.db, { name: 'Feed the cat', personId: 'p2', schedule: { kind: 'daily' }, dueTime: null }),
    ];
  };

  it('draws the board inside the box the household dragged it to', async () => {
    const h = await harness();
    seed(h);
    // A box in the bottom-right quarter, alone on the canvas — so "it drew
    // something" cannot pass by drawing in the corner every other widget
    // starts in, and cannot pass on ink another widget put there.
    h.placeWidget('chores', {}, { x: 0.55, y: 0.55, w: 0.4, h: 0.4 });

    const bounds = ink(await frame(h));
    expect(bounds.pixels).toBeGreaterThan(0);
    // Held to the posted box, with a little slack for the glyph metrics.
    expect(bounds.x).toBeGreaterThan(0.5);
    expect(bounds.y).toBeGreaterThan(0.5);
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(1);
  });

  it('draws a different frame for each of the three views', async () => {
    /*
     * The e-paper calendar shipped with all three of its "Show as" values
     * drawing the same thing, because the panel tested `mode === 'month'`
     * against a default the editor stores as an absence. Three identical
     * frames is exactly what that looked like, so it is what this refuses.
     */
    const views: (Record<string, unknown> | undefined)[] = [{}, { mode: 'people' }, { mode: 'week' }];
    const frames: string[] = [];
    for (const config of views) {
      const h = await harness();
      seed(h);
      h.placeWidget('chores', config);
      frames.push(Buffer.from(await frame(h)).toString('base64'));
    }
    expect(new Set(frames).size).toBe(3);
  });

  it('adds ink when a chore is ticked, and nothing else moves', async () => {
    /*
     * The sharpest assertion available on a 1-bit frame. Same chores, same day,
     * same layout — the only difference is one box going from outline to
     * filled, so the ink count must go *up*, by the area of that fill. "The
     * frame changed" would pass if the whole board had shifted a row.
     */
    const h = await harness();
    const [bins] = seed(h);
    h.placeWidget('chores', {});

    const before = ink(await frame(h));
    setChoreDone(h.db, bins!, localToday(HOUSEHOLD_TZ), true);
    const after = ink(await frame(h));

    expect(after.pixels).toBe(before.pixels + 36); // a 6×6 fill inside the 12px box
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it('honours "whose chores to show", drawing strictly less', async () => {
    const h = await harness();
    seed(h);
    h.placeWidget('chores', {});
    const all = ink(await frame(h));

    const h2 = await harness();
    seed(h2);
    // By person *id*, the same key and meaning the Shift widget's picker uses.
    h2.placeWidget('chores', { people: ['p1'] });
    const one = ink(await frame(h2));

    // Two chores drawn against one: strictly less ink, and still some.
    expect(one.pixels).toBeGreaterThan(0);
    expect(one.pixels).toBeLessThan(all.pixels);
  });

  it('refuses a tick from a panel, which cannot offer one anyway', async () => {
    /*
     * This assertion used to say the endpoint was a 404 — phase 2's "the wall
     * is read-only" — and it flipping is phase 3 landing, which is exactly what
     * it was written to notice.
     *
     * What survives is the half that still holds for a *panel*: `allow_chores`
     * is off by default, and an e-paper screen has no way to switch it on that
     * would mean anything, because a sleeping ESP32 cannot honour a tap.
     */
    const h = await harness();
    seed(h);
    const chore = readChores(h.db)[0]!;
    const response = await h.call('http://localhost:8080/d/chores/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `id=${chore.id}`,
    });
    expect(response.status).toBe(403);
    expect([...completionDates(h.db, chore.id, '2000-01-01', '2100-01-01')]).toEqual([]);
  });
});

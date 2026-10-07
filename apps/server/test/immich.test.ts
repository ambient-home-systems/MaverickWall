import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { createImmichSyncHandler, todayIn } from '../src/jobs/immich-sync.js';
import { immichBase } from '../src/modules/immich/client.js';
import { immichHandle } from '../src/modules/immich/store.js';
import { readAlbumSlides } from '../src/api/photo-albums.js';
import { fakeImmich, uuid, type FakeImmich } from './fake-immich.js';

/**
 * Immich as a photo source (plan item M3.2), against the real app, a real
 * database, the real fetcher and a stand-in Immich on loopback built from
 * Immich's own API description.
 *
 * Held first, what never happens: a key Immich refused is kept; a key, an
 * Immich address or an asset id reaches a wall; a wall reaches a photo the
 * household did not choose; a wall goes blank because Immich is down. Then the
 * journey: connect, choose an album, a person, favourites or the day's
 * memories, and see its photos on a wall by handle.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const fakes: FakeImmich[] = [];
let n = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(fakes.map((fake) => fake.close()));
});

const SUMMER = uuid(1);
const GARDEN = uuid(2);
const AMY = uuid(3);
const BEN = uuid(4);
const UNNAMED = uuid(5);
const HIDDEN = uuid(6);

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: ReturnType<typeof createKeyring>;
  readonly dataDir: string;
  readonly fake: FakeImmich;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly wall: (path: string) => Promise<Response>;
  readonly connect: () => Promise<Response>;
  readonly add: (choice: string) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  n++;
  const fake = await fakeImmich();
  fakes.push(fake);
  fake.albums.push({ id: SUMMER, albumName: 'Summer 2026' }, { id: GARDEN, albumName: 'Garden' });
  fake.people.push(
    { id: AMY, name: 'Amy', isHidden: false },
    { id: BEN, name: 'Ben', isHidden: false },
    { id: UNNAMED, name: '', isHidden: false },
    { id: HIDDEN, name: 'Hidden Harry', isHidden: true },
  );
  for (let i = 0; i < 7; i++) {
    fake.assets.push({ id: uuid(100 + i), type: 'IMAGE', albums: [SUMMER], people: i % 2 === 0 ? [AMY] : [BEN], favourite: i < 2 });
  }
  // A video in the album: never a slide.
  fake.assets.push({ id: uuid(200), type: 'VIDEO', albums: [SUMMER], people: [AMY], favourite: true });
  // A video among the memories: the search asks Immich for images, but
  // memories come back as they are, so this is the client's own filter.
  fake.memories = [uuid(100), uuid(101), uuid(200)];

  const dataDir = mkdtempSync(join(tmpdir(), 'mw-immich-'));
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
    clientAddress: () => `10.47.${n}.1`,
    setupToken,
    dataDir,
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
    email: `immich${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  return {
    db,
    keyring,
    dataDir,
    fake,
    form,
    get: (path) => call(path),
    wall: async (path) => app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${display.token}` } })),
    connect: () => form('/admin/photos/immich', { url: `${fake.base}/api/`, key: fake.key, allow_lan: '1', allow_http: '1' }),
    add: (choice) => form('/admin/photos/immich/add', { choice }),
  };
}

const handlesOf = (h: Harness, sourceId?: string): string[] =>
  (h.db
    .prepare(`SELECT handle FROM immich_assets ${sourceId === undefined ? '' : 'WHERE source_id = ?'} ORDER BY position`)
    .all(...(sourceId === undefined ? [] : [sourceId])) as { handle: string }[]).map((row) => row.handle);
const sourceIdOf = (h: Harness, name: string): string =>
  (h.db.prepare('SELECT id FROM immich_sources WHERE name = ?').get(name) as { id: string } | undefined)?.id ?? '';

describe('connecting', () => {
  it('reads the address the way Immich shows it, with or without /api and a trailing slash', () => {
    expect(immichBase('http://nas:2283/api/')).toBe('http://nas:2283');
    expect(immichBase('  https://photos.example.com/  ')).toBe('https://photos.example.com');
  });

  it('keeps a key only once Immich has accepted it, sealed, and never shows it again', async () => {
    const h = await harness();
    const refused = await h.form('/admin/photos/immich', { url: h.fake.base, key: 'not-the-key', allow_lan: '1', allow_http: '1' });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('Immich did not accept that API key.');
    expect(page).not.toContain('not-the-key');
    expect(h.db.prepare('SELECT count(*) AS n FROM immich_connection').get()).toEqual({ n: 0 });

    expect((await h.connect()).headers.get('location')).toContain('saved=immich-connected');
    expect(JSON.stringify(h.db.prepare('SELECT * FROM immich_connection').get())).not.toContain(h.fake.key);
    const photos = await (await h.get('/admin/photos')).text();
    expect(photos).toContain(`Connected to ${new URL(h.fake.base).host} as Jane`);
    expect(photos).not.toContain(h.fake.key);
    expect(await (await h.get('/admin/photos/immich')).text()).not.toContain(h.fake.key);
  });

  it('names the switches an address on the household’s own network needs, and contacts nothing without them', async () => {
    const h = await harness();
    const refused = await h.form('/admin/photos/immich', { url: h.fake.base, key: h.fake.key });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('turned on below');
    expect(page).toContain(`value="${h.fake.base}"`);
    expect(h.fake.requests).toHaveLength(0);
  });

  it('reads "today" for memories in the household’s zone, at fixed instants either side of midnight', () => {
    const at = Date.UTC(2026, 9, 7, 23, 30);
    expect(todayIn('Europe/London', at)).toBe('2026-10-08');
    expect(todayIn('America/New_York', at)).toBe('2026-10-07');
    expect(todayIn('Pacific/Auckland', Date.UTC(2026, 9, 7, 12, 0))).toBe('2026-10-08');
  });

  it('says plainly when the address answers but is not Immich', async () => {
    const h = await harness();
    const wrong = await h.form('/admin/photos/immich', { url: `${h.fake.base}/elsewhere`, key: h.fake.key, allow_lan: '1', allow_http: '1' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('not as Immich');
  });
});

describe('choosing what to show', () => {
  it('offers the albums with their counts, named people only, favourites and the day’s memories', async () => {
    const h = await harness();
    await h.connect();
    const page = await (await h.get('/admin/photos/immich/add')).text();
    expect(page).toContain('Summer 2026 — 8 items');
    expect(page).toContain('value="favourites"');
    expect(page).toContain('value="memories"');
    expect(page).toContain(`value="person:${AMY}"`);
    expect(page).not.toContain(UNNAMED);
    expect(page).not.toContain('Hidden Harry');
  });

  it('reads an album through the search before saying it was added, leaving the video out, across pages', async () => {
    const h = await harness();
    h.fake.pageSize = 3;
    await h.connect();
    expect((await h.add(`album:${SUMMER}`)).headers.get('location')).toContain('saved=immich-source-added');
    const id = sourceIdOf(h, 'Summer 2026');
    const expected = [0, 1, 2, 3, 4, 5, 6].map((i) => immichHandle(uuid(100 + i)));
    expect(handlesOf(h, id)).toEqual(expected);
    const searches = h.fake.requests.filter((request) => request.path === '/api/search/metadata');
    expect(searches.length).toBeGreaterThanOrEqual(3);
    expect(searches.every((request) => request.contentType?.startsWith('application/json'))).toBe(true);
    // Paged by cursor, the way Immich 3.2 and later do it.
    expect(searches.slice(1).every((request) => JSON.parse(request.body).cursor !== undefined)).toBe(true);
    // And never the key in an address.
    expect(h.fake.requests.every((request) => !request.query.includes(h.fake.key) && request.key === h.fake.key)).toBe(true);
  });

  it('pages by page number against an Immich from before 3.2', async () => {
    const h = await harness();
    h.fake.pageSize = 3;
    h.fake.cursors = false;
    await h.connect();
    await h.add(`album:${SUMMER}`);
    expect(handlesOf(h, sourceIdOf(h, 'Summer 2026'))).toHaveLength(7);
    const pages = h.fake.requests.filter((request) => request.path === '/api/search/metadata').map((request) => JSON.parse(request.body).page);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('reads a person, the favourites and today’s memories in the household’s own zone', async () => {
    const h = await harness();
    await h.connect();
    await h.add(`person:${AMY}`);
    await h.add('favourites');
    await h.add('memories');
    expect(handlesOf(h, sourceIdOf(h, 'Amy'))).toEqual([0, 2, 4, 6].map((i) => immichHandle(uuid(100 + i))));
    expect(handlesOf(h, sourceIdOf(h, 'Favourites'))).toEqual([0, 1].map((i) => immichHandle(uuid(100 + i))));
    expect(handlesOf(h, sourceIdOf(h, 'On this day'))).toEqual([0, 1].map((i) => immichHandle(uuid(100 + i))));
    const memories = h.fake.requests.find((request) => request.path === '/api/memories');
    expect(memories?.query).toBe(`?for=${todayIn('Europe/London', Date.now())}`);
  });

  it('refuses an album the account does not have, and says so of an Immich too old for memories', async () => {
    const h = await harness();
    await h.connect();
    const stranger = await h.add(`album:${uuid(77)}`);
    expect(stranger.status).toBe(400);
    expect(await stranger.text()).toContain('not in your Immich any more');
    h.fake.noMemories = true;
    const old = await h.add('memories');
    expect(old.status).toBe(400);
    expect(await old.text()).toContain('too old to have memories');
    expect(h.db.prepare('SELECT count(*) AS n FROM immich_sources').get()).toEqual({ n: 0 });
  });
});

describe('on a wall', () => {
  async function wallWithSummer(): Promise<{ h: Harness; id: string; handles: string[] }> {
    const h = await harness();
    await h.connect();
    await h.add(`album:${SUMMER}`);
    const id = sourceIdOf(h, 'Summer 2026');
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-show', 'wall', 'portrait', 'image', 0, 0, 1, 1, 0, ?, ?, ?)`,
      )
      .run(JSON.stringify({ album: id }), stamp, stamp);
    return { h, id, handles: handlesOf(h, id) };
  }

  it('is an album like any other to the slideshow, by handle, and the manifest names nothing of Immich', async () => {
    const { h, id, handles } = await wallWithSummer();
    expect(readAlbumSlides(h.db).find((album) => album.id === id)).toEqual({ id, name: 'Summer 2026 (Immich)', photos: handles });
    const manifest = await (await h.wall('/d/manifest')).text();
    expect(manifest).toContain(handles[0]);
    expect(manifest).not.toContain(h.fake.base);
    expect(manifest).not.toContain(new URL(h.fake.base).host);
    expect(manifest).not.toContain(h.fake.key);
    expect(manifest).not.toContain(uuid(100));
    expect(manifest).not.toContain(SUMMER);
  });

  it('serves a photo behind the display token, sniffed, keeps a copy, and goes on serving it with Immich down', async () => {
    const { h, handles } = await wallWithSummer();
    const handle = handles[0] ?? '';
    expect((await h.get(`/d/media/${handle}`)).status).toBe(401);
    const served = await h.wall(`/d/media/${handle}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(existsSync(join(h.dataDir, 'immich-cache', handle))).toBe(true);
    h.fake.failWith = 503;
    const again = await h.wall(`/d/media/${handle}`);
    expect(again.status).toBe(200);
    // One that was never fetched cannot be served while Immich is down: a 404, never a stranger's bytes.
    expect((await h.wall(`/d/media/${handles[1]}`)).status).toBe(404);
  });

  it('serves nothing for a handle no source names', async () => {
    const { h } = await wallWithSummer();
    expect((await h.wall(`/d/media/${immichHandle(uuid(200))}`)).status).toBe(404);
    expect((await h.wall(`/d/media/${'f'.repeat(64)}.jpg`)).status).toBe(404);
  });
});

describe('keeping up', () => {
  const job = (h: Harness): ReturnType<typeof createImmichSyncHandler> =>
    createImmichSyncHandler({ db: h.db, keyring: h.keyring, fetcher: createFetcher(), dataDir: h.dataDir, timezone: () => 'Europe/London' });
  const run = (handler: ReturnType<typeof createImmichSyncHandler>) =>
    handler({ key: 'immich-sync', kind: 'immich-sync', nextRunAt: 0, consecutiveFailures: 0 });

  it('keeps the last good photos and says why on the Photos screen when Immich will not answer', async () => {
    const h = await harness();
    await h.connect();
    await h.add(`album:${SUMMER}`);
    const before = handlesOf(h);
    h.fake.failWith = 500;
    expect(await run(job(h))).toMatchObject({ status: 'failed' });
    expect(handlesOf(h)).toEqual(before);
    const page = await (await h.get('/admin/photos')).text();
    expect(page).toContain('Immich refused it (500)');
    expect(page).toContain('The photos it had are still shown.');
  });

  it('skips without a connection, and fetches ahead the photos not yet kept when there is one', async () => {
    const h = await harness();
    expect(await run(job(h))).toMatchObject({ status: 'skipped' });
    await h.connect();
    await h.add(`album:${SUMMER}`);
    expect(existsSync(join(h.dataDir, 'immich-cache'))).toBe(false);
    expect(await run(job(h))).toEqual({ status: 'ok' });
    expect(readdirSync(join(h.dataDir, 'immich-cache')).sort()).toEqual([...handlesOf(h)].sort());
  });

  it('forgets everything on disconnect: the key, the sources, the handles and every kept copy', async () => {
    const h = await harness();
    await h.connect();
    await h.add(`album:${SUMMER}`);
    await h.wall(`/d/media/${handlesOf(h)[0]}`);
    expect(readdirSync(join(h.dataDir, 'immich-cache'))).toHaveLength(1);
    expect(await (await h.get('/admin/photos/immich/disconnect')).text()).toContain('Disconnect Immich?');
    expect((await h.form('/admin/photos/immich/disconnect', {})).headers.get('location')).toContain('saved=immich-disconnected');
    for (const table of ['immich_connection', 'immich_sources', 'immich_assets']) {
      expect(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(existsSync(join(h.dataDir, 'immich-cache'))).toBe(false);
  });

  it('removes one source and the copies only it named', async () => {
    const h = await harness();
    await h.connect();
    await h.add(`album:${SUMMER}`);
    await h.add('favourites');
    const [first] = handlesOf(h, sourceIdOf(h, 'Summer 2026'));
    const sixth = handlesOf(h, sourceIdOf(h, 'Summer 2026'))[5] ?? '';
    await h.wall(`/d/media/${first}`);
    await h.wall(`/d/media/${sixth}`);
    const removed = await h.form(`/admin/photos/immich/sources/${sourceIdOf(h, 'Summer 2026')}/remove`, {});
    expect(removed.headers.get('location')).toContain('saved=immich-source-removed');
    // The first is a favourite too, so its copy stays; the sixth was only in the album.
    expect(existsSync(join(h.dataDir, 'immich-cache', first ?? ''))).toBe(true);
    expect(existsSync(join(h.dataDir, 'immich-cache', sixth))).toBe(false);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { MAX_PHOTO_BYTES, mediaDir, sniffHeif, storeImage } from '../src/api/media.js';
import { addPhoto, createAlbum, forgetIfUnused, removePhoto } from '../src/api/photo-albums.js';

/**
 * Photo albums (plan item M3.1), against the real app, a real database and a
 * real data directory.
 *
 * Held first: every file is still the media store's — sniffed, never an SVG,
 * named by its hash and stored once however many albums hold it — and a HEIC
 * photo is named and refused without costing the rest of its upload. Then the
 * one new thing this owns, which is deleting: a photo leaves the disk only when
 * nothing in the database still names it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Real headers, as `media.test.ts` uses: the server sniffs bytes and never decodes them. */
const png = (seed: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, seed)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
/** An iPhone photo's first box: `ftyp`, brand `heic`. */
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 0)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(64, 0)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

interface Harness {
  readonly db: SqliteDatabase;
  readonly dataDir: string;
  readonly get: (path: string) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly upload: (albumId: string, files: readonly { name: string; bytes: Buffer }[]) => Promise<Response>;
  readonly album: (name?: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  n++;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-photos-'));
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
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.43.${n}.1`,
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
    email: `photos${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  return {
    db,
    dataDir,
    get: (path) => call(path),
    form,
    upload: (albumId, files) => {
      const body = new FormData();
      for (const file of files) body.append('photos', new File([new Uint8Array(file.bytes)], file.name));
      return call(`/admin/photos/${albumId}/upload`, { method: 'POST', body });
    },
    album: async (name = 'Holidays') => {
      const made = await form('/admin/photos', { name });
      const id = /\/admin\/photos\/([0-9a-f]{16})/.exec(made.headers.get('location') ?? '')?.[1];
      if (id === undefined) throw new Error(`no album: ${made.status}`);
      return id;
    },
  };
}

const assets = (h: Harness): { path: string; usage: string }[] =>
  h.db.prepare('SELECT path, usage FROM media_assets ORDER BY created_at').all() as { path: string; usage: string }[];
const items = (h: Harness, albumId: string): string[] =>
  (h.db.prepare('SELECT media_name AS name FROM photo_album_items WHERE album_id = ? ORDER BY position').all(albumId) as {
    name: string;
  }[]).map((row) => row.name);

describe('HEIC and AVIF', () => {
  it('are told apart from everything else by their ftyp brand', () => {
    expect(sniffHeif(HEIC)).toBe('heic');
    expect(sniffHeif(AVIF)).toBe('avif');
    expect(sniffHeif(JPEG)).toBeUndefined();
    expect(sniffHeif(png(1))).toBeUndefined();
    // An MP4 is ISO-BMFF too, and is not a photo.
    expect(sniffHeif(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(16)]))).toBeUndefined();
  });

  it('are refused with what to do, ahead of the size, so nobody shrinks a file that still would not be taken', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-photos-heic-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const big = Buffer.concat([HEIC, Buffer.alloc(MAX_PHOTO_BYTES)]);
    const refused = storeImage(db, dataDir, big, 'IMG_0001.HEIC', 'photo');
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('HEIC') as unknown as string });
    expect(refused.ok ? '' : refused.suggestion).toContain('Most Compatible');
  });
});

describe('albums', () => {
  it('lists under Photos in the navigation, and are named before they are made', async () => {
    const h = await harness();
    const list = await (await h.get('/admin/photos')).text();
    expect(list).toContain('href="admin/photos"');
    expect(list).toContain('No albums yet.');
    expect(list).toContain('href="admin/photos/new"');
    const refused = await h.form('/admin/photos', { name: '   ' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Give the album a name.');
    const id = await h.album('Summer 2026');
    expect(await (await h.get('/admin/photos')).text()).toContain('Summer 2026');
    expect(await (await h.get(`/admin/photos/${id}`)).text()).toContain('No photos yet');
  });

  it('adds every photo in one upload, stored in the media store as a photo and named by its hash', async () => {
    const h = await harness();
    const id = await h.album();
    const added = await h.upload(id, [
      { name: 'beach.png', bytes: png(1) },
      { name: 'IMG_0002.JPG', bytes: JPEG },
    ]);
    expect(added.headers.get('location')).toContain('saved=photos-added');
    expect(assets(h).map((asset) => asset.usage)).toEqual(['photo', 'photo']);
    expect(items(h, id)).toEqual(assets(h).map((asset) => asset.path));
    for (const name of items(h, id)) {
      expect(name).toMatch(/^[0-9a-f]{64}\.(png|jpg)$/);
      expect(existsSync(join(mediaDir(h.dataDir), name))).toBe(true);
    }
    const page = await (await h.get(`/admin/photos/${id}`)).text();
    expect(page).toContain('2 photos');
    expect(page).toContain('alt="beach.png"');
    expect(page).toContain('src="assets/photo-upload.js"');
  });

  it('names a HEIC photo and an SVG and adds the rest of the same upload', async () => {
    const h = await harness();
    const id = await h.album();
    const mixed = await h.upload(id, [
      { name: 'IMG_0001.HEIC', bytes: HEIC },
      { name: 'beach.png', bytes: png(1) },
      { name: 'logo.svg', bytes: SVG },
    ]);
    expect(mixed.status).toBe(400);
    const page = await mixed.text();
    expect(page).toContain('1 photo was added.');
    expect(page).toContain('IMG_0001.HEIC: That is a HEIC photo');
    expect(page).toContain('logo.svg: That file is not an image this can use.');
    expect(items(h, id)).toHaveLength(1);
  });

  it('takes a photo bigger than an avatar may be, since a wall can be a television', async () => {
    const h = await harness();
    const id = await h.album();
    const big = await h.upload(id, [{ name: 'big.png', bytes: Buffer.concat([png(1), Buffer.alloc(3 * 1024 * 1024)]) }]);
    expect(big.headers.get('location')).toContain('saved=photos-added');
  });

  it('refuses a photo over the cap without storing it', async () => {
    const h = await harness();
    const id = await h.album();
    const huge = await h.upload(id, [{ name: 'huge.png', bytes: Buffer.concat([png(1), Buffer.alloc(MAX_PHOTO_BYTES)]) }]);
    expect(huge.status).toBe(400);
    expect(await huge.text()).toContain('huge.png: larger than 8 MB');
    expect(assets(h)).toEqual([]);
  });

  it('says a photo already in the album is already there rather than added, and stores one file for two albums', async () => {
    const h = await harness();
    const one = await h.album('One');
    const two = await h.album('Two');
    await h.upload(one, [{ name: 'beach.png', bytes: png(1) }]);
    const again = await h.upload(one, [{ name: 'beach copy.png', bytes: png(1) }]);
    expect(again.headers.get('location')).toContain('saved=photos-already-there');
    await h.upload(two, [{ name: 'beach.png', bytes: png(1) }]);
    expect(items(h, one)).toEqual(items(h, two));
    expect(assets(h)).toHaveLength(1);
  });

  it('serves a photo to the admin behind the session, sniffed again and never sniffed by the browser', async () => {
    const h = await harness();
    const id = await h.album();
    await h.upload(id, [{ name: 'beach.png', bytes: png(1) }]);
    const name = items(h, id)[0] ?? '';
    const served = await h.get(`/admin/media/${name}`);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('deleting: a photo leaves the disk only when nothing names it', () => {
  it('deletes a removed photo nothing else uses, and keeps one another album still holds', async () => {
    const h = await harness();
    const one = await h.album('One');
    const two = await h.album('Two');
    await h.upload(one, [{ name: 'a.png', bytes: png(1) }, { name: 'b.png', bytes: png(2) }]);
    await h.upload(two, [{ name: 'b.png', bytes: png(2) }]);
    const [a, b] = items(h, one);
    const removedA = await h.form(`/admin/photos/${one}/remove/${a}`, {});
    expect(removedA.headers.get('location')).toContain('saved=photo-removed');
    expect(existsSync(join(mediaDir(h.dataDir), a ?? ''))).toBe(false);
    await h.form(`/admin/photos/${one}/remove/${b}`, {});
    expect(existsSync(join(mediaDir(h.dataDir), b ?? ''))).toBe(true);
    expect(assets(h).map((asset) => asset.path)).toEqual([b]);
  });

  it('keeps a photo a wall uses by name anywhere, and never deletes an avatar or a background', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-photos-gc-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const album = createAlbum(db, 'Album', 1);
    const albumId = album.ok ? album.id : '';
    const photo = storeImage(db, dataDir, png(5), 'p.png', 'photo');
    const name = photo.ok ? photo.name : '';
    addPhoto(db, albumId, name, 1);
    // A wall whose Image widget names it, the way a layout row stores it.
    db.prepare(
      `INSERT INTO layout_widgets (id, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES ('w1', 'image', 0, 0, 0.5, 0.5, 0, ?, 1, 1)`,
    ).run(JSON.stringify({ image: name }));
    expect(removePhoto(db, dataDir, albumId, name)).toBe(true);
    expect(existsSync(join(mediaDir(dataDir), name))).toBe(true);
    db.prepare(`DELETE FROM layout_widgets`).run();
    expect(forgetIfUnused(db, dataDir, name)).toBe(true);
    expect(existsSync(join(mediaDir(dataDir), name))).toBe(false);

    const avatar = storeImage(db, dataDir, png(6), 'face.png', 'avatar');
    expect(forgetIfUnused(db, dataDir, avatar.ok ? avatar.name : '')).toBe(false);
    expect(existsSync(join(mediaDir(dataDir), avatar.ok ? avatar.name : ''))).toBe(true);
  });

  it('deletes an album from its confirmation page, with its unused photos', async () => {
    const h = await harness();
    const id = await h.album('Old');
    await h.upload(id, [{ name: 'a.png', bytes: png(1) }]);
    const [a] = items(h, id);
    const confirm = await (await h.get(`/admin/photos/${id}/delete`)).text();
    expect(confirm).toContain('Delete Old?');
    const gone = await h.form(`/admin/photos/${id}/delete`, {});
    expect(gone.headers.get('location')).toContain('saved=album-removed');
    expect(h.db.prepare('SELECT count(*) AS n FROM photo_albums').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT count(*) AS n FROM photo_album_items').get()).toEqual({ n: 0 });
    expect(existsSync(join(mediaDir(h.dataDir), a ?? ''))).toBe(false);
  });

  it('claims nothing for a name that is not a stored one, or not in the album', async () => {
    const h = await harness();
    const id = await h.album();
    const odd = await h.form(`/admin/photos/${id}/remove/..%2F..%2Fkey`, {});
    expect(odd.headers.get('location')).not.toContain('saved=');
    const absent = await h.form(`/admin/photos/${id}/remove/${'a'.repeat(64)}.png`, {});
    expect(absent.headers.get('location')).not.toContain('saved=');
  });
});

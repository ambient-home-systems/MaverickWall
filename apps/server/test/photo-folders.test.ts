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
import { createPhotoFoldersSyncHandler } from '../src/jobs/photo-folders-sync.js';
import { insideFolder } from '../src/modules/folder/client.js';
import { readAlbumSlides } from '../src/api/photo-albums.js';
import { skippedSentence } from '../src/http/admin-folders.js';
import { fakeWebDav, png, type FakeWebDav } from './fake-webdav.js';

/**
 * A NAS folder as a photo source (plan item M3.3), against the real app, a
 * real database, the real fetcher and a WebDAV stand-in on loopback.
 *
 * What never happens: a password is kept for a folder the NAS refused, or
 * shown, or sent somewhere a listing points outside the folder; a wall learns
 * the NAS's address; a wall goes blank while the NAS sleeps. What a wall
 * cannot show — HEIC, RAW, a picture too big to fetch — is counted and named.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const fakes: FakeWebDav[] = [];
let n = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(fakes.map((fake) => fake.close()));
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: ReturnType<typeof createKeyring>;
  readonly dataDir: string;
  readonly nas: FakeWebDav;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  readonly wall: (path: string) => Promise<Response>;
  readonly add: (extra?: Record<string, string>) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  n++;
  const nas = await fakeWebDav();
  fakes.push(nas);
  nas.username = 'family';
  nas.password = 'nas-secret-password';
  const photo = (path: string, seed: number): void => {
    nas.files.set(path, { bytes: png(seed), type: 'image/png', etag: `e${seed}` });
  };
  photo('/photo/Holidays 2026/beach 10.png', 1);
  photo('/photo/Holidays 2026/beach 2.png', 2);
  photo('/photo/Holidays 2026/beach 1.png', 3);
  photo('/photo/Holidays 2026/Day trip/cliffs.png', 4);
  photo('/photo/Holidays 2026/Day trip/Deeper/Deepest/Too deep/bottom.png', 5);
  nas.files.set('/photo/Holidays 2026/IMG_0001.HEIC', { bytes: Buffer.from('heic'), type: 'image/heic', etag: 'h' });
  nas.files.set('/photo/Holidays 2026/IMG_0002.HEIC', { bytes: Buffer.from('heic'), type: 'application/octet-stream', etag: 'h2' });
  // A photo shared off a phone, named by nothing but its type.
  nas.files.set('/photo/Holidays 2026/shared photo', { bytes: Buffer.from('heif'), type: 'image/heif', etag: 'h3' });
  nas.files.set('/photo/Holidays 2026/DSC_1234.NEF', { bytes: Buffer.from('raw'), type: 'application/octet-stream', etag: 'r' });
  nas.files.set('/photo/Holidays 2026/panorama.jpg', { bytes: Buffer.from('big'), type: 'image/jpeg', etag: 'b', claimedSize: 40 * 1024 * 1024 });
  nas.files.set('/photo/Holidays 2026/notes.txt', { bytes: Buffer.from('a note'), type: 'text/plain', etag: 't' });
  nas.files.set('/photo/Private/secret.png', { bytes: png(9), type: 'image/png', etag: 's' });
  // What a server should never be trusted with: a photo on another host, and one above the folder.
  nas.strays.set('/photo/Holidays 2026/', ['http://evil.example/steal.jpg', '/photo/Private/secret.png', '/photo/Holidays%202026/..%2f..%2fPrivate/secret.png']);

  const dataDir = mkdtempSync(join(tmpdir(), 'mw-folders-'));
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
    clientAddress: () => `10.49.${n}.1`,
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
    email: `folders${n}@home.local`,
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
    nas,
    form,
    get: (path) => call(path),
    wall: async (path) => app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${display.token}` } })),
    add: (extra = {}) =>
      form('/admin/photos/folders', {
        name: 'Holidays',
        url: `${nas.base}/photo/Holidays%202026`,
        username: 'family',
        password: 'nas-secret-password',
        allow_lan: '1',
        allow_http: '1',
        ...extra,
      }),
  };
}

const paths = (h: Harness): string[] =>
  (h.db.prepare('SELECT path FROM photo_folder_assets ORDER BY position').all() as { path: string }[]).map((row) => row.path);
const handles = (h: Harness): string[] =>
  (h.db.prepare('SELECT handle FROM photo_folder_assets ORDER BY position').all() as { handle: string }[]).map((row) => row.handle);
const folderId = (h: Harness): string => (h.db.prepare('SELECT id FROM photo_folders').get() as { id: string } | undefined)?.id ?? '';

describe('a href is followed only inside the folder', () => {
  it('keeps a path under the folder on its origin, and nothing else', () => {
    const folder = 'http://nas:5005/photo/Holidays%202026/';
    expect(insideFolder('/photo/Holidays%202026/a.jpg', folder, folder)).toBe('/photo/Holidays%202026/a.jpg');
    expect(insideFolder('a.jpg', folder, folder)).toBe('/photo/Holidays%202026/a.jpg');
    expect(insideFolder('http://evil.example/photo/Holidays%202026/a.jpg', folder, folder)).toBeUndefined();
    expect(insideFolder('https://nas:5005/photo/Holidays%202026/a.jpg', folder, folder)).toBeUndefined();
    expect(insideFolder('/photo/Private/a.jpg', folder, folder)).toBeUndefined();
    expect(insideFolder('/photo/Holidays%202026/../Private/a.jpg', folder, folder)).toBeUndefined();
    expect(insideFolder('/photo/Holidays%202026/..%2f..%2fPrivate/a.jpg', folder, folder)).toBeUndefined();
    expect(insideFolder('/photo/Holidays%202026-other/a.jpg', folder, folder)).toBeUndefined();
  });
});

describe('adding a folder', () => {
  it('reads it before adding it, in name order, sealing the address and password', async () => {
    const h = await harness();
    expect((await h.add()).headers.get('location')).toContain('saved=folder-added');
    expect(paths(h)).toEqual([
      '/photo/Holidays%202026/beach%201.png',
      '/photo/Holidays%202026/beach%202.png',
      '/photo/Holidays%202026/beach%2010.png',
    ]);
    const row = JSON.stringify(h.db.prepare('SELECT * FROM photo_folders').get());
    expect(row).not.toContain('nas-secret-password');
    expect(row).not.toContain('Holidays%202026');
    expect(row).toContain(new URL(h.nas.base).host);
    const page = await (await h.get('/admin/photos')).text();
    expect(page).toContain(`${new URL(h.nas.base).host} · as family · 3 photos`);
    expect(page).not.toContain('nas-secret-password');
    // A listing that came through a 301 to the folder with its slash.
    expect(h.nas.requests.some((request) => request.method === 'PROPFIND' && request.depth === '1')).toBe(true);
  });

  it('names what a wall cannot show: three HEIC photos, a RAW file and a picture over 10 MB', async () => {
    const h = await harness();
    await h.add();
    expect(await (await h.get('/admin/photos')).text()).toContain(
      '3 HEIC photos, 1 RAW file and 1 picture over 10 MB left out: walls cannot show them. Save as JPEG to include them.',
    );
    expect(skippedSentence({ skippedHeic: 1, skippedRaw: 0, skippedLarge: 0 })).toBe(
      '1 HEIC photo left out: walls cannot show it. Save as JPEG to include it.',
    );
    expect(skippedSentence({ skippedHeic: 0, skippedRaw: 0, skippedLarge: 0 })).toBeUndefined();
  });

  it('goes into the folders inside it when asked, three deep and no deeper', async () => {
    const h = await harness();
    await h.add({ subfolders: '1' });
    expect(paths(h)).toContain('/photo/Holidays%202026/Day%20trip/cliffs.png');
    expect(paths(h).some((path) => path.includes('bottom.png'))).toBe(false);
  });

  it('never follows a listing out of the folder, and never sends the password there', async () => {
    const h = await harness();
    await h.add({ subfolders: '1' });
    expect(paths(h).some((path) => path.includes('Private') || path.includes('steal'))).toBe(false);
    await createPhotoFoldersSyncHandler({ db: h.db, keyring: h.keyring, fetcher: createFetcher(), dataDir: h.dataDir })({
      key: 'photo-folders-sync',
      kind: 'photo-folders-sync',
      nextRunAt: 0,
      consecutiveFailures: 0,
    });
    expect(h.nas.requests.some((request) => request.path.includes('Private'))).toBe(false);
  });

  it('keeps nothing for a password the NAS refused, says which, and echoes all but the password', async () => {
    const h = await harness();
    const refused = await h.add({ password: 'wrong-password' });
    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain('That username and password were not accepted.');
    expect(page).toContain('value="family"');
    expect(page).not.toContain('wrong-password');
    expect(h.db.prepare('SELECT count(*) AS n FROM photo_folders').get()).toEqual({ n: 0 });
    const none = await h.add({ username: '', password: '' });
    expect(await none.text()).toContain('That folder needs a username and password.');
  });

  it('refuses a password typed into the address, and names the switches a local address needs', async () => {
    const h = await harness();
    const inline = await h.add({ url: `${h.nas.base.replace('http://', 'http://family:pw@')}/photo/Holidays%202026` });
    expect(await inline.text()).toContain('Put the username and password in their own boxes');
    const local = await h.add({ allow_lan: '', allow_http: '' });
    expect(local.status).toBe(400);
    expect(await local.text()).toContain('turned on below');
    expect(h.nas.requests).toHaveLength(0);
  });

  it('says plainly when there is no folder there, or it is not WebDAV', async () => {
    const h = await harness();
    expect(await (await h.add({ url: `${h.nas.base}/photo/Nowhere` })).text()).toContain('There is no folder at that address');
    h.nas.plainWeb = true;
    expect(await (await h.add()).text()).toContain('not as a WebDAV folder');
  });
});

describe('on a wall', () => {
  it('is an album to the slideshow by handle, and the manifest names nothing of the NAS', async () => {
    const h = await harness();
    await h.add();
    const id = folderId(h);
    expect(readAlbumSlides(h.db).find((album) => album.id === id)).toEqual({ id, name: 'Holidays (folder)', photos: handles(h), portraits: [] });
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w', 'wall', 'portrait', 'image', 0, 0, 1, 1, 0, ?, ?, ?)`,
      )
      .run(JSON.stringify({ album: id }), stamp, stamp);
    const manifest = await (await h.wall('/d/manifest')).text();
    expect(manifest).toContain(handles(h)[0]);
    expect(manifest).not.toContain(new URL(h.nas.base).host);
    expect(manifest).not.toContain('Holidays%202026');
    expect(manifest).not.toContain('beach');
  });

  it('serves a photo behind the display token, keeps a copy, and goes on serving it with the NAS asleep', async () => {
    const h = await harness();
    await h.add();
    const [first, second] = handles(h);
    expect((await h.get(`/d/media/${first}`)).status).toBe(401);
    const served = await h.wall(`/d/media/${first}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(png(3))).toBe(true);
    const get = h.nas.requests.find((request) => request.method === 'GET');
    expect(get?.authorization).toBe(`Basic ${Buffer.from('family:nas-secret-password').toString('base64')}`);
    h.nas.failWith = 503;
    expect((await h.wall(`/d/media/${first}`)).status).toBe(200);
    expect((await h.wall(`/d/media/${second}`)).status).toBe(404);
  });

  it('gives a changed photo a new handle, so a kept copy is never the old picture', async () => {
    const h = await harness();
    await h.add();
    const before = handles(h);
    const changed = h.nas.files.get('/photo/Holidays 2026/beach 1.png');
    if (changed !== undefined) changed.etag = 'e-new';
    const sync = createPhotoFoldersSyncHandler({ db: h.db, keyring: h.keyring, fetcher: createFetcher(), dataDir: h.dataDir });
    await sync({ key: 'photo-folders-sync', kind: 'photo-folders-sync', nextRunAt: 0, consecutiveFailures: 0 });
    const after = handles(h);
    expect(after[0]).not.toBe(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

describe('keeping up', () => {
  const run = (h: Harness) =>
    createPhotoFoldersSyncHandler({ db: h.db, keyring: h.keyring, fetcher: createFetcher(), dataDir: h.dataDir })({
      key: 'photo-folders-sync',
      kind: 'photo-folders-sync',
      nextRunAt: 0,
      consecutiveFailures: 0,
    });

  it('skips with no folders, and fetches ahead the photos not yet kept when there are some', async () => {
    const h = await harness();
    expect(await run(h)).toMatchObject({ status: 'skipped' });
    await h.add();
    expect(await run(h)).toEqual({ status: 'ok' });
    expect(readdirSync(join(h.dataDir, 'photo-folder-cache')).sort()).toEqual([...handles(h)].sort());
  });

  it('keeps the last good photos and says why when the NAS will not answer', async () => {
    const h = await harness();
    await h.add();
    const before = handles(h);
    h.nas.failWith = 500;
    expect(await run(h)).toMatchObject({ status: 'failed' });
    expect(handles(h)).toEqual(before);
    const page = await (await h.get('/admin/photos')).text();
    expect(page).toContain('The server refused it (500)');
    expect(page).toContain('The photos it had are still shown.');
  });

  it('removes a folder with its kept copies, and changes nothing on the NAS', async () => {
    const h = await harness();
    await h.add();
    await h.wall(`/d/media/${handles(h)[0]}`);
    const removed = await h.form(`/admin/photos/folders/${folderId(h)}/remove`, {});
    expect(removed.headers.get('location')).toContain('saved=folder-removed');
    expect(h.db.prepare('SELECT count(*) AS n FROM photo_folder_assets').get()).toEqual({ n: 0 });
    expect(readdirSync(join(h.dataDir, 'photo-folder-cache'))).toEqual([]);
    expect(h.nas.requests.every((request) => request.method === 'PROPFIND' || request.method === 'GET')).toBe(true);
    expect(existsSync(join(h.dataDir, 'photo-folder-cache'))).toBe(true);
  });
});

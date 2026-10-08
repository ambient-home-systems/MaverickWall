import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { imageSize } from '../src/api/image-size.js';
import { measureKeptShapes, portraitHandles, recordShape } from '../src/api/photo-shapes.js';
import { readAlbumSlides } from '../src/api/photo-albums.js';
import { displayConfig } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';

/**
 * Which slideshow photos are portrait (plan item M3.7): the header reader, the
 * table and its precedence, measuring what this box keeps, and what the
 * manifest hands a wall. JPEG and WebP are read against Chromium's own
 * decoder in `browser-photo-pairing.test.ts`, from bytes a real encoder wrote.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function png(width: number, height: number): Buffer {
  const fb = new Framebuffer(width, height);
  fb.set(0, 0);
  return Buffer.from(encodePng1bit(fb));
}

function database(): { db: SqliteDatabase; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-shapes-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, dataDir };
}

const name = (c: string, ext = 'png'): string => `${c.repeat(64)}.${ext}`;

describe('imageSize', () => {
  it('reads a PNG and a GIF, and refuses what is not a picture or is cut short', () => {
    expect(imageSize(png(40, 90))).toEqual({ width: 40, height: 90 });
    const gif = Buffer.from('GIF89a\x2c\x01\xc8\x00\x00\x00\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 300, height: 200 });
    expect(imageSize(Buffer.from('not a picture at all'))).toBeUndefined();
    expect(imageSize(png(40, 90).subarray(0, 18))).toBeUndefined();
    // A JPEG whose frame header never arrives is nothing, not a guess.
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]))).toBeUndefined();
  });
});

describe('the shape table', () => {
  it('lets a measurement replace a guess, and never a guess a measurement', () => {
    const { db } = database();
    recordShape(db, 'a', { width: 4032, height: 3024 }, false, 1);
    expect([...portraitHandles(db)]).toEqual([]);
    recordShape(db, 'a', { width: 30, height: 60 }, true, 2);
    expect([...portraitHandles(db)]).toEqual(['a']);
    recordShape(db, 'a', { width: 4032, height: 3024 }, false, 3);
    expect([...portraitHandles(db)]).toEqual(['a']);
    expect(db.prepare('SELECT measured, updated_at AS at FROM photo_shapes').get()).toEqual({ measured: 1, at: 2 });
    // A square photo is not a portrait.
    recordShape(db, 'b', { width: 50, height: 50 }, true, 4);
    expect([...portraitHandles(db)]).toEqual(['a']);
  });

  it('measures every kept copy it has not measured, from all three sources, and leaves what is not here', () => {
    const { db, dataDir } = database();
    const at = 1_000;
    db.prepare(`INSERT INTO photo_albums (id, name, created_at, updated_at) VALUES ('0123456789abcdef', 'Us', ?, ?)`).run(at, at);
    const own = [name('a'), name('b'), name('c'), name('d')];
    own.forEach((one, position) =>
      db.prepare('INSERT INTO photo_album_items (album_id, media_name, position, added_at) VALUES (?, ?, ?, ?)').run('0123456789abcdef', one, position, at),
    );
    mkdirSync(join(dataDir, 'media'), { recursive: true });
    writeFileSync(join(dataDir, 'media', name('a')), png(30, 60)); // portrait
    writeFileSync(join(dataDir, 'media', name('b')), png(60, 30)); // landscape
    writeFileSync(join(dataDir, 'media', name('c')), Buffer.from('broken')); // not a picture
    // d has no copy here.
    db.prepare(`INSERT INTO immich_sources (id, kind, ref, name, created_at, updated_at) VALUES ('s1', 'favourites', NULL, 'Faves', ?, ?)`).run(at, at);
    db.prepare(`INSERT INTO immich_assets (handle, source_id, asset_id, position) VALUES (?, 's1', 'x', 0)`).run(name('e', 'jpg'));
    mkdirSync(join(dataDir, 'immich-cache'), { recursive: true });
    writeFileSync(join(dataDir, 'immich-cache', name('e', 'jpg')), png(20, 50));
    db.prepare(
      `INSERT INTO photo_folders (id, name, url_encrypted, host, created_at, updated_at) VALUES ('f1', 'NAS', 'sealed', 'nas', ?, ?)`,
    ).run(at, at);
    db.prepare(`INSERT INTO photo_folder_assets (handle, folder_id, path, position) VALUES (?, 'f1', '/p.jpg', 0)`).run(name('f', 'jpg'));
    mkdirSync(join(dataDir, 'photo-folder-cache'), { recursive: true });
    writeFileSync(join(dataDir, 'photo-folder-cache', name('f', 'jpg')), png(20, 50));

    expect(measureKeptShapes(db, dataDir, at)).toBe(4);
    expect([...portraitHandles(db)].sort()).toEqual([name('a'), name('e', 'jpg'), name('f', 'jpg')]);
    // Measured once: a second run reads nothing.
    expect(measureKeptShapes(db, dataDir, at)).toBe(0);
    // A guess for a measured photo is ignored; d arrives and is measured on the next run.
    writeFileSync(join(dataDir, 'media', name('d')), png(10, 40));
    expect(measureKeptShapes(db, dataDir, at)).toBe(1);

    const albums = readAlbumSlides(db);
    expect(albums.find((one) => one.id === '0123456789abcdef')?.portraits).toEqual([name('a'), name('d')]);
    expect(albums.find((one) => one.id === 's1')?.portraits).toEqual([name('e', 'jpg')]);
    expect(albums.find((one) => one.id === 'f1')?.portraits).toEqual([name('f', 'jpg')]);
  });
});

describe('the manifest', () => {
  const albums = [{ id: '0123456789abcdef', name: 'Us', photos: [name('a'), name('b')], portraits: [name('a')] }];

  it('names the portraits only for a widget that pairs them, and only when there are any', () => {
    expect(displayConfig('image', { album: '0123456789abcdef', pairPortraits: true }, [], albums)).toEqual({
      pairPortraits: true,
      slides: [name('a'), name('b')],
      albumName: 'Us',
      portraits: [name('a')],
    });
    // Not pairing: exactly what every slideshow sent before this.
    expect(displayConfig('image', { album: '0123456789abcdef' }, [], albums)).toEqual({ slides: [name('a'), name('b')], albumName: 'Us' });
    // Pairing with no portrait known: no empty list either.
    expect(displayConfig('image', { album: '0123456789abcdef', pairPortraits: true }, [], [{ ...albums[0]!, portraits: [] }])).toEqual({
      pairPortraits: true,
      slides: [name('a'), name('b')],
      albumName: 'Us',
    });
  });

  it('takes the switch as a boolean and refuses anything else', () => {
    const ok = (config: unknown): boolean => widgetConfigBody.safeParse(config).success;
    expect(ok({ pairPortraits: true })).toBe(true);
    expect(ok({ pairPortraits: false })).toBe(true);
    expect(ok({ pairPortraits: 'yes' })).toBe(false);
    expect(ok({ pairPortraits: 1 })).toBe(false);
  });
});

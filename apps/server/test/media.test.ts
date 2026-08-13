import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { isStoredName, listImages, mediaDir, readImage, sniffImage, storeImage } from '../src/api/media.js';

/**
 * Uploaded images.
 *
 * This is the only place the product takes a file from a person and hands it
 * back to a browser, so most of these are about what must not happen.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratch() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-media-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return { db, dataDir };
}

/** Real headers, so the sniffer is tested against what it will actually meet. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0), Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64, 2),
]);

describe('listImages (RFC 005 Phase 3b)', () => {
  it('lists the images of a usage, newest first, and keeps usages apart', () => {
    const { db, dataDir } = scratch();
    const bg1 = storeImage(db, dataDir, PNG, 'wall.png', 'background');
    const bg2 = storeImage(db, dataDir, JPEG, 'photo.jpg', 'background');
    storeImage(db, dataDir, GIF, 'face.gif', 'avatar');
    expect(bg1.ok && bg2.ok).toBe(true);

    const backgrounds = listImages(db, 'background');
    // Both backgrounds, and no avatar among them.
    expect(backgrounds.map((i) => i.originalName).sort()).toEqual(['photo.jpg', 'wall.png']);
    // Every listed name is a stored name (a hash, never a filename).
    expect(backgrounds.every((i) => isStoredName(i.name))).toBe(true);
    expect(listImages(db, 'avatar').map((i) => i.originalName)).toEqual(['face.gif']);
  });
});

describe('sniffing', () => {
  it('recognises the formats a wall can draw', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpeg');
    expect(sniffImage(GIF)).toBe('gif');
    expect(sniffImage(WEBP)).toBe('webp');
  });

  it('refuses SVG, which is a script container wearing an image costume', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );
    expect(sniffImage(svg)).toBeUndefined();
  });

  it('refuses a file that only claims to be an image', () => {
    // The extension and the Content-Type are both claims by the uploader.
    expect(sniffImage(Buffer.from('GIF87a is a nice format', 'utf8').subarray(0, 4))).toBeUndefined();
    expect(sniffImage(Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('storing', () => {
  it('names the file from its contents, never from the upload', () => {
    // A name is the classic way out of a directory.
    const { db, dataDir } = scratch();
    const result = storeImage(db, dataDir, PNG, '../../../../etc/passwd');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.name).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(readdirSync(mediaDir(dataDir))).toEqual([result.name]);
  });

  it('stores the same picture once', () => {
    const { db, dataDir } = scratch();
    const first = storeImage(db, dataDir, PNG, 'a.png');
    const second = storeImage(db, dataDir, PNG, 'again.png');
    expect(second).toMatchObject({ ok: true, reused: true });
    if (first.ok && second.ok) expect(second.name).toBe(first.name);
    expect(readdirSync(mediaDir(dataDir))).toHaveLength(1);
  });

  it('refuses something that is not an image, and says what is accepted', () => {
    const { db, dataDir } = scratch();
    const result = storeImage(db, dataDir, Buffer.from('<svg><script/></svg>'), 'nice.png');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.suggestion).toContain('SVG');
  });

  it('refuses a file too big for a wall to want', () => {
    const { db, dataDir } = scratch();
    const huge = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
    const result = storeImage(db, dataDir, huge, 'holiday.png');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('2 MB');
  });

  it('records what it stored, for the media table to be useful later', () => {
    const { db, dataDir } = scratch();
    storeImage(db, dataDir, JPEG, 'sam.jpg', 'avatar');
    expect(db.prepare('SELECT mime_type AS m, usage AS u FROM media_assets').get()).toEqual({
      m: 'image/jpeg',
      u: 'avatar',
    });
  });
});

describe('reading back', () => {
  it('serves the type the bytes actually are', () => {
    const { db, dataDir } = scratch();
    const stored = storeImage(db, dataDir, GIF, 'x.gif');
    if (!stored.ok) throw new Error('setup');
    expect(readImage(dataDir, stored.name)?.contentType).toBe('image/gif');
  });

  it('will not read a name that is not one it wrote', () => {
    const { dataDir } = scratch();
    for (const name of [
      '../../../etc/passwd',
      '../.secret',
      'wall.db',
      'abc.png',
      'a'.repeat(64) + '.svg',
      '',
    ]) {
      expect(isStoredName(name)).toBe(false);
      expect(readImage(dataDir, name)).toBeUndefined();
    }
  });

  it('refuses a stored file whose bytes stopped being an image', () => {
    // Belt and braces: if something ever wrote into the media directory, the
    // read path still asks the bytes rather than the filename.
    const { dataDir } = scratch();
    mkdirSync(mediaDir(dataDir), { recursive: true });
    const name = `${'a'.repeat(64)}.png`;
    writeFileSync(join(mediaDir(dataDir), name), '<svg><script>alert(1)</script></svg>');
    expect(readImage(dataDir, name)).toBeUndefined();
  });
});

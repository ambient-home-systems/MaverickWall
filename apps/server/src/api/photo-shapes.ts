import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDatabase } from '../db/open.js';
import { imageSize, type ImageSize } from './image-size.js';

/**
 * Which slideshow photos are portrait (plan item M3.7).
 *
 * A wall pairs two portrait photos side by side in a wide box, and it has to
 * know which photos are portrait before it asks for any of them, so the shape
 * is kept here by handle and sent with the album. It comes from two places:
 *
 * - **the picture's own header**, read from the copy this box keeps — an
 *   upload in the media store, an Immich preview or a folder photo in its
 *   cache, which both sources fetch ahead a few at a time — with a JPEG's EXIF
 *   orientation applied, because that is how a browser draws it;
 * - **Immich's own width and height**, as a first guess at sync, so an Immich
 *   album pairs before its previews have all been fetched.
 *
 * A measurement replaces a guess and a guess never replaces a measurement. A
 * photo with no shape yet is shown on its own, as every slideshow was before.
 */

/** Enough of a file for any header this reads: a JPEG's EXIF block, thumbnail and all, ends well before. */
const HEADER_BYTES = 128 * 1024;

export function recordShape(db: SqliteDatabase, handle: string, size: ImageSize, measured: boolean, at: number): void {
  db.prepare(
    `INSERT INTO photo_shapes (handle, width, height, measured, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET width = excluded.width, height = excluded.height,
       measured = excluded.measured, updated_at = excluded.updated_at
     WHERE photo_shapes.measured = 0 OR excluded.measured = 1`,
  ).run(handle, size.width, size.height, measured ? 1 : 0, at);
}

/** The photos taller than they are wide, of every photo whose shape is known. */
export function portraitHandles(db: SqliteDatabase): ReadonlySet<string> {
  const rows = db.prepare('SELECT handle FROM photo_shapes WHERE height > width').all() as { handle: string }[];
  return new Set(rows.map((row) => row.handle));
}

/** The first bytes of a file, or nothing. */
function head(path: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Measure every slideshow photo this box keeps a copy of and has not measured.
 *
 * Run at boot, after each Immich and folder sync has fetched ahead, and after
 * photos are uploaded to an album. A photo whose copy is not here yet is
 * measured on a later run, once it is. Answers how many were measured.
 */
export function measureKeptShapes(db: SqliteDatabase, dataDir: string, at: number): number {
  const measured = new Set(
    (db.prepare('SELECT handle FROM photo_shapes WHERE measured = 1').all() as { handle: string }[]).map((row) => row.handle),
  );
  const wanted: { handle: string; dir: string }[] = [
    ...(db.prepare('SELECT DISTINCT media_name AS handle FROM photo_album_items').all() as { handle: string }[]).map((row) => ({
      handle: row.handle,
      dir: 'media',
    })),
    ...(db.prepare('SELECT DISTINCT handle FROM immich_assets').all() as { handle: string }[]).map((row) => ({
      handle: row.handle,
      dir: 'immich-cache',
    })),
    ...(db.prepare('SELECT DISTINCT handle FROM photo_folder_assets').all() as { handle: string }[]).map((row) => ({
      handle: row.handle,
      dir: 'photo-folder-cache',
    })),
  ];
  let count = 0;
  for (const { handle, dir } of wanted) {
    if (measured.has(handle)) continue;
    const path = join(dataDir, dir, handle);
    if (!existsSync(path)) continue;
    const bytes = head(path);
    const size = bytes === undefined ? undefined : imageSize(bytes);
    if (size === undefined) continue;
    recordShape(db, handle, size, true, at);
    measured.add(handle);
    count++;
  }
  return count;
}

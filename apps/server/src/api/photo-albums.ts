import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SqliteDatabase } from '../db/open.js';
import { isStoredName, mediaDir } from './media.js';

/**
 * The household's photo albums (plan item M3.1).
 *
 * An album is a name and an ordered list of files in the media store. The
 * files themselves are the media store's — sniffed, deduplicated by hash and
 * named by it (`media.ts`) — so the same photo in two albums is one file, and
 * nothing here ever handles a name an uploader wrote.
 *
 * **A file leaves the disk only when nothing names it.** Taking a photo out of
 * an album, or deleting the album, would otherwise leave every removed photo on
 * a Raspberry Pi's SD card for ever; deleting it outright would take the same
 * photo off a wall that uses it as a background or an avatar. So `forgetIfUnused`
 * deletes a `photo` file only when no text column in any table holds its name —
 * a 64-character hash cannot match by accident, and asking every column rather
 * than a list of the ones known to hold image names is what keeps the next
 * feature that stores one from being the one this forgot.
 */

/** Enough for a family's holidays, few enough that the album page stays one page. */
export const MAX_PHOTOS_PER_ALBUM = 500;
export const MAX_ALBUMS = 50;

export interface AlbumSummary {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  /** The first photo's stored name, for a thumbnail; null for an empty album. */
  readonly cover: string | null;
}

export interface AlbumPhoto {
  readonly name: string;
  readonly originalName: string | null;
}

export interface Album {
  readonly id: string;
  readonly name: string;
  readonly photos: readonly AlbumPhoto[];
}

export function readAlbums(db: SqliteDatabase): AlbumSummary[] {
  return db
    .prepare(
      `SELECT a.id, a.name,
              (SELECT count(*) FROM photo_album_items i WHERE i.album_id = a.id) AS count,
              (SELECT i.media_name FROM photo_album_items i WHERE i.album_id = a.id
                ORDER BY i.position LIMIT 1) AS cover
         FROM photo_albums a ORDER BY a.name COLLATE NOCASE, a.created_at`,
    )
    .all() as AlbumSummary[];
}

export function readAlbum(db: SqliteDatabase, id: string): Album | undefined {
  const album = db.prepare('SELECT id, name FROM photo_albums WHERE id = ?').get(id) as
    | { id: string; name: string }
    | undefined;
  if (album === undefined) return undefined;
  const photos = db
    .prepare(
      `SELECT i.media_name AS name, m.original_name AS originalName
         FROM photo_album_items i LEFT JOIN media_assets m ON m.path = i.media_name
        WHERE i.album_id = ? ORDER BY i.position`,
    )
    .all(id) as AlbumPhoto[];
  return { ...album, photos };
}

export type AlbumResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

export function createAlbum(db: SqliteDatabase, name: string, at: number): AlbumResult {
  const count = (db.prepare('SELECT count(*) AS n FROM photo_albums').get() as { n: number }).n;
  if (count >= MAX_ALBUMS) {
    return { ok: false, message: `There are already ${MAX_ALBUMS} albums. Delete one you no longer use first.` };
  }
  const id = randomBytes(8).toString('hex');
  db.prepare('INSERT INTO photo_albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, at, at);
  return { ok: true, id };
}

export function renameAlbum(db: SqliteDatabase, id: string, name: string, at: number): boolean {
  return db.prepare('UPDATE photo_albums SET name = ?, updated_at = ? WHERE id = ?').run(name, at, id).changes > 0;
}

export type AddPhotoResult =
  | { readonly ok: true; readonly added: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Put a stored file at the end of an album. A photo already in it is not
 * added twice, and says so rather than failing: uploading the same picture
 * again is the commonest way to try.
 */
export function addPhoto(db: SqliteDatabase, albumId: string, mediaName: string, at: number): AddPhotoResult {
  if (!isStoredName(mediaName)) return { ok: false, message: 'That is not a stored picture.' };
  const count = (db.prepare('SELECT count(*) AS n FROM photo_album_items WHERE album_id = ?').get(albumId) as {
    n: number;
  }).n;
  const already = db
    .prepare('SELECT 1 FROM photo_album_items WHERE album_id = ? AND media_name = ?')
    .get(albumId, mediaName);
  if (already !== undefined) return { ok: true, added: false };
  if (count >= MAX_PHOTOS_PER_ALBUM) {
    return { ok: false, message: `This album already holds ${MAX_PHOTOS_PER_ALBUM} photos. Start another for the rest.` };
  }
  const last = db.prepare('SELECT max(position) AS p FROM photo_album_items WHERE album_id = ?').get(albumId) as {
    p: number | null;
  };
  db.prepare(
    'INSERT INTO photo_album_items (album_id, media_name, position, added_at) VALUES (?, ?, ?, ?)',
  ).run(albumId, mediaName, (last.p ?? -1) + 1, at);
  db.prepare('UPDATE photo_albums SET updated_at = ? WHERE id = ?').run(at, albumId);
  return { ok: true, added: true };
}

/** Take one photo out of an album; the file goes too if nothing else names it. */
export function removePhoto(db: SqliteDatabase, dataDir: string, albumId: string, mediaName: string): boolean {
  const removed =
    db.prepare('DELETE FROM photo_album_items WHERE album_id = ? AND media_name = ?').run(albumId, mediaName)
      .changes > 0;
  if (removed) forgetIfUnused(db, dataDir, mediaName);
  return removed;
}

/** Delete an album and its list; each file goes too if nothing else names it. */
export function deleteAlbum(db: SqliteDatabase, dataDir: string, albumId: string): boolean {
  const names = (db.prepare('SELECT media_name AS name FROM photo_album_items WHERE album_id = ?').all(albumId) as {
    name: string;
  }[]).map((row) => row.name);
  const gone = db.transaction(() => {
    db.prepare('DELETE FROM photo_album_items WHERE album_id = ?').run(albumId);
    return db.prepare('DELETE FROM photo_albums WHERE id = ?').run(albumId).changes > 0;
  })();
  for (const name of names) forgetIfUnused(db, dataDir, name);
  return gone;
}

/**
 * Delete a photo's file and its row when no table still names it.
 *
 * Only a file uploaded as a photo: an avatar or a canvas background is the
 * media store's other users', and this module does not decide for them. Every
 * text column of every table is asked, the media store's own row aside.
 */
export function forgetIfUnused(db: SqliteDatabase, dataDir: string, mediaName: string): boolean {
  if (!isStoredName(mediaName)) return false;
  const asset = db.prepare('SELECT usage FROM media_assets WHERE path = ?').get(mediaName) as
    | { usage: string }
    | undefined;
  if (asset?.usage !== 'photo') return false;
  if (isNamedAnywhere(db, mediaName)) return false;
  db.prepare('DELETE FROM media_assets WHERE path = ?').run(mediaName);
  rmSync(join(mediaDir(dataDir), mediaName), { force: true });
  return true;
}

function isNamedAnywhere(db: SqliteDatabase, mediaName: string): boolean {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name <> 'media_assets'`,
    )
    .all() as { name: string }[];
  for (const { name: table } of tables) {
    const columns = db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(table) as {
      name: string;
      type: string;
    }[];
    for (const column of columns) {
      if (!/text/i.test(column.type)) continue;
      const hit = db
        .prepare(`SELECT 1 FROM "${table.replace(/"/g, '""')}" WHERE "${column.name.replace(/"/g, '""')}" LIKE ? LIMIT 1`)
        .get(`%${mediaName}%`);
      if (hit !== undefined) return true;
    }
  }
  return false;
}

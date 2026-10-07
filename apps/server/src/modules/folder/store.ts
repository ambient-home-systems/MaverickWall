import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetcher, NetworkOption } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { sniffImage } from '../../api/media.js';
import { folderPolicy, folderUrl, listFolder, photoBytes, type FolderEndpoint } from './client.js';

/**
 * A NAS folder, as this application keeps it (plan item M3.3).
 *
 * Immich's arrangement (`modules/immich/store.ts`), one source along: a folder
 * is read before it is kept, its photos are kept as handles shaped like a
 * stored media name, a wall reaches them through `/d/media/`, and each is kept
 * on this box as it is first shown so a slideshow goes on turning with the NAS
 * asleep. What is different is only what a folder is: an address and,
 * usually, a username and password, each sealed.
 */

export interface FolderContext {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly dataDir: string;
  readonly now: number;
}

export interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly username: string | null;
  readonly subfolders: boolean;
  readonly count: number;
  readonly skippedHeic: number;
  readonly skippedRaw: number;
  readonly skippedLarge: number;
  readonly lastError: string | null;
}

export function readFolders(db: SqliteDatabase): FolderRow[] {
  return (db
    .prepare(
      `SELECT f.id, f.name, f.host, f.username, f.subfolders, f.skipped_heic AS skippedHeic, f.skipped_raw AS skippedRaw,
              f.skipped_large AS skippedLarge, f.last_error AS lastError,
              (SELECT count(*) FROM photo_folder_assets a WHERE a.folder_id = f.id) AS count
         FROM photo_folders f ORDER BY f.name COLLATE NOCASE, f.created_at`,
    )
    .all() as (Omit<FolderRow, 'subfolders'> & { subfolders: number })[]).map((row) => ({ ...row, subfolders: row.subfolders === 1 }));
}

/** The endpoint for a folder, with its address and password opened; nothing for one that cannot be. */
export function folderEndpoint(db: SqliteDatabase, keyring: Keyring, id: string): (FolderEndpoint & { subfolders: boolean }) | undefined {
  const row = db
    .prepare(
      `SELECT url_encrypted AS url, username, password_encrypted AS password, allow_lan AS allowLan, allow_http AS allowHttp,
              subfolders FROM photo_folders WHERE id = ?`,
    )
    .get(id) as
    | { url: string; username: string | null; password: string | null; allowLan: number; allowHttp: number; subfolders: number }
    | undefined;
  if (row === undefined) return undefined;
  const url = keyring.decrypt(row.url, 'photo-folder-url');
  if (!url.ok) return undefined;
  const password = row.password === null ? undefined : keyring.decrypt(row.password, 'photo-folder-password');
  if (password !== undefined && !password.ok) return undefined;
  return {
    url: url.value,
    ...(row.username === null ? {} : { username: row.username }),
    ...(password === undefined ? {} : { password: password.value }),
    policy: folderPolicy({ allowLan: row.allowLan === 1, allowHttp: row.allowHttp === 1 }),
    subfolders: row.subfolders === 1,
  };
}

export const MAX_FOLDERS = 20;

export interface AddFolderInput {
  readonly name: string;
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly allowLan: boolean;
  readonly allowHttp: boolean;
  readonly subfolders: boolean;
}

export type AddFolderResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly message: string; readonly switches?: readonly NetworkOption[] };

/**
 * Add a folder, read first: it is kept only once it has listed, so "Added" is
 * never said of a folder the NAS refused, and nothing typed is stored until
 * then.
 */
export async function addFolder(context: FolderContext, input: AddFolderInput): Promise<AddFolderResult> {
  const count = (context.db.prepare('SELECT count(*) AS n FROM photo_folders').get() as { n: number }).n;
  if (count >= MAX_FOLDERS) return { ok: false, message: `There are already ${MAX_FOLDERS} folders. Remove one first.` };
  const url = folderUrl(input.url);
  const endpoint: FolderEndpoint = {
    url,
    ...(input.username === undefined || input.username === '' ? {} : { username: input.username, password: input.password ?? '' }),
    policy: folderPolicy(input),
  };
  const listed = await listFolder(context.fetcher, endpoint, input.subfolders);
  if (!listed.ok) return { ok: false, message: listed.message, ...(listed.switches === undefined ? {} : { switches: listed.switches }) };
  const id = randomBytes(8).toString('hex');
  context.db
    .prepare(
      `INSERT INTO photo_folders (id, name, url_encrypted, host, username, password_encrypted, allow_lan, allow_http,
                                  subfolders, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.slice(0, 80),
      context.keyring.encrypt(url, 'photo-folder-url'),
      new URL(url).host,
      endpoint.username ?? null,
      endpoint.username === undefined ? null : context.keyring.encrypt(endpoint.password ?? '', 'photo-folder-password'),
      input.allowLan ? 1 : 0,
      input.allowHttp ? 1 : 0,
      input.subfolders ? 1 : 0,
      context.now,
      context.now,
    );
  keepListing(context, id, listed.value);
  return { ok: true, id };
}

export function folderHandle(folderId: string, path: string, etag: string | undefined): string {
  return `${createHash('sha256').update(`folder:${folderId}:${path}:${etag ?? ''}`).digest('hex')}.jpg`;
}

function keepListing(
  context: FolderContext,
  id: string,
  listing: { photos: readonly { path: string; etag: string | undefined }[]; heic: number; raw: number; tooLarge: number },
): void {
  context.db.transaction(() => {
    context.db.prepare('DELETE FROM photo_folder_assets WHERE folder_id = ?').run(id);
    const insert = context.db.prepare(
      'INSERT OR IGNORE INTO photo_folder_assets (handle, folder_id, path, position) VALUES (?, ?, ?, ?)',
    );
    listing.photos.forEach((photo, position) => insert.run(folderHandle(id, photo.path, photo.etag), id, photo.path, position));
    context.db
      .prepare(
        `UPDATE photo_folders SET skipped_heic = ?, skipped_raw = ?, skipped_large = ?, last_fetched_at = ?,
                last_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(listing.heic, listing.raw, listing.tooLarge, context.now, context.now, id);
  })();
  pruneFolderCache(context.db, context.dataDir);
}

/** Re-read a folder; a failure keeps the last good list and records why. */
export async function syncFolder(context: FolderContext, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const endpoint = folderEndpoint(context.db, context.keyring, id);
  if (endpoint === undefined) return { ok: false, message: 'That folder could not be opened. Remove it and add it again.' };
  const listed = await listFolder(context.fetcher, endpoint, endpoint.subfolders);
  if (!listed.ok) {
    context.db.prepare('UPDATE photo_folders SET last_error = ?, updated_at = ? WHERE id = ?').run(listed.message, context.now, id);
    return { ok: false, message: listed.message };
  }
  keepListing(context, id, listed.value);
  return { ok: true };
}

export function removeFolder(db: SqliteDatabase, dataDir: string, id: string): boolean {
  const gone = db.transaction(() => {
    db.prepare('DELETE FROM photo_folder_assets WHERE folder_id = ?').run(id);
    return db.prepare('DELETE FROM photo_folders WHERE id = ?').run(id).changes > 0;
  })();
  if (gone) pruneFolderCache(db, dataDir);
  return gone;
}

/** Every folder as the slideshow's albums see one. */
export function readFolderSlides(db: SqliteDatabase): { id: string; name: string; photos: string[] }[] {
  const folders = readFolders(db);
  const handles = db
    .prepare('SELECT folder_id AS folderId, handle FROM photo_folder_assets ORDER BY position')
    .all() as { folderId: string; handle: string }[];
  return folders.map((folder) => ({
    id: folder.id,
    name: `${folder.name} (folder)`,
    photos: handles.filter((row) => row.folderId === folder.id).map((row) => row.handle),
  }));
}

function cacheDir(dataDir: string): string {
  return join(dataDir, 'photo-folder-cache');
}

const HANDLE = /^[a-f0-9]{64}\.jpg$/;
const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

/** One folder photo by its handle: this box's copy, or fetched, sniffed and kept. A handle no folder names is nothing. */
export async function folderPhoto(
  context: Omit<FolderContext, 'now'>,
  handle: string,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  if (!HANDLE.test(handle)) return undefined;
  const row = context.db.prepare('SELECT folder_id AS folderId, path FROM photo_folder_assets WHERE handle = ? LIMIT 1').get(handle) as
    | { folderId: string; path: string }
    | undefined;
  if (row === undefined) return undefined;
  const file = join(cacheDir(context.dataDir), handle);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    const kind = sniffImage(bytes);
    if (kind !== undefined) return { bytes, contentType: CONTENT_TYPES[kind] };
  }
  const endpoint = folderEndpoint(context.db, context.keyring, row.folderId);
  if (endpoint === undefined) return undefined;
  const fetched = await photoBytes(context.fetcher, endpoint, row.path);
  if (!fetched.ok) return undefined;
  const kind = sniffImage(fetched.value);
  if (kind === undefined) return undefined;
  mkdirSync(cacheDir(context.dataDir), { recursive: true });
  writeFileSync(file, fetched.value);
  return { bytes: fetched.value, contentType: CONTENT_TYPES[kind] };
}

export async function prefetchFolders(context: Omit<FolderContext, 'now'>, limit: number): Promise<number> {
  const dir = cacheDir(context.dataDir);
  const handles = (context.db.prepare('SELECT DISTINCT handle FROM photo_folder_assets').all() as { handle: string }[]).map((row) => row.handle);
  let fetched = 0;
  for (const handle of handles) {
    if (fetched >= limit) break;
    if (existsSync(join(dir, handle))) continue;
    if ((await folderPhoto(context, handle)) !== undefined) fetched++;
    else break;
  }
  return fetched;
}

export function pruneFolderCache(db: SqliteDatabase, dataDir: string): void {
  const dir = cacheDir(dataDir);
  if (!existsSync(dir)) return;
  const kept = new Set((db.prepare('SELECT DISTINCT handle FROM photo_folder_assets').all() as { handle: string }[]).map((row) => row.handle));
  for (const name of readdirSync(dir)) if (!kept.has(name)) rmSync(join(dir, name), { force: true });
}

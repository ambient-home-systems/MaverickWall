import { createHash, randomBytes } from 'node:crypto';
import { recordShape } from '../../api/photo-shapes.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetcher, NetworkOption } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { sniffImage } from '../../api/media.js';
import {
  immichBase,
  immichPolicy,
  memoryPhotos,
  type ImmichShapes,
  previewBytes,
  searchPhotos,
  whoAmI,
  type ImmichEndpoint,
} from './client.js';

/**
 * Immich, as this application keeps it (plan item M3.2).
 *
 * One connection, with its key sealed under `immich-key` and opened only to
 * make a request. What the household chose to show — an album, a person, their
 * favourites, the day's memories — is a *source*, and each source's photos are
 * kept as handles: the hash of the asset id, shaped like a stored media name,
 * so a wall reaches an Immich photo through `/d/media/` exactly as it reaches
 * one of the household's own, and never learns Immich's address or an id.
 *
 * Photos are cached on this box as they are first shown and as the sync job
 * fetches ahead, so a wall goes on turning through the photos it has when
 * Immich is down (rule nine). The cache holds only what some source still
 * names: a sync that drops a photo deletes its copy.
 */

export interface ImmichContext {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly dataDir: string;
  readonly now: number;
}

export interface ImmichConnectionRow {
  readonly baseUrl: string;
  readonly host: string;
  readonly allowLan: boolean;
  readonly allowHttp: boolean;
  readonly accountLabel: string | null;
  readonly lastError: string | null;
}

export function readImmichConnection(db: SqliteDatabase): ImmichConnectionRow | undefined {
  const row = db
    .prepare(
      `SELECT base_url AS baseUrl, allow_lan AS allowLan, allow_http AS allowHttp, account_label AS accountLabel,
              last_error AS lastError
         FROM immich_connection WHERE id = 'immich'`,
    )
    .get() as { baseUrl: string; allowLan: number; allowHttp: number; accountLabel: string | null; lastError: string | null } | undefined;
  if (row === undefined) return undefined;
  let host = '';
  try {
    host = new URL(row.baseUrl).host;
  } catch {
    host = '';
  }
  return { ...row, host, allowLan: row.allowLan === 1, allowHttp: row.allowHttp === 1 };
}

/** The endpoint a request is made to, with the key opened; nothing when there is no connection. */
export function immichEndpoint(db: SqliteDatabase, keyring: Keyring): ImmichEndpoint | undefined {
  const row = db
    .prepare(`SELECT base_url AS base, api_key_encrypted AS sealed, allow_lan AS allowLan, allow_http AS allowHttp FROM immich_connection WHERE id = 'immich'`)
    .get() as { base: string; sealed: string; allowLan: number; allowHttp: number } | undefined;
  if (row === undefined) return undefined;
  const key = keyring.decrypt(row.sealed, 'immich-key');
  if (!key.ok) return undefined;
  return { base: row.base, key: key.value, policy: immichPolicy({ allowLan: row.allowLan === 1, allowHttp: row.allowHttp === 1 }) };
}

export type ConnectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly switches?: readonly NetworkOption[] };

/**
 * Connect, or replace the connection: the key is used before it is stored,
 * so "Connected" is never said of one Immich refused.
 */
export async function connectImmich(
  context: ImmichContext,
  input: { readonly url: string; readonly key: string; readonly allowLan: boolean; readonly allowHttp: boolean },
): Promise<ConnectResult> {
  const base = immichBase(input.url);
  const endpoint: ImmichEndpoint = { base, key: input.key, policy: immichPolicy(input) };
  const who = await whoAmI(context.fetcher, endpoint);
  if (!who.ok) return { ok: false, message: who.message, ...(who.switches === undefined ? {} : { switches: who.switches }) };
  context.db
    .prepare(
      `INSERT INTO immich_connection (id, base_url, api_key_encrypted, allow_lan, allow_http, account_label, last_error,
                                      created_at, updated_at)
       VALUES ('immich', ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, api_key_encrypted = excluded.api_key_encrypted,
         allow_lan = excluded.allow_lan, allow_http = excluded.allow_http, account_label = excluded.account_label,
         last_error = NULL, updated_at = excluded.updated_at`,
    )
    .run(
      base,
      context.keyring.encrypt(input.key, 'immich-key'),
      input.allowLan ? 1 : 0,
      input.allowHttp ? 1 : 0,
      who.value === '' ? null : who.value,
      context.now,
      context.now,
    );
  return { ok: true };
}

/** Forget Immich: the connection, every source, every handle and every cached photo. */
export function disconnectImmich(db: SqliteDatabase, dataDir: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM immich_assets').run();
    db.prepare('DELETE FROM immich_sources').run();
    db.prepare(`DELETE FROM immich_connection WHERE id = 'immich'`).run();
  })();
  rmSync(cacheDir(dataDir), { recursive: true, force: true });
}

export type ImmichSourceKind = 'album' | 'person' | 'favourites' | 'memories';

export interface ImmichSourceRow {
  readonly id: string;
  readonly kind: ImmichSourceKind;
  readonly ref: string | null;
  readonly name: string;
  readonly count: number;
  readonly lastFetchedAt: number | null;
  readonly lastError: string | null;
}

export function readImmichSources(db: SqliteDatabase): ImmichSourceRow[] {
  return db
    .prepare(
      `SELECT s.id, s.kind, s.ref, s.name, s.last_fetched_at AS lastFetchedAt, s.last_error AS lastError,
              (SELECT count(*) FROM immich_assets a WHERE a.source_id = s.id) AS count
         FROM immich_sources s ORDER BY s.name COLLATE NOCASE, s.created_at`,
    )
    .all() as ImmichSourceRow[];
}

/** At most this many sources: enough for every album a household would put on a wall. */
export const MAX_IMMICH_SOURCES = 20;

export function addImmichSource(
  db: SqliteDatabase,
  source: { readonly kind: ImmichSourceKind; readonly ref: string | null; readonly name: string },
  at: number,
): { ok: true; id: string } | { ok: false; message: string } {
  const count = (db.prepare('SELECT count(*) AS n FROM immich_sources').get() as { n: number }).n;
  if (count >= MAX_IMMICH_SOURCES) return { ok: false, message: `There are already ${MAX_IMMICH_SOURCES} from Immich. Remove one first.` };
  const same = db
    .prepare('SELECT id FROM immich_sources WHERE kind = ? AND ref IS ?')
    .get(source.kind, source.ref) as { id: string } | undefined;
  if (same !== undefined) return { ok: false, message: 'That is already here.' };
  const id = randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO immich_sources (id, kind, ref, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, source.kind, source.ref, source.name.slice(0, 120), at, at);
  return { ok: true, id };
}

export function removeImmichSource(db: SqliteDatabase, dataDir: string, id: string): boolean {
  const gone = db.transaction(() => {
    db.prepare('DELETE FROM immich_assets WHERE source_id = ?').run(id);
    return db.prepare('DELETE FROM immich_sources WHERE id = ?').run(id).changes > 0;
  })();
  if (gone) pruneCache(db, dataDir);
  return gone;
}

/** The handle a wall knows an Immich photo by: the asset id's hash, shaped like a stored name. */
export function immichHandle(assetId: string): string {
  return `${createHash('sha256').update(`immich:${assetId}`).digest('hex')}.jpg`;
}

/**
 * Read a source's photos from Immich and replace what is kept for it.
 *
 * A failure keeps the last good list and records the sentence, so a wall goes
 * on turning through the photos it has; "Immich could not be reached" is said
 * on the Photos screen, never by a wall going blank.
 */
export async function syncImmichSource(
  context: ImmichContext,
  sourceId: string,
  today: string,
): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  const source = context.db
    .prepare('SELECT kind, ref FROM immich_sources WHERE id = ?')
    .get(sourceId) as { kind: ImmichSourceKind; ref: string | null } | undefined;
  if (source === undefined) return { ok: false, message: 'That is not here any more.' };
  const endpoint = immichEndpoint(context.db, context.keyring);
  if (endpoint === undefined) return { ok: false, message: 'Immich is not connected.' };
  const shapes: ImmichShapes = new Map();
  const read =
    source.kind === 'memories'
      ? await memoryPhotos(context.fetcher, endpoint, today, shapes)
      : await searchPhotos(
          context.fetcher,
          endpoint,
          source.kind === 'album'
            ? { albumIds: [source.ref ?? ''] }
            : source.kind === 'person'
              ? { personIds: [source.ref ?? ''] }
              : { isFavorite: true },
          shapes,
        );
  if (!read.ok) {
    context.db.prepare('UPDATE immich_sources SET last_error = ?, updated_at = ? WHERE id = ?').run(read.message, context.now, sourceId);
    return { ok: false, message: read.message };
  }
  context.db.transaction(() => {
    context.db.prepare('DELETE FROM immich_assets WHERE source_id = ?').run(sourceId);
    const insert = context.db.prepare(
      'INSERT OR IGNORE INTO immich_assets (handle, source_id, asset_id, position) VALUES (?, ?, ?, ?)',
    );
    read.value.forEach((assetId, position) => insert.run(immichHandle(assetId), sourceId, assetId, position));
    // Immich's own sizes, as a guess until each preview is measured (plan item M3.7).
    for (const [assetId, size] of shapes) recordShape(context.db, immichHandle(assetId), size, false, context.now);
    context.db
      .prepare('UPDATE immich_sources SET last_fetched_at = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(context.now, context.now, sourceId);
  })();
  pruneCache(context.db, context.dataDir);
  return { ok: true, count: read.value.length };
}

/** Every source as the slideshow's albums see one: an id, a name and its photos' handles in order. */
export function readImmichSlides(db: SqliteDatabase): { id: string; name: string; photos: string[] }[] {
  const sources = readImmichSources(db);
  const handles = db
    .prepare('SELECT source_id AS sourceId, handle FROM immich_assets ORDER BY position')
    .all() as { sourceId: string; handle: string }[];
  return sources.map((source) => ({
    id: source.id,
    name: `${source.name} (Immich)`,
    photos: handles.filter((row) => row.sourceId === source.id).map((row) => row.handle),
  }));
}

function cacheDir(dataDir: string): string {
  return join(dataDir, 'immich-cache');
}

const HANDLE = /^[a-f0-9]{64}\.jpg$/;

/**
 * One Immich photo by its handle: from this box's copy when there is one,
 * otherwise fetched, checked to be a picture this wall draws, and kept.
 *
 * A handle no source names is nothing, so a wall cannot reach an Immich photo
 * the household has not chosen to show by guessing at one.
 */
export async function immichPhoto(
  context: Omit<ImmichContext, 'now'>,
  handle: string,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  if (!HANDLE.test(handle)) return undefined;
  const row = context.db.prepare('SELECT asset_id AS assetId FROM immich_assets WHERE handle = ? LIMIT 1').get(handle) as
    | { assetId: string }
    | undefined;
  if (row === undefined) return undefined;
  const path = join(cacheDir(context.dataDir), handle);
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    const kind = sniffImage(bytes);
    if (kind !== undefined) return { bytes, contentType: CONTENT_TYPES[kind] };
  }
  const endpoint = immichEndpoint(context.db, context.keyring);
  if (endpoint === undefined) return undefined;
  const fetched = await previewBytes(context.fetcher, endpoint, row.assetId);
  if (!fetched.ok) return undefined;
  // Sniffed, as every picture this application serves is: what Immich says
  // it sent is a claim, and an SVG would be a script.
  const kind = sniffImage(fetched.value);
  if (kind === undefined) return undefined;
  mkdirSync(cacheDir(context.dataDir), { recursive: true });
  writeFileSync(path, fetched.value);
  return { bytes: fetched.value, contentType: CONTENT_TYPES[kind] };
}

const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

/** Fetch ahead the photos not yet kept, a few per run, so a wall has them before Immich is next down. */
export async function prefetchImmich(context: Omit<ImmichContext, 'now'>, limit: number): Promise<number> {
  const dir = cacheDir(context.dataDir);
  const handles = (context.db.prepare('SELECT DISTINCT handle FROM immich_assets').all() as { handle: string }[]).map(
    (row) => row.handle,
  );
  let fetched = 0;
  for (const handle of handles) {
    if (fetched >= limit) break;
    if (existsSync(join(dir, handle))) continue;
    if ((await immichPhoto(context, handle)) !== undefined) fetched++;
    else break;
  }
  return fetched;
}

/** Delete the copies no source names any more. */
export function pruneCache(db: SqliteDatabase, dataDir: string): void {
  const dir = cacheDir(dataDir);
  if (!existsSync(dir)) return;
  const kept = new Set((db.prepare('SELECT DISTINCT handle FROM immich_assets').all() as { handle: string }[]).map((row) => row.handle));
  for (const name of readdirSync(dir)) {
    if (!kept.has(name)) rmSync(join(dir, name), { force: true });
  }
}

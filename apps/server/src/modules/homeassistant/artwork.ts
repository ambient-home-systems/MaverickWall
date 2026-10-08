import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { sniffImage } from '../../api/media.js';
import { parseJsonOr, z } from '../../validation.js';
import { call, callPicture, resolveConnection } from './client.js';
import { pickAttributes, pictureKey } from './entities.js';

/**
 * Album art while music plays (plan item M3.4).
 *
 * An Image widget can name a media player the household watches on Home
 * Assistant's Readings screen. While that player is *playing* and has a
 * picture, the widget shows the picture; otherwise it shows its own picture or
 * album, or says nothing is playing. The player is read the way every reading
 * is — the half-minute poll — so this adds no request of its own until a wall
 * asks for the picture.
 *
 * **The picture is named by a key, never by its address.** Home Assistant's
 * `entity_picture` for a media player carries an access token, so the cache
 * holds its hash (`pictureKey`) and a wall is handed that hash as a handle
 * shaped like a stored media name. Asked for it, this asks Home Assistant for
 * the player's state *again*, live, and fetches the picture only when the live
 * address hashes to the handle: a stale handle, a guessed one, or one for a
 * player nobody chose serves nothing.
 *
 * A picture on Home Assistant itself (`/api/…`) is fetched with the house's
 * token through `callPicture`. One on a music service's own server (some
 * integrations hand over a `https://` address) is fetched with no credential,
 * through the guard at its default: public https only.
 */

/** The players that are playing and have a picture, as a handle each, by entity id. */
export function nowPlayingArt(db: SqliteDatabase): Readonly<Record<string, string>> {
  const rows = db
    .prepare(`SELECT entity_id AS entityId, state, attributes FROM ha_entity_cache WHERE watched = 1 AND entity_id LIKE 'media_player.%'`)
    .all() as { entityId: string; state: string | null; attributes: string | null }[];
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.state !== 'playing') continue;
    const attributes = pickAttributes('media_player', parseJsonOr(z.unknown(), row.attributes ?? '', undefined));
    if (attributes.picture_key !== undefined) out[row.entityId] = `${attributes.picture_key}.jpg`;
  }
  return out;
}

const HANDLE = /^[a-f0-9]{64}\.jpg$/;
const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;
const liveState = z.object({ state: z.string(), attributes: z.looseObject({ entity_picture: z.string().max(2000).optional().catch(undefined) }) });

function cacheDir(dataDir: string): string {
  return join(dataDir, 'art-cache');
}

/** A picture by its handle, for a wall: this box's copy, or asked of Home Assistant live and checked. */
export async function artworkPhoto(
  context: { readonly db: SqliteDatabase; readonly keyring: Keyring; readonly fetcher: Fetcher; readonly dataDir: string },
  handle: string,
): Promise<{ bytes: Buffer; contentType: string } | undefined> {
  if (!HANDLE.test(handle)) return undefined;
  const playing = nowPlayingArt(context.db);
  const entityId = Object.keys(playing).find((id) => playing[id] === handle);
  if (entityId === undefined) return undefined;
  const dir = cacheDir(context.dataDir);
  // Only the pictures playing now are kept: a song that has finished is not.
  if (existsSync(dir)) {
    const current = new Set(Object.values(playing));
    for (const name of readdirSync(dir)) if (!current.has(name)) rmSync(join(dir, name), { force: true });
  }
  const file = join(dir, handle);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    const kind = sniffImage(bytes);
    if (kind !== undefined) return { bytes, contentType: CONTENT_TYPES[kind] };
  }
  const resolved = resolveConnection(context.db, context.keyring);
  if (!resolved.ok) return undefined;
  const live = await call(context.fetcher, resolved.connection, `/states/${encodeURIComponent(entityId)}`);
  if (!live.ok) return undefined;
  const shaped = liveState.safeParse(parseJsonOr(z.unknown(), live.body, undefined));
  const picture = shaped.success ? shaped.data.attributes.entity_picture : undefined;
  if (picture === undefined || `${pictureKey(picture)}.jpg` !== handle) return undefined;
  let bytes: Buffer;
  if (picture.startsWith('/')) {
    const fetched = await callPicture(context.fetcher, resolved.connection, picture);
    if (!fetched.ok) return undefined;
    bytes = fetched.bytes;
  } else {
    // The guard at its default — `policy: {}` — is what refuses anything but
    // public https here, so there is no second check to keep in step with it.
    const outcome = await context.fetcher.fetch({
      url: picture,
      policy: {},
      maxBytes: FETCH_LIMITS.image,
      timeoutMs: 15_000,
      bodyEncoding: 'base64',
    });
    if (outcome.status !== 'ok') return undefined;
    bytes = Buffer.from(outcome.body, 'base64');
  }
  // Sniffed, as every picture this application serves is.
  const kind = sniffImage(bytes);
  if (kind === undefined) return undefined;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, bytes);
  return { bytes, contentType: CONTENT_TYPES[kind] };
}

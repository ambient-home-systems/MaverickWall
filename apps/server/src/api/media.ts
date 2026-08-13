import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Uploaded images.
 *
 * The first place this product takes a file from a person and serves it back,
 * which is a different kind of surface from everything else here. Three rules
 * follow from that, and none of them are negotiable:
 *
 *   1. **The type is sniffed, never believed.** A `Content-Type` header and a
 *      file extension are both claims made by whoever is uploading.
 *   2. **SVG is refused.** It is an image to a person and a script container to
 *      a browser, and served from this origin it would be stored XSS against
 *      the household's own admin session.
 *   3. **The stored name is ours.** Derived from the content hash, so nothing
 *      an uploader writes can reach the filesystem — a name is the classic way
 *      out of a directory.
 */

/** Enough for a photograph of a person, small enough not to fill an SD card. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp';

const CONTENT_TYPES: Readonly<Record<ImageKind, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const EXTENSIONS: Readonly<Record<ImageKind, string>> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
};

/**
 * What the bytes actually are.
 *
 * Magic numbers only. Undefined for anything not recognised, which includes
 * SVG — it has no magic number because it is text, and that is precisely the
 * reason it is not on this list.
 */
export function sniffImage(bytes: Buffer): ImageKind | undefined {
  if (bytes.length < 12) return undefined;

  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF87a') return 'gif';
  if (bytes.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return undefined;
}

export type StoreResult =
  | { readonly ok: true; readonly name: string; readonly reused: boolean }
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

export function mediaDir(dataDir: string): string {
  return join(dataDir, 'media');
}

/**
 * A stored file's name, which is the only shape this module will ever read.
 *
 * Sixty-four hex characters and a known extension. A traversal cannot be
 * spelled in that alphabet, so the check at read time is a pattern match
 * rather than a path comparison that has to be got right.
 */
const STORED_NAME = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

export function isStoredName(name: string): boolean {
  return STORED_NAME.test(name);
}

export function storeImage(
  db: SqliteDatabase,
  dataDir: string,
  bytes: Buffer,
  originalName: string,
  usage: 'avatar' | 'background' | 'other' = 'avatar',
): StoreResult {
  if (bytes.length === 0) return { ok: false, message: 'That file is empty.' };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: 'That image is larger than 2 MB.',
      suggestion: 'A photo straight from a phone is usually far bigger than a wall needs. Crop or shrink it first.',
    };
  }

  const kind = sniffImage(bytes);
  if (kind === undefined) {
    return {
      ok: false,
      message: 'That file is not an image this can use.',
      suggestion: 'PNG, JPEG, GIF or WebP. SVG is deliberately not accepted — it can carry code.',
    };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = `${sha256}.${EXTENSIONS[kind]}`;

  const existing = db.prepare('SELECT path FROM media_assets WHERE sha256 = ?').get(sha256) as
    | { path: string }
    | undefined;
  if (existing !== undefined) {
    // The same photo uploaded twice is stored once. Households re-upload the
    // same picture more often than anyone would guess.
    return { ok: true, name: existing.path, reused: true };
  }

  const directory = mediaDir(dataDir);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), bytes);

  const at = Date.now();
  db.prepare(
    `INSERT INTO media_assets (id, path, original_name, mime_type, byte_size, sha256, usage,
                               created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256.slice(0, 16), name, originalName.slice(0, 120), CONTENT_TYPES[kind], bytes.length, sha256, usage, at, at);

  return { ok: true, name, reused: false };
}

export interface MediaListItem {
  readonly name: string;
  readonly originalName: string;
}

/**
 * The stored images of a usage, newest first — for the editor's image picker
 * (RFC 005 Phase 3b). Only the stored name and the original filename; the bytes
 * are served separately, behind the session or a display token.
 */
export function listImages(
  db: SqliteDatabase,
  usage: 'avatar' | 'background' | 'other' = 'background',
): MediaListItem[] {
  return db
    .prepare(
      `SELECT path AS name, original_name AS originalName
         FROM media_assets WHERE usage = ? ORDER BY created_at DESC`,
    )
    .all(usage) as MediaListItem[];
}

export interface StoredImage {
  readonly bytes: Buffer;
  readonly contentType: string;
}

/** Read a stored image by its own name. Undefined for anything else. */
export function readImage(dataDir: string, name: string): StoredImage | undefined {
  if (!isStoredName(name)) return undefined;
  try {
    const bytes = readFileSync(join(mediaDir(dataDir), name));
    const kind = sniffImage(bytes);
    if (kind === undefined) return undefined;
    // Sniffed again on the way out rather than trusting what was recorded:
    // the answer that matters is what a browser will make of these bytes.
    return { bytes, contentType: CONTENT_TYPES[kind] };
  } catch {
    return undefined;
  }
}

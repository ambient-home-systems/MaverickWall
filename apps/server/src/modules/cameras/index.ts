import { randomBytes } from 'node:crypto';

import type { SqliteDatabase } from '../../db/open.js';
import { z } from '../../validation.js';
import type { ModuleContext, PanelModule } from '../registry.js';

/**
 * Cameras on the wall (plan item M6.1, RFC 007 Tier A): a Home Assistant
 * camera's latest picture, fetched by the server and refreshed every few
 * seconds in a box the household placed.
 *
 * **A camera is not a reading.** Everything in the Home Assistant module's
 * supported domains becomes a reading, and a camera's state — `idle`,
 * `recording` — said on a wall is `calendar`'s old mistake with a worse
 * picture (RFC 007 §6.1). So cameras are their own list, on a screen of their
 * own, and the readings are untouched.
 *
 * **The wall is given a handle, never an entity id** (rule 12). A handle is
 * minted here when a camera is added and resolved here when a wall asks for
 * the picture; the manifest, the widget's config and the address the wall
 * fetches carry only the handle. It is an identifier rather than a credential —
 * the wall's display token is the credential, and the route also requires the
 * camera to be placed on that wall — so a URL in a screenshot names nothing.
 *
 * **No job of its own.** Whether each camera is there is read out of the
 * `/api/states` body the Home Assistant poll already fetches every thirty
 * seconds (`readCameraStates`), so a camera costs no request until a wall asks
 * for its picture.
 */

export const CAMERAS_BLOCK = 'cameras';

/** A wall is not a security console, and the box this runs on is small. */
export const MAX_CAMERAS = 8;

/** A handle's shape: 32 random bytes, base64url, as a display token is minted. */
export const CAMERA_HANDLE = /^[A-Za-z0-9_-]{43}$/;

/** A camera entity id, by the shape Home Assistant gives one. */
export const CAMERA_ENTITY = /^camera\.[a-z0-9_]+$/;

export interface CameraRow {
  readonly handle: string;
  readonly entityId: string;
  readonly name: string;
  readonly available: boolean;
  readonly checkedAt: number | null;
}

/** Every camera the household added, by name. */
export function readCameras(db: SqliteDatabase): CameraRow[] {
  const rows = db
    .prepare(
      `SELECT handle, entity_id AS entityId, name, available, checked_at AS checkedAt
         FROM ha_cameras ORDER BY name COLLATE NOCASE, entity_id`,
    )
    .all() as { handle: string; entityId: string; name: string; available: number; checkedAt: number | null }[];
  return rows.map((row) => ({ ...row, available: row.available === 1 }));
}

/** The handles of every camera added, for the omission (a widget naming a removed one is left out). */
export function cameraHandles(db: SqliteDatabase): string[] {
  return (db.prepare('SELECT handle FROM ha_cameras ORDER BY handle').all() as { handle: string }[]).map(
    (row) => row.handle,
  );
}

/** The entity a handle names, or nothing. Server side only. */
export function cameraEntityOf(db: SqliteDatabase, handle: string): CameraRow | undefined {
  if (!CAMERA_HANDLE.test(handle)) return undefined;
  return readCameras(db).find((row) => row.handle === handle);
}

export type WatchCameraResult =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly message: string };

/** Add a camera, minting its handle. One already added keeps the handle it has. */
export function watchCamera(
  db: SqliteDatabase,
  camera: { readonly entityId: string; readonly name: string },
  now: number,
): WatchCameraResult {
  if (!CAMERA_ENTITY.test(camera.entityId)) return { ok: false, message: 'Choose a camera from the list.' };
  const existing = db.prepare('SELECT handle FROM ha_cameras WHERE entity_id = ?').get(camera.entityId) as
    | { handle: string }
    | undefined;
  if (existing !== undefined) return { ok: true, handle: existing.handle };
  const count = (db.prepare('SELECT count(*) AS n FROM ha_cameras').get() as { n: number }).n;
  if (count >= MAX_CAMERAS) {
    return { ok: false, message: `A wall shows at most ${MAX_CAMERAS} cameras. Remove one to add another.` };
  }
  const handle = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO ha_cameras (handle, entity_id, name, available, checked_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, NULL, ?, ?)`,
  ).run(handle, camera.entityId, camera.name, now, now);
  return { ok: true, handle };
}

/** Remove a camera. A widget naming its handle is left out of every wall until it names another. */
export function unwatchCamera(db: SqliteDatabase, handle: string): void {
  db.prepare('DELETE FROM ha_cameras WHERE handle = ?').run(handle);
}

const stateRow = z.object({
  entity_id: z.string().max(255),
  state: z.string().max(255),
  attributes: z.looseObject({ friendly_name: z.string().max(200).optional().catch(undefined) }).optional().catch(undefined),
});

/** A camera Home Assistant lists, as the add page offers it. */
export interface CameraEntity {
  readonly entityId: string;
  readonly name: string;
  readonly available: boolean;
}

/**
 * The cameras in a `/api/states` body.
 *
 * A second, narrower reader over the document the readings are parsed from,
 * which leaves `parseStates` and the supported domains alone (RFC 007 §6.1).
 * A row of the wrong shape is skipped rather than costing the others.
 */
export function parseCameraEntities(body: string): CameraEntity[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const found: CameraEntity[] = [];
  for (const item of raw) {
    const row = stateRow.safeParse(item);
    if (!row.success || !CAMERA_ENTITY.test(row.data.entity_id)) continue;
    found.push({
      entityId: row.data.entity_id,
      name: row.data.attributes?.friendly_name ?? row.data.entity_id,
      available: row.data.state !== 'unavailable',
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether each added camera is there, from the same body the readings come from. */
export function writeCameraStates(db: SqliteDatabase, body: string, at: number): void {
  const cameras = readCameras(db);
  if (cameras.length === 0) return;
  const listed = new Map(parseCameraEntities(body).map((camera) => [camera.entityId, camera]));
  const update = db.prepare('UPDATE ha_cameras SET name = ?, available = ?, checked_at = ?, updated_at = ? WHERE handle = ?');
  db.transaction(() => {
    for (const camera of cameras) {
      const now = listed.get(camera.entityId);
      // A camera Home Assistant no longer lists is not there: the wall says so
      // and the route does not ask for a picture that cannot come.
      update.run(now?.name ?? camera.name, now?.available === true ? 1 : 0, at, at, camera.handle);
    }
  })();
}

/** What a wall is told about the cameras: a handle each, and whether it is there. Never an entity id. */
export interface CamerasPanel {
  readonly cameras: readonly { readonly handle: string; readonly available: boolean }[];
}

export const camerasModule: PanelModule = {
  key: CAMERAS_BLOCK,
  label: 'Cameras',

  ready(db: SqliteDatabase): boolean {
    return (db.prepare('SELECT count(*) AS n FROM ha_cameras').get() as { n: number }).n > 0;
  },

  contribute(context: ModuleContext): CamerasPanel | null {
    const cameras = readCameras(context.db);
    if (cameras.length === 0) return null;
    return { cameras: cameras.map((camera) => ({ handle: camera.handle, available: camera.available })) };
  },
};

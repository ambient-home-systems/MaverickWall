import type { Fetcher } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { sniffImage } from '../../api/media.js';
import { callPicture, resolveConnection } from '../homeassistant/client.js';
import { cameraEntityOf } from './index.js';

/**
 * A camera's latest picture, for a wall (RFC 007 §5.4).
 *
 * One bounded `GET` of Home Assistant's `/api/camera_proxy/<entity>` through
 * the ordinary fetcher — `callPicture`, beside `call`, so the house's token is
 * attached in one file and the address cannot leave Home Assistant's origin —
 * and nothing else: no socket held open, no new outbound mode.
 *
 * **Single-flighted per camera.** Three walls refreshing the same doorbell
 * every few seconds cost Home Assistant one fetch each time, not three: a
 * request arriving while one is under way, or within `SNAPSHOT_TTL_MS` of the
 * last answer, is handed that answer. The TTL is the shortest refresh a widget
 * may ask for, so no wall is ever shown a picture older than it asked for by
 * more than the time the fetch itself took.
 *
 * **Kept in memory only, and only the latest.** No frame is written to disk —
 * not a cache, not a last-known picture (RFC 007 §8): the wall shows now. The
 * map holds one entry per camera, replaced on every fetch and dropped with the
 * camera.
 */

/** The shortest refresh a camera widget may ask for, and so how long one answer is shared. */
export const SNAPSHOT_TTL_MS = 1_000;

const CONTENT_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const;

export type SnapshotResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly contentType: string }
  | { readonly ok: false; readonly status: 404 | 502 | 503; readonly message: string };

interface Flight {
  readonly answer: Promise<SnapshotResult>;
  settledAt?: number;
}

export interface SnapshotContext {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly now: () => number;
  /**
   * The latest frame of a camera whose live stream is open (plan item M6.2):
   * a snapshot of a streaming camera is that frame, and costs Home Assistant
   * nothing (RFC 007 §5.4).
   */
  readonly latest?: (handle: string) => Uint8Array | undefined;
}

/** One cache per app, so two test apps in one process do not share a picture. */
export function createSnapshots(context: SnapshotContext): {
  take(handle: string): Promise<SnapshotResult>;
  /** How many fetches have reached Home Assistant, for the single-flight test. */
  readonly fetches: () => number;
} {
  const flights = new Map<string, Flight>();
  let fetches = 0;

  async function fetchOnce(entityId: string): Promise<SnapshotResult> {
    const resolved = resolveConnection(context.db, context.keyring);
    if (!resolved.ok) {
      return { ok: false, status: 503, message: 'Home Assistant is not connected, so there is no picture.' };
    }
    fetches += 1;
    const fetched = await callPicture(
      context.fetcher,
      resolved.connection,
      `/api/camera_proxy/${encodeURIComponent(entityId)}`,
    );
    if (!fetched.ok) return { ok: false, status: 502, message: 'The camera did not send a picture just now.' };
    // Sniffed, as every picture this application serves is.
    const kind = sniffImage(fetched.bytes);
    if (kind === undefined) return { ok: false, status: 502, message: 'The camera sent something that is not a picture.' };
    return { ok: true, bytes: fetched.bytes, contentType: CONTENT_TYPES[kind] };
  }

  return {
    async take(handle: string): Promise<SnapshotResult> {
      const camera = cameraEntityOf(context.db, handle);
      if (camera === undefined) {
        flights.delete(handle);
        return { ok: false, status: 404, message: 'There is no such camera.' };
      }
      if (!camera.available) {
        return { ok: false, status: 503, message: 'This camera is not answering Home Assistant at the moment.' };
      }
      const streaming = context.latest?.(handle);
      if (streaming !== undefined) {
        const bytes = Buffer.from(streaming);
        const kind = sniffImage(bytes);
        if (kind !== undefined) return { ok: true, bytes, contentType: CONTENT_TYPES[kind] };
      }
      const at = context.now();
      const held = flights.get(handle);
      if (held !== undefined && (held.settledAt === undefined || at - held.settledAt < SNAPSHOT_TTL_MS)) {
        return held.answer;
      }
      const flight: Flight = {
        answer: fetchOnce(camera.entityId).then((result) => {
          flight.settledAt = context.now();
          return result;
        }),
      };
      flights.set(handle, flight);
      return flight.answer;
    },
    fetches: () => fetches,
  };
}

import type { Fetcher, JobHandler, JobResult } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { measureKeptShapes } from '../api/photo-shapes.js';
import { prefetchImmich, readImmichConnection, readImmichSources, syncImmichSource } from '../modules/immich/store.js';

/**
 * Re-read every Immich source, then fetch ahead a few photos not yet kept
 * (plan item M3.2).
 *
 * One job for the connection rather than one per source: they are all one
 * server on the household's own network, a handful at most. Registered always
 * and a no-op without a connection, the update check's arrangement, so turning
 * Immich on needs no job created and turning it off leaves none running.
 *
 * Memories are a fact about a day, so "today" is the household's, read in its
 * own zone: a wall in Sydney shows the 8th's memories while London's shows the
 * 7th's.
 */

export const IMMICH_SYNC_JOB = 'immich-sync';
/** Enough to fill a fresh source's first half hour of a slideshow without a burst at Immich. */
const PREFETCH_PER_RUN = 40;

export function todayIn(timezone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export function createImmichSyncHandler(deps: {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly dataDir: string;
  readonly timezone: () => string;
  readonly now?: () => number;
}): JobHandler {
  const now = deps.now ?? ((): number => Date.now());
  return async (): Promise<JobResult> => {
    if (readImmichConnection(deps.db) === undefined) return { status: 'skipped', reason: 'Immich is not connected' };
    const at = now();
    const context = { db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, dataDir: deps.dataDir, now: at };
    const today = todayIn(deps.timezone(), at);
    let failure: string | undefined;
    for (const source of readImmichSources(deps.db)) {
      const synced = await syncImmichSource(context, source.id, today);
      if (!synced.ok && failure === undefined) failure = synced.message;
    }
    await prefetchImmich(context, PREFETCH_PER_RUN);
    // What was just fetched ahead can be measured for pairing (plan item M3.7).
    measureKeptShapes(deps.db, deps.dataDir, at);
    return failure === undefined ? { status: 'ok' } : { status: 'failed', error: failure };
  };
}

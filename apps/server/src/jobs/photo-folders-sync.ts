import type { Fetcher, JobHandler, JobResult } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { prefetchFolders, readFolders, syncFolder } from '../modules/folder/store.js';

/**
 * Re-read every NAS folder, then fetch ahead a few photos not yet kept (plan
 * item M3.3) — `immich-sync`'s arrangement, one source along: registered
 * always, a no-op with no folders, half-hourly.
 */

export const PHOTO_FOLDERS_SYNC_JOB = 'photo-folders-sync';
const PREFETCH_PER_RUN = 40;

export function createPhotoFoldersSyncHandler(deps: {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly fetcher: Fetcher;
  readonly dataDir: string;
  readonly now?: () => number;
}): JobHandler {
  const now = deps.now ?? ((): number => Date.now());
  return async (): Promise<JobResult> => {
    const folders = readFolders(deps.db);
    if (folders.length === 0) return { status: 'skipped', reason: 'no folders' };
    const context = { db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, dataDir: deps.dataDir, now: now() };
    let failure: string | undefined;
    for (const folder of folders) {
      const synced = await syncFolder(context, folder.id);
      if (!synced.ok && failure === undefined) failure = synced.message;
    }
    await prefetchFolders(context, PREFETCH_PER_RUN);
    return failure === undefined ? { status: 'ok' } : { status: 'failed', error: failure };
  };
}

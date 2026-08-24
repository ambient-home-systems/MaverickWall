import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { databasePath } from './open.js';

/**
 * Applying a restore that was staged by the admin screen.
 *
 * Run at boot, before anything opens the database or the keyring reads
 * `.secret`, because that is the only moment nothing has either file open. A
 * restore applied under a live process — with WAL readers attached and the
 * scheduler mid-sync — is how a restore becomes a corruption.
 *
 * The old database and the old key, when either is replaced, are renamed
 * rather than deleted. Somebody who restores the wrong file has done
 * something frightening and reversible rather than frightening and final.
 */

export type RestoreOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'restored'; readonly keptAt: string }
  | { readonly status: 'failed'; readonly error: string };

export function stagedPath(dataDir: string): string {
  return join(dataDir, 'restore.db');
}

/**
 * Where a staged key upload sits until boot adopts it, beside `restore.db`.
 *
 * A database alone restores everything except calendar addresses — those are
 * encrypted, and the key is what reads them. On the Home Assistant add-on
 * there is no shell and no way to place `.secret` in the data directory by
 * hand, so this is the only path that can restore it there at all.
 */
export function stagedKeyPath(dataDir: string): string {
  return join(dataDir, 'restore.secret');
}

export function applyStagedRestore(dataDir: string): RestoreOutcome {
  const staged = stagedPath(dataDir);
  const stagedKey = stagedKeyPath(dataDir);
  const hasDb = existsSync(staged);
  const hasKey = existsSync(stagedKey);
  if (!hasDb && !hasKey) return { status: 'none' };

  try {
    if (hasDb && statSync(staged).size === 0) {
      renameSync(staged, `${staged}.rejected`);
      return { status: 'failed', error: 'The staged backup was empty and has been set aside.' };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let kept = '';

    if (hasDb) {
      const live = databasePath(dataDir);
      kept = `${live}.replaced-${stamp}`;
      if (existsSync(live)) renameSync(live, kept);

      /*
       * The write-ahead log and shared-memory files belong to the database
       * that has just been moved aside. Left behind, SQLite would try to
       * replay them over the restored file, which is a corruption rather
       * than a restore.
       */
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${live}${suffix}`;
        if (existsSync(sidecar)) renameSync(sidecar, `${kept}${suffix}`);
      }

      renameSync(staged, live);
    }

    if (hasKey) {
      const liveKey = join(dataDir, '.secret');
      const keptKey = `${liveKey}.replaced-${stamp}`;
      if (existsSync(liveKey)) renameSync(liveKey, keptKey);
      renameSync(stagedKey, liveKey);
      if (kept === '') kept = keptKey;
    }

    return { status: 'restored', keptAt: kept };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'the staged backup could not be applied',
    };
  }
}

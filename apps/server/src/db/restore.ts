import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { databasePath } from './open.js';

/**
 * Applying a restore that was staged by the admin screen.
 *
 * Run at boot, before anything opens the database, because that is the only
 * moment nothing has the file open. A restore applied under a live process —
 * with WAL readers attached and the scheduler mid-sync — is how a restore
 * becomes a corruption.
 *
 * The old database is renamed rather than deleted. Somebody who restores the
 * wrong file has done something frightening and reversible rather than
 * frightening and final.
 */

export type RestoreOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'restored'; readonly keptAt: string }
  | { readonly status: 'failed'; readonly error: string };

export function stagedPath(dataDir: string): string {
  return join(dataDir, 'restore.db');
}

export function applyStagedRestore(dataDir: string): RestoreOutcome {
  const staged = stagedPath(dataDir);
  if (!existsSync(staged)) return { status: 'none' };

  try {
    if (statSync(staged).size === 0) {
      renameSync(staged, `${staged}.rejected`);
      return { status: 'failed', error: 'The staged backup was empty and has been set aside.' };
    }

    const live = databasePath(dataDir);
    const kept = `${live}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(live)) renameSync(live, kept);

    /*
     * The write-ahead log and shared-memory files belong to the database that
     * has just been moved aside. Left behind, SQLite would try to replay them
     * over the restored file, which is a corruption rather than a restore.
     */
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${live}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${kept}${suffix}`);
    }

    renameSync(staged, live);
    return { status: 'restored', keptAt: kept };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'the staged backup could not be applied',
    };
  }
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The instance type of a better-sqlite3 connection.
 *
 * The package exports a constructor merged with a namespace, so the imported
 * name is not usable as a type on its own. Deriving it with `InstanceType`
 * works regardless of how the declarations are shaped, which matters because
 * that shape differs between the bundled types and @types/better-sqlite3.
 */
export type SqliteDatabase = InstanceType<typeof Database>;

/**
 * Opening the database.
 *
 * Every pragma here is deliberate and every one of them has to be re-applied on
 * each connection: SQLite persists `journal_mode` in the file but nothing else,
 * so a fresh connection silently reverts to defaults that are wrong for this
 * workload.
 */

export interface OpenOptions {
  readonly dataDir: string;
  /** Overrides the default `<dataDir>/wall.db`. Used by tests. */
  readonly filename?: string;
  readonly readonly?: boolean;
}

export interface OpenResult {
  readonly db: SqliteDatabase;
  readonly path: string;
  /** Pragmas that did not take, for the diagnostics overlay. */
  readonly warnings: readonly string[];
}

export function databasePath(dataDir: string): string {
  return join(dataDir, 'wall.db');
}

export function openDatabase(options: OpenOptions): OpenResult {
  const path = options.filename ?? databasePath(options.dataDir);
  mkdirSync(options.dataDir, { recursive: true });

  const db = new Database(path, options.readonly === true ? { readonly: true } : {});
  const warnings: string[] = [];

  // Write-ahead logging. Readers do not block the writer, which matters because
  // a calendar sync writes for a second or two while several screens are
  // polling. Persisted in the file, but set anyway so a fresh database gets it.
  const journalMode = String(db.pragma('journal_mode = WAL', { simple: true }));
  if (journalMode.toLowerCase() !== 'wal') {
    // Network filesystems refuse WAL. It still works, just with worse
    // concurrency, and that is not worth refusing to boot over.
    warnings.push(
      `Journal mode is "${journalMode}" rather than WAL. This usually means /data ` +
        'is on a network filesystem. The calendar will work but concurrent ' +
        'reads and writes will be slower.',
    );
  }

  // Not persisted, and off by default. Without it, every foreign key in the
  // schema is decoration and a deleted calendar source leaves its events behind.
  db.pragma('foreign_keys = ON');

  // Wait rather than throwing SQLITE_BUSY. A sync and a poll overlapping should
  // queue, not fail.
  db.pragma('busy_timeout = 5000');

  // Sync at checkpoints rather than every write. With WAL this keeps durability
  // against process crashes while surviving on an SD card, which is what most
  // of these run on.
  db.pragma('synchronous = NORMAL');

  // Keep temporary tables and sorts in memory; /data may be slow storage.
  db.pragma('temp_store = MEMORY');

  // Reclaim space gradually rather than in one long stall.
  db.pragma('auto_vacuum = INCREMENTAL');

  return { db, path, warnings };
}

/**
 * `PRAGMA optimize`, run periodically by the scheduler.
 *
 * Cheap, and it keeps the query planner's statistics current as the events
 * cache turns over. Failure is never worth surfacing.
 */
export function optimize(db: SqliteDatabase): void {
  try {
    db.pragma('optimize');
  } catch {
    // Advisory only.
  }
}

/**
 * Snapshot to `<dataDir>/backups`.
 *
 * `VACUUM INTO` produces a consistent copy without stopping writes, which is
 * the whole reason backups can be a scheduled job rather than a maintenance
 * window. Rule eleven: assume nobody can reach this machine to fix anything, so
 * restoring has to be copying one file back.
 */
export function backupTo(db: SqliteDatabase, destination: string): void {
  // Parameter binding is not available for VACUUM INTO, so the path is quoted
  // by doubling single quotes. Destinations are constructed by us from a
  // timestamp, never from user input.
  const quoted = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
}

/** Integrity check, surfaced in diagnostics rather than run on every boot. */
export function integrityCheck(db: SqliteDatabase): { ok: boolean; detail: string } {
  try {
    const result = String(db.pragma('integrity_check', { simple: true }));
    return { ok: result === 'ok', detail: result };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
  }
}

import { resolve } from 'node:path';
import { openDatabase, type SqliteDatabase } from './open.js';
import { describeOutcome, runMigrations, type MigrationOutcome } from './migrate.js';

/**
 * Open the database and bring the schema up to date.
 *
 * Every entry point goes through here — the server, and each command line tool.
 * The alternative, which this replaced, was tools that opened the database and
 * assumed the server had already created the schema. That works right up until
 * someone adds a calendar source before the first boot, which is exactly the
 * order the setup instructions suggested.
 *
 * Migrations are idempotent and taken behind a file lock, so running them from
 * a short-lived CLI while the server is up is safe: whichever process gets the
 * lock migrates, and the other waits.
 */

export interface BootstrapResult {
  readonly db: SqliteDatabase;
  readonly path: string;
  /** Absolute. Printed by every entry point so a mismatch is visible at once. */
  readonly dataDir: string;
  readonly migration: MigrationOutcome;
  /** Storage or migration problems worth surfacing. */
  readonly warnings: readonly string[];
}

/**
 * Where the generated migrations live, relative to this compiled module.
 *
 * Computed from `import.meta.url` rather than the process working directory,
 * because a CLI is run from wherever the operator happens to be standing.
 */
export function migrationsFolder(): string {
  return new URL('../../migrations', import.meta.url).pathname;
}

export function openAndMigrate(dataDir: string): BootstrapResult {
  // Resolved to an absolute path immediately, and reported by every caller.
  //
  // A relative DATA_DIR means a different database depending on where the
  // process was started, and `pnpm --filter` runs scripts from the package
  // directory rather than the repository root. That combination silently split
  // one installation into two: the tools wrote to one database and the server
  // read another, surfacing three commands later as "that pairing link is not
  // valid" with nothing to suggest the real cause.
  const absolute = resolve(dataDir);
  const opened = openDatabase({ dataDir: absolute });
  const warnings: string[] = [...opened.warnings];

  const migration = runMigrations(opened.db, {
    dataDir,
    migrationsFolder: migrationsFolder(),
  });

  const described = describeOutcome(migration);
  if (described) warnings.push(described);

  return { db: opened.db, path: opened.path, dataDir: absolute, migration, warnings };
}

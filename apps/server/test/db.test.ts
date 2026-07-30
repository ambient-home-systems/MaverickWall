import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupTo, databasePath, integrityCheck, openDatabase, optimize } from '../src/db/open.js';
import { describeOutcome, runMigrations } from '../src/db/migrate.js';

/**
 * The only test in this package that touches a real database.
 *
 * Everything else about the schema is a typecheck, which proves nothing about
 * whether SQLite accepts it. This opens a temp file, migrates it, and asserts
 * the pragmas actually took — because most of them are per-connection and
 * revert silently to the wrong defaults if the call is missed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'migrations');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mw-db-'));
  roots.push(dir);
  return dir;
}

function migratedDatabase() {
  const dataDir = scratch();
  const opened = openDatabase({ dataDir });
  const outcome = runMigrations(opened.db, {
    dataDir,
    migrationsFolder: MIGRATIONS,
    waitTimeoutMs: 1000,
  });
  return { ...opened, dataDir, outcome };
}

describe('migrations', () => {
  it('has generated migration files committed', () => {
    // If this fails, run: pnpm --filter @maverick-wall/server db:generate
    expect(existsSync(MIGRATIONS), `no migrations at ${MIGRATIONS}`).toBe(true);
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(0);
  });

  it('brings a fresh database up to date', () => {
    const { outcome } = migratedDatabase();
    expect(outcome.status).toBe('current');
    expect(describeOutcome(outcome)).toBeUndefined();
  });

  it('is idempotent across restarts', () => {
    // Every container restart runs this. Applying twice must be a no-op.
    const dataDir = scratch();
    for (let run = 0; run < 3; run++) {
      const { db } = openDatabase({ dataDir });
      const outcome = runMigrations(db, {
        dataDir,
        migrationsFolder: MIGRATIONS,
        waitTimeoutMs: 1000,
      });
      expect(outcome.status, `run ${run}`).toBe('current');
      db.close();
    }
  });

  it('releases the lock afterwards', () => {
    const { dataDir } = migratedDatabase();
    expect(existsSync(join(dataDir, '.migrate.lock'))).toBe(false);
  });

  it('reports rather than throws when the migrations folder is missing', () => {
    // Rule nine: a broken deployment still boots and says what is wrong.
    const dataDir = scratch();
    const { db } = openDatabase({ dataDir });
    const outcome = runMigrations(db, {
      dataDir,
      migrationsFolder: join(dataDir, 'does-not-exist'),
      waitTimeoutMs: 500,
    });
    expect(outcome.status).toBe('failed');
    expect(describeOutcome(outcome)).toContain('still being shown');
  });
});

describe('pragmas', () => {
  it('enables write-ahead logging', () => {
    const { db } = migratedDatabase();
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
  });

  it('enforces foreign keys', () => {
    // Off by default and not persisted in the file, so this is the pragma most
    // likely to be silently missing.
    const { db } = migratedDatabase();
    expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1);
  });

  it('waits instead of failing when the database is busy', () => {
    const { db } = migratedDatabase();
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(5000);
  });

  it('uses NORMAL synchronous, which is the WAL-safe setting', () => {
    const { db } = migratedDatabase();
    expect(Number(db.pragma('synchronous', { simple: true }))).toBe(1);
  });

  it('re-applies per-connection pragmas on a second connection', () => {
    // The failure this guards against: pragmas set once at first run, then a
    // later connection quietly running without foreign keys.
    const dataDir = scratch();
    const first = openDatabase({ dataDir });
    runMigrations(first.db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    first.db.close();

    const second = openDatabase({ dataDir });
    expect(Number(second.db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(Number(second.db.pragma('busy_timeout', { simple: true }))).toBe(5000);
  });
});

describe('schema', () => {
  const EXPECTED = [
    'account', 'active_alerts', 'alert_zones', 'audit_log', 'calendar_events_cache',
    'calendar_sources', 'ha_entity_cache', 'ha_settings', 'household_settings',
    'interrupt_rules', 'job_state', 'media_assets', 'people', 'screens', 'session',
    'shift_overrides', 'shift_plans', 'shift_types', 'user', 'verification', 'weather_cache',
  ];

  it('creates every expected table', () => {
    const { db } = migratedDatabase();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const present = new Set(rows.map((row) => row.name));
    for (const table of EXPECTED) {
      expect(present.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it('has no tenant_id anywhere', () => {
    // Stated as a rule, so pinned as a test. Adding it later should require
    // deleting this line and thinking about why.
    const { db } = migratedDatabase();
    const columns = db
      .prepare(
        "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m " +
          "JOIN pragma_table_info(m.name) p WHERE m.type = 'table'",
      )
      .all() as { tbl: string; col: string }[];
    const offenders = columns.filter((c) => c.col.includes('tenant'));
    expect(offenders).toEqual([]);
  });

  it('cascades deletes from a calendar source to its cached events', () => {
    // The foreign_keys pragma being on is only meaningful if the constraints
    // actually fire.
    const { db } = migratedDatabase();
    db.prepare(
      'INSERT INTO calendar_sources (id, name, url_encrypted, created_at, updated_at) ' +
        "VALUES ('src1', 'Test', 'mw1.xxx', 0, 0)",
    ).run();
    db.prepare(
      'INSERT INTO calendar_events_cache ' +
        '(id, source_id, uid, title, starts_at, ends_at, start_local_date, end_local_date, ' +
        'source_tzid, synced_at) ' +
        "VALUES ('e1', 'src1', 'uid1', 'Dentist', 0, 1, '2026-01-01', '2026-01-01', 'UTC', 0)",
    ).run();

    expect(
      (db.prepare('SELECT count(*) AS n FROM calendar_events_cache').get() as { n: number }).n,
    ).toBe(1);

    db.prepare("DELETE FROM calendar_sources WHERE id = 'src1'").run();

    expect(
      (db.prepare('SELECT count(*) AS n FROM calendar_events_cache').get() as { n: number }).n,
    ).toBe(0);
  });

  it('rejects an event pointing at a source that does not exist', () => {
    const { db } = migratedDatabase();
    expect(() =>
      db
        .prepare(
          'INSERT INTO calendar_events_cache ' +
            '(id, source_id, uid, title, starts_at, ends_at, start_local_date, end_local_date, ' +
            'source_tzid, synced_at) ' +
            "VALUES ('e1', 'nope', 'uid1', 'X', 0, 1, '2026-01-01', '2026-01-01', 'UTC', 0)",
        )
        .run(),
    ).toThrow();
  });

  it('indexes the column every display poll queries', () => {
    const { db } = migratedDatabase();
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM calendar_events_cache WHERE starts_at BETWEEN ? AND ?')
      .all(0, 1) as { detail: string }[];
    // A table scan here would be fine at ten events and miserable at ten
    // thousand, and nobody would notice until a household subscribed to a
    // school district calendar.
    expect(plan.some((row) => row.detail.includes('USING INDEX'))).toBe(true);
  });
});

describe('maintenance', () => {
  it('produces a restorable backup while the database is open', () => {
    // VACUUM INTO rather than a file copy: a copy of a live WAL database is
    // not guaranteed consistent, and restoring has to be copying one file back.
    const { db, dataDir } = migratedDatabase();
    const destination = join(dataDir, 'backup.db');
    backupTo(db, destination);
    expect(existsSync(destination)).toBe(true);

    const restored = openDatabase({ dataDir: scratch(), filename: destination });
    const rows = restored.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n: number };
    expect(rows.n).toBeGreaterThan(15);
  });

  it('passes an integrity check', () => {
    const { db } = migratedDatabase();
    expect(integrityCheck(db)).toEqual({ ok: true, detail: 'ok' });
  });

  it('optimises without complaint', () => {
    const { db } = migratedDatabase();
    expect(() => optimize(db)).not.toThrow();
  });

  it('creates the data directory if it is missing', () => {
    const dataDir = join(scratch(), 'nested', 'data');
    const { path } = openDatabase({ dataDir });
    expect(path).toBe(databasePath(dataDir));
    expect(existsSync(path)).toBe(true);
  });
});

describe('bootstrap', () => {
  it('creates the schema from nothing, so a CLI can run before the server', async () => {
    // The bug this pins: the command line tools opened the database and assumed
    // the server had already migrated it. Adding a calendar source before the
    // first boot — the order the setup instructions suggest — then failed with
    // "no such table".
    const { openAndMigrate } = await import('../src/db/bootstrap.js');
    const dataDir = scratch();
    const { db, migration } = openAndMigrate(dataDir);
    expect(migration.status).toBe('current');
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='calendar_sources'")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('is safe to run twice, as two entry points would', async () => {
    const { openAndMigrate } = await import('../src/db/bootstrap.js');
    const dataDir = scratch();
    expect(openAndMigrate(dataDir).migration.status).toBe('current');
    expect(openAndMigrate(dataDir).migration.status).toBe('current');
  });
});

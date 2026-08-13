import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Upgrading a database that already has a household's calendars in it.
 *
 * Every other test starts from an empty database and migrates it in one go,
 * which is the one path where a migration cannot destroy anything. This walks
 * the migrations one at a time with real rows already present, which is what
 * actually happens to somebody's kitchen calendar when they pull a new image.
 *
 * It exists because of a specific near miss. drizzle-kit's table-recreate
 * output listed the *new* columns in its `INSERT ... SELECT`, and SQLite
 * resolves a double-quoted name matching no column as a **string literal**
 * rather than erroring — so `SELECT "kind" FROM calendar_sources` on a table
 * with no `kind` column yields the text `'kind'` for every row. Every existing
 * source would have come out with `kind = 'kind'`, matched neither sync path,
 * and never fetched again. The migration reported success. Nothing typechecked
 * it, and no test that starts from empty could ever see it.
 *
 * So this asserts the property rather than that one column: after every
 * migration, a source that existed beforehand is still an ICS feed with its
 * events, its colour and its owner.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

function journal(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

/** Apply one migration exactly as the runtime migrator does: statement by statement. */
function apply(db: Database.Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed !== '') db.exec(trimmed);
  }
}

describe('upgrading a database that is already in use', () => {
  it('has a migration file for every journal entry, and nothing extra', () => {
    // A tag in the journal with no file is a container that starts and then
    // cannot migrate; a file with no entry never runs and looks like it did.
    const tags = new Set(journal().map((entry) => entry.tag));
    const files = new Set(
      readdirSync(MIGRATIONS)
        .filter((name) => name.endsWith('.sql'))
        .map((name) => name.replace(/\.sql$/, '')),
    );
    expect([...files].sort()).toEqual([...tags].sort());
  });

  it('carries an existing calendar through every later migration intact', () => {
    const entries = journal();
    const root = mkdtempSync(join(tmpdir(), 'mw-upgrade-'));
    roots.push(root);
    const db = new Database(join(root, 'wall.db'));
    db.pragma('journal_mode = WAL');

    /*
     * Inserted as early as the schema allows, then carried the whole way.
     *
     * The first migration is what creates the tables, so the row goes in after
     * it and every migration from then on has to preserve it. Doing this at
     * the *end* would prove nothing: the risk is entirely in what a later
     * migration does to rows that were already there.
     */
    const first = entries[0];
    expect(first).toBeDefined();
    apply(db, (first as JournalEntry).tag);

    const stamp = 1_700_000_000_000;
    db.prepare(
      `INSERT INTO calendar_sources (id, name, url_encrypted, url_host, color,
                                     event_count, created_at, updated_at)
       VALUES ('src-1', 'Family', 'mw1.envelope', 'calendar.google.com', '#AA3311', 2, ?, ?)`,
    ).run(stamp, stamp);

    db.prepare(
      `INSERT INTO calendar_events_cache
         (id, source_id, uid, title, starts_at, ends_at, all_day, start_local_date,
          end_local_date, source_tzid, status, is_recurring_instance, synced_at)
       VALUES ('evt-1', 'src-1', 'u1', 'Dentist', ?, ?, 0, '2026-08-02', '2026-08-02',
               'Europe/London', 'CONFIRMED', 0, ?)`,
    ).run(stamp, stamp + 3_600_000, stamp);

    for (const entry of entries.slice(1)) apply(db, entry.tag);

    const source = db
      .prepare(
        `SELECT name, kind, url_encrypted AS url, url_host AS host, color,
                event_count AS eventCount, ha_entity_id AS entityId
           FROM calendar_sources WHERE id = 'src-1'`,
      )
      .get() as Record<string, unknown>;

    expect(source).toEqual({
      name: 'Family',
      // The whole point. Not 'kind', not null — the column default.
      kind: 'ics',
      url: 'mw1.envelope',
      host: 'calendar.google.com',
      color: '#AA3311',
      eventCount: 2,
      entityId: null,
    });

    const events = db
      .prepare(`SELECT title FROM calendar_events_cache WHERE source_id = 'src-1'`)
      .all() as { title: string }[];
    expect(events.map((event) => event.title)).toEqual(['Dentist']);

    // A recreated table must not leave the child pointing at a table that is
    // gone, which is the other way a rebuild goes wrong.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    db.close();
  });

  it('carries an existing free-form canvas onto the portrait side (RFC 005)', () => {
    // A wall arranged before the two-canvas split has widgets with no
    // orientation column. The 0024 migration adds it with a `portrait` default,
    // because that is the aspect those rows were authored at — the same shape of
    // near-miss as the `kind = 'kind'` one above, just the other direction: an
    // additive column whose default has to be right, walked against real rows.
    const entries = journal();
    const root = mkdtempSync(join(tmpdir(), 'mw-upgrade-canvas-'));
    roots.push(root);
    const db = new Database(join(root, 'wall.db'));
    db.pragma('journal_mode = WAL');

    const stamp = 1_700_000_000_000;
    let inserted = false;
    for (const entry of entries) {
      // Just before the orientation column arrives, store a widget the way a
      // pre-RFC-005 wall did: no orientation column in the INSERT at all.
      if (entry.tag.startsWith('0024')) {
        db.prepare(
          `INSERT INTO layout_widgets (id, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES ('w-1', 'clock', 0.1, 0.1, 0.3, 0.2, 0, NULL, ?, ?)`,
        ).run(stamp, stamp);
        inserted = true;
      }
      apply(db, entry.tag);
    }
    // If the tag ever changes, this guard keeps the test from silently proving
    // nothing by inserting after the column already exists.
    expect(inserted).toBe(true);

    const row = db
      .prepare(`SELECT id, type, orientation AS o FROM layout_widgets WHERE id = 'w-1'`)
      .get() as { id: string; type: string; o: string };
    expect(row).toEqual({ id: 'w-1', type: 'clock', o: 'portrait' });

    db.close();
  });
});

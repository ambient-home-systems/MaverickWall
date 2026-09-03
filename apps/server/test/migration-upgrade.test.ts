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
                event_count AS eventCount, ha_entity_id AS entityId,
                show_in_grid AS showInGrid
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
      /*
       * 1, on a row inserted long before the column existed (0035).
       *
       * The whole promise of the switch is that nobody's wall changes at
       * upgrade — the calendar that drew on the month grid last night draws on
       * it this morning. A `DEFAULT true` that reached existing rows as NULL
       * would take every calendar off every grid in one image pull, which is
       * exactly the shape of the `kind = 'kind'` near miss this file exists
       * for, and no test starting from an empty database can see it.
       */
      showInGrid: 1,
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

  it('un-watches a calendar somebody added as a reading (0031)', () => {
    /*
     * Removing an option does not remove what it already created.
     *
     * `calendar` was a supported domain for the entity picker, so a household
     * could add `calendar.bins` beside their temperatures and get a chip
     * reading "Bins · On" — the entity's state, which means "an event is
     * happening right now". Dropping the domain stops it being *offered*, and
     * the panel query selects on `watched = 1` with no domain filter — so
     * without this migration every wall that already had one would carry on
     * drawing it, and the household would report the same bug a second time.
     *
     * The cache row itself stays: it is refreshed from Home Assistant on the
     * next poll, so deleting it would only bring it back.
     */
    const db = new Database(':memory:');
    const entries = journal();
    const before = entries.filter((entry) => entry.tag < '0031');
    for (const entry of before) apply(db, entry.tag);

    const at = Date.now();
    db.prepare(
      `INSERT INTO ha_entity_cache (entity_id, watched, sort_order, fetched_at)
       VALUES ('calendar.bins', 1, 0, ?), ('sensor.hall', 1, 1, ?)`,
    ).run(at, at);

    for (const entry of entries.filter((entry) => entry.tag >= '0031')) apply(db, entry.tag);

    const watched = db
      .prepare('SELECT entity_id FROM ha_entity_cache WHERE watched = 1')
      .all() as { entity_id: string }[];
    // The calendar stops being a reading; the thermometer beside it is untouched.
    expect(watched.map((row) => row.entity_id)).toEqual(['sensor.hall']);
    expect(
      db.prepare("SELECT count(*) AS n FROM ha_entity_cache WHERE entity_id = 'calendar.bins'")
        .get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it('leaves a screen that is already hung with no size and no reading distance (0037)', () => {
    /*
     * The two facts that size type arrive on a table full of screens.
     *
     * `screens` is where the *hardware* facts live — the rotation and the
     * pinned orientation are already there — so the panel's size and the
     * distance it is read from join them, and they join a row somebody paired
     * years ago. Three additive columns with no default, which has to reach an
     * existing row as **null on all three**: null is what every reader takes as
     * "this screen has not been measured", and it is the whole of the promise
     * that a household who never opens the setting draws exactly what they drew
     * last night. A default of 0 here would be a screen zero millimetres wide,
     * read from zero millimetres away, on every wall in the world at one image
     * pull — the `kind = 'kind'` shape again, one table along.
     *
     * The screen goes in before `orientation` and `rotation` exist at all
     * (0004), and is turned on its end once they do, because that is the row
     * this migration actually meets: a wall paired early, hung sideways later,
     * and never touched since.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let hung = false;
    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0000')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-1', 'Kitchen', 'hash-1', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
      }
      if (entry.tag.startsWith('0004')) {
        db.prepare(
          `UPDATE screens SET rotation = 90, orientation = 'portrait' WHERE id = 'scr-1'`,
        ).run();
        hung = true;
      }
    }
    // If the tags ever move, this keeps the test from proving nothing by
    // setting a rotation on a table that already had every later column.
    expect(hung).toBe(true);

    const screen = db
      .prepare(
        `SELECT name, orientation, rotation, kind,
                panel_width_mm AS widthMm, panel_height_mm AS heightMm,
                read_distance_mm AS distanceMm
           FROM screens WHERE id = 'scr-1'`,
      )
      .get() as Record<string, unknown>;

    expect(screen).toEqual({
      name: 'Kitchen',
      // Still hung the way the household hung it.
      orientation: 'portrait',
      rotation: 90,
      // 0029's default, on a row inserted long before that column existed.
      kind: 'browser',
      // The point. Not 0, not a preset somebody guessed at — unmeasured.
      widthMm: null,
      heightMm: null,
      distanceMm: null,
    });

    db.close();
  });

  it('leaves an existing eInk screen refusing nothing by network (0038)', () => {
    /*
     * `lan_only` (Option C) has to reach a screen paired long before it
     * existed, additive and `NOT NULL DEFAULT false` — the cheap direction,
     * since a default of `true` here would silently stop answering every
     * eInk panel already hanging in a kitchen the moment this migration ran.
     * The screen is turned into an eInk one at 0029, the migration that adds
     * `kind` at all, so this walks the same row `panel_width_mm` (0037) does,
     * one column further along the same table.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let becameEpaper = false;
    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0000')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-eink', 'Hallway', 'hash-2', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
      }
      if (entry.tag.startsWith('0029')) {
        db.prepare(`UPDATE screens SET kind = 'epaper', panel_width = 800, panel_height = 480 WHERE id = 'scr-eink'`).run();
        becameEpaper = true;
      }
    }
    // If the tags ever move, this keeps the test from proving nothing by
    // setting `kind` on a table that already had every later column.
    expect(becameEpaper).toBe(true);

    const screen = db
      .prepare(`SELECT kind, lan_only AS lanOnly FROM screens WHERE id = 'scr-eink'`)
      .get() as Record<string, unknown>;

    expect(screen).toEqual({ kind: 'epaper', lanOnly: 0 });

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

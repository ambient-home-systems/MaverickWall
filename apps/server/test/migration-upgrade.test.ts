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
                show_in_grid AS showInGrid, auth_username AS authUsername,
                auth_password_encrypted AS authPassword
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
      /*
       * Null on both, on a row inserted long before either column existed
       * (0042), and null rather than `''`.
       *
       * A feed can sign in now (RFC 013 Phase A), and every feed already
       * subscribed signs in as nobody — which is exactly what it did last
       * night. `api/feed-credentials.ts` reads null as "send no
       * `authorization` header at all", so a default of the empty string here
       * would be a username of `''` with an empty password beside it, and the
       * question of whether that composes a header is one no household should
       * ever have made to depend on a column default. The `kind = 'kind'`
       * shape again, two columns along.
       */
      authUsername: null,
      authPassword: null,
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
      .prepare(
        `SELECT kind, lan_only AS lanOnly, last_seen_forwarding AS forwarding
           FROM screens WHERE id = 'scr-eink'`,
      )
      .get() as Record<string, unknown>;

    /*
     * `last_seen_forwarding` (0039) rides along on the same row, and null is
     * the whole of its meaning: it is an *observation* about a request, and no
     * request has been made. A default of anything else would put a warning on
     * a settings page about a proxy nobody has, on every panel in the world at
     * one image pull — the `kind = 'kind'` shape one column along.
     */
    expect(screen).toEqual({ kind: 'epaper', lanOnly: 0, forwarding: null });

    db.close();
  });

  it('gives a screen and a calendar the to-do tables and switch, with nothing on either (0041)', () => {
    /*
     * RFC 012's one migration: two additive tables and one additive column,
     * walked with a screen paired at 0000 and a Home Assistant calendar added
     * once `kind` existed (0009) — the two rows a household running this
     * feature actually has. What has to hold is that the screen's new switch
     * reaches it as **false**, since `allow_todo` is read by nothing in phase 1
     * and a default of true would arm every wall in the world for a write that
     * arrives next release; that the calendar's `kind` is still what it was,
     * because 0041 sits on the same table 0009 recreated; and that the tables
     * exist, are empty, and carry the unique index the poll's upsert relies on.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let addedCalendar = false;
    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0000')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-todo', 'Kitchen', 'hash-3', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
      }
      if (entry.tag.startsWith('0009')) {
        db.prepare(
          `INSERT INTO calendar_sources (id, name, kind, ha_entity_id, color, created_at, updated_at)
           VALUES ('src-ha', 'Bins', 'homeassistant', 'calendar.bins', '#AA3311', ?, ?)`,
        ).run(stamp, stamp);
        addedCalendar = true;
      }
    }
    expect(addedCalendar).toBe(true);

    expect(
      db.prepare(`SELECT allow_todo AS allowTodo, allow_chores AS allowChores FROM screens WHERE id = 'scr-todo'`).get(),
    ).toEqual({ allowTodo: 0, allowChores: 0 });
    expect(
      db.prepare(`SELECT kind, ha_entity_id AS entityId FROM calendar_sources WHERE id = 'src-ha'`).get(),
    ).toEqual({ kind: 'homeassistant', entityId: 'calendar.bins' });

    expect(db.prepare('SELECT count(*) AS n FROM ha_todo_lists').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM ha_todo_items').get()).toEqual({ n: 0 });
    const indexes = db.pragma('index_list(ha_todo_items)') as { name: string; unique: number }[];
    expect(indexes.find((index) => index.name === 'ha_todo_items_entity_uid_idx')?.unique).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('gives a screen and a calendar the CalDAV table and column, changing neither (0043)', () => {
    /*
     * RFC 013 Phase C's one migration, walked with the two rows a household
     * actually has: a screen paired at 0000 and an ICS feed added at 0000 with
     * events in its cache.
     *
     * §6.2.1 predicts this migration is additive — one `CREATE TABLE` and one
     * nullable `ALTER TABLE ADD COLUMN` — so rule seven's `0009` hazard does not
     * apply. That is worth *checking* rather than assuming, because `0009` is
     * the one migration fault in this repository that reported success, and it
     * sat on this very table.
     *
     * Two things beyond the rows surviving. **Widening `kind` to carry
     * `'caldav'` must emit no DDL at all**: a drizzle SQLite text enum is a
     * compile-time narrowing over a plain `text` column, not a `CHECK`, and a
     * `CHECK` here would mean a table recreate on somebody's calendars. The
     * assertion is that the upgraded database *accepts* the new value, which is
     * the property a `CHECK` would take away — reading the SQL for the word
     * would pass just as happily against a constraint spelled differently.
     *
     * And the new column reaches an existing feed as **NULL rather than 0 or an
     * empty string**: `connectionFor` reads "no account" off exactly that, so a
     * default of anything else would point every ICS feed in the world at an
     * account row that does not exist.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0000')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-dav', 'Hall', 'hash-dav', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
        db.prepare(
          `INSERT INTO calendar_sources (id, name, url_encrypted, color, created_at, updated_at)
           VALUES ('src-dav', 'Family', 'mw1:sealed', '#4C7FD1', ?, ?)`,
        ).run(stamp, stamp);
        db.prepare(
          `INSERT INTO calendar_events_cache
             (id, source_id, uid, title, starts_at, ends_at, all_day, start_local_date,
              end_local_date, source_tzid, status, is_recurring_instance, synced_at)
           VALUES ('e1', 'src-dav', 'u1', 'Dentist', ?, ?, 0, '2026-03-02', '2026-03-02',
                   'Europe/London', 'CONFIRMED', 0, ?)`,
        ).run(stamp, stamp + 3_600_000, stamp);
      }
    }

    // The feed is untouched, still an ICS feed, still with its event.
    expect(
      db
        .prepare(
          `SELECT kind, url_encrypted AS url, color, caldav_account_id AS accountId
             FROM calendar_sources WHERE id = 'src-dav'`,
        )
        .get(),
    ).toEqual({ kind: 'ics', url: 'mw1:sealed', color: '#4C7FD1', accountId: null });
    expect(
      db.prepare(`SELECT count(*) AS n FROM calendar_events_cache WHERE source_id = 'src-dav'`).get(),
    ).toEqual({ n: 1 });
    // And the screen, which this migration has nothing to do with and which is
    // here precisely because a table recreate elsewhere would still be visible.
    expect(db.prepare(`SELECT name FROM screens WHERE id = 'scr-dav'`).get()).toEqual({
      name: 'Hall',
    });

    // The new table is there and empty.
    expect(db.prepare('SELECT count(*) AS n FROM caldav_accounts').get()).toEqual({ n: 0 });

    /*
     * No `CHECK` on `kind`, asserted by writing the new value rather than by
     * reading the DDL for the word.
     */
    db.prepare(
      `INSERT INTO caldav_accounts
         (id, server_url_encrypted, username, password_encrypted, created_at, updated_at)
       VALUES ('acct-1', 'mw1:server', 'jane@icloud.example', 'mw1:pw', ?, ?)`,
    ).run(stamp, stamp);
    db.prepare(
      `INSERT INTO calendar_sources
         (id, name, kind, caldav_account_id, url_encrypted, etag, color, created_at, updated_at)
       VALUES ('src-c', 'Home', 'caldav', 'acct-1', 'mw1:href', 'ctag-1', '#AA3311', ?, ?)`,
    ).run(stamp, stamp);
    expect(
      db.prepare(`SELECT kind, etag FROM calendar_sources WHERE id = 'src-c'`).get(),
    ).toEqual({ kind: 'caldav', etag: 'ctag-1' });

    /*
     * And the FK is real but carries **no action**, which is the thing reading
     * the migration caught and which `removeCaldavAccount` exists to work
     * around. The schema declares `ON DELETE CASCADE`; drizzle-kit drops it
     * from an `ALTER TABLE ADD COLUMN`, so SQLite applies `NO ACTION` and the
     * delete is refused. Asserted here rather than left as a comment, so that a
     * future drizzle that *does* emit the action turns this red and somebody
     * reads the code that is compensating for its absence.
     */
    db.pragma('foreign_keys = ON');
    expect(() => db.prepare(`DELETE FROM caldav_accounts WHERE id = 'acct-1'`).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
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

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
                read_distance_mm AS distanceMm,
                layout_style AS layoutStyle, motion
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
      // 0048 (RFC 014 §4.1): no default style lane, which is the wall drawing
      // exactly what it drew — spread out of the manifest, never `{}`.
      layoutStyle: null,
      // 0053 (plan P4.3): never chosen, which is on — and not 0, which would
      // still every wall in the world at one image pull.
      motion: null,
    });

    db.close();
  });

  it('leaves an existing widget on the default canvas, with the schedule table empty (0049)', () => {
    /*
     * RFC 014 §5.2: `layout_widgets.slot` is nullable and **null is the
     * default canvas** — every row that existed before the column did. A
     * migration that backfilled a name here, or a default of `''`, would put
     * every wall's widgets on a canvas the schedule could name and the wall
     * would draw them only inside a window nobody wrote. The row is planted
     * when the table is created (0012), before `screen_id` (0013) and
     * `orientation` (0024) exist, so it walks every shape the table has had.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let planted = false;
    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0012')) {
        db.prepare(
          `INSERT INTO layout_widgets (id, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES ('w-1', 'clock', 0, 0, 0.5, 0.2, 0, NULL, ?, ?)`,
        ).run(stamp, stamp);
        planted = true;
      }
    }
    expect(planted).toBe(true);

    const widget = db
      .prepare('SELECT type, screen_id AS screenId, orientation, slot FROM layout_widgets WHERE id = ?')
      .get('w-1') as Record<string, unknown>;
    expect(widget).toEqual({ type: 'clock', screenId: null, orientation: 'portrait', slot: null });
    // And `IS NULL` is how the default is read, so the row is found that way.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM layout_widgets WHERE slot IS NULL').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM layout_schedule').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('carries a wall’s widgets through 0050 with no group link (RFC 014 §5.1)', () => {
    /*
     * `layout_widgets.parent_id` is nullable and **null is a widget on the
     * canvas itself** — every row that existed before the column did. A
     * migration that backfilled anything here would put a household's boxes
     * inside a group nobody made, at fractions that were of the canvas and
     * are now read as fractions of that group. Two rows are planted the way a
     * wall stores them today — a clock and a calendar on one screen, one
     * orientation, the default slot — walked through the migration, and read
     * back exactly as they were: same box, same z, and no parent.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let planted = false;
    for (const entry of entries) {
      if (entry.tag.startsWith('0050')) {
        for (const [id, type, y, z] of [['w-clock', 'clock', 0, 0], ['w-cal', 'calendar', 0.2, 1]] as const) {
          db.prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, 's-wall', 'portrait', ?, 0, ?, 1, 0.2, ?, NULL, ?, ?)`,
          ).run(id, type, y, z, stamp, stamp);
        }
        planted = true;
      }
      apply(db, entry.tag);
    }
    expect(planted).toBe(true);

    const rows = db
      .prepare(
        `SELECT id, type, screen_id AS screenId, x, y, w, h, z, parent_id AS parentId
           FROM layout_widgets ORDER BY z`,
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { id: 'w-clock', type: 'clock', screenId: 's-wall', x: 0, y: 0, w: 1, h: 0.2, z: 0, parentId: null },
      { id: 'w-cal', type: 'calendar', screenId: 's-wall', x: 0, y: 0.2, w: 1, h: 0.2, z: 1, parentId: null },
    ]);
    // And the column is what a group's child will write into — text, nullable.
    const column = (
      db.prepare(`PRAGMA table_info(layout_widgets)`).all() as { name: string; type: string; notnull: number }[]
    ).find((c) => c.name === 'parent_id');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
    db.close();
  });

  it('carries a wall and its widgets through 0051 with no CSS on either (RFC 014 §7)', () => {
    /*
     * `custom_css` and `custom_css_scoped` are nullable on both tables and
     * **null is no CSS** — every row that existed before the columns did. A
     * migration that wrote anything here would hand a household's wall a
     * stylesheet nobody typed; so a wall paired long ago and a widget arranged
     * on it are planted before 0051, walked through it, and read back with
     * all four columns null and the widget's row otherwise exactly as it was.
     * Text and nullable, so a block can be written and cleared without a
     * default standing in for either.
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    let planted = false;
    for (const entry of entries) {
      if (entry.tag.startsWith('0051')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, theme, created_at, updated_at)
           VALUES ('s-wall', 'Kitchen', 'hash-1', ?, 'panels', ?, ?)`,
        ).run(stamp, stamp, stamp);
        db.prepare(
          `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES ('w-clock', 's-wall', 'portrait', 'clock', 0, 0, 1, 0.2, 0, '{"align":"center"}', ?, ?)`,
        ).run(stamp, stamp);
        planted = true;
      }
      apply(db, entry.tag);
    }
    expect(planted).toBe(true);

    expect(
      db
        .prepare('SELECT custom_css AS source, custom_css_scoped AS scoped FROM screens WHERE id = ?')
        .get('s-wall'),
    ).toEqual({ source: null, scoped: null });
    expect(
      db
        .prepare(
          `SELECT id, type, x, y, w, h, z, config, custom_css AS source, custom_css_scoped AS scoped
             FROM layout_widgets WHERE id = ?`,
        )
        .get('w-clock'),
    ).toEqual({
      id: 'w-clock', type: 'clock', x: 0, y: 0, w: 1, h: 0.2, z: 0, config: '{"align":"center"}',
      source: null, scoped: null,
    });
    for (const table of ['screens', 'layout_widgets']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number }[];
      for (const name of ['custom_css', 'custom_css_scoped']) {
        expect(columns.find((c) => c.name === name), `${table}.${name}`).toMatchObject({ type: 'TEXT', notnull: 0 });
      }
    }
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

  it('hands the household theme to every wall that was drawing it, then drops it (0044, 0045)', () => {
    /*
     * RFC 015 phase 2. Four screens the walk already carries never held a
     * *theme state*; these three do, and each is a different one. A wall with
     * its own theme keeps it. A wall following the household takes the
     * household's value — `board`, on purpose: a live key such as `almanac`
     * cannot tell a copy from a `COALESCE` that resolved through the display's
     * alias table, and the migration must copy *raw*, because resolving a
     * retired key is the reader's job. And an e-paper panel is left with
     * nothing, which is not a hole: a panel draws one bit and has no theme to
     * name, and the CHECK says so (`kind = 'epaper' OR theme IS NOT NULL`).
     *
     * `0045` is the `0009` shape — a recreate of the 46-column `screens`, which
     * carries `token_hash`, the credential every paired wall authenticates
     * with — so the walk asserts the token survives alongside the theme, and
     * the four household columns go by `ALTER TABLE … DROP COLUMN` rather
     * than a second recreate (SQLite 3.49.2, checked before this was written).
     */
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0000')) {
        db.prepare(
          `INSERT INTO household_settings
             (id, timezone, theme, daytime_theme, daytime_starts_at, daytime_ends_at,
              created_at, updated_at)
           VALUES ('singleton', 'Europe/London', 'board', 'almanac', '06:30', '20:15', ?, ?)`,
        ).run(stamp, stamp);
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
           VALUES ('scr-own', 'Bedroom', 'hash-own', 'almanac', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-follow', 'Kitchen', 'hash-follow', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
      }
      // `kind` arrives at 0029; the panel is turned into one the moment it can be.
      if (entry.tag.startsWith('0029')) {
        db.prepare(
          `INSERT INTO screens (id, name, token_hash, kind, panel_width, panel_height, panel_colour,
                                token_issued_at, created_at, updated_at)
           VALUES ('scr-panel', 'Hall tag', 'hash-panel', 'epaper', 800, 480, 'bw', ?, ?, ?)`,
        ).run(stamp, stamp, stamp);
      }
    }

    const walls = db
      .prepare(
        `SELECT id, kind, theme, token_hash AS tokenHash, daytime_theme AS daytimeTheme,
                daytime_starts_at AS startsAt, daytime_ends_at AS endsAt
           FROM screens ORDER BY id`,
      )
      .all();
    expect(walls).toEqual([
      // The raw copied value — not `panels`, which is what a resolver would say.
      {
        id: 'scr-follow', kind: 'browser', theme: 'board', tokenHash: 'hash-follow',
        daytimeTheme: 'almanac', startsAt: '06:30', endsAt: '20:15',
      },
      // Its own theme, untouched; the schedule it never set is the household's.
      {
        id: 'scr-own', kind: 'browser', theme: 'almanac', tokenHash: 'hash-own',
        daytimeTheme: 'almanac', startsAt: '06:30', endsAt: '20:15',
      },
      // A panel names nothing and is asked nothing.
      {
        id: 'scr-panel', kind: 'epaper', theme: null, tokenHash: 'hash-panel',
        daytimeTheme: null, startsAt: null, endsAt: null,
      },
    ]);

    // The four household columns are gone, and the rest of the row is not.
    const columns = (db.pragma('table_info(household_settings)') as { name: string }[]).map((c) => c.name);
    for (const gone of ['theme', 'daytime_theme', 'daytime_starts_at', 'daytime_ends_at']) {
      expect(columns, `${gone} survived the drop`).not.toContain(gone);
    }
    expect(db.prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`).get()).toEqual({
      timezone: 'Europe/London',
    });

    /*
     * The CHECK, as a pair: either half alone passes under a constraint that
     * is simply absent, or under one tightened into refusing every panel.
     */
    expect(() =>
      db
        .prepare(
          `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
           VALUES ('scr-bare', 'Bare', 'hash-bare', ?, ?, ?)`,
        )
        .run(stamp, stamp, stamp),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO screens (id, name, token_hash, kind, panel_width, panel_height, panel_colour,
                                token_issued_at, created_at, updated_at)
           VALUES ('scr-bare-panel', 'Bare tag', 'hash-bare-panel', 'epaper', 800, 480, 'bw', ?, ?, ?)`,
        )
        .run(stamp, stamp, stamp),
    ).not.toThrow();
    // And the unique index on the credential came back with the table.
    expect(
      (db.prepare(`PRAGMA index_list('screens')`).all() as { name: string; unique: number }[]).find(
        (index) => index.name === 'screens_token_hash_idx',
      )?.unique,
    ).toBe(1);
    db.close();
  });

  it('carries an existing custom theme through the shape column with no shape set (0046)', () => {
    // RFC 014 §4.3. The `shape` column is additive — one `ALTER TABLE ADD
    // COLUMN`, never a recreate — so a theme saved before it existed must come
    // out the other side with `shape: null`, which is exactly what
    // `resolveTheme` already treats as the `board` sentinel: a theme that never
    // chose a shape keeps drawing precisely what it drew before this column
    // existed, with no ETag churn.
    const entries = journal();
    const db = new Database(':memory:');
    const stamp = 1_700_000_000_000;

    for (const entry of entries) {
      apply(db, entry.tag);
      if (entry.tag.startsWith('0021')) {
        db.prepare(
          `INSERT INTO themes (id, name, tokens, created_at, updated_at)
           VALUES ('thm-1', 'Sunroom', '{"--bg":"#111111"}', ?, ?)`,
        ).run(stamp, stamp);
      }
    }

    expect(db.prepare(`SELECT id, name, shape FROM themes WHERE id = 'thm-1'`).get()).toEqual({
      id: 'thm-1',
      name: 'Sunroom',
      shape: null,
    });
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

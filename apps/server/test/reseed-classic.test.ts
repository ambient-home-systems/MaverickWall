/**
 * Re-seeding a wall that is still exactly the one we seeded — and never one
 * anybody has touched.
 *
 * A free-form canvas is chosen once, and a fresh install is seeded before the
 * household has configured anything: add a location a week later and the
 * forecast has nowhere to be drawn, because the box was never placed. So the
 * choice is re-made on boot. The danger is obvious and is the only thing this
 * file is really about — **a household who arranged their own wall must never
 * find it rearranged** — so the gate is a proof rather than a marker: a stored
 * canvas is ours only if it prints byte-identical to one of the arrangements
 * this build seeds.
 *
 * Every case below is a way of *not* being that, written against a real
 * migrated SQLite file rather than a mock, because the comparison is over
 * values that have been through SQLite's REAL storage and back.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { applyTemplate, backfillClassic, reseedClassicForSetUp } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';
import { householdSetUp } from '../src/modules/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A migrated database with a settings row and one paired screen. */
function fresh(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-reseed-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', 'hash-kitchen', ?, ?, ?)`,
  ).run(at, at, at);
  return db;
}

/** Give the household a location, which is all `weather.ready` asks for. */
function addLocation(db: SqliteDatabase): void {
  db.prepare(
    `UPDATE household_settings SET weather_enabled = 1, latitude = ?, longitude = ?, updated_at = ?
      WHERE id = 'singleton'`,
  ).run(51.5074, -0.1278, Date.now());
}

/** Every stored widget row, as bytes — the only honest "unchanged". */
const dump = (db: SqliteDatabase): string =>
  JSON.stringify(db.prepare('SELECT * FROM layout_widgets ORDER BY screen_id, orientation, id').all());

const types = (db: SqliteDatabase, owner: string | null): string[] =>
  readLayoutWidgets(db, owner, 'portrait').map((widget) => widget.type).sort();

/** One wall's rows out of a whole-database dump, so a sibling cannot mask it. */
const ofScreen = (dumped: string, owner: string | null): string =>
  JSON.stringify(
    (JSON.parse(dumped) as { screen_id: string | null }[]).filter((row) => row.screen_id === owner),
  );

describe('reseedClassicForSetUp', () => {
  it('moves a still-seeded wall onto the variant matching what is set up now', () => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    // A fresh install: no location, no rota. The forecast box is not placed,
    // because a placed one would be dropped from the manifest and leave a hole.
    expect(types(db, null), 'the fresh seed places no forecast').not.toContain('weather');
    expect(types(db, 'kitchen')).not.toContain('weather');

    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));

    expect(types(db, null), 'the default canvas gains a forecast').toContain('weather');
    expect(types(db, 'kitchen'), "the screen's own canvas gains one too").toContain('weather');
    // And it is the whole arrangement that moved, not a box bolted on: both
    // canvases now print as the variant `classicFor` would hand out today.
    for (const orientation of ['portrait', 'landscape'] as const) {
      const want = classicFor(householdSetUp(db))[orientation].widgets;
      const got = readLayoutWidgets(db, null, orientation);
      expect(got.map((w) => `${w.type}@${w.y}`)).toEqual(want.map((w) => `${w.type}@${w.y}`));
    }
  });

  it('writes nothing at all when the set-up has not changed', () => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    const before = dump(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    // Not merely "still Classic": identical rows. A re-apply would mint fresh
    // widget ids, which is a churned ETag on every wall in the house at every
    // boot, for nothing.
    expect(dump(db), 'an unchanged household is not written to').toBe(before);
  });

  /**
   * The absolute constraint, from every direction a household can touch a
   * canvas. Each of these leaves a stored canvas that is no longer one this
   * build would have written, and each must be left alone for ever — including
   * across a second boot, which is where a "seed once, then adapt" rule that
   * kept its own marker would get it wrong.
   */
  const TOUCHES: readonly { readonly label: string; readonly touch: (db: SqliteDatabase) => void }[] = [
    {
      label: 'a box dragged',
      touch: (db) => {
        const widgets = readLayoutWidgets(db, 'kitchen', 'portrait');
        db.prepare('UPDATE layout_widgets SET y = ? WHERE id = ?').run(
          (widgets[0]?.y ?? 0) + 0.01,
          widgets[0]?.id,
        );
      },
    },
    {
      label: 'a box resized by a hair',
      touch: (db) => {
        const widgets = readLayoutWidgets(db, 'kitchen', 'portrait');
        db.prepare('UPDATE layout_widgets SET w = ? WHERE id = ?').run(
          (widgets[0]?.w ?? 0) - 0.001,
          widgets[0]?.id,
        );
      },
    },
    {
      label: 'a widget removed',
      touch: (db) => {
        const widgets = readLayoutWidgets(db, 'kitchen', 'portrait');
        db.prepare('DELETE FROM layout_widgets WHERE id = ?').run(widgets[0]?.id);
      },
    },
    {
      label: 'a widget setting changed',
      touch: (db) => {
        const month = readLayoutWidgets(db, 'kitchen', 'portrait').find(
          (widget) => (widget.config as { mode?: string } | undefined)?.mode === 'month',
        );
        db.prepare('UPDATE layout_widgets SET config = ? WHERE id = ?').run(
          JSON.stringify({ mode: 'month', cellEvents: 'pills' }),
          month?.id,
        );
      },
    },
    {
      label: 'the canvas shape changed',
      touch: (db) => {
        db.prepare(`UPDATE screens SET layout_aspect = 0.75 WHERE id = 'kitchen'`).run();
      },
    },
    {
      label: 'a canvas background set',
      touch: (db) => {
        db.prepare(`UPDATE screens SET layout_background = ? WHERE id = 'kitchen'`).run(
          JSON.stringify({ kind: 'colour', colour: '#101418' }),
        );
      },
    },
    {
      label: 'the canvas emptied',
      touch: (db) => {
        db.prepare(`DELETE FROM layout_widgets WHERE screen_id = 'kitchen'`).run();
      },
    },
  ];

  it.each(TOUCHES)('never rewrites a wall the household touched — $label', ({ touch }) => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    touch(db);
    const before = dump(db);

    // The household then does the thing that would otherwise re-seed: sets a
    // location, and reboots. Twice, because "once" is the easy half.
    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    reseedClassicForSetUp(db, householdSetUp(db));

    expect(ofScreen(dump(db), 'kitchen'), 'the touched canvas is byte-identical').toBe(
      ofScreen(before, 'kitchen'),
    );
  });

  it('leaves a wall that was started from another template alone', () => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    // A household who picked something else from the gallery. Its canvas is a
    // perfectly ordinary one — it just is not one of ours.
    replaceLayout(db, 'kitchen', 'portrait', {
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [{ id: 'mine-1', type: 'notes', x: 0.1, y: 0.1, w: 0.8, h: 0.8, z: 0 }],
      background: null,
    });
    const before = ofScreen(dump(db), 'kitchen');
    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    /*
     * The kitchen only. The shared Default canvas *is* still one of ours and is
     * re-seeded in the same run, which is right — the two are separate walls
     * and a household who arranged one has said nothing about the other. Note
     * that only this screen's *portrait* canvas was touched: its landscape one
     * is untouched Classic, and it is skipped too, because a canvas is ours as
     * a whole or not at all.
     */
    expect(ofScreen(dump(db), 'kitchen')).toBe(before);
  });

  it('does nothing before the one-shot backfill marker is set', () => {
    const db = fresh();
    // Seeded by hand, with the marker still 0 — the state a database is in
    // between migrations and `backfillClassic`. Seeding is that function's job
    // and this one must not run ahead of it.
    applyTemplate(db, null, classicFor({ modules: [], shift: false }));
    const before = dump(db);
    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    expect(dump(db)).toBe(before);
  });

  it('leaves a revoked screen and a follower alone', () => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    db.prepare(`UPDATE screens SET revoked_at = ? WHERE id = 'kitchen'`).run(Date.now());
    const before = dump(db);
    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    expect(
      ofScreen(dump(db), 'kitchen'),
      'a revoked screen is not a wall anybody is looking at',
    ).toBe(ofScreen(before, 'kitchen'));
  });

  it('leaves a panel that follows a wall alone', () => {
    const db = fresh();
    backfillClassic(db, householdSetUp(db));
    // `follow` means the panel draws somebody else's canvas; its own rows are
    // not what is on the glass, so re-seeding them would write to a canvas
    // nothing reads while the panel silently kept following.
    db.prepare(`UPDATE screens SET layout_mode = 'follow', layout_follows = NULL WHERE id = 'kitchen'`).run();
    const before = dump(db);
    addLocation(db);
    reseedClassicForSetUp(db, householdSetUp(db));
    expect(ofScreen(dump(db), 'kitchen')).toBe(ofScreen(before, 'kitchen'));
  });
});

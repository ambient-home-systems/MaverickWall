import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { readLayoutWidgets, replaceLayout, effectiveDisplay } from '../src/api/queries.js';
import { buildLayout, type HouseholdRow, type PlacedWidgetRow } from '../src/api/manifest.js';

/**
 * The free-form layout, from a stored row to the shape the wall reads.
 *
 * The load-bearing rule here is rule nine: whatever is in the database, the
 * display must be handed something it can draw. So an empty canvas falls back
 * to the responsive layout, a coordinate off the wall is pulled back onto it,
 * and a type with no module is dropped rather than sent on.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const HOUSEHOLD = (over: Partial<HouseholdRow> = {}): HouseholdRow => ({
  timezone: 'UTC',
  theme: 'board',
  daytimeTheme: null,
  daytimeStartsAt: null,
  daytimeEndsAt: null,
  shiftEnabled: 0,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  layoutMode: 'auto',
  layoutAspect: 0.5625,
  ...over,
});

const widget = (over: Partial<PlacedWidgetRow>): PlacedWidgetRow => ({
  id: 'w', type: 'clock', x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0, config: undefined, ...over,
});

describe('buildLayout', () => {
  it('stays on auto unless the household chose free-form', () => {
    const layout = buildLayout(HOUSEHOLD({ layoutMode: 'auto' }), [widget({})]);
    expect(layout.mode).toBe('auto');
  });

  it('stays on auto when free-form is chosen but the canvas is empty', () => {
    // A blank wall is the one outcome rule nine forbids.
    expect(buildLayout(HOUSEHOLD({ layoutMode: 'freeform' }), []).mode).toBe('auto');
  });

  it('draws free-form once there is a widget to draw', () => {
    const layout = buildLayout(HOUSEHOLD({ layoutMode: 'freeform' }), [widget({})]);
    expect(layout.mode).toBe('freeform');
    expect(layout.widgets).toHaveLength(1);
  });

  it('clamps a widget onto the wall and gives a zero size a default', () => {
    const layout = buildLayout(HOUSEHOLD({ layoutMode: 'freeform' }), [
      widget({ x: -0.5, y: 2, w: 5, h: 0 }),
    ]);
    const w = layout.widgets[0]!;
    expect(w.x).toBe(0);
    expect(w.y).toBe(1);
    expect(w.w).toBe(1);
    expect(w.h).toBeGreaterThan(0);
  });

  it('drops a type it has no module for — including any web embed', () => {
    const layout = buildLayout(HOUSEHOLD({ layoutMode: 'freeform' }), [
      widget({ id: 'ok', type: 'calendar' }),
      widget({ id: 'nope', type: 'website' }),
      widget({ id: 'nope2', type: 'iframe' }),
    ]);
    expect(layout.widgets.map((w) => w.id)).toEqual(['ok']);
  });

  it('draws back to front by z', () => {
    const layout = buildLayout(HOUSEHOLD({ layoutMode: 'freeform' }), [
      widget({ id: 'top', z: 5 }),
      widget({ id: 'bottom', z: 1 }),
      widget({ id: 'mid', z: 3 }),
    ]);
    expect(layout.widgets.map((w) => w.id)).toEqual(['bottom', 'mid', 'top']);
  });

  it('falls back to a portrait aspect when the stored one is nonsense', () => {
    expect(buildLayout(HOUSEHOLD({ layoutAspect: 0 }), []).aspect).toBe(0.5625);
    expect(buildLayout(HOUSEHOLD({ layoutAspect: NaN }), []).aspect).toBe(0.5625);
    expect(buildLayout(HOUSEHOLD({ layoutAspect: 1.7778 }), []).aspect).toBe(1.7778);
  });
});

describe('readLayoutWidgets', () => {
  function db() {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-layout-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    return db;
  }

  it('reads rows in z order and parses the config JSON', () => {
    const d = db();
    const at = Date.now();
    const insert = d.prepare(
      `INSERT INTO layout_widgets (id, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('a', 'clock', 0.1, 0.1, 0.3, 0.2, 2, JSON.stringify({ seconds: true }), at, at);
    insert.run('b', 'calendar', 0, 0.4, 1, 0.5, 1, null, at, at);

    const rows = readLayoutWidgets(d);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']); // z 1 before z 2
    expect(rows.find((r) => r.id === 'a')?.config).toEqual({ seconds: true });
    expect(rows.find((r) => r.id === 'b')?.config).toBeUndefined();
  });

  it('does not throw on a config that will not parse — one bad widget, not a dead manifest', () => {
    const d = db();
    const at = Date.now();
    d.prepare(
      `INSERT INTO layout_widgets (id, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES ('x', 'clock', 0, 0, 0.5, 0.5, 0, '{not json', ?, ?)`,
    ).run(at, at);

    const rows = readLayoutWidgets(d);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config).toBeUndefined();
  });
});

describe('per-wall settings', () => {
  function freshDb() {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-perwall-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    const at = Date.now();
    db.prepare(
      `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
    ).run(at, at);
    // Two paired screens to write layouts against.
    for (const id of ['wallA', 'wallB']) {
      db.prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, id, `hash-${id}`, at, at, at);
    }
    return db;
  }

  describe('effectiveDisplay', () => {
    it('takes the household value where the screen has none', () => {
      const { household, layoutOwner } = effectiveDisplay(HOUSEHOLD({ displayTodayEvents: 8, layoutMode: 'auto' }), {
        id: 'wallA',
      });
      expect(household.displayTodayEvents).toBe(8);
      // No own layout_mode → inherits, and reads the shared default (null owner).
      expect(layoutOwner).toBeNull();
    });

    it('takes the screen value where it has one, field by field', () => {
      const { household } = effectiveDisplay(HOUSEHOLD({ displayTodayEvents: 8, displayNextDays: 6 }), {
        id: 'wallA',
        displayTodayEvents: 3, // overridden
        displayNextDays: null, // inherits
      });
      expect(household.displayTodayEvents).toBe(3);
      expect(household.displayNextDays).toBe(6);
    });

    it('reads the wall own canvas once it has its own layout_mode', () => {
      const { layoutOwner } = effectiveDisplay(HOUSEHOLD({ layoutMode: 'auto' }), {
        id: 'wallA',
        layoutMode: 'freeform',
      });
      expect(layoutOwner).toBe('wallA');
    });
  });

  describe('replaceLayout by owner', () => {
    it('keeps each wall and the default apart', () => {
      const d = freshDb();
      const w = (id: string) => [{ id, type: 'clock', x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0 }];
      replaceLayout(d, null, { mode: 'freeform', aspect: 0.5625, widgets: w('default') });
      replaceLayout(d, 'wallA', { mode: 'freeform', aspect: 1, widgets: w('a1').concat(w('a2') as never) });
      replaceLayout(d, 'wallB', { mode: 'freeform', aspect: 1.78, widgets: w('b1') });

      expect(readLayoutWidgets(d, null).map((x) => x.id)).toEqual(['default']);
      expect(readLayoutWidgets(d, 'wallA').map((x) => x.id)).toEqual(['a1', 'a2']);
      expect(readLayoutWidgets(d, 'wallB').map((x) => x.id)).toEqual(['b1']);

      // The mode and aspect land where they belong.
      const wallA = d.prepare(`SELECT layout_mode AS m, layout_aspect AS a FROM screens WHERE id='wallA'`).get() as {
        m: string; a: number;
      };
      expect(wallA).toEqual({ m: 'freeform', a: 1 });
      const hh = d.prepare(`SELECT layout_mode AS m FROM household_settings`).get() as { m: string };
      expect(hh.m).toBe('freeform');
    });

    it('re-saving one wall does not disturb another or the default', () => {
      const d = freshDb();
      const w = (id: string) => [{ id, type: 'clock', x: 0, y: 0, w: 0.5, h: 0.5, z: 0 }];
      replaceLayout(d, null, { mode: 'freeform', aspect: 0.5625, widgets: w('default') });
      replaceLayout(d, 'wallA', { mode: 'freeform', aspect: 1, widgets: w('a-old') });
      replaceLayout(d, 'wallA', { mode: 'freeform', aspect: 1, widgets: w('a-new') });

      expect(readLayoutWidgets(d, 'wallA').map((x) => x.id)).toEqual(['a-new']);
      expect(readLayoutWidgets(d, null).map((x) => x.id)).toEqual(['default']);
    });
  });
});

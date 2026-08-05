import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { readLayoutWidgets } from '../src/api/queries.js';
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

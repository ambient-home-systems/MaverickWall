import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { readLayoutWidgets, replaceLayout } from '../src/api/queries.js';
import { backfillClassic } from '../src/api/templates.js';

/**
 * The one-shot migration of every "auto" wall onto the Classic template.
 *
 * This is the riskiest kind of change in the codebase — it rewrites the layout of
 * every household's wall — so the guard is a real database with a mix of walls:
 * an untouched default and screen (the old "auto"), and a screen that already
 * arranged its own canvas. Classic must reach the first two and never the third,
 * exactly once.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function seeded() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-backfill-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(at, at);
  const screen = (id: string, name: string): void => {
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, `hash-${id}`, at, at, at);
  };
  // Two auto walls (no widgets) and one that already arranged a canvas.
  screen('auto-screen', 'Kitchen');
  screen('custom-screen', 'Hall');
  replaceLayout(db, 'custom-screen', 'portrait', {
    mode: 'freeform',
    aspect: 0.5625,
    widgets: [{ id: 'kept-1', type: 'clock', x: 0.1, y: 0.1, w: 0.5, h: 0.2, z: 0 }],
    background: null,
  });
  return db;
}

describe('backfillClassic', () => {
  it('seeds Classic onto every auto wall, leaves an arranged one alone, and runs once', () => {
    const db = seeded();
    backfillClassic(db);

    // The default (owner null) and the auto screen both get Classic on both sides.
    for (const owner of [null, 'auto-screen'] as const) {
      const portrait = readLayoutWidgets(db, owner, 'portrait');
      const landscape = readLayoutWidgets(db, owner, 'landscape');
      expect(portrait.length, `${owner ?? 'default'} portrait`).toBeGreaterThan(0);
      expect(landscape.length, `${owner ?? 'default'} landscape`).toBeGreaterThan(0);
      expect(portrait.map((w) => w.type)).toContain('calendar');
    }

    // The wall that already had its own canvas is untouched — same one widget,
    // still no landscape canvas.
    const custom = readLayoutWidgets(db, 'custom-screen', 'portrait');
    expect(custom.map((w) => w.id)).toEqual(['kept-1']);
    expect(readLayoutWidgets(db, 'custom-screen', 'landscape')).toHaveLength(0);

    // The one-shot flag is set.
    const flag = db
      .prepare(`SELECT layout_backfilled AS f FROM household_settings WHERE id = 'singleton'`)
      .get() as { f: number };
    expect(flag.f).toBe(1);

    // A second run is a no-op: the default's Classic ids are unchanged, and the
    // arranged wall is still its one widget. (If it re-ran, applyTemplate would
    // mint fresh ids and replace the canvas.)
    const idsBefore = readLayoutWidgets(db, null, 'portrait').map((w) => w.id);
    backfillClassic(db);
    const idsAfter = readLayoutWidgets(db, null, 'portrait').map((w) => w.id);
    expect(idsAfter).toEqual(idsBefore);
    expect(readLayoutWidgets(db, 'custom-screen', 'portrait').map((w) => w.id)).toEqual(['kept-1']);
  });

  it('does nothing when there is no settings row yet (setup has not run)', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-backfill-empty-'));
    roots.push(dataDir);
    const { db } = openDatabase({ dataDir });
    runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
    // No household_settings insert: a fresh box before the wizard.
    expect(() => backfillClassic(db)).not.toThrow();
    expect(readLayoutWidgets(db, null, 'portrait')).toHaveLength(0);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createShiftType,
  deleteShiftType,
  moveShiftType,
  readShiftTypes,
  updateShiftType,
} from '../src/api/queries.js';

/**
 * The Work Schedule's shift-type editor, at the query layer: rename, recolour,
 * reorder, add, and the one refusal that matters — a type a rotation still
 * references cannot be removed, which would leave those days pointing at nothing.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function db(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-shifttypes-'));
  roots.push(dataDir);
  const { db: database } = openDatabase({ dataDir });
  runMigrations(database, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return database;
}

const base = {
  label: 'Swing',
  shortCode: 'Sw',
  colorToken: '--s-straight',
  color: '#12ab34',
  startTime: null,
  endTime: null,
  isWorking: true,
};

describe('shift type CRUD', () => {
  it('creates a type with an explicit colour and reads it back', () => {
    const d = db();
    createShiftType(d, base);
    const type = readShiftTypes(d).find((t) => t.label === 'Swing');
    expect(type).toBeDefined();
    expect(type?.color).toBe('#12ab34');
    expect(type?.isWorking).toBe(true);
    expect(type?.key).toBe('swing'); // derived, stable
  });

  it('updates label, colour and working flag but not the key', () => {
    const d = db();
    createShiftType(d, base);
    const created = readShiftTypes(d).find((t) => t.label === 'Swing')!;
    updateShiftType(d, created.id, { ...base, label: 'Swings', color: null, isWorking: false });
    const after = readShiftTypes(d).find((t) => t.id === created.id)!;
    expect(after.label).toBe('Swings');
    expect(after.key).toBe('swing'); // unchanged
    expect(after.color).toBeUndefined(); // "match theme" cleared it
    expect(after.isWorking).toBe(false);
  });

  it('stores and reads back an optional HH:MM window', () => {
    const d = db();
    createShiftType(d, { ...base, label: 'Day', startTime: '07:00', endTime: '19:00' });
    const type = readShiftTypes(d).find((t) => t.label === 'Day')!;
    expect(type.startTime).toBe('07:00');
    expect(type.endTime).toBe('19:00');
    updateShiftType(d, type.id, { ...base, label: 'Day', startTime: null, endTime: null });
    const cleared = readShiftTypes(d).find((t) => t.id === type.id)!;
    expect(cleared.startTime).toBeUndefined();
    expect(cleared.endTime).toBeUndefined();
  });

  it('reorders types by moving one up', () => {
    const d = db();
    createShiftType(d, { ...base, label: 'Alpha' });
    createShiftType(d, { ...base, label: 'Beta' });
    const beta = readShiftTypes(d).find((t) => t.label === 'Beta')!;
    moveShiftType(d, beta.id, 'up');
    expect(readShiftTypes(d).map((t) => t.label)).toEqual(['Beta', 'Alpha']);
  });

  it('refuses to remove a type a rotation still uses', () => {
    const d = db();
    createShiftType(d, base);
    const type = readShiftTypes(d).find((t) => t.label === 'Swing')!;
    const at = Date.now();
    d.prepare(
      `INSERT INTO shift_plans (id, name, kind, effective_from, anchor_date, cycle, consumes_events, created_at, updated_at)
       VALUES ('p1', 'x', 'pattern', '2000-01-01', '2026-01-01', ?, 1, ?, ?)`,
    ).run(JSON.stringify(['swing', null]), at, at);
    const refused = deleteShiftType(d, type.id);
    expect(refused.ok).toBe(false);

    d.prepare('DELETE FROM shift_plans WHERE id = ?').run('p1');
    expect(deleteShiftType(d, type.id).ok).toBe(true);
    expect(readShiftTypes(d).some((t) => t.id === type.id)).toBe(false);
  });
});

import type { SqliteDatabase } from '../db/open.js';

/**
 * Registered third-party modules (docs/rfc-001-module-framework.md).
 *
 * Raw statements like the rest of the query layer. The block key is always
 * `ext:<id>`, minted here so nothing else has to remember the rule.
 */

export interface ExternalModuleRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly blockKey: string;
  readonly enabled: number;
  readonly sortOrder: number;
  readonly panel: unknown;
  readonly lastPolledAt: number;
  readonly lastError: string | null;
}

interface RawRow {
  id: string;
  url: string;
  name: string;
  block_key: string;
  enabled: number;
  sort_order: number;
  panel: string | null;
  last_polled_at: number;
  last_error: string | null;
}

function shape(row: RawRow): ExternalModuleRow {
  let panel: unknown = null;
  if (row.panel !== null) {
    try {
      panel = JSON.parse(row.panel);
    } catch {
      panel = null;
    }
  }
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    blockKey: row.block_key,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    panel,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
  };
}

const SELECT = `SELECT id, url, name, block_key, enabled, sort_order, panel,
  last_polled_at, last_error FROM external_modules ORDER BY sort_order, created_at`;

export function readExternalModules(db: SqliteDatabase): ExternalModuleRow[] {
  return (db.prepare(SELECT).all() as RawRow[]).map(shape);
}

export function readEnabledExternalModules(db: SqliteDatabase): ExternalModuleRow[] {
  return readExternalModules(db).filter((row) => row.enabled === 1);
}

export function externalBlockKey(id: string): string {
  return `ext:${id}`;
}

export function createExternalModule(
  db: SqliteDatabase,
  input: { id: string; url: string; name: string },
): string {
  const at = Date.now();
  const blockKey = externalBlockKey(input.id);
  const order =
    (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM external_modules`).get() as {
      n: number;
    }).n;
  db.prepare(
    `INSERT INTO external_modules (id, url, name, block_key, enabled, sort_order,
        last_polled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)`,
  ).run(input.id, input.url, input.name, blockKey, order, at, at);
  return blockKey;
}

export function setExternalModuleEnabled(db: SqliteDatabase, id: string, enabled: boolean): void {
  db.prepare(`UPDATE external_modules SET enabled = ?, updated_at = ? WHERE id = ?`).run(
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
}

export function deleteExternalModule(db: SqliteDatabase, id: string): void {
  db.prepare(`DELETE FROM external_modules WHERE id = ?`).run(id);
}

function readBlocks(db: SqliteDatabase): string[] {
  const row = db
    .prepare(`SELECT display_blocks AS blocks FROM household_settings WHERE id = 'singleton'`)
    .get() as { blocks: string | null } | undefined;
  return (row?.blocks ?? '').split(',').map((b) => b.trim()).filter((b) => b !== '');
}

function writeBlocks(db: SqliteDatabase, blocks: readonly string[]): void {
  db.prepare(
    `UPDATE household_settings SET display_blocks = ?, updated_at = ? WHERE id = 'singleton'`,
  ).run(blocks.join(','), Date.now());
}

/** Put a module's block on the wall — the moment the household asked for it. */
export function ensureDisplayBlock(db: SqliteDatabase, key: string): void {
  const blocks = readBlocks(db);
  if (blocks.includes(key)) return;
  // After the built-in blocks: a third-party panel joins the bottom of the wall
  // rather than pushing the calendar down. The household can reorder later.
  blocks.push(key);
  writeBlocks(db, blocks);
}

/** Take a module's block off the wall, when it is disabled or removed. */
export function removeDisplayBlock(db: SqliteDatabase, key: string): void {
  const blocks = readBlocks(db);
  if (!blocks.includes(key)) return;
  writeBlocks(db, blocks.filter((b) => b !== key));
}

/** A good poll: store the validated panel and clear the error. */
export function writeExternalModulePanel(db: SqliteDatabase, id: string, panel: unknown): void {
  const at = Date.now();
  db.prepare(
    `UPDATE external_modules SET panel = ?, last_error = NULL, last_polled_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(panel), at, at, id);
}

/**
 * A failed poll: record the error but keep the last good panel. A forecast from
 * this morning is worth more than a blank rectangle — the same call weather
 * makes — and the household sees the error on the module's own card.
 */
export function writeExternalModuleError(db: SqliteDatabase, id: string, error: string): void {
  const at = Date.now();
  db.prepare(
    `UPDATE external_modules SET last_error = ?, last_polled_at = ?, updated_at = ? WHERE id = ?`,
  ).run(error, at, at, id);
}

import type { SqliteDatabase } from '../db/open.js';
import { moduleVariantKey, variantBlockKey, widgetSettings } from './module-variant.js';
import { panelForWall } from './module-image-handle.js';

export { moduleVariantKey, variantBlockKey, widgetSettings };

/**
 * Registered third-party modules (docs/rfc-001-module-framework.md).
 *
 * Raw statements like the rest of the query layer. The block key is always
 * `ext:<id>`, minted here so nothing else has to remember the rule.
 */

/** What a module is allowed to do to the wall. See schema.ts. */
export type AlertsAction = 'none' | 'banner' | 'takeover';
const ALERTS_ACTIONS: readonly AlertsAction[] = ['none', 'banner', 'takeover'];

/** How a module is fed: an HTTP service (RFC 001) or a recipe (RFC 002 B1). */
export type ModuleKind = 'service' | 'recipe';

export interface ExternalModuleRow {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly blockKey: string;
  readonly enabled: number;
  readonly sortOrder: number;
  /** `service` polls the module over HTTP; `recipe` runs a declarative fetch here. */
  readonly kind: ModuleKind;
  /** For a recipe: its manifest (raw JSON this process wrote). Null for a service. */
  readonly recipe: unknown;
  /** For a recipe: the household's filled-in config values. */
  readonly config: unknown;
  /** For a recipe with secrets: the encrypted envelope, decrypted only at fetch. */
  readonly secretsEnvelope: string | null;
  readonly panel: unknown;
  /** Last validated signals this module offered; raw JSON this process wrote. */
  readonly signals: unknown;
  /** `none` (default), `banner`, or `takeover` — never `takeover_and_wake`. */
  readonly alertsAction: AlertsAction;
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
  kind: string;
  recipe: string | null;
  config: string | null;
  secrets: string | null;
  panel: string | null;
  signals: string | null;
  alerts_action: string | null;
  last_polled_at: number;
  last_error: string | null;
}

/** JSON a column holds, defended against a value this process did not write. */
function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function shape(row: RawRow): ExternalModuleRow {
  // A column read back that is not one of the three known values is treated as
  // `none`: an unarmed module is the safe reading of a corrupt one.
  const action = ALERTS_ACTIONS.includes(row.alerts_action as AlertsAction)
    ? (row.alerts_action as AlertsAction)
    : 'none';
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    blockKey: row.block_key,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    kind: row.kind === 'recipe' ? 'recipe' : 'service',
    recipe: parseJson(row.recipe),
    config: parseJson(row.config),
    secretsEnvelope: row.secrets,
    panel: parseJson(row.panel),
    signals: parseJson(row.signals),
    alertsAction: action,
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
  };
}

const SELECT = `SELECT id, url, name, block_key, enabled, sort_order, kind, recipe, config,
  secrets, panel, signals, alerts_action, last_polled_at, last_error
  FROM external_modules ORDER BY sort_order, created_at`;

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

/**
 * A recipe module: no service to poll, its data comes from the manifest and the
 * household's config. The `url` column keeps the recipe's fetch URL for the
 * health line; the poll runs the recipe engine rather than a GET to `/panel`.
 */
export function createRecipeModule(
  db: SqliteDatabase,
  input: {
    id: string;
    name: string;
    url: string;
    recipe: unknown;
    config: unknown;
    /** An already-encrypted keyring envelope, or null. Never plaintext here. */
    secretsEnvelope?: string | null;
  },
): string {
  const at = Date.now();
  const blockKey = externalBlockKey(input.id);
  const order =
    (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM external_modules`).get() as {
      n: number;
    }).n;
  db.prepare(
    `INSERT INTO external_modules (id, url, name, block_key, enabled, kind, recipe, config,
        secrets, sort_order, last_polled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'recipe', ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.id,
    input.url,
    input.name,
    blockKey,
    JSON.stringify(input.recipe),
    JSON.stringify(input.config),
    input.secretsEnvelope ?? null,
    order,
    at,
    at,
  );
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

/**
 * Replace the cached signals from a good `/signals` poll.
 *
 * Authoritative: the module is the source of truth for what is true right now,
 * so a shorter list means a signal went away and the interrupt it drove should
 * clear. Deliberately does NOT touch `last_error` — `/signals` is optional, and
 * a module that only serves `/panel` must not read as broken. Its panel poll
 * owns the health line.
 */
export function writeExternalModuleSignals(db: SqliteDatabase, id: string, signals: unknown): void {
  db.prepare(`UPDATE external_modules SET signals = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(signals),
    Date.now(),
    id,
  );
}

/**
 * Forget a module's signals entirely.
 *
 * For the one case where keeping the last-good set would be wrong: the module
 * answered `/signals` with a 404, which is it saying "I offer no signals". A
 * transient network failure keeps the last set instead (a blip must not drop a
 * real alert); only a definite "there is nothing here" clears it.
 */
export function clearExternalModuleSignals(db: SqliteDatabase, id: string): void {
  db.prepare(`UPDATE external_modules SET signals = NULL, updated_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

/** Set what a module may do to the wall. Validated to the enum at the boundary. */
export function setExternalModuleAlertsAction(
  db: SqliteDatabase,
  id: string,
  action: AlertsAction,
): void {
  db.prepare(`UPDATE external_modules SET alerts_action = ?, updated_at = ? WHERE id = ?`).run(
    action,
    Date.now(),
    id,
  );
}

// ---------------------------------------------------------------------------
// A widget's own settings (plan item M7.6)
// ---------------------------------------------------------------------------

/**
 * Every distinct set of settings a placed widget gives this module, on any
 * wall, either orientation, any named layout. A panel following a wall reads
 * the same rows, so a panel's variants are among these.
 */
export function readModuleWidgetSettings(db: SqliteDatabase, moduleId: string): Map<string, Record<string, string>> {
  const rows = db.prepare(`SELECT config FROM layout_widgets WHERE type = 'external'`).all() as {
    config: string | null;
  }[];
  const out = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const config = parseJson(row.config);
    if (config === null || typeof config !== 'object') continue;
    if ((config as Record<string, unknown>)['module'] !== moduleId) continue;
    const settings = widgetSettings(config);
    if (settings !== null) out.set(moduleVariantKey(moduleId, settings), settings);
  }
  return out;
}

export interface ModuleVariantRow {
  readonly moduleId: string;
  readonly variantKey: string;
  readonly panel: unknown;
  readonly lastPolledAt: number;
  readonly lastError: string | null;
}

export function readModuleVariants(db: SqliteDatabase, moduleId: string): ModuleVariantRow[] {
  return (
    db
      .prepare(
        `SELECT module_id, variant_key, panel, last_polled_at, last_error
         FROM external_module_variants WHERE module_id = ? ORDER BY variant_key`,
      )
      .all(moduleId) as {
      module_id: string;
      variant_key: string;
      panel: string | null;
      last_polled_at: number;
      last_error: string | null;
    }[]
  ).map((row) => ({
    moduleId: row.module_id,
    variantKey: row.variant_key,
    panel: parseJson(row.panel),
    lastPolledAt: row.last_polled_at,
    lastError: row.last_error,
  }));
}

/**
 * Every enabled module's variant panels, keyed as the manifest carries them.
 * A variant not yet read has no panel and is not sent: its widget waits, as a
 * freshly installed module's does.
 */
export function readVariantPanels(db: SqliteDatabase): Record<string, unknown> {
  const rows = db
    .prepare(
      `SELECT v.module_id, v.variant_key, v.panel FROM external_module_variants v
       JOIN external_modules m ON m.id = v.module_id
       WHERE m.enabled = 1 AND v.panel IS NOT NULL ORDER BY v.module_id, v.variant_key`,
    )
    .all() as { module_id: string; variant_key: string; panel: string }[];
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const panel = parseJson(row.panel);
    // A picture's address stays here; the wall is given its handle (M7.5).
    if (panel !== null) out[variantBlockKey(row.module_id, row.variant_key)] = panelForWall(row.module_id, panel);
  }
  return out;
}

/** A good read of a variant: its panel, and the error cleared. */
export function writeModuleVariantPanel(db: SqliteDatabase, moduleId: string, key: string, panel: unknown, at: number): void {
  db.prepare(
    `INSERT INTO external_module_variants (module_id, variant_key, panel, last_polled_at, last_error)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (module_id, variant_key) DO UPDATE SET panel = excluded.panel,
       last_polled_at = excluded.last_polled_at, last_error = NULL`,
  ).run(moduleId, key, JSON.stringify(panel), at);
}

/** A failed read of a variant: the error, and its last good panel kept. */
export function writeModuleVariantError(db: SqliteDatabase, moduleId: string, key: string, error: string, at: number): void {
  db.prepare(
    `INSERT INTO external_module_variants (module_id, variant_key, panel, last_polled_at, last_error)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (module_id, variant_key) DO UPDATE SET last_polled_at = excluded.last_polled_at,
       last_error = excluded.last_error`,
  ).run(moduleId, key, at, error);
}

/** Forget the variants no placed widget names any more. */
export function pruneModuleVariants(db: SqliteDatabase, moduleId: string, keep: ReadonlySet<string>): void {
  for (const row of readModuleVariants(db, moduleId)) {
    if (!keep.has(row.variantKey)) {
      db.prepare(`DELETE FROM external_module_variants WHERE module_id = ? AND variant_key = ?`).run(
        moduleId,
        row.variantKey,
      );
    }
  }
}

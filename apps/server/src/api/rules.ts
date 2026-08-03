import {
  DEFAULT_ALERT_RULES,
  type EntityCondition,
  type InterruptAction,
  type InterruptRule,
  type InterruptSource,
  type RuleMatch,
  type Severity,
  type TimeWindow,
  type Urgency,
} from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Interrupt rules, between the database and the pure evaluator.
 *
 * Everything that decides *whether* a rule fires lives in
 * `packages/core/domain/interrupts`. This file only turns rows into that shape
 * and back, and it is where a row somebody hand-edited stops being trusted — a
 * rule that will not parse is dropped here rather than defended against inside
 * the evaluator, because this is the side of the boundary that knows a column
 * is a column.
 */

const SEVERITIES: readonly string[] = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const URGENCIES: readonly string[] = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
const ACTIONS: readonly string[] = ['none', 'banner', 'takeover', 'takeover_and_wake'];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * The stored source name, tolerating the older spellings.
 *
 * The column is still called `trigger` and once held `ha_entity`,
 * `weather_alert` and `calendar_event`. Renaming a column means rebuilding the
 * table, and a rebuild on a household's live database is the one migration that
 * can destroy something — so the values moved and the name did not, and this
 * accepts both. It is four lines against a data migration.
 */
export function readSource(stored: string): InterruptSource | undefined {
  switch (stored) {
    case 'nws':
    case 'weather_alert':
      return 'nws';
    case 'homeassistant':
    case 'ha_entity':
      return 'homeassistant';
    case 'calendar':
    case 'calendar_event':
      return 'calendar';
    case 'manual':
      return 'manual';
    default:
      return undefined;
  }
}

function window(raw: unknown): TimeWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const from = record['from'];
  const to = record['to'];
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!HHMM.test(from) || !HHMM.test(to)) return null;
  // Both the same is a zero-length window that could never match. Somebody who
  // did that meant a whole day far more often than no day at all.
  return from === to ? null : { from, to };
}

function condition(raw: unknown): EntityCondition | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = record['kind'] ?? record['condition'];
  if (kind !== 'equals' && kind !== 'above' && kind !== 'below' && kind !== 'changed_to') {
    return undefined;
  }
  const value = record['value'];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return { kind, value: String(value), between: window(record['between']) };
}

/**
 * Read the stored match, in either shape.
 *
 * Rules written before the model gained severity stored a flat
 * `{entityId, condition, value, forSeconds, between}`. Converting them here
 * rather than migrating the rows keeps the upgrade to ADD COLUMN statements,
 * which cannot lose anything.
 */
export function readMatch(raw: unknown): { match: RuleMatch; legacyDwellSec: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  // The old flat shape: a condition at the top level rather than under `match`.
  if (typeof record['condition'] === 'string') {
    const entityId = record['entityId'] ?? record['key'];
    const parsed = condition(record);
    if (typeof entityId !== 'string' || parsed === undefined) return undefined;
    const forSeconds = record['forSeconds'];
    return {
      match: { entityId, condition: parsed },
      legacyDwellSec: typeof forSeconds === 'number' && forSeconds > 0 ? Math.round(forSeconds) : 0,
    };
  }

  const match: {
    eventTypes?: readonly string[];
    minSeverity?: Severity;
    minUrgency?: Urgency;
    entityId?: string;
    condition?: EntityCondition;
    startsWithinSec?: number;
  } = {};

  const eventTypes = record['eventTypes'];
  if (Array.isArray(eventTypes)) {
    const names = eventTypes.filter((name): name is string => typeof name === 'string' && name !== '');
    if (names.length > 0) match.eventTypes = names;
  }

  const minSeverity = record['minSeverity'];
  if (typeof minSeverity === 'string' && SEVERITIES.includes(minSeverity)) {
    match.minSeverity = minSeverity as Severity;
  }

  const minUrgency = record['minUrgency'];
  if (typeof minUrgency === 'string' && URGENCIES.includes(minUrgency)) {
    match.minUrgency = minUrgency as Urgency;
  }

  const entityId = record['entityId'];
  if (typeof entityId === 'string' && entityId !== '') match.entityId = entityId;

  const nested = condition(record['condition']);
  if (nested !== undefined) match.condition = nested;

  const startsWithin = record['startsWithinSec'];
  if (typeof startsWithin === 'number' && startsWithin > 0) {
    match.startsWithinSec = Math.round(startsWithin);
  }

  return { match, legacyDwellSec: 0 };
}

interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: number;
  readonly trigger: string;
  readonly conditions: string | null;
  readonly action: string;
  readonly priority: number;
  readonly piercesNightMode: number;
  readonly minDwellSec: number;
  readonly dismissible: number;
  readonly reassertAfterSec: number | null;
}

const SELECT_RULES = `SELECT id, name, enabled, trigger, conditions, action, priority,
        pierces_night_mode AS piercesNightMode, min_dwell_sec AS minDwellSec,
        dismissible, reassert_after_sec AS reassertAfterSec
   FROM interrupt_rules ORDER BY priority DESC, name`;

/** Every rule, including disabled ones, for the settings screen. */
export function readRuleRows(db: SqliteDatabase): RuleRow[] {
  return db.prepare(SELECT_RULES).all() as RuleRow[];
}

/** The rules the evaluator sees: parseable, whatever their enabled state. */
export function readRules(db: SqliteDatabase): InterruptRule[] {
  const rules: InterruptRule[] = [];

  for (const row of readRuleRows(db)) {
    const source = readSource(row.trigger);
    if (source === undefined) continue;

    let raw: unknown;
    try {
      raw = row.conditions === null ? null : JSON.parse(row.conditions);
    } catch {
      continue;
    }
    const parsed = readMatch(raw);
    if (parsed === undefined) continue;

    const action = ACTIONS.includes(row.action) ? (row.action as InterruptAction) : 'banner';
    // A legacy row's `forSeconds` becomes the dwell it always meant.
    const dwell = row.minDwellSec > 0 ? row.minDwellSec : parsed.legacyDwellSec;

    rules.push({
      id: row.id,
      source,
      name: row.name,
      enabled: row.enabled === 1,
      match: parsed.match,
      action,
      piercesNightMode: row.piercesNightMode === 1,
      minDwellSec: dwell,
      dismissible: row.dismissible === 1,
      ...(row.reassertAfterSec !== null ? { reassertAfterSec: row.reassertAfterSec } : {}),
      priority: row.priority,
    });
  }

  return rules;
}

export interface SaveRuleInput extends Omit<InterruptRule, 'id'> {
  readonly id?: string;
}

export function writeRule(db: SqliteDatabase, rule: InterruptRule): void {
  const at = Date.now();
  db.prepare(
    `INSERT INTO interrupt_rules
       (id, name, enabled, trigger, conditions, action, priority, wake_screen,
        pierces_night_mode, min_dwell_sec, dismissible, reassert_after_sec,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, enabled = excluded.enabled, trigger = excluded.trigger,
       conditions = excluded.conditions, action = excluded.action,
       priority = excluded.priority, wake_screen = excluded.wake_screen,
       pierces_night_mode = excluded.pierces_night_mode,
       min_dwell_sec = excluded.min_dwell_sec, dismissible = excluded.dismissible,
       reassert_after_sec = excluded.reassert_after_sec, updated_at = excluded.updated_at`,
  ).run(
    rule.id,
    rule.name,
    rule.enabled ? 1 : 0,
    rule.source,
    JSON.stringify(rule.match),
    rule.action,
    rule.priority,
    // Kept in step with `action` rather than asked about separately. Two
    // controls for one decision is how they end up disagreeing.
    rule.action === 'takeover_and_wake' ? 1 : 0,
    rule.piercesNightMode ? 1 : 0,
    rule.minDwellSec,
    rule.dismissible ? 1 : 0,
    rule.reassertAfterSec ?? null,
    at,
    at,
  );
}

export function deleteRule(db: SqliteDatabase, id: string): boolean {
  return db.prepare('DELETE FROM interrupt_rules WHERE id = ?').run(id).changes > 0;
}

export function setRuleEnabled(db: SqliteDatabase, id: string, enabled: boolean): void {
  db.prepare('UPDATE interrupt_rules SET enabled = ?, updated_at = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
}

/**
 * Put the shipped weather rules in, once.
 *
 * `DO NOTHING` on conflict, so a household who turned the Extreme rule off, or
 * changed what Severe does, keeps their decision across every future restart.
 * A seed that overwrote would quietly undo somebody's settings on upgrade, and
 * they would have no way to know why the wall started shouting again.
 */
export function seedDefaultRules(db: SqliteDatabase): void {
  const at = Date.now();
  const insert = db.prepare(
    `INSERT INTO interrupt_rules
       (id, name, enabled, trigger, conditions, action, priority, wake_screen,
        pierces_night_mode, min_dwell_sec, dismissible, reassert_after_sec,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );

  const seed = db.transaction(() => {
    for (const rule of DEFAULT_ALERT_RULES) {
      insert.run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.source,
        JSON.stringify(rule.match),
        rule.action,
        rule.priority,
        rule.action === 'takeover_and_wake' ? 1 : 0,
        rule.piercesNightMode ? 1 : 0,
        rule.minDwellSec,
        rule.dismissible ? 1 : 0,
        rule.reassertAfterSec ?? null,
        at,
        at,
      );
    }
  });
  seed();
}

// ---------------------------------------------------------------------------
// Dismissals
// ---------------------------------------------------------------------------

/** What has been cleared, keyed `ruleId:signalKey`. */
export function readDismissals(db: SqliteDatabase): Record<string, number> {
  const rows = db
    .prepare('SELECT key, dismissed_at AS dismissedAt FROM interrupt_dismissals')
    .all() as { key: string; dismissedAt: number }[];
  const dismissals: Record<string, number> = {};
  for (const row of rows) dismissals[row.key] = row.dismissedAt;
  return dismissals;
}

export function dismissInterrupt(db: SqliteDatabase, key: string, at = Date.now()): void {
  db.prepare(
    `INSERT INTO interrupt_dismissals (key, dismissed_at) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
  ).run(key, at);
}

/**
 * Forget dismissals for signals that are no longer live.
 *
 * Without this the table grows one row per warning for ever, and — worse — a
 * dismissal would still be sitting there if the same CAP identifier ever came
 * back. Run from the same job that reconciles the alerts, because that is the
 * moment the live set is known.
 */
export function pruneDismissals(db: SqliteDatabase, liveKeys: readonly string[]): void {
  const rows = db.prepare('SELECT key FROM interrupt_dismissals').all() as { key: string }[];
  const live = new Set(liveKeys);
  const remove = db.prepare('DELETE FROM interrupt_dismissals WHERE key = ?');
  const prune = db.transaction(() => {
    for (const row of rows) {
      // The stored key is `ruleId:signalKey`; the signal key is what expires.
      const separator = row.key.indexOf(':');
      const signalKey = separator < 0 ? row.key : row.key.slice(separator + 1);
      if (!live.has(signalKey)) remove.run(row.key);
    }
  });
  prune();
}

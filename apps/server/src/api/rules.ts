import {
  DEFAULT_ALERT_RULES,
  type InterruptAction,
  type InterruptRule,
  type InterruptSource,
  type RuleMatch,
} from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import { parseOr, z } from '../validation.js';

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

const ACTIONS: readonly string[] = ['none', 'banner', 'takeover', 'takeover_and_wake'];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * A stored rule's `conditions` column.
 *
 * This is a boundary like any other, and an unusual one: the value did not
 * come from a person or a server but from *an older version of this code*, or
 * from somebody with a SQLite client. Both are outside this process, so both
 * get validated.
 *
 * Two shapes are accepted on purpose. The nested one is what is written today;
 * the flat one is what rules written before the model gained severity look
 * like, and converting them here rather than migrating the rows keeps the
 * upgrade to `ADD COLUMN` statements, which cannot lose anything.
 */
const timeWindow = z
  .object({ from: z.string().regex(HHMM), to: z.string().regex(HHMM) })
  // Both the same is a zero-length window that could never match. Somebody who
  // did that meant a whole day far more often than no day at all.
  .refine((w) => w.from !== w.to)
  .nullish()
  .catch(null)
  .transform((w) => w ?? null);

const conditionKind = z.enum(['equals', 'above', 'below', 'changed_to']);

/** `value` arrives as a number from `<input type=number>` and a hand edit. */
const conditionValue = z.union([z.string(), z.number().transform(String)]);

const nestedCondition = z.object({
  kind: conditionKind,
  value: conditionValue,
  between: timeWindow,
});

const flatCondition = z.looseObject({
  entityId: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  condition: conditionKind,
  value: conditionValue,
  between: timeWindow,
  forSeconds: z.number().nullish().catch(null),
});

const nestedMatch = z.looseObject({
  eventTypes: z.array(z.string().min(1)).min(1).optional(),
  minSeverity: z.enum(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']).optional(),
  minUrgency: z.enum(['Immediate', 'Expected', 'Future', 'Past', 'Unknown']).optional(),
  entityId: z.string().min(1).optional(),
  condition: nestedCondition.optional(),
  startsWithinSec: z.number().positive().optional(),
});

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
      // A module rule's trigger is its own source, `ext:<id>`, stored verbatim.
      // It round-trips through the same column with no legacy spelling to map.
      return stored.startsWith('ext:') ? (stored as InterruptSource) : undefined;
  }
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
  // The older flat shape first: it is recognised by a `condition` that is a
  // string rather than an object.
  const flat = flatCondition.safeParse(raw);
  if (flat.success) {
    const entityId = flat.data.entityId ?? flat.data.key;
    if (entityId === undefined) return undefined;
    const legacy = flat.data.forSeconds;
    return {
      match: {
        entityId,
        condition: { kind: flat.data.condition, value: flat.data.value, between: flat.data.between },
      },
      legacyDwellSec: typeof legacy === 'number' && legacy > 0 ? Math.round(legacy) : 0,
    };
  }

  const shaped = nestedMatch.safeParse(raw);
  if (!shaped.success) return undefined;
  const data = shaped.data;

  /*
   * Rebuilt field by field rather than passed through.
   *
   * `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the
   * same as an absent key — and `matches` in core decides "this rule says
   * nothing" by counting which clauses are present.
   */
  const match: RuleMatch = {
    ...(data.eventTypes !== undefined ? { eventTypes: data.eventTypes } : {}),
    ...(data.minSeverity !== undefined ? { minSeverity: data.minSeverity } : {}),
    ...(data.minUrgency !== undefined ? { minUrgency: data.minUrgency } : {}),
    ...(data.entityId !== undefined ? { entityId: data.entityId } : {}),
    ...(data.condition !== undefined ? { condition: data.condition } : {}),
    ...(data.startsWithinSec !== undefined
      ? { startsWithinSec: Math.round(data.startsWithinSec) }
      : {}),
  };

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

    const parsed = readMatch(parseOr(z.unknown(), safeJson(row.conditions), null));
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

/** JSON from a column, which may not be JSON at all. */
function safeJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
 * The one rule a module's signals are allowed to fire, kept in step with the
 * household's per-module choice.
 *
 * A module cannot write a rule — that is the point. Instead the household picks
 * `banner` or `takeover` on the module's card, and this maintains a single
 * source-scoped rule so the existing evaluator does all the work (dwell,
 * dismissal, night mode, conflict resolution) with no module-specific path.
 *
 * Every field here is a guardrail, not a default:
 *   - `source` is `ext:<id>`, so this rule can only ever match *this* module's
 *     signals — never a weather warning, never another module.
 *   - `match` is the lowest severity bar, which every signal clears, so the
 *     module itself decides what is worth showing. It is not empty: an empty
 *     match matches nothing by design.
 *   - `piercesNightMode` is hard `false` and the action can never be
 *     `takeover_and_wake` (the caller's type forbids it). A third-party module
 *     may cover the wall when someone is looking at it; it may not light a dark
 *     bedroom. That is reserved for genuine safety like a tornado warning.
 *   - `dismissible` is hard `true`: whatever a module shows, the household can
 *     always clear it from the wall.
 *
 * The id is colon-free (`extrule-<id>`, not `ext:<id>`) on purpose: the wall's
 * dismiss endpoint splits the acknowledgement key on its first colon to recover
 * the rule id, so a colon in the id would break dismissal.
 */
export function moduleAlertRuleId(moduleId: string): string {
  return `extrule-${moduleId}`;
}

export function syncModuleAlertRule(
  db: SqliteDatabase,
  input: { moduleId: string; moduleName: string; action: 'none' | 'banner' | 'takeover' },
): void {
  const id = moduleAlertRuleId(input.moduleId);
  if (input.action === 'none') {
    deleteRule(db, id);
    return;
  }
  writeRule(db, {
    id,
    source: `ext:${input.moduleId}`,
    name: `${input.moduleName} alerts`,
    enabled: true,
    // Present (so `matches` does not treat it as a half-written rule) and the
    // lowest bar (so every signal the module emits clears it).
    match: { minSeverity: 'Unknown' },
    action: input.action,
    piercesNightMode: false,
    minDwellSec: 0,
    dismissible: true,
    // Below the built-in weather rules: a module alert must never outrank a
    // real warning. Severity outranks priority anyway, but this settles ties.
    priority: 0,
  });
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

export function dismissInterrupt(
  db: SqliteDatabase,
  source: string,
  key: string,
  at = Date.now(),
): void {
  db.prepare(
    `INSERT INTO interrupt_dismissals (key, source, dismissed_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET source = excluded.source, dismissed_at = excluded.dismissed_at`,
  ).run(key, source, at);
}

/**
 * Forget dismissals for signals that are no longer live.
 *
 * Without this the table grows one row per warning for ever, and — worse — a
 * dismissal would still be sitting there if the same CAP identifier ever came
 * back. Run from the same job that reconciles the alerts, because that is the
 * moment the live set is known.
 *
 * Scoped to `source`: this is called from the NWS alerts job, which knows
 * only its own CAP keys, every sixty seconds. Reaping every row not in that
 * list — regardless of where it came from — undid a Home Assistant, calendar
 * or module dismissal within the minute of it being acknowledged. A row with
 * no source (written before this column existed) is left alone rather than
 * guessed at, the same as a row from a different source.
 */
export function pruneDismissals(db: SqliteDatabase, source: string, liveKeys: readonly string[]): void {
  const rows = db
    .prepare('SELECT key FROM interrupt_dismissals WHERE source = ?')
    .all(source) as { key: string }[];
  const live = new Set(liveKeys);
  const remove = db.prepare('DELETE FROM interrupt_dismissals WHERE key = ?');
  const prune = db.transaction(() => {
    // The stored key *is* the signal key, so this is a direct comparison.
    for (const row of rows) {
      if (!live.has(row.key)) remove.run(row.key);
    }
  });
  prune();
}

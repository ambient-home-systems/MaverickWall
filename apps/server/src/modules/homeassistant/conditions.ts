import type { SqliteDatabase } from '../../db/open.js';
import { z } from '../../validation.js';
import {
  CONDITION_ENTITY_PATTERN,
  conditionReadingFrom,
  isMomentEntity,
  type ConditionReading,
  type Conditions,
} from '../../api/show-when.js';

/**
 * The states of the entities widgets are shown by (plan items M6.4, M6.5,
 * M6.7) — read out of the `/api/states` body the Home Assistant poll already
 * fetches, so a condition costs no request of its own.
 */

/**
 * Every entity a stored widget names in `showWhen`, on any wall, any canvas,
 * any named layout. Asked of the rows themselves, so a widget deleted is an
 * entity no longer read and its row goes on the next poll.
 */
export function conditionEntities(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(config, '$.showWhen.entity') AS entityId FROM layout_widgets
        WHERE json_valid(config) AND json_extract(config, '$.showWhen.entity') IS NOT NULL`,
    )
    .all() as { entityId: unknown }[];
  const found = new Set<string>();
  for (const row of rows) {
    if (typeof row.entityId === 'string' && CONDITION_ENTITY_PATTERN.test(row.entityId)) found.add(row.entityId);
  }
  return found;
}

const stateRow = z.object({
  entity_id: z.string().max(255),
  state: z.string().max(255),
  last_changed: z.string().max(64).optional(),
});

/** The wanted entities' readings in a `/api/states` body. A row of the wrong shape is skipped. */
export function readConditionStates(
  body: string,
  wanted: ReadonlySet<string>,
  readAt: number,
): Map<string, ConditionReading> {
  const found = new Map<string, ConditionReading>();
  if (wanted.size === 0) return found;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return found;
  }
  if (!Array.isArray(raw)) return found;
  for (const item of raw) {
    const row = stateRow.safeParse(item);
    if (!row.success || !wanted.has(row.data.entity_id)) continue;
    const reading = conditionReadingFrom(row.data, readAt);
    if (reading !== undefined) found.set(row.data.entity_id, reading);
  }
  return found;
}

/**
 * Keep exactly the wanted entities. An entity Home Assistant stopped listing
 * keeps its last row, which goes stale and then reads as "not in the state";
 * one no widget names any more is forgotten.
 */
export function writeConditionStates(
  db: SqliteDatabase,
  readings: ReadonlyMap<string, ConditionReading>,
  wanted: ReadonlySet<string>,
): void {
  const upsert = db.prepare(
    `INSERT INTO ha_condition_states (entity_id, state, changed_at, read_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at,
         read_at = excluded.read_at`,
  );
  for (const [entityId, reading] of readings) upsert.run(entityId, reading.state, reading.changedAt, reading.readAt);
  const held = db.prepare('SELECT entity_id AS entityId FROM ha_condition_states').all() as { entityId: string }[];
  const drop = db.prepare('DELETE FROM ha_condition_states WHERE entity_id = ?');
  for (const row of held) if (!wanted.has(row.entityId)) drop.run(row.entityId);
}

/**
 * The house's state for the omission, at `now`, on a wall or a panel. Taking
 * the caller's clock rather than reading one, as `addCalendarSource` does: two
 * clocks is how a pulse ends on the wall a minute before it ends here.
 */
export function readConditions(db: SqliteDatabase, now: number, panel = false): Conditions {
  const rows = db
    .prepare('SELECT entity_id AS entityId, state, changed_at AS changedAt, read_at AS readAt FROM ha_condition_states')
    .all() as { entityId: string; state: string; changedAt: number; readAt: number }[];
  const readings: Record<string, ConditionReading> = {};
  for (const row of rows) readings[row.entityId] = { state: row.state, changedAt: row.changedAt, readAt: row.readAt };
  return { readings, now, ...(panel ? { panel: true } : {}) };
}

/** The states each domain is commonly in, offered beside the entity's own. */
const DOMAIN_STATES: Readonly<Record<string, readonly string[]>> = {
  alarm_control_panel: ['disarmed', 'armed_home', 'armed_away', 'armed_night', 'triggered'],
  binary_sensor: ['on', 'off'],
  climate: ['heat', 'cool', 'heat_cool', 'auto', 'off'],
  cover: ['open', 'closed', 'opening', 'closing'],
  device_tracker: ['home', 'not_home'],
  fan: ['on', 'off'],
  input_boolean: ['on', 'off'],
  light: ['on', 'off'],
  lock: ['locked', 'unlocked'],
  media_player: ['playing', 'paused', 'idle', 'on', 'off'],
  person: ['home', 'not_home'],
  sun: ['above_horizon', 'below_horizon'],
  switch: ['on', 'off'],
  timer: ['active', 'paused', 'idle'],
  vacuum: ['cleaning', 'docked', 'returning'],
};

/** The domains whose state can say whether a box is wanted. */
const CONDITION_DOMAINS: ReadonlySet<string> = new Set([
  ...Object.keys(DOMAIN_STATES),
  'button',
  'calendar',
  'event',
  'input_button',
  'input_select',
  'schedule',
  'select',
  'sensor',
]);

export interface ConditionChoice {
  readonly id: string;
  readonly name: string;
  /** What it says now, then the domain's usual states — never for an event, whose state is a time. */
  readonly states: readonly string[];
  /** An `event`, `button` or `input_button`: shown for a while after it happens, never "while". */
  readonly moment: boolean;
}

const choiceRow = z.object({
  entity_id: z.string().max(255),
  state: z.string().max(255),
  attributes: z.object({ friendly_name: z.string().max(255).optional() }).passthrough().optional(),
});

/** The house's entities a widget may be shown by, by name, for the editor's picker. */
export function conditionChoices(body: string): ConditionChoice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const found: ConditionChoice[] = [];
  for (const item of raw) {
    const row = choiceRow.safeParse(item);
    if (!row.success || !CONDITION_ENTITY_PATTERN.test(row.data.entity_id)) continue;
    const domain = row.data.entity_id.slice(0, row.data.entity_id.indexOf('.'));
    if (!CONDITION_DOMAINS.has(domain)) continue;
    const moment = isMomentEntity(row.data.entity_id);
    const states = moment
      ? []
      : [...new Set([row.data.state, ...(DOMAIN_STATES[domain] ?? [])])].filter(
          (state) => state !== '' && state !== 'unavailable' && state !== 'unknown' && state.length <= 64,
        );
    found.push({ id: row.data.entity_id, name: row.data.attributes?.friendly_name ?? row.data.entity_id, states, moment });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 2000);
}

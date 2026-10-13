import type { SqliteDatabase } from '../../db/open.js';
import type { Signal } from '@maverick-wall/core';
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
  for (const entityId of ruleMoments(db)) found.add(entityId);
  return found;
}

/**
 * The moments a "Tell me when…" rule names (plan item M6.3): a doorbell's
 * `event` entity, a `button`, an `input_button`. None of them is a reading —
 * a reading is a state somebody is in, and these are an instant — so the
 * readings' poll never keeps them, and they are read here, beside the
 * entities a widget is shown by, out of the same body. Enabled or not: a rule
 * switched back on has its last ring to hand rather than none.
 */
export function ruleMoments(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(conditions, '$.entityId') AS entityId FROM interrupt_rules
        WHERE trigger IN ('homeassistant', 'ha_entity') AND json_valid(conditions)
          AND json_extract(conditions, '$.entityId') IS NOT NULL`,
    )
    .all() as { entityId: unknown }[];
  const found = new Set<string>();
  for (const row of rows) {
    if (typeof row.entityId === 'string' && CONDITION_ENTITY_PATTERN.test(row.entityId) && isMomentEntity(row.entityId)) {
      found.add(row.entityId);
    }
  }
  return found;
}

const stateRow = z.object({
  entity_id: z.string().max(255),
  state: z.string().max(255),
  last_changed: z.string().max(64).optional(),
  attributes: z.looseObject({ friendly_name: z.string().max(255).optional().catch(undefined) }).optional().catch(undefined),
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
    const name = row.data.attributes?.friendly_name;
    if (reading !== undefined) found.set(row.data.entity_id, name === undefined ? reading : { ...reading, name });
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
    // `noticed_at` moves only when the state does: it is when we first heard.
    `INSERT INTO ha_condition_states (entity_id, state, changed_at, read_at, friendly_name, noticed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         noticed_at = CASE WHEN ha_condition_states.state = excluded.state
                           THEN ha_condition_states.noticed_at ELSE excluded.noticed_at END,
         state = excluded.state, changed_at = excluded.changed_at,
         read_at = excluded.read_at, friendly_name = excluded.friendly_name`,
  );
  for (const [entityId, reading] of readings) {
    upsert.run(entityId, reading.state, reading.changedAt, reading.readAt, reading.name ?? null, reading.readAt);
  }
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

/**
 * How late a ring may be heard and still count as news (plan item M6.3): a
 * poll's interval and its lag, with room over. A ring first seen later than
 * this — a server that has just started, a Home Assistant that has just come
 * back — is history, and keeps its own instant, so it is already over.
 */
export const RING_HEARD_LATE_MS = 2 * 60_000;

/**
 * The moments a rule names, as signals (plan item M6.3): a doorbell's ring is
 * the instant in its `event` entity's state. `since` is that instant, or when
 * our poll first heard of it if that was later and within `RING_HEARD_LATE_MS`
 * — so a held rule shows for its whole time even when the poll caught the ring
 * thirty seconds late, and every wall still takes it down at one moment.
 * Believed however old the poll, as a widget's pulse is: a stale read does not
 * unmake a press. Never the entity id as the title — Home Assistant's name, or
 * plain words when it has none.
 */
export function momentSignals(db: SqliteDatabase): Signal[] {
  const wanted = ruleMoments(db);
  if (wanted.size === 0) return [];
  const rows = db
    .prepare(
      'SELECT entity_id AS entityId, state, friendly_name AS name, noticed_at AS noticedAt FROM ha_condition_states',
    )
    .all() as { entityId: string; state: string; name: string | null; noticedAt: number | null }[];
  const found: Signal[] = [];
  for (const row of rows) {
    if (!wanted.has(row.entityId)) continue;
    const rang = Date.parse(row.state);
    const heard = row.noticedAt;
    const at =
      Number.isFinite(rang) && heard !== null && heard > rang && heard - rang <= RING_HEARD_LATE_MS ? heard : rang;
    found.push({
      source: 'homeassistant',
      key: row.entityId,
      title: row.name ?? (row.entityId.startsWith('event.') ? 'The doorbell' : 'A button'),
      state: row.state,
      since: Number.isFinite(at) ? at : null,
    });
  }
  return found;
}

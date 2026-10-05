import { z } from 'zod';
import type { Fetcher } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { haReadingHandle, readingEntityIds } from '../../api/manifest.js';
import { buildCall, call, callService, resolveConnection } from './client.js';
import { cachedAttributes, parseStates } from './entities.js';
import {
  WALL_ACTIONS,
  WALL_ACTION_VALUES,
  sceneReachesNever,
  wallActionKey,
  wallActionsFor,
} from './services.js';
import { watchedReadingChoices } from './store.js';

/**
 * A wall operating something in the house (RFC 018 §8, phase 2).
 *
 * `/d/ha/act` is a thin route over `operate` below, for the reason
 * `widget-options.ts` and `ink.ts` are pure modules: a policy that lives inside
 * a handler is a policy a test can only reach through a server, one case at a
 * time. This is built from `/d/todo/tick` — the same gate, the same "the server
 * is the authority, not the button", the same write-through and re-poll — and
 * differs from it in what it checks before anything leaves.
 *
 * **The checks run in RFC 018's order, cheapest first**, and the order decides
 * which sentence a household reads:
 *
 *  1. the wall may operate things at all (`screens.allow_control`);
 *  2. the reading exists — the handle resolves to a watched entity;
 *  3. the household marked it controllable on the Readings screen;
 *  4. the widget the press came from is on this wall, set to act, and shows
 *     this reading;
 *  5. the wall's word is an action with a route for this entity's domain;
 *  6. the rate: twenty presses a minute per wall, one in flight per entity;
 *  7. the entity is *still* eligible, from its state re-read now — a light that
 *     an integration has since reported as something else is refused here,
 *     and its controllable flag cleared.
 *
 * Only then does `buildCall` make the one call and `callService` send it. The
 * wall never sends service data: it sends a handle, a widget id and a word.
 */

/**
 * What a wall may post to `/d/ha/act`: a handle, a widget id, a word. Bounded
 * by shape — a handle is `haReadingHandle`'s hex, a widget id is the editor's,
 * and the word is one this module has a table for — and refused rather than
 * coerced (rule five). Whether the word has a route for *this* entity is
 * `wallActionKey`'s question, asked later, because the answer depends on the
 * reading.
 */
export const haActBody = z.object({
  reading: z.string().regex(/^[0-9a-f]{16}$/),
  widget: z.string().min(1).max(64),
  action: z.string().refine((word) => Object.prototype.hasOwnProperty.call(WALL_ACTIONS, word)),
  /*
   * A number, or three numbers for a colour — and nothing else (RFC 018 §8.1).
   * Arrives as the form's text, so its *shape* is checked here and its bounds
   * by `buildCall`, which knows the light's own range. Whether this word takes
   * one at all is `valueFor`'s question.
   */
  value: z
    .string()
    .regex(/^(\d{1,5}|\d{1,3},\d{1,3},\d{1,3})$/)
    .optional(),
});

/**
 * The wall's value, turned into the shape the word takes — or `null` when the
 * two disagree: a word that takes no value sent one, a word that takes one sent
 * none, or a number arrived where a colour belongs. Refused rather than
 * coerced (rule five), with the 400 that goes with it.
 */
export function valueFor(action: string, raw: string | undefined): number | readonly number[] | undefined | null {
  const shape = WALL_ACTION_VALUES[action];
  if (shape === undefined) return raw === undefined ? undefined : null;
  if (raw === undefined) return null;
  const parts = raw.split(',').map(Number);
  if (shape === 'rgb') return parts.length === 3 ? parts : null;
  return parts.length === 1 ? (parts[0] as number) : null;
}

/** RFC 018 OQ7, decided: twenty presses a minute per wall. */
export const PRESSES_PER_MINUTE = 20;

/** RFC 018 OQ8, decided: fourteen days of history, admin only. */
export const HISTORY_MS = 14 * 24 * 60 * 60_000;

export interface OperateContext {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  readonly now: number;
}

export interface OperateInput {
  readonly screenId: string;
  readonly allowControl: boolean;
  /** The reading's handle, as the wall received it. */
  readonly reading: string;
  /** The widget the press landed in. */
  readonly widget: string;
  /** The wall's word for what to do: `toggle`, `brightness`, `position` and so on. */
  readonly action: string;
  /** A percentage, a kelvin or a colour, already in the word's shape (`valueFor`). */
  readonly value?: number | readonly number[];
}

export type OperateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 409 | 429 | 502;
      readonly error: string;
      readonly message: string;
    };

const NOT_ALLOWED = 'This wall cannot operate things in the house.';
const NOT_HERE = 'That is not on this wall any more.';
const NOT_CONTROLLABLE = "That can't be operated from a wall.";
const NOT_ANY_MORE = "That can't be operated from a wall any more.";
const TOO_MANY = 'Too many presses. Try again in a moment.';

/*
 * The rate's memory. In-process and forgotten at a restart, which is the right
 * size of thing: it exists to stop a stuck finger or a looping script hammering
 * a house, not to be an audit, and the audit is the table below.
 */
const recent = new Map<string, number[]>();
const inFlight = new Set<string>();

/** For the tests' sake: forget the rate between cases. */
export function resetOperateLimits(): void {
  recent.clear();
  inFlight.clear();
}

function refused(
  status: 400 | 403 | 404 | 409 | 429 | 502,
  error: string,
  message: string,
): OperateResult {
  return { ok: false, status, error, message };
}

interface Candidate {
  readonly entityId: string;
  readonly controllable: number;
}

/** Whether the widget the press came from may act on this entity. */
function widgetActs(db: SqliteDatabase, screenId: string, widgetId: string, entityId: string): boolean {
  const row = db
    .prepare(`SELECT type, config FROM layout_widgets WHERE id = ? AND screen_id = ?`)
    .get(widgetId, screenId) as { type: string; config: string | null } | undefined;
  if (row === undefined || row.type !== 'homeassistant' || row.config === null) return false;
  let config: unknown;
  try {
    config = JSON.parse(row.config);
  } catch {
    return false;
  }
  if (typeof config !== 'object' || config === null) return false;
  const c = config as Record<string, unknown>;
  if (c['tapAction'] !== 'act') return false;
  // No `readings` list, or an empty one, is "all of them" — the wall's own
  // reading of it (`houseReadingsFor`), so a press can only come from a reading
  // the widget actually draws.
  const shown = readingEntityIds(c['readings'], watchedReadingChoices(db));
  return shown === undefined || shown.length === 0 || shown.includes(entityId);
}

/**
 * Whether a scene may be run from a wall, from the house as it is now: its
 * members, each judged by the never-list. `ok: false` carries the sentence —
 * naming the member, in the household's words — or Home Assistant's own when
 * the house could not be asked, which is refused too: a check that cannot run
 * is not a pass.
 */
export async function checkScene(
  fetcher: Fetcher,
  connection: Parameters<typeof call>[1],
  sceneAttributes: unknown,
): Promise<{ ok: true } | { ok: false; reaches: boolean; message: string }> {
  const answer = await call(fetcher, connection, '/states');
  if (!answer.ok) return { ok: false, reaches: false, message: answer.message };
  let states: unknown;
  try {
    states = JSON.parse(answer.body);
  } catch {
    return { ok: false, reaches: false, message: 'Home Assistant answered in a way Maverick Wall could not read.' };
  }
  const byId = new Map<string, { deviceClass: string | null; name: string }>();
  if (Array.isArray(states)) {
    for (const entry of states) {
      if (typeof entry !== 'object' || entry === null) continue;
      const id = (entry as Record<string, unknown>)['entity_id'];
      const attributes = (entry as Record<string, unknown>)['attributes'];
      if (typeof id !== 'string') continue;
      const a = typeof attributes === 'object' && attributes !== null ? (attributes as Record<string, unknown>) : {};
      byId.set(id, {
        deviceClass: typeof a['device_class'] === 'string' ? a['device_class'] : null,
        name: typeof a['friendly_name'] === 'string' ? a['friendly_name'].slice(0, 60) : id,
      });
    }
  }
  const member = sceneReachesNever(sceneAttributes, (id) => byId.get(id)?.deviceClass);
  if (member === undefined) return { ok: true };
  if (member === null) {
    return { ok: false, reaches: true, message: 'This scene does not say what it sets, so a wall cannot run it.' };
  }
  return {
    ok: false,
    reaches: true,
    message:
      `This scene sets ${byId.get(member)?.name ?? member}, and a wall can never reach a lock, an alarm, ` +
      `a thermostat or a garage, gate, door or window — so a wall cannot run it.`,
  };
}

/** Read one entity's state now, raw, for the eligibility check and the cache. */
async function readEntity(
  context: OperateContext,
  connection: Parameters<typeof call>[1],
  entityId: string,
): Promise<{ ok: true; attributes: unknown; body: string } | { ok: false; message: string }> {
  const answer = await call(context.fetcher, connection, `/states/${encodeURIComponent(entityId)}`);
  if (!answer.ok) {
    return {
      ok: false,
      message: answer.httpStatus === 404 ? 'That is not in Home Assistant any more.' : answer.message,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { ok: false, message: 'Home Assistant answered in a way Maverick Wall could not read.' };
  }
  const attributes =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['attributes'] : undefined;
  return { ok: true, attributes, body: answer.body };
}

/**
 * Write what Home Assistant says now into the cache, the way the poll does, so
 * the wall's re-poll draws the new state rather than waiting up to a minute.
 * `fetched_at` moves, unlike the to-do write-through: this is a real read of
 * the whole state, not a guess about one field of it.
 */
function writeThrough(db: SqliteDatabase, body: string, at: number): void {
  const [state] = parseStates(`[${body}]`);
  if (state === undefined) return;
  db.prepare(
    `UPDATE ha_entity_cache
        SET state = ?, attributes = ?, friendly_name = ?, unit_of_measurement = ?,
            last_changed_at = ?, fetched_at = ?
      WHERE entity_id = ?`,
  ).run(
    state.state,
    cachedAttributes(state),
    state.friendlyName,
    state.unit,
    state.lastChangedAt,
    at,
    state.entityId,
  );
}

/** Record one press Home Assistant was asked about, and forget the old ones. */
export function recordWallAction(
  db: SqliteDatabase,
  row: { screenId: string; entityId: string; action: string; ok: boolean; message: string | null },
  at: number,
): void {
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO ha_wall_actions (at, screen_id, entity_id, action, ok, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(at, row.screenId, row.entityId, row.action, row.ok ? 1 : 0, row.message);
    db.prepare(`DELETE FROM ha_wall_actions WHERE at < ?`).run(at - HISTORY_MS);
  });
  write();
}

export interface WallActionRow {
  readonly at: number;
  readonly wall: string;
  readonly reading: string;
  readonly action: string;
  readonly ok: boolean;
  readonly message: string | null;
}

/**
 * The last fourteen days of presses, newest first, for the Readings screen.
 * Named by the wall's name and the reading's own label — the household's words —
 * and by the entity id only when both are gone.
 */
export function readWallActions(db: SqliteDatabase, now: number, limit = 50): WallActionRow[] {
  const rows = db
    .prepare(
      `SELECT a.at, a.action, a.ok, a.message,
              COALESCE(s.name, 'A wall that has been removed') AS wall,
              COALESCE(e.label, e.friendly_name, a.entity_id) AS reading
         FROM ha_wall_actions a
         LEFT JOIN screens s ON s.id = a.screen_id
         LEFT JOIN ha_entity_cache e ON e.entity_id = a.entity_id
        WHERE a.at >= ?
        ORDER BY a.at DESC, a.id DESC
        LIMIT ?`,
    )
    .all(now - HISTORY_MS, limit) as {
    at: number;
    action: string;
    ok: number;
    message: string | null;
    wall: string;
    reading: string;
  }[];
  return rows.map((row) => ({ ...row, ok: row.ok === 1 }));
}

/**
 * Operate one entity from one wall, or say why not. Never throws: a wall cannot
 * handle an exception, and a household cannot read a stack trace.
 */
export async function operate(context: OperateContext, input: OperateInput): Promise<OperateResult> {
  const { db } = context;

  // 1. The wall's own switch.
  if (!input.allowControl) return refused(403, 'not-allowed', NOT_ALLOWED);

  // 2. The reading, by its handle. Never an entity id from the wall.
  const candidates = db
    .prepare(`SELECT entity_id AS entityId, controllable FROM ha_entity_cache WHERE watched = 1`)
    .all() as Candidate[];
  const found = candidates.find((row) => haReadingHandle(row.entityId) === input.reading);
  if (found === undefined) return refused(404, 'no-such-reading', NOT_HERE);
  const { entityId } = found;

  // 3. The household's own choice, on the Readings screen.
  if (found.controllable !== 1) return refused(403, 'not-controllable', NOT_CONTROLLABLE);

  // 4. The widget it came from: on this wall, set to act, showing this reading.
  if (!widgetActs(db, input.screenId, input.widget, entityId)) {
    return refused(403, 'widget-does-not-act', NOT_CONTROLLABLE);
  }

  // 5. A word with a route, for this domain. Whether it carries a value in
  // its own shape was the route's question (`valueFor`); its bounds are
  // `buildCall`'s, below, which knows the light's own range.
  const key = wallActionKey(input.action, entityId);
  if (key === undefined) return refused(400, 'bad-action', NOT_CONTROLLABLE);

  // 6. The rate.
  const window = (recent.get(input.screenId) ?? []).filter((at) => context.now - at < 60_000);
  if (window.length >= PRESSES_PER_MINUTE || inFlight.has(entityId)) {
    recent.set(input.screenId, window);
    return refused(429, 'too-many', TOO_MANY);
  }
  window.push(context.now);
  recent.set(input.screenId, window);

  inFlight.add(entityId);
  try {
    const resolved = resolveConnection(db, context.keyring);
    if (!resolved.ok) return refused(502, 'upstream', resolved.message);
    const connection = resolved.connection;

    // 7. Still eligible, from the state as it is now.
    const before = await readEntity(context, connection, entityId);
    if (!before.ok) return refused(502, 'upstream', before.message);
    const built = buildCall({
      key,
      entityId,
      attributes: before.attributes,
      ...(input.value === undefined ? {} : { value: input.value }),
    });
    if (!built.ok) {
      // A value out of the light's own range is the press's fault, not the
      // light's, and says so.
      if (built.code === 'bad-value') return refused(400, 'bad-value', built.message);
      /*
       * The entity no longer supports this — a light whose colour modes an
       * integration narrowed, a blind that lost its position. The flag is
       * cleared only when it has nothing left a wall could do: a light that
       * stopped dimming still switches, and taking that away too would punish
       * the household for something the integration did.
       */
      if (wallActionsFor(entityId, before.attributes).length === 0) {
        db.prepare(`UPDATE ha_entity_cache SET controllable = 0 WHERE entity_id = ?`).run(entityId);
      }
      return refused(409, 'not-eligible', NOT_ANY_MORE);
    }

    /*
     * A scene is everything it sets (RFC 018 phase 4): judged now, member by
     * member, from the house as it is. One that has since been edited to set a
     * lock or a garage door loses its switch, as a blind that became a garage
     * door does.
     */
    if (key === 'scene.run') {
      const scene = await checkScene(context.fetcher, connection, before.attributes);
      if (!scene.ok) {
        if (!scene.reaches) return refused(502, 'upstream', scene.message);
        db.prepare(`UPDATE ha_entity_cache SET controllable = 0 WHERE entity_id = ?`).run(entityId);
        return refused(409, 'not-eligible', NOT_ANY_MORE);
      }
    }

    const answer = await callService(context.fetcher, connection, built.call);
    recordWallAction(
      db,
      {
        screenId: input.screenId,
        entityId,
        action: input.action,
        ok: answer.ok,
        message: answer.ok ? null : answer.message,
      },
      context.now,
    );
    if (!answer.ok) return refused(502, 'upstream', answer.message);

    // The new state, read back and written through, so the re-poll draws it.
    const after = await readEntity(context, connection, entityId);
    if (after.ok) writeThrough(db, after.body, context.now);
    return { ok: true };
  } finally {
    inFlight.delete(entityId);
  }
}

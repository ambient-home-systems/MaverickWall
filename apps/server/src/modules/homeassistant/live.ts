import { FETCH_LIMITS, type Fetcher, type SubscribeOutcome } from '@maverick-wall/core';

import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { CONDITION_ENTITY_PATTERN } from '../../api/show-when.js';
import { parseJsonOr, z } from '../../validation.js';
import { clean } from '../weather/alerts.js';
import { resolveConnection } from './client.js';
import { conditionEntities } from './conditions.js';
import { websocketUrl } from './notifications.js';

/**
 * Home Assistant, heard as it happens.
 *
 * The thirty-second poll is the baseline and stays the baseline: everything a
 * wall knows about the house still arrives through it, parsed and written by
 * the one job that has always done that. What this adds is a WebSocket held
 * open to Home Assistant, subscribed to the entities a wall cares about, so a
 * change there runs that job **now** and nudges every wall to ask again. A
 * doorbell pressed is on the glass in about a second, where it used to wait up
 * to half a minute for the next poll, and a ring that takes thirty seconds to
 * arrive is a visitor who has already walked away.
 *
 * **It cannot be the reason a wall stops knowing anything.** The module header
 * once declined a subscription for exactly that: one that fails to
 * authenticate must not be why a wall goes blind. So this never writes
 * anything itself — an event only says "read again", and the read is the
 * poll's own — and when the socket will not open, will not authenticate, or
 * drops, the poll goes on exactly as it did before, and this tries again,
 * backing off from a second to a minute.
 *
 * **`subscribe_entities`, not `state_changed`.** The second is the whole house
 * on one socket — a power meter reporting every second is a message every
 * second — and the first asks Home Assistant to send only the entities named,
 * which is what the frontend itself subscribes with. A different list is a
 * new subscription, so when the list changes the socket is closed and opened
 * again with the new one.
 *
 * **Urgent and not.** An entity a "Tell me when…" rule or a widget's
 * show-when names, or a wall's daylight switch, runs the read within a
 * quarter of a second of the event. A reading that is only drawn — a
 * temperature, a light's state — waits up to `readingGapMs` since the last
 * read, because a chatty sensor must not turn the half-minute poll into one a
 * second, and nobody stands in front of a thermometer waiting for a tenth of a
 * degree.
 *
 * **Three messages are ever sent**: the token, as the handshake asks;
 * `subscribe_entities`, which is a read; and `ping`. Nothing here writes to
 * the house, and `ha-write-boundary.test.ts` holds this file to those three.
 */

/** The commands this file sends after the handshake. */
export const HA_LIVE_COMMANDS = ['subscribe_entities', 'ping'] as const;

/** The most entities one subscription names; past this, the poll alone answers. */
export const MAX_LIVE_ENTITIES = 500;

export interface LiveTimings {
  /** How often a ping goes, so a dead socket is noticed and the list re-read. */
  readonly pingMs: number;
  /** How long the socket may go without hearing anything. */
  readonly idleMs: number;
  /** After a failure, the first wait and the longest. */
  readonly backoffMinMs: number;
  readonly backoffMaxMs: number;
  /** How long after an urgent change the read runs — long enough to gather a burst. */
  readonly urgentGapMs: number;
  /** The least time between two reads brought forward by readings alone. */
  readonly readingGapMs: number;
  /** With nothing to watch or no connection, how often to look again. */
  readonly recheckMs: number;
}

export const LIVE_TIMINGS: LiveTimings = {
  pingMs: 30_000,
  idleMs: 75_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  urgentGapMs: 150,
  readingGapMs: 10_000,
  recheckMs: 30_000,
};

export interface LiveDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  /** The Home Assistant read — the poll's own job, run now. */
  readonly sync: () => Promise<void>;
  /** The read wrote something: tell the walls to ask again. */
  readonly changed: () => void;
  readonly timings?: Partial<LiveTimings>;
  readonly log?: (message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LiveHandle {
  /** Whether a subscription is open and acknowledged right now. */
  readonly listening: boolean;
  close(): void;
}

/**
 * The entities worth hearing about, split by how fast. Asked of the rows each
 * time, so a rule added, a widget's condition changed or a reading removed is
 * a different subscription within one ping.
 */
export function liveEntities(db: SqliteDatabase): { readonly urgent: Set<string>; readonly readings: Set<string> } {
  const urgent = conditionEntities(db);
  for (const row of db
    .prepare(
      `SELECT DISTINCT json_extract(conditions, '$.entityId') AS entityId FROM interrupt_rules
        WHERE trigger IN ('homeassistant', 'ha_entity') AND enabled = 1 AND json_valid(conditions)
          AND json_extract(conditions, '$.entityId') IS NOT NULL`,
    )
    .all() as { entityId: unknown }[]) {
    if (typeof row.entityId === 'string' && CONDITION_ENTITY_PATTERN.test(row.entityId)) urgent.add(row.entityId);
  }
  for (const row of db
    .prepare(
      `SELECT DISTINCT daylight_entity AS entityId FROM screens
        WHERE daylight_source = 'entity' AND daylight_entity IS NOT NULL AND revoked_at IS NULL`,
    )
    .all() as { entityId: string }[]) {
    urgent.add(row.entityId);
  }
  const readings = new Set<string>();
  for (const row of db.prepare('SELECT entity_id AS entityId FROM ha_entity_cache').all() as { entityId: string }[]) {
    if (!urgent.has(row.entityId)) readings.add(row.entityId);
  }
  for (const row of db.prepare('SELECT entity_id AS entityId FROM ha_cameras').all() as { entityId: string }[]) {
    if (!urgent.has(row.entityId)) readings.add(row.entityId);
  }
  return { urgent, readings };
}

const frame = z.looseObject({
  type: z.string(),
  id: z.number().optional(),
  success: z.boolean().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  event: z.looseObject({}).optional(),
});

/** The entity ids an entities event names: added, changed or removed. */
export function entitiesIn(event: Record<string, unknown> | undefined): string[] {
  if (event === undefined) return [];
  const found: string[] = [];
  for (const part of ['a', 'c'] as const) {
    const map = event[part];
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) found.push(...Object.keys(map));
  }
  const removed = event['r'];
  if (Array.isArray(removed)) for (const id of removed) if (typeof id === 'string') found.push(id);
  return found;
}

/** Start listening. Never throws; a house with no Home Assistant costs one look every `recheckMs`. */
export function startHaLive(deps: LiveDeps): LiveHandle {
  const t: LiveTimings = { ...LIVE_TIMINGS, ...deps.timings };
  const log = deps.log ?? (() => undefined);
  let closed = false;
  let listening = false;
  let current: Extract<SubscribeOutcome, { status: 'ok' }> | undefined;
  let wait: ReturnType<typeof setTimeout> | undefined;
  let backoff = t.backoffMinMs;
  let lastSaid = '';

  // The read, gathered: one at a time, and one more after it if anything
  // arrived while it ran.
  let reading = false;
  let again = false;
  let lastReadAt = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let pendingAt = Infinity;

  const say = (message: string): void => {
    if (message === lastSaid) return;
    lastSaid = message;
    log(`[ha-live] ${message}`);
  };

  const read = async (): Promise<void> => {
    if (closed) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        lastReadAt = Date.now();
        try {
          await deps.sync();
          deps.changed();
        } catch (error) {
          say(`a read failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } while (again && !closed);
    } finally {
      reading = false;
    }
  };

  const readWithin = (ms: number): void => {
    const at = Date.now() + ms;
    if (pending !== undefined && pendingAt <= at) return;
    if (pending !== undefined) clearTimeout(pending);
    pendingAt = at;
    pending = setTimeout(() => {
      pending = undefined;
      pendingAt = Infinity;
      void read();
    }, ms);
    pending.unref?.();
  };

  const later = (ms: number): void => {
    if (closed) return;
    wait = setTimeout(() => {
      wait = undefined;
      void connect();
    }, ms);
    wait.unref?.();
  };

  const listOf = (): { key: string; urgent: Set<string>; all: string[] } => {
    const { urgent, readings } = liveEntities(deps.db);
    const all = [...urgent, ...readings].sort().slice(0, MAX_LIVE_ENTITIES);
    return { key: all.join(','), urgent, all };
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    if (deps.fetcher.subscribe === undefined) return;
    let list: ReturnType<typeof listOf>;
    try {
      list = listOf();
    } catch {
      later(t.recheckMs);
      return;
    }
    if (list.all.length === 0) {
      later(t.recheckMs);
      return;
    }
    const resolved = resolveConnection(deps.db, deps.keyring, deps.env);
    if (!resolved.ok) {
      later(t.recheckMs);
      return;
    }
    const connection = resolved.connection;
    let urgent = list.urgent;
    let nextId = 1;
    let subscribed = 0;

    const outcome = await deps.fetcher.subscribe({
      url: websocketUrl(connection),
      policy: connection.policy,
      maxBytes: FETCH_LIMITS.json,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: t.idleMs,
      converse: (text) => {
        const shaped = frame.safeParse(parseJsonOr(z.unknown(), text, undefined));
        if (!shaped.success) return { fail: 'Home Assistant sent something unreadable.' };
        const message = shaped.data;
        if (message.type === 'auth_required') {
          return { send: [JSON.stringify({ type: 'auth', access_token: connection.token })] };
        }
        if (message.type === 'auth_invalid') return { fail: 'Home Assistant did not accept the token.' };
        if (message.type === 'auth_ok') {
          subscribed = nextId++;
          return { send: [JSON.stringify({ id: subscribed, type: 'subscribe_entities', entity_ids: list.all })] };
        }
        if (message.type === 'result' && message.id === subscribed) {
          if (message.success !== true) {
            const said = message.error?.message === undefined ? undefined : clean(message.error.message, 200);
            return { fail: `Home Assistant would not subscribe${said === undefined || said === null ? '' : `: ${said}`}.` };
          }
          listening = true;
          backoff = t.backoffMinMs;
          say(`listening to ${list.all.length} entit${list.all.length === 1 ? 'y' : 'ies'}`);
          // Anything that changed while the socket was down.
          readWithin(t.urgentGapMs);
          return { send: [] };
        }
        if (message.type === 'event' && message.id === subscribed) {
          const named = entitiesIn(message.event as Record<string, unknown> | undefined);
          if (named.some((id) => urgent.has(id))) readWithin(t.urgentGapMs);
          else if (named.length > 0) readWithin(Math.max(t.urgentGapMs, lastReadAt + t.readingGapMs - Date.now()));
          return { send: [] };
        }
        // A pong, or an answer to nothing we asked.
        return { send: [] };
      },
    });

    if (outcome.status !== 'ok') {
      say(`not listening: ${outcome.message}`);
      later(backoff);
      backoff = Math.min(backoff * 2, t.backoffMaxMs);
      return;
    }
    if (closed) {
      outcome.close();
      return;
    }
    current = outcome;
    const ping = setInterval(() => {
      let next;
      try {
        next = listOf();
      } catch {
        return;
      }
      if (next.key !== list.key) {
        // A different list is a different subscription.
        list = next;
        outcome.close();
        return;
      }
      urgent = next.urgent;
      outcome.send(JSON.stringify({ id: nextId++, type: 'ping' }));
    }, t.pingMs);
    ping.unref?.();

    const end = await outcome.ended;
    clearInterval(ping);
    current = undefined;
    const wasListening = listening;
    listening = false;
    if (closed) return;
    if (end.code === 'closed') {
      // Our own close, for a new list: straight back.
      later(0);
      return;
    }
    say(`stopped listening: ${end.message}`);
    later(wasListening ? t.backoffMinMs : backoff);
    if (!wasListening) backoff = Math.min(backoff * 2, t.backoffMaxMs);
  };

  void connect();

  return {
    get listening(): boolean {
      return listening;
    },
    close(): void {
      closed = true;
      listening = false;
      if (wait !== undefined) clearTimeout(wait);
      if (pending !== undefined) clearTimeout(pending);
      current?.close();
    },
  };
}

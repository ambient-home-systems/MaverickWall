import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import type { Signal } from '../../api/interrupts.js';
import { call, resolveConnection } from './client.js';
import {
  iconFor,
  parseStates,
  readState,
  toReading,
  type DisplayMode,
  type EntityReading,
  type HaState,
} from './entities.js';

/**
 * Home Assistant, as a panel module and a source of signals.
 *
 * Two jobs in one directory: a handful of readings drawn beside the calendar,
 * and the facts the interrupt rules match on. Both come from one poll, because
 * `/api/states` answers with the whole house in a single request and asking
 * for six entities individually would be six.
 *
 * **Polling is the implementation, deliberately.** Home Assistant has a
 * WebSocket API and it would cost less, but its auth handshake is reported to
 * behave differently through the supervisor proxy than against Core directly,
 * and a subscription that fails to authenticate must not be the reason a
 * household's wall stops knowing anything. Thirty-second REST polling is the
 * reliable baseline the brief asks for; a subscription would be an
 * optimisation layered on top of it, and it is not built.
 */

export const HOME_BLOCK = 'home';

interface WatchRow {
  readonly entityId: string;
  readonly label: string | null;
  readonly displayMode: string;
  readonly sortOrder: number;
  readonly state: string | null;
  readonly friendlyName: string | null;
  readonly unit: string | null;
  readonly lastChangedAt: number | null;
  readonly fetchedAt: number;
  readonly attributes: string | null;
}

const MODES: readonly string[] = ['value', 'label_value', 'icon_state', 'presence'];

function modeOf(stored: string): DisplayMode {
  return (MODES.includes(stored) ? stored : 'label_value') as DisplayMode;
}

/**
 * Rebuild enough of a parsed state to reuse the pure formatters.
 *
 * The cache stores what came back rather than what it meant, so the wording
 * and the character are decided at read time by the same functions the tests
 * exercise — a household who renames a device class in Home Assistant sees the
 * new wording on the next poll rather than on the next release.
 */
function stateFrom(row: WatchRow): HaState {
  let deviceClass: string | null = null;
  if (row.attributes !== null) {
    try {
      const parsed: unknown = JSON.parse(row.attributes);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>)['device_class'];
        if (typeof value === 'string') deviceClass = value;
      }
    } catch {
      // A cache row that will not parse is a row with no device class. The
      // reading still draws; it just reads `on` instead of `Open`.
    }
  }

  const dot = row.entityId.indexOf('.');
  return {
    entityId: row.entityId,
    domain: dot < 0 ? '' : row.entityId.slice(0, dot),
    state: row.state ?? '',
    friendlyName: row.friendlyName ?? row.entityId,
    unit: row.unit,
    deviceClass,
    lastChangedAt: row.lastChangedAt,
  };
}

const SELECT_WATCHED = `SELECT entity_id AS entityId, label, display_mode AS displayMode,
          sort_order AS sortOrder, state, friendly_name AS friendlyName,
          unit_of_measurement AS unit, last_changed_at AS lastChangedAt,
          fetched_at AS fetchedAt, attributes
     FROM ha_entity_cache WHERE watched = 1
    ORDER BY sort_order, entity_id`;

export interface HomePanel {
  readonly readings: readonly EntityReading[];
  readonly fetchedAt: number;
  /** Set when the last poll failed, so the wall can say so quietly. */
  readonly note: string | null;
}

export const haModule: PanelModule = {
  key: HOME_BLOCK,
  label: 'The house',

  /**
   * Ready when there is something to draw.
   *
   * Not "is Home Assistant connected": a household can have a working
   * connection purely for their calendars and want nothing from the house on
   * the wall, and an empty strip where a panel should be is worse than no
   * panel. Deciding on watched rows also means this needs no credential, which
   * keeps the manifest path free of the keyring.
   */
  ready(db: SqliteDatabase): boolean {
    const row = db
      .prepare('SELECT count(*) AS n FROM ha_entity_cache WHERE watched = 1')
      .get() as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  },

  contribute(context: ModuleContext): HomePanel | null {
    const rows = context.db.prepare(SELECT_WATCHED).all() as WatchRow[];
    if (rows.length === 0) return null;

    const readings = rows.map((row) =>
      toReading(
        stateFrom(row),
        {
          entityId: row.entityId,
          label: row.label,
          displayMode: modeOf(row.displayMode),
          sortOrder: row.sortOrder,
        },
        row.fetchedAt,
        context.now,
      ),
    );

    const oldest = rows.reduce((least, row) => Math.min(least, row.fetchedAt), Infinity);
    const error = context.db
      .prepare(`SELECT last_error AS lastError FROM ha_settings WHERE id = 'singleton'`)
      .get() as { lastError: string | null } | undefined;

    return {
      readings,
      fetchedAt: Number.isFinite(oldest) ? oldest : 0,
      /*
       * A stale reading is shown, and said.
       *
       * The same argument as the offline manifest and the weather panel: a
       * temperature from twenty minutes ago is worth far more than a hole, as
       * long as nobody is invited to believe it is current.
       */
      note: error?.lastError ?? null,
    };
  },

  /**
   * Every cached entity, whether or not it is drawn.
   *
   * The rules match on entities the household may deliberately not display —
   * nobody wants a permanent readout of the freezer door, they want to be told
   * when it has been open five minutes.
   */
  signals(context: ModuleContext): readonly Signal[] {
    const rows = context.db
      .prepare(
        `SELECT entity_id AS entityId, label, state, friendly_name AS friendlyName,
                unit_of_measurement AS unit, last_changed_at AS lastChangedAt,
                fetched_at AS fetchedAt, attributes, display_mode AS displayMode,
                sort_order AS sortOrder
           FROM ha_entity_cache`,
      )
      .all() as WatchRow[];

    return rows.map((row) => {
      const state = stateFrom(row);
      const asNumber = Number(state.state);
      return {
        source: 'ha_entity',
        key: row.entityId,
        state: state.state,
        // What a person would say. `readState` is the same function the panel
        // uses, so a door reads "Open" in both places rather than "on" in one.
        reading: readState(state),
        numeric: state.state.trim() !== '' && Number.isFinite(asNumber) ? asNumber : null,
        since: row.lastChangedAt,
        // The household's own name for it if they gave one, then Home
        // Assistant's. An entity id never reaches the wall.
        label: row.label ?? state.friendlyName,
      };
    });
  },

  job: {
    kind: 'ha-sync',
    /*
     * Thirty seconds, bounded by the scheduler's own tick.
     *
     * The tick is also thirty seconds, so in practice a reading is between
     * thirty and sixty seconds old. That is the right trade for a wall: a
     * faster tick would wake the process constantly for the benefit of a house
     * whose temperature moves in tenths of a degree an hour.
     */
    intervalMs: 30_000,

    async run(context: ModuleContext): Promise<void> {
      /*
       * Only the entities somebody asked about.
       *
       * `/api/states` answers with the whole house, which for a real
       * installation is hundreds of rows of things a calendar has no use for.
       * Storing them all would make the cache the largest table in the
       * database and put a household's every sensor into a backup that exists
       * to protect their calendar.
       */
      const wanted = new Set<string>();
      for (const row of context.db
        .prepare('SELECT entity_id AS entityId FROM ha_entity_cache')
        .all() as { entityId: string }[]) {
        wanted.add(row.entityId);
      }
      if (wanted.size === 0) return;

      const resolved = resolveConnection(context.db, context.keyring);
      if (!resolved.ok) {
        if (resolved.code !== 'not-configured') recordError(context.db, resolved.message);
        return;
      }

      const response = await call(context.fetcher, resolved.connection, '/states');
      if (!response.ok) {
        // The cached readings stay. A failed poll costs freshness, not the
        // panel — and the interrupt rules keep matching on the last known
        // state, which is the honest answer to "what do we know".
        recordError(context.db, response.message);
        return;
      }

      const states = parseStates(response.body).filter((state) => wanted.has(state.entityId));
      const at = context.now;

      const update = context.db.prepare(
        `UPDATE ha_entity_cache
            SET state = ?, attributes = ?, friendly_name = ?, unit_of_measurement = ?,
                last_changed_at = ?, fetched_at = ?
          WHERE entity_id = ?`,
      );

      const write = context.db.transaction(() => {
        for (const state of states) {
          update.run(
            state.state,
            JSON.stringify({ device_class: state.deviceClass }),
            state.friendlyName,
            state.unit,
            state.lastChangedAt,
            at,
            state.entityId,
          );
        }
        context.db
          .prepare(
            `UPDATE ha_settings SET last_sync_at = ?, last_error = NULL, updated_at = ?
              WHERE id = 'singleton'`,
          )
          .run(at, at);
      });
      write();
    },
  },
};

/**
 * Record why the last poll did not work.
 *
 * The message is the client's own wording, which never contains the token —
 * there is a test for that, because "the credential must not appear in a log"
 * is the kind of rule that is true until somebody helpfully includes the
 * request in an error.
 */
function recordError(db: SqliteDatabase, message: string): void {
  db.prepare(
    `UPDATE ha_settings SET last_error = ?, last_sync_at = ?, updated_at = ?
      WHERE id = 'singleton'`,
  ).run(message, Date.now(), Date.now());
}

/** Re-exported so the admin screen draws the same characters the wall does. */
export { iconFor, readState };

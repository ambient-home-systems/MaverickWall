import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../../db/open.js';
import type { Keyring } from '../../secrets/keyring.js';
import { HOME_BLOCK } from './index.js';
import type { DisplayMode } from './entities.js';

/**
 * This module's corner of the database.
 *
 * Kept here rather than in `api/queries.ts` because a module owning its own
 * settings, its own cache and its own rows is the property that makes the
 * seam worth having. Nothing outside this directory writes `ha_settings` or
 * `ha_entity_cache`.
 *
 * The token is the exception to nothing: it goes in as an envelope and never
 * comes back out of this file except through `resolveConnection`.
 */

export interface HaSettings {
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  /** Whether a token is stored. Never the token. */
  readonly hasToken: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly lastSyncAt: number | null;
  readonly lastError: string | null;
}

export function readHaSettings(db: SqliteDatabase): HaSettings {
  const row = db
    .prepare(
      `SELECT enabled, base_url AS baseUrl, token_encrypted AS tokenEncrypted,
              allow_private_network AS allowPrivateNetwork,
              last_sync_at AS lastSyncAt, last_error AS lastError
         FROM ha_settings WHERE id = 'singleton'`,
    )
    .get() as
    | {
        enabled: number;
        baseUrl: string | null;
        tokenEncrypted: string | null;
        allowPrivateNetwork: number;
        lastSyncAt: number | null;
        lastError: string | null;
      }
    | undefined;

  return {
    enabled: row?.enabled === 1,
    baseUrl: row?.baseUrl ?? null,
    hasToken: (row?.tokenEncrypted ?? null) !== null,
    allowPrivateNetwork: row?.allowPrivateNetwork !== 0,
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
  };
}

export interface WriteHaSettingsInput {
  readonly baseUrl: string;
  /** Undefined leaves the stored token alone; a household editing the address
   *  should not have to paste a token they cannot read back. */
  readonly token?: string;
  readonly allowPrivateNetwork: boolean;
}

export function writeHaSettings(
  db: SqliteDatabase,
  keyring: Keyring,
  input: WriteHaSettingsInput,
): void {
  const at = Date.now();
  const envelope = input.token === undefined ? undefined : keyring.encrypt(input.token, 'ha-token');

  db.prepare(
    `INSERT INTO ha_settings (id, enabled, base_url, token_encrypted,
                              allow_private_network, created_at, updated_at)
     VALUES ('singleton', 1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 1,
       base_url = excluded.base_url,
       token_encrypted = COALESCE(excluded.token_encrypted, ha_settings.token_encrypted),
       allow_private_network = excluded.allow_private_network,
       -- A fresh address deserves a fresh verdict. Leaving the old failure up
       -- would have somebody fixing a problem they have already fixed.
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.baseUrl, envelope ?? null, input.allowPrivateNetwork ? 1 : 0, at, at);
}

/**
 * Disconnect, and forget the credential.
 *
 * The token is deleted rather than kept against a reconnection. A household
 * who disconnected Home Assistant has withdrawn permission for this process to
 * hold a key to their house, and keeping it warm in case they change their
 * mind is not ours to decide. Watched entities go too, for the same reason:
 * they are a record of what is in somebody's home.
 */
export function disconnectHa(db: SqliteDatabase): void {
  const at = Date.now();
  const clear = db.transaction(() => {
    db.prepare(
      `UPDATE ha_settings SET enabled = 0, token_encrypted = NULL, last_error = NULL,
                              updated_at = ? WHERE id = 'singleton'`,
    ).run(at);
    db.prepare('DELETE FROM ha_entity_cache').run();
    /*
     * Both spellings, and only this source's rules.
     *
     * The stored value moved from `ha_entity` to `homeassistant` when the model
     * became source-agnostic, and this clause did not follow it — so
     * disconnecting left every rule about the house behind, still matching, on
     * entities that were about to be deleted. Naming both is what makes the
     * upgrade safe. The shipped weather rules are emphatically not touched:
     * they have nothing to do with Home Assistant.
     */
    db.prepare(
      `DELETE FROM interrupt_rules WHERE trigger IN ('homeassistant', 'ha_entity')`,
    ).run();
  });
  clear();
}

export interface WatchedRow {
  readonly entityId: string;
  readonly label: string | null;
  readonly displayMode: string;
  readonly sortOrder: number;
  readonly watched: number;
  readonly state: string | null;
  readonly friendlyName: string | null;
  readonly unitOfMeasurement: string | null;
  readonly fetchedAt: number;
}

export function readWatched(db: SqliteDatabase): WatchedRow[] {
  return db
    .prepare(
      `SELECT entity_id AS entityId, label, display_mode AS displayMode,
              sort_order AS sortOrder, watched, state,
              friendly_name AS friendlyName,
              unit_of_measurement AS unitOfMeasurement, fetched_at AS fetchedAt
         FROM ha_entity_cache
        ORDER BY watched DESC, sort_order, entity_id`,
    )
    .all() as WatchedRow[];
}

export interface WatchInput {
  readonly entityId: string;
  readonly friendlyName: string;
  readonly label: string | null;
  readonly displayMode: DisplayMode;
}

/**
 * Start showing an entity, and put the block on the wall.
 *
 * The block order is stored per household, so a block that did not exist when
 * they last saved can never appear in it — they would add a temperature, wait,
 * and see nothing. The moment somebody adds the first reading is the moment
 * they asked for the panel, so that is when it is inserted. Turning readings
 * off again leaves the order alone: it is theirs.
 */
export function watchEntity(db: SqliteDatabase, input: WatchInput): void {
  const at = Date.now();
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO ha_entity_cache (entity_id, friendly_name, label, display_mode,
                                    watched, sort_order, fetched_at)
       VALUES (?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM ha_entity_cache), ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         watched = 1, label = excluded.label, display_mode = excluded.display_mode,
         friendly_name = excluded.friendly_name`,
    ).run(input.entityId, input.friendlyName, input.label, input.displayMode, at);

    ensureBlock(db);
    // Bring the poll forward so the reading fills in rather than sitting empty
    // for half a minute while somebody watches it.
    db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'ha-sync'`).run();
  });
  write();
}

function ensureBlock(db: SqliteDatabase): void {
  const row = db
    .prepare(`SELECT display_blocks AS blocks FROM household_settings WHERE id = 'singleton'`)
    .get() as { blocks: string | null } | undefined;
  const blocks = (row?.blocks ?? '')
    .split(',')
    .map((block) => block.trim())
    .filter((block) => block !== '');
  if (blocks.includes(HOME_BLOCK)) return;

  // After the weather strip if there is one, otherwise after today. The house
  // is ambient context and belongs beside the other ambient context, not above
  // the thing somebody walked over to read.
  const after = blocks.indexOf('weather') >= 0 ? blocks.indexOf('weather') : blocks.indexOf('now');
  blocks.splice(after < 0 ? blocks.length : after + 1, 0, HOME_BLOCK);
  db.prepare(
    `UPDATE household_settings SET display_blocks = ?, updated_at = ? WHERE id = 'singleton'`,
  ).run(blocks.join(','), Date.now());
}

/**
 * Stop showing an entity.
 *
 * The row survives when a rule still names it: a household who stopped
 * displaying the freezer door has not asked to stop being told it is open,
 * and deleting the row would silently disarm the rule.
 */
export function unwatchEntity(db: SqliteDatabase, entityId: string): void {
  const referenced = db
    .prepare(
      `SELECT count(*) AS n FROM interrupt_rules
        WHERE trigger = 'ha_entity' AND conditions LIKE ?`,
    )
    .get(`%${entityId}%`) as { n: number } | undefined;

  if ((referenced?.n ?? 0) > 0) {
    db.prepare('UPDATE ha_entity_cache SET watched = 0 WHERE entity_id = ?').run(entityId);
    return;
  }
  db.prepare('DELETE FROM ha_entity_cache WHERE entity_id = ?').run(entityId);
}

// ---------------------------------------------------------------------------
// Calendar entities as sources
// ---------------------------------------------------------------------------

export interface AddHaCalendarInput {
  readonly entityId: string;
  readonly name: string;
  readonly color?: string;
}

/**
 * Add a Home Assistant calendar as a source, and schedule its first sync.
 *
 * `url_encrypted` stays null: this source has no address of its own. It is
 * reached through the one connection on the Home Assistant screen, which is
 * also why moving that connection needs no rewrite here.
 */
export function addHaCalendarSource(db: SqliteDatabase, input: AddHaCalendarInput): string {
  const id = randomBytes(8).toString('hex');
  const at = Date.now();

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO calendar_sources
         (id, name, kind, ha_entity_id, color, created_at, updated_at)
       VALUES (?, ?, 'homeassistant', ?, ?, ?, ?)`,
    ).run(id, input.name, input.entityId, input.color ?? '#4C7FD1', at, at);

    db.prepare(
      `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
       VALUES (?, 'ha-calendar-sync', ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
    ).run(`ha-calendar-sync:${id}`, at + 3_000, at, at);
  });
  write();
  return id;
}

/** Which calendar entities are already sources, so the picker can say so. */
export function haCalendarEntityIds(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT ha_entity_id AS entityId FROM calendar_sources WHERE kind = 'homeassistant'`)
    .all() as { entityId: string | null }[];
  return new Set(rows.map((row) => row.entityId).filter((id): id is string => id !== null));
}

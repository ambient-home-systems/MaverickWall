import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import type { FeedCaldavAccount } from './feed-credentials.js';
import { nextCalendarColor } from './palette.js';

/**
 * Creating, reading and removing a CalDAV account and its calendars
 * (RFC 013 §6.2.1).
 *
 * One credential to many calendars is the shape `calendar_sources` has no word
 * for, and this file is where the two tables are kept in step. Everything a
 * household does to a CalDAV account happens here rather than in a handler, for
 * the reason `api/sources.ts` exists: the admin screen and the CLI both do all
 * of this, and two copies of "remove the calendar, and the account if it was
 * the last one" would drift — the half that drifts being the one that leaves a
 * stored password behind.
 */

/** Host only, for the settings row. Never the path. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export interface CreateAccountInput {
  /** The address the household typed, not the one discovery resolved. */
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
  readonly principalUrl: string;
  readonly homeSetUrl: string;
  /** Set only when discovery left the typed host and the household accepted it. */
  readonly confirmedHost?: string | null;
  readonly allowPrivateNetwork?: boolean;
  readonly allowLoopback?: boolean;
  readonly allowHttp?: boolean;
}

/**
 * Write the account row, sealing the password on the way in.
 *
 * `at` is the caller's clock and is deliberately not defaulted, which is the
 * rule `addCalendarSource` and `equipHousehold` already state and for the same
 * reason: a default is how a second clock comes back.
 */
export function createCaldavAccount(
  db: SqliteDatabase,
  keyring: Keyring,
  input: CreateAccountInput,
  at: number,
): string {
  const id = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO caldav_accounts
       (id, server_url_encrypted, server_host, username, password_encrypted,
        principal_url, home_set_url, confirmed_host, allow_private_network,
        allow_loopback, allow_http, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    keyring.encrypt(input.serverUrl, 'calendar-source-url'),
    hostOf(input.serverUrl),
    input.username,
    keyring.encrypt(input.password, 'caldav-password'),
    input.principalUrl,
    input.homeSetUrl,
    input.confirmedHost ?? null,
    input.allowPrivateNetwork === true ? 1 : 0,
    input.allowLoopback === true ? 1 : 0,
    input.allowHttp === true ? 1 : 0,
    at,
    at,
  );
  return id;
}

export interface AddCaldavCalendarInput {
  readonly accountId: string;
  readonly name: string;
  /** The collection href, absolute, as discovery resolved it. */
  readonly url: string;
  /** `CS:getctag` as discovery read it, so the first sync can be a no-op. */
  readonly ctag?: string | null;
  readonly personId?: string | null;
  readonly showInGrid?: boolean;
}

/**
 * Add one discovered collection as a calendar.
 *
 * The colour is rotated exactly as `addCalendarSource` rotates it, and that is
 * the point of a calendar being its own row: a household ticking Home, Work and
 * Kids' school gets three colours, three owners and three `show_in_grid`
 * switches. Under the rejected one-row-per-account shape they would get one of
 * each, which breaks the column that exists to fix the standup fault.
 *
 * **The three network opt-ins are deliberately not written here.** They belong
 * to the account, and writing a copy onto the calendar row would be the second
 * storage location §6.2.2 exists to prevent — `connectionFor` reads them off
 * the account, so a copy here would be a value nothing reads that a household
 * could still see and believe.
 */
export function addCaldavCalendar(
  db: SqliteDatabase,
  keyring: Keyring,
  input: AddCaldavCalendarInput,
  at: number,
): string {
  const id = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, kind, caldav_account_id, url_encrypted, url_host, etag, color,
        person_id, show_in_grid, created_at, updated_at)
     VALUES (?, ?, 'caldav', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.accountId,
    keyring.encrypt(input.url, 'calendar-source-url'),
    hostOf(input.url),
    // The CTag discovery already read. Storing it means the very first sync
    // costs one PROPFIND and no REPORT, which is the same saving every later
    // one gets rather than a special case for the first.
    input.ctag ?? null,
    nextCalendarColor(db),
    input.personId ?? null,
    input.showInGrid === false ? 0 : 1,
    at,
    at,
  );
  db.prepare(
    `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
     VALUES (?, 'caldav-sync', ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
  ).run(`caldav-sync:${id}`, at + 3_000, at, at);
  return id;
}

/**
 * The account a source is reached through, in the shape `connectionFor` wants.
 *
 * Returns undefined for every other kind, which is what makes the resolver's
 * "account first, the row's own columns second" a single expression at every
 * call site rather than a branch each.
 */
export function accountForSource(
  db: SqliteDatabase,
  caldavAccountId: string | null,
): FeedCaldavAccount | undefined {
  if (caldavAccountId === null) return undefined;
  const row = db
    .prepare(
      `SELECT id, username, password_encrypted AS passwordEncrypted,
              allow_private_network AS allowPrivateNetwork,
              allow_loopback AS allowLoopback, allow_http AS allowHttp,
              confirmed_host AS confirmedHost
         FROM caldav_accounts WHERE id = ?`,
    )
    .get(caldavAccountId) as
    | {
        id: string;
        username: string;
        passwordEncrypted: string;
        allowPrivateNetwork: number;
        allowLoopback: number;
        allowHttp: number;
        confirmedHost: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    username: row.username,
    passwordEncrypted: row.passwordEncrypted,
    allowPrivateNetwork: row.allowPrivateNetwork === 1,
    allowLoopback: row.allowLoopback === 1,
    allowHttp: row.allowHttp === 1,
    confirmedHost: row.confirmedHost,
  };
}

/**
 * Change an account's password, once, for every calendar on it.
 *
 * **This function is the entire argument of §6.2.1** and is why the parent
 * table exists at all. Apple app-specific passwords get regenerated; under a
 * flat scheme — each calendar row carrying its own copy of the same envelope —
 * a household would edit four rows with the same value, and missing one
 * presents as "one of my calendars stopped updating", about the hardest fault
 * for a household to describe. Here it is one row.
 *
 * `last_error` is cleared with it, because the error it is almost always
 * holding is the sign-in that this call fixes, and a stale red sentence over a
 * calendar that now works is its own bug.
 */
export function rotateCaldavPassword(
  db: SqliteDatabase,
  keyring: Keyring,
  accountId: string,
  password: string,
  at: number,
): boolean {
  return (
    db
      .prepare(
        `UPDATE caldav_accounts
            SET password_encrypted = ?, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(keyring.encrypt(password, 'caldav-password'), at, accountId).changes > 0
  );
}

/**
 * Remove an account and every calendar on it, deliberately.
 *
 * Removing one calendar is `deleteSource`'s job — the one writer, which drops
 * the account itself when that calendar was the last of them (§6.2.1). This is
 * the other direction, for a household who wants the whole account gone rather
 * than four calendars removed one at a time.
 *
 * The calendars go first and explicitly, and that is not a tidiness choice: the
 * declared `ON DELETE CASCADE` does not reach the database — drizzle-kit drops
 * the action from an `ALTER TABLE ADD COLUMN` — so deleting the account while
 * its calendars still point at it is *refused* by SQLite rather than cascaded.
 * Measured against a real `better-sqlite3` with `foreign_keys = ON`.
 */
export function removeCaldavAccount(db: SqliteDatabase, accountId: string): boolean {
  const remove = db.transaction((id: string): boolean => {
    const sources = db
      .prepare('SELECT id FROM calendar_sources WHERE caldav_account_id = ?')
      .all(id) as { id: string }[];
    for (const source of sources) {
      db.prepare('DELETE FROM calendar_events_cache WHERE source_id = ?').run(source.id);
      db.prepare('DELETE FROM job_state WHERE key = ?').run(`caldav-sync:${source.id}`);
      db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(source.id);
    }
    return db.prepare('DELETE FROM caldav_accounts WHERE id = ?').run(id).changes > 0;
  });
  return remove(accountId);
}

export interface AdminCaldavAccount {
  readonly id: string;
  readonly username: string;
  readonly serverHost: string | null;
  readonly confirmedHost: string | null;
  readonly lastError: string | null;
}

/** Every account, for the Calendars screen. Never the password. */
export function readCaldavAccounts(db: SqliteDatabase): readonly AdminCaldavAccount[] {
  return db
    .prepare(
      `SELECT id, username, server_host AS serverHost, confirmed_host AS confirmedHost,
              last_error AS lastError
         FROM caldav_accounts ORDER BY created_at`,
    )
    .all() as AdminCaldavAccount[];
}

/** Record an account-wide failure — a password that stopped being accepted. */
export function recordAccountError(
  db: SqliteDatabase,
  accountId: string,
  message: string | null,
  at: number,
): void {
  db.prepare('UPDATE caldav_accounts SET last_error = ?, updated_at = ? WHERE id = ?').run(
    message,
    at,
    accountId,
  );
}

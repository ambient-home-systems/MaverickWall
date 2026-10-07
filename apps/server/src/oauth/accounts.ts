import { randomBytes } from 'node:crypto';
import type { Fetcher } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import { nextCalendarColor } from '../api/palette.js';
import { apiHost, type OAuthEndpoints, type OAuthProvider } from './endpoints.js';
import { refreshAccessToken } from './token.js';

/**
 * A signed-in Google or Microsoft account and its calendars, as this
 * application keeps them (plan item M5.11).
 *
 * One account to many calendars, CalDAV's shape (`caldav_accounts`), for
 * CalDAV's reason: signing in again after Google's seven-day Testing expiry is
 * one act for every calendar on the account, and a household doing it four
 * times would miss one.
 *
 * The refresh token is sealed, and opened only inside `accessToken` for the
 * one request that trades it for an access token. Access tokens live in this
 * process's memory and nowhere else: an hour each, and a restart costs one
 * refresh per account, which is what a refresh token is for.
 */

export interface OAuthAccountRow {
  readonly id: string;
  readonly provider: OAuthProvider;
  readonly clientId: string;
  readonly tenant: string | null;
  readonly accountLabel: string | null;
  readonly lastError: string | null;
  readonly calendars: number;
}

export function readOAuthAccounts(db: SqliteDatabase): OAuthAccountRow[] {
  return db
    .prepare(
      `SELECT a.id, a.provider, a.client_id AS clientId, a.directory AS tenant, a.account_label AS accountLabel,
              a.last_error AS lastError,
              (SELECT count(*) FROM calendar_sources s WHERE s.oauth_account_id = a.id) AS calendars
         FROM oauth_accounts a ORDER BY a.created_at`,
    )
    .all() as OAuthAccountRow[];
}

export interface CreateOAuthAccountInput {
  readonly provider: OAuthProvider;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tenant?: string;
  readonly refreshToken: string;
  readonly label?: string;
}

export function createOAuthAccount(db: SqliteDatabase, keyring: Keyring, input: CreateOAuthAccountInput, at: number): string {
  const id = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO oauth_accounts
       (id, provider, client_id, client_secret_encrypted, directory, refresh_token_encrypted, account_label,
        last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    input.provider,
    input.clientId,
    input.clientSecret === undefined ? null : keyring.encrypt(input.clientSecret, 'oauth-client-secret'),
    input.provider === 'microsoft' ? (input.tenant ?? 'common') : null,
    keyring.encrypt(input.refreshToken, 'oauth-refresh-token'),
    input.label ?? null,
    at,
    at,
  );
  return id;
}

/**
 * The account signed in again: a new refresh token, the error cleared, and
 * every calendar on it asked for at once — including any a refused sign-in
 * had held for a week, which is the hold an edit is meant to lift.
 */
export function replaceOAuthTokens(
  db: SqliteDatabase,
  keyring: Keyring,
  accountId: string,
  refreshToken: string,
  label: string | undefined,
  at: number,
): boolean {
  const changed = db
    .prepare(
      `UPDATE oauth_accounts
          SET refresh_token_encrypted = ?, account_label = COALESCE(?, account_label), last_error = NULL,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(keyring.encrypt(refreshToken, 'oauth-refresh-token'), label ?? null, at, accountId).changes;
  if (changed === 0) return false;
  forgetAccessToken(accountId);
  db.prepare(
    `UPDATE job_state SET next_run_at = 0, consecutive_failures = 0
      WHERE key IN (SELECT 'oauth-sync:' || id FROM calendar_sources WHERE oauth_account_id = ?)`,
  ).run(accountId);
  return true;
}

export interface AddOAuthCalendarInput {
  readonly accountId: string;
  readonly provider: OAuthProvider;
  /** The provider's own id for the calendar, sealed like every address here. */
  readonly calendarId: string;
  readonly name: string;
  readonly personId?: string | null;
}

export function addOAuthCalendar(
  db: SqliteDatabase,
  keyring: Keyring,
  endpoints: OAuthEndpoints,
  input: AddOAuthCalendarInput,
  at: number,
): string {
  const id = randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO calendar_sources
       (id, name, kind, oauth_account_id, url_encrypted, url_host, color, person_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.provider,
    input.accountId,
    keyring.encrypt(input.calendarId, 'calendar-source-url'),
    apiHost(input.provider, endpoints),
    nextCalendarColor(db),
    input.personId ?? null,
    at,
    at,
  );
  db.prepare(
    `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
     VALUES (?, 'oauth-sync', ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
  ).run(`oauth-sync:${id}`, at + 3_000, at, at);
  return id;
}

/**
 * Remove an account and every calendar on it, by hand.
 *
 * `oauth_account_id` declares no foreign key (see `schema.ts`), so nothing
 * would cascade; each calendar's events, its job and the row go first, then
 * the account, in one transaction. Nothing at Google or Microsoft is touched:
 * the household revokes the app there if they want it gone everywhere.
 */
export function removeOAuthAccount(db: SqliteDatabase, accountId: string): boolean {
  const remove = db.transaction(() => {
    const sources = db.prepare(`SELECT id FROM calendar_sources WHERE oauth_account_id = ?`).all(accountId) as {
      id: string;
    }[];
    for (const { id } of sources) {
      db.prepare(`DELETE FROM calendar_events_cache WHERE source_id = ?`).run(id);
      db.prepare(`DELETE FROM job_state WHERE key = ?`).run(`oauth-sync:${id}`);
      db.prepare(`DELETE FROM calendar_sources WHERE id = ?`).run(id);
    }
    return db.prepare(`DELETE FROM oauth_accounts WHERE id = ?`).run(accountId).changes > 0;
  });
  const removed = remove();
  forgetAccessToken(accountId);
  return removed;
}

export function recordOAuthAccountError(db: SqliteDatabase, accountId: string, message: string | null, at: number): void {
  db.prepare(`UPDATE oauth_accounts SET last_error = ?, updated_at = ? WHERE id = ?`).run(message, at, accountId);
}

/** Access tokens, in memory only, by account; never written anywhere. */
const ACCESS = new Map<string, { readonly token: string; readonly expiresAt: number }>();

export function forgetAccessToken(accountId: string): void {
  ACCESS.delete(accountId);
}

/** For tests: forget every access token, as a restart would. */
export function forgetAllAccessTokens(): void {
  ACCESS.clear();
}

export type AccessResult =
  | { readonly ok: true; readonly token: string; readonly provider: OAuthProvider }
  | { readonly ok: false; readonly revoked: boolean; readonly message: string };

/**
 * An access token for the account: the one in memory while it has a minute
 * left, otherwise a new one from the sealed refresh token.
 *
 * A refresh token the provider no longer honours is the account's failure and
 * is said on the account (`last_error`) as well as returned, so the Calendars
 * screen names it once against the account rather than once per calendar. A
 * rotated refresh token — Microsoft sends one with every refresh — is sealed
 * and stored before this returns.
 */
export async function accessToken(
  context: { readonly db: SqliteDatabase; readonly keyring: Keyring; readonly fetcher: Fetcher; readonly now: number },
  endpoints: OAuthEndpoints,
  accountId: string,
): Promise<AccessResult> {
  const row = context.db
    .prepare(
      `SELECT provider, client_id AS clientId, client_secret_encrypted AS secret, directory AS tenant,
              refresh_token_encrypted AS refresh
         FROM oauth_accounts WHERE id = ?`,
    )
    .get(accountId) as
    | { provider: OAuthProvider; clientId: string; secret: string | null; tenant: string | null; refresh: string }
    | undefined;
  if (row === undefined) return { ok: false, revoked: false, message: 'That account is not connected any more.' };

  const held = ACCESS.get(accountId);
  if (held !== undefined && held.expiresAt - 60_000 > context.now) {
    return { ok: true, token: held.token, provider: row.provider };
  }

  const refresh = context.keyring.decrypt(row.refresh, 'oauth-refresh-token');
  const secret = row.secret === null ? undefined : context.keyring.decrypt(row.secret, 'oauth-client-secret');
  if (!refresh.ok || (secret !== undefined && !secret.ok)) {
    const message = 'The sign-in could not be opened. Sign in again on the Calendars screen.';
    recordOAuthAccountError(context.db, accountId, message, context.now);
    return { ok: false, revoked: true, message };
  }
  const result = await refreshAccessToken(context.fetcher, endpoints, {
    provider: row.provider,
    clientId: row.clientId,
    ...(secret?.ok === true ? { clientSecret: secret.value } : {}),
    ...(row.tenant === null ? {} : { tenant: row.tenant }),
    refreshToken: refresh.value,
  });
  if (!result.ok) {
    if (result.reason !== 'unreachable') recordOAuthAccountError(context.db, accountId, result.message, context.now);
    return { ok: false, revoked: result.reason === 'revoked', message: result.message };
  }
  if (result.refreshToken !== undefined && result.refreshToken !== refresh.value) {
    context.db
      .prepare(`UPDATE oauth_accounts SET refresh_token_encrypted = ?, updated_at = ? WHERE id = ?`)
      .run(context.keyring.encrypt(result.refreshToken, 'oauth-refresh-token'), context.now, accountId);
  }
  recordOAuthAccountError(context.db, accountId, null, context.now);
  ACCESS.set(accountId, { token: result.accessToken, expiresAt: context.now + result.expiresInSec * 1000 });
  return { ok: true, token: result.accessToken, provider: row.provider };
}

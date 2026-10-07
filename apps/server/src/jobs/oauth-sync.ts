import type { Fetcher, JobHandler, JobRecord, JobResult } from '@maverick-wall/core';
import { createEventWriter, toEventRow } from './events.js';
import { AUTH_FAILURE_HOLD_SECONDS, WINDOW_AFTER_DAYS, WINDOW_BEFORE_DAYS } from './ics-sync.js';
import { sourceIdFromJobKey } from './ha-calendar-sync.js';
import { accessToken, forgetAccessToken } from '../oauth/accounts.js';
import { googleEvents, microsoftEvents } from '../oauth/calendars.js';
import { OAUTH, apiHost, type OAuthEndpoints } from '../oauth/endpoints.js';
import type { Keyring } from '../secrets/keyring.js';
import type { SqliteDatabase } from '../db/open.js';

/**
 * Syncing one Google or Microsoft calendar (plan item M5.11).
 *
 * The same job as every other calendar with a different way of getting the
 * occurrences: an access token for the account, the window's events from the
 * provider, and the same rows through the same writer — so the manifest, the
 * wall, the shift matcher and the health notices cannot tell which kind a
 * calendar is (RFC 013 §9).
 *
 * Rule nine, as everywhere: every failure leaves the events already cached in
 * place. A sign-in the provider stopped honouring is held for a week, the
 * CalDAV path's rule — waiting will not fix it, signing in again will, and a
 * calendar knocking every fifteen minutes on a refused grant is how an
 * account gets flagged. Signing in again lifts the hold.
 */

export const OAUTH_SYNC_JOB = 'oauth-sync';

export interface OAuthSyncDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly keyring: Keyring;
  readonly timezone: () => string;
  readonly now?: () => number;
  /** Where Google and Microsoft are — set only by a test, to a stand-in. */
  readonly endpoints?: OAuthEndpoints;
}

interface SourceRow {
  readonly id: string;
  readonly enabled: number;
  readonly kind: string;
  readonly accountId: string | null;
  readonly calendar: string | null;
}

export function createOAuthSyncHandler(deps: OAuthSyncDeps): JobHandler {
  const now = deps.now ?? ((): number => Date.now());
  const endpoints = deps.endpoints ?? OAUTH;
  const events = createEventWriter(deps.db, now);
  const selectSource = deps.db.prepare(
    `SELECT id, enabled, kind, oauth_account_id AS accountId, url_encrypted AS calendar
       FROM calendar_sources WHERE id = ?`,
  );

  return async (job: JobRecord): Promise<JobResult> => {
    const sourceId = sourceIdFromJobKey(job.key);
    if (!sourceId) return { status: 'skipped', reason: 'job key carries no source id' };
    const source = selectSource.get(sourceId) as SourceRow | undefined;
    if (!source) return { status: 'skipped', reason: 'source no longer exists' };
    if (source.enabled === 0) return { status: 'skipped', reason: 'source is disabled' };
    if ((source.kind !== 'google' && source.kind !== 'microsoft') || source.accountId === null || source.calendar === null) {
      return { status: 'skipped', reason: 'source is not a signed-in calendar' };
    }

    const calendar = deps.keyring.decrypt(source.calendar, 'calendar-source-url');
    if (!calendar.ok) {
      const message = 'This calendar could not be opened. Remove it and add it again.';
      events.recordFailure(sourceId, message);
      return { status: 'failed', error: message };
    }

    const at = now();
    const token = await accessToken({ db: deps.db, keyring: deps.keyring, fetcher: deps.fetcher, now: at }, endpoints, source.accountId);
    if (!token.ok) {
      events.recordFailure(sourceId, token.message);
      return token.revoked
        ? { status: 'failed', error: token.message, retryAfterSeconds: AUTH_FAILURE_HOLD_SECONDS }
        : { status: 'failed', error: token.message };
    }

    const timezone = deps.timezone();
    const window = {
      from: new Date(at - WINDOW_BEFORE_DAYS * 86_400_000),
      to: new Date(at + WINDOW_AFTER_DAYS * 86_400_000),
      timezone,
    };
    const read =
      token.provider === 'google'
        ? await googleEvents(deps.fetcher, endpoints, token.token, calendar.value, window)
        : await microsoftEvents(deps.fetcher, endpoints, token.token, calendar.value, window);
    if (!read.ok) {
      // A 401 with a token this process thought was good: drop it, so the next
      // run asks for a new one rather than presenting the refused one again.
      if (read.status === 401) forgetAccessToken(source.accountId);
      events.recordFailure(sourceId, read.message);
      return { status: 'failed', error: read.message };
    }

    const rows = read.events.map((event) => toEventRow(event, sourceId, timezone));
    events.replace(sourceId, rows);
    events.recordSuccess(sourceId, {
      etag: null,
      lastModified: null,
      host: apiHost(token.provider, endpoints),
      eventCount: rows.length,
    });
    return { status: 'ok' };
  };
}

import { FETCH_LIMITS, type Fetcher, type JobHandler, type JobResult } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import { AGENT, pointsUrl } from './nws.js';
import { fetchAlerts, parseZones, reconcile } from './alerts.js';
import {
  applyAlerts,
  expireAlerts,
  knownAlerts,
  liveAlertKeys,
  readZones,
  recordZonePoll,
  replaceZones,
} from './alert-store.js';
import { pruneDismissals } from '../../api/rules.js';

/**
 * Polling the National Weather Service for what is in force.
 *
 * Every sixty seconds, conditionally, against the household's one or two zones.
 * A quiet zone costs a 304 and nothing else, which is what makes a minute
 * defensible — and during the weather that makes this matter, the polling has
 * to already be in rhythm rather than starting up.
 *
 * Every failure path leaves the stored alerts alone. A warning already on the
 * wall must survive a network that has gone away; that is rule nine, and it is
 * the whole reason alerts are persisted rather than derived.
 */

export interface AlertJobDeps {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly now?: () => number;
}

interface HouseholdRow {
  readonly enabled: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

function settings(db: SqliteDatabase): HouseholdRow {
  const row = db
    .prepare(
      `SELECT alerts_enabled AS enabled, latitude, longitude
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as HouseholdRow | undefined;
  return {
    enabled: row?.enabled ?? 0,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
  };
}

export function createAlertJobHandler(deps: AlertJobDeps): JobHandler {
  const now = deps.now ?? ((): number => Date.now());

  return async (): Promise<JobResult> => {
    const config = settings(deps.db);
    const at = now();

    /*
     * Expiry runs first, and runs even when alerts are switched off.
     *
     * A household that turns alerts off should not be left with a warning
     * frozen on the wall for ever, and a wall that has been unreachable comes
     * back to a set that clears itself on schedule rather than on the next
     * successful poll.
     */
    expireAlerts(deps.db, at);

    if (config.enabled !== 1 || config.latitude === null || config.longitude === null) {
      return { status: 'skipped', reason: 'alerts are off, or there is no location' };
    }

    /*
     * The zones, resolved once and kept.
     *
     * `/points` answers with both the forecast zone and the county, and the
     * answer is stable for a location for ever in practice — a household does
     * not move. Re-resolving every minute would be a request nobody needed
     * against a service that asks to be polled politely.
     */
    let zones = readZones(deps.db);
    if (zones.length === 0) {
      const response = await deps.fetcher.fetch({
        url: pointsUrl({ latitude: config.latitude, longitude: config.longitude }),
        policy: {},
        maxBytes: FETCH_LIMITS.json,
        acceptContentTypes: ['application/geo+json', 'application/json'],
        timeoutMs: 12_000,
        userAgent: AGENT,
      });

      if (response.status !== 'ok') {
        return { status: 'failed', error: 'Could not work out which alert zones cover this address.' };
      }
      const resolved = parseZones(response.body);
      if (resolved === undefined) {
        // Outside NWS coverage is the likeliest cause by a distance, and it is
        // not retryable — so it is said once rather than every minute.
        return {
          status: 'skipped',
          reason: 'That location is not in a National Weather Service zone.',
        };
      }
      replaceZones(deps.db, resolved);
      zones = readZones(deps.db);
    }

    let hardBackOff = false;
    let retryAfterSeconds: number | undefined;
    let failures = 0;

    for (const zone of zones) {
      const result = await fetchAlerts(deps.fetcher, zone.code, AGENT, zone.etag);

      if (result.status === 'not-modified') {
        recordZonePoll(deps.db, zone.code, null, null);
        continue;
      }

      if (result.status === 'failed') {
        failures++;
        recordZonePoll(deps.db, zone.code, null, result.message);
        if (result.backOffHard) {
          hardBackOff = true;
          if (result.retryAfterSeconds !== undefined) {
            retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds);
          }
        }
        // The stored alerts stay. Backing off costs freshness, never the
        // warning already on screen.
        continue;
      }

      const { upsert, remove } = reconcile(result.alerts, knownAlerts(deps.db, zone.code));
      applyAlerts(deps.db, upsert, remove);
      recordZonePoll(deps.db, zone.code, result.etag ?? null, null);
    }

    // The live set is known exactly here, which is the moment to forget
    // dismissals for warnings that are over.
    pruneDismissals(deps.db, liveAlertKeys(deps.db, at));

    if (hardBackOff) {
      /*
       * A 429 or a 5xx, which is when NWS is least reliable.
       *
       * Reported as a failure so the scheduler's own exponential backoff takes
       * over rather than this file inventing a second one — and a thousand
       * kitchen walls retrying a struggling service every sixty seconds is a
       * small part of why it was struggling.
       */
      return retryAfterSeconds === undefined
        ? { status: 'failed', error: 'The weather service is not answering.' }
        : { status: 'failed', error: 'The weather service asked us to wait.', retryAfterSeconds };
    }

    if (failures > 0 && failures === zones.length) {
      return { status: 'failed', error: 'No alert zone could be reached.' };
    }

    return { status: 'ok' };
  };
}

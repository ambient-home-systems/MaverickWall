import type { Signal } from '@maverick-wall/core';
import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import { fetchForecast, resolveForecastUrl, type Forecast } from './nws.js';
import {
  fetchForecast as fetchOpenMeteo,
  type Units,
} from './open-meteo.js';
import { alertSignals } from './alert-store.js';

/**
 * Weather, as the first panel module.
 *
 * Owns one row of `weather_cache`, one job, one slice of the manifest and one
 * section of the Display screen. Nothing outside this directory knows the
 * provider exists.
 *
 * The cache is the contract with the display, not an optimisation: the
 * manifest is assembled on every poll and must never wait on a network call.
 * The job refreshes the cache; `contribute` only ever reads it.
 */

export const WEATHER_BLOCK = 'weather';

export type Provider = 'nws' | 'openmeteo';

/**
 * Where each provider's forecast lives, and the NWS gridpoint.
 *
 * The forecast key is namespaced by provider so switching from one to the other
 * never reads the other's cached document — the wall shows the active
 * provider's forecast or nothing, never a stale mix.
 */
const forecastKey = (provider: Provider): string => `${provider}:forecast`;
const POINT_KEY = 'nws:point';

interface HouseholdWeather {
  readonly enabled: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly provider: Provider;
  readonly units: Units;
  readonly timezone: string;
}

function settings(db: SqliteDatabase): HouseholdWeather {
  const row = db
    .prepare(
      `SELECT weather_enabled AS enabled, latitude, longitude,
              weather_provider AS provider, weather_units AS units, timezone
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as
    | {
        enabled: number;
        latitude: number | null;
        longitude: number | null;
        provider: string | null;
        units: string | null;
        timezone: string | null;
      }
    | undefined;
  return {
    enabled: row?.enabled === 1,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
    // Anything but the two known providers falls back to NWS, the shipped
    // default, rather than drawing nothing on a typo.
    provider: row?.provider === 'openmeteo' ? 'openmeteo' : 'nws',
    units: row?.units === 'metric' ? 'metric' : 'imperial',
    timezone: row?.timezone ?? 'America/New_York',
  };
}

/** The household's local date, for labelling Open-Meteo's first day "Today". */
function localToday(timezone: string, now: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now);
  }
}

function readCache(db: SqliteDatabase, key: string): { payload: unknown; expiresAt: number | null } | undefined {
  const row = db
    .prepare('SELECT payload, expires_at AS expiresAt FROM weather_cache WHERE cache_key = ?')
    .get(key) as { payload: string; expiresAt: number | null } | undefined;
  if (row === undefined) return undefined;
  try {
    return { payload: JSON.parse(row.payload), expiresAt: row.expiresAt };
  } catch {
    return undefined;
  }
}

function writeCache(
  db: SqliteDatabase,
  provider: Provider,
  key: string,
  payload: unknown,
  expiresAt: number | null,
  at: number,
): void {
  db.prepare(
    `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET provider = excluded.provider, payload = excluded.payload,
       fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
  ).run(key.replace(/[^a-z0-9]/gi, '').slice(0, 32), provider, key, JSON.stringify(payload), at, expiresAt);
}

export interface WeatherPanel {
  readonly provider: Provider;
  readonly days: Forecast['days'];
  readonly fetchedAt: number;
  /** Set when the last attempt failed, so the wall can say so quietly. */
  readonly note: string | null;
}

export const weatherModule: PanelModule = {
  key: WEATHER_BLOCK,
  label: 'Weather',

  ready(db: SqliteDatabase): boolean {
    const config = settings(db);
    // A location is as necessary as the switch: a weather panel with nowhere
    // to be is a hole in the wall rather than a feature.
    return config.enabled && config.latitude !== null && config.longitude !== null;
  },

  contribute(context: ModuleContext): WeatherPanel | null {
    const provider = settings(context.db).provider;
    const cached = readCache(context.db, forecastKey(provider));
    if (cached === undefined) return null;

    const forecast = cached.payload as Partial<Forecast>;
    if (!Array.isArray(forecast.days) || forecast.days.length === 0) return null;

    /*
     * Stale is shown, and said.
     *
     * A forecast from this morning is worth far more than an empty strip, and
     * the wall already has the vocabulary for admitting age — the same
     * argument as the offline manifest.
     */
    const age = context.now - (forecast.fetchedAt ?? 0);
    const stale = age > 6 * 60 * 60_000;

    return {
      provider,
      days: forecast.days,
      fetchedAt: forecast.fetchedAt ?? 0,
      note: stale ? 'The forecast is more than six hours old.' : null,
    };
  },

  /**
   * Alerts in force, as signals.
   *
   * They belong to this module because they come from the same provider and
   * the same location, but they are deliberately not part of the panel: a
   * forecast strip is something to glance at and a tornado warning is not.
   * Kept ungated on `ready` by the registry, so a household who switched the
   * forecast strip off still gets warned.
   */
  signals(context: ModuleContext): readonly Signal[] {
    return alertSignals(context.db, context.now);
  },

  job: {
    kind: 'weather-sync',
    // NWS updates about hourly and asks clients not to poll harder.
    intervalMs: 60 * 60_000,

    async run(context: ModuleContext): Promise<void> {
      const config = settings(context.db);
      if (!config.enabled || config.latitude === null || config.longitude === null) return;

      const at = { latitude: config.latitude, longitude: config.longitude };

      // Open-Meteo is one request and needs no gridpoint; its own branch keeps
      // the NWS two-step below untouched.
      if (config.provider === 'openmeteo') {
        const result = await fetchOpenMeteo(context.fetcher, at, {
          units: config.units,
          todayIso: localToday(config.timezone, context.now),
          now: context.now,
        });
        // A failed refresh costs freshness, not the panel: the old forecast
        // stays in place, the same as the NWS branch.
        if (!result.ok) return;
        writeCache(context.db, 'openmeteo', forecastKey('openmeteo'), result.forecast, result.expiresAt, context.now);
        return;
      }

      /*
       * The gridpoint is resolved once and kept.
       *
       * A household does not move, and re-resolving the same coordinates every
       * hour is a request nobody needed. It is re-resolved only when the
       * coordinates themselves change.
       */
      const pointKey = `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`;
      const cachedPoint = readCache(context.db, POINT_KEY) as
        | { payload: { key?: string; url?: string } }
        | undefined;

      let forecastUrl = cachedPoint?.payload.key === pointKey ? cachedPoint.payload.url : undefined;
      if (forecastUrl === undefined) {
        const resolved = await resolveForecastUrl(context.fetcher, at);
        if (!('url' in resolved)) {
          writeCache(context.db, 'nws', forecastKey('nws'), { days: [], error: resolved.message }, null, context.now);
          return;
        }
        forecastUrl = resolved.url;
        writeCache(context.db, 'nws', POINT_KEY, { key: pointKey, url: forecastUrl }, null, context.now);
      }

      const result = await fetchForecast(context.fetcher, forecastUrl, context.now);
      if (!result.ok) {
        // The old forecast is left in place. A failed refresh should cost
        // freshness, not the panel.
        return;
      }
      writeCache(context.db, 'nws', forecastKey('nws'), result.forecast, result.expiresAt, context.now);
    },
  },
};

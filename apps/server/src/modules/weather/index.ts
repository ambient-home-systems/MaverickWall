import type { SqliteDatabase } from '../../db/open.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import { fetchForecast, resolveForecastUrl, type Forecast } from './nws.js';

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

/** Where the resolved gridpoint and the forecast live. */
const FORECAST_KEY = 'nws:forecast';
const POINT_KEY = 'nws:point';

interface HouseholdWeather {
  readonly enabled: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

function settings(db: SqliteDatabase): HouseholdWeather {
  const row = db
    .prepare(
      `SELECT weather_enabled AS enabled, latitude, longitude
         FROM household_settings WHERE id = 'singleton'`,
    )
    .get() as { enabled: number; latitude: number | null; longitude: number | null } | undefined;
  return {
    enabled: row?.enabled === 1,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
  };
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

function writeCache(db: SqliteDatabase, key: string, payload: unknown, expiresAt: number | null, at: number): void {
  db.prepare(
    `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
     VALUES (?, 'nws', ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload,
       fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
  ).run(key.replace(/[^a-z0-9]/gi, '').slice(0, 32), key, JSON.stringify(payload), at, expiresAt);
}

export interface WeatherPanel {
  readonly provider: 'nws';
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
    const cached = readCache(context.db, FORECAST_KEY);
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
      provider: 'nws',
      days: forecast.days,
      fetchedAt: forecast.fetchedAt ?? 0,
      note: stale ? 'The forecast is more than six hours old.' : null,
    };
  },

  job: {
    kind: 'weather-sync',
    // NWS updates about hourly and asks clients not to poll harder.
    intervalMs: 60 * 60_000,

    async run(context: ModuleContext): Promise<void> {
      const config = settings(context.db);
      if (!config.enabled || config.latitude === null || config.longitude === null) return;

      const at = { latitude: config.latitude, longitude: config.longitude };

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
          writeCache(context.db, FORECAST_KEY, { days: [], error: resolved.message }, null, context.now);
          return;
        }
        forecastUrl = resolved.url;
        writeCache(context.db, POINT_KEY, { key: pointKey, url: forecastUrl }, null, context.now);
      }

      const result = await fetchForecast(context.fetcher, forecastUrl, context.now);
      if (!result.ok) {
        // The old forecast is left in place. A failed refresh should cost
        // freshness, not the panel.
        return;
      }
      writeCache(context.db, FORECAST_KEY, result.forecast, result.expiresAt, context.now);
    },
  },
};

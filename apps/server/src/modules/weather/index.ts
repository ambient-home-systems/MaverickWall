import type { Signal } from '@maverick-wall/core';
import { wallClockInZone } from '@maverick-wall/calendar';
import type { SqliteDatabase } from '../../db/open.js';
import { z } from '../../validation.js';
import type { ModuleContext, PanelModule } from '../registry.js';
import { fetchForecast, fetchHourly, resolvePoint, type Coordinates, type Forecast } from './nws.js';
import { fetchObservation, fetchStations } from './nws-observations.js';
import {
  airScaleFor,
  fetchAirQuality,
  fetchOpenMeteo,
  unitsFor,
  type Units,
} from './open-meteo.js';
import {
  AIR_MAX_AGE_MS,
  presentCurrent,
  presentHourly,
  type AirQuality,
  type ConditionsReading,
  type CurrentWeather,
  type HourRecord,
  type HourlyWeather,
  type WeatherUnits,
} from './readings.js';
import { localIso, sunDay, sunIsUp } from './sun.js';
import { alertSignals } from './alert-store.js';
import { DEFAULT_TIMEZONE } from '../../timezone.js';

/**
 * Weather, as the first panel module.
 *
 * Owns its rows of `weather_cache`, one job, one slice of the manifest and one
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
 * Where each part lives (plan item P3.2).
 *
 * Namespaced by provider *and* part, so switching provider never reads the
 * other's rows and one part failing to refresh never costs another its copy —
 * the wall shows the active provider's answer or nothing, never a stale mix.
 * `forecast` is the key the strip has always read, unchanged, so a cache
 * written before the other parts existed is read exactly as it was.
 */
const forecastKey = (provider: Provider): string => `${provider}:forecast`;
const currentKey = (provider: Provider): string => `${provider}:current`;
const hourlyKey = (provider: Provider): string => `${provider}:hourly`;
/** Open-Meteo's whichever provider draws the strip: NWS has no air quality. */
const AIR_KEY = 'openmeteo:air';
const POINT_KEY = 'nws:point';
const STATIONS_KEY = 'nws:stations';

/**
 * How often each part is refreshed.
 *
 * The job runs every fifteen minutes (`JOB_TIMINGS['weather-sync']`) and asks
 * each part whether it is due, because a module has one job and the parts have
 * different lives: conditions change by the quarter hour, a forecast by the
 * hour, and NWS asks politely that nobody poll it harder than that.
 */
const PART_INTERVAL = {
  current: 15 * 60_000,
  hourly: 60 * 60_000,
  forecast: 60 * 60_000,
  air: 60 * 60_000,
} as const;

/**
 * The scheduler spreads each run by a fifth of its interval either way, so a
 * part due at fifteen minutes is asked at twelve as often as at eighteen.
 * Without the slack a run at 14:59 finds it not quite due and the reading waits
 * another quarter of an hour.
 */
const DUE_SLACK = 3 * 60_000;

interface HouseholdWeather {
  readonly enabled: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly provider: Provider;
  readonly units: Units;
  readonly timezone: string;
  readonly airQuality: boolean;
}

function settings(db: SqliteDatabase): HouseholdWeather {
  const row = db
    .prepare(
      `SELECT weather_enabled AS enabled, latitude, longitude,
              weather_provider AS provider, weather_units AS units, timezone,
              air_quality_enabled AS airQuality
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
        airQuality: number | null;
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
    // Same shared fallback the manifest and the column default use, so a
    // household with no row cannot get a forecast labelled in one zone and a
    // calendar anchored in another.
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
    airQuality: row?.airQuality === 1,
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

/**
 * Minutes east of UTC in the household's zone at an instant.
 *
 * This is the one place the sun's arithmetic meets `Intl`: `sun.ts` takes an
 * offset rather than a zone so it can stay pure, and this is what hands it
 * one — per instant, so a sunrise on the morning the clocks change is printed
 * in the offset in force at that sunrise.
 */
function offsetMinutesAt(timezone: string, instantMs: number): number {
  try {
    const wc = wallClockInZone(instantMs, timezone);
    const local = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    return Math.round((local - Math.floor(instantMs / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** The zone-dependent answers the parsers ask for, bound to one household. */
function sunContext(at: Coordinates, timezone: string): {
  readonly localTime: (instantMs: number) => string;
  readonly isDayAt: (instantMs: number) => boolean | undefined;
  readonly sunFor: (date: string) => { sunrise?: string; sunset?: string };
} {
  const localTime = (instantMs: number): string => localIso(instantMs, offsetMinutesAt(timezone, instantMs));
  return {
    localTime,
    isDayAt: (instantMs) =>
      sunIsUp(instantMs, at.latitude, at.longitude, offsetMinutesAt(timezone, instantMs)),
    sunFor: (date) => {
      // The events are a function of the date and the longitude alone; the
      // zone only decides how each is printed.
      const day = sunDay(date, at.latitude, at.longitude, 0);
      return day?.kind === 'rises'
        ? { sunrise: localTime(day.sunriseAt), sunset: localTime(day.sunsetAt) }
        : {};
    },
  };
}

interface CacheRow {
  readonly payload: unknown;
  readonly fetchedAt: number;
  readonly expiresAt: number | null;
}

function readCache(db: SqliteDatabase, key: string): CacheRow | undefined {
  const row = db
    .prepare('SELECT payload, fetched_at AS fetchedAt, expires_at AS expiresAt FROM weather_cache WHERE cache_key = ?')
    .get(key) as { payload: string; fetchedAt: number; expiresAt: number | null } | undefined;
  if (row === undefined) return undefined;
  try {
    return { payload: JSON.parse(row.payload), fetchedAt: row.fetchedAt, expiresAt: row.expiresAt };
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

/**
 * Whether a part wants refreshing.
 *
 * Never cached, or its interval has passed, or — whichever is later — the
 * provider's own expiry has. A refresh that fails writes nothing, so the part
 * stays due and is asked again on the next run while its old copy stays on
 * the wall: keep-last-good, per part.
 */
export function partDue(row: { fetchedAt: number; expiresAt: number | null } | undefined, intervalMs: number, now: number): boolean {
  if (row === undefined) return true;
  return now >= Math.max(row.fetchedAt + intervalMs, row.expiresAt ?? 0) - DUE_SLACK;
}

/*
 * The cached parts, read back.
 *
 * These are this process's own writes, so they are not a boundary in rule
 * five's sense — but a cache outlives the code that wrote it, and a row from a
 * version that shaped a part differently must cost that part rather than throw
 * inside manifest assembly. So each is checked on the way out and anything that
 * does not fit is simply absent.
 */
const glyphField = z.string().nullable();
const cachedReading = z.object({
  reading: z.looseObject({
    observedAt: z.number(),
    temp: z.number().nullable(),
    condition: z.string(),
    glyph: glyphField,
    isDay: z.boolean(),
  }),
});
const cachedHours = z.object({
  hours: z.array(
    z.looseObject({
      at: z.number(),
      end: z.number(),
      temp: z.number(),
      glyph: glyphField,
      isDay: z.boolean(),
    }),
  ),
});
const cachedAir = z.object({
  air: z.looseObject({
    aqi: z.number(),
    scale: z.enum(['us', 'eu']),
    label: z.string(),
    observedAt: z.number(),
  }),
});

function readPart<T>(db: SqliteDatabase, key: string, schema: z.ZodType<T>): T | undefined {
  const row = readCache(db, key);
  if (row === undefined) return undefined;
  const shaped = schema.safeParse(row.payload);
  return shaped.success ? shaped.data : undefined;
}

export interface WeatherPanel {
  readonly provider: Provider;
  readonly days: Forecast['days'];
  readonly fetchedAt: number;
  /** Set when the last attempt failed, so the wall can say so quietly. */
  readonly note: string | null;
  /*
   * The richer half (plan item P3.1). Absent, never null, so a panel with
   * nothing new in it serialises exactly as it did before these existed.
   */
  readonly current?: CurrentWeather;
  readonly hourly?: readonly HourlyWeather[];
  readonly units?: WeatherUnits;
  readonly air?: AirQuality;
}

/**
 * The units a provider's panel is in.
 *
 * NWS answers a forecast in Fahrenheit and mph whatever the household's
 * setting, and the Weather page says so; its observations are converted to
 * match, so a panel is never half one scale. Open-Meteo is asked for the
 * household's units, wind and rain included.
 */
function panelUnits(provider: Provider, units: Units): WeatherUnits {
  return provider === 'nws' ? unitsFor('imperial') : unitsFor(units);
}

/** Whether a day carries anything the plan added. */
function hasDayExtras(day: Forecast['days'][number]): boolean {
  return (
    day.precipChance !== undefined ||
    day.precipAmount !== undefined ||
    day.windMax !== undefined ||
    day.uvMax !== undefined ||
    day.sunrise !== undefined ||
    day.sunset !== undefined ||
    day.detail !== undefined
  );
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
    const config = settings(context.db);
    const provider = config.provider;
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

    const hours = (readPart(context.db, hourlyKey(provider), cachedHours)?.hours ?? []) as HourRecord[];
    const reading = readPart(context.db, currentKey(provider), cachedReading)?.reading as
      | ConditionsReading
      | undefined;
    const current = presentCurrent({ provider, reading, hours, now: context.now });
    const hourly = presentHourly(hours, context.now);
    const storedAir = config.airQuality
      ? (readPart(context.db, AIR_KEY, cachedAir)?.air as AirQuality | undefined)
      : undefined;
    const air =
      storedAir !== undefined && context.now - storedAir.observedAt <= AIR_MAX_AGE_MS ? storedAir : undefined;

    /*
     * Spread, never null — the whole of the byte-identical promise.
     *
     * The first four keys are the panel as it always was, in the order it
     * always had. A household whose cache holds nothing new (the first poll
     * after an upgrade, before the job has run) gets exactly that document and
     * therefore exactly that ETag. `units` rides only with a field that has a
     * unit to be read in.
     */
    const days = forecast.days;
    const richer = current !== undefined || hourly.length > 0 || days.some(hasDayExtras);
    return {
      provider,
      days,
      fetchedAt: forecast.fetchedAt ?? 0,
      note: stale ? 'The forecast is more than six hours old.' : null,
      ...(current === undefined ? {} : { current }),
      ...(hourly.length === 0 ? {} : { hourly }),
      ...(richer ? { units: panelUnits(provider, config.units) } : {}),
      ...(air === undefined ? {} : { air }),
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
    /*
     * Fifteen minutes, and each part decides whether it is due (plan item
     * P3.2). The interval the scheduler actually uses is
     * `JOB_TIMINGS['weather-sync']`, which says the same thing.
     */
    intervalMs: 15 * 60_000,

    async run(context: ModuleContext): Promise<void> {
      const config = settings(context.db);
      if (!config.enabled || config.latitude === null || config.longitude === null) return;

      const at = { latitude: config.latitude, longitude: config.longitude };
      const sun = sunContext(at, config.timezone);

      if (config.provider === 'openmeteo') await refreshOpenMeteo(context, at, config, sun);
      else await refreshNws(context, at, sun);

      /*
       * Air quality, when the household asked for it (Q5: off unless they
       * did). A second host, and the same one whichever provider draws the
       * strip, because NWS has none.
       */
      if (config.airQuality && partDue(readCache(context.db, AIR_KEY), PART_INTERVAL.air, context.now)) {
        const air = await fetchAirQuality(context.fetcher, at, airScaleFor(config.timezone));
        if (air !== undefined) writeCache(context.db, 'openmeteo', AIR_KEY, { air }, null, context.now);
      }
    },
  },
};

type Sun = ReturnType<typeof sunContext>;

/**
 * Open-Meteo: one request for every part that is due.
 *
 * The answer always carries all three, and only the due ones are written — so
 * the days are re-stamped hourly, as they always were, rather than every time
 * the temperature is. A part the answer did not carry keeps its old copy and
 * stays due.
 */
async function refreshOpenMeteo(
  context: ModuleContext,
  at: Coordinates,
  config: HouseholdWeather,
  sun: Sun,
): Promise<void> {
  const now = context.now;
  const due = {
    forecast: partDue(readCache(context.db, forecastKey('openmeteo')), PART_INTERVAL.forecast, now),
    current: partDue(readCache(context.db, currentKey('openmeteo')), PART_INTERVAL.current, now),
    hourly: partDue(readCache(context.db, hourlyKey('openmeteo')), PART_INTERVAL.hourly, now),
  };
  if (!due.forecast && !due.current && !due.hourly) return;

  const result = await fetchOpenMeteo(context.fetcher, at, {
    units: config.units,
    todayIso: localToday(config.timezone, now),
    now,
    localTime: sun.localTime,
    isDayAt: sun.isDayAt,
  });
  // A failed refresh costs freshness, not the panel: every old part stays.
  if (!result.ok) return;
  const { forecast, current, hours } = result.parts;
  if (due.forecast && forecast !== undefined) {
    writeCache(context.db, 'openmeteo', forecastKey('openmeteo'), forecast, null, now);
  }
  if (due.current && current !== undefined) {
    writeCache(context.db, 'openmeteo', currentKey('openmeteo'), { reading: current }, null, now);
  }
  if (due.hourly && hours !== undefined) {
    writeCache(context.db, 'openmeteo', hourlyKey('openmeteo'), { hours }, null, now);
  }
}

/**
 * NWS: the gridpoint once, then each part from its own document.
 *
 * The forecast and the hourly forecast hourly, the nearest station's latest
 * observation every fifteen minutes, and the station list once per location,
 * cached like the gridpoint (`nws:stations`).
 */
async function refreshNws(context: ModuleContext, at: Coordinates, sun: Sun): Promise<void> {
  const now = context.now;
  const due = {
    forecast: partDue(readCache(context.db, forecastKey('nws')), PART_INTERVAL.forecast, now),
    current: partDue(readCache(context.db, currentKey('nws')), PART_INTERVAL.current, now),
    hourly: partDue(readCache(context.db, hourlyKey('nws')), PART_INTERVAL.hourly, now),
  };
  if (!due.forecast && !due.current && !due.hourly) return;

  /*
   * The gridpoint is resolved once and kept.
   *
   * A household does not move, and re-resolving the same coordinates every
   * hour is a request nobody needed. It is re-resolved only when the
   * coordinates themselves change — or once, for a gridpoint cached before the
   * hourly and station URLs were kept beside it (`extras` marks one that has
   * been asked for them, whether or not the answer had them).
   */
  const pointKey = `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`;
  const cachedPoint = readCache(context.db, POINT_KEY)?.payload as
    | { key?: string; url?: string; hourlyUrl?: string; stationsUrl?: string; extras?: boolean }
    | undefined;

  let point =
    cachedPoint?.key === pointKey && cachedPoint.url !== undefined && cachedPoint.extras === true
      ? cachedPoint
      : undefined;
  if (point === undefined) {
    /*
     * An unresolved location is asked about with the forecast, hourly — not
     * with the conditions every fifteen minutes. A household outside the
     * United States on NWS gets a 404 from `/points` however often it asks,
     * and the job used to ask once an hour; the faster cadence must not make
     * that four. The one exception is a gridpoint resolved by an earlier
     * release, before the hourly and station URLs were kept: that is asked for
     * once, at once, rather than an hour after the upgrade.
     */
    const upgrading = cachedPoint?.key === pointKey && cachedPoint.url !== undefined;
    if (!due.forecast && !upgrading) return;
    const resolved = await resolvePoint(context.fetcher, at);
    if (!('url' in resolved)) {
      writeCache(context.db, 'nws', forecastKey('nws'), { days: [], error: resolved.message }, null, now);
      return;
    }
    point = { key: pointKey, ...resolved, extras: true };
    writeCache(context.db, 'nws', POINT_KEY, point, null, now);
  }

  if (due.forecast && point.url !== undefined) {
    const result = await fetchForecast(context.fetcher, point.url, now, 5, sun.sunFor);
    // The old forecast is left in place. A failed refresh should cost
    // freshness, not the panel.
    if (result.ok) writeCache(context.db, 'nws', forecastKey('nws'), result.forecast, result.expiresAt, now);
  }

  if (due.hourly && point.hourlyUrl !== undefined) {
    const hours = await fetchHourly(context.fetcher, point.hourlyUrl, now, sun.isDayAt);
    if (hours !== undefined) writeCache(context.db, 'nws', hourlyKey('nws'), { hours }, null, now);
  }

  if (due.current && point.stationsUrl !== undefined) {
    const cachedStations = readCache(context.db, STATIONS_KEY)?.payload as
      | { key?: string; stations?: unknown }
      | undefined;
    let stations =
      cachedStations?.key === pointKey && Array.isArray(cachedStations.stations)
        ? (cachedStations.stations.filter((id) => typeof id === 'string') as string[])
        : [];
    if (stations.length === 0) {
      stations = (await fetchStations(context.fetcher, point.stationsUrl)) ?? [];
      if (stations.length > 0) {
        writeCache(context.db, 'nws', STATIONS_KEY, { key: pointKey, stations }, null, now);
      }
    }
    const nearest = stations[0];
    if (nearest !== undefined) {
      const reading = await fetchObservation(context.fetcher, nearest, sun.isDayAt);
      // A station that answered is written even with no temperature in it:
      // that is its latest word, and the fallback to the hourly forecast is
      // `presentCurrent`'s, at assembly.
      if (reading !== undefined) writeCache(context.db, 'nws', currentKey('nws'), { reading }, null, now);
    }
  }
}

import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import type { Coordinates, Forecast, ForecastDay } from './nws.js';
import type { GlyphKey } from '../../glyphs.js';
import {
  airLabel,
  compassPoint,
  type AirQuality,
  type ConditionsReading,
  type HourRecord,
  type WeatherUnits,
} from './readings.js';

/**
 * Open-Meteo — the second forecast provider, and the reason weather is a choice.
 *
 * Where NWS is the United States only and takes two requests (a point resolves
 * to a gridpoint, the gridpoint to a forecast), Open-Meteo is worldwide,
 * key-less, and answers in one. It hands back daily maxima, minima and a WMO
 * weather code rather than prose, so the glyph is mapped from the code here the
 * way `glyphFor` maps it from NWS wording. Everything it produces is the same
 * `Forecast` shape NWS produces, so the panel, the cache and the wall never
 * learn there is a second provider.
 *
 * Public https only. The URL carries the household's coordinates, which are
 * numbers validated on the way in, and the whole request still goes through the
 * SSRF-guarded fetcher (rule four) — Open-Meteo lives on the public internet and
 * there is no LAN opt-in here.
 */

export type Units = 'metric' | 'imperial';

/**
 * WMO weather-interpretation codes to a glyph key.
 *
 * The same keys `glyphFor` maps NWS's wording to, so the two providers draw the
 * same weather the same way — one vocabulary, resolved on the server, handed to
 * both renderers. Grouped as Open-Meteo documents the codes; anything unmapped
 * answers `null` and the strip draws no glyph, exactly as the NWS mapping does.
 */
export function glyphForCode(code: number): GlyphKey | null {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly-clear';
  if (code === 2) return 'partly-cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code === 56 || code === 57 || code === 66 || code === 67) return 'sleet'; // freezing
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code === 85 || code === 86) return 'snow'; // snow showers
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return null;
}

/*
 * The document, validated defensively — a missing array is an empty forecast,
 * never a throw.
 *
 * The four daily arrays the strip has always read keep their `.default`, so
 * their shape is exactly what it was. Everything added for the richer panel
 * (plan item P3.1) is `.catch`, per field: a provider that sends one of them
 * as the wrong type costs that field, never the forecast behind it.
 */
const numbers = z.array(z.number().nullable()).catch([]);
const strings = z.array(z.string().nullable()).catch([]);

const forecastDocument = z.object({
  /*
   * The one offset every local time in the answer is written in. Open-Meteo
   * keeps it for the whole response, even across a clock change (Sydney's
   * sunrises in the captured spread run on without a jump over 4 October), so
   * this, and not the zone's rules, is what turns its times back into instants.
   * Absent, nothing time-stamped in the answer can be placed, and is dropped.
   */
  utc_offset_seconds: z.number().int().optional().catch(undefined),
  daily: z
    .object({
      time: z.array(z.string()).default([]),
      weather_code: z.array(z.number()).default([]),
      temperature_2m_max: z.array(z.number().nullable()).default([]),
      temperature_2m_min: z.array(z.number().nullable()).default([]),
      precipitation_probability_max: numbers,
      precipitation_sum: numbers,
      wind_speed_10m_max: numbers,
      uv_index_max: numbers,
      sunrise: strings,
      sunset: strings,
    })
    .default({
      time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
      precipitation_probability_max: [], precipitation_sum: [], wind_speed_10m_max: [],
      uv_index_max: [], sunrise: [], sunset: [],
    }),
  current: z
    .looseObject({
      time: z.string(),
      temperature_2m: z.number(),
      apparent_temperature: z.number().nullish().catch(undefined),
      relative_humidity_2m: z.number().nullish().catch(undefined),
      weather_code: z.number().nullish().catch(undefined),
      is_day: z.number().nullish().catch(undefined),
      wind_speed_10m: z.number().nullish().catch(undefined),
      wind_direction_10m: z.number().nullish().catch(undefined),
      wind_gusts_10m: z.number().nullish().catch(undefined),
      uv_index: z.number().nullish().catch(undefined),
    })
    .optional()
    .catch(undefined),
  hourly: z
    .looseObject({
      time: z.array(z.string()).catch([]),
      temperature_2m: numbers,
      precipitation_probability: numbers,
      weather_code: numbers,
      is_day: numbers,
    })
    .optional()
    .catch(undefined),
});

type ForecastDocument = z.infer<typeof forecastDocument>;

const EMPTY_DOCUMENT: ForecastDocument = {
  utc_offset_seconds: undefined,
  daily: {
    time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [],
    precipitation_probability_max: [], precipitation_sum: [], wind_speed_10m_max: [],
    uv_index_max: [], sunrise: [], sunset: [],
  },
  current: undefined,
  hourly: undefined,
};

/** The units a household's setting asks Open-Meteo for, as the panel names them. */
export function unitsFor(units: Units): WeatherUnits {
  return units === 'metric'
    ? { temp: 'C', wind: 'km/h', precip: 'mm' }
    : { temp: 'F', wind: 'mph', precip: 'in' };
}

/**
 * WMO weather-interpretation codes, in words.
 *
 * The same families `glyphForCode` draws, said the way a person says them —
 * sentence case, like the plan's "Light rain", and short enough to sit under a
 * temperature. Open-Meteo sends a code and no prose, so this is the only place
 * the current conditions get a sentence. A code nobody predicted is `''`: no
 * words is honest, a guessed word is not.
 */
const CONDITION_WORDS: Readonly<Record<number, string>> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Light snow showers',
  86: 'Snow showers',
  95: 'Thunderstorms',
  96: 'Thunderstorms with hail',
  99: 'Thunderstorms with heavy hail',
};

export function conditionWords(code: number): string {
  return CONDITION_WORDS[code] ?? '';
}

export function forecastUrl(at: Coordinates, units: Units, forecastDays: number): string {
  const params = new URLSearchParams({
    // Four decimals is about ten metres — plenty, and it keeps the URL short.
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    /*
     * Current, the next day's hours and the days, in one request (plan item
     * P3.2): about ninety-six a day at the fifteen-minute refresh, far inside
     * the free tier. Only the fields the panel carries — `cloud_cover` and
     * `precipitation` would be bytes nothing reads.
     */
    current:
      'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,' +
      'wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,' +
      'precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset',
    temperature_unit: units === 'metric' ? 'celsius' : 'fahrenheit',
    /*
     * Both set explicitly, never left to the default: Open-Meteo answers wind
     * in km/h and rain in millimetres whatever the temperature unit is, so an
     * imperial household would read "12 mph" off a number that is kilometres.
     */
    wind_speed_unit: units === 'metric' ? 'kmh' : 'mph',
    precipitation_unit: units === 'metric' ? 'mm' : 'inch',
    // Open-Meteo aligns the day boundaries to the location's own zone, so the
    // days are the household's days rather than UTC's.
    timezone: 'auto',
    forecast_days: String(Math.max(1, Math.min(16, forecastDays))),
    // Starting at the current hour, which is where "the next day" begins.
    forecast_hours: '24',
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

/** The second host, contacted only when the household switched it on (Q5). */
export const AIR_QUALITY_HOST = 'air-quality-api.open-meteo.com';

export function airQualityUrl(at: Coordinates): string {
  const params = new URLSearchParams({
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    current: 'us_aqi,european_aqi',
    timezone: 'auto',
  });
  return `https://${AIR_QUALITY_HOST}/v1/air-quality?${params.toString()}`;
}

/**
 * Which index a household reads: the European one in Europe, the US one
 * everywhere else.
 *
 * Keyed on the household's zone rather than the forecast's units, because a
 * British household on Fahrenheit still reads the EEA's bands in the news, and
 * the US AQI is the one most of the rest of the world's apps print.
 */
export function airScaleFor(timezone: string): 'us' | 'eu' {
  return timezone.startsWith('Europe/') ? 'eu' : 'us';
}

/** Open-Meteo's local time as an instant, in the offset its answer carries. */
function instantOf(local: string, offsetSeconds: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return undefined;
  const at = Date.parse(`${local}:00Z`);
  return Number.isFinite(at) ? at - offsetSeconds * 1000 : undefined;
}

/** The civil date after this one. */
function nextDate(date: string): string {
  const at = Date.parse(`${date}T00:00:00Z`);
  return new Date(at + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A day's sun times, or none on a day the sun does not rise or set.
 *
 * Open-Meteo says "no sunrise" with a sentinel — sunrise at the day's own
 * midnight and sunset at the same instant (polar night) or the next midnight
 * (polar day) — and a wall drawing that as a time is a wall saying the sun
 * rose at 00:00. So the sentinel is read as the absence it is. A real sunrise
 * at exactly 00:00 on the one day a polar season ends is the only thing this
 * refuses, and the NOAA calculation (`sun.ts`) agrees it has no time either.
 */
function sunTimes(
  date: string,
  sunrise: string | null | undefined,
  sunset: string | null | undefined,
  offsetSeconds: number | undefined,
  localTime: ((instantMs: number) => string) | undefined,
): { sunrise?: string; sunset?: string } {
  if (typeof sunrise !== 'string' || typeof sunset !== 'string') return {};
  const midnight = `${date}T00:00`;
  if (sunrise === midnight && (sunset === midnight || sunset === `${nextDate(date)}T00:00`)) return {};
  /*
   * Re-expressed in the household's zone when the caller can say what that is.
   * Open-Meteo prints every day in the offset of the moment it answered, so a
   * forecast that crosses a clock change would otherwise put Sunday's sunrise
   * an hour away from the clock on the wall beside it.
   */
  if (localTime !== undefined && offsetSeconds !== undefined) {
    const rise = instantOf(sunrise, offsetSeconds);
    const set = instantOf(sunset, offsetSeconds);
    if (rise === undefined || set === undefined) return {};
    return { sunrise: localTime(rise), sunset: localTime(set) };
  }
  return { sunrise, sunset };
}

/** A number the provider sent, or nothing — never a zero standing in for "unknown". */
function present(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The weekday label for an ISO date, tz-agnostic; the first is "Today". */
function label(dateIso: string, todayIso: string): string {
  if (dateIso === todayIso) return 'Today';
  // Anchored at UTC midnight so the weekday is the calendar date's own, not a
  // reading shifted across a zone boundary.
  const at = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return dateIso;
  return new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(at);
}

/** What one Open-Meteo answer holds, part by part; any part may be missing. */
export interface OpenMeteoParts {
  readonly forecast?: Forecast;
  readonly current?: ConditionsReading;
  readonly hours?: readonly HourRecord[];
}

export interface OpenMeteoParseOptions {
  readonly now: number;
  readonly units: Units;
  readonly todayIso: string;
  readonly limit: number;
  /** An instant as local ISO in the household's zone. Without it, sun times stay as sent. */
  readonly localTime?: (instantMs: number) => string;
  /** Whether the sun is up at an instant, for an answer that did not say (`sun.ts`). */
  readonly isDayAt?: (instantMs: number) => boolean | undefined;
}

/**
 * Read every part of one answer, each on its own.
 *
 * A part that is missing or malformed is simply not returned, and the job
 * keeps the copy it already has (keep-last-good per part, plan item P3.2): an
 * answer whose `hourly` block changed shape still refreshes the days.
 */
export function parseOpenMeteo(body: string, options: OpenMeteoParseOptions): OpenMeteoParts {
  const document = parseJsonOr(forecastDocument, body, EMPTY_DOCUMENT);
  const offset = document.utc_offset_seconds;
  const isDay = (flag: number | null | undefined, at: number): boolean =>
    // The provider's own flag first; the NOAA sun only when it said nothing;
    // and daylight as the last resort, because a reading drawn in the wrong
    // sky is a lesser fault than no reading at all.
    flag === 1 ? true : flag === 0 ? false : (options.isDayAt?.(at) ?? true);

  const forecast = readDays(document, options);

  let current: ConditionsReading | undefined;
  const now = document.current;
  if (now !== undefined && offset !== undefined) {
    const observedAt = instantOf(now.time, offset);
    if (observedAt !== undefined) {
      const code = present(now.weather_code) ? now.weather_code : undefined;
      current = {
        observedAt,
        temp: now.temperature_2m,
        ...(present(now.apparent_temperature) ? { feelsLike: now.apparent_temperature } : {}),
        condition: code === undefined ? '' : conditionWords(code),
        glyph: code === undefined ? null : glyphForCode(code),
        isDay: isDay(now.is_day, observedAt),
        ...(present(now.relative_humidity_2m) ? { humidity: Math.round(now.relative_humidity_2m) } : {}),
        ...(present(now.wind_speed_10m) ? { windSpeed: now.wind_speed_10m } : {}),
        ...(present(now.wind_gusts_10m) ? { windGust: now.wind_gusts_10m } : {}),
        ...(present(now.wind_direction_10m)
          ? { windDir: compassPoint(now.wind_direction_10m) as string }
          : {}),
        ...(present(now.uv_index) ? { uv: now.uv_index } : {}),
      };
    }
  }

  let hours: HourRecord[] | undefined;
  const hourly = document.hourly;
  if (hourly !== undefined && offset !== undefined) {
    hours = [];
    for (let i = 0; i < hourly.time.length; i++) {
      const at = instantOf(hourly.time[i] as string, offset);
      const temp = hourly.temperature_2m[i];
      if (at === undefined || !present(temp)) continue;
      const code = hourly.weather_code[i];
      const chance = hourly.precipitation_probability[i];
      hours.push({
        at,
        end: at + 60 * 60_000,
        temp,
        glyph: present(code) ? glyphForCode(code) : null,
        isDay: isDay(hourly.is_day[i], at),
        ...(present(chance) ? { precipChance: Math.round(chance) } : {}),
      });
    }
    // An hourly block with no usable hour in it is not a part worth keeping
    // over the one already cached.
    if (hours.length === 0) hours = undefined;
  }

  return {
    ...(forecast === undefined ? {} : { forecast }),
    ...(current === undefined ? {} : { current }),
    ...(hours === undefined ? {} : { hours }),
  };
}

function readDays(document: ForecastDocument, options: OpenMeteoParseOptions): Forecast | undefined {
  const daily = document.daily;
  /*
   * The letter only — "C", not "°C".
   *
   * The display adds the degree itself (`68°`) and appends the unit after it,
   * so the row reads "84° 69°F" with one sign rather than repeating it five
   * times across the strip. Emitting "°F" here made that "69°°F" on every
   * Open-Meteo wall, while NWS (which sends `temperatureUnit: "F"`) was right.
   * Found by a fixture written in this provider's own shape.
   */
  const unit = options.units === 'metric' ? 'C' : 'F';
  const days: ForecastDay[] = [];
  for (let i = 0; i < daily.time.length && days.length < options.limit; i++) {
    const date = daily.time[i];
    if (date === undefined) continue;
    const code = daily.weather_code[i] ?? 0;
    const chance = daily.precipitation_probability_max[i];
    const amount = daily.precipitation_sum[i];
    const wind = daily.wind_speed_10m_max[i];
    const uv = daily.uv_index_max[i];
    days.push({
      name: label(date, options.todayIso),
      // Already the household's own calendar date: the request asks for
      // `timezone: auto`, so the daily series is local to the location.
      date,
      high: daily.temperature_2m_max[i] ?? null,
      low: daily.temperature_2m_min[i] ?? null,
      unit,
      // The code in words, so an Open-Meteo day has the sentence an NWS day
      // has always had. `''` for a code nobody predicted, as before.
      summary: conditionWords(code),
      glyph: glyphForCode(code),
      ...(present(chance) ? { precipChance: Math.round(chance) } : {}),
      ...(present(amount) ? { precipAmount: amount } : {}),
      ...(present(wind) ? { windMax: wind } : {}),
      ...(present(uv) ? { uvMax: uv } : {}),
      ...sunTimes(
        date,
        daily.sunrise[i],
        daily.sunset[i],
        document.utc_offset_seconds,
        options.localTime,
      ),
    });
  }
  return days.length === 0 ? undefined : { days, fetchedAt: options.now };
}

/** The days alone, as the strip has always read them. */
export function parseForecast(
  body: string,
  at: number,
  units: Units,
  todayIso: string,
  limit: number,
): Forecast | undefined {
  return parseOpenMeteo(body, { now: at, units, todayIso, limit }).forecast;
}

/** Read an air-quality answer, on the scale the household reads. */
export function parseAirQuality(body: string, scale: 'us' | 'eu'): AirQuality | undefined {
  const document = parseJsonOr(airDocument, body, { utc_offset_seconds: undefined, current: undefined });
  const now = document.current;
  if (now === undefined || document.utc_offset_seconds === undefined) return undefined;
  const aqi = scale === 'us' ? now.us_aqi : now.european_aqi;
  if (!present(aqi)) return undefined;
  const observedAt = instantOf(now.time, document.utc_offset_seconds);
  const words = airLabel(aqi, scale);
  if (observedAt === undefined || words === undefined) return undefined;
  return { aqi: Math.round(aqi), scale, label: words, observedAt };
}

const airDocument = z.object({
  utc_offset_seconds: z.number().int().optional().catch(undefined),
  current: z
    .looseObject({
      time: z.string(),
      us_aqi: z.number().nullish().catch(undefined),
      european_aqi: z.number().nullish().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

export type OpenMeteoResult =
  | { readonly ok: true; readonly parts: OpenMeteoParts }
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

/**
 * One request for the conditions, the hours and the days.
 *
 * Returns every part it could read; the job decides which of them were due and
 * writes only those, so the days are not re-stamped every fifteen minutes just
 * because they arrived in the same answer as the temperature.
 */
export async function fetchOpenMeteo(
  fetcher: Fetcher,
  at: Coordinates,
  options: Omit<OpenMeteoParseOptions, 'limit'> & { readonly limit?: number },
): Promise<OpenMeteoResult> {
  const limit = options.limit ?? 5;
  const response = await fetcher.fetch({
    url: forecastUrl(at, options.units, limit),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });

  if (response.status !== 'ok') {
    return {
      ok: false,
      message: 'Could not reach the Open-Meteo forecast service.',
      suggestion: 'It needs an internet connection but no account or key. It will keep trying.',
    };
  }

  const parts = parseOpenMeteo(response.body, { ...options, limit });
  if (parts.forecast === undefined && parts.current === undefined && parts.hours === undefined) {
    return { ok: false, message: 'Open-Meteo answered without a forecast in it.' };
  }
  return { ok: true, parts };
}

/** The air quality where the household lives, from the second host. */
export async function fetchAirQuality(
  fetcher: Fetcher,
  at: Coordinates,
  scale: 'us' | 'eu',
): Promise<AirQuality | undefined> {
  const response = await fetcher.fetch({
    url: airQualityUrl(at),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });
  return response.status === 'ok' ? parseAirQuality(response.body, scale) : undefined;
}

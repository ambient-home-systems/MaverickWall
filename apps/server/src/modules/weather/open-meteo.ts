import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import type { Coordinates, Forecast, ForecastDay, WeatherResult } from './nws.js';

/**
 * Open-Meteo — the second forecast provider, and the reason weather is a choice.
 *
 * Where NWS is the United States only and takes two requests (a point resolves
 * to a gridpoint, the gridpoint to a forecast), Open-Meteo is worldwide,
 * key-less, and answers in one. It hands back daily maxima, minima and a WMO
 * weather code rather than prose, so the glyph is mapped from the code here the
 * way `iconFor` maps it from NWS wording. Everything it produces is the same
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
 * WMO weather-interpretation codes → a glyph the display already has.
 *
 * The same characters `iconFor` uses, so the two providers draw the same
 * weather the same way. Grouped as Open-Meteo documents the codes; anything
 * unmapped falls back to the dot, exactly as the NWS mapping does.
 */
export function iconForCode(code: number): string {
  if (code === 0) return '☀'; // clear sky
  if (code === 1) return '🌤'; // mainly clear
  if (code === 2) return '⛅'; // partly cloudy
  if (code === 3) return '☁'; // overcast
  if (code === 45 || code === 48) return '🌫'; // fog
  if (code === 56 || code === 57 || code === 66 || code === 67) return '🌨'; // freezing drizzle / rain
  if (code >= 51 && code <= 55) return '🌧'; // drizzle
  if (code >= 61 && code <= 65) return '🌧'; // rain
  if (code >= 71 && code <= 77) return '❄'; // snow
  if (code >= 80 && code <= 82) return '🌦'; // rain showers
  if (code === 85 || code === 86) return '❄'; // snow showers
  if (code >= 95 && code <= 99) return '⛈'; // thunderstorm
  return '·';
}

/** The document, validated defensively — a missing array is an empty forecast, never a throw. */
const forecastDocument = z.object({
  daily: z
    .object({
      time: z.array(z.string()).default([]),
      weather_code: z.array(z.number()).default([]),
      temperature_2m_max: z.array(z.number().nullable()).default([]),
      temperature_2m_min: z.array(z.number().nullable()).default([]),
    })
    .default({ time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] }),
});

export function forecastUrl(at: Coordinates, units: Units, forecastDays: number): string {
  const params = new URLSearchParams({
    // Four decimals is about ten metres — plenty, and it keeps the URL short.
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    temperature_unit: units === 'metric' ? 'celsius' : 'fahrenheit',
    // Open-Meteo aligns the day boundaries to the location's own zone, so the
    // days are the household's days rather than UTC's.
    timezone: 'auto',
    forecast_days: String(Math.max(1, Math.min(16, forecastDays))),
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
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

export function parseForecast(
  body: string,
  at: number,
  units: Units,
  todayIso: string,
  limit: number,
): Forecast | undefined {
  const document = parseJsonOr(forecastDocument, body, {
    daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] },
  });
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
  const unit = units === 'metric' ? 'C' : 'F';
  const days: ForecastDay[] = [];
  for (let i = 0; i < daily.time.length && days.length < limit; i++) {
    const date = daily.time[i];
    if (date === undefined) continue;
    const code = daily.weather_code[i] ?? 0;
    days.push({
      name: label(date, todayIso),
      // Already the household's own calendar date: the request asks for
      // `timezone: auto`, so the daily series is local to the location.
      date,
      high: daily.temperature_2m_max[i] ?? null,
      low: daily.temperature_2m_min[i] ?? null,
      unit,
      summary: '',
      icon: iconForCode(code),
    });
  }
  return days.length === 0 ? undefined : { days, fetchedAt: at };
}

export async function fetchForecast(
  fetcher: Fetcher,
  at: Coordinates,
  options: { units: Units; todayIso: string; now: number; limit?: number },
): Promise<WeatherResult> {
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

  const forecast = parseForecast(response.body, options.now, options.units, options.todayIso, limit);
  if (forecast === undefined) {
    return { ok: false, message: 'Open-Meteo answered without a forecast in it.' };
  }

  // Open-Meteo updates roughly hourly; a wall has no reason to poll harder, so
  // the job's own interval carries it and no upstream expiry is claimed.
  return { ok: true, forecast, expiresAt: null };
}

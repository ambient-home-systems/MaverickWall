import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import type { GlyphKey } from '../../glyphs.js';
import { celsiusToFahrenheit, kmhToMph, knownCompassPoint, type HourRecord } from './readings.js';

/**
 * The National Weather Service.
 *
 * Two requests: a point resolves to a gridpoint, and the gridpoint gives a
 * forecast. The first answer is stable for a location for ever in practice, so
 * it is cached separately and hard — re-resolving a grid the household has not
 * moved out of is a request nobody needed.
 *
 * **NWS covers the United States only.** A household anywhere else gets a
 * clear message rather than an empty panel, and the module seam is where a
 * second provider would go. Adding one speculatively before anybody has asked
 * would be inventing a second implementation to keep correct.
 *
 * Everything here returns a value. A forecast that cannot be fetched is a
 * missing panel and a note, never an exception into manifest assembly.
 */

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ForecastDay {
  /** "Monday", "Tonight" — the provider's own wording, which reads well. */
  readonly name: string;
  /**
   * The civil date this covers, `YYYY-MM-DD`, or `''` when the provider did
   * not say. What lets the agenda put a day's numbers beside that day's events
   * — a name cannot, because "Tonight" and "This Afternoon" name no weekday and
   * a weekday names no year.
   */
  readonly date: string;
  readonly high: number | null;
  readonly low: number | null;
  readonly unit: string;
  readonly summary: string;
  /** A glyph key both renderers draw themselves, or `null` for a sky neither has. */
  readonly glyph: GlyphKey | null;

  /*
   * The richer half (plan item P3.1). Every one is optional and absent rather
   * than null when the provider has nothing for it, so a day from a cache
   * written before these existed, and a day from a provider that cannot supply
   * one, serialise exactly as they always did. Units are the panel's `units`.
   */
  /** Percent. NWS: the higher of the day's and the night's. */
  readonly precipChance?: number;
  /** Open-Meteo only: NWS has it in the grid data alone. */
  readonly precipAmount?: number;
  readonly windMax?: number;
  /** Open-Meteo only. */
  readonly uvMax?: number;
  /** Local ISO time in the household's zone, `YYYY-MM-DDTHH:MM`. Absent on a polar day or night. */
  readonly sunrise?: string;
  readonly sunset?: string;
  /** NWS's `detailedForecast`, the paragraph behind `summary`. */
  readonly detail?: string;
}

export interface Forecast {
  readonly days: readonly ForecastDay[];
  readonly fetchedAt: number;
}

export type WeatherResult =
  | { readonly ok: true; readonly forecast: Forecast; readonly expiresAt: number | null }
  | { readonly ok: false; readonly message: string; readonly suggestion?: string };

/**
 * NWS asks for a contact in the agent string, and enforces it with a 403.
 *
 * The fetcher already sends this on every request; re-stating it at the NWS
 * call sites is belt and braces for the one upstream that refuses without it.
 * Re-exported rather than repeated, because two copies of a version string is
 * one version bump away from one of them being wrong.
 */
export { DEFAULT_USER_AGENT as AGENT };

export function pointsUrl(at: Coordinates): string {
  // Four decimals is about ten metres, and NWS rejects excessive precision.
  return `https://api.weather.gov/points/${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`;
}

/**
 * A glyph for a forecast, matched on the provider's own wording.
 *
 * NWS returns an icon URL, which rule three forbids the display from fetching
 * — so the summary text is mapped here instead. What it used to map to was an
 * emoji, which is the same rule broken invisibly: no emoji font ships in the
 * image, so the storm was resolved out of whatever colour bitmap set the tablet
 * happened to have, differed on every panel, and was stripped outright on
 * e-ink. It names a first-party glyph now and each renderer draws it.
 *
 * Ordered: "chance showers and thunderstorms" must match the storm before it
 * matches the shower. A summary nothing matches gets `null` and the strip draws
 * no glyph rather than a stand-in character.
 */
export function glyphFor(summary: string): GlyphKey | null {
  const text = summary.toLowerCase();
  const rules: readonly (readonly [string, GlyphKey])[] = [
    ['thunder', 'thunderstorm'],
    ['snow', 'snow'],
    ['sleet', 'sleet'],
    ['freezing', 'sleet'],
    ['fog', 'fog'],
    ['haze', 'fog'],
    ['shower', 'showers'],
    ['drizzle', 'drizzle'],
    ['rain', 'rain'],
    ['mostly cloudy', 'cloudy'],
    ['partly sunny', 'partly-cloudy'],
    ['partly cloudy', 'partly-cloudy'],
    ['mostly sunny', 'mostly-clear'],
    ['mostly clear', 'mostly-clear'],
    ['cloud', 'cloudy'],
    ['overcast', 'cloudy'],
    ['wind', 'wind'],
    ['sunny', 'clear'],
    ['clear', 'clear'],
  ];
  for (const [needle, glyph] of rules) if (text.includes(needle)) return glyph;
  return null;
}

/**
 * One forecast period.
 *
 * `name` is the only required field: it is what the row is labelled with, and
 * a period nobody can name is a column of numbers with no heading. Everything
 * else falls back rather than failing — a missing temperature is an em dash on
 * the wall, not a missing forecast.
 */
const nwsPeriod = z.looseObject({
  name: z.string().min(1),
  /*
   * Local to the forecast point, offset included — "2026-08-21T06:00:00-05:00".
   * Its date part is therefore already the household's own calendar date (the
   * forecast is for where they live), so the date needs no zone conversion and
   * this stays a pure function with no `Intl` in it. Optional: a period without
   * one still draws, it just cannot be joined to a day.
   */
  startTime: z.string().catch(''),
  isDaytime: z.boolean().catch(false),
  temperature: z.number().nullish().catch(null),
  temperatureUnit: z.string().catch('F'),
  shortForecast: z.string().catch(''),
  /*
   * The richer half (plan item P3.1), each caught on its own so a period that
   * changed one of them still folds into a day with a high and a low.
   */
  endTime: z.string().catch(''),
  probabilityOfPrecipitation: z
    .looseObject({ value: z.number().nullish().catch(null) })
    .nullish()
    .catch(null),
  /** "6 to 9 mph" in a forecast, "12 mph" in an hourly one. */
  windSpeed: z.string().catch(''),
  windDirection: z.string().catch(''),
  detailedForecast: z.string().catch(''),
  relativeHumidity: z
    .looseObject({ value: z.number().nullish().catch(null) })
    .nullish()
    .catch(null),
});

type NwsPeriod = z.infer<typeof nwsPeriod>;

/**
 * An hourly period, which is a forecast period with no name.
 *
 * Every hourly period in the captured Washington forecast has `"name": ""`, so
 * the daily schema's one required field — a row nobody can name is a column
 * of numbers with no heading — would refuse all 156 of them. An hour is named
 * by its time instead, which is required here in its place.
 */
const hourlyPeriod = nwsPeriod.extend({ name: z.string().catch(''), startTime: z.string(), endTime: z.string() });

/**
 * The fastest speed a period's wind string names, in mph, or undefined.
 *
 * NWS writes a range as prose — "6 to 9 mph", "0 to 6 mph" — and a day's wind
 * is the top of it. A string that names no speed in a unit this knows is
 * absent rather than read as calm.
 */
export function windMaxOf(text: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)(?:\s*to\s*(\d+(?:\.\d+)?))?\s*(mph|km\/h)/i.exec(text);
  if (match === null) return undefined;
  const top = Number(match[2] ?? match[1]);
  if (!Number.isFinite(top)) return undefined;
  return (match[3] as string).toLowerCase() === 'mph' ? top : kmhToMph(top);
}

/** A percent a provider sent, or undefined — never a zero standing in for "not said". */
function percentOf(quantity: { value?: number | null | undefined } | null | undefined): number | undefined {
  const value = quantity?.value;
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** The larger of two optional numbers, or whichever one exists. */
function higher(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * A detailed forecast, bounded.
 *
 * It is a paragraph somebody at a forecast office wrote, and it travels to the
 * wall; the display sanitises every string it draws, and this caps what it is
 * asked to. NWS's are two or three sentences.
 */
function detailOf(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? undefined : trimmed.slice(0, 600);
}

const forecastDocument = z.looseObject({
  properties: z.looseObject({ periods: z.array(z.unknown()).catch([]) }).catch({ periods: [] }),
});

/**
 * What `/points` resolves a location to.
 *
 * `forecast` is the one the strip cannot do without and stays required. The
 * hourly forecast and the station list are what current conditions need
 * (plan item P3.1), and a points answer without them still gives a forecast.
 */
const pointsDocument = z.looseObject({
  properties: z.looseObject({
    forecast: z.url(),
    forecastHourly: z.url().optional().catch(undefined),
    observationStations: z.url().optional().catch(undefined),
  }),
});

/**
 * Fold the provider's alternating day and night periods into days.
 *
 * NWS answers with "Tonight", "Monday", "Monday Night", … — a daytime high and
 * an overnight low as separate entries. A wall wants one row per day with both
 * numbers, and the first period may be a night, because the forecast starts
 * whenever it is now.
 */
/** The date part of an ISO local time, or `''` when it is not one. */
function civilDateOf(startTime: string): string {
  const date = startTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

export function foldPeriods(periods: readonly unknown[], limit: number): ForecastDay[] {
  // Parsed one at a time: one odd period must not cost the other six.
  const shaped: NwsPeriod[] = [];
  for (const raw of periods) {
    const one = nwsPeriod.safeParse(raw);
    if (one.success) shaped.push(one.data);
  }

  const days: ForecastDay[] = [];

  for (let index = 0; index < shaped.length && days.length < limit; index++) {
    const period = shaped[index] as NwsPeriod;

    const daytime = period.isDaytime;
    const temperature = period.temperature ?? null;
    const unit = period.temperatureUnit;
    const summary = period.shortForecast;

    if (daytime) {
      // The night that follows carries the low.
      const next = shaped[index + 1];
      const low = next !== undefined && !next.isDaytime ? (next.temperature ?? null) : null;
      const night = next !== undefined && !next.isDaytime ? next : undefined;
      days.push({
        name: period.name,
        // The daytime period's own date: "Monday" plus "Monday Night" is one
        // row, and it belongs to Monday rather than to the night after it.
        date: civilDateOf(period.startTime),
        high: temperature,
        low,
        unit,
        summary,
        glyph: glyphFor(summary),
        ...extrasOf(period, night),
      });
      index++;
      continue;
    }

    /*
     * A leading night — the wall is being looked at in the evening.
     *
     * It has a low and no high, and calling it by the provider's own name
     * ("Tonight") is better than inventing one or dropping it, because it is
     * the period the household is actually in.
     */
    days.push({
      name: period.name,
      // "Tonight" starts this evening, so its date is today's — which is the
      // day the household is standing in and the row they want it beside.
      date: civilDateOf(period.startTime),
      high: null,
      low: temperature,
      unit,
      summary,
      glyph: glyphFor(summary),
      ...extrasOf(period, undefined),
    });
  }

  return days;
}

/**
 * A day's rain chance, wind and words, from its period and the night after.
 *
 * The chance and the wind are the higher of the two, because a row stands for
 * the whole day and "a 40% chance tonight" is still that day's rain. The words
 * are the first period's own, which is the one the row is named for. Spread,
 * so a period that says nothing adds nothing.
 */
function extrasOf(
  period: NwsPeriod,
  night: NwsPeriod | undefined,
): { precipChance?: number; windMax?: number; detail?: string } {
  const chance = higher(
    percentOf(period.probabilityOfPrecipitation),
    night === undefined ? undefined : percentOf(night.probabilityOfPrecipitation),
  );
  const wind = higher(
    windMaxOf(period.windSpeed),
    night === undefined ? undefined : windMaxOf(night.windSpeed),
  );
  const detail = detailOf(period.detailedForecast);
  return {
    ...(chance === undefined ? {} : { precipChance: chance }),
    ...(wind === undefined ? {} : { windMax: wind }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Parse a forecast document. Undefined when it is not one.
 *
 * `sunFor` adds the day's sunrise and sunset, which NWS does not send for any
 * day but today: the job passes the NOAA calculation (`sun.ts`) in the
 * household's zone. Without it the days are exactly what they always were.
 */
export function parseForecast(
  body: string,
  at: number,
  limit: number,
  sunFor?: (date: string) => { sunrise?: string; sunset?: string },
): Forecast | undefined {
  const document = parseJsonOr(forecastDocument, body, { properties: { periods: [] } });
  const folded = foldPeriods(document.properties.periods, limit);
  const days =
    sunFor === undefined
      ? folded
      : folded.map((day) => (day.date === '' ? day : { ...day, ...sunFor(day.date) }));
  return days.length === 0 ? undefined : { days, fetchedAt: at };
}

/**
 * The hourly forecast, as the hours the cache keeps.
 *
 * `isDayAt` is the NOAA sun, and it is preferred over the period's own
 * `isDaytime` for a measured reason: NWS's hourly flag is a 06:00–18:00 clock,
 * not the sun — the captured Washington forecast calls 18:00 night an hour
 * before a 19:02 sunset. The flag is the fallback for a place the calculation
 * cannot answer.
 *
 * Hours that ended before `now` are dropped, and at most `keep` are kept: the
 * cache is refreshed hourly, so twenty-six is twenty-four still to come at the
 * end of its hour.
 */
export function parseHourly(
  body: string,
  now: number,
  isDayAt: (instantMs: number) => boolean | undefined,
  keep = 26,
): HourRecord[] | undefined {
  const document = parseJsonOr(forecastDocument, body, { properties: { periods: [] } });
  const hours: HourRecord[] = [];
  for (const raw of document.properties.periods) {
    if (hours.length >= keep) break;
    const shaped = hourlyPeriod.safeParse(raw);
    if (!shaped.success) continue;
    const period = shaped.data;
    const at = Date.parse(period.startTime);
    const end = Date.parse(period.endTime);
    if (!Number.isFinite(at) || !Number.isFinite(end) || end <= now) continue;
    const temp = temperatureInF(period.temperature ?? null, period.temperatureUnit);
    if (temp === null) continue;
    const chance = percentOf(period.probabilityOfPrecipitation);
    const humidity = percentOf(period.relativeHumidity);
    const wind = windMaxOf(period.windSpeed);
    const direction = knownCompassPoint(period.windDirection);
    hours.push({
      at,
      end,
      temp,
      glyph: glyphFor(period.shortForecast),
      isDay: isDayAt(at) ?? period.isDaytime,
      ...(chance === undefined ? {} : { precipChance: chance }),
      condition: period.shortForecast,
      ...(humidity === undefined ? {} : { humidity }),
      ...(wind === undefined ? {} : { windSpeed: wind }),
      ...(direction === undefined ? {} : { windDir: direction }),
    });
  }
  return hours.length === 0 ? undefined : hours;
}

/**
 * A period's temperature in Fahrenheit, the scale NWS answers in by default.
 *
 * NWS reports Fahrenheit unless asked for SI, and this module never asks, so
 * `C` is not expected; it is converted rather than drawn as Fahrenheit on the
 * day it appears. Any other letter is not a temperature this knows.
 */
function temperatureInF(value: number | null, unit: string): number | null {
  if (value === null) return null;
  if (unit === 'F') return value;
  if (unit === 'C') return celsiusToFahrenheit(value);
  return null;
}

/** What a location resolves to: the forecast, and what current conditions need. */
export interface ResolvedPoint {
  readonly url: string;
  readonly hourlyUrl?: string;
  readonly stationsUrl?: string;
}

/** The forecast URLs for a location, from the points document. */
export async function resolvePoint(
  fetcher: Fetcher,
  at: Coordinates,
): Promise<ResolvedPoint | { message: string; suggestion?: string }> {
  const response = await fetcher.fetch({
    url: pointsUrl(at),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/geo+json', 'application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });

  if (response.status !== 'ok') {
    return response.status === 'failed' && response.httpStatus === 404
      ? {
          message: 'The National Weather Service has no forecast for that location.',
          suggestion: 'It covers the United States only. Leave weather off elsewhere for now.',
        }
      : { message: describe(response) };
  }

  const document = parseJsonOr(pointsDocument, response.body, null);
  if (document === null) return { message: 'That location did not resolve to a forecast.' };
  const { forecast, forecastHourly, observationStations } = document.properties;
  return {
    url: forecast,
    ...(forecastHourly === undefined ? {} : { hourlyUrl: forecastHourly }),
    ...(observationStations === undefined ? {} : { stationsUrl: observationStations }),
  };
}

export async function fetchForecast(
  fetcher: Fetcher,
  forecastUrl: string,
  at: number,
  limit = 5,
  sunFor?: (date: string) => { sunrise?: string; sunset?: string },
): Promise<WeatherResult> {
  const response = await fetcher.fetch({
    url: forecastUrl,
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/geo+json', 'application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });

  if (response.status !== 'ok') return { ok: false, message: describe(response) };

  const forecast = parseForecast(response.body, at, limit, sunFor);
  if (forecast === undefined) {
    return { ok: false, message: 'The weather service answered without a forecast in it.' };
  }

  /*
   * The provider's own staleness hint, honoured.
   *
   * NWS updates roughly hourly and asks politely that clients not poll harder
   * than the expiry it sends. A wall has no reason to want fresher.
   */
  const expires = Date.parse(String(response.lastModified ?? ''));
  return {
    ok: true,
    forecast,
    expiresAt: Number.isFinite(expires) ? expires + 60 * 60_000 : null,
  };
}

/** The hourly forecast, or undefined when it could not be had (keep the last one). */
export async function fetchHourly(
  fetcher: Fetcher,
  hourlyUrl: string,
  now: number,
  isDayAt: (instantMs: number) => boolean | undefined,
): Promise<HourRecord[] | undefined> {
  const response = await fetcher.fetch({
    url: hourlyUrl,
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/geo+json', 'application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
  });
  return response.status === 'ok' ? parseHourly(response.body, now, isDayAt) : undefined;
}

/**
 * A failure in words.
 *
 * Takes the outcome rather than a narrowed shape: `not-modified` carries no
 * message at all, and a signature that assumed one made the compiler point out
 * that this function could be handed something it could not describe.
 */
function describe(response: { status: string; code?: string; message?: string }): string {
  switch (response.code) {
    case 'dns-failed':
    case 'network-error':
      return 'Could not reach the weather service. This machine may have no internet access.';
    case 'timeout':
      return 'The weather service did not answer in time.';
    case 'http-error':
      return 'The weather service refused the request.';
    default:
      return response.message ?? 'The weather service answered unexpectedly.';
  }
}

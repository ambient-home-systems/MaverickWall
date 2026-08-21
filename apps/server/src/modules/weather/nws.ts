import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';

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
  /** A character the display can draw without fetching anything. */
  readonly icon: string;
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
 * A character for a forecast, matched on the provider's own wording.
 *
 * NWS returns an icon URL, which rule three forbids the display from
 * fetching — so the summary text is mapped here instead and the wall draws a
 * character it already has. Ordered: "chance showers and thunderstorms" must
 * match the storm before it matches the shower.
 */
export function iconFor(summary: string): string {
  const text = summary.toLowerCase();
  const rules: readonly (readonly [string, string])[] = [
    ['thunder', '⛈'],
    ['snow', '❄'],
    ['sleet', '🌨'],
    ['freezing', '🌨'],
    ['fog', '🌫'],
    ['haze', '🌫'],
    ['shower', '🌦'],
    ['rain', '🌧'],
    ['drizzle', '🌧'],
    ['mostly cloudy', '☁'],
    ['partly sunny', '⛅'],
    ['partly cloudy', '⛅'],
    ['mostly sunny', '🌤'],
    ['mostly clear', '🌤'],
    ['cloud', '☁'],
    ['overcast', '☁'],
    ['wind', '💨'],
    ['sunny', '☀'],
    ['clear', '☀'],
  ];
  for (const [needle, glyph] of rules) if (text.includes(needle)) return glyph;
  return '·';
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
});

type NwsPeriod = z.infer<typeof nwsPeriod>;

const forecastDocument = z.looseObject({
  properties: z.looseObject({ periods: z.array(z.unknown()).catch([]) }).catch({ periods: [] }),
});

/** The forecast URL for a location, from `/points`. */
const pointsDocument = z.looseObject({
  properties: z.looseObject({ forecast: z.url() }),
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
      days.push({
        name: period.name,
        // The daytime period's own date: "Monday" plus "Monday Night" is one
        // row, and it belongs to Monday rather than to the night after it.
        date: civilDateOf(period.startTime),
        high: temperature,
        low,
        unit,
        summary,
        icon: iconFor(summary),
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
      icon: iconFor(summary),
    });
  }

  return days;
}

/** Parse a forecast document. Undefined when it is not one. */
export function parseForecast(body: string, at: number, limit: number): Forecast | undefined {
  const document = parseJsonOr(forecastDocument, body, { properties: { periods: [] } });
  const days = foldPeriods(document.properties.periods, limit);
  return days.length === 0 ? undefined : { days, fetchedAt: at };
}

/** The forecast URL for a location, from the points document. */
export async function resolveForecastUrl(
  fetcher: Fetcher,
  at: Coordinates,
): Promise<{ url: string } | { message: string; suggestion?: string }> {
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
  return { url: document.properties.forecast };
}

export async function fetchForecast(
  fetcher: Fetcher,
  forecastUrl: string,
  at: number,
  limit = 5,
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

  const forecast = parseForecast(response.body, at, limit);
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

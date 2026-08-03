import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';

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

/** NWS asks for a contact in the agent string, and enforces it. */
const AGENT = 'MaverickWall/0.1 (+https://github.com/ambient-home-systems/MaverickWall)';

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

interface NwsPeriod {
  readonly name?: unknown;
  readonly isDaytime?: unknown;
  readonly temperature?: unknown;
  readonly temperatureUnit?: unknown;
  readonly shortForecast?: unknown;
  readonly startTime?: unknown;
}

/**
 * Fold the provider's alternating day and night periods into days.
 *
 * NWS answers with "Tonight", "Monday", "Monday Night", … — a daytime high and
 * an overnight low as separate entries. A wall wants one row per day with both
 * numbers, and the first period may be a night, because the forecast starts
 * whenever it is now.
 */
export function foldPeriods(periods: readonly NwsPeriod[], limit: number): ForecastDay[] {
  const days: ForecastDay[] = [];

  for (let index = 0; index < periods.length && days.length < limit; index++) {
    const period = periods[index] as NwsPeriod;
    if (typeof period.name !== 'string') continue;

    const daytime = period.isDaytime === true;
    const temperature = typeof period.temperature === 'number' ? period.temperature : null;
    const unit = typeof period.temperatureUnit === 'string' ? period.temperatureUnit : 'F';
    const summary = typeof period.shortForecast === 'string' ? period.shortForecast : '';

    if (daytime) {
      // The night that follows carries the low.
      const next = periods[index + 1] as NwsPeriod | undefined;
      const low =
        next !== undefined && next.isDaytime === false && typeof next.temperature === 'number'
          ? next.temperature
          : null;
      days.push({ name: period.name, high: temperature, low, unit, summary, icon: iconFor(summary) });
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
    days.push({ name: period.name, high: null, low: temperature, unit, summary, icon: iconFor(summary) });
  }

  return days;
}

/** Parse a forecast document. Undefined when it is not one. */
export function parseForecast(body: string, at: number, limit: number): Forecast | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const periods = (parsed as { properties?: { periods?: unknown } }).properties?.periods;
  if (!Array.isArray(periods)) return undefined;

  const days = foldPeriods(periods as NwsPeriod[], limit);
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
    userAgent: AGENT,
  });

  if (response.status !== 'ok') {
    return response.status === 'failed' && response.httpStatus === 404
      ? {
          message: 'The National Weather Service has no forecast for that location.',
          suggestion: 'It covers the United States only. Leave weather off elsewhere for now.',
        }
      : { message: describe(response) };
  }

  try {
    const parsed = JSON.parse(response.body) as { properties?: { forecast?: unknown } };
    const url = parsed.properties?.forecast;
    if (typeof url !== 'string') return { message: 'That location did not resolve to a forecast.' };
    return { url };
  } catch {
    return { message: 'The weather service answered with something unreadable.' };
  }
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
    userAgent: AGENT,
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

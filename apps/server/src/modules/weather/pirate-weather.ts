import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import type { GlyphKey } from '../../glyphs.js';
import type { Coordinates, ForecastDay } from './nws.js';
import {
  compassPoint,
  dayLabel,
  localDateOf,
  precipIn,
  present,
  type ConditionsReading,
  type HourRecord,
  type PartsResult,
  type ReadOptions,
  type WeatherParts,
} from './readings.js';

/**
 * Pirate Weather (plan item M5.8): the Dark Sky API's shape, kept alive.
 *
 * Read from its own documentation (`docs.pirateweather.net`, "Data Blocks"
 * and "Response Examples"). One request answers the conditions, the hours and
 * the days. `units=us` is Fahrenheit, mph and inches; `units=ca` is Celsius,
 * km/h and — for an accumulation — **centimetres**, which is converted to the
 * panel's millimetres here rather than drawn as a number ten times too small.
 *
 * **The key travels in a header, never in the address.** The documented form
 * puts it in the path; the same page says an `apikey` header is accepted with
 * a placeholder in the path instead, and that is the form used, so no address
 * this application builds, logs or holds ever carries a household's key.
 */

export const PIRATE_HOST = 'api.pirateweather.net';

/** What stands in the path where the key would go; the real one is the header. */
const PATH_PLACEHOLDER = 'key-in-header';

export function pirateUrl(at: Coordinates, units: 'metric' | 'imperial'): string {
  const params = new URLSearchParams({
    units: units === 'metric' ? 'ca' : 'us',
    // Only the three blocks a panel reads.
    exclude: 'minutely,alerts,day_night',
  });
  return (
    `https://${PIRATE_HOST}/forecast/${PATH_PLACEHOLDER}/` +
    `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}?${params.toString()}`
  );
}

/**
 * The icons Pirate Weather sends, to the wall's glyph keys.
 *
 * The documented default set; `none` and anything a later version adds answer
 * `null`, so the strip draws no picture rather than a wrong one.
 */
export function glyphForIcon(icon: string): GlyphKey | null {
  switch (icon) {
    case 'clear-day':
    case 'clear-night':
      return 'clear';
    case 'partly-cloudy-day':
    case 'partly-cloudy-night':
      return 'partly-cloudy';
    case 'cloudy':
      return 'cloudy';
    case 'fog':
      return 'fog';
    case 'rain':
      return 'rain';
    case 'snow':
      return 'snow';
    case 'sleet':
    case 'hail':
      return 'sleet';
    case 'wind':
      return 'wind';
    case 'thunderstorm':
      return 'thunderstorm';
    default:
      return null;
  }
}

const num = z.number().nullish().catch(undefined);
const point = z.looseObject({
  time: z.number(),
  summary: z.string().max(400).optional().catch(undefined),
  icon: z.string().max(40).optional().catch(undefined),
  temperature: num,
  apparentTemperature: num,
  humidity: num,
  windSpeed: num,
  windGust: num,
  windBearing: num,
  uvIndex: num,
  solar: num,
  precipProbability: num,
  precipAccumulation: num,
  liquidAccumulation: num,
  temperatureMax: num,
  temperatureMin: num,
  sunriseTime: num,
  sunsetTime: num,
});
const block = z.object({ data: z.array(z.unknown()).catch([]) }).optional().catch(undefined);
const document = z.object({
  currently: z.unknown().optional(),
  hourly: block,
  daily: block,
});

type Point = z.infer<typeof point>;

/** Each point on its own: one odd entry costs that entry, never the block. */
function points(data: readonly unknown[] | undefined): Point[] {
  const out: Point[] = [];
  for (const item of data ?? []) {
    const shaped = point.safeParse(item);
    if (shaped.success) out.push(shaped.data);
  }
  return out;
}

function isDayOf(icon: string | undefined, at: number, options: ReadOptions): boolean {
  if (icon?.endsWith('-night') === true) return false;
  if (icon?.endsWith('-day') === true) return true;
  return options.isDayAt?.(at) ?? true;
}

/** Read one answer, every part on its own. */
export function parsePirateWeather(body: string, options: ReadOptions): WeatherParts {
  const answer = parseJsonOr(document, body, { currently: undefined, hourly: undefined, daily: undefined });
  const precipUnit = options.units === 'metric' ? 'cm' : 'in';
  const precipTo = options.units === 'metric' ? 'mm' : 'in';

  let current: ConditionsReading | undefined;
  const now = point.safeParse(answer.currently);
  if (now.success && present(now.data.temperature)) {
    const at = now.data.time * 1000;
    const c = now.data;
    current = {
      observedAt: at,
      temp: c.temperature as number,
      ...(present(c.apparentTemperature) ? { feelsLike: c.apparentTemperature } : {}),
      condition: c.summary ?? '',
      glyph: c.icon === undefined ? null : glyphForIcon(c.icon),
      isDay: isDayOf(c.icon, at, options),
      // A fraction here, a percentage on the panel.
      ...(present(c.humidity) ? { humidity: Math.round(c.humidity * 100) } : {}),
      ...(present(c.windSpeed) ? { windSpeed: c.windSpeed } : {}),
      ...(present(c.windGust) ? { windGust: c.windGust } : {}),
      ...(present(c.windBearing) ? { windDir: compassPoint(c.windBearing) as string } : {}),
      ...(present(c.uvIndex) ? { uv: c.uvIndex } : {}),
      ...(present(c.solar) && c.solar >= 0 ? { solar: Math.round(c.solar) } : {}),
    };
  }

  const hourly: HourRecord[] = [];
  for (const h of points(answer.hourly?.data)) {
    if (!present(h.temperature)) continue;
    const at = h.time * 1000;
    if (at + 60 * 60_000 <= options.now) continue;
    hourly.push({
      at,
      end: at + 60 * 60_000,
      temp: h.temperature,
      glyph: h.icon === undefined ? null : glyphForIcon(h.icon),
      isDay: isDayOf(h.icon, at, options),
      ...(present(h.precipProbability) ? { precipChance: Math.round(h.precipProbability * 100) } : {}),
      ...(h.summary === undefined ? {} : { condition: h.summary }),
      ...(present(h.humidity) ? { humidity: Math.round(h.humidity * 100) } : {}),
      ...(present(h.windSpeed) ? { windSpeed: h.windSpeed } : {}),
      ...(present(h.windBearing) ? { windDir: compassPoint(h.windBearing) as string } : {}),
    });
    if (hourly.length === 24) break;
  }

  const unit = options.units === 'metric' ? 'C' : 'F';
  const days: ForecastDay[] = [];
  for (const d of points(answer.daily?.data)) {
    if (days.length >= options.limit) break;
    const date = localDateOf(d.time * 1000, options);
    // Liquid alone when it is said: `precipAccumulation` adds centimetres of
    // snow to millimetres of rain, which is not an amount of anything.
    const amount = present(d.liquidAccumulation) ? d.liquidAccumulation : d.precipAccumulation;
    const amountIn = present(amount) ? precipIn(amount, precipUnit, precipTo) : undefined;
    days.push({
      name: dayLabel(date, options.todayIso),
      date,
      // The calendar day's, midnight to midnight, as every other provider's day is.
      high: present(d.temperatureMax) ? d.temperatureMax : null,
      low: present(d.temperatureMin) ? d.temperatureMin : null,
      unit,
      summary: d.summary ?? '',
      glyph: d.icon === undefined ? null : glyphForIcon(d.icon),
      ...(present(d.precipProbability) ? { precipChance: Math.round(d.precipProbability * 100) } : {}),
      ...(amountIn === undefined ? {} : { precipAmount: amountIn }),
      ...(present(d.uvIndex) ? { uvMax: d.uvIndex } : {}),
      ...(present(d.sunriseTime) && present(d.sunsetTime) && options.localTime !== undefined
        ? { sunrise: options.localTime(d.sunriseTime * 1000), sunset: options.localTime(d.sunsetTime * 1000) }
        : {}),
    });
  }

  return {
    ...(days.length === 0 ? {} : { forecast: { days, fetchedAt: options.now } }),
    ...(current === undefined ? {} : { current }),
    ...(hourly.length === 0 ? {} : { hours: hourly }),
  };
}

/** One request, with the key in the `apikey` header. */
export async function fetchPirateWeather(
  fetcher: Fetcher,
  at: Coordinates,
  key: string,
  options: ReadOptions,
): Promise<PartsResult> {
  const response = await fetcher.fetch({
    url: pirateUrl(at, options.units),
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    timeoutMs: 12_000,
    userAgent: DEFAULT_USER_AGENT,
    headers: { apikey: key },
  });
  if (response.status !== 'ok') {
    if (response.status === 'failed' && (response.httpStatus === 401 || response.httpStatus === 403)) {
      return { ok: false, message: 'Pirate Weather did not accept the key. Paste it again on the Weather screen.' };
    }
    return { ok: false, message: 'Could not reach Pirate Weather. It will be tried again.' };
  }
  const parts = parsePirateWeather(response.body, options);
  if (parts.forecast === undefined && parts.current === undefined && parts.hours === undefined) {
    return { ok: false, message: 'Pirate Weather answered without a forecast in it.' };
  }
  return { ok: true, parts };
}

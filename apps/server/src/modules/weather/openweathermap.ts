import { FETCH_LIMITS, type Fetcher, type FetchOutcome } from '@maverick-wall/core';
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
  windIn,
  type ConditionsReading,
  type HourRecord,
  type PartsResult,
  type ReadOptions,
  type WeatherParts,
} from './readings.js';

/**
 * OpenWeatherMap (plan item M5.8), through the two calls every free key
 * reaches: current weather (`/data/2.5/weather`) and the five-day forecast in
 * three-hour steps (`/data/2.5/forecast`). Read from its own documentation at
 * `openweathermap.org/current` and `/forecast5`; One Call 3.0 is a separate
 * subscription and is not asked for.
 *
 * Three things its documentation says that the reader has to honour:
 *
 * - **Wind is metres per second in metric**, and miles per hour in imperial,
 *   so a metric household's wind is converted to km/h here.
 * - **Rain and snow volumes are millimetres whatever the units**, so an
 *   imperial household's are converted to inches.
 * - **There is no daily forecast**: a day's high and low are the highest and
 *   lowest of its three-hour steps, grouped by the household's own date, and
 *   today's are of the steps still to come.
 *
 * **The key goes in the address, because nowhere else is documented.** It is
 * built into the URL in memory for the one request and nowhere else: never
 * stored in one, never logged (the fetcher logs nothing, and every sentence
 * below is this module's own rather than the fetcher's), never in a message.
 */

export const OWM_HOST = 'api.openweathermap.org';

export function owmUrl(
  kind: 'weather' | 'forecast',
  at: Coordinates,
  units: 'metric' | 'imperial',
  key: string,
): string {
  const params = new URLSearchParams({
    lat: at.latitude.toFixed(4),
    lon: at.longitude.toFixed(4),
    units,
    appid: key,
  });
  return `https://${OWM_HOST}/data/2.5/${kind}?${params.toString()}`;
}

/**
 * Weather condition ids, to the wall's glyph keys, by the groups the
 * documentation lists: 2xx thunderstorm, 3xx drizzle, 5xx rain (511 freezing,
 * 520–531 showers), 6xx snow (611–616 sleet and mixes), 7xx atmosphere, 800
 * clear, 801–804 cloud by amount.
 */
export function glyphForId(id: number): GlyphKey | null {
  if (id >= 200 && id < 300) return 'thunderstorm';
  if (id >= 300 && id < 400) return 'drizzle';
  if (id === 511) return 'sleet';
  if (id >= 520 && id < 600) return 'showers';
  if (id >= 500 && id < 600) return 'rain';
  if (id >= 611 && id <= 616) return 'sleet';
  if (id >= 600 && id < 700) return 'snow';
  if (id === 771 || id === 781) return 'wind';
  if (id >= 700 && id < 800) return 'fog';
  if (id === 800) return 'clear';
  if (id === 801) return 'mostly-clear';
  if (id === 802) return 'partly-cloudy';
  if (id === 803 || id === 804) return 'cloudy';
  return null;
}

/** "light rain" to "Light rain": the wall's sentence case. */
function sentence(text: string): string {
  return text === '' ? '' : text[0]!.toUpperCase() + text.slice(1);
}

const num = z.number().nullish().catch(undefined);
const condition = z.array(
  z.looseObject({ id: z.number(), description: z.string().max(200).catch(''), icon: z.string().max(8).catch('') }),
).catch([]);
const step = z.looseObject({
  dt: z.number(),
  main: z.looseObject({ temp: z.number(), feels_like: num, temp_min: num, temp_max: num, humidity: num }),
  weather: condition,
  wind: z.looseObject({ speed: num, deg: num, gust: num }).optional().catch(undefined),
  pop: num,
  rain: z.looseObject({ '1h': num, '3h': num }).optional().catch(undefined),
  snow: z.looseObject({ '1h': num, '3h': num }).optional().catch(undefined),
  sys: z.looseObject({ pod: z.string().optional().catch(undefined) }).optional().catch(undefined),
});
const forecastDocument = z.object({ list: z.array(z.unknown()).catch([]) });

type Step = z.infer<typeof step>;

/** Day or night: the icon's own letter (`10d`, `10n`), then the sun, then day. */
function isDayOf(s: Step, at: number, options: ReadOptions): boolean {
  const icon = s.weather[0]?.icon ?? '';
  if (icon.endsWith('n') || s.sys?.pod === 'n') return false;
  if (icon.endsWith('d') || s.sys?.pod === 'd') return true;
  return options.isDayAt?.(at) ?? true;
}

function windOf(value: number | null | undefined, options: ReadOptions): number | undefined {
  if (!present(value)) return undefined;
  return options.units === 'metric' ? windIn(value, 'm/s', 'km/h') : value;
}

/** The conditions now, from `/data/2.5/weather`. */
export function parseOwmCurrent(body: string, options: ReadOptions): ConditionsReading | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const shaped = step.safeParse(raw);
  if (!shaped.success) return undefined;
  const s = shaped.data;
  const at = s.dt * 1000;
  const first = s.weather[0];
  const wind = windOf(s.wind?.speed, options);
  const gust = windOf(s.wind?.gust, options);
  return {
    observedAt: at,
    temp: s.main.temp,
    ...(present(s.main.feels_like) ? { feelsLike: s.main.feels_like } : {}),
    condition: sentence(first?.description ?? ''),
    glyph: first === undefined ? null : glyphForId(first.id),
    isDay: isDayOf(s, at, options),
    ...(present(s.main.humidity) ? { humidity: Math.round(s.main.humidity) } : {}),
    ...(wind === undefined ? {} : { windSpeed: wind }),
    ...(gust === undefined ? {} : { windGust: gust }),
    ...(present(s.wind?.deg) ? { windDir: compassPoint(s.wind?.deg as number) as string } : {}),
  };
}

/** The hours and the days, from `/data/2.5/forecast`. */
export function parseOwmForecast(body: string, options: ReadOptions): Pick<WeatherParts, 'forecast' | 'hours'> {
  const answer = parseJsonOr(forecastDocument, body, { list: [] });
  const steps: Step[] = [];
  for (const item of answer.list) {
    const shaped = step.safeParse(item);
    if (shaped.success) steps.push(shaped.data);
  }
  const stepMs = 3 * 60 * 60_000;

  /*
   * The hours ahead are three hours apart, which is what this API has: each
   * entry is drawn at its own time, and only the next day's worth is kept.
   */
  const hours: HourRecord[] = [];
  for (const s of steps) {
    const at = s.dt * 1000;
    if (at + stepMs <= options.now || at > options.now + 24 * 60 * 60_000) continue;
    const first = s.weather[0];
    const wind = windOf(s.wind?.speed, options);
    hours.push({
      at,
      end: at + stepMs,
      temp: s.main.temp,
      glyph: first === undefined ? null : glyphForId(first.id),
      isDay: isDayOf(s, at, options),
      ...(present(s.pop) ? { precipChance: Math.round(s.pop * 100) } : {}),
      ...(first === undefined ? {} : { condition: sentence(first.description) }),
      ...(present(s.main.humidity) ? { humidity: Math.round(s.main.humidity) } : {}),
      ...(wind === undefined ? {} : { windSpeed: wind }),
      ...(present(s.wind?.deg) ? { windDir: compassPoint(s.wind?.deg as number) as string } : {}),
    });
  }

  // The steps grouped into the household's own days, in order.
  const byDate = new Map<string, Step[]>();
  for (const s of steps) {
    const date = localDateOf(s.dt * 1000, options);
    byDate.set(date, [...(byDate.get(date) ?? []), s]);
  }
  const unit = options.units === 'metric' ? 'C' : 'F';
  const days: ForecastDay[] = [];
  for (const [date, group] of byDate) {
    if (days.length >= options.limit) break;
    const highs = group.map((s) => (present(s.main.temp_max) ? s.main.temp_max : s.main.temp));
    const lows = group.map((s) => (present(s.main.temp_min) ? s.main.temp_min : s.main.temp));
    /*
     * The sky is the one nearest the middle of the day, which is what a day's
     * picture means everywhere else; a day with only night steps left (the
     * last of today) takes its first.
     */
    const noon = group.reduce((best, s) => {
      const hour = Number((options.localTime?.(s.dt * 1000) ?? new Date(s.dt * 1000).toISOString()).slice(11, 13));
      const bestHour = Number(
        (options.localTime?.(best.dt * 1000) ?? new Date(best.dt * 1000).toISOString()).slice(11, 13),
      );
      return Math.abs(hour - 13) < Math.abs(bestHour - 13) ? s : best;
    });
    const sky = noon.weather[0];
    const pops = group.map((s) => s.pop).filter(present);
    const mm = group
      .map((s) => (s.rain?.['3h'] ?? 0) + (s.snow?.['3h'] ?? 0))
      .reduce((sum, value) => sum + (present(value) ? value : 0), 0);
    const winds = group.map((s) => windOf(s.wind?.speed, options)).filter((value): value is number => value !== undefined);
    const amount = precipIn(mm, 'mm', options.units === 'metric' ? 'mm' : 'in');
    days.push({
      name: dayLabel(date, options.todayIso),
      date,
      high: Math.max(...highs),
      low: Math.min(...lows),
      unit,
      summary: sentence(sky?.description ?? ''),
      glyph: sky === undefined ? null : glyphForId(sky.id),
      ...(pops.length === 0 ? {} : { precipChance: Math.round(Math.max(...pops) * 100) }),
      ...(amount === undefined ? {} : { precipAmount: amount }),
      ...(winds.length === 0 ? {} : { windMax: Math.max(...winds) }),
      ...(options.sunFor?.(date) ?? {}),
    });
  }

  return {
    ...(days.length === 0 ? {} : { forecast: { days, fetchedAt: options.now } }),
    ...(hours.length === 0 ? {} : { hours }),
  };
}

/** Why a request failed, in this module's own words — never the fetcher's, which might name the address. */
function owmFailure(outcome: FetchOutcome): string {
  if (outcome.status === 'failed' && outcome.httpStatus === 401) {
    return (
      'OpenWeatherMap did not accept the key. A new key can take a couple of hours to start ' +
      'working; if it is older than that, paste it again on the Weather screen.'
    );
  }
  if (outcome.status === 'failed' && outcome.httpStatus === 429) {
    return 'OpenWeatherMap says the key has asked too often today. It will be tried again.';
  }
  return 'Could not reach OpenWeatherMap. It will be tried again.';
}

/** The conditions and the forecast, two requests, each part kept on its own. */
export async function fetchOpenWeatherMap(
  fetcher: Fetcher,
  at: Coordinates,
  key: string,
  options: ReadOptions,
  want: { readonly current: boolean; readonly forecast: boolean },
): Promise<PartsResult> {
  const ask = (kind: 'weather' | 'forecast'): Promise<FetchOutcome> =>
    fetcher.fetch({
      url: owmUrl(kind, at, options.units, key),
      policy: {},
      maxBytes: FETCH_LIMITS.json,
      acceptContentTypes: ['application/json'],
      timeoutMs: 12_000,
      userAgent: DEFAULT_USER_AGENT,
    });
  let failure: string | undefined;
  let current: ConditionsReading | undefined;
  if (want.current) {
    const outcome = await ask('weather');
    if (outcome.status === 'ok') current = parseOwmCurrent(outcome.body, options);
    else failure = owmFailure(outcome);
  }
  let rest: Pick<WeatherParts, 'forecast' | 'hours'> = {};
  if (want.forecast && failure === undefined) {
    const outcome = await ask('forecast');
    if (outcome.status === 'ok') rest = parseOwmForecast(outcome.body, options);
    else failure = owmFailure(outcome);
  }
  const parts: WeatherParts = { ...rest, ...(current === undefined ? {} : { current }) };
  if (parts.forecast === undefined && parts.current === undefined && parts.hours === undefined) {
    return { ok: false, message: failure ?? 'OpenWeatherMap answered without a forecast in it.' };
  }
  return { ok: true, parts };
}

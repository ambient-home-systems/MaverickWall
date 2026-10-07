import type { Fetcher } from '@maverick-wall/core';
import { z } from '../../validation.js';
import type { GlyphKey } from '../../glyphs.js';
import { buildCall, call, callService, type Connection } from '../homeassistant/client.js';
import type { ForecastDay } from './nws.js';
import {
  compassPoint,
  dayLabel,
  localDateOf,
  precipIn,
  present,
  temperatureIn,
  tenth,
  windIn,
  type ConditionsReading,
  type HourRecord,
  type PartsResult,
  type ReadOptions,
  type WeatherParts,
} from './readings.js';

/**
 * A Home Assistant weather entity as the forecast (plan item M5.8).
 *
 * Two reads, both through Home Assistant's own API. The entity's state is the
 * conditions now — its state is the condition and its attributes carry the
 * temperature, humidity and wind, each in the unit the entity names. The
 * forecast is `weather.get_forecasts`, which only reads, through the one row
 * of `HA_SERVICES` that names it (`weather.forecasts`, RFC 018 §5), `buildCall`
 * and `callService`, the one door every call leaves through. It is asked for
 * the daily forecast, or the twice-daily one when that is all the entity has,
 * and the hourly one when the entity has it.
 *
 * The entity id stays on this side, as every Home Assistant id does: the
 * panel carries values, and the wall is never told where they came from.
 */

/** `WeatherEntityFeature` in Home Assistant core's `weather/const.py`. */
const FORECAST_DAILY = 1;
const FORECAST_HOURLY = 2;
const FORECAST_TWICE_DAILY = 4;

/** An entity id this module will read: a weather entity and nothing else. */
export const WEATHER_ENTITY_PATTERN = /^weather\.[a-z0-9_]{1,250}$/;

/**
 * Home Assistant's fixed condition vocabulary (`ATTR_CONDITION_*` in core), to
 * the wall's glyphs and to words. "exceptional" has no picture: it is
 * whatever the integration could not name.
 */
const CONDITIONS: Readonly<Record<string, { readonly glyph: GlyphKey | null; readonly words: string }>> = {
  'clear-night': { glyph: 'clear', words: 'Clear' },
  cloudy: { glyph: 'cloudy', words: 'Cloudy' },
  exceptional: { glyph: null, words: 'Exceptional' },
  fog: { glyph: 'fog', words: 'Fog' },
  hail: { glyph: 'sleet', words: 'Hail' },
  lightning: { glyph: 'thunderstorm', words: 'Lightning' },
  'lightning-rainy': { glyph: 'thunderstorm', words: 'Thunderstorms' },
  partlycloudy: { glyph: 'partly-cloudy', words: 'Partly cloudy' },
  pouring: { glyph: 'rain', words: 'Heavy rain' },
  rainy: { glyph: 'rain', words: 'Rain' },
  snowy: { glyph: 'snow', words: 'Snow' },
  'snowy-rainy': { glyph: 'sleet', words: 'Sleet' },
  sunny: { glyph: 'clear', words: 'Sunny' },
  windy: { glyph: 'wind', words: 'Windy' },
  'windy-variant': { glyph: 'wind', words: 'Windy and cloudy' },
};

export function haCondition(state: string): { readonly glyph: GlyphKey | null; readonly words: string } {
  return CONDITIONS[state] ?? { glyph: null, words: '' };
}

const num = z.number().nullish().catch(undefined);
const unitText = z.string().max(16).optional().catch(undefined);
const stateDocument = z.object({
  state: z.string().max(64),
  last_updated: z.string().optional().catch(undefined),
  attributes: z
    .looseObject({
      temperature: num,
      apparent_temperature: num,
      humidity: num,
      wind_speed: num,
      wind_gust_speed: num,
      wind_bearing: z.union([z.number(), z.string().max(8)]).nullish().catch(undefined),
      uv_index: num,
      temperature_unit: unitText,
      wind_speed_unit: unitText,
      precipitation_unit: unitText,
      supported_features: z.number().int().nonnegative().optional().catch(undefined),
      friendly_name: z.string().max(200).optional().catch(undefined),
    })
    .catch({}),
});

const entry = z.looseObject({
  datetime: z.string().max(40),
  condition: z.string().max(64).nullish().catch(undefined),
  temperature: num,
  templow: num,
  precipitation: num,
  precipitation_probability: num,
  wind_speed: num,
  wind_bearing: z.union([z.number(), z.string().max(8)]).nullish().catch(undefined),
  humidity: num,
  uv_index: num,
  is_daytime: z.boolean().nullish().catch(undefined),
});

type Entry = z.infer<typeof entry>;

/** The units an entity speaks, as it names them; the defaults are Home Assistant's own metric ones. */
export interface EntityUnits {
  readonly temp: string;
  readonly wind: string;
  readonly precip: string;
}

/** The entity's state, read: the conditions now, its units and what it can forecast. */
export interface HaWeatherState {
  readonly reading: ConditionsReading | undefined;
  readonly units: EntityUnits;
  readonly features: number;
  readonly name: string | undefined;
}

function bearing(value: number | string | null | undefined): string | undefined {
  if (typeof value === 'number') return compassPoint(value);
  if (typeof value === 'string') return /^[NSEW]{1,3}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : undefined;
  return undefined;
}

export function parseHaWeatherState(body: string, options: ReadOptions): HaWeatherState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const shaped = stateDocument.safeParse(raw);
  if (!shaped.success) return undefined;
  const { state, attributes: a } = shaped.data;
  const units: EntityUnits = {
    temp: a.temperature_unit ?? '°C',
    wind: a.wind_speed_unit ?? 'km/h',
    precip: a.precipitation_unit ?? 'mm',
  };
  const tempTo = options.units === 'metric' ? 'C' : 'F';
  const windTo = options.units === 'metric' ? 'km/h' : 'mph';
  const at = Date.parse(shaped.data.last_updated ?? '');
  const observedAt = Number.isFinite(at) ? at : options.now;
  const temp = present(a.temperature) ? temperatureIn(a.temperature, units.temp, tempTo) : undefined;
  const feels = present(a.apparent_temperature) ? temperatureIn(a.apparent_temperature, units.temp, tempTo) : undefined;
  const wind = present(a.wind_speed) ? windIn(a.wind_speed, units.wind, windTo) : undefined;
  const gust = present(a.wind_gust_speed) ? windIn(a.wind_gust_speed, units.wind, windTo) : undefined;
  const dir = bearing(a.wind_bearing);
  const sky = haCondition(state);
  /*
   * "unavailable" and "unknown" are states too, and they are not weather: an
   * integration that has lost its source says so, and the panel shows no
   * "now" rather than a temperature it no longer has.
   */
  const reading: ConditionsReading | undefined =
    state === 'unavailable' || state === 'unknown'
      ? undefined
      : {
          observedAt,
          temp: temp ?? null,
          ...(feels === undefined ? {} : { feelsLike: feels }),
          condition: sky.words,
          glyph: sky.glyph,
          isDay: state === 'clear-night' ? false : (options.isDayAt?.(observedAt) ?? true),
          ...(present(a.humidity) ? { humidity: Math.round(a.humidity) } : {}),
          ...(wind === undefined ? {} : { windSpeed: wind }),
          ...(gust === undefined ? {} : { windGust: gust }),
          ...(dir === undefined ? {} : { windDir: dir }),
          ...(present(a.uv_index) ? { uv: a.uv_index } : {}),
        };
  return { reading, units, features: a.supported_features ?? 0, name: a.friendly_name };
}

/** The forecast list out of a `get_forecasts` answer, each entry on its own. */
export function forecastEntries(body: string, entityId: string): Entry[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const shaped = z
    .object({ service_response: z.record(z.string(), z.object({ forecast: z.array(z.unknown()) })) })
    .safeParse(raw);
  if (!shaped.success) return undefined;
  const list = shaped.data.service_response[entityId]?.forecast;
  if (list === undefined) return undefined;
  const out: Entry[] = [];
  for (const item of list) {
    const one = entry.safeParse(item);
    if (one.success && Number.isFinite(Date.parse(one.data.datetime))) out.push(one.data);
  }
  return out;
}

/**
 * The days, from a daily or a twice-daily forecast.
 *
 * Grouped by the household's own date either way: a daily entry is one day,
 * and a twice-daily pair is a day and its night, whose high is the day's and
 * whose low is the night's (`templow` where the integration gives one).
 */
export function haDays(entries: readonly Entry[], units: EntityUnits, options: ReadOptions): ForecastDay[] {
  const tempTo = options.units === 'metric' ? 'C' : 'F';
  const windTo = options.units === 'metric' ? 'km/h' : 'mph';
  const precipTo = options.units === 'metric' ? 'mm' : 'in';
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const date = localDateOf(Date.parse(e.datetime), options);
    groups.set(date, [...(groups.get(date) ?? []), e]);
  }
  const t = (value: number | null | undefined): number | undefined =>
    present(value) ? temperatureIn(value, units.temp, tempTo) : undefined;
  const days: ForecastDay[] = [];
  for (const [date, group] of groups) {
    if (days.length >= options.limit) break;
    const day = group.find((e) => e.is_daytime !== false) ?? group[0]!;
    const highs = group.filter((e) => e.is_daytime !== false).map((e) => t(e.temperature)).filter(present);
    const lows = group
      .map((e) => (e.is_daytime === false ? t(e.templow ?? e.temperature) : t(e.templow)))
      .filter(present);
    const chances = group.map((e) => e.precipitation_probability).filter(present);
    const amounts = group.map((e) => e.precipitation).filter(present);
    const winds = group
      .map((e) => (present(e.wind_speed) ? windIn(e.wind_speed, units.wind, windTo) : undefined))
      .filter(present);
    const uvs = group.map((e) => e.uv_index).filter(present);
    const sky = haCondition(day.condition ?? '');
    const amount = amounts.length === 0
      ? undefined
      : precipIn(amounts.reduce((sum, value) => sum + value, 0), units.precip, precipTo);
    days.push({
      name: dayLabel(date, options.todayIso),
      date,
      high: highs.length === 0 ? null : Math.max(...highs),
      low: lows.length === 0 ? null : Math.min(...lows),
      unit: tempTo,
      summary: sky.words,
      glyph: sky.glyph,
      ...(chances.length === 0 ? {} : { precipChance: Math.round(Math.max(...chances)) }),
      ...(amount === undefined ? {} : { precipAmount: amount }),
      ...(winds.length === 0 ? {} : { windMax: tenth(Math.max(...winds)) }),
      ...(uvs.length === 0 ? {} : { uvMax: Math.max(...uvs) }),
      ...(options.sunFor?.(date) ?? {}),
    });
  }
  return days;
}

/** The next day of hours, from an hourly forecast. */
export function haHours(entries: readonly Entry[], units: EntityUnits, options: ReadOptions): HourRecord[] {
  const tempTo = options.units === 'metric' ? 'C' : 'F';
  const windTo = options.units === 'metric' ? 'km/h' : 'mph';
  const hours: HourRecord[] = [];
  for (const e of entries) {
    const at = Date.parse(e.datetime);
    if (at + 60 * 60_000 <= options.now) continue;
    const temp = present(e.temperature) ? temperatureIn(e.temperature, units.temp, tempTo) : undefined;
    if (temp === undefined) continue;
    const sky = haCondition(e.condition ?? '');
    const wind = present(e.wind_speed) ? windIn(e.wind_speed, units.wind, windTo) : undefined;
    const dir = bearing(e.wind_bearing);
    hours.push({
      at,
      end: at + 60 * 60_000,
      temp,
      glyph: sky.glyph,
      isDay: e.condition === 'clear-night' ? false : (options.isDayAt?.(at) ?? true),
      ...(present(e.precipitation_probability) ? { precipChance: Math.round(e.precipitation_probability) } : {}),
      ...(sky.words === '' ? {} : { condition: sky.words }),
      ...(present(e.humidity) ? { humidity: Math.round(e.humidity) } : {}),
      ...(wind === undefined ? {} : { windSpeed: wind }),
      ...(dir === undefined ? {} : { windDir: dir }),
    });
    if (hours.length === 24) break;
  }
  return hours;
}

const GONE = 'That weather entity is not in Home Assistant any more. Choose another on the Weather screen.';

/**
 * Read the entity: its state, then each forecast it has and was due.
 *
 * Every read is through `call` or `callService`; nothing here builds a URL to
 * Home Assistant of its own.
 */
export async function fetchHaWeather(
  fetcher: Fetcher,
  connection: Connection,
  entityId: string,
  options: ReadOptions,
  want: { readonly current: boolean; readonly forecast: boolean; readonly hourly: boolean },
): Promise<PartsResult> {
  if (!WEATHER_ENTITY_PATTERN.test(entityId)) return { ok: false, message: GONE };
  const state = await call(fetcher, connection, `/states/${encodeURIComponent(entityId)}`);
  if (!state.ok) return { ok: false, message: state.httpStatus === 404 ? GONE : state.message };
  const read = parseHaWeatherState(state.body, options);
  if (read === undefined) return { ok: false, message: GONE };

  const forecastOf = async (type: 'daily' | 'twice_daily' | 'hourly'): Promise<Entry[] | undefined> => {
    const built = buildCall({ key: 'weather.forecasts', entityId, type });
    if (!built.ok) return undefined;
    const answer = await callService(fetcher, connection, built.call);
    return answer.ok ? forecastEntries(answer.body, entityId) : undefined;
  };

  let days: ForecastDay[] = [];
  if (want.forecast) {
    const type = (read.features & FORECAST_DAILY) !== 0
      ? 'daily'
      : (read.features & FORECAST_TWICE_DAILY) !== 0
        ? 'twice_daily'
        : undefined;
    const entries = type === undefined ? undefined : await forecastOf(type);
    if (entries !== undefined) days = haDays(entries, read.units, options);
  }
  let hours: HourRecord[] = [];
  if (want.hourly && (read.features & FORECAST_HOURLY) !== 0) {
    const entries = await forecastOf('hourly');
    if (entries !== undefined) hours = haHours(entries, read.units, options);
  }

  const parts: WeatherParts = {
    ...(days.length === 0 ? {} : { forecast: { days, fetchedAt: options.now } }),
    ...(want.current && read.reading !== undefined ? { current: read.reading } : {}),
    ...(hours.length === 0 ? {} : { hours }),
  };
  if (parts.forecast === undefined && parts.current === undefined && parts.hours === undefined) {
    return {
      ok: false,
      message:
        (read.features & (FORECAST_DAILY | FORECAST_TWICE_DAILY)) === 0
          ? 'That weather entity has no forecast. Choose another on the Weather screen.'
          : 'Home Assistant answered without a forecast in it.',
    };
  }
  return { ok: true, parts };
}

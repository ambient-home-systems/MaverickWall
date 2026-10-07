import { FETCH_LIMITS, type Fetcher, type FetchOutcome } from '@maverick-wall/core';
import { DEFAULT_USER_AGENT } from '../../net/fetcher.js';
import { parseJsonOr, z } from '../../validation.js';
import type { GlyphKey } from '../../glyphs.js';
import type { Coordinates, ForecastDay } from './nws.js';
import {
  compassPoint,
  dayLabel,
  present,
  type ConditionsReading,
  type PartsResult,
  type ReadOptions,
  type WeatherParts,
} from './readings.js';

/**
 * Weather Underground (plan item M5.8), through the two calls a personal
 * weather station owner's free key reaches on `api.weather.com`: the five-day
 * daily forecast by location (`/v3/wx/forecast/daily/5day`) and a station's
 * current observation (`/v2/pws/observations/current`).
 *
 * Shaped field for field on real answers published at
 * `github.com/whilei/weatherunderground-influxdb` (the fixtures say which
 * fields were kept). `units=e` answers Fahrenheit, mph and inches with the
 * station's numbers under `imperial`; `units=m` answers Celsius, km/h and
 * millimetres under `metric`.
 *
 * **What this key cannot reach is said rather than faked.** It has no hourly
 * forecast, so a panel from here has no hours ahead. And "now" is a station's
 * measurement or nothing: a station measures the air, not the sky, so the
 * picture beside its temperature is the forecast's for this part of the day.
 *
 * **The key goes in the address, because The Weather Company documents no
 * other way.** It is built into the URL in memory for one request and nowhere
 * else, as OpenWeatherMap's is.
 */

export const WU_HOST = 'api.weather.com';

/** A station id as Weather Underground prints them: `KMAHANOV10`, `ILONDON123`. */
export const WU_STATION_PATTERN = /^[A-Za-z0-9]{3,32}$/;

export function wuForecastUrl(at: Coordinates, units: 'metric' | 'imperial', key: string): string {
  const params = new URLSearchParams({
    geocode: `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`,
    format: 'json',
    units: units === 'metric' ? 'm' : 'e',
    language: 'en-US',
    apiKey: key,
  });
  return `https://${WU_HOST}/v3/wx/forecast/daily/5day?${params.toString()}`;
}

export function wuStationUrl(station: string, units: 'metric' | 'imperial', key: string): string {
  const params = new URLSearchParams({
    stationId: station,
    format: 'json',
    units: units === 'metric' ? 'm' : 'e',
    numericPrecision: 'decimal',
    apiKey: key,
  });
  return `https://${WU_HOST}/v2/pws/observations/current?${params.toString()}`;
}

/**
 * The Weather Company's icon codes, 0–47, to the wall's glyph keys.
 *
 * The published table: 0–4 and 37, 38, 47 are storms; 5–8, 10, 17, 18 and 35
 * are mixes, freezing and hail; 9 drizzle; 12 and 40 rain, 11, 39 and 45
 * showers; 13–16, 41–43 and 46 snow; 19–22 dust, fog, haze and smoke; 23, 24
 * wind; 26–28 cloud; 29, 30 partly; 31, 32 and 36 clear; 33, 34 fair. 25
 * (frigid) and 44 (not available) say nothing about the sky.
 */
export function glyphForCode(code: number): GlyphKey | null {
  if ([0, 1, 2, 3, 4, 37, 38, 47].includes(code)) return 'thunderstorm';
  if ([5, 6, 7, 8, 10, 17, 18, 35].includes(code)) return 'sleet';
  if (code === 9) return 'drizzle';
  if (code === 12 || code === 40) return 'rain';
  if ([11, 39, 45].includes(code)) return 'showers';
  if ([13, 14, 15, 16, 41, 42, 43, 46].includes(code)) return 'snow';
  if (code >= 19 && code <= 22) return 'fog';
  if (code === 23 || code === 24) return 'wind';
  if (code >= 26 && code <= 28) return 'cloudy';
  if (code === 29 || code === 30) return 'partly-cloudy';
  if (code === 31 || code === 32 || code === 36) return 'clear';
  if (code === 33 || code === 34) return 'mostly-clear';
  return null;
}

const nums = z.array(z.number().nullable()).catch([]);
const strings = z.array(z.string().nullable()).catch([]);
const forecastDocument = z.object({
  dayOfWeek: strings,
  validTimeUtc: nums,
  validTimeLocal: strings,
  temperatureMax: nums,
  temperatureMin: nums,
  calendarDayTemperatureMax: nums,
  calendarDayTemperatureMin: nums,
  narrative: strings,
  qpf: nums,
  sunriseTimeUtc: nums,
  sunsetTimeUtc: nums,
  daypart: z
    .array(
      z.looseObject({
        dayOrNight: strings,
        iconCode: nums,
        precipChance: nums,
        wxPhraseLong: strings,
        windSpeed: nums,
        uvIndex: nums,
      }),
    )
    .catch([]),
});
const EMPTY = {
  dayOfWeek: [], validTimeUtc: [], validTimeLocal: [], temperatureMax: [], temperatureMin: [],
  calendarDayTemperatureMax: [], calendarDayTemperatureMin: [], narrative: [], qpf: [],
  sunriseTimeUtc: [], sunsetTimeUtc: [], daypart: [],
};

/** The days, from the five-day forecast. */
export function parseWuForecast(body: string, options: ReadOptions): WeatherParts['forecast'] {
  const answer = parseJsonOr(forecastDocument, body, EMPTY);
  const part = answer.daypart[0];
  const unit = options.units === 'metric' ? 'C' : 'F';
  const days: ForecastDay[] = [];
  for (let i = 0; i < answer.validTimeLocal.length && days.length < options.limit; i++) {
    const local = answer.validTimeLocal[i];
    if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(local)) continue;
    // Already the location's own date: The Weather Company's day is local to the place.
    const date = local.slice(0, 10);
    /*
     * The day part, then the night. Today's day part is null once the
     * afternoon is over, which is when the night's picture is the honest one.
     */
    const pick = <T>(values: readonly (T | null)[] | undefined): T | undefined =>
      values?.[2 * i] ?? values?.[2 * i + 1] ?? undefined;
    const code = pick(part?.iconCode);
    const chances = [part?.precipChance[2 * i], part?.precipChance[2 * i + 1]].filter(present);
    const winds = [part?.windSpeed[2 * i], part?.windSpeed[2 * i + 1]].filter(present);
    // The day part's alone: a night's UV index is always 0, which says nothing about a day.
    const uv = part?.uvIndex[2 * i] ?? undefined;
    const qpf = answer.qpf[i];
    const rise = answer.sunriseTimeUtc[i];
    const set = answer.sunsetTimeUtc[i];
    // `temperatureMax` is null once today's has passed; the calendar day's is the day's high either way.
    const high = answer.temperatureMax[i] ?? answer.calendarDayTemperatureMax[i] ?? null;
    const low = answer.temperatureMin[i] ?? answer.calendarDayTemperatureMin[i] ?? null;
    days.push({
      name: dayLabel(date, options.todayIso),
      date,
      high,
      low,
      unit,
      summary: pick(part?.wxPhraseLong) ?? answer.narrative[i] ?? '',
      glyph: code === undefined ? null : glyphForCode(code),
      ...(chances.length === 0 ? {} : { precipChance: Math.round(Math.max(...chances)) }),
      ...(present(qpf) ? { precipAmount: qpf } : {}),
      ...(winds.length === 0 ? {} : { windMax: Math.max(...winds) }),
      ...(uv === undefined ? {} : { uvMax: uv }),
      ...(present(rise) && present(set) && options.localTime !== undefined
        ? { sunrise: options.localTime(rise * 1000), sunset: options.localTime(set * 1000) }
        : {}),
    });
  }
  return days.length === 0 ? undefined : { days, fetchedAt: options.now };
}

const reading = z.number().nullish().catch(undefined);
const observation = z.looseObject({
  epoch: z.number(),
  humidity: reading,
  winddir: reading,
  uv: reading,
  solarRadiation: reading,
  imperial: z.looseObject({ temp: reading, windSpeed: reading, windGust: reading }).optional().catch(undefined),
  metric: z.looseObject({ temp: reading, windSpeed: reading, windGust: reading }).optional().catch(undefined),
});
const stationDocument = z.object({ observations: z.array(z.unknown()).catch([]) });

/**
 * A station's latest reading, with the sky borrowed from the forecast.
 *
 * `sky` is what the forecast says for this part of the day; a station has no
 * opinion about cloud, so its own reading carries none.
 */
export function parseWuStation(
  body: string,
  options: ReadOptions,
  sky: { readonly condition: string; readonly glyph: GlyphKey | null } | undefined,
): ConditionsReading | undefined {
  const answer = parseJsonOr(stationDocument, body, { observations: [] });
  const shaped = observation.safeParse(answer.observations[0]);
  if (!shaped.success) return undefined;
  const o = shaped.data;
  const values = options.units === 'metric' ? o.metric : o.imperial;
  if (values === undefined) return undefined;
  const at = o.epoch * 1000;
  return {
    observedAt: at,
    // Null is kept, as NWS's is: the decision about a station with no
    // temperature is `presentCurrent`'s, at assembly.
    temp: present(values.temp) ? values.temp : null,
    condition: sky?.condition ?? '',
    glyph: sky?.glyph ?? null,
    isDay: options.isDayAt?.(at) ?? true,
    ...(present(o.humidity) ? { humidity: Math.round(o.humidity) } : {}),
    ...(present(values.windSpeed) ? { windSpeed: values.windSpeed } : {}),
    ...(present(values.windGust) ? { windGust: values.windGust } : {}),
    ...(present(o.winddir) ? { windDir: compassPoint(o.winddir) as string } : {}),
    ...(present(o.uv) ? { uv: o.uv } : {}),
    ...(present(o.solarRadiation) && o.solarRadiation >= 0 ? { solar: Math.round(o.solarRadiation) } : {}),
  };
}

function wuFailure(outcome: FetchOutcome, station: boolean): string {
  if (outcome.status === 'failed' && (outcome.httpStatus === 401 || outcome.httpStatus === 403)) {
    return 'Weather Underground did not accept the key. Paste it again on the Weather screen.';
  }
  if (station && outcome.status === 'failed' && (outcome.httpStatus === 204 || outcome.httpStatus === 404)) {
    return 'Weather Underground has no reading from that station. Check its id on the Weather screen.';
  }
  return 'Could not reach Weather Underground. It will be tried again.';
}

/** The forecast, then the station when there is one. */
export async function fetchWunderground(
  fetcher: Fetcher,
  at: Coordinates,
  key: string,
  station: string | null,
  options: ReadOptions,
  want: { readonly current: boolean; readonly forecast: boolean },
): Promise<PartsResult> {
  const ask = (url: string): Promise<FetchOutcome> =>
    fetcher.fetch({
      url,
      policy: {},
      maxBytes: FETCH_LIMITS.json,
      acceptContentTypes: ['application/json'],
      timeoutMs: 12_000,
      userAgent: DEFAULT_USER_AGENT,
    });
  // The forecast is asked whenever the station is, for the sky to put beside it.
  const forecastOutcome = want.forecast || (want.current && station !== null)
    ? await ask(wuForecastUrl(at, options.units, key))
    : undefined;
  if (forecastOutcome !== undefined && forecastOutcome.status !== 'ok') {
    return { ok: false, message: wuFailure(forecastOutcome, false) };
  }
  const forecast = forecastOutcome?.status === 'ok' ? parseWuForecast(forecastOutcome.body, options) : undefined;

  let current: ConditionsReading | undefined;
  if (want.current && station !== null) {
    const outcome = await ask(wuStationUrl(station, options.units, key));
    if (outcome.status !== 'ok') {
      if (forecast === undefined) return { ok: false, message: wuFailure(outcome, true) };
    } else {
      const today = forecast?.days[0];
      current = parseWuStation(
        outcome.body,
        options,
        today === undefined ? undefined : { condition: today.summary, glyph: today.glyph },
      );
    }
  }

  const parts: WeatherParts = {
    ...(want.forecast && forecast !== undefined ? { forecast } : {}),
    ...(current === undefined ? {} : { current }),
  };
  if (parts.forecast === undefined && parts.current === undefined) {
    return { ok: false, message: 'Weather Underground answered without a forecast in it.' };
  }
  return { ok: true, parts };
}

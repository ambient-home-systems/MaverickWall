import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wallClockInZone } from '@maverick-wall/calendar';

import { forecastUrl, parseOpenMeteo } from '../src/modules/weather/open-meteo.js';
import { parsePirateWeather, pirateUrl } from '../src/modules/weather/pirate-weather.js';
import { glyphForId, owmUrl, parseOwmCurrent, parseOwmForecast } from '../src/modules/weather/openweathermap.js';
import {
  glyphForCode,
  parseWuForecast,
  parseWuStation,
  wuForecastUrl,
  wuStationUrl,
} from '../src/modules/weather/wunderground.js';
import { forecastEntries, haDays, haHours, parseHaWeatherState } from '../src/modules/weather/ha-weather.js';
import { localIso } from '../src/modules/weather/sun.js';
import { precipIn, temperatureIn, windIn, type ReadOptions } from '../src/modules/weather/readings.js';
import { PROVIDER_FACTS, WEATHER_PROVIDERS, providerOr } from '../src/modules/weather/providers.js';

/**
 * The five providers plan item M5.8 adds, read from their own answers.
 *
 * DWD ICON is two live captures (`fixtures/weather-providers/real/`). The
 * others cannot be captured without a household's key, so each fixture is the
 * provider's own documented example or a real published answer, kept field for
 * field — the README beside them says which and where from. Every assertion
 * here is a number the fixture holds, worked out by hand from it, so a reader
 * that agreed with itself would still be caught.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'weather-providers');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

/** `localTime` in a zone, the way the job builds it from `sun.ts`. */
function inZone(zone: string): (instantMs: number) => string {
  return (instantMs) => {
    const wc = wallClockInZone(instantMs, zone);
    const local = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    return localIso(instantMs, Math.round((local - Math.floor(instantMs / 1000) * 1000) / 60_000));
  };
}

function options(now: number, zone: string, units: 'metric' | 'imperial', todayIso: string): ReadOptions {
  return { now, units, todayIso, limit: 5, localTime: inZone(zone), isDayAt: () => true };
}

describe('the provider table', () => {
  it('names seven providers, each with what a household reads about it', () => {
    expect(WEATHER_PROVIDERS).toEqual([
      'nws', 'openmeteo', 'dwd', 'homeassistant', 'openweathermap', 'pirateweather', 'wunderground',
    ]);
    for (const key of WEATHER_PROVIDERS) {
      expect(PROVIDER_FACTS[key].name.length).toBeGreaterThan(0);
      expect(PROVIDER_FACTS[key].about.length).toBeGreaterThan(40);
    }
    // A value nobody recognises is the shipped default, never nothing.
    expect(providerOr('darksky')).toBe('nws');
    expect(providerOr('pirateweather')).toBe('pirateweather');
  });

  it('converts into the panel’s units, and refuses a unit it does not know', () => {
    expect(temperatureIn(68, '°F', 'C')).toBe(20);
    expect(temperatureIn(20, '°C', 'F')).toBe(68);
    expect(temperatureIn(20, 'K', 'C')).toBeUndefined();
    expect(windIn(10, 'm/s', 'km/h')).toBe(36);
    expect(windIn(10, 'mph', 'km/h')).toBe(16.1);
    expect(windIn(36, 'km/h', 'mph')).toBe(22.4);
    expect(windIn(10, 'kn', 'mph')).toBe(11.5);
    expect(windIn(10, 'furlongs', 'mph')).toBeUndefined();
    expect(precipIn(0.5, 'cm', 'mm')).toBe(5);
    expect(precipIn(25.4, 'mm', 'in')).toBe(1);
  });
});

describe('DWD ICON, through Open-Meteo', () => {
  it('asks the dwd-icon endpoint with the forecast endpoint’s own parameters', () => {
    const at = { latitude: 52.52, longitude: 13.405 };
    const dwd = new URL(forecastUrl(at, 'metric', 5, 'dwd-icon'));
    const best = new URL(forecastUrl(at, 'metric', 5));
    expect(dwd.pathname).toBe('/v1/dwd-icon');
    expect(best.pathname).toBe('/v1/forecast');
    expect(dwd.search).toBe(best.search);
  });

  it('reads a live Berlin answer: five days, the hours, now, and no UV index because ICON has none', () => {
    // Captured at 01:33 UTC on 7 October 2026; the answer's own "now" is 03:30 in Berlin.
    const parts = parseOpenMeteo(read('real/dwd-berlin-metric.json'), {
      ...options(Date.parse('2026-10-07T01:33:00Z'), 'Europe/Berlin', 'metric', '2026-10-07'),
    });
    expect(parts.forecast?.days.map((day) => day.date)).toEqual([
      '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
    expect(parts.forecast?.days[0]).toMatchObject({ name: 'Today', unit: 'C', precipChance: 5 });
    for (const day of parts.forecast?.days ?? []) expect(day).not.toHaveProperty('uvMax');
    expect(parts.current).toMatchObject({ temp: 12, humidity: 96, condition: 'Fog', glyph: 'fog', isDay: false });
    expect(parts.current).not.toHaveProperty('uv');
    expect(parts.hours).toHaveLength(24);
  });

  it('reads a live Washington answer in Fahrenheit', () => {
    const parts = parseOpenMeteo(read('real/dwd-dc-imperial.json'), {
      ...options(Date.parse('2026-10-07T01:33:00Z'), 'America/New_York', 'imperial', '2026-10-06'),
    });
    expect(parts.forecast?.days[0]?.unit).toBe('F');
    expect(parts.forecast?.days).toHaveLength(5);
    expect(parts.current?.temp).toBeGreaterThan(30);
  });
});

describe('Pirate Weather', () => {
  // The documentation's example: Toronto's region, 19:55 UTC on 9 November 2025, units=ca.
  const NOW = 1762718100_000;
  const parsed = (): ReturnType<typeof parsePirateWeather> =>
    parsePirateWeather(read('pirate-weather-ca.json'), options(NOW, 'America/Toronto', 'metric', '2025-11-09'));

  it('puts no key in the address it builds', () => {
    const url = pirateUrl({ latitude: 45.42, longitude: -74.3 }, 'metric');
    expect(url).toBe(
      'https://api.pirateweather.net/forecast/key-in-header/45.4200,-74.3000?units=ca&exclude=minutely%2Calerts%2Cday_night',
    );
    expect(new URL(pirateUrl({ latitude: 1, longitude: 1 }, 'imperial')).searchParams.get('units')).toBe('us');
  });

  it('reads now: a fraction of humidity as a percentage, the bearing as a compass point', () => {
    expect(parsed().current).toEqual({
      observedAt: NOW,
      temp: -0.88,
      feelsLike: -6.77,
      condition: 'Light Snow',
      glyph: 'snow',
      isDay: true,
      humidity: 82,
      windSpeed: 17.73,
      windGust: 46.84,
      windDir: 'NE',
      uv: 0.38,
    });
  });

  it('reads the days in the household’s own dates, centimetres as millimetres, liquid where it is said', () => {
    const days = parsed().forecast?.days ?? [];
    expect(days.map((day) => [day.date, day.name, day.high, day.low, day.glyph])).toEqual([
      ['2025-11-09', 'Today', 0.04, -2.81, 'sleet'],
      ['2025-11-10', 'Mon', 3.2, -1.6, 'cloudy'],
      ['2025-11-11', 'Tue', 2.9, 0.4, 'rain'],
    ]);
    // 7.5957 cm of everything on a day that names no liquid: 76 mm. 0.05 cm of
    // liquid on the next: 0.5 mm, where `precipAccumulation` (3.05) adds 3 cm of snow.
    expect(days[0]).toMatchObject({ precipChance: 100, precipAmount: 76, uvMax: 1.8 });
    expect(days[1]).toMatchObject({ precipChance: 12, precipAmount: 0.5 });
    // 1762688903 is 06:48:23 EST.
    expect(days[0]).toMatchObject({ sunrise: '2025-11-09T06:48', sunset: '2025-11-09T16:33' });
  });

  it('reads the hours still to come, and night from the icon', () => {
    const hours = parsed().hours ?? [];
    expect(hours.map((hour) => hour.temp)).toEqual([-0.49, -0.6, -0.8, -1.0, -1.1, -1.29]);
    expect(hours[0]).toMatchObject({ precipChance: 47, glyph: 'snow' });
    expect(hours[4]).toMatchObject({ glyph: 'partly-cloudy', isDay: false });
    // An hour that has ended is not ahead.
    const later = parsePirateWeather(
      read('pirate-weather-ca.json'),
      options(NOW + 3 * 3600_000, 'America/Toronto', 'metric', '2025-11-09'),
    );
    expect(later.hours?.map((hour) => hour.temp)).toEqual([-1.0, -1.1, -1.29]);
  });
});

describe('OpenWeatherMap', () => {
  // The documented example's reading, 14:43 UTC on 30 August 2022, Zocca (Europe/Rome).
  const NOW = 1661870592_000;

  it('puts the key in the query alone, which is the only place it documents', () => {
    const url = new URL(owmUrl('forecast', { latitude: 44.34, longitude: 10.99 }, 'metric', 'k-123456789'));
    expect(url.host).toBe('api.openweathermap.org');
    expect(url.pathname).toBe('/data/2.5/forecast');
    expect(url.searchParams.get('appid')).toBe('k-123456789');
    expect(url.searchParams.get('units')).toBe('metric');
  });

  it('reads now, with metres per second turned into km/h', () => {
    const now = parseOwmCurrent(read('openweathermap-weather-metric.json'), options(NOW, 'Europe/Rome', 'metric', '2022-08-30'));
    expect(now).toEqual({
      observedAt: NOW,
      temp: 25.33,
      feelsLike: 25.59,
      condition: 'Moderate rain',
      glyph: 'rain',
      isDay: true,
      humidity: 64,
      windSpeed: 2.2,
      windGust: 4.2,
      windDir: 'N',
    });
    // In imperial the API already answers mph, so nothing is converted.
    const imperial = parseOwmCurrent(read('openweathermap-weather-metric.json'), options(NOW, 'Europe/Rome', 'imperial', '2022-08-30'));
    expect(imperial?.windSpeed).toBe(0.62);
  });

  it('groups three-hour steps into the household’s days, and keeps a day of hours', () => {
    const parts = parseOwmForecast(read('openweathermap-forecast-metric.json'), options(NOW, 'Europe/Rome', 'metric', '2022-08-30'));
    const days = parts.forecast?.days ?? [];
    expect(days).toHaveLength(5);
    // Today is what remains of it: 17:00, 20:00 and 23:00 in Rome.
    expect(days[0]).toMatchObject({
      date: '2022-08-30', name: 'Today', high: 26.6, low: 19.5, precipChance: 95, precipAmount: 1.9,
      // The step nearest the middle of the day is 17:00's moderate rain.
      summary: 'Moderate rain', glyph: 'rain',
    });
    // Tomorrow, 02:00 to 23:00 in Rome: eight steps.
    expect(days[1]).toMatchObject({ date: '2022-08-31', name: 'Wed', high: 27.3, low: 17.3 });
    // 15:00 to 12:00 the next day: eight steps a day ahead, three hours apart.
    expect(parts.hours).toHaveLength(8);
    expect((parts.hours?.[1]?.at ?? 0) - (parts.hours?.[0]?.at ?? 0)).toBe(3 * 3600_000);
    // The household's own days, not UTC's: in New York the steps at 00:00 and
    // 03:00 UTC are the evening of the 30th, so today's low is theirs.
    const york = parseOwmForecast(read('openweathermap-forecast-metric.json'), options(NOW, 'America/New_York', 'metric', '2022-08-30'));
    expect(york.forecast?.days[0]).toMatchObject({ date: '2022-08-30', high: 26.6, low: 17.3 });
    // Rain is always millimetres in this API; an imperial household reads inches.
    const imperial = parseOwmForecast(read('openweathermap-forecast-metric.json'), options(NOW, 'Europe/Rome', 'imperial', '2022-08-30'));
    expect(imperial.forecast?.days[0]?.precipAmount).toBe(0.07);
  });

  it('draws condition ids by their documented groups', () => {
    expect([200, 301, 511, 521, 500, 611, 601, 741, 771, 800, 801, 802, 804].map(glyphForId)).toEqual([
      'thunderstorm', 'drizzle', 'sleet', 'showers', 'rain', 'sleet', 'snow', 'fog', 'wind',
      'clear', 'mostly-clear', 'partly-cloudy', 'cloudy',
    ]);
    expect(glyphForId(999)).toBeNull();
  });
});

describe('Weather Underground', () => {
  // 19:50 on Monday 5 October 2026 in Seattle, after today's day part has gone.
  const NOW = Date.parse('2026-10-06T02:50:00Z');
  const opts = (): ReadOptions => options(NOW, 'America/Los_Angeles', 'metric', '2026-10-05');

  it('builds both addresses with the key in the query, units as the API spells them', () => {
    const forecast = new URL(wuForecastUrl({ latitude: 47.668, longitude: -122.384 }, 'imperial', 'k-123456789'));
    expect(forecast.pathname).toBe('/v3/wx/forecast/daily/5day');
    expect(forecast.searchParams.get('geocode')).toBe('47.6680,-122.3840');
    expect(forecast.searchParams.get('units')).toBe('e');
    const station = new URL(wuStationUrl('KWASEATT2743', 'metric', 'k-123456789'));
    expect(station.pathname).toBe('/v2/pws/observations/current');
    expect(station.searchParams.get('stationId')).toBe('KWASEATT2743');
    expect(station.searchParams.get('units')).toBe('m');
  });

  it('reads today from its night once the day part is gone, and the calendar day’s high', () => {
    const days = parseWuForecast(read('wunderground-5day-metric.json'), opts())?.days ?? [];
    expect(days).toHaveLength(5);
    expect(days[0]).toMatchObject({
      date: '2026-10-05', name: 'Today', high: 17, low: 9, summary: 'Showers', glyph: 'showers',
      precipChance: 60, precipAmount: 2.3, windMax: 14,
    });
    expect(days[0]).not.toHaveProperty('uvMax');
    // A whole day: the higher of its two chances, its day part's picture.
    expect(days[1]).toMatchObject({
      date: '2026-10-06', name: 'Tue', high: 16, low: 10, summary: 'Showers', precipChance: 85, windMax: 22, uvMax: 2,
    });
    expect(days[2]).toMatchObject({ glyph: 'rain', summary: 'Rain' });
    expect(days[3]).toMatchObject({ glyph: 'partly-cloudy' });
    // 07:12 local on the first day, from its UTC instant.
    expect(days[0]).toMatchObject({ sunrise: '2026-10-05T07:12', sunset: '2026-10-05T18:40' });
  });

  it('reads a station’s measurement, with the sky borrowed from the forecast', () => {
    const now = parseWuStation(read('wunderground-pws-metric.json'), opts(), { condition: 'Showers', glyph: 'showers' });
    expect(now).toEqual({
      observedAt: NOW,
      temp: 11.6,
      condition: 'Showers',
      glyph: 'showers',
      isDay: true,
      humidity: 88,
      windSpeed: 6.1,
      windGust: 11.2,
      windDir: 'SSW',
      uv: 0,
      solar: 12,
    });
    // Asked in imperial, a metric answer has nothing to read.
    expect(parseWuStation(read('wunderground-pws-metric.json'), { ...opts(), units: 'imperial' }, undefined)).toBeUndefined();
  });

  it('draws The Weather Company’s icon codes', () => {
    expect([4, 9, 11, 12, 16, 17, 20, 24, 26, 30, 32, 34, 44].map(glyphForCode)).toEqual([
      'thunderstorm', 'drizzle', 'showers', 'rain', 'snow', 'sleet', 'fog', 'wind', 'cloudy',
      'partly-cloudy', 'clear', 'mostly-clear', null,
    ]);
  });
});

describe('a Home Assistant weather entity', () => {
  const NOW = Date.parse('2026-10-06T09:00:00Z');
  const opts = (units: 'metric' | 'imperial'): ReadOptions => options(NOW, 'Europe/London', units, '2026-10-06');
  // An entity set up in Fahrenheit and mph, as a US integration would be.
  const state = JSON.stringify({
    entity_id: 'weather.home',
    state: 'rainy',
    attributes: {
      temperature: 59, apparent_temperature: 57.2, humidity: 93, wind_speed: 10, wind_gust_speed: 20,
      wind_bearing: 225, uv_index: 1, temperature_unit: '°F', wind_speed_unit: 'mph',
      precipitation_unit: 'in', supported_features: 3, friendly_name: 'Home',
    },
    last_changed: '2026-10-06T08:50:00+00:00',
    last_updated: '2026-10-06T08:55:00+00:00',
  });

  it('reads now in the household’s units, whatever the entity’s are', () => {
    const read = parseHaWeatherState(state, opts('metric'));
    expect(read?.features).toBe(3);
    expect(read?.reading).toEqual({
      observedAt: Date.parse('2026-10-06T08:55:00Z'),
      temp: 15,
      feelsLike: 14,
      condition: 'Rain',
      glyph: 'rain',
      isDay: true,
      humidity: 93,
      windSpeed: 16.1,
      windGust: 32.2,
      windDir: 'SW',
      uv: 1,
    });
  });

  it('has no "now" while the integration says it is unavailable', () => {
    const gone = parseHaWeatherState(state.replace('"rainy"', '"unavailable"'), opts('metric'));
    expect(gone?.reading).toBeUndefined();
  });

  it('reads a daily forecast into the household’s dates, and a twice-daily one into days', () => {
    const units = { temp: '°C', wind: 'km/h', precip: 'mm' };
    const daily = forecastEntries(
      JSON.stringify({
        changed_states: [],
        service_response: {
          'weather.home': {
            forecast: [
              { datetime: '2026-10-06T11:00:00+00:00', condition: 'rainy', temperature: 15.8, templow: 10.1,
                precipitation: 5, precipitation_probability: 83, wind_speed: 16.9, uv_index: 1.2 },
              { datetime: '2026-10-07T11:00:00+00:00', condition: 'partlycloudy', temperature: 14.9, templow: 8.3,
                precipitation: 0.3, precipitation_probability: 40, wind_speed: 14.5 },
              // Not a forecast entry: no datetime. Costs itself and nothing else.
              { condition: 'sunny', temperature: 30 },
            ],
          },
        },
      }),
      'weather.home',
    );
    expect(daily).toHaveLength(2);
    const days = haDays(daily ?? [], units, opts('imperial'));
    expect(days.map((day) => [day.date, day.name, day.high, day.low, day.glyph, day.unit])).toEqual([
      ['2026-10-06', 'Today', 60.4, 50.2, 'rain', 'F'],
      ['2026-10-07', 'Wed', 58.8, 46.9, 'partly-cloudy', 'F'],
    ]);
    // Millimetres to inches, km/h to mph: the panel is one scale.
    expect(days[0]).toMatchObject({ precipChance: 83, precipAmount: 0.2, windMax: 10.5, uvMax: 1.2 });

    const twice = haDays(
      [
        { datetime: '2026-10-06T06:00:00+00:00', condition: 'sunny', temperature: 18, is_daytime: true },
        { datetime: '2026-10-06T18:00:00+00:00', condition: 'clear-night', temperature: 9, is_daytime: false },
        { datetime: '2026-10-07T06:00:00+00:00', condition: 'cloudy', temperature: 16, is_daytime: true },
      ],
      units,
      opts('metric'),
    );
    // A day and its night make one day: the day's high, the night's low, the day's sky.
    expect(twice.map((day) => [day.date, day.high, day.low, day.summary])).toEqual([
      ['2026-10-06', 18, 9, 'Sunny'],
      ['2026-10-07', 16, null, 'Cloudy'],
    ]);
  });

  it('reads the hours still to come, night from "clear-night"', () => {
    const hours = haHours(
      [
        { datetime: '2026-10-06T07:00:00+00:00', condition: 'rainy', temperature: 14 },
        { datetime: '2026-10-06T09:00:00+00:00', condition: 'rainy', temperature: 15, precipitation_probability: 70 },
        { datetime: '2026-10-06T22:00:00+00:00', condition: 'clear-night', temperature: 9 },
      ],
      { temp: '°C', wind: 'km/h', precip: 'mm' },
      opts('metric'),
    );
    expect(hours.map((hour) => [hour.temp, hour.isDay])).toEqual([[15, true], [9, false]]);
    expect(hours[0]).toMatchObject({ precipChance: 70, condition: 'Rain' });
  });
});

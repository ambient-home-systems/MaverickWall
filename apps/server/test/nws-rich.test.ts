import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseForecast, parseHourly, windMaxOf } from '../src/modules/weather/nws.js';
import { observationUrl, parseObservation, parseStations, stationsUrl } from '../src/modules/weather/nws-observations.js';
import { presentCurrent, presentHourly, CURRENT_MAX_AGE_MS } from '../src/modules/weather/readings.js';
import { sunIsUp } from '../src/modules/weather/sun.js';

/**
 * The National Weather Service's richer half, against the owner's captures.
 *
 * NWS's CDN refuses cloud addresses, so these five documents were captured
 * from a home network and committed under `fixtures/nws/real/` (the plan's
 * owner task, P3.6): the points document for the plan's Washington location,
 * its station list, KDCA's latest observation, and the forecast and hourly
 * forecast, all on the morning of 2026-09-24. Nothing here is invented.
 *
 * **One capture the owner task asked for is not among them**: an observation
 * with `"temperature": {"value": null}`. The null-temperature case is therefore
 * the real KDCA observation with that one value set to null, in the shape the
 * same document already uses for four other quantities (wind speed, direction
 * and gust, and sea-level pressure) — a real document with one field changed,
 * rather than a document written from memory. The README beside the fixtures
 * records it as missing.
 */

const REAL = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nws', 'real');
const read = (file: string): string => readFileSync(join(REAL, file), 'utf8');
const OBSERVATION = read('observation-latest.json');
const HOURLY = read('forecast-hourly.json');
const FORECAST = read('forecast.json');

const DC = { latitude: 38.8894, longitude: -77.0352 };
const isDayAt = (instantMs: number): boolean | undefined =>
  sunIsUp(instantMs, DC.latitude, DC.longitude, -240);

/** The real observation with its temperature taken away, as a station sends it. */
function withNullTemperature(): string {
  const document = JSON.parse(OBSERVATION) as {
    properties: { temperature: { value: number | null; qualityControl: string } };
  };
  document.properties.temperature.value = null;
  document.properties.temperature.qualityControl = 'Z';
  return JSON.stringify(document);
}

describe('the station list', () => {
  it('reads the stations nearest first, and asks for five', () => {
    expect(parseStations(read('stations.json'))).toEqual(['KDCA', 'KCGS', 'KADW', 'KDAA', 'KGAI']);
    const points = JSON.parse(read('points.json')) as { properties: { observationStations: string } };
    expect(stationsUrl(points.properties.observationStations)).toBe(
      'https://api.weather.gov/gridpoints/LWX/97,71/stations?limit=5',
    );
  });

  it('builds the observation URL on the service host from a name, never from a path', () => {
    expect(observationUrl('KDCA')).toBe('https://api.weather.gov/stations/KDCA/observations/latest');
    // A station "identifier" that is a path is not one.
    const hostile = JSON.stringify({
      features: [{ properties: { stationIdentifier: '../../points' } }, { properties: { stationIdentifier: 'KDCA' } }],
    });
    expect(parseStations(hostile)).toEqual(['KDCA']);
  });
});

describe('the latest observation', () => {
  it('reads KDCA at 12:00 UTC, converted out of SI into the panel’s units', () => {
    expect(parseObservation(OBSERVATION, isDayAt)).toEqual({
      observedAt: Date.parse('2026-09-24T12:00:00Z'),
      // 12 °C.
      temp: 53.6,
      // No wind chill and no heat index in this document, so the air
      // temperature, which is the plan's order.
      feelsLike: 53.6,
      condition: 'Mostly Clear',
      glyph: 'mostly-clear',
      // 08:00 in New York, an hour after a 06:58 sunrise.
      isDay: true,
      humidity: 71,
      // Wind speed, gust and direction are all null in the real document, so
      // none of them is here — absent, not zero.
    });
  });

  it('keeps a station’s null temperature as null, rather than a zero or a missing reading', () => {
    const reading = parseObservation(withNullTemperature(), isDayAt);
    expect(reading?.temp).toBeNull();
    // And nothing it cannot know: feels-like fell through to a null temperature.
    expect(reading).not.toHaveProperty('feelsLike');
    expect(reading?.condition).toBe('Mostly Clear');
  });

  it('treats a value NWS flagged as rejected as the null it should have been', () => {
    const document = JSON.parse(OBSERVATION) as { properties: { temperature: { qualityControl: string } } };
    document.properties.temperature.qualityControl = 'X';
    expect(parseObservation(JSON.stringify(document), isDayAt)?.temp).toBeNull();
  });

  it('refuses a unit it does not know rather than drawing it as Fahrenheit', () => {
    const document = JSON.parse(OBSERVATION) as { properties: { temperature: { unitCode: string } } };
    document.properties.temperature.unitCode = 'wmoUnit:K';
    expect(parseObservation(JSON.stringify(document), isDayAt)?.temp).toBeNull();
  });

  it('answers nothing for a document that is not one, or cannot say when it was taken', () => {
    for (const body of ['', '{}', 'null', '{"properties":{}}', '{"properties":{"timestamp":"yesterday"}}']) {
      expect(parseObservation(body, isDayAt)).toBeUndefined();
    }
  });
});

describe('the hourly forecast', () => {
  const FETCHED = Date.parse('2026-09-24T12:05:00Z');

  it('keeps the hours still to come, with the sun deciding day and night', () => {
    const hours = parseHourly(HOURLY, FETCHED, isDayAt);
    // The 07:00 period ended at 12:00 UTC, before the fetch.
    expect(hours?.[0]).toMatchObject({
      at: Date.parse('2026-09-24T12:00:00Z'),
      end: Date.parse('2026-09-24T13:00:00Z'),
      temp: 54,
      glyph: 'partly-cloudy',
      isDay: true,
      precipChance: 0,
      condition: 'Partly Sunny',
      humidity: 80,
      windSpeed: 12,
      windDir: 'N',
    });
    expect(hours).toHaveLength(26);
  });

  it('calls 18:00 day where NWS’s own flag calls it night, because the sun sets at 19:02', () => {
    const document = JSON.parse(HOURLY) as {
      properties: { periods: { startTime: string; isDaytime: boolean }[] };
    };
    const six = document.properties.periods.find((p) => p.startTime === '2026-09-24T18:00:00-04:00');
    // The provider's clock-based flag, as captured.
    expect(six?.isDaytime).toBe(false);
    const hours = parseHourly(HOURLY, FETCHED, isDayAt) ?? [];
    expect(hours.find((hour) => hour.at === Date.parse('2026-09-24T22:00:00Z'))?.isDay).toBe(true);
    // An hour is day or night by its start, which is Open-Meteo's reading of
    // its own `is_day` too: the captured Washington answer marks 19:00 day and
    // 20:00 night, either side of a 19:01 sunset.
    expect(hours.find((hour) => hour.at === Date.parse('2026-09-24T23:00:00Z'))?.isDay).toBe(true);
    expect(hours.find((hour) => hour.at === Date.parse('2026-09-25T00:00:00Z'))?.isDay).toBe(false);
  });

  it('slims to what the manifest carries, and drops an hour that has ended', () => {
    const hours = parseHourly(HOURLY, FETCHED, isDayAt) ?? [];
    const shown = presentHourly(hours, Date.parse('2026-09-24T13:10:00Z'));
    expect(shown).toHaveLength(24);
    expect(shown[0]).toEqual({
      at: Date.parse('2026-09-24T13:00:00Z'),
      temp: 56,
      glyph: 'partly-cloudy',
      isDay: true,
      precipChance: 0,
    });
    expect(shown[0]).not.toHaveProperty('condition');
  });
});

describe('the days', () => {
  it('adds the rain chance, the wind and the forecaster’s words to each day', () => {
    const forecast = parseForecast(FORECAST, 0, 5);
    const today = forecast?.days[0];
    expect(today).toMatchObject({ name: 'Today', high: 66, low: 51, summary: 'Mostly Cloudy' });
    // The higher of Today (0%) and Tonight (0%); the higher of 13 and "6 to 9".
    expect(today?.precipChance).toBe(0);
    expect(today?.windMax).toBe(13);
    expect(today?.detail).toBe(
      'Mostly cloudy, with a high near 66. Northeast wind around 13 mph, with gusts as high as 22 mph.',
    );
    // Saturday is 10% by day and 16% overnight: the row is the whole day.
    const saturday = forecast?.days.find((day) => day.name === 'Saturday');
    expect(saturday?.precipChance).toBe(16);
    expect(saturday?.windMax).toBe(14);
    // NWS has neither in a forecast.
    expect(today).not.toHaveProperty('uvMax');
    expect(today).not.toHaveProperty('precipAmount');
  });

  it('adds the sun only when it is given a way to work it out, and is otherwise the day it always was', () => {
    const plain = parseForecast(FORECAST, 0, 5);
    expect(plain?.days[0]).not.toHaveProperty('sunrise');
    const withSun = parseForecast(FORECAST, 0, 5, (date) => ({ sunrise: `${date}T06:58`, sunset: `${date}T19:02` }));
    expect(withSun?.days[0]?.sunrise).toBe('2026-09-24T06:58');
  });

  it('reads the top of a wind range, in any form NWS writes one', () => {
    expect(windMaxOf('6 to 9 mph')).toBe(9);
    expect(windMaxOf('13 mph')).toBe(13);
    expect(windMaxOf('0 to 6 mph')).toBe(6);
    expect(windMaxOf('10 to 20 km/h')).toBe(12.4);
    expect(windMaxOf('Calm')).toBeUndefined();
    expect(windMaxOf('')).toBeUndefined();
  });
});

/*
 * The fallback and the ninety minutes (plan item P3.4), end to end on real
 * documents: the station's reading, the hourly forecast fetched with it, and a
 * clock that is an argument.
 */
describe('what the wall is told it is like now', () => {
  const hours = parseHourly(HOURLY, Date.parse('2026-09-24T12:05:00Z'), isDayAt) ?? [];
  const observed = parseObservation(OBSERVATION, isDayAt);

  it('is the station’s measurement while it is fresh', () => {
    const now = Date.parse('2026-09-24T12:40:00Z');
    expect(presentCurrent({ provider: 'nws', reading: observed, hours, now })).toMatchObject({
      source: 'observed',
      temp: 53.6,
      condition: 'Mostly Clear',
    });
  });

  it('falls back to the hour covering now when the station has no temperature', () => {
    const reading = parseObservation(withNullTemperature(), isDayAt);
    const now = Date.parse('2026-09-24T12:40:00Z');
    expect(presentCurrent({ provider: 'nws', reading, hours, now })).toEqual({
      observedAt: Date.parse('2026-09-24T12:00:00Z'),
      source: 'modelled',
      temp: 54,
      condition: 'Partly Sunny',
      glyph: 'partly-cloudy',
      isDay: true,
      humidity: 80,
      windSpeed: 12,
      windDir: 'N',
    });
  });

  it('is the measurement at exactly ninety minutes old, and the hourly model a minute later', () => {
    const at90 = (observed?.observedAt ?? 0) + CURRENT_MAX_AGE_MS;
    expect(presentCurrent({ provider: 'nws', reading: observed, hours, now: at90 })?.source).toBe('observed');
    const at91 = at90 + 60_000;
    const late = presentCurrent({ provider: 'nws', reading: observed, hours, now: at91 });
    expect(late?.source).toBe('modelled');
    // 13:31 UTC is inside the 09:00 hour in New York.
    expect(late?.observedAt).toBe(Date.parse('2026-09-24T13:00:00Z'));
    expect(late?.temp).toBe(56);
  });

  it('is nothing at all when neither the station nor the forecast covers now', () => {
    // Two days on, with nothing refreshed: the cached hours ran out long ago.
    const now = Date.parse('2026-09-26T12:00:00Z') + 30 * 3600_000;
    expect(presentCurrent({ provider: 'nws', reading: observed, hours, now })).toBeUndefined();
  });

  it('is nothing for a stale Open-Meteo reading, which has no better model behind it', () => {
    const reading = { ...observed!, temp: 54 };
    const now = reading.observedAt + CURRENT_MAX_AGE_MS + 60_000;
    expect(presentCurrent({ provider: 'openmeteo', reading, hours, now })).toBeUndefined();
    expect(presentCurrent({ provider: 'openmeteo', reading, hours, now: reading.observedAt })?.source).toBe(
      'modelled',
    );
  });
});

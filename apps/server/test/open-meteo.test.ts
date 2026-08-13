import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastUrl, iconForCode, parseForecast } from '../src/modules/weather/open-meteo.js';

/**
 * Open-Meteo, against bytes it actually sent.
 *
 * The fixture is a real response for London captured once — a hand-written one
 * would agree with whatever this parser happens to do, which is the opposite of
 * a test. The interesting parts are the ones a made-up document would get
 * wrong: the daily arrays are parallel, not a list of objects, and the first
 * day is labelled "Today" only when it matches the household's own date.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FORECAST = readFileSync(join(FIXTURES, 'open-meteo-forecast.json'), 'utf8');
const AT = 1_700_000_000_000;
// The fixture's first day.
const TODAY = '2026-08-13';

describe('the request', () => {
  it('rounds coordinates and carries units and day count', () => {
    const url = new URL(forecastUrl({ latitude: 51.50741234, longitude: -0.12781111 }, 'metric', 7));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('51.5074');
    expect(url.searchParams.get('longitude')).toBe('-0.1278');
    expect(url.searchParams.get('temperature_unit')).toBe('celsius');
    expect(url.searchParams.get('forecast_days')).toBe('7');
    expect(url.searchParams.get('timezone')).toBe('auto');
  });

  it('asks for fahrenheit when imperial, and clamps an absurd day count', () => {
    expect(new URL(forecastUrl({ latitude: 0, longitude: 0 }, 'imperial', 1)).searchParams.get('temperature_unit'))
      .toBe('fahrenheit');
    expect(new URL(forecastUrl({ latitude: 0, longitude: 0 }, 'metric', 999)).searchParams.get('forecast_days'))
      .toBe('16');
  });
});

describe('reading a real forecast', () => {
  it('folds the parallel daily arrays into days with a high, a low and an icon', () => {
    const forecast = parseForecast(FORECAST, AT, 'metric', TODAY, 5);
    expect(forecast).toBeDefined();
    expect(forecast?.days).toHaveLength(5);

    const first = forecast?.days[0];
    // The first day is the household's today.
    expect(first?.name).toBe('Today');
    // Fixture: code 3 (overcast), 35.4 / 20.5 °C.
    expect(first?.icon).toBe('☁');
    expect(first?.high).toBe(35.4);
    expect(first?.low).toBe(20.5);
    expect(first?.unit).toBe('°C');
  });

  it('labels days after today by weekday, not by date', () => {
    // 2026-08-14 is a Friday.
    const second = parseForecast(FORECAST, AT, 'metric', TODAY, 5)?.days[1];
    expect(second?.name).toBe('Fri');
  });

  it('reports °F when asked for imperial, without touching the numbers', () => {
    // The unit label follows the request; converting is Open-Meteo's job, not
    // the parser's, so the numbers are whatever the (metric) fixture holds.
    const day = parseForecast(FORECAST, AT, 'imperial', TODAY, 1)?.days[0];
    expect(day?.unit).toBe('°F');
  });

  it('honours the limit it is given', () => {
    expect(parseForecast(FORECAST, AT, 'metric', TODAY, 3)?.days).toHaveLength(3);
  });

  it('returns nothing rather than throwing on a document that is not one', () => {
    for (const body of ['', 'null', '{}', '{"daily":{}}', 'not json at all', '[]']) {
      expect(parseForecast(body, AT, 'metric', TODAY, 5)).toBeUndefined();
    }
  });
});

describe('the icon, from a WMO code', () => {
  it('maps the codes the fixture uses', () => {
    expect(iconForCode(3)).toBe('☁'); // overcast
    expect(iconForCode(51)).toBe('🌧'); // drizzle
  });

  it('separates the weather families', () => {
    expect(iconForCode(0)).toBe('☀'); // clear
    expect(iconForCode(2)).toBe('⛅'); // partly cloudy
    expect(iconForCode(71)).toBe('❄'); // snow
    expect(iconForCode(80)).toBe('🌦'); // rain showers
    expect(iconForCode(95)).toBe('⛈'); // thunderstorm
    expect(iconForCode(45)).toBe('🌫'); // fog
  });

  it('falls back rather than throwing on a code nobody predicted', () => {
    expect(iconForCode(999)).toBe('·');
    expect(iconForCode(-1)).toBe('·');
  });
});

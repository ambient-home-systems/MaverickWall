import { describe, expect, it } from 'vitest';
import { clockWeatherLine, clockWeatherOf } from '../src/clock-weather.js';
import type { CurrentWeatherModel, WeatherDayModel } from '../src/viewmodel.js';

/**
 * The clock's weather line (plan item M5.10), as data: what a clock's config
 * asks for, and what the line says for a forecast.
 */

const units = { temp: 'C', wind: 'km/h', precip: 'mm' } as const;

const now: CurrentWeatherModel = {
  observedAt: 0,
  source: 'modelled',
  temp: '14°',
  tempValue: 14,
  feelsLike: '12°',
  condition: 'Light rain',
  glyph: 'rain',
  isDay: false,
  humidity: 81.6,
  windSpeed: 12.4,
  windGust: undefined,
  windDir: 'NW',
  uv: 0.4,
};

const today = {
  name: 'Today',
  date: '2026-10-07',
  glyph: 'partly-cloudy',
  // As the forecast formats them: the low carries the unit after it.
  high: '18°',
  low: '9°C',
  highValue: 18,
  lowValue: 9,
  tempUnit: 'C',
  windMax: 21.7,
  uvMax: 3.2,
} as unknown as WeatherDayModel;

describe('what a clock asks for', () => {
  it('draws nothing unless the line was switched on, and takes the readings in the line’s own order', () => {
    expect(clockWeatherOf(undefined).show).toBe(false);
    expect(clockWeatherOf({ showWeather: 'yes' }).show).toBe(false);
    const asked = clockWeatherOf({ showWeather: true, weatherReadings: ['uv', 'pressure', 'humidity'], icons: 'line' });
    expect(asked).toEqual({ show: true, readings: ['humidity', 'uv'], pictures: 'line' });
  });
});

describe('what the line says', () => {
  it('is now, with the readings asked for and the wind’s direction and unit', () => {
    expect(
      clockWeatherLine({ current: now, days: [today], todayDate: '2026-10-07', units }, ['humidity', 'wind', 'uv']),
    ).toEqual({ mode: 'now', glyph: 'rain', isDay: false, temp: '14°', parts: ['82%', 'NW 12 km/h', 'UV 0'] });
  });

  it('is today’s high and low with no reading for now, and the day’s own wind and UV — never a humidity', () => {
    expect(
      clockWeatherLine({ current: undefined, days: [today], todayDate: '2026-10-07', units }, ['humidity', 'wind', 'uv']),
    ).toEqual({ mode: 'today', glyph: 'partly-cloudy', isDay: true, temp: '18° / 9°', parts: ['22 km/h', 'UV 3'] });
  });

  it('leaves out a wind whose unit nobody named', () => {
    const line = clockWeatherLine({ current: now, days: [], todayDate: undefined, units: undefined }, ['wind']);
    expect(line?.parts).toEqual([]);
  });

  it('says nothing when there is neither a reading nor a today', () => {
    expect(clockWeatherLine({ current: undefined, days: [], todayDate: undefined, units }, [])).toBeUndefined();
    // A forecast whose first day is another day is not today (a forecast saved yesterday).
    const yesterday = { ...today, date: '2026-10-06' } as WeatherDayModel;
    expect(clockWeatherLine({ current: undefined, days: [yesterday], todayDate: '2026-10-07', units }, [])).toBeUndefined();
  });
});

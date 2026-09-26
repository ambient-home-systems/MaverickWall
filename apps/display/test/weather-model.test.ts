import { describe, expect, it } from 'vitest';
import { buildModel, weatherFrom } from '../src/viewmodel.js';
import type { Manifest } from '../src/manifest.js';

/**
 * The wall's reading of the richer weather panel (plan item P3.7).
 *
 * The panel below is the shape `weather-job.test.ts` asserts the server
 * assembles from the captured Washington documents — its values are those
 * documents' values — so this is the display reading what the server really
 * sends. Everything after it is a document the server would never send, which
 * is the point: a wall a version ahead or behind must cost a field, never the
 * strip.
 */

const OBSERVED = Date.parse('2026-09-24T12:00:00Z');
const NOW = Date.parse('2026-09-24T12:40:00Z');

const panel = {
  provider: 'nws',
  days: [
    {
      name: 'Today', date: '2026-09-24', high: 66, low: 51, unit: 'F', summary: 'Mostly Cloudy', glyph: 'cloudy',
      precipChance: 0, windMax: 13, sunrise: '2026-09-24T06:58', sunset: '2026-09-24T19:02',
      detail: 'Mostly cloudy, with a high near 66. Northeast wind around 13 mph, with gusts as high as 22 mph.',
    },
    { name: 'Friday', date: '2026-09-25', high: 72, low: 57, unit: 'F', summary: 'Sunny', glyph: 'clear', precipChance: 3 },
  ],
  fetchedAt: OBSERVED,
  note: null,
  current: {
    observedAt: OBSERVED, source: 'observed', temp: 53.6, feelsLike: 53.6, condition: 'Mostly Clear',
    glyph: 'mostly-clear', isDay: true, humidity: 71,
  },
  hourly: [
    { at: Date.parse('2026-09-24T12:00:00Z'), temp: 54, glyph: 'partly-cloudy', isDay: true, precipChance: 0 },
    { at: Date.parse('2026-09-24T13:00:00Z'), temp: 56, glyph: 'partly-cloudy', isDay: true, precipChance: 0 },
  ],
  units: { temp: 'F', wind: 'mph', precip: 'in' },
  air: { aqi: 43, scale: 'us', label: 'Good', observedAt: OBSERVED },
};

describe('reading what the server sends', () => {
  it('carries the day’s own words, which the wall used to drop', () => {
    const { days } = weatherFrom(panel, NOW);
    expect(days[0]?.summary).toBe('Mostly Cloudy');
    expect(days[1]?.summary).toBe('Sunny');
  });

  it('reads every per-day field, and leaves one the day lacks undefined', () => {
    const [today, friday] = weatherFrom(panel, NOW).days;
    expect(today).toMatchObject({
      high: '66°', low: '51°F', precipChance: 0, windMax: 13,
      sunrise: '2026-09-24T06:58', sunset: '2026-09-24T19:02',
    });
    expect(today?.detail).toContain('Northeast wind around 13 mph');
    expect(today?.uvMax).toBeUndefined();
    expect(friday?.precipChance).toBe(3);
    expect(friday?.sunrise).toBeUndefined();
  });

  it('carries each day’s temperatures as numbers too, for a style that places them on a scale', () => {
    // P5.1: the range bar and the colour tint read the numbers; the strip still
    // reads the strings, which are untouched.
    const [today] = weatherFrom(panel, NOW).days;
    expect(today).toMatchObject({ high: '66°', low: '51°F', highValue: 66, lowValue: 51, tempUnit: 'F' });
    const odd = weatherFrom({ days: [{ name: 'X', high: 'warm', low: -3.5, unit: 'K' }] }, NOW).days[0];
    expect(odd).toMatchObject({ highValue: undefined, lowValue: -3.5, tempUnit: undefined });
  });

  it('reads the current conditions, formatted the way a day’s temperature is', () => {
    expect(weatherFrom(panel, NOW).current).toEqual({
      observedAt: OBSERVED, source: 'observed', temp: '54°', tempValue: 53.6, feelsLike: '54°', condition: 'Mostly Clear',
      glyph: 'mostly-clear', isDay: true, humidity: 71, windSpeed: undefined, windGust: undefined,
      windDir: undefined, uv: undefined,
    });
  });

  it('reads the hours, the air and the units', () => {
    const read = weatherFrom(panel, NOW);
    expect(read.hourly.map((hour) => hour.temp)).toEqual(['54°', '56°']);
    expect(read.air).toEqual({ aqi: 43, scale: 'us', label: 'Good', observedAt: OBSERVED });
    expect(read.units).toEqual({ temp: 'F', wind: 'mph', precip: 'in' });
  });

  it('puts it all on the model buildModel hands the renderer', () => {
    const manifest: Manifest = {
      manifestVersion: 1,
      appVersion: '0.1.0-test',
      generatedAt: NOW,
      timezone: 'America/New_York',
      theme: { active: 'panels' },
      window: { from: '2026-09-23', to: '2026-10-30' },
      days: [{ date: '2026-09-24', events: [], shifts: [] }],
      people: [],
      sources: [],
      notices: [],
      weather: null,
      interrupts: [],
      panels: { weather: panel },
    };
    const model = buildModel({ manifest, now: NOW, lastConfirmedAt: NOW, offline: false });
    expect(model.weatherCurrent?.temp).toBe('54°');
    expect(model.weatherHourly).toHaveLength(2);
    expect(model.weatherAir?.label).toBe('Good');
    expect(model.weatherUnits?.wind).toBe('mph');
    expect(model.weather[0]?.summary).toBe('Mostly Cloudy');

    // And it hands `weatherFrom` the wall's clock: the same saved manifest
    // drawn ninety-one minutes after its reading presents no "now" at all.
    const later = OBSERVED + 91 * 60_000;
    const stale = buildModel({ manifest, now: later, lastConfirmedAt: NOW, offline: true });
    expect(stale.weatherCurrent).toBeUndefined();
    expect(stale.weather).toHaveLength(2);
  });
});

describe('the wall’s own clock', () => {
  it('stops presenting a reading as now at ninety minutes, even from a saved manifest', () => {
    // A wall that lost its server at 12:10 and is still drawing what it saved:
    // the server's rule cannot reach it, so the wall applies it again.
    expect(weatherFrom(panel, OBSERVED + 90 * 60_000).current).toBeDefined();
    expect(weatherFrom(panel, OBSERVED + 91 * 60_000).current).toBeUndefined();
    // The days are not a "now", and stay.
    expect(weatherFrom(panel, OBSERVED + 91 * 60_000).days).toHaveLength(2);
  });

  it('drops an hour that has ended', () => {
    expect(weatherFrom(panel, Date.parse('2026-09-24T13:05:00Z')).hourly.map((hour) => hour.temp)).toEqual(['56°']);
  });
});

describe('a document the server would never send', () => {
  it('reads a panel from before any of this existed exactly as it always did', () => {
    const old = { provider: 'nws', days: [{ name: 'Today', high: 66, low: 51, unit: 'F', glyph: 'cloudy' }], fetchedAt: 0, note: null };
    const read = weatherFrom(old, NOW);
    expect(read.days[0]).toMatchObject({ name: 'Today', high: '66°', low: '51°F', glyph: 'cloudy', date: undefined });
    expect(read.current).toBeUndefined();
    expect(read.hourly).toEqual([]);
    expect(read.air).toBeUndefined();
    expect(read.units).toBeUndefined();
  });

  it('costs a field, never the day, for a value that is not one', () => {
    const odd = {
      ...panel,
      days: [{ ...panel.days[0], precipChance: 140, windMax: 'breezy', sunrise: '6:58am', uvMax: -1 }],
    };
    const [day] = weatherFrom(odd, NOW).days;
    expect(day?.high).toBe('66°');
    expect(day?.precipChance).toBeUndefined();
    expect(day?.windMax).toBeUndefined();
    expect(day?.sunrise).toBeUndefined();
    expect(day?.uvMax).toBeUndefined();
  });

  it('drops a current reading that cannot say when, what source, or whether it is day', () => {
    for (const broken of [
      { ...panel.current, observedAt: 'this morning' },
      { ...panel.current, source: 'guessed' },
      { ...panel.current, temp: null },
      { ...panel.current, isDay: 'yes' },
    ]) {
      expect(weatherFrom({ ...panel, current: broken }, NOW).current).toBeUndefined();
    }
  });

  it('refuses a wind direction, a scale or a unit outside its vocabulary', () => {
    const read = weatherFrom(
      {
        ...panel,
        current: { ...panel.current, windDir: 'UP' },
        air: { ...panel.air, scale: 'mars' },
        units: { temp: 'K', wind: 'mph', precip: 'in' },
      },
      NOW,
    );
    expect(read.current?.windDir).toBeUndefined();
    expect(read.air).toBeUndefined();
    expect(read.units).toBeUndefined();
  });

  it('sanitises the words it draws, as it does every string a stranger wrote', () => {
    const read = weatherFrom(
      { ...panel, days: [{ ...panel.days[0], summary: 'Mostly‮ Cloudy', detail: 'Line one\nline two' }] },
      NOW,
    );
    expect(read.days[0]?.summary).toBe('Mostly Cloudy');
    expect(read.days[0]?.detail).toBe('Line one line two');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldPeriods, iconFor, parseForecast, pointsUrl } from '../src/modules/weather/nws.js';
import { collectPanels, type PanelModule } from '../src/modules/registry.js';

/**
 * Weather, against bytes the National Weather Service actually sent.
 *
 * The fixture is a real response, captured once. A hand-written one would
 * agree with whatever this parser happens to do, which is the opposite of a
 * test — and the period folding in particular only looks obvious until you see
 * that a real forecast starts with a night if you ask in the evening.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FORECAST = readFileSync(join(FIXTURES, 'nws-forecast.json'), 'utf8');
const AT = 1_700_000_000_000;

describe('the request', () => {
  it('rounds coordinates, because the service rejects excessive precision', () => {
    expect(pointsUrl({ latitude: 38.88941234, longitude: -77.03521111 })).toBe(
      'https://api.weather.gov/points/38.8894,-77.0352',
    );
  });
});

describe('reading a real forecast', () => {
  it('folds day and night periods into days with a high and a low', () => {
    const forecast = parseForecast(FORECAST, AT, 5);
    expect(forecast).toBeDefined();
    expect(forecast?.days.length).toBeGreaterThan(2);

    // A real forecast captured in the evening starts with a night: a low and
    // no high, named the way the provider named it.
    const first = forecast?.days[0];
    expect(first?.name).toBe('Tonight');
    expect(first?.high).toBeNull();
    expect(typeof first?.low).toBe('number');

    const second = forecast?.days[1];
    expect(second?.name).toBe('Monday');
    expect(typeof second?.high).toBe('number');
    // The low comes from the night that follows, not from the day itself.
    expect(typeof second?.low).toBe('number');
  });

  it('honours the limit it is given', () => {
    expect(parseForecast(FORECAST, AT, 3)?.days).toHaveLength(3);
  });

  it('returns nothing rather than throwing on a document that is not one', () => {
    for (const body of ['null', '{}', 'not json', '{"properties":{}}', '[]']) {
      expect(parseForecast(body, AT, 5)).toBeUndefined();
    }
  });

  it('pairs a day with the night after it, not the night before', () => {
    const days = foldPeriods(
      [
        { name: 'Monday', isDaytime: true, temperature: 80, temperatureUnit: 'F', shortForecast: 'Sunny' },
        { name: 'Monday Night', isDaytime: false, temperature: 60, temperatureUnit: 'F', shortForecast: 'Clear' },
        { name: 'Tuesday', isDaytime: true, temperature: 70, temperatureUnit: 'F', shortForecast: 'Rain' },
        { name: 'Tuesday Night', isDaytime: false, temperature: 50, temperatureUnit: 'F', shortForecast: 'Clear' },
      ],
      5,
    );
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ name: 'Monday', high: 80, low: 60 });
    expect(days[1]).toMatchObject({ name: 'Tuesday', high: 70, low: 50 });
  });

  it('leaves the low empty when the forecast ends on a day', () => {
    const days = foldPeriods(
      [{ name: 'Friday', isDaytime: true, temperature: 75, temperatureUnit: 'F', shortForecast: 'Sunny' }],
      5,
    );
    expect(days[0]).toMatchObject({ high: 75, low: null });
  });
});

describe('the icon', () => {
  it('matches the more specific wording first', () => {
    // "Chance Showers And Thunderstorms" is a storm, not a shower.
    expect(iconFor('Chance Showers And Thunderstorms')).toBe(iconFor('Thunderstorms'));
    expect(iconFor('Showers And Thunderstorms')).not.toBe(iconFor('Rain Showers'));
  });

  it('has something for every summary in the real fixture', () => {
    const summaries = [...FORECAST.matchAll(/"shortForecast":\s*"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(summaries.length).toBeGreaterThan(3);
    for (const summary of summaries) {
      expect(iconFor(summary), `no icon for "${summary}"`).not.toBe('·');
    }
  });

  it('falls back rather than throwing on wording nobody predicted', () => {
    expect(iconFor('Volcanic Ash')).toBe('·');
    expect(iconFor('')).toBe('·');
  });
});

describe('the module seam', () => {
  const db = {} as never;

  it('collects a slice from every ready module', () => {
    const modules: PanelModule[] = [
      { key: 'a', label: 'A', ready: () => true, contribute: () => ({ v: 1 }) },
      { key: 'b', label: 'B', ready: () => true, contribute: () => ({ v: 2 }) },
    ];
    expect(collectPanels(modules, { db, fetcher: {} as never, now: AT, timezone: 'UTC' })).toEqual({
      a: { v: 1 },
      b: { v: 2 },
    });
  });

  it('skips a module that is not ready, and one with nothing to say', () => {
    const modules: PanelModule[] = [
      { key: 'off', label: 'Off', ready: () => false, contribute: () => ({ v: 1 }) },
      { key: 'quiet', label: 'Quiet', ready: () => true, contribute: () => null },
    ];
    expect(collectPanels(modules, { db, fetcher: {} as never, now: AT, timezone: 'UTC' })).toEqual({});
  });

  it('lets one module fail without costing the others', () => {
    // A calendar must not stop rendering because a forecast provider changed a
    // field name. This is the whole reason the seam catches per module.
    const modules: PanelModule[] = [
      {
        key: 'broken', label: 'Broken', ready: () => true,
        contribute: () => { throw new Error('provider changed'); },
      },
      { key: 'fine', label: 'Fine', ready: () => true, contribute: () => ({ v: 'ok' }) },
    ];
    expect(collectPanels(modules, { db, fetcher: {} as never, now: AT, timezone: 'UTC' })).toEqual({
      fine: { v: 'ok' },
    });
  });
});

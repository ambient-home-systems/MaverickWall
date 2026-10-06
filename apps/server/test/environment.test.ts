import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { airQualityUrl, parseAirQuality, parseOpenMeteo } from '../src/modules/weather/open-meteo.js';
import { ENV_DEFAULT_FIELDS, envAscii, envFields, envTiles, pollenWords, uvWords } from '../src/api/env-tiles.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';

/**
 * The Environment widget's readings (plan item M5.6), from real answers.
 *
 * Captured on 6 October 2026: London, Berlin and Washington from the
 * air-quality service, and the forecast for Washington with sunlight in it —
 * plus Berlin's hourly record for 20 April, the one day here with pollen in
 * the air. What is held is the difference the plan names: pollen is modelled
 * for Europe only, so outside it there is no pollen tile at all, and inside it
 * a day with none says "None".
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const real = (name: string): string => readFileSync(join(HERE, 'fixtures', 'open-meteo', 'real', name), 'utf8');

describe('the air-quality request', () => {
  it('asks for the pollutants, the UV and six plants’ pollen in the one request the switch consents to', () => {
    const url = new URL(airQualityUrl({ latitude: 51.5074, longitude: -0.1278 }));
    expect(url.host).toBe('air-quality-api.open-meteo.com');
    expect(url.searchParams.get('current')?.split(',')).toEqual([
      'us_aqi', 'european_aqi', 'pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide', 'uv_index',
      'alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen',
    ]);
  });
});

describe('reading real answers', () => {
  it('reads London’s pollutants, and its zero pollen as "none today"', () => {
    expect(parseAirQuality(real('air-pollutants-london.json'), 'eu')).toEqual({
      aqi: 68,
      scale: 'eu',
      label: 'Poor',
      observedAt: Date.parse('2026-10-06T20:00:00+01:00'),
      pm25: 12.2,
      pm10: 15.1,
      ozone: 2,
      no2: 76.7,
      uv: 0,
      pollen: {},
    });
  });

  it('reads Washington’s with no pollen at all, because none is modelled there', () => {
    const air = parseAirQuality(real('air-pollutants-washington.json'), 'us');
    expect(air?.pollen).toBeUndefined();
    expect(air?.ozone).toBe(91);
  });

  it('reads Berlin in April with birch in the air', () => {
    const hourly = JSON.parse(real('air-pollen-berlin-april-hourly.json')) as {
      utc_offset_seconds: number;
      hourly: Record<string, unknown[]>;
    };
    const at = hourly.hourly['time']?.indexOf('2026-04-20T14:00') as number;
    const current = Object.fromEntries(Object.entries(hourly.hourly).map(([key, values]) => [key, values[at]]));
    const air = parseAirQuality(JSON.stringify({ utc_offset_seconds: hourly.utc_offset_seconds, current }), 'eu');
    expect(air?.pollen).toEqual({ alder: 0.3, birch: 304.7, grass: 0.4 });
  });

  it('reads the sunlight from the forecast, in W/m²', () => {
    const parts = parseOpenMeteo(real('forecast-dc-solar.json'), {
      now: Date.parse('2026-10-06T19:05:00Z'),
      units: 'imperial',
      todayIso: '2026-10-06',
      limit: 5,
    });
    expect(parts.current?.solar).toBe(639);
    // An answer from before the field existed reads exactly as it did.
    const older = parseOpenMeteo(real('forecast-dc-imperial.json'), {
      now: Date.parse('2026-09-24T19:05:00Z'),
      units: 'imperial',
      todayIso: '2026-09-24',
      limit: 5,
    });
    expect(older.current === undefined || !('solar' in older.current)).toBe(true);
  });
});

describe('the tiles', () => {
  const london = parseAirQuality(real('air-pollutants-london.json'), 'eu');
  const washington = parseAirQuality(real('air-pollutants-washington.json'), 'us');

  it('draws the default five in order, each only where its reading exists', () => {
    expect(envFields({})).toEqual([...ENV_DEFAULT_FIELDS]);
    const tiles = envTiles({ air: london!, windSpeed: 12.4, windDir: 'NW', windUnit: 'km/h' }, {});
    expect(tiles).toEqual([
      { key: 'aqi', label: 'Air quality (EU)', value: '68', detail: 'Poor' },
      { key: 'pm25', label: 'PM2.5', value: '12', unit: 'µg/m³' },
      { key: 'pollen', label: 'Pollen', value: 'None' },
      { key: 'uv', label: 'UV', value: '0', detail: 'Low' },
      { key: 'wind', label: 'Wind', value: '12', unit: 'km/h', detail: 'NW' },
    ]);
  });

  it('has no pollen tile where pollen is not modelled, rather than a dash', () => {
    const tiles = envTiles({ air: washington! }, { envFields: ['pollen', 'ozone'] });
    expect(tiles.map((tile) => tile.key)).toEqual(['ozone']);
  });

  it('names the plant with most in the air, and draws nothing with no reading at all', () => {
    const tiles = envTiles({ air: { ...london!, pollen: { birch: 304.7, grass: 0.4 } } }, { envFields: ['pollen'] });
    expect(tiles).toEqual([{ key: 'pollen', label: 'Pollen', value: 'Birch', detail: 'Very high' }]);
    expect(envTiles({}, {})).toEqual([]);
  });

  it('falls back to the forecast’s UV, and draws sunlight only where the forecast has it', () => {
    expect(envTiles({ uv: 6.4 }, { envFields: ['uv', 'solar'] })).toEqual([
      { key: 'uv', label: 'UV', value: '6', detail: 'High' },
    ]);
    expect(envTiles({ solar: 639 }, { envFields: ['solar'] })).toEqual([
      { key: 'solar', label: 'Sunlight', value: '639', unit: 'W/m²' },
    ]);
  });

  it('uses the WHO’s UV words and a general pollen guide, at their edges', () => {
    expect([0, 2.9, 3, 5.9, 6, 7.9, 8, 10.9, 11].map(uvWords)).toEqual([
      'Low', 'Low', 'Moderate', 'Moderate', 'High', 'High', 'Very high', 'Very high', 'Extreme',
    ]);
    expect([1, 9.9, 10, 49, 50, 199, 200].map(pollenWords)).toEqual([
      'Low', 'Low', 'Moderate', 'Moderate', 'High', 'High', 'Very high',
    ]);
  });

  it('keeps its own order whatever order a config names them in, and says it in ASCII for a panel', () => {
    expect(envFields({ envFields: ['wind', 'aqi'] })).toEqual(['aqi', 'wind']);
    expect(envAscii('NO₂ 15 µg/m³ · 639 W/m²')).toBe('NO2 15 ug/m3 · 639 W/m2');
  });

  it('is refused a reading the widget does not know', () => {
    expect(widgetConfigBody.safeParse({ envFields: ['aqi', 'radon'] }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ envFields: ['aqi', 'pollen'] }).success).toBe(true);
  });
});

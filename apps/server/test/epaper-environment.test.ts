import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { panelInput, renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * An Environment widget on one bit (plan item M5.6).
 *
 * A panel reads its tiles as lines, built by the same `envTiles` the wall
 * draws, in the panel's ASCII — "ug/m3" where the wall says "µg/m³", which
 * `asciiTitle` alone would have cut to "g/m". What the frame's ETag hashes is
 * those lines, so a frame changes when a number it draws changes and not when
 * a reading it does not draw does.
 */
function manifest(air: Record<string, unknown> | null = {
  aqi: 42, scale: 'eu', label: 'Fair', observedAt: 1, pm25: 8.2, pm10: 12.1, ozone: 60, no2: 14.5, uv: 4.1,
  pollen: { birch: 120.5, grass: 3 },
}): Manifest {
  const days: ManifestDay[] = [{ date: '2026-10-06', shifts: [], events: [] } as unknown as ManifestDay];
  return {
    timezone: 'Europe/London',
    generatedAt: Date.UTC(2026, 9, 6, 10),
    window: { from: '2026-10-01', to: '2026-11-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [],
    panels: {
      weather: {
        days: [],
        ...(air === null ? {} : { air }),
        current: { observedAt: 1, source: 'modelled', temp: 20, condition: '', glyph: null, isDay: true, windSpeed: 12, windDir: 'NW', solar: 410 },
        units: { temp: 'C', wind: 'km/h', precip: 'mm' },
      },
      home: {
        readings: [
          { key: 'rd-co2', label: 'Indoor CO₂', value: '612 ppm', mode: 'label_value' },
          { key: 'rd-garden', label: 'Garden', value: '14.2 °C', mode: 'label_value' },
        ],
      },
    },
  } as unknown as Manifest;
}

const lines = (config: Record<string, unknown>, m: Manifest = manifest()): unknown =>
  (panelInput('environment', m, config) as { panel: unknown }).panel;

describe('the environment on a panel', () => {
  it('reads its tiles as ASCII lines, in the household’s order', () => {
    expect(lines({})).toEqual(['Air quality (EU) 42 Fair', 'PM2.5 8 ug/m3', 'Pollen Birch High', 'UV 4 Moderate', 'Wind 12 km/h NW']);
    expect(lines({ envFields: ['solar', 'no2'] })).toEqual(['NO2 15 ug/m3', 'Sunlight 410 W/m2']);
  });

  it('adds the sensors it names, by handle or by label, and none when it names none', () => {
    expect(lines({ envFields: [], readings: ['Garden'] })).toEqual(['Garden 14.2 C']);
    expect(lines({ envFields: [] })).toEqual([]);
  });

  it('draws no air tile with air quality off, and keeps the wind', () => {
    expect(lines({}, manifest(null))).toEqual(['Wind 12 km/h NW']);
  });

  it('moves its frame input when a number it draws moves, and not when one it does not draw does', () => {
    const base = lines({ envFields: ['aqi'] });
    const ozone = manifest({ aqi: 42, scale: 'eu', label: 'Fair', observedAt: 1, ozone: 99 });
    expect(lines({ envFields: ['aqi'] }, ozone)).toEqual(base);
    const worse = manifest({ aqi: 61, scale: 'eu', label: 'Poor', observedAt: 1 });
    expect(lines({ envFields: ['aqi'] }, worse)).not.toEqual(base);
  });

  it('draws its lines, and says so when it has none', () => {
    const ink = (config: Record<string, unknown>, m: Manifest = manifest()): number => {
      const widget: PlacedEpaperWidget = { type: 'environment', x: 0, y: 0, w: 1, h: 1, z: 0, config };
      const fb = renderFreeformEpaper(buildEpaperModel(m), m, [widget], { width: 800, height: 480 });
      let count = 0;
      for (let y = 20; y < 460; y++) for (let x = 20; x < 780; x++) if (fb.get(x, y)) count++;
      return count;
    };
    expect(ink({})).toBeGreaterThan(ink({ envFields: ['aqi'] }));
    expect(ink({ envFields: [] })).toBeGreaterThan(0);
  });
});

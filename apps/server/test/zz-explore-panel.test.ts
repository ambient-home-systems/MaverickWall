import { it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { encodePng1bit } from '../src/epaper/png.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { parseOpenMeteo } from '../src/modules/weather/open-meteo.js';
import type { Manifest } from '../src/api/manifest.js';

const OUT = process.env['EXPLORE_OUT'] ?? '/tmp';
it('draws', () => {
  const body = readFileSync('test/fixtures/open-meteo/real/forecast-london-metric.json', 'utf8');
  const parts = parseOpenMeteo(body, { now: Date.UTC(2026, 8, 24, 12, 40), units: 'metric', todayIso: '2026-09-24', limit: 5 });
  for (const withCurrent of [true, false]) {
    const manifest = {
      timezone: 'Europe/London', generatedAt: Date.UTC(2026, 8, 24, 12, 40), window: { from: '2026-09-01', to: '2026-10-31' },
      display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
      days: [{ date: '2026-09-24', shifts: [], events: [] }],
      panels: { weather: { provider: 'openmeteo', fetchedAt: 1, note: null, days: parts.forecast!.days, ...(withCurrent ? { current: { ...parts.current!, source: 'modelled' } } : {}), units: { temp: 'C', wind: 'km/h', precip: 'mm' } } },
    } as unknown as Manifest;
    const widgets: PlacedEpaperWidget[] = [
      { type: 'weather', x: 0, y: 0, w: 0.5, h: 0.5, z: 0, config: { variant: 'today' } } as PlacedEpaperWidget,
      { type: 'weather', x: 0.5, y: 0, w: 0.5, h: 0.25, z: 0, config: { variant: 'today' } } as PlacedEpaperWidget,
      { type: 'weather', x: 0.5, y: 0.25, w: 0.25, h: 0.1, z: 0, config: { variant: 'today' } } as PlacedEpaperWidget,
      { type: 'weather', x: 0, y: 0.5, w: 1, h: 0.5, z: 0, config: {} } as PlacedEpaperWidget,
    ];
    const fb = renderFreeformEpaper(buildEpaperModel(manifest), manifest, widgets, { width: 800, height: 480 });
    writeFileSync(`${OUT}/panel-today-${withCurrent ? 'now' : 'forecast'}.png`, encodePng1bit(fb));
  }
});

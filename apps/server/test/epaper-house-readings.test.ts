import { describe, expect, it } from 'vitest';

import { haReadingHandle, type Manifest } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';

/**
 * A panel picks a Home Assistant widget's readings the way the wall does (P1.3).
 *
 * A panel draws from the *stored* config — entity ids now, or a label on a
 * widget saved before the editor wrote ids — and resolves them against the
 * house panel's handles through the same `readingHandlesFor` the manifest
 * uses for the wall, so the two cannot pick differently.
 *
 * It used to compare the stored label with `asciiTitle` of the panel's, which
 * deletes every code point above 0x7E, so a label with an accent could never
 * match: a panel asked for "Température" drew "No readings yet" while the wall
 * beside it drew the temperature. That is asserted here by decoding frames,
 * the way every claim about a 1-bit frame in this suite is — and it is the
 * pair that goes red when the filter is put back on the label: the id and the
 * label draw the same frame, and it is not the frame for the other reading.
 */

const PANEL = {
  readings: [
    {
      key: haReadingHandle('sensor.salon'),
      label: 'Température',
      value: '19.4',
      unit: '°C',
      glyph: 'thermometer',
      mode: 'label_value',
      stale: false,
    },
    {
      key: haReadingHandle('sensor.hall'),
      label: 'Hall',
      value: '18.1',
      unit: '°C',
      glyph: 'thermometer',
      mode: 'label_value',
      stale: false,
    },
  ],
  fetchedAt: 0,
  note: null,
};

function manifest(): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 8, 24, 11, 0, 0),
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [],
    sources: [],
    panels: { home: PANEL },
  } as unknown as Manifest;
}

function frame(config: Record<string, unknown>): string {
  const m = manifest();
  const widget: PlacedEpaperWidget = { type: 'homeassistant', x: 0.05, y: 0.05, w: 0.6, h: 0.5, z: 0, config };
  const fb: Framebuffer = renderFreeformEpaper(buildEpaperModel(m), m, [widget], { width: 800, height: 480 });
  let bits = '';
  for (let y = 0; y < 480; y++) for (let x = 0; x < 800; x++) bits += fb.get(x, y) ? '1' : '0';
  return bits;
}

describe('a Home Assistant widget on a panel', () => {
  it('draws the reading a widget names by entity id', () => {
    const byId = frame({ readings: ['sensor.salon'] });
    expect(byId).not.toBe(frame({ readings: ['sensor.hall'] }));
    // And not the frame for a reading nobody watches, which draws nothing but its note.
    expect(byId).not.toBe(frame({ readings: ['sensor.garden_shed'] }));
  });

  it('draws the reading a legacy widget names by label, accent and all', () => {
    // Not "No readings yet", which is what the old comparison drew for it:
    // `sensor.garden_shed` is watched by nobody, so its frame is that note.
    expect(frame({ readings: ['Température'] })).not.toBe(frame({ readings: ['sensor.garden_shed'] }));
    expect(frame({ readings: ['Température'] })).toBe(frame({ readings: ['sensor.salon'] }));
    expect(frame({ readings: ['Hall'] })).toBe(frame({ readings: ['sensor.hall'] }));
  });

  it('draws every reading when none is named, as it always has', () => {
    expect(frame({})).toBe(frame({ readings: [] }));
    expect(frame({})).not.toBe(frame({ readings: ['sensor.hall'] }));
  });

  it('lets the ink lane pick a different reading from the wall', () => {
    // The panel's own list wins, resolved the same way: `withInk` lays it over.
    expect(frame({ readings: ['sensor.salon'], ink: { readings: ['sensor.hall'] } })).toBe(
      frame({ readings: ['sensor.hall'] }),
    );
  });
});

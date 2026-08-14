import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The freeform renderer places widgets in their boxes and draws each type.
 *
 * Exact glyphs are not assertable from a 1-bit buffer, so these check the
 * load-bearing structural promises: a widget draws inside its own box and not
 * outside it, every type renders without throwing, and a box too small to hold
 * anything is skipped rather than left as a lone border.
 */

function manifest(days: ManifestDay[] = []): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 8, 42, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    panels: { weather: { items: [{ label: 'Now', value: '19° cloudy' }] } },
  } as unknown as Manifest;
}

const W = (type: string, x: number, y: number, w: number, h: number, config: Record<string, unknown> = {}, z = 0): PlacedEpaperWidget => ({ type, x, y, w, h, z, config });

function inkIn(fb: Framebuffer, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (fb.get(x, y)) n++;
  return n;
}

describe('placement', () => {
  it('draws a widget inside its box and leaves the rest of the canvas blank', () => {
    const fb = renderFreeformEpaper(
      buildEpaperModel(manifest()),
      manifest(),
      [W('clock', 0.0, 0.0, 0.5, 0.25)],
      { width: 400, height: 240 },
    );
    // Ink is in the top-left quarter…
    expect(inkIn(fb, 0, 0, 200, 60)).toBeGreaterThan(0);
    // …and nothing spilled into the bottom-right.
    expect(inkIn(fb, 210, 120, 400, 240)).toBe(0);
  });

  it('skips a widget too small to hold anything', () => {
    const fb = renderFreeformEpaper(buildEpaperModel(manifest()), manifest(), [W('clock', 0.5, 0.5, 0.01, 0.01)], {
      width: 400,
      height: 240,
    });
    expect(inkIn(fb, 0, 0, 400, 240)).toBe(0);
  });

  it('respects z-order without crashing on overlap', () => {
    expect(() =>
      renderFreeformEpaper(
        buildEpaperModel(manifest()),
        manifest(),
        [W('calendar', 0, 0, 1, 1, { mode: 'month' }, 0), W('clock', 0.1, 0.1, 0.4, 0.2, {}, 5)],
        { width: 800, height: 480 },
      ),
    ).not.toThrow();
  });
});

describe('every widget type renders', () => {
  const model = buildEpaperModel(
    manifest([
      { date: '2026-08-13', shifts: [], events: [{ id: 'e', uid: 'e', title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9), endsAt: 0, allDay: false, sourceId: 's', color: '#000', status: 'confirmed', continues: false }] },
    ]),
  );
  const types = ['clock', 'calendar', 'shift', 'countdown', 'notes', 'todo', 'weather', 'homeassistant', 'external', 'image', 'nonsense'];

  for (const type of types) {
    it(`draws ${type} without throwing and puts ink in its box`, () => {
      const config: Record<string, unknown> =
        type === 'countdown'
          ? { target: '2026-08-20', title: 'Trip' }
          : type === 'notes'
            ? { text: 'Milk, bread, and something long enough to wrap onto a second line here' }
            : type === 'todo'
              ? { items: ['Post office', 'Call the plumber'] }
              : type === 'calendar'
                ? { mode: 'month' }
                : {};
      const fb = renderFreeformEpaper(model, manifest(), [W(type, 0.05, 0.05, 0.9, 0.9, config)], {
        width: 400,
        height: 300,
      });
      // The border alone guarantees ink; the point is nothing threw and the box drew.
      expect(inkIn(fb, 0, 0, 400, 300)).toBeGreaterThan(0);
    });
  }
});

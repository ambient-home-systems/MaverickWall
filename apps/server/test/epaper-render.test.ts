import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { renderEpaper } from '../src/epaper/render.js';
import { renderFreeformEpaper } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The renderer draws something coherent for both orientations.
 *
 * Exact pixel positions are layout, and layout is argued about by looking at a
 * generated frame, not asserted here. What this pins is the load-bearing 1-bit
 * grammar: the header is an inverted band with text knocked out of it, and both
 * columns actually get drawn. A blank region on either side is the failure this
 * catches.
 */

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e', uid: 'e', title: 'Event', startsAt: 0, endsAt: 0, allDay: false,
    sourceId: 's', color: '#000', status: 'confirmed', continues: false, ...over,
  };
}
function fakeManifest(days: ManifestDay[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

/** Count ink pixels in a rectangle, for "did anything get drawn here" checks. */
function inkIn(fb: ReturnType<typeof renderEpaper>, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (fb.get(x, y)) n++;
  return n;
}

const busyDay: ManifestDay = {
  date: '2026-08-13',
  shifts: [],
  events: [ev({ title: 'Bin day', allDay: true }), ev({ title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0) })],
};

describe('landscape', () => {
  const fb = renderEpaper(buildEpaperModel(fakeManifest([busyDay])), { width: 800, height: 480 });

  it('is the size of the panel', () => {
    expect(fb.width).toBe(800);
    expect(fb.height).toBe(480);
  });

  it('draws an inverted header with text knocked out', () => {
    const inkInHeader = inkIn(fb, 0, 0, 800, 54);
    const total = 800 * 54;
    expect(inkInHeader).toBeGreaterThan(total * 0.5); // mostly filled band
    expect(inkInHeader).toBeLessThan(total); // but text is knocked back out
  });

  it('draws both the agenda column and the grid column', () => {
    expect(inkIn(fb, 0, 60, 380, 480)).toBeGreaterThan(0); // agenda
    expect(inkIn(fb, 400, 60, 800, 480)).toBeGreaterThan(0); // grid
  });
});

describe('portrait', () => {
  it('renders without complaint and fills both regions', () => {
    const fb = renderEpaper(buildEpaperModel(fakeManifest([busyDay])), { width: 480, height: 800 });
    expect(fb.width).toBe(480);
    expect(fb.height).toBe(800);
    expect(inkIn(fb, 0, 60, 480, 400)).toBeGreaterThan(0); // agenda area
    expect(inkIn(fb, 0, 400, 480, 800)).toBeGreaterThan(0); // grid area
  });
});

describe('an empty day', () => {
  it('says so rather than leaving the column blank', () => {
    const fb = renderEpaper(buildEpaperModel(fakeManifest([{ date: '2026-08-13', shifts: [], events: [] }])), {
      width: 800,
      height: 480,
    });
    expect(inkIn(fb, 0, 60, 380, 200)).toBeGreaterThan(0); // "Nothing on today"
  });
});

/**
 * Text is sized to the box it has, not just the height of it.
 *
 * `drawLines` truncates a line at its box edge, so a size chosen from height
 * alone loses characters off the right — reported from a real panel as a clock
 * that drew "08:3" for half past eight. The box must shrink the type instead.
 *
 * Decoded rather than eyeballed, in the spirit of the QR encoder: two times of
 * the same length that differ only in the final digit must produce different
 * frames. Identical frames mean that digit never reached the panel — which is
 * exactly what the bug did, and what a "looks about right" assertion misses.
 */
describe('a clock in a box taller than it is wide', () => {
  const manifest = fakeManifest([busyDay]);
  // 0.34 × 0.31 of an 800×480 panel: the arrangement the fault was seen in.
  const clockFrame = (now: number) =>
    renderFreeformEpaper(
      buildEpaperModel(manifest, { now }),
      manifest,
      [{ type: 'clock', x: 0.02, y: 0.02, w: 0.34, h: 0.31, z: 0, config: {} }],
      { width: 800, height: 480 },
    );
  const differs = (a: ReturnType<typeof clockFrame>, b: ReturnType<typeof clockFrame>): boolean => {
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (a.get(x, y) !== b.get(x, y)) return true;
    return false;
  };

  it('draws the final digit of the time rather than cutting it off', () => {
    const at0832 = clockFrame(Date.UTC(2026, 7, 21, 8, 32));
    const at0830 = clockFrame(Date.UTC(2026, 7, 21, 8, 30));
    expect(differs(at0832, at0830)).toBe(true);
  });

  it('keeps every pixel it draws inside the widget box', () => {
    const fb = clockFrame(Date.UTC(2026, 7, 21, 8, 32));
    // The box is x 16..288, y 9..158 on this panel; nothing may spill past it.
    const right = Math.round(0.02 * 800) + Math.round(0.34 * 800);
    const bottom = Math.round(0.02 * 480) + Math.round(0.31 * 480);
    expect(inkIn(fb, right + 2, 0, 800, 480)).toBe(0);
    expect(inkIn(fb, 0, bottom + 2, 800, 480)).toBe(0);
  });
});

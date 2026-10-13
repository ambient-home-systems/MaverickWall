import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import type { RegionLog } from '../src/epaper/render.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { bitString } from './epaper-frame.js';

/**
 * A stacked group on one bit (plan item M6.6), decoded.
 *
 * A stack gives every child the whole of its inner box and the wall draws one
 * at a time, swapped by a tap. A panel cannot be tapped, so it draws the front
 * one — the first in `z` order — and nothing of the others: not a frame, not a
 * word. The strongest way to say so is a frame: the stack of two draws exactly
 * the bits a group holding only its front child draws, in the same box.
 */

function manifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 23; d <= 27; d++) days.push({ date: `2026-09-${d}`, shifts: [], events: [] } as unknown as ManifestDay);
  return {
    timezone: 'Europe/London',
    generatedAt: Date.UTC(2026, 8, 23, 10, 0, 0),
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [],
    panels: {},
  } as unknown as Manifest;
}

const M = manifest();
const MODEL = buildEpaperModel(M);
const PANEL = { width: 800, height: 480 };

function group(layout: string): PlacedEpaperWidget {
  return { id: 'g', type: 'group', x: 0.05, y: 0.1, w: 0.6, h: 0.5, z: 0, config: { layout } };
}
const FRONT: PlacedEpaperWidget = {
  type: 'heading', x: 0, y: 0, w: 1, h: 1, z: 0, config: { text: 'ALPHA' }, parentId: 'g',
};
const BEHIND: PlacedEpaperWidget = {
  type: 'heading', x: 0, y: 0, w: 1, h: 1, z: 1, config: { text: 'BETAWORDS' }, parentId: 'g',
};

function render(widgets: readonly PlacedEpaperWidget[]): { bits: string; regions: RegionLog } {
  const regions: RegionLog = [];
  const fb = renderFreeformEpaper(MODEL, M, widgets, PANEL, regions);
  return { bits: bitString(fb), regions };
}

describe('a stacked group on a panel', () => {
  it('draws its front widget across the whole inner box, and nothing of the one behind it', () => {
    const stack = render([group('stack'), FRONT, BEHIND]);
    const frontAlone = render([group('stack'), FRONT]);
    expect(stack.bits).toBe(frontAlone.bits);

    const inner = stack.regions.find((r) => r.name === 'widget-inner:0');
    const child = stack.regions.find((r) => r.name === 'child:0:0');
    expect(child).toEqual(inner === undefined ? undefined : { ...inner, name: 'child:0:0' });
    expect(stack.regions.some((r) => r.name === 'child:0:1')).toBe(false);
  });

  it('draws the front by `z`, not by the order the rows arrive in', () => {
    expect(render([group('stack'), BEHIND, FRONT]).bits).toBe(render([group('stack'), FRONT]).bits);
  });

  it('is a different frame from the same two widgets in a row, which draws both', () => {
    const row = render([group('row'), FRONT, BEHIND]);
    expect(row.regions.some((r) => r.name === 'child:0:1')).toBe(true);
    expect(row.bits).not.toBe(render([group('stack'), FRONT, BEHIND]).bits);
  });

  it('is a layout the schema takes', () => {
    expect(widgetConfigBody.safeParse({ layout: 'stack' }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ layout: 'pile' }).success).toBe(false);
  });
});

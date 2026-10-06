import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * A Heading on one bit (plan item M5.4), decoded.
 *
 * `epaper-ink.test.ts` proves every key a panel is said to honour moves ink.
 * What it cannot say is *how*: that a smaller box gives up the second line
 * before the heading gives up a size, that the block sits where it was asked,
 * and that nothing is drawn outside the box or through a line of type. Each of
 * those is read off the frame here, as bands of ink.
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

/** A box in panel pixels, as fractions the canvas stores. */
function render(config: Record<string, unknown>, box: { x: number; y: number; w: number; h: number }): Framebuffer {
  const widget: PlacedEpaperWidget = {
    type: 'heading',
    x: box.x / PANEL.width,
    y: box.y / PANEL.height,
    w: box.w / PANEL.width,
    h: box.h / PANEL.height,
    z: 0,
    config,
  };
  return renderFreeformEpaper(MODEL, M, [widget], PANEL);
}

/**
 * The bands of ink inside a box, top to bottom, stepping in from its hairline
 * frame: each a run of rows with ink in them, as [first row, last row].
 */
function bands(fb: Framebuffer, box: { x: number; y: number; w: number; h: number }): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let y = box.y + 2; y <= box.y + box.h - 2; y++) {
    let ink = false;
    if (y < box.y + box.h - 2) {
      for (let x = box.x + 2; x < box.x + box.w - 2; x++) {
        if (fb.get(x, y)) {
          ink = true;
          break;
        }
      }
    }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      out.push([start, y - 1]);
      start = -1;
    }
  }
  return out;
}

/**
 * Every inked pixel outside a box, as "x,y", collected and asserted once: an
 * `expect` per pixel is 384,000 of them, which timed out on a CI runner.
 */
function inkOutside(fb: Framebuffer, box: { x: number; y: number; w: number; h: number }): string[] {
  const stray: string[] = [];
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) {
      const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      if (!inside && fb.get(x, y)) stray.push(`${x},${y}`);
    }
  }
  return stray.slice(0, 20);
}

const height = (band: [number, number] | undefined): number => (band === undefined ? 0 : band[1] - band[0] + 1);

describe('a heading on a panel', () => {
  const wide = { x: 20, y: 20, w: 760, h: 300 };

  it('draws its three sizes in order, small to large', () => {
    const at = (textSize: string): number =>
      height(bands(render({ text: 'HELLO', textSize }, wide), wide)[0]);
    expect(at('small')).toBeLessThan(at('medium'));
    expect(at('medium')).toBeLessThan(at('large'));
  });

  it('gives up the second line before a size, as the box shortens', () => {
    const config = { text: 'HELLO', subtitle: 'SECOND LINE', textSize: 'large' };
    const large = height(bands(render(config, wide), wide)[0]);
    const seen: { h: number; head: number; second: boolean }[] = [];
    for (let h = 300; h >= 30; h -= 2) {
      const box = { ...wide, h };
      const found = bands(render(config, box), box);
      seen.push({ h, head: height(found[0]), second: found.length > 1 });
    }
    // The tall boxes draw both lines at the size asked for.
    expect(seen[0]).toEqual({ h: 300, head: large, second: true });
    // Somewhere the heading keeps its size and the second line has gone.
    expect(seen.some((one) => one.head === large && !one.second)).toBe(true);
    // And at no box does a smaller heading come before the second line goes at the larger one.
    const firstSmaller = seen.findIndex((one) => one.head < large);
    const firstWithout = seen.findIndex((one) => !one.second);
    expect(firstWithout).toBeGreaterThanOrEqual(0);
    expect(firstSmaller).toBeGreaterThan(firstWithout);
  });

  it('sits at the top, the middle or the bottom of its box, as asked', () => {
    const top = bands(render({ text: 'HELLO', valign: 'top' }, wide), wide)[0] as [number, number];
    const middle = bands(render({ text: 'HELLO' }, wide), wide)[0] as [number, number];
    const bottom = bands(render({ text: 'HELLO', valign: 'bottom' }, wide), wide)[0] as [number, number];
    expect(top[0]).toBeLessThan(middle[0]);
    expect(middle[0]).toBeLessThan(bottom[0]);
    // Each against its own edge, inside the frame's inset and no further.
    expect(top[0] - wide.y).toBeLessThan(30);
    expect(wide.y + wide.h - bottom[1]).toBeLessThan(30);
  });

  it('draws a rule across the box between the two lines, when asked', () => {
    const config = { text: 'HELLO', subtitle: 'SECOND LINE', divider: true };
    const found = bands(render(config, wide), wide);
    expect(found.length).toBe(3);
    const rule = found[1] as [number, number];
    expect(height(rule)).toBe(1);
    const fb = render(config, wide);
    let across = 0;
    for (let x = wide.x; x < wide.x + wide.w; x++) if (fb.get(x, rule[0])) across++;
    expect(across).toBeGreaterThan(wide.w * 0.8);
    expect(bands(render({ ...config, divider: false }, wide), wide).length).toBe(2);
  });

  it('keeps every line it draws inside its box, and cuts a long heading between lines', () => {
    const box = { x: 100, y: 100, w: 200, h: 70 };
    const long = { text: 'A HEADING FAR TOO LONG FOR THIS SMALL BOX TO HOLD AT ANY SIZE', textSize: 'large' };
    const fb = render(long, box);
    expect(inkOutside(fb, box)).toEqual([]);
    // At least one whole line, and every band a full line of type: none cut through.
    const found = bands(fb, box);
    expect(found.length).toBeGreaterThan(0);
    const first = height(found[0]);
    for (const band of found) expect(height(band)).toBe(first);
  });

  it('draws no line at all in a box too short for one, rather than half of one', () => {
    // 28px: drawn at all (a box under 16 is skipped whole), with 12px inside its
    // frame's inset for a 16px line.
    const box = { x: 100, y: 100, w: 300, h: 28 };
    // With a glyph, which is taller than the line beside it and must not be drawn beside nothing.
    const fb = render({ text: 'HELLO', textSize: 'small', glyph: 'person' }, box);
    expect(inkOutside(fb, box)).toEqual([]);
  });

  it('says there is nothing to show, rather than an empty box', () => {
    expect(bands(render({}, wide), wide).length).toBe(1);
  });
});

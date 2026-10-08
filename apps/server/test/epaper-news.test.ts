import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { panelInput, renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { decodePixels } from './qr-decode.js';
import { bitString } from './epaper-frame.js';

/**
 * A News widget on one bit (plan item M5.5), read off the frame.
 *
 * A panel never turns through the headlines — it shows one picture for up to
 * an hour — so the one-at-a-time view is the newest headline with its code,
 * and the code is decoded here rather than looked at. The list is held to
 * whole rows. And what the frame's ETag hashes is held to what is drawn: a
 * list carries no link, so a story's address changing cannot refresh it.
 */

const AT = Date.UTC(2026, 9, 6, 15, 0);
const HEADLINES = [
  { key: 'nh-aaaaaaaaaaaa', feed: 'nf-aaaaaaaaaaaa', source: 'Local News', title: 'Library opens late on Thursdays', at: AT - 30 * 60_000, link: 'https://example.com/news/library-late-thursdays' },
  { key: 'nh-bbbbbbbbbbbb', feed: 'nf-bbbbbbbbbbbb', source: 'Science Daily', title: 'A comet passes close enough to see from the garden this week', at: AT - 3 * 3600_000, link: 'https://example.org/comet' },
  { key: 'nh-cccccccccccc', feed: 'nf-aaaaaaaaaaaa', source: 'Local News', title: 'Bin collections move to Tuesdays', at: AT - 26 * 3600_000 },
];

function manifest(headlines: readonly object[] = HEADLINES): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 6; d <= 10; d++) days.push({ date: `2026-10-0${d}`.replace('-010', '-10'), shifts: [], events: [] } as unknown as ManifestDay);
  return {
    timezone: 'Europe/London',
    generatedAt: AT,
    window: { from: '2026-10-01', to: '2026-11-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [],
    panels: { news: { headlines } },
  } as unknown as Manifest;
}

const PANEL = { width: 800, height: 480 };

function render(config: Record<string, unknown>, m: Manifest = manifest()): Framebuffer {
  const widget: PlacedEpaperWidget = { type: 'news', x: 0, y: 0, w: 1, h: 1, z: 0, config };
  return renderFreeformEpaper(buildEpaperModel(m), m, [widget], PANEL);
}

function decode(fb: Framebuffer): string | undefined {
  const data = new Uint8ClampedArray(PANEL.width * PANEL.height * 4).fill(255);
  for (let y = 0; y < PANEL.height; y++) {
    for (let x = 0; x < PANEL.width; x++) {
      if (!fb.get(x, y)) continue;
      const at = (y * PANEL.width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  return decodePixels(data, PANEL.width, PANEL.height);
}

describe('news on a panel', () => {
  it('draws the newest headline one at a time with a code that reads back as its link', () => {
    expect(decode(render({ mode: 'one' }))).toBe(HEADLINES[0]?.link);
  });

  it('never turns: the same frame whatever the clock says and whatever the turning is set to', () => {
    const later = { ...manifest(), generatedAt: AT + 10 * 60_000 } as Manifest;
    const bits = (fb: Framebuffer): string => bitString(fb, PANEL.width, PANEL.height);
    const first = bits(render({ mode: 'one' }));
    expect(bits(render({ mode: 'one' }, later))).toBe(first);
    expect(bits(render({ mode: 'one', rotateSeconds: 30 }))).toBe(first);
  });

  it('draws no code when it is switched off, or for a headline with no link, and no code in a list', () => {
    expect(decode(render({ mode: 'one', showQr: false }))).toBeUndefined();
    expect(decode(render({ mode: 'one' }, manifest([HEADLINES[2] as object])))).toBeUndefined();
    expect(decode(render({}))).toBeUndefined();
  });

  it('hashes a link only where a code is drawn, so a list does not refresh when an address changes', () => {
    const list = panelInput('news', manifest(), {});
    expect(JSON.stringify(list)).not.toContain('https://');
    const one = panelInput('news', manifest(), { mode: 'one' });
    expect(JSON.stringify(one)).toContain(HEADLINES[0]?.link);
    const moved = manifest(HEADLINES.map((headline) => ({ ...headline, link: 'https://example.net/elsewhere' })));
    expect(panelInput('news', moved, {})).toEqual(list);
    // Clock times on a panel, never "5 min ago": wrong within the minute.
    expect(JSON.stringify(list)).toContain('"time":"15:30"');
    expect(JSON.stringify(list)).toContain('"time":"Mon"');
  });

  it('shows only the feeds a widget names', () => {
    const named = panelInput('news', manifest(), { newsFeeds: ['nf-bbbbbbbbbbbb'] });
    expect(JSON.stringify(named)).toContain('A comet passes');
    expect(JSON.stringify(named)).not.toContain('Library');
  });

  it('says there are no headlines rather than drawing an empty box', () => {
    const fb = render({}, manifest([]));
    let ink = 0;
    for (let y = 10; y < PANEL.height - 10; y++) for (let x = 10; x < PANEL.width - 10; x++) if (fb.get(x, y)) ink++;
    expect(ink).toBeGreaterThan(0);
  });
});

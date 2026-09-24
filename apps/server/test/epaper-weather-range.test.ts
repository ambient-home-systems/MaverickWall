import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { panelInput, renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { parseOpenMeteo } from '../src/modules/weather/open-meteo.js';

/**
 * The `range` forecast on a panel (plan item P5.1): a row per day, and a black
 * bar from the low to the high on the week's own scale.
 *
 * Verified by decoding the frame, the way every 1-bit claim in this project is
 * — never by looking at it. The bar is found as ink rather than trusted from
 * the draw's arithmetic: a track is the one horizontal run every row shares
 * (it is the whole scale, drawn the same width on every day), and a day's bar
 * is the run on the row directly above its track, inside it. Its ends are then
 * held to where the day's low and high fall on the week, which is the whole
 * claim the style makes and the one a bar drawn from the wrong numbers, or on
 * a per-day scale, would fail.
 *
 * The rest is the ladder's give-up order stated as frame equivalences, the
 * idiom `epaper-weather-widget.test.ts` uses: a box too narrow for the rain
 * chance draws the frame of a forecast with none, one narrower still draws the
 * frame of a forecast with no glyphs either, and the bar and its numbers stay.
 */

const PANEL = { width: 800, height: 480 } as const;
const HERE = dirname(fileURLToPath(import.meta.url));

interface Day {
  name: string;
  high: number | null;
  low: number | null;
  unit: string;
  glyph: string | null;
  summary: string;
  precipChance?: number;
}

const day = (name: string, low: number, high: number, extra: Partial<Day> = {}): Day => ({
  name,
  high,
  low,
  unit: 'C',
  glyph: 'clear',
  summary: 'Sunny',
  ...extra,
});

function manifestOf(days: readonly Day[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 8, 24, 11, 0, 0),
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [{ date: '2026-09-24', shifts: [], events: [] } as unknown as ManifestDay],
    panels: { weather: { provider: 'openmeteo', fetchedAt: 1, note: null, days } },
  } as unknown as Manifest;
}

function frameOf(
  manifest: Manifest,
  config: Record<string, unknown>,
  box: Partial<PlacedEpaperWidget> = {},
): Framebuffer {
  const widget = { type: 'weather', x: 0, y: 0, w: 1, h: 1, z: 0, config, ...box } as PlacedEpaperWidget;
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

/** The frame's packed bits, as one comparable string. */
const bitsOf = (fb: Framebuffer): string => Buffer.from(fb.bits).toString('base64');

interface Run {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
}

/** Every maximal horizontal run of ink at least `min` pixels long. */
function runsOf(fb: Framebuffer, min: number): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < PANEL.height; y++) {
    let start = -1;
    for (let x = 0; x <= PANEL.width; x++) {
      const ink = x < PANEL.width && fb.get(x, y);
      if (ink && start < 0) start = x;
      if (!ink && start >= 0) {
        if (x - start >= min) out.push({ y, x0: start, x1: x - 1 });
        start = -1;
      }
    }
  }
  return out;
}

/**
 * The tracks, top to bottom: the longest run inside the widget, which every
 * row shares because it is the whole scale. (A bar's rows share an extent
 * too, but no bar here is as long as its track; the widget's own outline is
 * longer still and is left out as the frame it is.)
 */
function tracksOf(fb: Framebuffer): Run[] {
  const inside = runsOf(fb, 16).filter((run) => run.y > 0 && run.y < PANEL.height - 1 && run.x0 > 0);
  const longest = Math.max(...inside.map((run) => run.x1 - run.x0));
  return inside.filter((run) => run.x1 - run.x0 === longest);
}

/** A day's bar: the ink on the row above its track, inside the track's extent. */
function barOn(fb: Framebuffer, track: Run): { x0: number; x1: number } | undefined {
  let x0 = -1;
  let x1 = -1;
  for (let x = track.x0; x <= track.x1; x++) {
    if (!fb.get(x, track.y - 1)) continue;
    if (x0 < 0) x0 = x;
    x1 = x;
  }
  return x0 < 0 ? undefined : { x0, x1 };
}

describe('the range look on a panel', () => {
  // A week from 0 to 40 with no day spanning it, so a track is never also a bar.
  const WEEK = [day('Mon', 0, 10), day('Tue', 30, 40), day('Wed', 5, 35), day('Thu', 18, 22)];

  it('draws one track per day, all the same width, and a bar on each at its own place on the week', () => {
    const fb = frameOf(manifestOf(WEEK), { variant: 'range' });
    const tracks = tracksOf(fb);
    expect(tracks, 'one track per day').toHaveLength(WEEK.length);
    const [first] = tracks as [Run];
    const length = first.x1 - first.x0;
    WEEK.forEach((one, i) => {
      const track = tracks[i] as Run;
      const bar = barOn(fb, track);
      expect(bar, `${one.name} drew no bar`).toBeDefined();
      const at = (value: number): number => track.x0 + Math.round((value / 40) * length);
      // Within a pixel: the bar is the day's low to its high on the week's own
      // 0..40 — not on the day's own, which would draw every bar the same.
      expect(Math.abs(bar!.x0 - at(one.low as number)), `${one.name}'s bar starts`).toBeLessThanOrEqual(1);
      expect(Math.abs(bar!.x1 - at(one.high as number)), `${one.name}'s bar ends`).toBeLessThanOrEqual(1);
    });
    // Rows run down the box, a day each, in the forecast's order.
    for (let i = 1; i < tracks.length; i++) expect((tracks[i] as Run).y).toBeGreaterThan((tracks[i - 1] as Run).y);
  });

  it('is not the strip, and is the strip again when the look is taken off', () => {
    const range = bitsOf(frameOf(manifestOf(WEEK), { variant: 'range' }));
    expect(range).not.toBe(bitsOf(frameOf(manifestOf(WEEK), {})));
    expect(bitsOf(frameOf(manifestOf(WEEK), { variant: 'strip' }))).toBe(bitsOf(frameOf(manifestOf(WEEK), {})));
  });

  it('draws a real forecast — the captured London answer — a bar a day on one scale', () => {
    const body = readFileSync(join(HERE, 'fixtures', 'open-meteo', 'real', 'forecast-london-metric.json'), 'utf8');
    const forecast = parseOpenMeteo(body, { now: Date.UTC(2026, 8, 24, 12), units: 'metric', todayIso: '2026-09-24', limit: 5 }).forecast;
    expect(forecast?.days.length).toBe(5);
    const days = forecast!.days as unknown as Day[];
    const fb = frameOf(manifestOf(days), { variant: 'range' });
    const tracks = tracksOf(fb);
    expect(tracks).toHaveLength(5);
    const lows = days.map((d) => d.low as number);
    const highs = days.map((d) => d.high as number);
    const min = Math.min(...lows, ...highs);
    const max = Math.max(...lows, ...highs);
    const coldest = lows.indexOf(min);
    const warmest = highs.indexOf(max);
    // The coldest low starts at the track's left and the warmest high ends at its right.
    expect(barOn(fb, tracks[coldest] as Run)!.x0).toBeLessThanOrEqual((tracks[coldest] as Run).x0 + 1);
    expect(barOn(fb, tracks[warmest] as Run)!.x1).toBeGreaterThanOrEqual((tracks[warmest] as Run).x1 - 1);
  });

  it('gives up the rain chance first, then the glyph, and keeps the bar and its numbers', () => {
    const rainy = WEEK.map((one, i) => ({ ...one, precipChance: [10, 40, 80, 0][i] as number }));
    const noRain = WEEK;
    const bare = WEEK.map((one) => ({ ...one, glyph: null }));
    const drawn = new Map<string, string>();
    const at = (days: readonly Day[], w: number): string => {
      const key = `${days === rainy ? 'r' : days === bare ? 'b' : 'n'}${w}`;
      if (!drawn.has(key)) drawn.set(key, bitsOf(frameOf(manifestOf(days), { variant: 'range' }, { w })));
      return drawn.get(key) as string;
    };

    // Wide: the rain chance is drawn — the frame is not the one without it.
    expect(at(rainy, 1)).not.toBe(at(noRain, 1));
    // Narrowing the box a hundredth of the panel at a time, the first width
    // that gives something up gives up the rain chance and keeps the glyph;
    // the glyph goes only at a narrower one. Never the other way round.
    const widths = Array.from({ length: 50 }, (_, i) => Math.round((0.6 - i * 0.01) * 100) / 100);
    const noRainRoom = widths.find((w) => at(rainy, w) === at(noRain, w));
    expect(noRainRoom, 'no width gave up the rain chance').toBeDefined();
    expect(at(noRain, noRainRoom!), 'the glyph went with the rain chance').not.toBe(at(bare, noRainRoom!));
    const bareRoom = widths.find((w) => at(noRain, w) === at(bare, w));
    expect(bareRoom, 'no width gave up the glyph').toBeDefined();
    expect(bareRoom!).toBeLessThan(noRainRoom!);
    expect(tracksOf(frameOf(manifestOf(bare), { variant: 'range' }, { w: bareRoom! }))).toHaveLength(WEEK.length);
  });

  it('gives up days from the bottom in a short box', () => {
    const tall = tracksOf(frameOf(manifestOf(WEEK), { variant: 'range' }));
    const short = tracksOf(frameOf(manifestOf(WEEK), { variant: 'range' }, { h: 0.2 }));
    expect(tall).toHaveLength(4);
    expect(short.length).toBeGreaterThanOrEqual(1);
    expect(short.length).toBeLessThan(tall.length);
    // The rows it kept are the first days, at the top.
    expect((short[0] as Run).y).toBeLessThan((tall[1] as Run).y);
  });
});

describe('what a range frame reads, and what a strip frame does not (P3.5)', () => {
  it('hands the range draw its numbers and rain chance, and the strip neither', () => {
    const manifest = manifestOf([day('Mon', 9, 18, { precipChance: 40 })]);
    const range = panelInput('weather', manifest, { variant: 'range' });
    const strip = panelInput('weather', manifest, {});
    const colour = panelInput('weather', manifest, { variant: 'colour' });
    expect(range).toMatchObject({ kind: 'weather', days: [{ lowValue: 9, highValue: 18, precipChance: 40 }] });
    // A strip's input — and a colour look's, which a panel draws as the strip —
    // carries nothing the strip does not draw, so a revised rain chance cannot
    // move its frame's ETag.
    expect(JSON.stringify(strip)).not.toMatch(/precipChance|lowValue|highValue/);
    expect(colour).toEqual(strip);
  });
});

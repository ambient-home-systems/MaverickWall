import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { epaperCurrent, panelInput, renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { panelMetrics } from '../src/epaper/metrics.js';
import { parseOpenMeteo } from '../src/modules/weather/open-meteo.js';

/**
 * The `today` forecast on a panel (plan item P5.1): the large reading with the
 * time it was read, and today's high and low under it — a one-bit version of
 * the wall's card, with no sky.
 *
 * Verified by decoding the frame, the way every 1-bit claim here is. Reading
 * words back out of a bitmap would be a second renderer, so what is asserted
 * is what each part of the claim *does* to the ink:
 *
 *  1. **The stamp is drawn.** A reading taken fifteen minutes later at the same
 *     temperature moves the frame — only the time changed, so the time is on
 *     the glass — and it does in every box that draws a reading at all,
 *     including the one too short for a lede over its stamp. A battery panel's
 *     "19C" is never drawn without its time (P3.5).
 *  2. **The lede is large**: its ink is taller than the panel's body type, in a
 *     box with room for it.
 *  3. **Its size is the box's, not the reading's**: "9C" and "19C" draw figures
 *     of one height, so a new reading moves ink inside a rectangle and moves no
 *     rectangle — the refresh contract in `epaper/render.ts`.
 *  4. **With no reading it falls back to today's high and low**, and moves for a
 *     change to the day's high where the reading's time no longer reaches it.
 *
 * The forecast is the captured London answer, read through the provider's own
 * parser, and the panel is the size S14's range file draws on.
 */

const PANEL = { width: 800, height: 480 } as const;
const HERE = dirname(fileURLToPath(import.meta.url));
const LONDON = readFileSync(join(HERE, 'fixtures', 'open-meteo', 'real', 'forecast-london-metric.json'), 'utf8');
const MINUTE = 60_000;

const PARTS = parseOpenMeteo(LONDON, { now: Date.UTC(2026, 8, 24, 12, 40), units: 'metric', todayIso: '2026-09-24', limit: 5 });

function manifestOf(options: { temp?: number; observedAt?: number; current?: boolean; high?: number } = {}): Manifest {
  const days = PARTS.forecast!.days.map((day, i) =>
    i === 0 && options.high !== undefined ? { ...day, high: options.high } : day,
  );
  const reading = PARTS.current!;
  const current = {
    ...reading,
    temp: options.temp ?? reading.temp,
    observedAt: options.observedAt ?? reading.observedAt,
    source: 'modelled',
  };
  return {
    timezone: 'Europe/London',
    generatedAt: Date.UTC(2026, 8, 24, 12, 40),
    window: { from: '2026-09-01', to: '2026-10-31' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [{ date: '2026-09-24', shifts: [], events: [] } as unknown as ManifestDay],
    panels: {
      weather: {
        provider: 'openmeteo',
        fetchedAt: 1,
        note: null,
        days,
        ...(options.current === false ? {} : { current }),
        units: { temp: 'C', wind: 'km/h', precip: 'mm' },
      },
    },
  } as unknown as Manifest;
}

function frameOf(manifest: Manifest, config: Record<string, unknown>, box: Partial<PlacedEpaperWidget> = {}): Framebuffer {
  const widget = { type: 'weather', x: 0, y: 0, w: 1, h: 1, z: 0, config, ...box } as PlacedEpaperWidget;
  return renderFreeformEpaper(buildEpaperModel(manifest), manifest, [widget], PANEL);
}

const bitsOf = (fb: Framebuffer): string => Buffer.from(fb.bits).toString('base64');
const TODAY = { variant: 'today' } as const;

/**
 * The inked rows inside the widget's frame, top to bottom, as bands: runs of
 * rows with ink in them, separated by at least one empty row. The widget's own
 * outline (the first and last rows and columns with ink the whole way) is left
 * out as the frame it is.
 */
function bandsOf(fb: Framebuffer, inset = 3, right: number = PANEL.width): { top: number; bottom: number }[] {
  const bands: { top: number; bottom: number }[] = [];
  let open = -1;
  for (let y = inset; y < PANEL.height - inset; y++) {
    let ink = false;
    for (let x = inset; x < right - inset && !ink; x++) ink = fb.get(x, y);
    if (ink && open < 0) open = y;
    if (!ink && open >= 0) {
      bands.push({ top: open, bottom: y - 1 });
      open = -1;
    }
  }
  if (open >= 0) bands.push({ top: open, bottom: PANEL.height - inset - 1 });
  return bands;
}

describe('the reading and its time', () => {
  const at = PARTS.current!.observedAt;

  it('reads the captured reading, stamped in the household’s own zone and clock', () => {
    // The premise: the capture's reading is "19C at 13:30" in London.
    expect(epaperCurrent(manifestOf().panels['weather'], 'Europe/London', true)?.text).toBe('19C at 13:30');
    const input = panelInput('weather', manifestOf(), TODAY);
    expect(input.kind === 'weather' ? input.current?.text : undefined).toBe('19C at 13:30');
  });

  it('draws the stamp: the same temperature fifteen minutes later is a different frame', () => {
    const now = frameOf(manifestOf(), TODAY);
    const later = frameOf(manifestOf({ observedAt: at + 15 * MINUTE }), TODAY);
    expect(bitsOf(later)).not.toBe(bitsOf(now));
    // …and the strip, which draws no reading, is the same frame either way.
    expect(bitsOf(frameOf(manifestOf({ observedAt: at + 15 * MINUTE }), {}))).toBe(bitsOf(frameOf(manifestOf(), {})));
  });

  it('keeps the stamp in a box too short for a lede over it, on one line', () => {
    // A box one body line tall: no room for a large reading and its stamp.
    const m = panelMetrics(PANEL);
    const h = (m.body.height + 2 * m.widget.inset + 6) / PANEL.height;
    const short = { h };
    const now = frameOf(manifestOf(), TODAY, short);
    const later = frameOf(manifestOf({ observedAt: at + 15 * MINUTE }), TODAY, short);
    expect(bitsOf(later), 'the one-line form dropped the time').not.toBe(bitsOf(now));
    // One line of body type, and nothing larger.
    const bands = bandsOf(now).filter((band) => band.bottom < h * PANEL.height - 2);
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) expect(band.bottom - band.top + 1).toBeLessThanOrEqual(m.body.height);
  });
});

describe('the lede', () => {
  it('is large in a box with room, and its lines are body type under it', () => {
    const m = panelMetrics(PANEL);
    const bands = bandsOf(frameOf(manifestOf(), TODAY));
    expect(bands.length, JSON.stringify(bands)).toBeGreaterThanOrEqual(3);
    const lede = bands[0]!;
    expect(lede.bottom - lede.top + 1, 'the reading is no larger than body type').toBeGreaterThan(2 * m.body.height);
    // The stamp and the range: each a line of body type, under the lede.
    for (const line of bands.slice(1)) {
      expect(line.top).toBeGreaterThan(lede.bottom);
      expect(line.bottom - line.top + 1).toBeLessThanOrEqual(m.body.height);
    }
  });

  it('is the box’s size and not the reading’s: 9C and 19C draw figures of one height', () => {
    /*
     * In a narrow box, where the width is what binds. A lede fitted to its own
     * words would draw "9C" a rung taller than "19C" there — a rectangle that
     * moves because the temperature fell a degree. In a full-panel box the
     * height binds first and a lede fitted to its words draws the same size
     * anyway, so that box cannot tell the two apart; the first draft of this
     * assertion used it and stayed green with the fix reverted.
     */
    const narrow = { w: 0.2, h: 0.6 };
    const tall = (temp: number, box: Partial<PlacedEpaperWidget> = narrow): number => {
      // Inside the widget's own outline, which runs the full height of a
      // narrow box and would read as one band from top to bottom.
      const right = Math.round((box.w ?? 1) * PANEL.width);
      const band = bandsOf(frameOf(manifestOf({ temp }), TODAY, box), 3, right)[0]!;
      return band.bottom - band.top;
    };
    // The premise: the width binds in the narrow box, so its lede is smaller.
    expect(tall(19)).toBeLessThan(tall(19, {}));
    expect(tall(9)).toBe(tall(19));
    expect(tall(-12)).toBe(tall(19));
  });

  it('is not the strip, and not the range', () => {
    const today = bitsOf(frameOf(manifestOf(), TODAY));
    expect(today).not.toBe(bitsOf(frameOf(manifestOf(), {})));
    expect(today).not.toBe(bitsOf(frameOf(manifestOf(), { variant: 'range' })));
  });
});

describe('with no reading to call now', () => {
  it('draws today’s high and low as the lede, and no stamp at all', () => {
    const none = manifestOf({ current: false });
    const input = panelInput('weather', none, TODAY);
    expect(input.kind === 'weather' ? input.current : 'not weather').toBeUndefined();
    const frame = frameOf(none, TODAY);
    expect(bitsOf(frame)).not.toBe(bitsOf(frameOf(manifestOf(), TODAY)));
    // The lede is large here too.
    const band = bandsOf(frame)[0]!;
    expect(band.bottom - band.top + 1).toBeGreaterThan(2 * panelMetrics(PANEL).body.height);
    // It is today's high on the glass: a warmer day is a different frame.
    expect(bitsOf(frameOf(manifestOf({ current: false, high: 27.4 }), TODAY))).not.toBe(bitsOf(frame));
  });

  it('draws nothing it cannot say with no forecast either', () => {
    const empty = { ...manifestOf({ current: false }), panels: {} } as unknown as Manifest;
    const frame = frameOf(empty, TODAY);
    // "No weather yet", the strip's own sentence, and nothing larger.
    const bands = bandsOf(frame);
    expect(bands.length).toBe(1);
    expect(bands[0]!.bottom - bands[0]!.top + 1).toBeLessThanOrEqual(panelMetrics(PANEL).body.height);
  });
});

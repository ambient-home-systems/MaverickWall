import { describe, expect, it } from 'vitest';

import { haReadingHandle, type Manifest } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { panelInput, renderFreeformEpaper } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { bitString } from './epaper-frame.js';

/**
 * The status card (plan item M6.8) and the day's line (plan item M6.10) on a
 * one-bit panel, asked by decoding frames.
 *
 *  - A card draws its subject, the progress the reading says, and a doubled
 *    edge once it says the finished words — each a change of ink — and never
 *    the subject's own picture, which a panel does not draw (MQ11).
 *  - A day is drawn as ink inside its own rectangle and nowhere else, and two
 *    days in the same box move only that rectangle's ink — the refresh
 *    contract, which a line that changes twice an hour leans on.
 *  - A panel's frame input carries a reading's day only where its widget draws
 *    the line, and a card's picture never, so neither refreshes a panel that
 *    does not draw it.
 */

const TODAY = '2026-08-22';
const W = 800;
const H = 480;

const day = (shift: number): (number | null)[] =>
  Array.from({ length: 48 }, (_, i) => (i === 20 ? null : 18 + 3 * Math.sin((i + shift) / 6)));

const WASHER = haReadingHandle('sensor.washer_status');
const PROGRESS = haReadingHandle('sensor.washer_progress');

function house(series = day(0)): Record<string, unknown>[] {
  return [
    { key: WASHER, label: 'Washer', value: 'Running', unit: null, glyph: 'power', mode: 'label_value', stale: false, tone: 'active', changedAt: null, picture: `${'ab'.repeat(32)}.jpg` },
    { key: PROGRESS, label: 'Washer progress', value: '45', unit: '%', mode: 'label_value', stale: false, tone: null, changedAt: null },
    { key: haReadingHandle('sensor.kitchen'), label: 'Kitchen', value: '19.4', unit: 'C', glyph: 'temperature', mode: 'label_value', stale: false, tone: null, changedAt: null, series },
    { key: haReadingHandle('binary_sensor.door'), label: 'Front door', value: 'Closed', unit: null, glyph: 'door', mode: 'label_value', stale: false, tone: null, changedAt: null },
  ];
}

function manifestOf(readings: readonly Record<string, unknown>[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days: [{ date: TODAY, shifts: [], events: [] }],
    sources: [],
    panels: { home: { readings, note: null } },
  } as unknown as Manifest;
}

function frame(config: Record<string, unknown>, readings = house()): string {
  const manifest = manifestOf(readings);
  const fb: Framebuffer = renderFreeformEpaper(
    buildEpaperModel(manifest),
    manifest,
    [{ type: 'homeassistant', x: 0, y: 0, w: 1, h: 1, z: 0, config }],
    { width: W, height: H },
  );
  return bitString(fb, W, H);
}

/** The rows and columns where two frames differ, as a bounding rectangle — or nothing. */
function diffBox(a: string, b: string): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    box = box === undefined
      ? { x0: x, y0: y, x1: x, y1: y }
      : { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
  }
  return box;
}

const CARD = {
  variant: 'status',
  subject: 'sensor.washer_status',
  progress: 'sensor.washer_progress',
  readings: ['sensor.kitchen', 'binary_sensor.door'],
};

describe('the status card on a panel', () => {
  it('draws its subject, its progress and a doubled edge once finished, each moving ink', () => {
    const card = frame(CARD);
    expect(card).toContain('1');
    // Another subject is another card.
    expect(frame({ ...CARD, subject: 'sensor.kitchen' })).not.toBe(card);
    // No progress reading, and a subject with no level of its own: no bar.
    expect(frame({ ...CARD, progress: undefined })).not.toBe(card);
    // Finished: the edge doubled and the disc ringed.
    const done = frame({ ...CARD, doneState: 'running' });
    expect(done).not.toBe(card);
    // The words compared without their capitals, and words it does not say are not finished.
    expect(frame({ ...CARD, doneState: 'RUNNING' })).toBe(done);
    expect(frame({ ...CARD, doneState: 'Complete' })).toBe(card);
  });

  it('draws the doubled edge just inside the card’s own outline', () => {
    const card = frame(CARD);
    const done = frame({ ...CARD, doneState: 'running' });
    // The card's top edge: the first row inked solid across the middle, past
    // row 0, which is the panel's own frame round the widget.
    const span = (bits: string, y: number): string => bits.slice(y * W + 300, y * W + 500);
    const top = Array.from({ length: H }, (_, y) => y).find((y) => y > 1 && !span(card, y).includes('0'));
    expect(top).toBeDefined();
    // The row under it: the second edge, which an unfinished card leaves white.
    expect(span(done, (top as number) + 1)).not.toContain('0');
    expect(span(card, (top as number) + 1)).not.toContain('1');
  });

  it('never draws the subject’s own picture: the switch moves no ink', () => {
    expect(frame({ ...CARD, subjectPicture: true })).toBe(frame(CARD));
  });
});

describe('the day’s line on a panel', () => {
  it('draws a day on every look, inside its own rectangle, and two days move only that rectangle', () => {
    for (const look of [{ readings: ['sensor.kitchen'] }, { variant: 'tile', readings: ['sensor.kitchen'] }, { ...CARD, subject: 'sensor.kitchen' }]) {
      const plain = frame(look);
      const lined = frame({ ...look, sparkline: true });
      expect(lined, JSON.stringify(look)).not.toBe(plain);
      const a = frame({ ...look, sparkline: true }, house(day(0)));
      const b = frame({ ...look, sparkline: true }, house(day(9)));
      const changed = diffBox(a, b);
      expect(changed, JSON.stringify(look)).toBeDefined();
      // Only the line moved: everything outside the rectangle the two days
      // share is one frame.
      const region = changed as NonNullable<typeof changed>;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1) continue;
          if (a[y * W + x] !== b[y * W + x]) throw new Error(`ink moved outside the line at ${x},${y}`);
        }
      }
      // And that rectangle is a line's, not the box's: well under the frame.
      expect((region.x1 - region.x0 + 1) * (region.y1 - region.y0 + 1)).toBeLessThan((W * H) / 4);
    }
  });

  it('leaves the rectangle white for a reading with no day, at the same size', () => {
    const none = house().map((r) => (r['label'] === 'Kitchen' ? { ...r, series: undefined } : r));
    const lined = frame({ readings: ['sensor.kitchen'], sparkline: true }, none);
    // No day is no line, and the words are where they were with one.
    expect(lined).toBe(frame({ readings: ['sensor.kitchen'], sparkline: true }, house(new Array(48).fill(null))));
  });
});

describe('what a panel’s frame is keyed on', () => {
  const panels = (readings: readonly Record<string, unknown>[]) => manifestOf(readings);

  it('carries a reading’s day only where its widget draws the line, and a card’s picture never', () => {
    const a = JSON.stringify(panelInput('homeassistant', panels(house(day(0))), {}));
    const b = JSON.stringify(panelInput('homeassistant', panels(house(day(9))), {}));
    expect(a).toBe(b);
    expect(a).not.toContain('series');
    expect(a).not.toContain('picture');
    const lined = (series: (number | null)[]) =>
      JSON.stringify(panelInput('homeassistant', panels(house(series)), { sparkline: true }));
    expect(lined(day(0))).not.toBe(lined(day(9)));
    expect(JSON.stringify(panelInput('homeassistant', panels(house()), { variant: 'status', subjectPicture: true }))).not.toContain('picture');
  });
});

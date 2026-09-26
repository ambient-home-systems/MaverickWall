import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import type { RegionLog } from '../src/epaper/render.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { panelMetrics } from '../src/epaper/metrics.js';

/**
 * The rota on a panel's calendar widget, in one bit (plan item P5.4).
 *
 * The wall has four looks for a rota and three of them are colour. What one
 * bit can say is the shift's short code, so the panel draws that beside the
 * day number whichever look the widget wears — and the plan asked for one
 * thing to be *decided by rendering*: whether a 7.5" cell can hold it at all.
 * So every assertion here is a decoded frame: ink inside the rectangle the
 * renderer logged for the codes, none where a day has no rota, none where the
 * cell has no room for the codes whole, and a rectangle that is a function of
 * the cell rather than of the words in it, which is the refresh contract.
 *
 * `epaper-ink.test.ts` holds the tables — `showShifts` moves ink and
 * `shiftStyle` does not — by probing; this file says what the ink is.
 */

const PANEL = { width: 800, height: 480 } as const;
const TODAY = '2026-08-22';

interface Person {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly label: string;
}
const AMY: Person = { id: 'p1', name: 'Amy', code: 'D', label: 'Days' };
const BEN: Person = { id: 'p2', name: 'Ben', code: 'N', label: 'Nights' };

function shiftOf(person: Person): ManifestDay['shifts'][number] {
  return {
    key: person.label.toLowerCase(), label: person.label, shortCode: person.code, colorToken: '--s-day',
    isWorking: true, source: 'pattern', personId: person.id, personName: person.name,
    personColor: '#000', personAvatarUrl: null,
  } as unknown as ManifestDay['shifts'][number];
}

/**
 * A fortnight: the 22nd (today) with two people, the 23rd with one, the 24th
 * with nobody on a rota, and the 25th with two again — so one grid holds every
 * case a cell can be in.
 */
function manifest(rota: Readonly<Record<string, readonly Person[]>> = { '2026-08-22': [AMY, BEN], '2026-08-23': [AMY], '2026-08-25': [AMY, BEN] }): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 21; d <= 31; d++) {
    const date = `2026-08-${d}`;
    days.push({
      date,
      shifts: (rota[date] ?? []).map(shiftOf),
      events: [],
    } as unknown as ManifestDay);
  }
  return {
    manifestVersion: 1,
    appVersion: 'test',
    generatedAt: Date.UTC(2026, 7, 22, 10),
    timezone: 'UTC',
    theme: { active: 'panels' },
    window: { from: '2026-08-21', to: '2026-09-30' },
    days,
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'sunday' },
    people: [],
    sources: [],
    notices: [],
    interrupts: [],
  } as unknown as Manifest;
}

interface Drawn {
  readonly fb: Framebuffer;
  readonly regions: RegionLog;
}

/** One calendar widget on the panel, this wide, with this config. */
function draw(config: Record<string, unknown>, m: Manifest = manifest(), w = 1): Drawn {
  const widget: PlacedEpaperWidget = { type: 'calendar', x: 0, y: 0, w, h: 1, z: 0, config };
  const regions: RegionLog = [];
  const fb = renderFreeformEpaper(buildEpaperModel(m), m, [widget], PANEL, regions);
  return { fb, regions };
}

const bits = (fb: Framebuffer): string => {
  let out = '';
  for (let y = 0; y < PANEL.height; y++) for (let x = 0; x < PANEL.width; x++) out += fb.get(x, y) ? '1' : '0';
  return out;
};

/** Lit pixels inside a logged rectangle. */
function inkIn(fb: Framebuffer, region: { x: number; y: number; w: number; h: number }): number {
  let lit = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) if (fb.get(x, y)) lit++;
  }
  return lit;
}

/** The month cell and the codes' rectangle for a date, from the region log. */
function cellOf(drawn: Drawn, date: string): { cell: RegionLog[number]; codes: RegionLog[number] | undefined } {
  const model = buildEpaperModel(manifest());
  let at = '';
  model.weeks.forEach((week, r) => week.forEach((item, c) => { if (item.date === date) at = `${r}:${c}`; }));
  if (at === '') throw new Error(`${date} is not on the grid`);
  const cell = drawn.regions.find((region) => region.name === `cell:${at}`);
  if (cell === undefined) throw new Error(`no cell region for ${date}`);
  return { cell, codes: drawn.regions.find((region) => region.name === `cell-shift:${at}`) };
}

describe('the rota on a panel’s month grid', () => {
  const m = panelMetrics(PANEL);

  it('draws one person’s code beside the day number, and nothing beside a day with no rota', () => {
    const drawn = draw({ mode: 'month' });
    const one = cellOf(drawn, '2026-08-23');
    expect(one.codes, 'no rectangle was logged for the codes').toBeDefined();
    // Inside the cell, to the right of the widest number the grid can draw, on
    // the number's own line — and it has ink in it.
    const codes = one.codes!;
    expect(codes.x).toBeGreaterThan(one.cell.x + m.cellNumberInset);
    expect(codes.x + codes.w).toBeLessThanOrEqual(one.cell.x + one.cell.w);
    expect(codes.y).toBeGreaterThanOrEqual(one.cell.y);
    expect(codes.y + codes.h).toBeLessThanOrEqual(one.cell.y + m.cellNumberInset + m.small.height * 3);
    expect(inkIn(drawn.fb, codes), 'a rota day’s codes rectangle carries no ink').toBeGreaterThan(8);

    const none = cellOf(drawn, '2026-08-24');
    expect(none.codes).toBeDefined();
    expect(inkIn(drawn.fb, none.codes!), 'a day with no rota has ink where its codes would be').toBe(0);
  });

  it('draws two people by initial where the cell has room, and nothing at all where it has not', () => {
    // A month filling the panel: 114px cells, room for "A:D B:N" whole.
    const wide = draw({ mode: 'month' });
    const two = cellOf(wide, '2026-08-25');
    expect(inkIn(wide.fb, two.codes!)).toBeGreaterThan(inkIn(wide.fb, cellOf(wide, '2026-08-23').codes!));

    /*
     * The 7.5" decision, by rendering. The panel's built-in layout gives its
     * month 0.46 of a landscape panel (`panel-built-in.ts`), which is a 52px
     * cell at 800x480: the room beside a two-digit number holds "D" and not
     * "D N", so one person is drawn and two are drawn whole or not at all —
     * not at all. The rectangle is still logged, at the same place, empty.
     */
    const narrow = draw({ mode: 'month' }, manifest(), 0.46);
    const one = cellOf(narrow, '2026-08-23');
    expect(inkIn(narrow.fb, one.codes!), 'a 7.5" cell could not hold one code').toBeGreaterThan(4);
    const both = cellOf(narrow, '2026-08-25');
    expect(inkIn(narrow.fb, both.codes!), 'a 7.5" cell drew two people’s codes cut').toBe(0);
    expect(both.codes!.w).toBeGreaterThan(0);
  });

  it('knocks the codes out of today’s filled cell, as it does the number', () => {
    const drawn = draw({ mode: 'month' });
    const today = cellOf(drawn, '2026-08-22');
    // Today's cell is solid ink; its codes are the holes in it.
    const rect = today.codes!;
    expect(inkIn(drawn.fb, rect)).toBeLessThan(rect.w * rect.h);
    const without = draw({ mode: 'month', showShifts: false });
    expect(inkIn(without.fb, rect)).toBe(rect.w * rect.h);
  });

  it('is switched off by the same key the wall reads, and nothing else', () => {
    const on = bits(draw({ mode: 'month' }).fb);
    const off = bits(draw({ mode: 'month', showShifts: false }).fb);
    expect(off).not.toBe(on);
    // No rota at all draws exactly the frame the switch turns off — the codes
    // are the only thing the switch decides.
    expect(bits(draw({ mode: 'month' }, manifest({})).fb)).toBe(off);
    // And every look draws the code, because three of the four are colour.
    for (const look of ['tint', 'label', 'edge', 'dot']) {
      expect(bits(draw({ mode: 'month', shiftStyle: look }).fb), look).toBe(on);
    }
  });

  it('logs the codes’ rectangle as a function of the cell, never of the words', () => {
    // The refresh contract: two frames whose codes differ draw them into the
    // same rectangles. Longer codes, more people, a rota where there was none.
    const a = draw({ mode: 'month' });
    const b = draw(
      { mode: 'month' },
      manifest({
        '2026-08-22': [AMY],
        '2026-08-23': [{ ...BEN, code: 'OC' }, AMY],
        '2026-08-24': [AMY, BEN],
      }),
    );
    const rects = (drawn: Drawn): string[] =>
      drawn.regions.filter((region) => region.name.startsWith('cell-shift:')).map((region) => JSON.stringify(region));
    expect(rects(a).length).toBe(35);
    expect(rects(b)).toEqual(rects(a));
    expect(bits(a.fb)).not.toBe(bits(b.fb));
  });
});

describe('the rota on a panel’s week strip', () => {
  it('draws the codes only when told to, as the wall does (Q2)', () => {
    const off = bits(draw({ mode: 'week' }).fb);
    // An absent switch is off on a week: the frame a week panel drew before.
    expect(bits(draw({ mode: 'week' }, manifest({})).fb)).toBe(off);
    expect(bits(draw({ mode: 'week', showShifts: false }).fb)).toBe(off);
    const on = bits(draw({ mode: 'week', showShifts: true }).fb);
    expect(on).not.toBe(off);
    for (const look of ['label', 'edge', 'dot']) {
      expect(bits(draw({ mode: 'week', showShifts: true, shiftStyle: look }).fb), look).toBe(on);
    }
  });
});

import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import {
  MAX_AGENDA_ROWS,
  MAX_CELL_TITLES,
  agendaRowsInBox,
  cellTitlesInBox,
  gridMetrics,
  panelMetrics,
  type EpaperMetrics,
} from '../src/epaper/metrics.js';
import { epaperBlocks, renderEpaper } from '../src/epaper/render.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The frame fills the panel it is drawn on, at every size a household can pair.
 *
 * The whole eInk layout used to be absolute pixels tuned by looking at one
 * 800×480 Seeed panel — `MARGIN = 16`, `HEADER_H = 54`, `rowH = 34`,
 * `EPAPER_TODAY_LIMIT = 6`. Measured across the supported range with thirty
 * days of events on it, that renderer stopped drawing halfway down a 13.3"
 * panel and left the bottom half white:
 *
 *   640×384    blank bottom   69 px (18%)   6 agenda rows
 *   800×480    blank bottom  140 px (29%)   6 agenda rows
 *   1304×984   blank bottom  479 px (49%)   6 agenda rows
 *   1872×1404  blank bottom  714 px (51%)   6 agenda rows
 *
 * Six rows on every panel in a 3.7× range is the shape of it: an honest
 * measurement of one panel applied to all of them.
 *
 * Two things are asserted here and they pull against each other on purpose.
 * The range must fill (`blank bottom ≤ 4%`, and *whatever is on the calendar*,
 * because a household with a quiet Tuesday still owns the whole panel), and
 * 800×480 — the one size anybody has ever looked at output from — must come
 * back to the values it was tuned to. The second is the stronger assertion:
 * if a derivation cannot reproduce the shipped constant at 480px of panel, the
 * derivation is wrong and the constant was right.
 */

const OUT_OF_THE_BOX = { width: 800, height: 480 } as const;

/** The landscape split, `round(width × 0.54)` — where the agenda column ends. */
const SPLIT_800 = 432;

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e', uid: 'e', title: 'Event', startsAt: 0, endsAt: 0, allDay: false,
    sourceId: 'home', color: '#000', status: 'confirmed', continues: false, ...over,
  };
}

const TITLES = [
  'Bin day', 'Dentist', 'Football training', 'Book club',
  'Piano lesson', 'Swimming', 'Parents evening', 'Delivery',
];

/**
 * Thirty days of events — the fixture the table above was measured with.
 *
 * Today carries twenty of them so the *box* is what decides how many rows are
 * drawn rather than the household's density or the day running out of events.
 * `todayEvents: 24` says the same thing from the other side: this household has
 * not asked for fewer than the panel can hold.
 */
function busyMonth(): ManifestDay[] {
  const days: ManifestDay[] = [];
  for (let i = 0; i < 30; i++) {
    const date = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
    const count = date === '2026-08-13' ? 20 : (i % 4) + 1;
    const events: ManifestEvent[] = [];
    for (let e = 0; e < count; e++) {
      events.push(
        ev({
          title: TITLES[(i + e) % TITLES.length]!,
          allDay: e === 0 && i % 3 === 0,
          startsAt: Date.UTC(2026, 7, 1 + i, 6 + (e % 14), 30),
        }),
      );
    }
    days.push({ date, shifts: [], events });
  }
  return days;
}

/** A quiet Tuesday: the fixture the rest of the eInk tests draw with. */
const quietDay: ManifestDay = {
  date: '2026-08-13',
  shifts: [],
  events: [
    ev({ title: 'Bin day', allDay: true }),
    ev({ title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0) }),
  ],
};

function manifestOf(days: ManifestDay[], todayEvents = 8): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

const busy = manifestOf(busyMonth(), 24);
const quiet = manifestOf([quietDay]);

function frameAt(manifest: Manifest, width: number, height: number): Framebuffer {
  return renderEpaper(buildEpaperModel(manifest), { width, height });
}

/** The last row of the raster with any ink on it; -1 for a blank frame. */
function lastInkedRow(fb: Framebuffer): number {
  for (let y = fb.height - 1; y >= 0; y--) {
    for (let x = 0; x < fb.width; x++) if (fb.get(x, y)) return y;
  }
  return -1;
}

/** Ink pixels in a rectangle. */
function inkIn(fb: Framebuffer, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (fb.get(x, y)) n++;
  return n;
}

/** How much of the panel below the last ink is white, as a fraction of its height. */
function blankBottom(fb: Framebuffer): number {
  return (fb.height - 1 - lastInkedRow(fb)) / fb.height;
}

/**
 * How many agenda rows were actually *drawn*, counted from ink rather than
 * from the arithmetic that chose them.
 *
 * Every row starts with a bullet at the agenda box's own left edge — an open
 * square for an all-day entry, a filled one for a timed one — and nothing else
 * in the column touches that edge, because times and titles start 20px in. So a
 * run of ink down that one pixel column, a bullet tall, is a row. The length
 * window is what keeps the month grid's vertical borders out of the count: they
 * run the height of the grid, not the height of a bullet.
 */
function agendaRowsDrawn(fb: Framebuffer, left: number, bullet: number): number {
  let rows = 0;
  let run = 0;
  const isBullet = (length: number): boolean => length >= bullet - 2 && length <= bullet + 2;
  for (let y = 0; y < fb.height; y++) {
    if (fb.get(left, y)) run++;
    else {
      if (isBullet(run)) rows++;
      run = 0;
    }
  }
  if (isBullet(run)) rows++;
  return rows;
}

/**
 * The rows of the raster that are a full-width rule of the month grid.
 *
 * A grid cell is a `strokeRect`, so every cell boundary draws right across the
 * grid — which makes a row that is almost entirely ink between two x bounds a
 * horizontal rule, and the gaps between those rules the cell height. Today's
 * cell is filled solid, but only one cell wide, so it never reaches the bar.
 *
 * Consecutive hits collapse to one rule, because two neighbouring cells each
 * stroke their own edge and a boundary is therefore *two* inked rows. Left
 * uncollapsed the gaps run 1, 186, 1, 186 and the commonest one is 1 — which
 * reads as a cell a pixel tall and passed the squareness check by tying with
 * itself on the panel that happened to have an odd number of cells.
 */
function fullRuns(
  fb: Framebuffer,
  from: number,
  to: number,
  span: readonly [number, number],
  along: 'rows' | 'columns',
): number[] {
  const [lo, hi] = span;
  const width = hi - lo;
  const hits: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = from; i < to; i++) {
    let ink = 0;
    for (let j = lo; j < hi; j++) if (along === 'rows' ? fb.get(j, i) : fb.get(i, j)) ink++;
    if (ink < width * 0.9) continue;
    if (i !== previous + 1) hits.push(i);
    previous = i;
  }
  return hits;
}

/** The commonest gap between consecutive hits — one cell. */
function step(hits: readonly number[]): number {
  const gaps = new Map<number, number>();
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i]! - hits[i - 1]!;
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  let best = 0;
  let seen = 0;
  for (const [gap, count] of gaps) if (count > seen) [best, seen] = [gap, count];
  return best;
}

/**
 * The six sizes: the range's ends and its two commonest panels, each in the
 * orientation a household hangs it in. 640×384 and 1872×1404 are the smallest
 * and largest panels RFC 006 supports; a quarter turn makes the same hardware
 * 384×640 and 1404×1872, and the renderer draws the visual orientation, so
 * those are separate layouts rather than the same one rotated.
 */
const PANELS = [
  { width: 640, height: 384 },
  { width: 800, height: 480 },
  { width: 1304, height: 984 },
  { width: 1872, height: 1404 },
  { width: 384, height: 640 },
  { width: 1404, height: 1872 },
] as const;

describe('the panel is filled, at every size and whatever is on the calendar', () => {
  for (const panel of PANELS) {
    const name = `${panel.width}×${panel.height}`;

    it(`${name} leaves at most 4% of its height blank with a full month`, () => {
      expect(blankBottom(frameAt(busy, panel.width, panel.height))).toBeLessThanOrEqual(0.04);
    });

    /*
     * The same bar on a quiet day, which is the case a household has most of
     * the time. A frame that only fills when today happens to be busy has moved
     * the fault rather than fixed it — and a fixture with twenty events on it
     * would never say so.
     */
    it(`${name} leaves at most 4% blank on a quiet day too`, () => {
      expect(blankBottom(frameAt(quiet, panel.width, panel.height))).toBeLessThanOrEqual(0.04);
    });
  }
});

describe('a bigger panel shows more, not the same thing bigger', () => {
  /*
   * The whole bug in one number. The shipped renderer drew six agenda rows at
   * 640×384 and six at 1872×1404 — a 3.7× range answered with one constant —
   * so a household who bought a 13.3" panel got the 7.5" panel's calendar
   * enlarged and 714px of white under it.
   *
   * Counted from ink rather than from the arithmetic that chose it, because
   * "the function returns more" and "the panel shows more" are two claims and
   * only the second is the product.
   */
  const landscape = PANELS.filter((p) => p.width >= p.height);

  it('draws strictly more agenda rows at each step up the range', () => {
    const rows = landscape.map((p) => {
      const m = panelMetrics(p);
      return agendaRowsDrawn(frameAt(busy, p.width, p.height), epaperBlocks(5, m).agenda.x, m.bullet);
    });
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]!);
    // …and the smallest panel still draws a usable agenda rather than one row.
    expect(rows[0]).toBeGreaterThanOrEqual(6);
  });

  it('agrees with the arithmetic that chose the rows', () => {
    for (const panel of landscape) {
      const m = panelMetrics(panel);
      // Asked of `epaperBlocks` rather than recomputed here: a test that works
      // out the split for itself is a second opinion about the layout, and the
      // renderer would be free to disagree with it.
      const box = epaperBlocks(5, m).agenda;
      const fits = agendaRowsInBox(box.y + box.h - (box.y + m.agendaHeadH), m);
      expect(agendaRowsDrawn(frameAt(busy, panel.width, panel.height), box.x, m.bullet)).toBe(fits);
    }
  });
});

describe('the counts are bounded, so a huge panel cannot ask for a hundred rows', () => {
  it('stops the agenda at the working set however tall the box is', () => {
    const m = panelMetrics({ width: 1872, height: 1404 });
    expect(agendaRowsInBox(100_000, m)).toBe(MAX_AGENDA_ROWS);
    expect(cellTitlesInBox(100_000, m)).toBe(MAX_CELL_TITLES);
  });

  it('draws nothing rather than a clipped row in a box with no room', () => {
    const m = panelMetrics({ width: 800, height: 480 });
    expect(agendaRowsInBox(m.bodyGlyph - 1, m)).toBe(0);
    expect(agendaRowsInBox(m.bodyGlyph, m)).toBe(1);
  });

  /*
   * The cell aspect rail. Nothing in the built-in layout reaches it — 2.03 at
   * 1872×1404 is the widest the range gets — so it is only ever a widget box a
   * household dragged very tall, and an assertion no edit can turn red is this
   * project's most repeated complaint. This one can: the box is 4.4 cells tall
   * for every one it is wide.
   */
  it('stops a month cell stretching past two and a half times its width', () => {
    const m = panelMetrics({ width: 800, height: 480 });
    const grid = gridMetrics(210, 5 * 210, 5, m);
    expect(grid.cellH).toBe(Math.round(grid.cellW * 2.5));
    expect(grid.topOffset).toBe(0); // a deliberate gap, not a rounding remainder
  });
});

describe('every metric is a whole pixel', () => {
  /*
   * A 1-bit raster has no half-lit line: a fractional row boundary is a grey
   * smear that survives until the next full refresh. Swept across the range
   * rather than at the six sizes, because the fractions hide between them —
   * `2 × round(short / 60)` is an integer at 480 whatever it does at 481.
   */
  it('at every panel size from 64 to 2000 pixels', () => {
    for (let side = 64; side <= 2000; side += 7) {
      for (const geometry of [{ width: side, height: 384 }, { width: 800, height: side }]) {
        const m: EpaperMetrics = panelMetrics(geometry);
        for (const [key, value] of Object.entries(m)) {
          if (key === 'panel') continue;
          expect(Number.isInteger(value), `${key} at ${geometry.width}×${geometry.height} is ${String(value)}`).toBe(
            true,
          );
        }
        const grid = gridMetrics(m.panel.width, m.panel.height, 5, m);
        for (const [key, value] of Object.entries(grid)) {
          expect(Number.isInteger(value), `grid ${key} at ${geometry.width}×${geometry.height}`).toBe(true);
        }
      }
    }
  });
});

describe('the arithmetic comes back to the constants it replaced', () => {
  /*
   * Task 3, as arithmetic rather than as pixels. These are the numbers somebody
   * reached by looking at real output on a Seeed 7.5", and a derivation that
   * cannot reproduce them at 480px of panel is wrong — the constant was right.
   * Exact equality, not a tolerance: a pixel here moves every row under it.
   */
  const m = panelMetrics(OUT_OF_THE_BOX);

  it('at 800×480', () => {
    expect({
      margin: m.margin,
      headerHeight: m.headerHeight,
      headerGap: m.headerGap,
      blockGap: m.blockGap,
      agendaRowH: m.agendaRowH,
      agendaRuleY: m.agendaRuleY,
      agendaHeadH: m.agendaHeadH,
      monthHeadH: m.monthHeadH,
      weekHeadH: m.weekHeadH,
      pillMinCell: m.pillMinCell,
      minCell: m.minCell,
      cellTitleLineH: m.cellTitleLineH,
      weekTitleLineH: m.weekTitleLineH,
      upcomingRowH: m.upcomingRowH,
      bullet: m.bullet,
    }).toEqual({
      margin: 16, // MARGIN
      headerHeight: 54, // HEADER_H
      headerGap: 14, // bodyTop = HEADER_H + 14
      blockGap: 12, // the portrait gap between agenda and grid
      agendaRowH: 34, // rowH
      agendaRuleY: 22, // the "TODAY" rule
      agendaHeadH: 36, // and the drop past it
      monthHeadH: 22, // labelH
      weekHeadH: 26, // headH
      pillMinCell: 34, // PILL_MIN_CELL
      minCell: 12, // the floor under a grid cell
      cellTitleLineH: 10, // drawCellTitles' lineH
      weekTitleLineH: 11, // drawWeekBox's row step
      upcomingRowH: 30, // drawUpcomingBox's row step
      bullet: 12, // the all-day/timed square
    });
  });

  it('and the type ladder lands on the scales that shipped', () => {
    expect([m.headerScale, m.yearScale, m.bodyScale, m.labelScale, m.smallScale]).toEqual([3, 2, 2, 2, 1]);
  });
});

describe('a portrait panel keeps its month cells square', () => {
  /*
   * Filling the box is what closes the white bottom, and on a *landscape* panel
   * it is paid for by the cell: the month is a tall narrow column beside the
   * agenda, so its cells come out about twice as tall as they are wide, and
   * there is nothing else in that column to absorb the height. Stacked, there
   * is — so a portrait panel asks the grid what a square cell needs (a seventh
   * of the width) and gives the agenda the rest, rather than splitting the body
   * at a flat 42% and handing the month a box its cells cannot fill.
   *
   * The blank-bottom assertions cannot see this: the grid fills either way, and
   * only the *shape* of what it fills with is different. Reverting the split to
   * `bodyH × 0.42` leaves every one of them green and turns this one red, which
   * is the only reason it is worth writing.
   */
  for (const panel of PANELS.filter((p) => p.height > p.width)) {
    it(`${panel.width}×${panel.height} draws them within a pixel of square`, () => {
      const fb = frameAt(busy, panel.width, panel.height);
      const m = panelMetrics(panel);
      // The lower half of a portrait panel is the month block, and the grid is
      // the only thing in it that rules right across the body's own width.
      const body: [number, number] = [m.margin, panel.width - m.margin];
      const half = Math.floor(panel.height / 2);
      const rows = fullRuns(fb, half, panel.height, body, 'rows');
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const columns = fullRuns(fb, body[0], body[1], [rows[0]!, rows[rows.length - 1]!], 'columns');
      expect(columns.length).toBeGreaterThanOrEqual(3);
      expect(Math.abs(step(rows) - step(columns))).toBeLessThanOrEqual(1);
    });
  }
});

describe('the panel that was tuned by looking at it', () => {
  const before = { header: 38944, agendaColumn: 2773, monthColumn: 15280, total: 56997 };
  const fb = frameAt(quiet, OUT_OF_THE_BOX.width, OUT_OF_THE_BOX.height);

  /*
   * The header band and the agenda column are pinned to the pixel, not to a
   * tolerance. Nothing about them is meant to move: every metric under them
   * derives back to the shipped constant at 480px of panel, so a single pixel
   * of drift here is a derivation that missed its anchor.
   */
  it('draws the identical header band', () => {
    expect(inkIn(fb, 0, 800, 0, 54)).toBe(before.header);
  });

  it('draws the identical agenda column on a quiet day', () => {
    expect(inkIn(fb, 0, SPLIT_800, 54, 480)).toBe(before.agendaColumn);
  });

  it('keeps the whole frame within a tenth of the ink it had', () => {
    const total = inkIn(fb, 0, 800, 0, 480);
    expect(Math.abs(total - before.total) / before.total).toBeLessThanOrEqual(0.1);
  });
});

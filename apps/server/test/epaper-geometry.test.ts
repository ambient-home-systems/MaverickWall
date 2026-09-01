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
  scaleRung,
  type EpaperMetrics,
  type PanelGeometry,
} from '../src/epaper/metrics.js';
import { epaperBlocks, renderEpaper } from '../src/epaper/render.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';
import { renderFreeformEpaper, type PlacedEpaperWidget } from '../src/epaper/widgets.js';

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
        // Descends into the widget group rather than stopping at it: a nested
        // object read as "not an integer" is the sweep working, and a nested
        // object *skipped* is twelve metrics it silently stops checking.
        for (const [key, value] of [...Object.entries(m), ...Object.entries(m.widget)]) {
          if (key === 'panel' || key === 'widget') continue;
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

/*
 * ---------------------------------------------------------------------------
 * The widgets, which had the same fault one layer along.
 * ---------------------------------------------------------------------------
 *
 * `renderEpaper`'s built-in layout is derived from the panel now, and its
 * calendar draws proved it. Every *other* widget was still drawn in absolute
 * pixels tuned on the same 800×480 Seeed: `PAD = 8`, a title bar 20px tall with
 * 8px type in it, `rowH = 24` for a to-do, `rowH = 22` for a chore, a module
 * panel counting rows at 24px, and — the one that reaches furthest — a dozen
 * `scaleToFit(text, box.w, 2)` calls, capping ordinary widget text at 16px on
 * every panel in the range.
 *
 * Measured as ink inside one widget filling 90% of the panel, the shipped
 * renderer drew this fraction of the same box at 1872×1404 as it drew at
 * 800×480:
 *
 *   clock 16%   shift 14%   countdown 14%   notes 15%   todo 15%
 *   chores 15%  chores/week 15%  chores/people 15%  weather 30%
 *   homeassistant 15%   external 14%   image 17%
 *   …and calendar 64%, because that one had already been fixed.
 *
 * 14% is what "the box grew 6.85× and the type did not" looks like: a note
 * widget on a 13.3" panel spending 98% of itself on white. The bar below is
 * 45%, which is clear of every pre-change number and clear of the ~58% the
 * ladder can actually reach — a widget with three readings in it cannot fill a
 * bigger box by drawing more, only by drawing bigger, and the ladder is
 * deliberately sub-linear.
 */

function widgetManifest(): Manifest {
  const days: ManifestDay[] = [];
  for (let d = 22; d <= 27; d++) {
    days.push({
      date: `2026-08-${d}`,
      shifts: [
        {
          personId: 'p1', personName: 'Amy', label: 'Days', shortCode: 'D',
          startTime: '07:00', endTime: '19:00', isWorking: true, color: '#f00',
        },
      ],
      events: [
        ev({ id: `e${d}`, uid: `e${d}`, title: `Dentist ${d}`, startsAt: Date.UTC(2026, 7, d, 9) }),
        ev({ id: `f${d}`, uid: `f${d}`, title: `Swimming lesson ${d}`, startsAt: Date.UTC(2026, 7, d, 17) }),
      ],
    } as unknown as ManifestDay);
  }
  const chore = (name: string, person: string, done: boolean): unknown => ({
    name, person, personId: person.toLowerCase(), done,
  });
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 22, 15, 30, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
    sources: [{ id: 's1', name: 'Family', color: '#000' }, { id: 's2', name: 'School', color: '#111' }],
    panels: {
      weather: {
        days: [
          { name: 'Fri', high: 24, low: 13, unit: 'C' }, { name: 'Sat', high: 22, low: 12, unit: 'C' },
          { name: 'Sun', high: 20, low: 11, unit: 'C' }, { name: 'Mon', high: 19, low: 10, unit: 'C' },
        ],
        provider: 'nws', fetchedAt: 1,
      },
      home: {
        readings: [
          { label: 'Front door', value: 'Locked', mode: 'label_value' },
          { label: 'Kitchen', value: '19.4 C', mode: 'label_value' },
          { label: 'Garage', value: 'Open', mode: 'label_value' },
          { label: 'Loft', value: '14.1 C', mode: 'label_value' },
        ],
        fetchedAt: 1,
      },
      mymod: {
        items: [
          { label: 'Bins', value: 'Tuesday' }, { label: 'Tide', value: 'High' },
          { label: 'Bus', value: '7 min' }, { label: 'Post', value: 'Collected' },
        ],
      },
      chores: {
        today: '2026-08-22',
        days: [
          { date: '2026-08-22', items: [chore('Feed the cat', 'Ella', true), chore('Empty the dishwasher', 'Sam', false), chore('Hoover the hall', 'Ella', false), chore('Take the bins out', 'Sam', false)] },
          { date: '2026-08-23', items: [chore('Water the plants', 'Ella', false), chore('Wash the car', 'Sam', false)] },
          { date: '2026-08-24', items: [chore('Change the beds', 'Ella', false)] },
        ],
      },
    },
  } as unknown as Manifest;
}

const WIDGET_MANIFEST = widgetManifest();
const WIDGET_MODEL = buildEpaperModel(WIDGET_MANIFEST);

/** One widget over 90% of the panel, so its box scales with the panel. */
const WIDGET_BOX = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } as const;

/**
 * Every placeable type, with enough content that the *box* is what limits it.
 *
 * A widget with one line in it fills a big box no better however the type is
 * derived, so a fixture that starves them would pass over the whole fault.
 */
const WIDGET_CASES: readonly { readonly name: string; readonly type: string; readonly config: Record<string, unknown> }[] = [
  { name: 'clock', type: 'clock', config: { showTitle: true, title: 'Time' } },
  { name: 'calendar', type: 'calendar', config: {} },
  { name: 'shift', type: 'shift', config: {} },
  { name: 'countdown', type: 'countdown', config: { target: '2026-12-25', title: 'Christmas' } },
  { name: 'notes', type: 'notes', config: { text: 'Remember the milk and the bread and the eggs and the cheese' } },
  { name: 'todo', type: 'todo', config: { items: ['Milk', 'Bread', 'Eggs', 'Cheese', 'Butter', 'Jam', 'Tea', 'Coffee'] } },
  { name: 'chores (today)', type: 'chores', config: {} },
  { name: 'chores (week)', type: 'chores', config: { mode: 'week' } },
  { name: 'chores (people)', type: 'chores', config: { mode: 'people' } },
  { name: 'weather', type: 'weather', config: {} },
  { name: 'homeassistant', type: 'homeassistant', config: {} },
  { name: 'external', type: 'external', config: { module: 'mymod' } },
  { name: 'image', type: 'image', config: { image: 'kitchen.jpg' } },
];

function widgetFrame(type: string, config: Record<string, unknown>, panel: PanelGeometry): Framebuffer {
  const widget: PlacedEpaperWidget = { type, ...WIDGET_BOX, z: 0, config };
  return renderFreeformEpaper(WIDGET_MODEL, WIDGET_MANIFEST, [widget], panel);
}

/** Ink inside the widget's own border, as a fraction of the box it was given. */
function widgetInkFill(type: string, config: Record<string, unknown>, panel: PanelGeometry): number {
  const fb = widgetFrame(type, config, panel);
  const x0 = Math.round(WIDGET_BOX.x * panel.width);
  const y0 = Math.round(WIDGET_BOX.y * panel.height);
  const w = Math.round(WIDGET_BOX.w * panel.width);
  const h = Math.round(WIDGET_BOX.h * panel.height);
  // Two pixels in from the border, so the frame's own rectangle — which scales
  // with nothing and is one pixel wide on every panel — cannot flatter a big
  // box or a small one.
  return inkIn(fb, x0 + 2, x0 + w - 2, y0 + 2, y0 + h - 2) / (w * h);
}

describe('a widget draws at the panel\'s scale, not at 800×480\'s', () => {
  const anchor = { width: 800, height: 480 } as const;

  for (const widget of WIDGET_CASES) {
    it(`${widget.name} keeps its ink density across the range`, () => {
      const base = widgetInkFill(widget.type, widget.config, anchor);
      expect(base).toBeGreaterThan(0);
      for (const panel of PANELS) {
        const fill = widgetInkFill(widget.type, widget.config, panel);
        expect(fill / base, `${widget.name} at ${panel.width}×${panel.height}`).toBeGreaterThanOrEqual(0.45);
      }
    });
  }
});

/**
 * Ink bands inside a widget's border — a run of rows with any ink in them.
 *
 * Two pixels in from the box, because the widget's own rectangle is inked on
 * every row of it and would otherwise merge every line into one band.
 */
function inkBands(
  type: string,
  config: Record<string, unknown>,
  panel: PanelGeometry,
  box: { x: number; y: number; w: number; h: number } = { ...WIDGET_BOX },
): { readonly top: number; readonly height: number }[] {
  const widget: PlacedEpaperWidget = { type, ...box, z: 0, config };
  const fb = renderFreeformEpaper(WIDGET_MODEL, WIDGET_MANIFEST, [widget], panel);
  const x0 = Math.round(box.x * panel.width);
  const w = Math.round(box.w * panel.width);
  const y0 = Math.round(box.y * panel.height);
  const h = Math.round(box.h * panel.height);
  const bands: { top: number; height: number }[] = [];
  let start = -1;
  for (let y = y0 + 2; y < y0 + h - 2; y++) {
    if (inkIn(fb, x0 + 2, x0 + w - 2, y, y + 1) > 0) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      bands.push({ top: start - y0, height: y - start });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ top: start - y0, height: y0 + h - 2 - start });
  return bands;
}

const SMALL_PANEL = { width: 800, height: 480 } as const;
const LARGE_PANEL = { width: 1872, height: 1404 } as const;

describe('the widget chrome scales too', () => {
  /*
   * The title bar is the one piece of chrome every widget shares, and it was
   * the worst of them: `scale: 1` is 8px of type on a 13.3" panel, under a
   * hairline 12px down, inside an 8px inset — none of which a household reads
   * from across a kitchen.
   *
   * **Every number here is a literal, and that is the whole point.** The first
   * version of this test compared the measured offset against
   * `m.widget.inset + m.widget.smallLine` — which is the arithmetic that drew
   * it, so pinning either metric back to a constant moved the frame *and* the
   * expectation together and the test stayed green. Checked by doing exactly
   * that, twice. These come off the ladder by hand instead: at 1872×1404 the
   * body glyph is 32, so the inset is 16, and the small glyph is 16 with 8 of
   * leading, so the title bar is 24 to its rule and 40 to the content.
   */
  const titled = { showTitle: true, title: 'Shopping', text: 'Milk' };

  it('puts the title rule and the content where the ladder says, at both ends', () => {
    const small = inkBands('notes', titled, SMALL_PANEL);
    // The title's own ink, the hairline, then the first line of content.
    expect(small[0]!.top).toBe(8); // the inset
    expect(small[1]!.top).toBe(20); // inset + one small line
    expect(small[2]!.top).toBe(28); // inset + the whole title bar

    const large = inkBands('notes', titled, LARGE_PANEL);
    expect(large[0]!.top).toBe(16);
    expect(large[1]!.top).toBe(40);
    expect(large[2]!.top).toBe(56);
  });

  it('draws the title itself a rung larger on the larger panel', () => {
    // The band's height is the glyph's inked height, so this is a fact about
    // the *scale* the title was drawn at rather than about where it sits — the
    // half the offsets above cannot see.
    const small = inkBands('notes', titled, SMALL_PANEL)[0]!.height;
    const large = inkBands('notes', titled, LARGE_PANEL)[0]!.height;
    expect(large).toBe(small * 2);
  });
});

describe('a widget\'s rows are spaced for the type in them', () => {
  /*
   * A row height left at 24 while the type in it grew to 32 is not a tidier
   * list, it is rows that touch — and the ink-density check above cannot see
   * it, because overlapping rows are *more* ink rather than less. Measured as
   * the pitch between consecutive bands, against literals worked out from the
   * ladder rather than from the metric that draws them.
   */
  const pitch = (bands: readonly { readonly top: number }[]): number => {
    // Two bands is a pitch; fewer is a widget that drew one thing, and a pitch
    // read off that would be a number with nothing behind it.
    expect(bands.length).toBeGreaterThanOrEqual(2);
    return bands[1]!.top - bands[0]!.top;
  };

  const CASES = [
    { name: 'a to-do', type: 'todo', config: { items: ['Milk', 'Bread', 'Eggs', 'Cheese', 'Butter', 'Jam'] }, small: 24, large: 48 },
    { name: 'a chore board', type: 'chores', config: {}, small: 22, large: 44 },
    { name: 'a note', type: 'notes', config: { text: 'Remember the milk and the bread and the eggs and the cheese and the butter' }, small: 20, large: 40 },
  ] as const;

  for (const c of CASES) {
    it(`${c.name} steps by ${c.small}px at 800×480 and ${c.large}px at 1872×1404`, () => {
      expect(pitch(inkBands(c.type, c.config, SMALL_PANEL))).toBe(c.small);
      expect(pitch(inkBands(c.type, c.config, LARGE_PANEL))).toBe(c.large);
    });
  }

  it('keeps every row of a list a separate band on both panels', () => {
    // Six items, six bands. Rows that have grown into each other merge, so this
    // is the same fault as the pitch above read from the other side.
    const items = { items: ['Milk', 'Bread', 'Eggs', 'Cheese', 'Butter', 'Jam'] };
    expect(inkBands('todo', items, SMALL_PANEL)).toHaveLength(6);
    expect(inkBands('todo', items, LARGE_PANEL)).toHaveLength(6);
  });
});

describe('a forecast gives up its columns at the panel\'s own threshold', () => {
  /*
   * `drawWeather` draws columns when each has room to be read and lines when it
   * has not, and "room" was 56px — measured for 16px type and then asked of a
   * panel drawing 32px type, where 56px of column is four characters. The
   * threshold is 3.5 body glyphs now, so it moves with what it is protecting.
   *
   * Read as the tallest thing drawn: below the threshold the strip falls back to
   * lines and keeps the panel's type, above it the columns shrink the type to
   * fit. A narrow box that still draws columns on a 13.3" panel draws them at
   * the smallest scale the font has.
   */
  const narrow = { x: 0.05, y: 0.05, w: 0.19, h: 0.4 };
  const shortest = (panel: PanelGeometry): number =>
    Math.min(...inkBands('weather', {}, panel, narrow).map((band) => band.height));

  /*
   * Read as the *shortest* run of text, not the tallest, and that is the whole
   * assertion. "Tallest" was the first version and it survived pinning the
   * threshold back to 56: the columns that mode draws still size their day
   * names at the small rung, so the tall band stayed tall while the row beside
   * it — the temperatures, the thing a forecast is for — collapsed to a single
   * scale. Only the shortest run can see that.
   *
   * A glyph's bottom row is blank for most of the alphabet, so an 8px rung
   * measures 7px of ink; the bar is the rung less one for exactly that.
   */
  for (const panel of [SMALL_PANEL, LARGE_PANEL]) {
    it(`draws nothing under the small rung at ${panel.width}×${panel.height}`, () => {
      const rung = 8 * panelMetrics(panel).smallScale;
      expect(shortest(panel)).toBeGreaterThanOrEqual(rung - 1);
    });
  }
});

describe('the widget metrics come back to the constants they replaced', () => {
  it('at 800×480', () => {
    const w = panelMetrics(OUT_OF_THE_BOX).widget;
    expect({
      inset: w.inset,
      smallLine: w.smallLine,
      titleBarH: w.titleBarH,
      linePad: w.linePad,
      listRowH: w.listRowH,
      choreRowH: w.choreRowH,
      tickDrop: w.tickDrop,
      tickInset: w.tickInset,
      tickDot: w.tickDot,
      rowGap: w.rowGap,
      columnMinW: w.columnMinW,
      columnMinH: w.columnMinH,
    }).toEqual({
      inset: 8, // PAD
      smallLine: 12, // the title rule, and a group heading's drop
      titleBarH: 20, // the drop past the title bar
      linePad: 4, // drawLines' and drawStack's leading, and drawShift's ROW_GAP
      listRowH: 24, // drawTodo's rowH
      choreRowH: 22, // drawChores' rowH
      tickDrop: 3, // the chore tick's drop into its row
      tickInset: 3, // and the inset of its filled dot
      tickDot: 6, // …and the dot
      rowGap: 6, // between chore groups, and between forecast rows
      columnMinW: 56, // the forecast draws columns above this, lines below
      columnMinH: 40,
    });
  });

  it('and the scale rungs land on the caps that shipped', () => {
    const m = panelMetrics(OUT_OF_THE_BOX);
    expect([
      scaleRung(m, 4), // the clock's biggest time
      scaleRung(m, 4.5), // the countdown's biggest number
      scaleRung(m, 3.5), // a shift card's headline
      scaleRung(m, 1.5), // a forecast column's headline, and the clock's date
      scaleRung(m, 1), // ordinary widget text
    ]).toEqual([8, 9, 7, 3, 2]);
  });
});

describe('a module panel counts the rows it actually draws', () => {
  /*
   * The one thing that moves at 800×480 in this pass, and it moves in the
   * household's favour.
   *
   * `drawPanel` capped its rows at `box.h / 24` and then drew them at a line
   * height of 20 — so a box with room for five of a module's readings asked the
   * module for four and drew four, and the fifth was thrown away two layers
   * before anything measured the box. A count and the loop that draws it have
   * to be the same arithmetic; that is `agendaRowsInBox`'s whole rule, and this
   * was the same fault in a widget.
   *
   * Nothing can overflow as a result: `drawLines` still stops at the foot of
   * the box, so the count only decides how many candidates it is handed.
   */
  const readings = Array.from({ length: 12 }, (_, i) => ({ label: `Row ${i + 1}`, value: `v${i + 1}` }));
  const withModule = {
    ...WIDGET_MANIFEST,
    panels: { ...WIDGET_MANIFEST.panels, many: { items: readings } },
  } as unknown as Manifest;

  /** Lines of text drawn inside the widget's border, counted as ink bands. */
  const linesDrawn = (heightFraction: number): number => {
    const panel = { width: 800, height: 480 } as const;
    const widget: PlacedEpaperWidget = {
      type: 'external', x: 0.05, y: 0.05, w: 0.9, h: heightFraction, z: 0, config: { module: 'many' },
    };
    const fb = renderFreeformEpaper(buildEpaperModel(withModule), withModule, [widget], panel);
    const x0 = Math.round(0.05 * panel.width);
    const w = Math.round(0.9 * panel.width);
    const y0 = Math.round(0.05 * panel.height);
    const h = Math.round(heightFraction * panel.height);
    let bands = 0;
    let run = 0;
    // Two pixels in from the border, which is inked on every row of the box and
    // would otherwise merge every line into one band.
    for (let y = y0 + 2; y < y0 + h - 2; y++) {
      if (inkIn(fb, x0 + 2, x0 + w - 2, y, y + 1) > 0) run++;
      else {
        if (run > 0) bands++;
        run = 0;
      }
    }
    return run > 0 ? bands + 1 : bands;
  };

  it('fills the box rather than stopping a row short', () => {
    // 4, 5 and 7 before the count and the loop were made to agree.
    expect(linesDrawn(0.25)).toBe(5); // a 120px box
    expect(linesDrawn(0.3)).toBe(6); // 144px
    expect(linesDrawn(0.4)).toBe(8); // 192px
  });

  it('and still draws nothing past the foot of the box', () => {
    const panel = { width: 800, height: 480 } as const;
    const widget: PlacedEpaperWidget = {
      type: 'external', x: 0.05, y: 0.05, w: 0.9, h: 0.25, z: 0, config: { module: 'many' },
    };
    const fb = renderFreeformEpaper(buildEpaperModel(withModule), withModule, [widget], panel);
    const bottom = Math.round(0.05 * panel.height) + Math.round(0.25 * panel.height);
    expect(inkIn(fb, 0, panel.width, bottom + 1, panel.height)).toBe(0);
  });
});

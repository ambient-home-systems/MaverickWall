import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import type { Framebuffer } from '../src/epaper/framebuffer.js';
import { renderEpaper } from '../src/epaper/render.js';
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
  it('draws strictly more agenda rows at each step up the range', () => {
    // 12 is the bullet at 800×480; the count window is wide enough to catch the
    // bigger panels' bigger bullets, and far too narrow for a grid border.
    const rows = PANELS.filter((p) => p.width >= p.height).map((p) => {
      const fb = frameAt(busy, p.width, p.height);
      const margin = Math.round(p.height / 30);
      return agendaRowsDrawn(fb, margin, Math.round(p.height / 40));
    });
    expect(rows[0]).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]!);
  });
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

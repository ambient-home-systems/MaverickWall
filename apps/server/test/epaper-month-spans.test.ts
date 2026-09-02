import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { drawMonthBox, renderEpaper } from '../src/epaper/render.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { gridMetrics, panelMetrics } from '../src/epaper/metrics.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * The panel follows the wall — measured in the ink a real panel would carry.
 *
 * A multi-day event is one bar here too, the counter never costs a name here
 * too, and a density mark says how busy a day is here too. Which events are a
 * bar is not decided twice: `epaper/month-spans.ts` is the wall's own module
 * transcribed, held to it by `month-spans-parity.test.ts`. What this file
 * measures is the half that *is* the panel's own — where the ink lands.
 *
 * **Decoded, never inspected.** Reading the framebuffer the renderer just
 * wrote proves the renderer agrees with itself; the PNG is what a panel
 * actually receives. That is the QR lesson — a code that passed every
 * structural check and scanned as nothing — applied one renderer along, and it
 * is cheap here because the decoder already exists next door.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Unpack a 1-bit PNG into rows of "is this pixel black". */
function decode(png: Uint8Array): boolean[][] {
  for (let i = 0; i < SIGNATURE.length; i++) expect(png[i]).toBe(SIGNATURE[i]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    );
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
    } else if (type === 'IDAT') {
      parts.push(data.slice());
    }
    offset += 12 + length;
  }
  const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;
  const rows: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const byte = raw[start + 1 + (x >> 3)]!;
      row.push((((byte >> (7 - (x & 7))) & 1) === 0));
    }
    rows.push(row);
  }
  return rows;
}

function ink(rows: readonly (readonly boolean[])[], x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (rows[y]?.[x] === true) n++;
  }
  return n;
}

/*
 * A fixed month so the grid's geometry is arithmetic rather than a guess.
 *
 * 2026-08-13 is a Thursday; with a Sunday week start the grid begins on
 * Sunday 2026-08-09, so column 0 of week 0 is the 9th and the days below land
 * where this file says they do. A relative fixture would put them somewhere
 * different each day the suite runs, which is the `harness-fixture-dates`
 * lesson, and here it would also make every pixel assertion a guess.
 */
const TODAY = '2026-08-13';
const WEEK_START = '2026-08-09';

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e',
    uid: 'e',
    title: 'Event',
    startsAt: 0,
    endsAt: 0,
    allDay: false,
    sourceId: 's',
    color: '#000',
    status: 'confirmed',
    continues: false,
    ...over,
  };
}

function fakeManifest(days: ManifestDay[], generatedAt = Date.UTC(2026, 7, 13, 12, 0, 0)): Manifest {
  return {
    timezone: 'UTC',
    generatedAt,
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

/** `YYYY-MM-DD`, `n` days after the week start. */
function dayOf(offset: number): string {
  return new Date(Date.parse(`${WEEK_START}T12:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A half term over columns 1, 2 and 3 of the first grid week, plus a busy
 * today — the smallest fixture that can tell every rule apart. It stops short
 * of today's column deliberately: that cell is a solid fill, so it can say
 * nothing about whether a bar was drawn over it.
 */
function halfTermManifest(): Manifest {
  const half = (date: string): ManifestDay => ({
    date,
    shifts: [],
    events: [ev({ id: 'half', uid: 'half', title: 'Half term', allDay: true, continues: true })],
  });
  return fakeManifest([
    half(dayOf(1)),
    half(dayOf(2)),
    half(dayOf(3)),
    {
      date: TODAY,
      shifts: [],
      events: [
        ev({ id: 'a', title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0) }),
        ev({ id: 'b', title: 'Football', startsAt: Date.UTC(2026, 7, 13, 17, 0) }),
        ev({ id: 'c', title: 'Book club', startsAt: Date.UTC(2026, 7, 13, 19, 0) }),
        ev({ id: 'd', title: 'Late thing', startsAt: Date.UTC(2026, 7, 13, 21, 0) }),
      ],
    },
  ]);
}

/**
 * The month grid alone, on a generous canvas, decoded.
 *
 * Drawn through `drawMonthBox` rather than through the whole panel so the cell
 * geometry below is the box this test set — the fixed layout gives the grid
 * whatever is left after the agenda, which is a different number on every
 * panel size and would make every coordinate here a guess.
 */
function grid(manifest: Manifest, box = { x: 0, y: 0, w: 700, h: 420 }): {
  rows: boolean[][];
  cellW: number;
  cellH: number;
  gx: number;
  gridTop: number;
  laneH: number;
  barH: number;
  numberBand: number;
} {
  const model = buildEpaperModel(manifest, { now: Date.parse(`${TODAY}T12:00:00Z`) });
  const fb = new Framebuffer(box.w, box.h);
  const m = panelMetrics({ width: box.w, height: box.h });
  drawMonthBox(fb, model, m, box, { pills: true });
  /*
   * Asked of the same arithmetic the renderer used, rather than recomputed.
   *
   * This transcribed `labelH = 22` and a *square* `min(box.w / 7, …)` cell to
   * find what it decodes, which was right while the grid was square and drawn
   * at fixed pixels. It is neither now — the cell fills its box in both
   * directions and the rounding remainder sits above the first row — so a
   * transcription would read a band that has moved and report it as missing
   * ink. Same reason `epaper-geometry.test.ts` stopped transcribing the header
   * height: a measurement's geometry has to follow the renderer it measures.
   */
  const grid = gridMetrics(box.w, box.h - m.monthHeadH, model.weeks.length, m);
  const gridTop = box.y + m.monthHeadH + grid.topOffset;
  const gx = box.x + Math.floor((box.w - grid.cellW * 7) / 2);
  // Where a cell's lanes start: the number's inset, the number, and the gap
  // under it — `drawMonthBox`'s own `numberBand`.
  const numScale = Math.min(grid.cellH, grid.cellW) >= m.pillMinCell ? 2 * m.smallScale : m.smallScale;
  const numberBand = m.cellNumberInset + 8 * numScale + 2 * m.smallScale;
  return {
    rows: decode(encodePng1bit(fb)),
    cellW: grid.cellW,
    cellH: grid.cellH,
    gx,
    gridTop,
    laneH: m.spanLaneH,
    barH: m.spanBarH,
    numberBand,
  };
}

describe('rule 1 on a panel — one bar across the days', () => {
  it('lays ink across the three covered cells and none beside them', () => {
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(halfTermManifest());
    /*
     * The lane band, measured column by column across the first grid week.
     *
     * It sits under the day number, so the band is read at a fixed offset
     * rather than by hunting for ink: the whole claim is that a bar covering
     * columns 1 to 3 puts ink in *those* columns of the band and in no other.
     * A bar drawn one column out passes any "did the frame change" check and
     * fails this.
     */
    const laneTop = gridTop + numberBand;
    const band = (column: number): number =>
      ink(rows, gx + column * cellW + 2, laneTop, gx + (column + 1) * cellW - 2, laneTop + barH);

    for (const column of [1, 2, 3]) {
      expect(band(column), `column ${column} carries no bar`).toBeGreaterThan(cellW * 3);
    }
    /*
     * Column 4 is today, whose whole cell is a solid fill, so it can say
     * nothing about a bar and is deliberately not asked. Columns 0 and 5 are
     * what catch a bar placed one column out in either direction.
     */
    for (const column of [0, 5, 6]) {
      expect(band(column), `column ${column} carries a bar it should not`).toBe(0);
    }
  });

  it('draws one bar, not one per day', () => {
    /*
     * The bar is continuous *through* the cell borders it crosses, which is
     * what makes a week read as one object — three separate boxes with ink in
     * them would leave the vertical rules standing between them.
     *
     * Measured on the bar's own middle row: every pixel from the start of
     * column 2 to the end of column 4 is ink, with no gap at either boundary.
     */
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(halfTermManifest());
    /*
     * The bar's *last* row, not its middle: the title is knocked out of the
     * band, so a row through the words is full of holes by design. The bar is
     * ten pixels and scale-1 text is eight of them starting one down, which
     * leaves the bottom row solid wherever the bar is drawn.
     */
    const middle = gridTop + numberBand + 9;
    const from = gx + 1 * cellW + 2;
    const to = gx + 4 * cellW - 3;
    let gaps = 0;
    for (let x = from; x < to; x++) if (rows[middle]?.[x] !== true) gaps++;
    expect(gaps, `${gaps} pixels of the bar are missing across its three days`).toBe(0);
  });

  it('leaves the cells under a bar with nothing more to say', () => {
    /*
     * The half a bar-shaped assertion cannot see. Each of these three days has
     * exactly one event and the bar above already draws it, so the space under
     * the lane — past the density mark — has to be empty. Without the skip,
     * every one of them prints "Half term" again *underneath* the bar that
     * says it, which is the repetition being fixed and is invisible to any
     * measurement taken inside the band.
     */
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(halfTermManifest());
    // Lane band, then the density mark and its gap: 12 + 3 + 3.
    const below = gridTop + numberBand + laneH + 6;
    for (const column of [1, 2, 3]) {
      expect(
        ink(rows, gx + column * cellW + 2, below, gx + (column + 1) * cellW - 2, gridTop + cellH - 2),
        `column ${column} repeats its event under the bar that already draws it`,
      ).toBe(0);
    }
  });

  it('names the run once', () => {
    /*
     * The title is knocked out of the bar, so the *first* covered cell has
     * clear pixels inside a band that is otherwise solid and the others do
     * not. Counting clear pixels rather than reading text back is the honest
     * measurement available from a bitmap, and it is exactly the difference
     * between a labelled bar and a continuation.
     */
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(halfTermManifest());
    const laneTop = gridTop + numberBand;
    const clearIn = (column: number): number => {
      let n = 0;
      for (let y = laneTop + 1; y < laneTop + 9; y++) {
        for (let x = gx + column * cellW + 3; x < gx + (column + 1) * cellW - 3; x++) {
          if (rows[y]?.[x] === false) n++;
        }
      }
      return n;
    };
    expect(clearIn(1), 'the first cell of the run carries no words').toBeGreaterThan(10);
  });

  it('carries no title on a bar continuing into the next week', () => {
    /*
     * The week-boundary rule, on the panel. Three days from the Friday put one
     * bar at column 6 of week 0 and another at columns 0–1 of week 1; the
     * first carries the words and the second must not, or the title is printed
     * twice — the bug being fixed, one row down instead of three columns
     * across.
     *
     * Measured as clear pixels inside the band, which is what a knocked-out
     * title *is* on 1 bit: a solid bar has none.
     */
    const half = (date: string): ManifestDay => ({
      date,
      shifts: [],
      events: [ev({ id: 'half', uid: 'half', title: 'Half term', allDay: true, continues: true })],
    });
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(
      fakeManifest([half(dayOf(5)), half(dayOf(6)), half(dayOf(7)), half(dayOf(8))]),
    );
    const clearIn = (weekRow: number, column: number): number => {
      const top = gridTop + weekRow * cellH + numberBand;
      let n = 0;
      for (let y = top + 1; y < top + 9; y++) {
        for (let x = gx + column * cellW + 3; x < gx + (column + 1) * cellW - 3; x++) {
          if (rows[y]?.[x] === false) n++;
        }
      }
      return n;
    };
    expect(clearIn(0, 5), 'the leading bar carries no words').toBeGreaterThan(10);
    expect(clearIn(1, 0), 'the continuation repeats the title').toBe(0);
    expect(clearIn(1, 1), 'the continuation repeats the title').toBe(0);
  });

  it('leaves a one-day all-day event and a daily series as rows', () => {
    // `DTEND` is exclusive and `continues` is what says otherwise. A bar for a
    // birthday is the single most common ICS bug wearing a new hat.
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(
      fakeManifest([
        { date: dayOf(1), shifts: [], events: [ev({ id: 'bday', title: 'Birthday', allDay: true })] },
        { date: dayOf(2), shifts: [], events: [ev({ id: 's1', title: 'Standup', startsAt: 0 })] },
        { date: dayOf(3), shifts: [], events: [ev({ id: 's2', title: 'Standup', startsAt: 0 })] },
      ]),
    );
    const laneTop = gridTop + numberBand;
    for (const column of [1, 2, 3]) {
      const band = ink(
        rows,
        gx + column * cellW + 2,
        laneTop,
        gx + (column + 1) * cellW - 2,
        laneTop + barH,
      );
      // Text, not a bar: a solid 10px band across a ~90px cell is most of 900
      // pixels, and a line of scale-1 words is a small fraction of that.
      expect(band, `column ${column} drew a bar for a one-day event`).toBeLessThan(cellW * 3);
    }
  });
});

describe('rules 2 and 3 on a panel', () => {
  it('draws a longer density mark for a busier day', () => {
    /*
     * The mark's *length* is the encoding, so this measures how far the ink
     * runs rather than whether any was laid. Today's cell is filled, so its
     * mark is knocked out of the fill — measured as clear pixels there and as
     * ink everywhere else, which is the same rule the day number follows.
     */
    const quiet = fakeManifest([
      { date: dayOf(2), shifts: [], events: [ev({ id: 'one', title: 'One', startsAt: 0 })] },
    ]);
    const busy = fakeManifest([
      {
        date: dayOf(2),
        shifts: [],
        events: [1, 2, 3, 4].map((n) => ev({ id: `e${n}`, title: `Thing ${n}`, startsAt: 0 })),
      },
    ]);
    const widthOf = (manifest: Manifest): number => {
      const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(manifest);
      const top = gridTop + numberBand;
      let widest = 0;
      for (let y = top; y < top + 4; y++) {
        let run = 0;
        for (let x = gx + 2 * cellW + 3; x < gx + 3 * cellW - 3; x++) {
          if (rows[y]?.[x] === true) run++;
        }
        widest = Math.max(widest, run);
      }
      return widest;
    };
    const one = widthOf(quiet);
    const four = widthOf(busy);
    expect(one, 'a one-event day drew no mark at all').toBeGreaterThan(0);
    expect(four, `a four-event day marks ${four}px and a one-event day ${one}px`).toBeGreaterThan(
      one + 4,
    );
  });

  it('draws nothing under the numeral on an empty day', () => {
    // An empty day is the information. Every cell in this grid is empty except
    // one, so the whole band under those numerals must be clear.
    const { rows, cellW, cellH, gx, gridTop, laneH, barH, numberBand } = grid(
      fakeManifest([{ date: dayOf(2), shifts: [], events: [ev({ id: 'x', title: 'X', startsAt: 0 })] }]),
    );
    const top = gridTop + numberBand;
    // Column 4 is today: a solid fill, which says nothing about what was drawn
    // under its numeral and is the one cell this cannot ask.
    for (const column of [0, 1, 3, 5, 6]) {
      expect(
        ink(rows, gx + column * cellW + 2, top, gx + (column + 1) * cellW - 2, top + 6),
        `column ${column} is empty and drew something under its numeral`,
      ).toBe(0);
    }
  });

  it('shares the last name\'s line with the count rather than taking one', () => {
    /*
     * A cell that can name something, and four events on the day: the last name
     * drawn has to hold a "+N" hard right, because a counter on a line of its
     * own costs a name and a count is a summary of what is missing — it cannot
     * be worth more than the thing itself.
     *
     * **The box is bigger than it was, and the reason is the tier table.** This
     * used to run on 46px cells, which is four characters of this font — so
     * "Yoga" was fitted to "Yo" and this assertion's own comment described
     * reading the tail of a two-letter stub. A cell that narrow now draws its
     * density mark and no names at all (`tiers.ts`, M0), which is what the wall
     * draws in a cell of the same width and is the divergence this phase
     * closed. The rule under test is untouched; it needs a cell that can hold a
     * name to be *about* anything, so the panel is one that can.
     */
    const busy = fakeManifest([
      {
        date: dayOf(2),
        shifts: [],
        events: ['Yoga', 'A', 'B', 'C'].map((title, n) =>
          ev({ id: `e${n}`, title, startsAt: 0 }),
        ),
      },
    ]);
    const box = { x: 0, y: 0, w: 700, h: 420 };
    const { rows, cellW, cellH, gx, gridTop, numberBand } = grid(busy, box);
    const m = panelMetrics({ width: box.w, height: box.h });
    const left = gx + 2 * cellW;
    // The first title line: the numeral's band, then the mark and its gap.
    const top = gridTop + numberBand + m.markH + m.markGap;
    const glyph = 8 * m.smallScale;
    /*
     * Which lines were actually drawn, found by looking rather than by working
     * out how many the box affords — a test that recomputes the renderer's own
     * row arithmetic is the second opinion `grid()` above exists to avoid, and
     * working it out is how this file came to describe a stub as a name.
     */
    // Bounded by the cell, which is not fussiness: the line after the last one
    // that fits runs into the next week's border and numeral, and a scan that
    // walked into it read the row below as a line of this cell's.
    const bottom = gridTop + cellH;
    const drawn: number[] = [];
    for (let y = top; y + glyph <= bottom; y += m.cellTitleLineH) {
      if (ink(rows, left + m.cellInset, y, left + cellW - 1, y + glyph) > 0) drawn.push(y);
    }
    expect(drawn.length, 'the cell named nothing, so there is no rule to test').toBeGreaterThan(0);
    const last = drawn[drawn.length - 1] as number;
    expect(
      ink(rows, left + m.cellInset, last, left + Math.floor(cellW / 2), last + glyph),
      'the cell spent its last line on a count and drew no name on it',
    ).toBeGreaterThan(0);
    expect(
      ink(rows, left + cellW - 3 * m.cellInset, last, left + cellW - 1, last + glyph),
      'the count is not on the name\'s line, so it either took one or vanished',
    ).toBeGreaterThan(0);
    // And it took no line of its own under the names, which is the whole rule.
    const under = last + m.cellTitleLineH;
    expect(under + glyph, 'the cell has no room below its last name to test').toBeLessThan(bottom);
    expect(
      ink(rows, left + m.cellInset, under, left + cellW - 1, under + glyph),
      'the count took a line of its own under the names',
    ).toBe(0);
  });

  it('never draws a count in a cell that names nothing', () => {
    /*
     * A cell too small to hold a line still has a day number and a density
     * mark, and "+4" alone would be its entire content — a number with no
     * subject, which is exactly the failure this rule removes from the wall.
     *
     * 34px cells, which is `PILL_MIN_CELL` exactly: names are asked for, and
     * the arithmetic the renderer does — the numeral's line, the mark and its
     * gap — leaves four pixels, where a line needs eight. So there is nothing
     * below the mark, and the assertion is that there is *nothing* rather than
     * that some particular corner is clear: a counter drawn anywhere in that
     * strip is a cell spending its whole content on a number.
     */
    const busy = fakeManifest([
      {
        date: dayOf(2),
        shifts: [],
        events: [1, 2, 3, 4].map((n) => ev({ id: `e${n}`, title: `Committee ${n}`, startsAt: 0 })),
      },
    ]);
    const model = buildEpaperModel(busy, { now: Date.parse(`${TODAY}T12:00:00Z`) });
    const box = { x: 0, y: 0, w: 238, h: 192 };
    const fb = new Framebuffer(box.w, box.h);
    drawMonthBox(fb, model, panelMetrics({ width: box.w, height: box.h }), box, { pills: true });
    const rows = decode(encodePng1bit(fb));
    const cell = Math.max(12, Math.floor(Math.min(box.w / 7, (box.h - 22) / model.weeks.length)));
    expect(cell, 'the box did not produce the cell size this measurement assumes').toBe(34);
    const left = Math.floor((box.w - cell * 7) / 2) + 2 * cell;
    // Below the numeral's line and the mark: 4 + 8*2 + 2 for the number, then
    // the 3px mark. Everything under that has to be empty.
    const under = 22 + 4 + 8 * 2 + 2 + 4;
    expect(
      ink(rows, left + 1, under, left + cell - 1, 22 + cell - 1),
      'the cell drew a count with no name for it to be a count of',
    ).toBe(0);
    // And it is not empty for the boring reason: the mark above it is drawn,
    // so the cell does say how busy the day is.
    expect(
      ink(rows, left + 1, 22 + 4 + 8 * 2 + 2, left + cell - 1, under),
      'the cell drew no density mark either, so it says nothing at all',
    ).toBeGreaterThan(0);
  });
});

describe('rule 4 stops at the wall', () => {
  it('draws no current-time indicator anywhere on a panel', () => {
    /*
     * Asserted as the property that matters rather than as the absence of an
     * element, because a bitmap has no elements: **the same day drawn at two
     * different times is the same frame.** An indicator that means anything
     * has to move as the clock does, so any frame carrying one differs here.
     *
     * The reason is not tidiness. A panel refreshing every minute is a battery
     * screen dead in a fortnight, and this product documents e-paper as a
     * glance class rather than an alert class. `frameEtag` buckets on the
     * civil date for the same reason, so a frame that *did* move every minute
     * would not even reach the panel — it would simply be wrong and cached.
     */
    const day: ManifestDay = {
      date: TODAY,
      shifts: [],
      events: [
        ev({ id: 'a', title: 'Dentist', startsAt: Date.UTC(2026, 7, 13, 9, 0), endsAt: Date.UTC(2026, 7, 13, 10, 0) }),
        ev({ id: 'b', title: 'Book club', startsAt: Date.UTC(2026, 7, 13, 19, 30), endsAt: Date.UTC(2026, 7, 13, 21, 0) }),
      ],
    };
    const at = (hour: number): string => {
      const now = Date.UTC(2026, 7, 13, hour, 0, 0);
      const model = buildEpaperModel(fakeManifest([day], now), { now });
      const fb = renderEpaper(model, { width: 800, height: 480 });
      return Buffer.from(encodePng1bit(fb)).toString('base64');
    };
    // Before the first event, between the two, and after both: three readings
    // a moving indicator could not possibly draw the same.
    expect(at(8)).toBe(at(12));
    expect(at(8)).toBe(at(22));
  });
});

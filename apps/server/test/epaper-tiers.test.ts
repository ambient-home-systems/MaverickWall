import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { drawMonthBox } from '../src/epaper/render.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { rungStep } from '../src/epaper/font.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { gridMetrics, panelMetrics } from '../src/epaper/metrics.js';
import { namesAt, spanIsLabelled, tierFor } from '../src/epaper/tiers.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

/**
 * What a panel's month cell draws, held to the tier its own box resolves.
 *
 * The wall's browser test asks this of a DOM; this asks it of the frame,
 * decoded — which is the only honest way to check a 1-bit renderer and is the
 * rule this project already keeps for its QR encoder ("verify by decoding,
 * never by looking"). A panel that stamped nothing and drew whatever it liked
 * would pass a structural check; nothing here reads a flag.
 *
 * Three boxes on two panels, chosen so the table's own boundary falls between
 * them: every cell in the *built-in* layout is between 3.8 and 9.7 characters
 * wide, so it takes a calendar given most of a panel to reach the rungs above
 * M0 — and both sides of the boundary have to be measured or "names are drawn"
 * and "names are not drawn" are two tests of the same thing. The box is passed
 * separately from the panel because a widget is whatever size the household
 * dragged it to, which is the whole reason a tier exists.
 *
 * What the panel replaces is `pillMinCell`/`pillMinWidth`, whose width half was
 * 32px — three and a half characters of this font — so a household who asked
 * for labelled cells got "Denti" and "Assem" on every panel in the range. That
 * is a truncation this project's own rule calls a *different string* rather
 * than a shortened title, and it is also a divergence: the wall draws no names
 * in a cell of that width and the panel drew four.
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
      row.push(((byte >> (7 - (x & 7))) & 1) === 0);
    }
    rows.push(row);
  }
  return rows;
}

function ink(
  rows: readonly (readonly boolean[])[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (rows[y]?.[x] === true) n++;
  }
  return n;
}

/* A fixed month, so the grid's geometry is arithmetic rather than a guess. */
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

function fakeManifest(days: ManifestDay[]): Manifest {
  return {
    timezone: 'UTC',
    generatedAt: Date.UTC(2026, 7, 13, 12, 0, 0),
    window: { from: '2026-08-01', to: '2026-09-30' },
    display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true },
    days,
  } as unknown as Manifest;
}

function dayOf(offset: number): string {
  return new Date(Date.parse(`${WEEK_START}T12:00:00Z`) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A busy day in column 1 and a four-day half term over columns 3 to 6.
 *
 * The busy day is column 1 rather than today's, because today's cell is a solid
 * fill and can say nothing about whether names were drawn in it. The run does
 * cross today, which is why the bar below is *found* in the frame rather than
 * placed by column arithmetic — today's fill is ink in the same band.
 */
function busyMonth(): Manifest {
  const half = (date: string): ManifestDay => ({
    date,
    shifts: [],
    events: [ev({ id: 'half', uid: 'half', title: 'Half term', allDay: true, continues: true })],
  });
  return fakeManifest([
    {
      date: dayOf(1),
      shifts: [],
      events: [
        ev({ id: 'a', title: 'Dentist', startsAt: Date.UTC(2026, 7, 10, 9, 0) }),
        ev({ id: 'b', title: 'Football', startsAt: Date.UTC(2026, 7, 10, 17, 0) }),
        ev({ id: 'c', title: 'Book club', startsAt: Date.UTC(2026, 7, 10, 19, 0) }),
        ev({ id: 'd', title: 'Late thing', startsAt: Date.UTC(2026, 7, 10, 21, 0) }),
        ev({ id: 'e2', title: 'One to one', startsAt: Date.UTC(2026, 7, 10, 22, 0) }),
      ],
    },
    half(dayOf(3)),
    half(dayOf(4)),
    half(dayOf(5)),
    half(dayOf(6)),
  ]);
}

/**
 * One month box, decoded, with the geometry the renderer itself used.
 *
 * Every coordinate below comes from `panelMetrics`/`gridMetrics` rather than
 * from a transcription: a measurement's geometry has to follow the renderer it
 * measures, which is the lesson `epaper-geometry` and `epaper-month-spans`
 * both record after transcribing a header height that moved.
 */
function drawn(panel: { readonly w: number; readonly h: number }, box: { readonly w: number; readonly h: number }) {
  const model = buildEpaperModel(busyMonth(), { now: Date.parse(`${TODAY}T12:00:00Z`) });
  const m = panelMetrics({ width: panel.w, height: panel.h });
  const fb = new Framebuffer(box.w, box.h);
  drawMonthBox(fb, model, m, { x: 0, y: 0, w: box.w, h: box.h }, { pills: true });
  const grid = gridMetrics(box.w, box.h - m.monthHeadH, model.weeks.length, m);
  const gridTop = m.monthHeadH + grid.topOffset;
  const gx = Math.floor((box.w - grid.cellW * 7) / 2);
  const assumedNum = Math.min(grid.cellH, grid.cellW) >= m.pillMinCell ? rungStep(m.small, 1) : m.small;
  const cellFoot = Math.round(m.smallGlyph / 4);
  const numberBand = m.cellNumberInset + assumedNum.height + cellFoot;
  const room = grid.cellH - numberBand - cellFoot;
  // The panel's own two measurements, taken off the rung the tier resolved: a
  // cell is `height` tall and `advance` wide including its pixel of tracking.
  const cellEm = m.smallGlyph;
  const cellCh = m.small.advance;
  return {
    rows: decode(encodePng1bit(fb)),
    m,
    grid,
    gridTop,
    gx,
    numberBand,
    room,
    cellEm,
    cellCh,
    tier: tierFor(grid.cellW - m.cellInset * 2, room, cellCh, cellEm),
    names: namesAt(
      tierFor(grid.cellW - m.cellInset * 2, room, cellCh, cellEm),
      room,
      cellEm,
    ),
  };
}

/**
 * Three panels, and the boundary the table draws falls between them.
 *
 * 800x480 is the panel every constant in this renderer was originally tuned on
 * and is where the cells are four characters wide; the other two are what a
 * household who dragged a calendar across a bigger panel actually gets.
 */
const PANELS = [
  {
    label: 'a small calendar widget on a 7.5" panel',
    panel: { w: 800, h: 480 },
    // 260 rather than 200 of height, and the 60px is not slack: a lane for a
    // multi-day bar has to fit under the numeral or no bar is drawn at all, and
    // the label assertion below would then be about a frame with no bar in it.
    box: { w: 300, h: 260 },
  },
  {
    label: 'a 7.5" panel given to the calendar whole',
    panel: { w: 800, h: 480 },
    box: { w: 800, h: 480 },
  },
  {
    label: 'a 13.3" panel given to the calendar whole',
    panel: { w: 1872, h: 1404 },
    box: { w: 1872, h: 1404 },
  },
] as const;

describe('what a panel cell draws is what its tier permits', () => {
  for (const panel of PANELS) {
    it(`${panel.label} (${panel.box.w}x${panel.box.h} of ${panel.panel.w}x${panel.panel.h})`, () => {
      const d = drawn(panel.panel, panel.box);
      const cellCh = (d.grid.cellW - d.m.cellInset * 2) / d.cellCh;
      const cellEm = d.room / d.cellEm;

      /*
       * The names, counted by scanning the cell's own band for lines with ink
       * in them — a line at a time, bounded by the cell, because the line after
       * the last one that fits runs into the next week's border and numeral.
       *
       * **The bound stops one row above the cell**, and that row is the cell's
       * own bottom rule. It was `+ cellH` while the line height happened to
       * leave the last slot clear of it; the type tiers moved the pitch, the
       * last slot reached the border, and the scan reported a rule as a sixth
       * name in a cell the tier permits five. A border is not a name.
       */
      const column = 1;
      const x0 = d.gx + column * d.grid.cellW + d.m.cellInset;
      const x1 = d.gx + (column + 1) * d.grid.cellW - 1;
      const bottom = d.gridTop + d.grid.cellH - 1;
      const glyph = d.m.smallGlyph;
      let lines = 0;
      const top = d.gridTop + d.numberBand + d.m.markH + d.m.markGap;
      for (let y = top; y + glyph <= bottom; y += d.m.cellTitleLineH) {
        if (ink(d.rows, x0, y, x1, y + glyph) > 0) lines += 1;
      }

      expect(
        lines,
        `a ${cellCh.toFixed(2)}ch x ${cellEm.toFixed(2)}em cell is ${d.tier.tier}, which permits ` +
          `${d.names} names, and ${lines} lines of ink were decoded in it`,
      ).toBeLessThanOrEqual(d.names);

      if (d.names === 0) {
        /*
         * And a cell that may name nothing draws nothing rather than a stub.
         *
         * This is the assertion the width guard it replaces could not make:
         * `pillMinWidth` was three and a half characters, so the same cell drew
         * four truncated names and every structural check passed.
         */
        expect(lines, 'a cell the tier says can name nothing drew a line anyway').toBe(0);
        /*
         * …but it is not silent. The density mark is what such a cell says, and
         * it is the same answer the wall's own grid gives at this rung — which
         * is the divergence this closes rather than a coincidence.
         */
        expect(
          ink(d.rows, x0, d.gridTop + d.numberBand, x1, d.gridTop + d.numberBand + d.m.markH),
          'a cell that names nothing drew no density mark either, so it says nothing at all',
        ).toBeGreaterThan(0);
      } else {
        expect(lines, 'the cell drew no names at a tier that permits them').toBeGreaterThan(0);
      }
    });
  }

  it('labels a multi-day bar on the bar’s own width, not on the cell’s', () => {
    /*
     * The one place the table is read against a different box, and the reason
     * it is: a four-day bar on a panel whose cells are four characters wide is
     * sixteen of its own, and "Half term" is the only name that panel's grid
     * has ever had. Asking the cell would take it off the glass.
     *
     * Decoded from the bar's own band, and the discriminator is the *left* of
     * it: a bar is solid ink either way, so what says the words are there is
     * that the ink is *knocked out* — the title is drawn `ink: false`, so a
     * labelled bar has clear pixels inside a solid band and an unlabelled one
     * has none.
     */
    const d = drawn(PANELS[0].panel, PANELS[0].box);
    expect(d.names, 'this box is not the cell-names-nothing case this is about').toBe(0);
    const bar = spanIsLabelled(4 * d.grid.cellW - 2 - d.m.cellInset * 2, d.cellCh);
    expect(bar, 'a four-day bar over these cells is not wide enough for its own words').toBe(true);

    /*
     * The bar is *found* rather than placed, and then read strictly inside its
     * own edges. Both halves earned their place by failing.
     *
     * Placing it meant working out which grid column the run starts in, which
     * is a second opinion about a layout — and it was wrong, because the run
     * crosses today's cell, whose solid fill is ink of its own. And a window
     * that includes the bar's edges reports clear pixels whatever is written
     * in it, because `drawMonthBox` clears a pixel of ground all round each
     * bar. Either way the discriminator could not go red: checked by giving the
     * panel the *cell's* tier instead of the bar's width, which takes the label
     * off the frame entirely, and watching it pass twice.
     */
    const laneTop = d.gridTop + d.numberBand;
    /*
     * The bar's *first* row, not its middle: the title is knocked out of the
     * middle, so a widest-run scan there measures the gap between two letters
     * and reported 84px of a 166px bar. The top row is solid across the whole
     * bar — `drawText` starts a pixel down — and the pixel of clear ground
     * `drawMonthBox` puts round each bar is what stops the run merging with the
     * cells beside it.
     */
    let from = -1;
    let best = { x0: -1, x1: -1 };
    for (let x = 0; x <= d.rows[laneTop]!.length; x++) {
      const lit = d.rows[laneTop]?.[x] === true;
      if (lit && from < 0) from = x;
      if (!lit && from >= 0) {
        if (x - from > best.x1 - best.x0) best = { x0: from, x1: x };
        from = -1;
      }
    }
    expect(
      best.x1 - best.x0,
      'no run of ink wide enough to be a multi-day bar was found in the lane',
    ).toBeGreaterThan(3 * d.grid.cellW);

    const x0 = best.x0 + d.m.cellInset;
    const x1 = best.x1 - d.m.cellInset;
    const solid = ink(d.rows, x0, laneTop + 1, x1, laneTop + d.m.spanBarH - 1);
    const clear = (x1 - x0) * (d.m.spanBarH - 2) - solid;
    expect(solid, 'the run found in the lane is not a filled bar').toBeGreaterThan(0);
    // "Half term" at this scale is nine glyphs of knocked-out ink, so a handful
    // of pixels would be a rounding artefact and this is a word.
    expect(clear, 'the bar is solid ink with no words knocked out of it').toBeGreaterThan(20);
  });

  it('draws the weekday head the tier has room for', () => {
    /*
     * The one part of a cell's form its own contents cannot change, so it is
     * the cleanest thing to hold the tier to. Measured as the *width* of the
     * ink over one column rather than as a string: the renderer draws glyphs,
     * and a test that read a label back out of the model would be asking the
     * model what the model said.
     */
    const small = drawn(PANELS[0].panel, PANELS[0].box);
    const wide = drawn(PANELS[2].panel, PANELS[2].box);
    const widthOf = (d: ReturnType<typeof drawn>): number => {
      const x0 = d.gx + 2 * d.grid.cellW;
      const x1 = d.gx + 3 * d.grid.cellW;
      let left = -1;
      let right = -1;
      for (let x = x0; x < x1; x++) {
        if (ink(d.rows, x, 0, x + 1, d.m.monthHeadH) > 0) {
          if (left < 0) left = x;
          right = x;
        }
      }
      return left < 0 ? 0 : right - left + 1;
    };
    const oneLetter = small.m.label.height;
    expect(small.tier.weekdayLetters, 'the small box is not the one-letter case').toBe(1);
    expect(wide.tier.weekdayLetters, 'the wide box asks for no more letters than the small one')
      .toBeGreaterThan(1);
    expect(
      widthOf(small),
      'a one-letter weekday head is wider than one glyph',
    ).toBeLessThanOrEqual(oneLetter + 2);
    // And the larger panel's head is no *narrower*, which is what says the
    // renderer is reading the tier rather than always cutting to one letter.
    expect(widthOf(wide) / wide.m.label.height).toBeGreaterThanOrEqual(
      widthOf(small) / oneLetter,
    );
  });
});

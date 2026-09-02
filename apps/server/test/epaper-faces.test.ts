/**
 * Three bitmap faces, chosen by tier, and the properties that make them one
 * family rather than three alphabets (RFC 006 phase 11).
 *
 * The panel shipped with **one** 8x8 face at integer scales, so the only type
 * sizes anywhere in a 3.7x range of panels were 8, 16, 24 and 32 pixels — and
 * the role that carries a month cell's event names, a widget's title and every
 * "+N" is `round(body / 2)`, which answers **2 on a 10.3" panel and 2 on a
 * 13.3" one**. At each panel's own read distance that is 12.6 arc-minutes and
 * 9.9: the larger, further screen drew it smaller. `font.ts` carries the
 * measurement and `type-tiers.ts` the table that fixes it.
 *
 * What this file holds, and each of them is a claim the redraw could have
 * quietly lost:
 *
 *  - the art is complete, rectangular, and clear of the column a grade needs;
 *  - **every face has font8x8's own cap height and x-height ratio**, so a rung
 *    swap changes the width and never the size a household reads;
 *  - the grade is the next weight at the *same* advance, gains ink everywhere,
 *    and closes no counter;
 *  - the ladder is monotone in height *and* advance, which a step-down search
 *    depends on;
 *  - the tier boundaries are where the anchored arithmetic says they are;
 *  - and, decoded off real frames at all six supported panel sizes, the face
 *    the frame was drawn in is the face the tier names.
 */
import { describe, expect, it } from 'vitest';
import { addDays, type CivilDate } from '@maverick-wall/core';

import type { Manifest, ManifestDay, ManifestEvent } from '../src/api/manifest.js';
import { drawText, FACES, measureText, rungAt, TYPE_RUNGS, type BitmapFace, type TypeRung } from '../src/epaper/font.js';
import { FACE_12X16, FACE_12X16_HEIGHT, FACE_12X16_WIDTH } from '../src/epaper/font-12x16.js';
import { FACE_16X24, FACE_16X24_HEIGHT, FACE_16X24_WIDTH } from '../src/epaper/font-16x24.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { panelMetrics, type PanelGeometry } from '../src/epaper/metrics.js';
import { epaperBlocks, renderEpaper } from '../src/epaper/render.js';
import {
  bodyHeightTarget,
  tierRungs,
  typeTierFor,
  TYPE_TIERS,
  ANCHOR_BODY_HEIGHT,
  ANCHOR_SHORT_SIDE,
} from '../src/epaper/type-tiers.js';
import { buildEpaperModel } from '../src/epaper/viewmodel.js';

const FIRST = 0x20;
const LAST = 0x7e;
const EVERY = Array.from({ length: LAST - FIRST + 1 }, (_, i) => String.fromCodePoint(FIRST + i));

/** The drawn faces, as the art a person reviews rather than as packed bits. */
const ART = [
  { key: 'f12' as const, art: FACE_12X16, width: FACE_12X16_WIDTH, height: FACE_12X16_HEIGHT },
  { key: 'f16' as const, art: FACE_16X24, width: FACE_16X24_WIDTH, height: FACE_16X24_HEIGHT },
];

/** A glyph's rows as `#`/`.` art, whichever face it came from. */
function rowsOf(face: BitmapFace, ch: string): string[] {
  const base = ((ch.codePointAt(0) ?? FIRST) - FIRST) * face.height;
  const out: string[] = [];
  for (let r = 0; r < face.height; r++) {
    const bits = face.rows[base + r] as number;
    let line = '';
    for (let c = 0; c < face.width; c++) line += (bits >> c) & 1 ? '#' : '.';
    out.push(line);
  }
  return out;
}

/** The rows a glyph inks, first and last. */
function band(rows: readonly string[]): { first: number; last: number } {
  const inked = rows.map((r, i) => (r.includes('#') ? i : -1)).filter((i) => i >= 0);
  return { first: inked[0] ?? -1, last: inked[inked.length - 1] ?? -1 };
}

/** The one-pixel horizontal dilation `drawText` applies to reversed runs. */
function graded(rows: readonly string[], width: number): string[] {
  return rows.map((r) => {
    let out = '';
    for (let c = 0; c < width; c++) out += r[c] === '#' || (c > 0 && r[c - 1] === '#') ? '#' : '.';
    return out;
  });
}

/**
 * The enclosed white regions of a glyph — its counters.
 *
 * Flood-filled from the cell's border, so what is left is white that ink
 * surrounds: the bowl of an 'o', the eye of an 'e', both holes of an '8'. A
 * grade that closes one turns a letter into a blob, which is the one thing a
 * "did it get heavier" check cannot see.
 */
function counters(rows: readonly string[], w: number, h: number): [number, number][][] {
  const ink = rows.map((r) => [...r].map((c) => c === '#'));
  const outside = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  const stack: [number, number][] = [];
  for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (outside[y]![x] === true || ink[y]![x] === true) continue;
    outside[y]![x] = true;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const seen = Array.from({ length: h }, () => new Array<boolean>(w).fill(false));
  const found: [number, number][][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ink[y]![x] === true || outside[y]![x] === true || seen[y]![x] === true) continue;
      const region: [number, number][] = [];
      const walk: [number, number][] = [[x, y]];
      while (walk.length > 0) {
        const [a, b] = walk.pop() as [number, number];
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        if (ink[b]![a] === true || outside[b]![a] === true || seen[b]![a] === true) continue;
        seen[b]![a] = true;
        region.push([a, b]);
        walk.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
      }
      found.push(region);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The art
// ---------------------------------------------------------------------------

describe('the drawn faces are complete and rectangular', () => {
  for (const face of ART) {
    it(`${face.key} carries every code point from 0x20 to 0x7E`, () => {
      expect(Object.keys(face.art).sort()).toEqual([...EVERY].sort());
    });

    it(`${face.key} is ${face.width} by ${face.height} in every glyph`, () => {
      for (const ch of EVERY) {
        const rows = face.art[ch] as readonly string[];
        expect(rows.length, `${JSON.stringify(ch)} rows`).toBe(face.height);
        for (const row of rows) {
          expect(row.length, `${JSON.stringify(ch)} row "${row}"`).toBe(face.width);
          expect(/^[.#]*$/.test(row), `${JSON.stringify(ch)} row "${row}"`).toBe(true);
        }
      }
    });

    it(`${face.key} draws something for everything but the space`, () => {
      for (const ch of EVERY) {
        const rows = face.art[ch] as readonly string[];
        const hasInk = rows.some((r) => r.includes('#'));
        expect(hasInk, `${JSON.stringify(ch)} is blank`).toBe(ch === ' ' ? false : true);
      }
    });

    it(`${face.key} leaves the last column clear, so a grade stays in the cell`, () => {
      /*
       * The grade is `row | (row << 1)`. Ink in the last column would leave the
       * cell, and a cell that grows is a metric change — which is a reflow, and
       * reflow is what forecloses partial refresh.
       */
      for (const ch of EVERY) {
        const rows = face.art[ch] as readonly string[];
        for (const row of rows) {
          expect(row[face.width - 1], `${JSON.stringify(ch)} inks its last column`).toBe('.');
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// One family, not three alphabets
// ---------------------------------------------------------------------------

describe('every face has the shipped 8x8 face own proportions', () => {
  /*
   * **This is the assertion the first draft of the redraw failed**, and it cost
   * a whole second pass at 190 glyphs to find it. The faces were drawn with an
   * 11-row cap in a 16-row cell and a 17-row cap in a 24-row one, which is 69%
   * and 71% where font8x8 is 87.5% — so at the same line box a household's
   * event titles would have come out **21% shorter** than the face they
   * replace. A face that says more per line and less per letter is the opposite
   * of what this phase is for. Nothing in an ink-density or a row-count check
   * can see it: the rows are where they were and the words are the same words.
   */
  const CAP_OF_CELL = 7 / 8;
  const X_OF_CAP = 5 / 7;

  for (const key of ['f8', 'f12', 'f16'] as const) {
    it(`${key} puts a cap in ${(CAP_OF_CELL * 100).toFixed(1)}% of its cell`, () => {
      const face = FACES[key];
      const cap = band(rowsOf(face, 'A'));
      expect(cap.first, `${key} 'A' starts below the cell's top`).toBe(0);
      expect(cap.last - cap.first + 1).toBe(Math.round(face.height * CAP_OF_CELL));
    });

    it(`${key} puts an x-height at ${X_OF_CAP.toFixed(2)} of its cap`, () => {
      const face = FACES[key];
      const cap = band(rowsOf(face, 'A'));
      const x = band(rowsOf(face, 'x'));
      const capH = cap.last - cap.first + 1;
      const xH = x.last - x.first + 1;
      expect(xH).toBe(Math.round(capH * X_OF_CAP));
      // …and they sit on one baseline, or a line of mixed case is a staircase.
      expect(x.last, `${key} 'x' does not share 'A's baseline`).toBe(cap.last);
    });

    it(`${key} descends below that baseline and no further than its cell`, () => {
      const face = FACES[key];
      const baseline = band(rowsOf(face, 'A')).last;
      for (const ch of ['g', 'j', 'p', 'q', 'y']) {
        const tail = band(rowsOf(face, ch));
        expect(tail.last, `${key} '${ch}' does not descend`).toBeGreaterThan(baseline);
        expect(tail.last, `${key} '${ch}' runs out of its cell`).toBeLessThan(face.height);
      }
    });
  }
});

describe('the row byte convention', () => {
  /*
   * The least significant bit is the leftmost column. A face packed the other
   * way round renders every glyph mirrored, which passes any "did it draw
   * something" check — so each face is verified against a shape read out by
   * hand rather than against a hash.
   */
  it("reads the canonical font8x8 'A' the right way round", () => {
    // 0C 1E 33 33 3F 33 33 00, LSB = leftmost.
    expect(rowsOf(FACES.f8, 'A')).toEqual([
      '..##....',
      '.####...',
      '##..##..',
      '##..##..',
      '######..',
      '##..##..',
      '##..##..',
      '........',
    ]);
  });

  for (const face of ART) {
    it(`packs ${face.key}'s art back to the same art`, () => {
      // Character by character rather than as a digest: a hash that disagrees
      // says nothing about which glyph, and a face has ninety-five of them.
      for (const ch of EVERY) {
        expect(rowsOf(FACES[face.key], ch), `${face.key} ${JSON.stringify(ch)}`).toEqual([
          ...(face.art[ch] as readonly string[]),
        ]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The grade
// ---------------------------------------------------------------------------

describe('the grade is the next weight at the same cell', () => {
  /*
   * Reversed type is the panel's dark theme, and on e-paper the black bleeds
   * into the white — so a light stroke knocked out of a filled ground closes
   * up. The correction is the browser wall's `--f-grade`: thicken the stroke
   * without moving the advance. **A metric change is a reflow, and reflow is
   * what forecloses partial refresh**, so "the same cell" is the load-bearing
   * half of this and is asserted first.
   */
  for (const face of ART) {
    it(`${face.key} grades without moving an advance`, () => {
      const rung = TYPE_RUNGS.find((r) => r.face === face.key) as TypeRung;
      for (const tracking of [0, 1, 2]) {
        expect(measureText('Half term', { rung, tracking, ink: false })).toBe(
          measureText('Half term', { rung, tracking, ink: true }),
        );
      }
    });

    it(`${face.key} gains ink in every glyph that has any`, () => {
      for (const ch of EVERY) {
        if (ch === ' ') continue;
        const rows = face.art[ch] as readonly string[];
        const before = rows.join('').split('#').length - 1;
        const after = graded(rows, face.width).join('').split('#').length - 1;
        expect(after, `${face.key} ${JSON.stringify(ch)} did not thicken`).toBeGreaterThan(before);
      }
    });

    it(`${face.key} closes no counter`, () => {
      for (const ch of EVERY) {
        const rows = face.art[ch] as readonly string[];
        const heavy = graded(rows, face.width);
        const heavyInk = heavy.map((r) => [...r].map((c) => c === '#'));
        for (const region of counters(rows, face.width, face.height)) {
          const open = region.some(([x, y]) => heavyInk[y]![x] === false);
          expect(open, `${face.key} ${JSON.stringify(ch)} loses a counter to the grade`).toBe(true);
        }
      }
    });

    it(`${face.key} stays inside its cell when graded`, () => {
      for (const ch of EVERY) {
        const rows = face.art[ch] as readonly string[];
        for (const row of graded(rows, face.width)) {
          expect(row.length).toBe(face.width);
        }
      }
    });
  }

  /*
   * ---------------------------------------------------------------------
   * …and the renderer actually applies it.
   * ---------------------------------------------------------------------
   *
   * Everything above measures the *art* through this file's own `graded()`,
   * which is a reimplementation of the rule — so a `drawText` that stopped
   * grading altogether would leave every one of those assertions green.
   * Checked by doing exactly that: replacing `raw | (raw << 1)` with `raw`
   * turns nothing above red and turns the three below red at once.
   */
  describe('as the renderer draws it', () => {
    const RUNG = TYPE_RUNGS.find((r) => r.face === 'f12') as TypeRung;
    const WORDS = 'Half term';

    /** White pixels in a run knocked out of a filled ground. */
    const knockedOut = (options: { readonly grade?: boolean }): number => {
      const fb = new Framebuffer(240, 40);
      fb.fillRect(0, 0, 240, 40, true);
      drawText(fb, 4, 4, WORDS, { rung: RUNG, ink: false, ...options });
      let clear = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 240; x++) if (!fb.get(x, y)) clear += 1;
      return clear;
    };

    it('draws a reversed run heavier than the same run told not to grade', () => {
      expect(knockedOut({})).toBeGreaterThan(knockedOut({ grade: false }));
    });

    it('leaves an ordinary run alone, because the ground is what asks for it', () => {
      const drawn = (options: { readonly grade?: boolean }): number => {
        const fb = new Framebuffer(240, 40);
        drawText(fb, 4, 4, WORDS, { rung: RUNG, ...options });
        let ink = 0;
        for (let y = 0; y < 40; y++) for (let x = 0; x < 240; x++) if (fb.get(x, y)) ink += 1;
        return ink;
      };
      // Ink on white is not graded…
      expect(drawn({})).toBe(drawn({ grade: false }));
      // …and asking for it explicitly still works, or the default is the only
      // behaviour there is and "follows the ground" is not a rule.
      expect(drawn({ grade: true })).toBeGreaterThan(drawn({}));
    });

    it('moves no advance doing it, which is the whole of "same cell"', () => {
      const end = (options: { readonly ink?: boolean }): number => {
        const fb = new Framebuffer(240, 40);
        return drawText(fb, 4, 4, WORDS, { rung: RUNG, ...options });
      };
      expect(end({ ink: false })).toBe(end({ ink: true }));
      expect(end({ ink: false })).toBe(4 + measureText(WORDS, { rung: RUNG }));
    });
  });

  it('leaves the 8x8 face alone, because it has no room for a weight above it', () => {
    /*
     * Measured rather than assumed: font8x8 has 1px stems and 1px counters, and
     * swept over all 95 glyphs a one-pixel grade closes a counter in three of
     * them ('#', '&' twice) while two more already carry ink in the last column,
     * where the dilation would leave the cell. So `f8.graded` is false and a
     * reversed run at that rung draws exactly what the panel draws today.
     */
    expect(FACES.f8.graded).toBe(false);
    expect(FACES.f12.graded).toBe(true);
    expect(FACES.f16.graded).toBe(true);

    let closes = 0;
    let overflows = 0;
    for (const ch of EVERY) {
      const rows = rowsOf(FACES.f8, ch);
      if (rows.some((r) => r[7] === '#')) overflows += 1;
      const heavy = graded(rows, 8).map((r) => [...r].map((c) => c === '#'));
      for (const region of counters(rows, 8, 8)) {
        if (!region.some(([x, y]) => heavy[y]![x] === false)) closes += 1;
      }
    }
    expect(closes, 'the 8x8 would lose counters to a grade').toBeGreaterThan(0);
    expect(overflows, 'the 8x8 already fills its own cell').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The ladder and the tiers
// ---------------------------------------------------------------------------

describe('the type ladder', () => {
  it('is strictly increasing in height and in advance together', () => {
    /*
     * Not decoration: `rungToFit` and `fitNumberRung` walk down the ladder
     * until a string fits, so a shorter rung has to be a narrower one. Left
     * unsorted the ladder contains `f8@5` — 40px tall at 45px of advance —
     * sitting between `f16@1` (24/17) and `f16@2` (48/34), where stepping
     * *down* makes the text wider and the search never converges.
     */
    for (let i = 1; i < TYPE_RUNGS.length; i++) {
      const below = TYPE_RUNGS[i - 1] as TypeRung;
      const rung = TYPE_RUNGS[i] as TypeRung;
      expect(rung.height, `rung ${i} height`).toBeGreaterThan(below.height);
      expect(rung.advance, `rung ${i} advance`).toBeGreaterThan(below.advance);
      expect(rung.index).toBe(i);
    }
  });

  it('states each rung as its face times a whole number', () => {
    for (const rung of TYPE_RUNGS) {
      const face = FACES[rung.face];
      expect(Number.isInteger(rung.scale) && rung.scale >= 1).toBe(true);
      expect(rung.height).toBe(face.height * rung.scale);
      expect(rung.advance).toBe((face.width + 1) * rung.scale);
    }
  });

  it('reaches every height the 8x8 reached, and each of them narrower', () => {
    // The four heights the shipped ladder produced across the supported range,
    // with the advance the 8x8 needed for each.
    for (const [height, was] of [[8, 9], [16, 18], [24, 27], [32, 36], [48, 54]] as const) {
      const rung = TYPE_RUNGS.find((r) => r.height === height) as TypeRung;
      expect(rung, `no rung at ${height}px`).toBeDefined();
      expect(rung.advance, `${height}px is no narrower than the 8x8's ${was}`).toBeLessThanOrEqual(was);
    }
  });
});

describe('the tier table', () => {
  it('is anchored on the panel the layout was tuned on', () => {
    expect(bodyHeightTarget(ANCHOR_SHORT_SIDE)).toBe(ANCHOR_BODY_HEIGHT);
    const anchor = tierRungs(typeTierFor(ANCHOR_SHORT_SIDE));
    expect(anchor.tier).toBe('E1');
    expect(anchor.body.height).toBe(ANCHOR_BODY_HEIGHT);
  });

  it('puts every boundary where the anchored arithmetic says it is', () => {
    /*
     * The table is a table so that a tier can be *named* — it is in the frame's
     * ETag — but the rows are not free. Each boundary is the first short side
     * at which the rung nearest `16 * (short / 480) ** 0.6` changes, and this
     * walks the whole supported range rather than spot-checking, so a row
     * edited by eye fails here rather than on somebody's panel.
     */
    const nearest = (px: number): number => {
      let best = 0;
      for (const rung of TYPE_RUNGS) {
        if (Math.abs(rung.height - px) < Math.abs((TYPE_RUNGS[best] as TypeRung).height - px)) {
          best = rung.index;
        }
      }
      return best;
    };
    const floor = (TYPE_TIERS[0] as { body: number }).body;
    for (let short = 64; short <= 4600; short += 1) {
      const want = Math.max(floor, nearest(bodyHeightTarget(short)));
      expect(typeTierFor(short).body, `short side ${short}`).toBe(want);
    }
  });

  it('floors at E1, so the smallest panels keep the type they have', () => {
    // A 2.9" panel is 296x128 and resolves to a 7px target. The shipped ladder
    // clamped its body scale to 2 for exactly this reason; the floor is that
    // clamp, restated as a tier.
    expect(typeTierFor(128).tier).toBe('E1');
    expect(tierRungs(typeTierFor(128)).body.height).toBe(16);
  });

  it('never collapses a role onto one value for two tiers', () => {
    /*
     * The fault, in one assertion. `round(body / 2)` answered 2 on a 10.3"
     * panel and 2 on a 13.3" one; an offset on a strictly-increasing ladder
     * cannot, so a panel a tier up draws every role larger than the tier below.
     */
    for (let i = 1; i < TYPE_TIERS.length; i++) {
      const below = tierRungs(TYPE_TIERS[i - 1] as never);
      const above = tierRungs(TYPE_TIERS[i] as never);
      for (const role of ['body', 'header', 'year', 'label', 'small'] as const) {
        expect(above[role].height, `${role} at ${above.tier}`).toBeGreaterThan(below[role].height);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Decoded off real frames
// ---------------------------------------------------------------------------

function ev(over: Partial<ManifestEvent>): ManifestEvent {
  return {
    id: 'e', uid: 'e', title: 'Event', startsAt: 0, endsAt: 0, allDay: false,
    sourceId: 's', color: '#000', status: 'confirmed', continues: false, ...over,
  };
}

const TODAY: CivilDate = '2026-08-13';

function atHour(date: CivilDate, hour: number): number {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return Date.UTC(y as number, (m ?? 1) - 1, d ?? 1, hour, 0, 0);
}

const DAYS: readonly ManifestDay[] = Array.from({ length: 30 }, (_, index) => {
  const date = addDays(TODAY, index - 2);
  return {
    date,
    shifts: [],
    events: [
      ev({ id: `${date}-a`, uid: `${date}-a`, title: 'Swimming lesson', startsAt: atHour(date, 9), endsAt: atHour(date, 10) }),
      ev({ id: `${date}-b`, uid: `${date}-b`, title: 'Parents evening', startsAt: atHour(date, 18), endsAt: atHour(date, 19) }),
    ],
  };
});

const MANIFEST = {
  timezone: 'UTC',
  generatedAt: atHour(TODAY, 12),
  window: { from: DAYS[0]?.date, to: DAYS[DAYS.length - 1]?.date },
  display: { todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: [], clock24: true, weekStart: 'monday' },
  days: DAYS,
} as unknown as Manifest;

const SIZES: readonly PanelGeometry[] = [
  { width: 640, height: 384 },
  { width: 800, height: 480 },
  { width: 1304, height: 984 },
  { width: 1872, height: 1404 },
  { width: 480, height: 800 },
  { width: 1404, height: 1872 },
];

/** Any ink in a rectangle of the decoded frame. */
function inkRow(fb: Framebuffer, y: number, x0: number, x1: number): boolean {
  for (let x = Math.max(0, x0); x < Math.min(fb.width, x1); x++) if (fb.get(x, y)) return true;
  return false;
}

/**
 * The height of the first run of inked rows below `from`, in a column window.
 *
 * The frame's own "TODAY" rule is what this is pointed at: all capitals, drawn
 * at the body rung at a known corner, with the section's hairline a whole line
 * box below it. So the run it finds is exactly one cap of the body face, which
 * is the measurement that names the rung — and through the rung, the face.
 */
function capBelow(fb: Framebuffer, from: number, x0: number, x1: number): number {
  let y = from;
  while (y < fb.height && !inkRow(fb, y, x0, x1)) y += 1;
  let height = 0;
  while (y + height < fb.height && inkRow(fb, y + height, x0, x1)) height += 1;
  return height;
}

describe('the face a frame is drawn in is the face its tier names', () => {
  for (const size of SIZES) {
    const key = `${size.width}x${size.height}`;
    it(`${key} draws its agenda in the tier's own body rung`, () => {
      const m = panelMetrics(size);
      const model = buildEpaperModel(MANIFEST);
      const fb = renderEpaper(model, size);
      const box = epaperBlocks(model.weeks.length, m).agenda;
      const label = measureText('TODAY', { rung: m.body, tracking: 2 });
      const cap = capBelow(fb, box.y, box.x, box.x + label);

      // Every face keeps font8x8's 87.5% cap, so a drawn cap names a rung.
      const wanted = Math.round(m.body.height * 7) / 8;
      expect(cap, `${key}: "TODAY" is ${cap}px of cap`).toBe(Math.round(wanted));

      const drawnIn = TYPE_RUNGS.filter((r) => Math.round((r.height * 7) / 8) === cap);
      expect(drawnIn.map((r) => `${r.face}@${r.scale}`)).toContain(`${m.body.face}@${m.body.scale}`);
      expect(m.tier).toBe(typeTierFor(Math.min(size.width, size.height)).tier);
    });
  }

  it('draws a materially larger title on a 13.3" panel than on a 7.5" one', () => {
    /*
     * The sentence this phase is named for, decoded rather than argued.
     *
     * The **body** was already twice the size on the larger panel and still is:
     * 14px of cap against 28px. What moved is the rung below it — the role that
     * carries a month cell's names, a widget's title and every "+N" — which was
     * `round(body / 2)` and so answered the *same 16px* on a 10.3" panel and a
     * 13.3" one. It is a rung below the body now, on a ladder that strictly
     * increases, so the 13.3" panel draws it at 24px where the 7.5" draws 8:
     * three times, where it used to be twice.
     */
    const small = panelMetrics({ width: 800, height: 480 });
    const large = panelMetrics({ width: 1872, height: 1404 });

    const capOf = (rung: TypeRung): number => Math.round((rung.height * 7) / 8);
    expect(capOf(large.body) / capOf(small.body)).toBe(2);
    expect(capOf(large.small) / capOf(small.small)).toBe(3);

    // …and the frame agrees with the metric, which is the half a table cannot
    // claim on its own.
    const model = buildEpaperModel(MANIFEST);
    const read = (panel: PanelGeometry, m: ReturnType<typeof panelMetrics>): number => {
      const fb = renderEpaper(model, panel);
      const box = epaperBlocks(model.weeks.length, m).agenda;
      return capBelow(fb, box.y, box.x, box.x + measureText('TODAY', { rung: m.body, tracking: 2 }));
    };
    const drawnSmall = read({ width: 800, height: 480 }, small);
    const drawnLarge = read({ width: 1872, height: 1404 }, large);
    expect(drawnLarge).toBeGreaterThan(drawnSmall);
    expect(drawnLarge / drawnSmall).toBe(2);
  });

  it('draws every rung in a face this build ships', () => {
    for (const size of SIZES) {
      const m = panelMetrics(size);
      for (const rung of [m.body, m.header, m.year, m.label, m.small]) {
        expect(FACES[rung.face], `${size.width}x${size.height} ${rung.face}`).toBeDefined();
        expect(rungAt(rung.index).face).toBe(rung.face);
      }
    }
  });
});

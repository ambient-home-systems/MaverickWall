import { describe, expect, it } from 'vitest';

import {
  CALENDAR_TIERS,
  LABEL_MIN_CH,
  MAX_LINES,
  MAX_NAMES,
  TIER_NAMES,
  linesAt,
  listRowsAt,
  namesAt,
  promoted,
  spanIsLabelled,
  tierFor,
  tierNamed,
  weekdayHead,
} from '../src/tiers.js';

/**
 * The tier table's own rules, in the units it is stated in.
 *
 * Every case here names a box in `ch` and `em` and converts, rather than
 * writing a pixel count: the whole claim of this table is that it is stated in
 * the reader's own units, and a test written in pixels would be asserting one
 * screen's arithmetic back at itself.
 */

/** A box `ch` wide and `em` tall, at a plausible event role of 20px. */
const EM = 20;
const CH = 10;
const box = (ch: number, em: number): { w: number; h: number } => ({ w: ch * CH, h: em * EM });
const at = (ch: number, em: number): string => tierFor(box(ch, em).w, box(ch, em).h, CH, EM).tier;

describe('which tier a box affords', () => {
  it('reads the table, both dimensions', () => {
    expect(at(30, 30)).toBe('M4');
    expect(at(22, 10)).toBe('M4');
    expect(at(16, 7.5)).toBe('M3');
    expect(at(12, 5)).toBe('M2');
    expect(at(9, 3)).toBe('M1');
    expect(at(8.9, 3)).toBe('M0');
    expect(at(9, 2.9)).toBe('M0');
  });

  it('is held to the smaller of its two dimensions', () => {
    // A tall narrow column is as much M1 as a short wide one: a name needs
    // width to be a name and height to be a row, and the table says so twice.
    expect(at(9, 40)).toBe('M1');
    expect(at(40, 3)).toBe('M1');
    expect(at(40, 7.5)).toBe('M3');
    expect(at(16, 40)).toBe('M3');
  });

  it('takes the floor rather than throwing on a box nothing has measured', () => {
    // Rule nine: a widget rendered before layout, or inside a zero-height
    // preview, must draw the quiet grid rather than nothing at all.
    expect(tierFor(0, 0, CH, EM).tier).toBe('M0');
    expect(tierFor(400, 400, 0, EM).tier).toBe('M0');
    expect(tierFor(400, 400, CH, 0).tier).toBe('M0');
    expect(tierFor(Number.NaN, 400, CH, EM).tier).toBe('M0');
  });

  it('reads a box built to sit exactly on a threshold as reaching it', () => {
    /*
     * Both terms are a division of two measured pixel counts, so a cell built
     * to be exactly 9ch lands a hair under about half the time. Without the
     * whisker the identical wall draws two different tiers on two loads, which
     * is the font race in a different costume.
     */
    const width = 9 * CH - 1e-9;
    expect(tierFor(width, 3 * EM, CH, EM).tier).toBe('M1');
  });
});

describe('how many names a tier draws', () => {
  it('is the table, in the box each rung is stated for', () => {
    expect(namesAt(tierNamed('M0'), 100 * EM, EM)).toBe(0);
    expect(namesAt(tierNamed('M1'), 3 * EM, EM)).toBe(1);
    expect(namesAt(tierNamed('M2'), 5 * EM, EM)).toBe(3);
    expect(namesAt(tierNamed('M3'), 7.5 * EM, EM)).toBe(5);
  });

  it('grows with the box at M4, which is the whole point of the file', () => {
    // At its own threshold M4 is the table's six; a taller column shows more,
    // which is the sentence "a box with more room shows more things" as an
    // assertion. Pinning the top rung's allowance back to `tier.names` turns
    // this red at both larger heights.
    expect(namesAt(tierNamed('M4'), 10 * EM, EM)).toBe(6);
    expect(namesAt(tierNamed('M4'), 14 * EM, EM)).toBe(8);
    expect(namesAt(tierNamed('M4'), 20 * EM, EM)).toBe(12);
  });

  it('lets surplus height buy rows, up to what the height alone would afford', () => {
    /*
     * The 13.3" panel's cell: M1 by width and tall enough for six rows. Held to
     * M1's literal one name it draws one where it draws seven today. And the
     * ceiling is the height's own tier rather than the sky — a 3em-tall M1 cell
     * still draws exactly one, which is the table.
     */
    expect(namesAt(tierNamed('M1'), 3 * EM, EM)).toBe(1);
    expect(namesAt(tierNamed('M1'), 5 * EM, EM)).toBe(2);
    expect(namesAt(tierNamed('M1'), 10.94 * EM, EM)).toBe(6);
    // The in-between box: 4.33em is the shipped portrait wall's own cell, half
    // again the rung it sits on and short of the next. It holds two rows and
    // draws two — a ceiling taken from the rung would draw one and leave the
    // room empty, which is the fault this whole file is about.
    expect(namesAt(tierNamed('M1'), 4.33 * EM, EM)).toBe(2);
    // Never below the tier's own number, however short the box: M3 promises
    // five and a box that has already been classified M3 keeps them.
    expect(namesAt(tierNamed('M3'), 7.5 * EM, EM)).toBe(5);
    expect(namesAt(tierNamed('M3'), 3 * EM, EM)).toBe(5);
  });

  it('never names more than a cell whose height is the only thing left', () => {
    // A very tall M0 cell still names nothing: width is what decides whether a
    // name would be a name, and no amount of height buys a legible one.
    expect(namesAt(tierNamed('M0'), 40 * EM, EM)).toBe(0);
  });

  it('stops where the model does', () => {
    // A thirteenth name is not something a bigger box can buy: the model's own
    // per-cell list stops at twelve, so a larger number here would be a
    // promise the manifest cannot keep.
    expect(namesAt(tierNamed('M4'), 400 * EM, EM)).toBe(MAX_NAMES);
  });

  it('draws strictly more at every rung, each measured in its own box', () => {
    /*
     * The ladder is monotonic, which is what makes "double the box and the
     * count goes up" a property of the table rather than of one fixture. Each
     * rung is asked in the box it is defined for, because that is what doubling
     * an area does — it clears the next threshold in *both* directions, which
     * is a different question from holding the height still and stepping the
     * width.
     */
    const counts = CALENDAR_TIERS.map((tier) => namesAt(tier, Math.max(tier.minEm, 0.1) * EM, EM));
    for (let index = 1; index < counts.length; index++) {
      expect(counts[index], `${TIER_NAMES[index] ?? ''} draws no more than the rung below it`)
        .toBeGreaterThan(counts[index - 1] as number);
    }
  });
});

describe('how many lines a name may wrap to', () => {
  it('is one line at M1 in the cell the table describes', () => {
    expect(linesAt(tierNamed('M1'), 3 * EM, EM)).toBe(1);
  });

  it('spends surplus height on the second line, and that is the shipped wall', () => {
    /*
     * The Classic portrait month cell measures 8.6ch by 5.1em on a 1080x1920
     * wall — under M1's width and well over its height. Held to the table's
     * literal "one line" there, the grid stops drawing every title that needs
     * two, which it draws today. The surplus is real height under the numeral
     * and the wrap allowance is the only thing in a cell that can absorb it.
     */
    expect(linesAt(tierNamed('M1'), 5.1 * EM, EM)).toBe(2);
  });

  it('never goes past the grid\u2019s own maximum', () => {
    expect(linesAt(tierNamed('M2'), 100 * EM, EM)).toBe(MAX_LINES);
    expect(linesAt(tierNamed('M4'), 100 * EM, EM)).toBe(MAX_LINES);
  });

  it('is no lines where there are no names', () => {
    expect(linesAt(tierNamed('M0'), 100 * EM, EM)).toBe(0);
  });
});

describe('promotion', () => {
  it('moves one rung and clamps at both ends', () => {
    expect(promoted(tierNamed('M0'), 1).tier).toBe('M1');
    expect(promoted(tierNamed('M3'), 1).tier).toBe('M4');
    expect(promoted(tierNamed('M4'), 1).tier).toBe('M4');
    expect(promoted(tierNamed('M0'), -1).tier).toBe('M0');
    expect(promoted(tierNamed('M4'), -2).tier).toBe('M2');
    expect(promoted(tierNamed('M2'), 0).tier).toBe('M2');
  });
});

describe('a list, which is not a cell', () => {
  it('always draws one row, however small the box', () => {
    // Rule nine. A month cell with no room has the density mark to say the day
    // is busy; a list with no rows is a heading over an empty rectangle.
    expect(listRowsAt(tierNamed('M0'), 0.1 * EM, EM)).toBe(1);
    expect(listRowsAt(tierNamed('M1'), 3 * EM, EM)).toBe(1);
    expect(listRowsAt(tierNamed('M3'), 8 * EM, EM)).toBe(5);
  });
});

describe('a span bar, which is measured as itself', () => {
  it('is labelled on its own width and not on the cell beneath it', () => {
    /*
     * The measurement this rule exists for: a 7.5" e-ink panel at 800x480 has
     * 4.7ch cells and a five-day bar 26ch wide. Asking the cell would take the
     * only name either e-ink panel has on its grid off the glass.
     */
    expect(spanIsLabelled(LABEL_MIN_CH * CH, CH)).toBe(true);
    expect(spanIsLabelled(5 * 4.7 * CH, CH)).toBe(true);
    expect(spanIsLabelled(4.7 * CH, CH)).toBe(false);
    expect(spanIsLabelled(100, 0)).toBe(false);
  });
});

describe('the weekday head', () => {
  it('cuts the short name, or hands back the long one', () => {
    expect(weekdayHead('Mon', 'Monday', 1)).toBe('M');
    expect(weekdayHead('Mon', 'Monday', 3)).toBe('Mon');
    expect(weekdayHead('Mon', 'Monday', 0)).toBe('Monday');
  });

  it('falls back to the short name when a manifest carries no long one', () => {
    // A wall that has been hanging for months may be drawing a document
    // written by an older bundle, which carried one weekday and not two.
    expect(weekdayHead('Mon', '', 0)).toBe('Mon');
  });
});

describe('the table itself', () => {
  it('names every rung once, in order, smallest first', () => {
    expect(CALENDAR_TIERS.map((tier) => tier.tier)).toEqual([...TIER_NAMES]);
  });

  it('never asks for less room than the rung below it', () => {
    for (let index = 1; index < CALENDAR_TIERS.length; index++) {
      const lower = CALENDAR_TIERS[index - 1] as (typeof CALENDAR_TIERS)[number];
      const upper = CALENDAR_TIERS[index] as (typeof CALENDAR_TIERS)[number];
      expect(upper.minCh).toBeGreaterThan(lower.minCh);
      expect(upper.minEm).toBeGreaterThan(lower.minEm);
    }
  });

  it('draws a multi-day event once at every rung, M0 included', () => {
    /*
     * The one place this table deviates from the brief it was written from,
     * pinned so the deviation is a decision rather than a drift. See the
     * table's own docstring for the measurement.
     */
    expect(CALENDAR_TIERS.every((tier) => tier.spans)).toBe(true);
  });

  it('marks an all-day event at the cell edge only where there is no row', () => {
    expect(tierNamed('M0').allDay).toBe('edge');
    for (const name of ['M1', 'M2', 'M3', 'M4'] as const) {
      expect(tierNamed(name).allDay).toBe('bar');
    }
  });

  it('takes the floor for a rung this build does not know', () => {
    // A stored value from a newer bundle, or a hand-edited row. Never a throw
    // and never an undefined tier: the quiet grid is the safe answer.
    expect(tierNamed('M9').tier).toBe('M0');
    expect(tierNamed('').tier).toBe('M0');
  });
});

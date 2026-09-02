/**
 * The six widgets' density tables, as arithmetic.
 *
 * `tiers.test.ts` does this for the calendar. The value of a pure table is that
 * it can be argued about against numbers rather than a screenshot, so this is
 * where the *shape* of each ladder is pinned; whether a real wall draws what
 * they say is `browser-widget-tiers.test.ts`, which measures pixels.
 *
 * The thresholds themselves are measured values and deliberately not asserted
 * here as literals — a test that re-types the table is a test that agrees with
 * itself. What is asserted is everything a table has to be true of whatever the
 * numbers are: every rung a real step up, no rung ever silent, the household's
 * own list never lengthened, and the two rules the ladder brought with it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHORE_TIERS,
  HOUSE_TIERS,
  NOTES_TIERS,
  SHIFT_TIERS,
  TODO_TIERS,
  WEATHER_COLUMN_CH,
  WEATHER_TIERS,
  WIDGET_TIERS,
  WIDGET_TIER_NAMES,
  columnsAt,
  itemsAt,
  laddersToOneLine,
  rungsAt,
  rungsByPriority,
  widgetTierFor,
} from '../src/widget-tiers.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const TABLES = [
  ['weather', WEATHER_TIERS],
  ['shift', SHIFT_TIERS],
  ['homeassistant', HOUSE_TIERS],
  ['notes', NOTES_TIERS],
  ['todo', TODO_TIERS],
  ['chores', CHORE_TIERS],
] as const;

describe('every table is a ladder', () => {
  for (const [name, table] of TABLES) {
    it(`${name}: names its rungs in order and never goes backwards`, () => {
      expect(table.map((tier) => tier.tier)).toEqual([...WIDGET_TIER_NAMES]);
      for (let at = 1; at < table.length; at++) {
        const above = table[at]!;
        const below = table[at - 1]!;
        expect(above.minCh, `${name} ${above.tier} needs less width than ${below.tier}`)
          .toBeGreaterThanOrEqual(below.minCh);
        expect(above.minEm, `${name} ${above.tier} needs less height than ${below.tier}`)
          .toBeGreaterThanOrEqual(below.minEm);
        expect(above.items).toBeGreaterThanOrEqual(below.items);
        expect(above.rungs).toBeGreaterThanOrEqual(below.rungs);
      }
    });

    it(`${name}: draws at least one of whatever it is a list of`, () => {
      // Rule nine, at the floor: a widget that resolves to nothing is the one
      // outcome forbidden, and a household who dragged a box too small should
      // see the thing at the top of it.
      for (const tier of table) expect(itemsAt(tier, 0)).toBeGreaterThanOrEqual(1);
      expect(itemsAt(table[0]!, Number.POSITIVE_INFINITY)).toBeGreaterThanOrEqual(1);
    });

    it(`${name}: is the table the renderer looks up by widget type`, () => {
      // A table nothing reads is a comment. This is the line that makes every
      // measurement above load-bearing.
      expect(WIDGET_TIERS[name]).toBe(table);
    });
  }

  it('offers a table for the six widgets and for nothing else', () => {
    expect(Object.keys(WIDGET_TIERS).sort()).toEqual(
      ['chores', 'homeassistant', 'notes', 'shift', 'todo', 'weather'],
    );
  });
});

describe('what a box affords', () => {
  const CH = 10;
  const EM = 20;

  it('walks up to the highest rung both dimensions reach', () => {
    const wideAndShort = widgetTierFor(NOTES_TIERS, 40 * CH, 1.4 * EM, CH, EM);
    const narrowAndTall = widgetTierFor(NOTES_TIERS, 6 * CH, 40 * EM, CH, EM);
    // A tall narrow column is as much T0 as a short wide one: a line needs
    // width to be a line and height to be a row.
    expect(wideAndShort.tier).toBe('T0');
    expect(narrowAndTall.tier).toBe('T0');
    expect(widgetTierFor(NOTES_TIERS, 40 * CH, 40 * EM, CH, EM).tier).toBe('T3');
  });

  it('reads a box exactly at a threshold as reaching it', () => {
    // The whisker. Both terms are a division of two measured pixel counts and a
    // browser reports those to sub-pixel precision, so a box built to be
    // exactly 9ch wide lands at 8.99999 about half the time — and a tier that
    // flickers between two draws of the identical wall is the font race in a
    // different costume.
    const rung = TODO_TIERS[2]!;
    expect(widgetTierFor(TODO_TIERS, rung.minCh * CH, rung.minEm * EM, CH, EM).tier).toBe(rung.tier);
  });

  it('answers the floor for a box or a face it cannot measure', () => {
    for (const bad of [
      [0, 100, CH, EM],
      [100, 0, CH, EM],
      [100, 100, 0, EM],
      [100, 100, CH, Number.NaN],
    ] as const) {
      expect(widgetTierFor(CHORE_TIERS, bad[0], bad[1], bad[2], bad[3]).tier).toBe('T0');
    }
  });

  it('lets the height buy more than the rung states, never fewer', () => {
    // The rule `namesAt` states one table along and the sentence this whole
    // file exists to make true: a 20em column that drew what a 10em one draws
    // is the fault being fixed.
    const rung = NOTES_TIERS[2]!;
    expect(itemsAt(rung, 2)).toBe(rung.items);
    expect(itemsAt(rung, rung.items + 5)).toBe(rung.items + 5);
  });
});

describe('a strip of days', () => {
  it('spends width on more days rather than on wider ones', () => {
    const ch = 8;
    expect(columnsAt(WEATHER_COLUMN_CH * ch * 3, ch, WEATHER_COLUMN_CH)).toBe(3);
    expect(columnsAt(WEATHER_COLUMN_CH * ch * 6, ch, WEATHER_COLUMN_CH)).toBe(6);
  });

  it('never draws fewer than one column, whatever the arithmetic says', () => {
    expect(columnsAt(1, 100, WEATHER_COLUMN_CH)).toBe(1);
    expect(columnsAt(0, 0, WEATHER_COLUMN_CH)).toBe(1);
  });

  it('asks for both temperatures only where a column can hold them', () => {
    // T2 and T3 differ in width and not in height, which looks like a mistake
    // and is the table being honest: the high and the low share a line while
    // they are adjacent, so giving up the low buys no height at all.
    expect(WEATHER_TIERS[3]!.minEm).toBe(WEATHER_TIERS[2]!.minEm);
    expect(WEATHER_TIERS[3]!.minCh).toBeGreaterThan(WEATHER_TIERS[2]!.minCh);
  });
});

describe('the ladder, cut to a tier', () => {
  const LADDER = ['person', 'shift', 'hours', 'run'] as const;

  it('takes rungs off the bottom and never adds one', () => {
    expect(rungsAt(SHIFT_TIERS[3]!, LADDER)).toEqual([...LADDER]);
    expect(rungsAt(SHIFT_TIERS[1]!, LADDER)).toEqual(['person', 'shift']);
    // Shorter than the tier allows stays exactly as the household wrote it: the
    // box is not entitled to a say in what is on the list.
    expect(rungsAt(SHIFT_TIERS[3]!, ['shift'])).toEqual(['shift']);
  });

  it('never resolves to nothing', () => {
    expect(rungsAt(SHIFT_TIERS[0]!, LADDER)).toEqual(['person']);
  });

  it('leaves a widget with no ladder alone', () => {
    // `rungs: 0` is "not my question" rather than "draw nothing" — a note is
    // lines of one thing and has no ladder at all.
    for (const tier of NOTES_TIERS) expect(rungsAt(tier, LADDER)).toEqual([...LADDER]);
  });

  it('draws a line rather than a word at one rung out of several', () => {
    // The ladder's own rule, kept word for word: a box with room for one row
    // spending it on "Amy" when "Amy: Days · 07:00–19:00" fits is the same room
    // spent on strictly less.
    expect(laddersToOneLine(SHIFT_TIERS[0]!, 4)).toBe(true);
    expect(laddersToOneLine(SHIFT_TIERS[1]!, 4)).toBe(false);
    // And a ladder that is one rung *anyway* is a card, not a line: there is
    // nothing to join up.
    expect(laddersToOneLine(SHIFT_TIERS[0]!, 1)).toBe(false);
  });

  it('keeps a house reading by role rather than by position', () => {
    /*
     * The one exception in the file, and the reason the house was never in the
     * wall's drop loop: `HOUSE_MODE_LADDERS` puts the value **last** in every
     * one of its four shapes, so taking the last entry leaves a widget saying
     * "Front door" and not what the front door is doing.
     */
    const reading = ['icon', 'label', 'value'] as const;
    const priority = ['value', 'label', 'icon'] as const;
    expect(rungsByPriority(HOUSE_TIERS[0]!, reading, priority)).toEqual(['value']);
    expect(rungsByPriority(HOUSE_TIERS[1]!, reading, priority)).toEqual(['label', 'value']);
    expect(rungsByPriority(HOUSE_TIERS[3]!, reading, priority)).toEqual([...reading]);
  });

  it('answers in the order the household draws them, not the order it keeps them', () => {
    // A household who put the label before the value did not ask for them to
    // swap when the box got narrow.
    expect(rungsByPriority(HOUSE_TIERS[1]!, ['label', 'value'], ['value', 'label', 'icon']))
      .toEqual(['label', 'value']);
    expect(rungsByPriority(HOUSE_TIERS[1]!, ['value', 'label'], ['value', 'label', 'icon']))
      .toEqual(['value', 'label']);
  });

  it('gives up a field it has never heard of first', () => {
    // A name from a server newer than this bundle sorts last rather than being
    // kept ahead of a value.
    expect(rungsByPriority(HOUSE_TIERS[1]!, ['nonsense', 'value', 'label'], ['value', 'label']))
      .toEqual(['value', 'label']);
  });
});

describe('nothing in this bundle scales a laid-out section', () => {
  /*
   * The mechanism this phase removed, asserted as an absence — which is the one
   * thing a measurement of a drawn wall cannot show. A renderer that still
   * carried `fitToBox` and merely never reached it on the fixture under test
   * would pass every pixel assertion in the suite and fail the next arrangement
   * somebody drags.
   *
   * Comments stripped first, because this project keeps its retired reasoning
   * in them and a scan that reads a paragraph about the mechanism as the
   * mechanism is a scan that can never go green.
   */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('declares no scale-to-fit and no scale floor', () => {
    const render = withoutComments(readFileSync(join(SRC, 'render.ts'), 'utf8'));
    for (const gone of ['fitToBox', 'minScaleFor', 'fitAndTrimToDays', 'trimCellRows']) {
      expect(render, `${gone} survives in the renderer`).not.toContain(gone);
    }
    const density = withoutComments(readFileSync(join(SRC, 'density.ts'), 'utf8'));
    for (const gone of ['MIN_CALENDAR_SCALE', 'MIN_CHORE_SCALE']) {
      expect(density, `${gone} survives in density.ts`).not.toContain(gone);
    }
  });

  it('writes no transform from any module in the display bundle', () => {
    for (const file of ['render.ts', 'main.ts', 'viewmodel.ts', 'orientation.ts']) {
      const source = withoutComments(readFileSync(join(SRC, file), 'utf8'));
      expect(source, `${file} writes a transform`).not.toMatch(/\.style\.transform\s*=/);
      expect(source, `${file} builds a scale()`).not.toMatch(/`scale\(/);
    }
  });

  it('declares no scale transform in the stylesheet', () => {
    const css = withoutComments(readFileSync(join(SRC, 'display.css'), 'utf8'));
    expect([...css.matchAll(/transform:[^;}]*scale\(/g)].map((match) => match[0])).toEqual([]);
  });
});

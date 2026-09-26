import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHIFT_DOTS_MAX,
  SHIFT_STYLES,
  markInitial,
  shiftDotCount,
  shiftLabelForms,
  shiftStyle,
  shiftsShown,
} from '../src/epaper/shift-style.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';

/**
 * The two copies of the rota reading must not drift (plan item P5.4).
 *
 * The wall and the panel read one stored value one way, and this proves it by
 * reading both files. The fault it guards against is this project's most
 * repeated one: `shifts[0]` on the month cell against everybody on the badge,
 * `display_mode` read by one renderer and not the other, `cellEvents` as
 * `=== 'pills'` on the panel while the wall drew names for `swiss` too, `mode`
 * as `!== 'list'` against `=== 'month'`. Each time the cure was to resolve the
 * value **once** and hand over the answer, and each time the resolution had to
 * be written twice because the display bundle has no bundler and the server
 * cannot import from it — so each time a test reads both files as text and
 * refuses to let them differ. `calendar-view-parity`, `tier-parity` and
 * `month-spans-parity` are the same seam; this is the rota's.
 *
 * Everything from the first declaration on is held **character-identical**,
 * the strongest form this seam has (`tier-parity`'s), because a reading is a
 * function and not a table: `shiftsShown` is where week views read the same
 * key the other way round (Q2), and a panel that read an absence as *on* there
 * would light up a code on every week panel following a wall that draws none.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'shift-style.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'shift-style.ts');
const wall = readFileSync(WALL_PATH, 'utf8');
const panel = readFileSync(PANEL_PATH, 'utf8');

/** Everything from the first declaration on — the part that must be identical. */
function transcribed(source: string, where: string): string {
  const marker = '/**\n * The four looks a rota can take';
  const from = source.indexOf(marker);
  if (from < 0) throw new Error(`no transcription marker in ${where}`);
  return source.slice(from);
}

describe('the two copies of the rota reading', () => {
  it('read a display file that says something, so a rename fails loudly', () => {
    // Without this, a moved marker would leave the comparison below holding
    // two thrown errors to each other rather than two readings.
    expect(wall).toContain('export function shiftStyle');
    expect(wall).toContain('export function shiftsShown');
    expect(wall).toContain('export function shiftLabelForms');
    expect(transcribed(wall, WALL_PATH).length).toBeGreaterThan(500);
  });

  it('are character-identical from the first declaration on', () => {
    expect(
      transcribed(panel, PANEL_PATH),
      "the panel's shift-style.ts has drifted from the wall's in apps/display/src/shift-style.ts — " +
        'the wall is the spec, so copy it back',
    ).toBe(transcribed(wall, WALL_PATH));
  });

  it('names exactly the looks the schema accepts, in the editor’s order', () => {
    // The enum in `widgetConfigBody` is the boundary and this is the reading;
    // a look accepted by one and unknown to the other is a stored value one
    // renderer draws as `tint` while the other draws it as itself.
    expect([...SHIFT_STYLES]).toEqual([...widgetConfigBody.shape.shiftStyle.unwrap().options]);
    expect(SHIFT_STYLES[0]).toBe('tint');
  });

  it('reads an absence as the look every wall already drew', () => {
    expect(shiftStyle({})).toBe('tint');
    expect(shiftStyle(undefined)).toBe('tint');
    expect(shiftStyle({ shiftStyle: 'label' })).toBe('label');
    expect(shiftStyle({ shiftStyle: 'edge' })).toBe('edge');
    expect(shiftStyle({ shiftStyle: 'dot' })).toBe('dot');
    // A fifth look from a newer server is not a look this build knows.
    expect(shiftStyle({ shiftStyle: 'stripe' })).toBe('tint');
    expect(shiftStyle({ shiftStyle: 1 })).toBe('tint');
  });

  it('reads the switch one way on the month and the list, and the other on the week (Q2)', () => {
    for (const view of ['month', 'list'] as const) {
      expect(shiftsShown({}, view), `${view}: absent means on`).toBe(true);
      expect(shiftsShown({ showShifts: true }, view)).toBe(true);
      expect(shiftsShown({ showShifts: false }, view)).toBe(false);
    }
    expect(shiftsShown({}, 'week'), 'week: absent means off, so no hanging week wall lights up').toBe(false);
    expect(shiftsShown({ showShifts: true }, 'week')).toBe(true);
    expect(shiftsShown({ showShifts: false }, 'week')).toBe(false);
  });

  it('spells a label longest form first, and a lone person by their code alone', () => {
    expect(shiftLabelForms([], ':')).toEqual([]);
    expect(shiftLabelForms([{ initial: 'A', code: 'D' }], ':')).toEqual([['D']]);
    expect(
      shiftLabelForms(
        [
          { initial: 'A', code: 'D' },
          { initial: 'B', code: 'N' },
        ],
        ':',
      ),
    ).toEqual([['A:D', 'B:N'], ['D', 'N']]);
  });

  it('draws at most three dots, and an initial is one character', () => {
    const marks = [
      { initial: 'A', code: 'D' },
      { initial: 'B', code: 'N' },
      { initial: 'C', code: 'D' },
      { initial: 'D', code: 'N' },
    ];
    expect(shiftDotCount(marks)).toBe(SHIFT_DOTS_MAX);
    expect(shiftDotCount(marks.slice(0, 2))).toBe(2);
    expect(markInitial('amy')).toBe('A');
    expect(markInitial('  Ben Smith ')).toBe('B');
    expect(markInitial('')).toBe('');
    expect(markInitial('Élodie')).toBe('É');
  });
});

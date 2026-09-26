import { describe, expect, it } from 'vitest';

import {
  SHIFT_DOTS_MAX,
  SHIFT_STYLES,
  markInitial,
  shiftDotCount,
  shiftLabelForms,
  shiftStyle,
  shiftsShown,
} from '../src/shift-style.js';

/**
 * The rota reading, resolved as data (plan item P5.4).
 *
 * There is no DOM in this package's tests, so a rule that lived inside
 * `renderCell` would be a rule nothing here could check. These are the
 * decisions the renderer hands over — which look, whether at all on this view,
 * and what words a label carries — asked directly. `shift-style-parity.test.ts`
 * on the server holds the panel's transcription to this file character for
 * character, so what is proved here is proved of the panel too.
 */
describe('which look a rota takes', () => {
  it('is tint by its absence, which is what every wall already drew', () => {
    expect(shiftStyle({})).toBe('tint');
    expect(shiftStyle(undefined)).toBe('tint');
    expect(shiftStyle(null)).toBe('tint');
    expect(shiftStyle('label')).toBe('tint');
  });

  it('is each of the four when asked, and tint for anything else', () => {
    for (const style of SHIFT_STYLES) expect(shiftStyle({ shiftStyle: style })).toBe(style);
    expect(shiftStyle({ shiftStyle: 'TINT' })).toBe('tint');
    expect(shiftStyle({ shiftStyle: 'ring' })).toBe('tint');
  });
});

describe('whether a view draws the rota (Q2)', () => {
  it('draws on the month and the list unless told not to', () => {
    expect(shiftsShown({}, 'month')).toBe(true);
    expect(shiftsShown({}, 'list')).toBe(true);
    expect(shiftsShown({ showShifts: false }, 'month')).toBe(false);
    expect(shiftsShown({ showShifts: false }, 'list')).toBe(false);
  });

  it('draws on a week only when told to, so no hanging week wall lights up', () => {
    // A week wall saved before P5.4 stores no `showShifts` at all, and it drew
    // no rota; reading the absence as *on* there would paint one on the day of
    // an upgrade. Only the explicit `true` a household writes after the switch
    // appears on the week view turns it on.
    expect(shiftsShown({}, 'week')).toBe(false);
    expect(shiftsShown({ showShifts: 'true' }, 'week')).toBe(false);
    expect(shiftsShown({ showShifts: true }, 'week')).toBe(true);
    expect(shiftsShown({ showShifts: false }, 'week')).toBe(false);
  });
});

describe('the words a label carries', () => {
  const amy = { initial: 'A', code: 'D' };
  const ben = { initial: 'B', code: 'N' };

  it('is the code alone for one person', () => {
    expect(shiftLabelForms([amy], '·')).toEqual([['D']]);
  });

  it('tells two people apart by initial, and falls back to the codes alone', () => {
    // "D D" would say two are on days and not who; "A·D B·N" says both. When
    // the date line cannot hold the long form whole, the codes are the shorter
    // whole form — never a cut string.
    expect(shiftLabelForms([amy, ben], '·')).toEqual([['A·D', 'B·N'], ['D', 'N']]);
    expect(shiftLabelForms([amy, { initial: 'B', code: 'D' }], '·')).toEqual([['A·D', 'B·D'], ['D', 'D']]);
  });

  it('carries nothing for nobody', () => {
    expect(shiftLabelForms([], '·')).toEqual([]);
  });

  it('takes the separator from the caller, because the two alphabets differ', () => {
    // The panel's bitmap face is ASCII; the wall draws a middle dot.
    expect(shiftLabelForms([amy, ben], ':')[0]).toEqual(['A:D', 'B:N']);
  });
});

describe('the dots and the initials', () => {
  it('draws one dot a person, to three', () => {
    const four = ['A', 'B', 'C', 'D'].map((initial) => ({ initial, code: 'D' }));
    expect(shiftDotCount(four.slice(0, 1))).toBe(1);
    expect(shiftDotCount(four.slice(0, 2))).toBe(2);
    expect(shiftDotCount(four)).toBe(SHIFT_DOTS_MAX);
    expect(SHIFT_DOTS_MAX).toBe(3);
  });

  it('takes one upper-case character of a name, whole', () => {
    expect(markInitial('amy')).toBe('A');
    expect(markInitial('Ben Smith')).toBe('B');
    expect(markInitial('   ')).toBe('');
    // A name starting outside the basic plane is one character, not half of one.
    expect(markInitial('😀 Sam')).toBe('😀');
  });
});

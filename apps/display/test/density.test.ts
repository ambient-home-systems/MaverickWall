import { describe, expect, it } from 'vitest';
import {
  agendaTimeFitsBeside,
  MIN_AGENDA_ROW_REM,
  MIN_WEEK_COLUMN_REM,
  weekColumnsFit,
} from '../src/density.js';

/*
 * The floors are calibrated against a real browser (see the table in
 * density.ts), so these test the decision rather than the number: that it
 * turns over where it says it does, and that an unmeasurable box keeps what
 * the household asked for rather than silently substituting something else.
 */

const REM = 19.2;

describe('whether seven day-columns are worth drawing', () => {
  it('keeps the week when each column clears the floor', () => {
    // 0.7 of a 1080-wide canvas: 5.6rem a column, which reads cleanly.
    expect(weekColumnsFit(756, REM)).toBe(true);
  });

  it('gives up the week when a column would be below it', () => {
    // 0.5 of the same canvas: 4rem a column, where every title becomes one
    // letter and an ellipsis. Tidy, and it tells nobody anything.
    expect(weekColumnsFit(540, REM)).toBe(false);
  });

  it('turns over exactly at the floor', () => {
    const exact = MIN_WEEK_COLUMN_REM * REM * 7;
    expect(weekColumnsFit(exact, REM)).toBe(true);
    expect(weekColumnsFit(exact - 1, REM)).toBe(false);
  });

  it('keeps the week when the box cannot be measured', () => {
    // A detached node, a frame before layout, a rem that did not parse. The
    // household asked for a week; drawing it is the safer failure.
    expect(weekColumnsFit(0, REM)).toBe(true);
    expect(weekColumnsFit(756, Number.NaN)).toBe(true);
  });
});

describe('whether an agenda row can keep its time beside its title', () => {
  it('keeps the design arrangement when there is room', () => {
    expect(agendaTimeFitsBeside(MIN_AGENDA_ROW_REM * REM, REM)).toBe(true);
  });

  it('stacks the time above the title when there is not', () => {
    // Measured on the laid-out section, not the box: a scaled box can be far
    // wider than the section inside it.
    expect(agendaTimeFitsBeside(391, REM)).toBe(false);
  });

  it('keeps the arrangement when the section cannot be measured', () => {
    expect(agendaTimeFitsBeside(0, REM)).toBe(true);
  });
});

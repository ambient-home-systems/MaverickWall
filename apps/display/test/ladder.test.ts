import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHIFT_LADDER,
  DEFAULT_WEATHER_LADDER,
  SHIFT_FIELDS,
  SHIFT_ROLES,
  WEATHER_FIELDS,
  WEATHER_ROLES,
  dropToFit,
  ladderRows,
  pairsTemperatures,
  shiftLadder,
  weatherLadder,
  type LadderRow,
} from '../src/ladder.js';

/**
 * The field ladder, on the wall's side.
 *
 * The panel runs the same cases against its own transcription in
 * `epaper-ladder-parity.test.ts`, which also reads this file and refuses to let
 * the two tables drift. Written twice because the display bundle has no
 * dependencies and no bundler and so cannot share a module with the server.
 */

describe('the ladder a widget resolves to', () => {
  it('is the badge every wall already drew, when nothing was set', () => {
    // Rule nine's version of backwards compatibility: a widget saved before the
    // ladder existed must resolve to exactly what it drew.
    expect(shiftLadder()).toEqual([...DEFAULT_SHIFT_LADDER]);
    expect(shiftLadder({})).toEqual(['person', 'shift', 'hours', 'run']);
  });

  it('still honours the switches that predate it', () => {
    expect(shiftLadder({ showHours: false })).toEqual(['person', 'shift', 'run']);
    expect(shiftLadder({ showRun: false })).toEqual(['person', 'shift', 'hours']);
    expect(shiftLadder({ showHours: false, showRun: false })).toEqual(['person', 'shift']);
  });

  it('lets a stored ladder win outright, so a widget is never half in each', () => {
    expect(shiftLadder({ fields: ['shift', 'person'], showHours: false, showRun: false })).toEqual([
      'shift',
      'person',
    ]);
  });

  it('keeps the order it was given — that is the whole point', () => {
    expect(shiftLadder({ fields: ['run', 'hours', 'shift', 'person'] })).toEqual([
      'run',
      'hours',
      'shift',
      'person',
    ]);
  });

  it('drops a name it has no renderer for rather than passing it on', () => {
    expect(shiftLadder({ fields: ['shift', 'website', 'hours'] })).toEqual(['shift', 'hours']);
    // And a repeat is drawn once, exactly as `parseBlocks` treats a repeated
    // block name.
    expect(shiftLadder({ fields: ['shift', 'shift', 'person'] })).toEqual(['shift', 'person']);
  });

  it('never resolves to an empty badge', () => {
    for (const fields of [[], ['nope'], 'shift', 7, null, undefined]) {
      expect(shiftLadder({ fields }), JSON.stringify(fields ?? null)).toEqual([
        ...DEFAULT_SHIFT_LADDER,
      ]);
    }
    expect(shiftLadder('not an object')).toEqual([...DEFAULT_SHIFT_LADDER]);
  });

  it('gives every field an emphasis, and every field is in the default', () => {
    // A field with no role would draw at whatever the last one happened to be;
    // a field outside the default ladder could never appear on an untouched
    // wall and would look like a control that does nothing.
    for (const field of SHIFT_FIELDS) {
      expect(SHIFT_ROLES[field], field).toBeDefined();
      expect(DEFAULT_SHIFT_LADDER, field).toContain(field);
    }
  });
});

describe('the rows a ladder produces', () => {
  it('drops a field the day has no data for, which is not "switched off"', () => {
    // An untimed shift has no hours; a run the server could not establish has
    // no position. Neither is a household asking for a gap in the badge.
    const rows = ladderRows(
      ['person', 'shift', 'hours', 'run'],
      { person: 'Amy', shift: 'Days', hours: '' },
      SHIFT_ROLES,
    );
    expect(rows.map((r) => r.field)).toEqual(['person', 'shift']);
  });

  it('carries the emphasis with the row, not with its position', () => {
    // Reordering changes what is drawn first and what is given up first. It
    // does not re-typeset the badge: a person is a kicker wherever they sit.
    const rows = ladderRows(
      ['hours', 'person'],
      { hours: '07:00–19:00', person: 'Amy' },
      SHIFT_ROLES,
    );
    expect(rows).toEqual([
      { field: 'hours', role: 'body', text: '07:00–19:00' },
      { field: 'person', role: 'kicker', text: 'Amy' },
    ]);
  });
});

describe('giving up rows that will not fit', () => {
  const rows: LadderRow[] = [
    { field: 'person', role: 'kicker', text: 'Amy' },
    { field: 'shift', role: 'headline', text: 'Days' },
    { field: 'hours', role: 'body', text: '07:00–19:00' },
    { field: 'run', role: 'small', text: 'Day 2 of 4' },
  ];
  const ten = (): number => 10;

  it('takes them from the bottom, one at a time', () => {
    expect(dropToFit(rows, 40, ten)).toHaveLength(4);
    expect(dropToFit(rows, 39, ten).map((r) => r.field)).toEqual(['person', 'shift', 'hours']);
    expect(dropToFit(rows, 25, ten).map((r) => r.field)).toEqual(['person', 'shift']);
  });

  it('keeps the head however small the box gets', () => {
    // Rule nine. A household who dragged a box too small should see the thing
    // they put first, clipped if it comes to that, not an empty rectangle.
    expect(dropToFit(rows, 1, ten).map((r) => r.field)).toEqual(['person']);
    expect(dropToFit(rows, 0, ten).map((r) => r.field)).toEqual(['person']);
    expect(dropToFit(rows, -50, () => 1e6).map((r) => r.field)).toEqual(['person']);
  });

  it('sacrifices in the household’s order, not in a fixed one', () => {
    // The claim the whole feature rests on: put the hours first and the hours
    // are what survives.
    const reordered = [...rows].reverse();
    expect(dropToFit(reordered, 15, ten).map((r) => r.field)).toEqual(['run']);
  });

  it('measures each row by its own role', () => {
    // A headline costs more than a kicker: 10 + 30 + 10 + 10 against a budget,
    // so where the ladder cuts depends on which roles are above the cut and not
    // on how many rows there are.
    const tall = (role: string): number => (role === 'headline' ? 30 : 10);
    expect(dropToFit(rows, 60, tall)).toHaveLength(4);
    expect(dropToFit(rows, 50, tall).map((r) => r.field)).toEqual(['person', 'shift', 'hours']);
    expect(dropToFit(rows, 45, tall).map((r) => r.field)).toEqual(['person', 'shift']);
    // The same 45 holds four rows when none of them is the headline.
    const flat = rows.map((row) => ({ ...row, role: 'small' as const }));
    expect(dropToFit(flat, 45, tall)).toHaveLength(4);
  });

  it('leaves a ladder that already fits alone', () => {
    expect(dropToFit(rows, 1000, ten)).toEqual(rows);
    expect(dropToFit([], 0, ten)).toEqual([]);
  });
});

/* -------------------------------------------------------------- WEATHER --- */

describe('the forecast strip’s ladder', () => {
  it('is the strip every wall already drew, when nothing was set', () => {
    expect(weatherLadder()).toEqual([...DEFAULT_WEATHER_LADDER]);
    expect(weatherLadder({})).toEqual(['name', 'icon', 'high', 'low']);
  });

  it('still honours the switches that predate it', () => {
    expect(weatherLadder({ showIcon: false })).toEqual(['name', 'high', 'low']);
    expect(weatherLadder({ showLow: false })).toEqual(['name', 'icon', 'high']);
    expect(weatherLadder({ showIcon: false, showLow: false })).toEqual(['name', 'high']);
  });

  it('keeps the order it was given', () => {
    expect(weatherLadder({ fields: ['high', 'name'] })).toEqual(['high', 'name']);
  });

  it('ignores fields that belong to another widget', () => {
    /*
     * One `fields` key serves every ladder, because the config is one strict
     * object for every widget type. A Weather widget carrying a shift field —
     * a retyped widget, or a hand-edited row — must read it as "not for me".
     */
    expect(weatherLadder({ fields: ['person', 'shift', 'hours'] })).toEqual([
      ...DEFAULT_WEATHER_LADDER,
    ]);
    expect(weatherLadder({ fields: ['low', 'person', 'name'] })).toEqual(['low', 'name']);
  });

  it('never resolves to an empty strip', () => {
    for (const fields of [[], ['nope'], 'high', 3, null]) {
      expect(weatherLadder({ fields }), JSON.stringify(fields)).toEqual([
        ...DEFAULT_WEATHER_LADDER,
      ]);
    }
  });

  it('gives every field an emphasis, and every field is in the default', () => {
    for (const field of WEATHER_FIELDS) {
      expect(WEATHER_ROLES[field], field).toBeDefined();
      expect(DEFAULT_WEATHER_LADDER, field).toContain(field);
    }
  });

  it('pairs the temperatures only while they are next to each other', () => {
    // A range reads as one thing — "24° 13°C" is how this strip has always
    // drawn it, and the default ladder has to keep drawing exactly that.
    expect(pairsTemperatures([...DEFAULT_WEATHER_LADDER])).toBe(true);
    expect(pairsTemperatures(['name', 'high', 'low'])).toBe(true);
    // Order within the pair does not matter: a low above a high is still a range.
    expect(pairsTemperatures(['low', 'high'])).toBe(true);
    // Separated on purpose, so separated on the wall.
    expect(pairsTemperatures(['high', 'name', 'low'])).toBe(false);
    // And one without the other is not a pair at all.
    expect(pairsTemperatures(['name', 'high'])).toBe(false);
    expect(pairsTemperatures([])).toBe(false);
  });

  it('drops a day’s row when the provider gave nothing for it', () => {
    const rows = ladderRows(
      [...DEFAULT_WEATHER_LADDER],
      { name: 'Today', icon: '', high: '24°', low: '13°C' },
      WEATHER_ROLES,
    );
    expect(rows.map((r) => r.field)).toEqual(['name', 'high', 'low']);
  });
});

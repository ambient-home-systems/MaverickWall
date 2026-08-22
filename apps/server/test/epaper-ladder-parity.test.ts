import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as panelLadder from '../src/epaper/ladder.js';
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
} from '../src/epaper/ladder.js';

/**
 * The two copies of the ladder must not drift.
 *
 * The display bundle has no dependencies and no bundler — plain `tsc` output
 * served to a browser, `rootDir` pinned to its own `src` — so it cannot import
 * a shared module, and a test here cannot import *from* it without putting a
 * file outside `tsconfig.test.json`'s root and failing the typecheck that
 * `pnpm test` exists to run. So the table is written twice, and this reads both
 * files as text and compares them.
 *
 * The same shape as `migration-upgrade.test.ts` asserting the migrations
 * directory and its journal agree in *both* directions: a field here with no
 * field there is a panel drawing a row the wall does not, and a field there
 * with none here is a household choosing something the panel silently ignores.
 * Both are the drift that put `shifts[0]` on one renderer and everybody on the
 * other, which is the fault this whole seam exists to prevent.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY_LADDER = join(HERE, '..', '..', 'display', 'src', 'ladder.ts');
const source = readFileSync(DISPLAY_LADDER, 'utf8');

/** `export const NAME = [...] as const;` → its string members, in order. */
function tuple(name: string): string[] {
  const match = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (match?.[1] === undefined) throw new Error(`no ${name} in ${DISPLAY_LADDER}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/** `key: 'value',` pairs inside `export const NAME ... = { ... }`. */
function table(name: string): Record<string, string> {
  const from = source.indexOf(`export const ${name}`);
  if (from < 0) throw new Error(`no ${name} in ${DISPLAY_LADDER}`);
  const body = source.slice(source.indexOf('{', from) + 1, source.indexOf('}', from));
  const out: Record<string, string> = {};
  for (const [, key, value] of body.matchAll(/(\w+)\s*:\s*'([^']+)'/g)) out[key as string] = value as string;
  return out;
}

describe('the ladder tables, on both renderers', () => {
  it('names the same shift fields, in the same order', () => {
    expect(tuple('SHIFT_FIELDS')).toEqual([...SHIFT_FIELDS]);
  });

  it('names the same weather fields, in the same order', () => {
    expect(tuple('WEATHER_FIELDS')).toEqual([...WEATHER_FIELDS]);
  });

  it('gives every field the same emphasis', () => {
    expect(table('SHIFT_ROLES')).toEqual({ ...SHIFT_ROLES });
    expect(table('WEATHER_ROLES')).toEqual({ ...WEATHER_ROLES });
  });

  it('starts from the same default ladders', () => {
    expect(tuple('DEFAULT_SHIFT_LADDER')).toEqual([...DEFAULT_SHIFT_LADDER]);
    expect(tuple('DEFAULT_WEATHER_LADDER')).toEqual([...DEFAULT_WEATHER_LADDER]);
  });

  it('has the same set of ladders on each side, in both directions', () => {
    /*
     * The parity that is easiest to lose: a third widget gaining a ladder on one
     * renderer and not the other passes every assertion above, because those
     * only compare the tables they were told about.
     *
     * Compared as *sets*, and from each file's own declarations rather than
     * from a list written here — a hard-coded expectation would have to be
     * updated by the same person who forgot the other file. Checked by adding a
     * table to one side and watching it go red, which is how the first version
     * of this test was found to only look one way.
     */
    const inDisplay = [...source.matchAll(/export const (\w+)_FIELDS\b/g)]
      .map((m) => m[1] as string)
      .sort();
    const inPanel = Object.keys(panelLadder)
      .filter((name) => name.endsWith('_FIELDS'))
      .map((name) => name.replace(/_FIELDS$/, ''))
      .sort();
    expect(inPanel).toEqual(inDisplay);
    expect(inPanel).toContain('SHIFT');
    expect(inPanel).toContain('WEATHER');
  });

  it('reads the display file it claims to, so a rename fails loudly', () => {
    // A regex over a file that moved would quietly match nothing and pass every
    // assertion above by comparing two empty lists.
    expect(source).toContain('The field ladder');
    expect(tuple('SHIFT_FIELDS').length).toBeGreaterThan(0);
  });
});

describe('resolving a weather ladder', () => {
  it('is the strip every wall already drew, when nothing was set', () => {
    expect(weatherLadder({})).toEqual(['name', 'icon', 'high', 'low']);
  });

  it('still honours the switches that predate it', () => {
    expect(weatherLadder({ showIcon: false })).toEqual(['name', 'high', 'low']);
    expect(weatherLadder({ showLow: false })).toEqual(['name', 'icon', 'high']);
  });

  it('ignores a field that belongs to another widget', () => {
    // One `fields` key serves every ladder, so a Weather widget carrying a
    // shift field must read as "not for me" rather than as an unrenderable row.
    expect(weatherLadder({ fields: ['person', 'shift'] })).toEqual([
      'name',
      'icon',
      'high',
      'low',
    ]);
    expect(weatherLadder({ fields: ['high', 'person', 'name'] })).toEqual(['high', 'name']);
  });

  it('pairs the temperatures only while they are next to each other', () => {
    // A range reads as one thing, which is how the strip has always drawn it.
    expect(pairsTemperatures(['name', 'icon', 'high', 'low'])).toBe(true);
    expect(pairsTemperatures(['low', 'high'])).toBe(true);
    expect(pairsTemperatures(['high', 'name', 'low'])).toBe(false);
    expect(pairsTemperatures(['name', 'high'])).toBe(false);
  });
});

/**
 * The resolver's own rules, asserted against the server's copy. The display's
 * copy is driven by `apps/display/test/ladder.test.ts`; both run the same cases
 * because the parity above pins the table they share.
 */
describe('resolving a ladder', () => {
  it('is the old badge when nothing was ever set', () => {
    expect(shiftLadder({})).toEqual(['person', 'shift', 'hours', 'run']);
  });

  it('still honours the switches that predate it', () => {
    expect(shiftLadder({ showHours: false })).toEqual(['person', 'shift', 'run']);
    expect(shiftLadder({ showRun: false, showHours: false })).toEqual(['person', 'shift']);
  });

  it('lets a stored ladder win, switches and all', () => {
    expect(shiftLadder({ fields: ['shift', 'person'], showHours: false })).toEqual([
      'shift',
      'person',
    ]);
  });

  it('drops what it cannot draw rather than passing it on', () => {
    expect(shiftLadder({ fields: ['shift', 'nonsense', 'shift', 'hours'] })).toEqual([
      'shift',
      'hours',
    ]);
  });

  it('falls back rather than resolving to an empty badge', () => {
    // Rule nine: an empty list is far more likely to be a mistake than a
    // household asking for a blank box.
    for (const fields of [[], ['nonsense'], 'shift', 42, null]) {
      expect(shiftLadder({ fields }), JSON.stringify(fields)).toEqual([
        'person',
        'shift',
        'hours',
        'run',
      ]);
    }
  });

  it('drops a row the day has no data for, which is not the same as off', () => {
    const rows = ladderRows(
      ['person', 'shift', 'hours', 'run'],
      {
        person: 'Amy',
        shift: 'Days',
        // An untimed shift, and a run the server could not establish.
      },
      SHIFT_ROLES,
    );
    expect(rows.map((r) => r.field)).toEqual(['person', 'shift']);
  });

  it('gives up rows from the bottom, and never the last one', () => {
    const rows: LadderRow[] = [
      { field: 'person', role: 'kicker', text: 'Amy' },
      { field: 'shift', role: 'headline', text: 'Days' },
      { field: 'hours', role: 'body', text: '07:00-19:00' },
    ];
    const h = (): number => 10;
    expect(dropToFit(rows, 30, h).map((r) => r.field)).toEqual(['person', 'shift', 'hours']);
    expect(dropToFit(rows, 25, h).map((r) => r.field)).toEqual(['person', 'shift']);
    expect(dropToFit(rows, 15, h).map((r) => r.field)).toEqual(['person']);
    // However small the box, and however tall the row: the head survives.
    expect(dropToFit(rows, 0, h).map((r) => r.field)).toEqual(['person']);
    expect(dropToFit(rows, -100, () => 1000).map((r) => r.field)).toEqual(['person']);
  });

  it('gives up in the household\u2019s order, not in a fixed one', () => {
    // The whole claim of the ladder: reordering changes what is sacrificed.
    const reordered: LadderRow[] = [
      { field: 'hours', role: 'body', text: '07:00-19:00' },
      { field: 'shift', role: 'headline', text: 'Days' },
      { field: 'person', role: 'kicker', text: 'Amy' },
    ];
    expect(dropToFit(reordered, 15, () => 10).map((r) => r.field)).toEqual(['hours']);
  });
});

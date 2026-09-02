import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as panelTiers from '../src/epaper/tiers.js';
import {
  CALENDAR_TIERS,
  LABEL_MIN_CH,
  LINE_EM,
  MAX_LINES,
  MAX_NAMES,
  NUMERAL_EM,
  ROW_EM,
  TIER_EPSILON,
  TIER_NAMES,
  TYPE_SPECIMEN,
  linesAt,
  listRowsAt,
  namesAt,
  promoted,
  spanIsLabelled,
  tierFor,
  tierNamed,
  weekdayHead,
} from '../src/epaper/tiers.js';

/**
 * The two copies of the density-tier table must not drift.
 *
 * The display bundle has no dependencies and no bundler — plain `tsc` output
 * served to a browser, `rootDir` pinned to its own `src` — so it cannot import
 * a shared module, and a test here cannot import *from* it without putting a
 * file outside `tsconfig.test.json`'s root and failing the typecheck that
 * `pnpm test` exists to run. So the table is written twice, and this reads both
 * files as text and compares them.
 *
 * The same seam and the same idiom as `epaper-ladder-parity.test.ts`, with its
 * lesson applied from the start rather than after the fact: **the sets are
 * compared, each derived from its own file**, because that test's first version
 * only compared the tables it had been told about and a third table added on
 * one side alone sailed straight through. Both directions were confirmed here
 * by adding a rung to one file at a time and watching this go red.
 *
 * And the *bodies* are compared, not only the tables. A tier is not a lookup —
 * `namesAt` decides how many names a box of a given height draws, and a panel
 * that rounded that differently would answer a different month from the wall it
 * follows for exactly the boxes where it matters. So every exported function is
 * held to being character-identical, which is the strongest form this seam has:
 * `month-spans-parity` already does it for the span reading, and it is what
 * makes "the wall is the spec" a fact rather than an intention.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY_TIERS = join(HERE, '..', '..', 'display', 'src', 'tiers.ts');
const PANEL_TIERS = join(HERE, '..', 'src', 'epaper', 'tiers.ts');
const display = readFileSync(DISPLAY_TIERS, 'utf8');
const panel = readFileSync(PANEL_TIERS, 'utf8');

/** Everything from the first declaration on — the part that must be identical. */
function transcribed(source: string): string {
  const from = source.indexOf('/** The rungs, smallest first.');
  if (from < 0) throw new Error('no transcription marker');
  return source.slice(from);
}

/** `export const NAME: … = [ { … }, … ];` → one object per row, as text. */
function tierRows(source: string, name: string): string[] {
  const from = source.indexOf(`export const ${name}`);
  if (from < 0) throw new Error(`no ${name}`);
  const body = source.slice(source.indexOf('[', from) + 1, source.indexOf('];', from));
  return [...body.matchAll(/\{[^}]*\}/g)].map((match) => match[0].replace(/\s+/g, ' ').trim());
}

/** Every `export const NAME_TIERS` this file declares, by its bare name. */
function tableNames(source: string): string[] {
  return [...source.matchAll(/export const (\w+)_TIERS\b/g)].map((match) => match[1] as string).sort();
}

/** Every exported function in a file, as `name` → its whole body text. */
function functionBodies(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /export function (\w+)\(([\s\S]*?)\n\}\n/g;
  for (const match of source.matchAll(pattern)) {
    out[match[1] as string] = (match[2] as string).replace(/\r/g, '');
  }
  return out;
}

describe('the tier table, on both renderers', () => {
  it('reads the files it claims to, so a rename fails loudly', () => {
    // A regex over a file that moved would quietly match nothing and pass every
    // assertion below by comparing two empty lists.
    expect(display).toContain('Density tiers');
    expect(panel).toContain('transcribed, and nothing else');
    expect(tierRows(display, 'CALENDAR_TIERS').length).toBeGreaterThan(0);
  });

  it('declares the same rungs, in the same order', () => {
    expect(tierRows(display, 'CALENDAR_TIERS')).toEqual(tierRows(panel, 'CALENDAR_TIERS'));
    expect(tierRows(panel, 'CALENDAR_TIERS').length).toBe(CALENDAR_TIERS.length);
    expect(CALENDAR_TIERS.map((tier) => tier.tier)).toEqual([...TIER_NAMES]);
  });

  it('has the same set of tables on each side, in both directions', () => {
    /*
     * The parity that is easiest to lose, and the one the ladder's first
     * version could not see: a second table gaining a home on one renderer and
     * not the other passes every assertion above, because those only compare
     * the tables they were told about. Derived from each file's own
     * declarations rather than from a list written here, so it cannot be
     * updated by the same person who forgot the other file.
     */
    expect(tableNames(panel)).toEqual(tableNames(display));
    expect(tableNames(panel)).toContain('CALENDAR');
    // …and the module's own exports agree with what its source declares, so a
    // table renamed but not re-exported does not read as parity.
    const exported = Object.keys(panelTiers)
      .filter((name) => name.endsWith('_TIERS'))
      .map((name) => name.replace(/_TIERS$/, ''))
      .sort();
    expect(exported).toEqual(tableNames(panel));
  });

  it('shares every constant the table is stated in', () => {
    /*
     * The units, not just the rows. `ROW_EM` decides how many names a box of a
     * given height draws, so a panel carrying 1.5 where the wall carries 1.55
     * would agree about every threshold in the table and disagree about the
     * answer — which is the divergence this seam exists to make impossible.
     */
    const constant = (source: string, name: string): string => {
      const match = new RegExp(`export const ${name}(?:: [^=]+)? = ([^;]+);`).exec(source);
      if (match?.[1] === undefined) throw new Error(`no ${name}`);
      return match[1].trim();
    };
    for (const name of [
      'NUMERAL_EM',
      'LINE_EM',
      'ROW_EM',
      'MAX_LINES',
      'MAX_NAMES',
      'LABEL_MIN_CH',
      'TIER_EPSILON',
      'TYPE_SPECIMEN',
    ]) {
      expect(constant(panel, name), name).toBe(constant(display, name));
    }
    // And the values the panel actually imports are the ones in its own text,
    // so a constant edited past the regex fails rather than passing quietly.
    expect([NUMERAL_EM, LINE_EM, ROW_EM, MAX_LINES, MAX_NAMES, LABEL_MIN_CH]).toEqual([
      1.2, 1.25, 1.55, 2, 12, 12,
    ]);
    expect(TIER_EPSILON).toBe(0.001);
    expect(TYPE_SPECIMEN.length).toBe(43);
  });

  it('resolves a tier with the same function body, character for character', () => {
    const here = functionBodies(panel);
    const there = functionBodies(display);
    expect(Object.keys(here).sort()).toEqual(Object.keys(there).sort());
    for (const name of Object.keys(there)) {
      expect(here[name], `${name} has drifted between the two renderers`).toBe(there[name]);
    }
    // The set is what a reader would expect to find, so a function deleted from
    // *both* files still fails here rather than passing as agreement.
    expect(Object.keys(here).sort()).toEqual([
      'linesAt',
      'listRowsAt',
      'namesAt',
      'promoted',
      'spanIsLabelled',
      'tierFor',
      'tierNamed',
      'weekdayHead',
    ]);
  });

  it('transcribes the whole module below its own header', () => {
    // Everything past the first declaration is a copy, so the two files can
    // only differ in the comment that says which one is the copy.
    expect(transcribed(panel)).toBe(transcribed(display));
  });
});

/**
 * The resolver's own rules, asserted against the panel's copy.
 *
 * The display's copy is driven by `apps/display/test/tiers.test.ts`; a handful
 * of the same cases run here so that a panel whose module failed to compile,
 * or whose export shape changed, fails on its own rather than only through the
 * text comparison above.
 */
describe('the panel resolving a tier', () => {
  const EM = 16;
  const CH = 18; // 8px glyph, 9px advance: the panel's own 1.125em per character.

  it('reads the table in the panel’s own units', () => {
    expect(tierFor(22 * CH, 10 * EM, CH, EM).tier).toBe('M4');
    expect(tierFor(12 * CH, 5 * EM, CH, EM).tier).toBe('M2');
    expect(tierFor(9 * CH, 3 * EM, CH, EM).tier).toBe('M1');
    // A 7.5" panel's month cell: 44px wide at a 9px advance, which is four
    // characters and is why it draws a mark rather than "Denti".
    expect(tierFor(44, 40, 9, 8).tier).toBe('M0');
  });

  it('names what the table says, in the box each rung is stated for', () => {
    expect(namesAt(tierNamed('M0'), 40 * EM, EM)).toBe(0);
    expect(namesAt(tierNamed('M1'), 3 * EM, EM)).toBe(1);
    expect(namesAt(tierNamed('M2'), 5 * EM, EM)).toBe(3);
    expect(namesAt(tierNamed('M3'), 7.5 * EM, EM)).toBe(5);
    expect(namesAt(tierNamed('M4'), 10 * EM, EM)).toBe(6);
  });

  it('lets a tall narrow cell draw the rows it has room for', () => {
    // The 13.3" panel's own cell: M1 by width, six rows of height.
    expect(namesAt(tierNamed('M1'), 10.94 * EM, EM)).toBe(6);
  });

  it('keeps the rest of the vocabulary', () => {
    expect(linesAt(tierNamed('M1'), 5 * EM, EM)).toBe(2);
    expect(listRowsAt(tierNamed('M0'), EM, EM)).toBe(1);
    expect(promoted(tierNamed('M0'), 1).tier).toBe('M1');
    expect(spanIsLabelled(LABEL_MIN_CH * CH, CH)).toBe(true);
    expect(weekdayHead('Mon', 'Monday', 1)).toBe('M');
  });
});

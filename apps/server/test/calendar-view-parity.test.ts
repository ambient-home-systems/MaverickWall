import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CALENDAR_DENSITIES,
  CALENDAR_VIEWS,
  LEGACY_CALENDAR_DENSITY,
  LEGACY_CALENDAR_VIEW,
  calendarView,
} from '../src/epaper/calendar-view.js';

/**
 * The wall and the panel read one stored value one way, and this proves it by
 * reading both files.
 *
 * This project has already shipped the fault: the wall's `renderCalendarWidget`
 * tested `mode !== 'list'` while the panel's `drawCalendarWidget` tested
 * `mode === 'month'`. The editor stores a widget's default view by **leaving
 * the key out**, so the commonest setting — the one nobody changes — matched
 * neither, fell through, and all three of the panel's "Show as" values drew the
 * same thing. It was reported by a household as "the calendar settings have no
 * impact", and the same shape has appeared under three other names in this
 * repository: `shifts[0]`, `display_mode`, `cellEvents`.
 *
 * The cure each time is to resolve the value **once** and hand over the answer.
 * `calendarView` is that resolution, and it is written twice for the reason
 * `ladder.ts` is: the display bundle has no dependencies and no bundler — plain
 * `tsc` output with `rootDir` pinned to its own `src` — so the server cannot
 * import it, and a test here cannot import *from* it without falling outside
 * `tsconfig.test.json`'s root and failing the typecheck `pnpm test` exists to
 * run.
 *
 * So this reads `apps/display/src/widget-views.ts` as **text**, pulls out what
 * it actually says, and holds the imported server copy to it — in both
 * directions, the way `migration-upgrade.test.ts` compares a migrations
 * directory with its journal. A value here and not there is a panel reading
 * something the wall does not; a value there and not here is a household
 * choosing something the panel silently ignores.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_SOURCE_PATH = join(HERE, '..', '..', 'display', 'src', 'widget-views.ts');
const wall = readFileSync(WALL_SOURCE_PATH, 'utf8');

/** `export const NAME = [...] as const;` → its string members, in order. */
function tuple(name: string): string[] {
  const match = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(wall);
  if (match?.[1] === undefined) throw new Error(`no ${name} in ${WALL_SOURCE_PATH}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * `export function calendarView(…) { … }`, from either file, verbatim.
 *
 * The tables agreeing is not the same as the *readings* agreeing, and it is the
 * reading that draws. These two function bodies are written to be
 * character-identical, so comparing them is the sharpest guard available here:
 * any drift on either side — a default flipped, a legacy branch reordered, a
 * `===` become a `!==` — turns this red, and the sentence it fails with says
 * which file to fix.
 */
function readingOf(source: string, where: string): string {
  const from = source.indexOf('export function calendarView');
  if (from < 0) throw new Error(`no calendarView in ${where}`);
  const to = source.indexOf('\n}\n', from);
  if (to < 0) throw new Error(`calendarView in ${where} never closes`);
  return source.slice(from, to + 3);
}

/** `key: 'value',` pairs inside `export const NAME … = { … }`. */
function table(name: string): Record<string, string> {
  const from = wall.indexOf(`export const ${name}`);
  if (from < 0) throw new Error(`no ${name} in ${WALL_SOURCE_PATH}`);
  const body = wall.slice(wall.indexOf('{', from) + 1, wall.indexOf('}', from));
  const out: Record<string, string> = {};
  for (const row of body.matchAll(/([A-Za-z_][\w]*)\s*:\s*'([^']+)'/g)) {
    out[row[1] as string] = row[2] as string;
  }
  return out;
}

describe('the two copies of the calendar reading', () => {
  it('reads a display file that says something, so a rename fails loudly', () => {
    // Without this, a moved or renamed constant would leave every comparison
    // below holding two empty lists to each other and passing.
    expect(wall).toContain('export function calendarView');
    expect(tuple('CALENDAR_VIEWS').length).toBeGreaterThan(1);
    expect(tuple('CALENDAR_DENSITIES').length).toBeGreaterThan(1);
    expect(Object.keys(table('LEGACY_CALENDAR_VIEW')).length).toBeGreaterThan(0);
  });

  it('reads one stored value with one function, written out twice', () => {
    /*
     * **The wall is the spec.** If these two ever differ, the display file is
     * right and this one is the copy — that is the whole ordering, and it is
     * why the failure message names which is which rather than printing a
     * symmetrical diff.
     */
    const panel = readFileSync(join(HERE, '..', 'src', 'epaper', 'calendar-view.ts'), 'utf8');
    expect(
      readingOf(panel, 'epaper/calendar-view.ts'),
      "the panel's calendarView has drifted from the wall's in " +
        'apps/display/src/widget-views.ts — the wall is the spec, so copy it back',
    ).toBe(readingOf(wall, 'display/src/widget-views.ts'));
  });

  it('names the same views, in the same order', () => {
    // Order matters as well as membership: the first entry is the default the
    // editor stores as an absence, and the picker renders them in this order.
    expect([...CALENDAR_VIEWS]).toEqual(tuple('CALENDAR_VIEWS'));
  });

  it('names the same densities, in the same order', () => {
    expect([...CALENDAR_DENSITIES]).toEqual(tuple('CALENDAR_DENSITIES'));
  });

  it('maps every value written before the split the same way', () => {
    /*
     * The compatibility promise, held to both files at once. A wall hung before
     * the split stores `skymonth` and no migration rewrites it, so the panel
     * following that wall has to reach the same (view, density) pair — for ever,
     * and from a table rather than from two `if` statements somebody has to
     * notice are a pair.
     */
    expect(LEGACY_CALENDAR_VIEW).toEqual(table('LEGACY_CALENDAR_VIEW'));
    expect(LEGACY_CALENDAR_DENSITY).toEqual(table('LEGACY_CALENDAR_DENSITY'));
  });

  it('answers what the display file declares, for every value either knows', () => {
    /*
     * The tables agreeing is not the same as the *functions* agreeing, and it
     * is the functions that draw. So the server's imported `calendarView` is
     * exercised against every value the display file declares — including the
     * absence, which is the one that has already been got wrong.
     */
    const views = tuple('CALENDAR_VIEWS');
    const densities = tuple('CALENDAR_DENSITIES');
    const legacyView = table('LEGACY_CALENDAR_VIEW');
    const legacyDensity = table('LEGACY_CALENDAR_DENSITY');
    const first = views[0] as string;

    // The default, stored as an absence — on both axes and on either.
    expect(calendarView({})).toEqual({ view: first, density: densities[0] });
    expect(calendarView({ mode: first })).toEqual({ view: first, density: densities[0] });

    for (const view of views) {
      for (const density of densities) {
        expect(calendarView({ mode: view, density }), `${view} + ${density}`).toEqual({
          view,
          density,
        });
      }
    }

    for (const [stored, view] of Object.entries(legacyView)) {
      expect(calendarView({ mode: stored }), stored).toEqual({
        view,
        density: legacyDensity[stored],
      });
    }
  });

  it('reads the same nonsense the same way', () => {
    /*
     * Totality is part of the contract, not a detail of it: this runs inside a
     * draw, so an unknown value is the default rather than an exception on the
     * one screen the household is looking at (rule nine). A config from a newer
     * server is the ordinary way a panel meets a value it has never heard of —
     * and `people`, the Chores widget's board, shares this very key.
     */
    const first = tuple('CALENDAR_VIEWS')[0];
    const comfortable = tuple('CALENDAR_DENSITIES')[0];
    for (const config of [
      { mode: 'people' },
      { mode: 'skyfortnight' },
      { mode: 42 },
      { density: 'cosy' },
      {},
      'not an object',
      [],
      null,
      undefined,
    ]) {
      const seen = calendarView(config);
      if (config !== null && typeof config === 'object' && 'mode' in config) {
        expect(seen.view, JSON.stringify(config)).toBe(first);
      }
      if (JSON.stringify(config) === JSON.stringify({ density: 'cosy' })) {
        expect(seen.density).toBe(comfortable);
      }
    }
  });

  it('lets a legacy value answer both halves, on both sides', () => {
    // A legacy `mode` already carries a density, so a `density` beside it is a
    // contradiction the editor cannot write. Taking the view from one key and
    // the density from another is exactly how two readers come to disagree.
    const [stored, view] = Object.entries(table('LEGACY_CALENDAR_VIEW'))[0] as [string, string];
    const density = table('LEGACY_CALENDAR_DENSITY')[stored];
    const others = tuple('CALENDAR_DENSITIES').filter((one) => one !== density);
    for (const contradiction of others) {
      expect(calendarView({ mode: stored, density: contradiction })).toEqual({ view, density });
    }
    // And the display file says so in the same words, so the two cannot drift
    // into opposite readings of the one case no test data will ever contain.
    expect(wall).toContain('const legacy = LEGACY_CALENDAR_VIEW[mode];');
  });
});

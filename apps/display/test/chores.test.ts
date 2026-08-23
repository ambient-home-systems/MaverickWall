import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_CHORE_SCALE } from '../src/density.js';
import { choresFrom } from '../src/viewmodel.js';
import { WIDGET_VIEWS } from '../src/widget-views.js';

/**
 * The chore board on the wall (RFC 008 phase 2).
 *
 * Two halves: the defensive read of the panel, and the one assertion that
 * exists because this project has already paid for its absence — that the two
 * renderers which draw chores read the stored view the same way.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const EPAPER = join(SRC, '..', '..', 'server', 'src', 'epaper', 'widgets.ts');

const BOARD = {
  today: '2026-08-25',
  days: [
    {
      date: '2026-08-25',
      items: [
        { name: 'Put the bins out', person: 'Sam', color: '#4C7FD1', dueTime: '19:00', done: false },
        { name: 'Feed the cat', person: null, color: null, dueTime: null, done: true },
      ],
    },
    { date: '2026-08-26', items: [] },
  ],
};

describe('choresFrom', () => {
  it('shapes a board and keeps the day with nothing due', () => {
    /*
     * The empty day is kept on purpose. The week view skips it when *drawing*,
     * but a caller laying days out in a grid needs it to line them up, and
     * re-inventing it from a sparse list is how two renderers start disagreeing
     * about which column is which.
     */
    const board = choresFrom(BOARD);
    expect(board?.today).toBe('2026-08-25');
    expect(board?.days).toHaveLength(2);
    expect(board?.days[1]?.items).toEqual([]);
    expect(board?.days[0]?.items[0]).toEqual({
      name: 'Put the bins out',
      person: 'Sam',
      color: '#4C7FD1',
      dueTime: '19:00',
      done: false,
    });
    expect(board?.days[0]?.items[1]?.done).toBe(true);
    expect(board?.days[0]?.items[1]?.person).toBeUndefined();
  });

  it('refuses a colour that is not a hex, rather than passing it to a style', () => {
    // The only value from this panel that reaches a `style` attribute. A string
    // the renderer would hand to `setProperty` is the one field here worth
    // being strict about.
    const board = choresFrom({
      today: '2026-08-25',
      days: [{ date: '2026-08-25', items: [{ name: 'Bins', color: 'red; background:url(x)' }] }],
    });
    expect(board?.days[0]?.items[0]?.color).toBeUndefined();
  });

  it('drops a bad day and a bad item without losing the rest', () => {
    const board = choresFrom({
      today: '2026-08-25',
      days: [
        { date: 'sometime', items: [{ name: 'Nope' }] },
        { date: '2026-08-26', items: [{ name: 'Bins' }, { nope: true }, 'not an object'] },
      ],
    });
    expect(board?.days).toHaveLength(1);
    expect(board?.days[0]?.date).toBe('2026-08-26');
    expect(board?.days[0]?.items.map((item) => item.name)).toEqual(['Bins']);
  });

  it('refuses a panel with no usable day at all', () => {
    expect(choresFrom(undefined)).toBeUndefined();
    expect(choresFrom({ today: '2026-08-25' })).toBeUndefined();
    expect(choresFrom({ today: 'today', days: [] })).toBeUndefined();
    expect(choresFrom({ days: [{ date: '2026-08-25', items: [] }] })).toBeUndefined();
  });

  it('refuses a due time that is not one', () => {
    const board = choresFrom({
      today: '2026-08-25',
      days: [{ date: '2026-08-25', items: [{ name: 'Bins', dueTime: '25:99' }] }],
    });
    expect(board?.days[0]?.items[0]?.dueTime).toBeUndefined();
  });
});

/** The body of a named function, from its declaration to the next column-0 brace. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end, `${declaration} has no end`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('the wall and the panel read one stored view the same way', () => {
  /*
   * This is the assertion the e-paper calendar shipped without.
   *
   * The editor stores a widget's default view by *leaving the key out*, and the
   * panel's calendar tested `mode === 'month'` against that absence — so all
   * three "Show as" values drew the same thing and the commonest setting was
   * the broken one. It was reported as "the calendar settings have no impact".
   *
   * Two renderers reading one stored value opposite ways is the shape of that
   * bug, so this holds both chore renderers to the same literals and to the
   * same table. The wall is the spec; the panel follows it.
   */
  const wall = functionBody(
    readFileSync(join(SRC, 'render.ts'), 'utf8'),
    'function renderChoresWidget(',
  );
  const panel = functionBody(readFileSync(EPAPER, 'utf8'), 'function drawChores(');

  const modesIn = (body: string): string[] =>
    [...body.matchAll(/mode === '([a-z]*)'/g)].map((match) => match[1] as string).sort();

  it('branches on the same values in both renderers', () => {
    expect(modesIn(wall)).toEqual(['people', 'week']);
    expect(modesIn(panel)).toEqual(modesIn(wall));
  });

  it('treats an absent mode as the default in both, rather than as nothing', () => {
    // Neither may compare against the *first* view's value, because that value
    // is never stored — an absence is what "Today" looks like on disk.
    for (const body of [wall, panel]) {
      expect(body).not.toContain("mode === 'today'");
      expect(body).toMatch(/mode\s*=\s*(?:str\(config, 'mode'\)|typeof cfg\['mode'\])/);
    }
  });

  it('offers exactly those two named views plus the default, in the table', () => {
    const views = WIDGET_VIEWS['chores'];
    expect(views?.map((view) => view.value)).toEqual(['', 'people', 'week']);
    // The first view's value is the absence, which is the convention every
    // other type follows and what both renderers above depend on.
    expect(views?.[0]?.value).toBe('');
  });
});

describe('the readable floor', () => {
  /*
   * The floor was found by measuring a real wall, and these pin what the
   * measurement decided rather than re-deriving it. A board of four daily
   * chores over a week is 28 rows; at the note widget's 0.3 the names rendered
   * at 8.1px on a 1280px display, which nobody would report as broken and
   * nobody could read either — the same failure mode `MIN_WEEK_COLUMN_REM`
   * exists to prevent one widget along.
   */
  it('is well above the floor a note or a checklist uses', () => {
    const render = readFileSync(join(SRC, 'render.ts'), 'utf8');
    const noteFloor = /case 'notes':\s*\n\s*case 'todo':\s*\n\s*return ([\d.]+);/.exec(render);
    expect(noteFloor?.[1]).toBe('0.3');
    expect(MIN_CHORE_SCALE).toBeGreaterThan(Number(noteFloor?.[1]));
  });

  it('keeps a chore name legible on a wall, not merely present', () => {
    // 2rem at the 10.8px root this canvas resolves to — the same arithmetic the
    // table in `density.ts` records.
    const nameAtFullSize = 21.6;
    expect(nameAtFullSize * MIN_CHORE_SCALE).toBeGreaterThan(12);
  });

  it('is the value the renderer actually uses', () => {
    // A constant nothing reads is a comment. This is the one line that makes
    // the measurement above load-bearing.
    const render = readFileSync(join(SRC, 'render.ts'), 'utf8');
    expect(render).toMatch(/case 'chores':\s*\n\s*return MIN_CHORE_SCALE;/);
  });
});

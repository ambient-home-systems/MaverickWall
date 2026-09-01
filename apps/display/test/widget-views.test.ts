import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALENDAR_DENSITIES,
  CALENDAR_VIEWS,
  LEGACY_CALENDAR_DENSITY,
  LEGACY_CALENDAR_VIEW,
  WIDGET_VIEWS,
  calendarView,
  viewLabel,
} from '../src/widget-views.js';
import { PALETTE } from '../src/widget-labels.js';

/**
 * Every widget declares what it can draw, and the table agrees with the code.
 *
 * A *view* is which renderer draws a widget — Month grid, Upcoming list — and
 * it is content rather than styling: it decides what you see, not how the box
 * is painted. It used to be labelled "Style" on the Calendar's Content tab,
 * beside a Style *tab* that means something else entirely, which is how it came
 * to be reported as confusing.
 *
 * The table is the seam a widget editor would build on, so these tests are
 * about it staying true rather than about the editor's markup:
 *
 *  - every widget type in the palette has at least one view, so no Content tab
 *    is ever empty and the inspector reads the same from one widget to the next;
 *  - the first view is the default, and its value is stored as an absence,
 *    which is the convention `mode` has always followed;
 *  - and the Calendar's list matches the branches its renderer actually has —
 *    a fourth renderer added with no view here would be unreachable from the
 *    editor, and a fourth view with no renderer would silently draw a month grid.
 *
 * The Calendar had *five* views and two of them were the same view wearing a
 * second name: `skymonth` drew the month grid and `skyweek` the week columns,
 * edge to edge. That was a density choice dressed as a view, and it hid the
 * trade it makes — the dense pair sits under this project's own 22px type
 * floor. There are three views and two densities now, and the second half of
 * this file is about the one function that reads them.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the widget view table', () => {
  it('covers every type the palette can place', () => {
    /*
     * The palette is the first-party allowlist (rule three), read from the
     * editor rather than restated, so a widget added there must declare a view.
     *
     * It used to be scraped out of `layout-editor.ts` with a regular
     * expression, because it lived inside the file's 4,000 lines and nothing
     * could import it. It is `widget-labels.ts` now, so this reads the array
     * itself — a scrape answers about the source text and this answers about
     * the value the editor actually renders.
     */
    const types = PALETTE.map((entry) => entry.type);

    expect(types.length).toBeGreaterThan(5);
    for (const type of types) {
      const views = WIDGET_VIEWS[type];
      expect(views, `${type} declares no view, so its Content tab would be empty`).toBeDefined();
      expect((views ?? []).length, `${type} needs at least one named view`).toBeGreaterThan(0);
    }
  });

  it('names every view, and gives the default an empty value where there is only one', () => {
    for (const [type, views] of Object.entries(WIDGET_VIEWS)) {
      for (const view of views) {
        expect(view.label.trim(), `${type} has an unnamed view`).not.toBe('');
      }
      // One view is stated, not chosen, so it stores nothing at all.
      if (views.length === 1) expect(views[0]?.value, `${type}'s only view must store nothing`).toBe('');
      // Labels are what a household reads; two the same would be unpickable.
      expect(new Set(views.map((v) => v.label)).size).toBe(views.length);
      expect(new Set(views.map((v) => v.value)).size).toBe(views.length);
    }
  });

  it('offers exactly the three views the model names', () => {
    // One list, not two. A view in the picker with nothing to resolve it to is
    // unreachable from `calendarView`; a view in the model the picker never
    // offers is a renderer a household cannot get to.
    expect((WIDGET_VIEWS['calendar'] ?? []).map((v) => v.value)).toEqual([...CALENDAR_VIEWS]);
  });

  it('offers no legacy value, and resolves every one of them', () => {
    /*
     * `skymonth` and `skyweek` are read for ever and written never. A household
     * must not be able to pick one again — that is the whole simplification —
     * and every one that is still out there must land on a view that exists.
     */
    const offered = new Set((WIDGET_VIEWS['calendar'] ?? []).map((v) => v.value));
    for (const legacy of Object.keys(LEGACY_CALENDAR_VIEW)) {
      expect(offered.has(legacy), `${legacy} is still offered as a view`).toBe(false);
      expect(
        (CALENDAR_VIEWS as readonly string[]).includes(LEGACY_CALENDAR_VIEW[legacy] ?? ''),
        `${legacy} maps to a view that does not exist`,
      ).toBe(true);
      expect(
        (CALENDAR_DENSITIES as readonly string[]).includes(LEGACY_CALENDAR_DENSITY[legacy] ?? ''),
        `${legacy} maps to a density that does not exist`,
      ).toBe(true);
    }
    // Both halves of the legacy map describe the same set of old values, or one
    // of them answers a view with no density and falls back to the default.
    expect(Object.keys(LEGACY_CALENDAR_VIEW).sort()).toEqual(
      Object.keys(LEGACY_CALENDAR_DENSITY).sort(),
    );
  });

  it('dispatches on the resolved view, never on the stored string', () => {
    const render = readFileSync(join(SRC, 'render.ts'), 'utf8');
    const from = render.indexOf('function renderCalendarWidget');
    expect(from, 'renderCalendarWidget moved or was renamed').toBeGreaterThan(-1);
    const body = render.slice(from, render.indexOf('\nfunction ', from + 1));

    /*
     * The regression this pins is the one the whole seam exists for.
     *
     * The default view is stored as an *absence*, so any `mode === '…'` in here
     * is a reading of a value the editor does not write — which is how the wall
     * came to read `mode !== 'list'` while the panel read `mode === 'month'`,
     * and how all three of the panel's calendar settings drew the same thing.
     * `calendarView` is the one reading; this asserts there is no second one.
     */
    expect(
      [...body.matchAll(/mode [=!]== '[a-z]+'/g)].map((m) => m[0]),
      'renderCalendarWidget compares `mode` against a literal again',
    ).toEqual([]);

    const branched = new Set([...body.matchAll(/view === '([a-z]+)'/g)].map((m) => m[1] as string));
    expect(branched.size, 'the scan found no views at all, so it proves nothing').toBeGreaterThan(1);
    for (const view of branched) {
      expect(
        (CALENDAR_VIEWS as readonly string[]).includes(view),
        `renderCalendarWidget draws '${view}' but no view offers it`,
      ).toBe(true);
    }
    // Exactly one view is the tail the others fall through to; every other one
    // is named. A second unnamed view would be silently drawn as the tail.
    const unnamed = CALENDAR_VIEWS.filter((view) => !branched.has(view));
    expect(unnamed.length, `these views are drawn by nothing in particular: ${unnamed.join(', ')}`).toBe(1);

    // And density reaches the two renderers that are the whole reason it
    // exists. A `compact` that resolved to the comfortable draw would be a
    // control that does nothing, which is worse than one not offered.
    expect(body).toContain("density === 'compact'");
    expect(body).toContain('renderSkyMonth');
    expect(body).toContain('renderSkyWeek');
  });
});

/**
 * One stored config, read as the pair it means.
 *
 * `calendarView` is the *only* reading on either screen, and
 * `apps/server/test/calendar-view-parity.test.ts` holds the panel's
 * transcription of it to this file. These are about the reading itself: what an
 * absence means, what a value written before the split means, and what happens
 * to something neither.
 */
describe('a calendar widget read as a view and a density', () => {
  it('reads an absent config as the month grid, comfortably', () => {
    // The default is an absence, on both axes, and this is the case that
    // matters most: it is what every wall nobody has configured stores.
    expect(calendarView({})).toEqual({ view: 'month', density: 'comfortable' });
    expect(calendarView(undefined)).toEqual({ view: 'month', density: 'comfortable' });
    expect(calendarView(null)).toEqual({ view: 'month', density: 'comfortable' });
    expect(calendarView({ mode: 'month' })).toEqual({ view: 'month', density: 'comfortable' });
  });

  it('reads each stored view', () => {
    expect(calendarView({ mode: 'week' }).view).toBe('week');
    expect(calendarView({ mode: 'list' }).view).toBe('list');
  });

  it('reads each stored density', () => {
    expect(calendarView({ density: 'compact' })).toEqual({ view: 'month', density: 'compact' });
    expect(calendarView({ mode: 'week', density: 'compact' })).toEqual({
      view: 'week',
      density: 'compact',
    });
    expect(calendarView({ density: 'comfortable' }).density).toBe('comfortable');
  });

  it('reads a canvas written before the split as the pair it meant', () => {
    /*
     * The compatibility promise, and it is a promise about somebody's kitchen:
     * a wall hung before the split holds `skymonth` and no migration will ever
     * rewrite it. `skymonth` *is* month + compact — the same renderer, the same
     * pixels — so it keeps drawing what it drew the day it was hung.
     */
    expect(calendarView({ mode: 'skymonth' })).toEqual({ view: 'month', density: 'compact' });
    expect(calendarView({ mode: 'skyweek' })).toEqual({ view: 'week', density: 'compact' });
  });

  it('lets a legacy value answer both halves rather than half of each', () => {
    /*
     * A legacy `mode` carries a density inside it, so a `density` beside it is
     * a contradiction — and the editor cannot write one, because it writes both
     * keys or neither. Answering the old value whole is what keeps the two
     * renderers agreeing; taking the view from one key and the density from
     * another is how they would come to disagree.
     */
    expect(calendarView({ mode: 'skymonth', density: 'comfortable' })).toEqual({
      view: 'month',
      density: 'compact',
    });
  });

  it('reads anything it cannot make sense of as the default', () => {
    /*
     * Total, because it runs inside a draw (rule nine). `people` is the Chores
     * widget's board sharing this key, and a config from a newer server is the
     * ordinary way a wall meets a value it has never heard of.
     */
    expect(calendarView({ mode: 'people' })).toEqual({ view: 'month', density: 'comfortable' });
    expect(calendarView({ mode: 'skyfortnight' }).view).toBe('month');
    expect(calendarView({ mode: 42 }).view).toBe('month');
    expect(calendarView({ density: 'cosy' }).density).toBe('comfortable');
    expect(calendarView('not an object').view).toBe('month');
    expect(calendarView([]).view).toBe('month');
  });

  it('names a legacy widget by the view it actually draws', () => {
    /*
     * The chip on the canvas and the row in Layers. A `skymonth` box draws the
     * month grid, so it must read "Month grid" — and it must do so because the
     * label asked `calendarView`, not because an unknown value happened to fall
     * back to the first entry in the list.
     */
    expect(viewLabel('calendar', { mode: 'skymonth' })).toBe('Month grid');
    expect(viewLabel('calendar', { mode: 'skyweek' })).toBe('Week columns');
    expect(viewLabel('calendar', {})).toBe('Month grid');
    expect(viewLabel('calendar', { mode: 'list' })).toBe('Upcoming list');
    // A type with one view still says nothing at all.
    expect(viewLabel('clock', {})).toBeUndefined();
  });
});

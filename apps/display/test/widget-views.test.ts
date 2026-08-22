import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIDGET_VIEWS } from '../src/widget-views.js';

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
 *    a sixth renderer added with no view here would be unreachable from the
 *    editor, and a sixth view with no renderer would silently draw a month grid.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the widget view table', () => {
  it('covers every type the palette can place', () => {
    // The palette is the first-party allowlist (rule three), read from the
    // editor rather than restated, so a widget added there must declare a view.
    const editor = readFileSync(join(SRC, 'layout-editor.ts'), 'utf8');
    const block = editor.slice(editor.indexOf('const PALETTE'), editor.indexOf('];', editor.indexOf('const PALETTE')));
    const types = [...block.matchAll(/type:\s*'([a-z]+)'/g)].map((m) => m[1] as string);

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

  it('matches the calendar modes its renderer actually branches on', () => {
    const render = readFileSync(join(SRC, 'render.ts'), 'utf8');
    // Scoped to the calendar's own renderer: `mode` is also the name of a
    // Home Assistant reading's display mode further down the file, and a scan
    // of the whole thing reports `presence` as a calendar view.
    const from = render.indexOf('function renderCalendarWidget');
    expect(from, 'renderCalendarWidget moved or was renamed').toBeGreaterThan(-1);
    const body = render.slice(from, render.indexOf('\nfunction ', from + 1));
    // Both forms count. The renderer dispatches the sky views and the week
    // columns with `===`, and reaches the agenda through `mode !== 'list'` —
    // whose *other* side is the month grid, the default nothing names out loud.
    const branched = new Set(
      [...body.matchAll(/mode [=!]== '([a-z]+)'/g)].map((m) => m[1] as string),
    );
    expect(branched.size, 'the scan found no modes at all, so it proves nothing').toBeGreaterThan(2);
    const declared = new Set((WIDGET_VIEWS['calendar'] ?? []).map((v) => v.value));

    // The default is the fallthrough, so the renderer never names it.
    expect(declared.has('month')).toBe(true);
    expect(branched.has('month')).toBe(false);
    for (const mode of branched) {
      expect(declared.has(mode), `renderCalendarWidget draws '${mode}' but no view offers it`).toBe(true);
    }
    for (const mode of declared) {
      if (mode === 'month') continue;
      expect(branched.has(mode), `a '${mode}' view is offered but no renderer draws it`).toBe(true);
    }
  });
});

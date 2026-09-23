import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MODULES } from '../src/modules/index.js';
import {
  WIDGET_MODULE,
  WIDGET_TYPES,
  buildLayout,
  keepWidgetsWithSomethingToSay,
  widgetIsSetUp,
  type HouseholdRow,
  type PlacedWidgetRow,
} from '../src/api/manifest.js';

/**
 * RFC 009 Phase 2.1 — a widget with nothing behind it yields its space.
 *
 * Three things are checked here and they fail in three different ways.
 *
 * The **table** names module block keys and widget types, and is transcribed
 * rather than imported (see `WIDGET_MODULE`), so a renamed module or a renamed
 * widget would leave it pointing at nothing and silently stop omitting
 * anything — the `options.json` failure, where a control exists and does not
 * work. Both directions, the way the migration journal check does it.
 *
 * The **display's own renderers** decide which widgets can draw the permanent
 * "Nothing to show yet." note at all: `renderWidget` returning `undefined` is
 * what produces it. Every one of those has to be omittable, or the note comes
 * back on a wall nobody configured. Read out of `render.ts` as text, for the
 * same reason `epaper-ladder-parity.test.ts` reads `ladder.ts` as text — the
 * display bundle cannot be imported from here.
 *
 * And the **guard**: filtering must never empty a canvas somebody arranged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER = join(HERE, '..', '..', 'display', 'src', 'render.ts');

const HOUSEHOLD = (over: Partial<HouseholdRow> = {}): HouseholdRow => ({
  timezone: 'Europe/London', shiftEnabled: 0, displayTodayEvents: 8, displayNextDays: 6,
  displayHorizonWeeks: 5, displayBlocks: 'now,next,horizon', clock24: 1, weekStart: 'sunday',
  layoutMode: 'freeform', layoutAspect: 0.5625, layoutLandscapeAspect: 1.7778,
  layoutBackground: null, layoutLandscapeBackground: null,
  ...over,
});

const widget = (id: string, type: string): PlacedWidgetRow => ({
  id, type, x: 0.1, y: 0.1, w: 0.3, h: 0.2, z: 0, config: undefined,
});

describe('the widget/module table', () => {
  /*
   * `todo` is in the table — the registry parity below needs it, since the
   * `todo` module is real — and it is the one entry `widgetIsSetUp` reads
   * conditionally: the table backs a to-do widget only when it names a list.
   * The test above this file's canvas cases is what holds that reading.
   */
  it('names only real module block keys', () => {
    const keys = MODULES.map((module) => module.key);
    const orphans = Object.entries(WIDGET_MODULE).filter(([, block]) => !keys.includes(block));
    expect(
      orphans,
      `a widget is backed by a module block key nothing registers. Its widget would ` +
        `then be omitted from every wall for ever. Registered: ${keys.join(', ')}`,
    ).toEqual([]);
  });

  it('names only real widget types', () => {
    const unknown = Object.keys(WIDGET_MODULE).filter(
      (type) => !(WIDGET_TYPES as readonly string[]).includes(type),
    );
    expect(
      unknown,
      'the table names a widget type the canvas cannot hold, so the entry does nothing.',
    ).toEqual([]);
  });
});

describe('every widget that can draw the note can be omitted', () => {
  /**
   * Which arms of `renderWidget` can return `undefined`.
   *
   * `renderFreeform` draws "Nothing to show yet." exactly when the renderer
   * answers `undefined`, so this set *is* the set of widgets that can carry
   * that note. Parsed rather than assumed: the switch names the function and
   * the function's own signature says whether it can decline.
   */
  function canReturnUndefined(): string[] {
    const source = readFileSync(RENDER, 'utf8');
    const from = source.indexOf('export function renderWidget(');
    expect(from, `no renderWidget in ${RENDER}`).toBeGreaterThan(-1);
    const body = source.slice(from, source.indexOf('\n}', from));
    const declines = new Set(
      [...source.matchAll(/function (render\w+)\([^)]*\)[^{]*:\s*HTMLElement \| undefined/g)].map(
        (match) => match[1] as string,
      ),
    );
    const types: string[] = [];
    for (const arm of body.matchAll(/case '(\w+)':\s*\n?\s*return (render\w+)\(/g)) {
      if (declines.has(arm[2] as string)) types.push(arm[1] as string);
    }
    return types;
  }

  it('is a subset of the widgets the manifest may omit', () => {
    const withNote = canReturnUndefined();
    /*
     * Something has to have been found, or this passes by looking at nothing —
     * a renamed `renderWidget` or a reshaped switch would otherwise read as
     * green rather than as a test that stopped parsing.
     */
    expect(
      withNote.length,
      `no widget renderer in ${RENDER} can return undefined, which cannot be right: ` +
        `the "Nothing to show yet." note is drawn on exactly that answer.`,
    ).toBeGreaterThan(0);

    const nothingSetUp = { modules: [], shift: false, todoLists: [] };
    const stuck = withNote.filter((type) => widgetIsSetUp({ type }, nothingSetUp));
    expect(
      stuck,
      'a widget can draw "Nothing to show yet." and the manifest will never omit ' +
        'it, so a household who has set nothing up gets that sentence on their ' +
        'wall for ever. Either back it with a module in WIDGET_MODULE or give it ' +
        'a prompt of its own that names the control that fixes it.',
    ).toEqual([]);
  });
});

describe('widgetIsSetUp', () => {
  it('keeps what needs nothing and what the household types in itself', () => {
    const nothing = { modules: [], shift: false, todoLists: [] };
    for (const type of ['clock', 'calendar', 'notes', 'todo', 'image', 'countdown', 'external']) {
      expect(widgetIsSetUp({ type }, nothing), `${type} was omitted`).toBe(true);
    }
  });

  it('drops the four whose prerequisite lives on another screen', () => {
    const nothing = { modules: [], shift: false, todoLists: [] };
    for (const type of ['weather', 'homeassistant', 'chores', 'shift']) {
      expect(widgetIsSetUp({ type }, nothing), `${type} survived with nothing behind it`).toBe(false);
    }
  });

  it('keeps a module-backed widget the moment its module is ready', () => {
    expect(widgetIsSetUp({ type: 'weather' }, { modules: ['weather'], shift: false, todoLists: [] })).toBe(true);
    expect(widgetIsSetUp({ type: 'homeassistant' }, { modules: ['home'], shift: false, todoLists: [] })).toBe(true);
    expect(widgetIsSetUp({ type: 'chores' }, { modules: ['chores'], shift: false, todoLists: [] })).toBe(true);
    expect(widgetIsSetUp({ type: 'shift' }, { modules: [], shift: true, todoLists: [] })).toBe(true);
  });

  it('asks a to-do widget which list it names, and answers from that (RFC 012 §6.2)', () => {
    /*
     * The one type whose answer is a fact about its own config. Typed items
     * need nothing; a named list needs to still be watched — and "watched"
     * implies the module is ready, since `ready` is "at least one watched
     * list", so one membership test answers both halves.
     */
    const nothing = { modules: [], shift: false, todoLists: [] };
    const shopping = { modules: ['todo'], shift: false, todoLists: ['todo.shopping'] };
    expect(widgetIsSetUp({ type: 'todo', config: { items: ['Milk'] } }, nothing)).toBe(true);
    expect(widgetIsSetUp({ type: 'todo', config: { list: 'todo.shopping' } }, nothing)).toBe(false);
    expect(widgetIsSetUp({ type: 'todo', config: { list: 'todo.shopping' } }, shopping)).toBe(true);
    // A list the household stopped watching, on a household that still watches another.
    expect(widgetIsSetUp({ type: 'todo', config: { list: 'todo.read_only' } }, shopping)).toBe(false);
    // An empty string is an absence, not a list called "".
    expect(widgetIsSetUp({ type: 'todo', config: { list: '', items: ['Milk'] } }, nothing)).toBe(true);
  });

  it('is about the prerequisite, not the widget having data today', () => {
    /*
     * The distinction the whole design turns on. A ready module contributes no
     * panel when its cache is empty, and that widget keeps its placeholder —
     * "the feed is empty today" is information. Only `readyModules` decides
     * here, and it is fed by `ready`, never by `panels`.
     */
    expect(widgetIsSetUp({ type: 'weather' }, { modules: ['weather'], shift: false, todoLists: [] })).toBe(true);
  });
});

describe('the canvas', () => {
  it('drops the unbacked widgets and keeps the rest', () => {
    const layout = buildLayout(
      HOUSEHOLD(),
      [widget('a', 'clock'), widget('b', 'weather'), widget('c', 'calendar'), widget('d', 'shift')],
      [],
      [],
    );
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['clock', 'calendar']);
  });

  it('keeps them all when the household has set them up', () => {
    const layout = buildLayout(
      HOUSEHOLD({ shiftEnabled: 1 }),
      [widget('a', 'clock'), widget('b', 'weather'), widget('d', 'shift')],
      [],
      ['weather'],
    );
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['clock', 'weather', 'shift']);
  });

  it('never empties a canvas somebody arranged', () => {
    /*
     * Rule nine. A canvas holding only an unconfigured Weather box would draw
     * "Nothing on this display yet." — a lie about a display that *was*
     * arranged, and worse than the per-widget note it replaced.
     */
    const layout = buildLayout(HOUSEHOLD(), [widget('b', 'weather')], [], []);
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['weather']);
  });

  it('draws a typed-items to-do widget on a household with no Home Assistant at all (RFC 012 §6.2)', () => {
    /*
     * The omission trap, and the test the RFC asked for before the change.
     *
     * A `todo` widget's content is typed into the widget itself, so it always
     * has something to say — unless it names a Home Assistant list, which is a
     * prerequisite on another screen. The obvious way to back the list case is
     * a `todo: 'todo'` entry in `WIDGET_MODULE`, and that entry omits **every
     * existing typed checklist** on every wall whose household has no list, at
     * one image pull. Written first, watched go red against exactly that entry,
     * then made to pass by asking the widget rather than the type.
     */
    const typed = { ...widget('t', 'todo'), config: { items: ['Milk', 'Bread'] } };
    const layout = buildLayout(HOUSEHOLD(), [widget('a', 'clock'), typed], [], []);
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['clock', 'todo']);
  });

  it('drops an unknown type even when that leaves the canvas empty', () => {
    // The guard is about widgets the wall could draw. A type with no renderer
    // is not something to fall back to.
    const layout = buildLayout(HOUSEHOLD(), [widget('x', 'website')], [], []);
    expect(layout.portrait.widgets).toEqual([]);
  });

  it('keeps a canvas of nothing-but-unconfigured widgets whole', () => {
    /*
     * The guard is per canvas, which is why the editor's flag has to be per
     * widget rather than per type: on this canvas the wall draws both boxes,
     * so labelling either "not on the wall" would be the screen contradicting
     * the wall it describes.
     */
    const layout = buildLayout(HOUSEHOLD(), [widget('b', 'weather'), widget('c', 'chores')], [], []);
    expect(layout.portrait.widgets.map((w) => w.type)).toEqual(['weather', 'chores']);
  });

  it('is the same filter the e-paper panel applies', () => {
    // One function, both renderers — so a panel following a wall cannot draw
    // "No weather yet" where the wall draws nothing.
    const rows = [widget('a', 'clock'), widget('b', 'weather')];
    expect(
      keepWidgetsWithSomethingToSay(rows, { modules: [], shift: false, todoLists: [] }).map((r) => r.type),
    ).toEqual(['clock']);
  });
});

describe('a fallback for an empty box (RFC 014 §5.3)', () => {
  /*
   * Substitution, and nothing else: a box with nothing to say draws another
   * widget in the same rectangle. Resolved here, in the one function the wall's
   * canvas and the panel's share, so a panel following a wall cannot disagree
   * about what the box holds.
   */
  const notes = { type: 'notes', config: { text: 'Bins go out Tuesday' } };
  const withFallback = (id: string, type: string, whenEmpty: unknown, z = 0): PlacedWidgetRow => ({
    ...widget(id, type),
    z,
    config: { whenEmpty },
  });

  it('draws the fallback in the empty box — same id, same rectangle, same z — and marks it', () => {
    const empty = { ...withFallback('w', 'weather', notes, 3), x: 0.2, y: 0.4, w: 0.5, h: 0.25 };
    const layout = buildLayout(HOUSEHOLD(), [widget('a', 'clock'), empty], [], []);
    const drawn = layout.portrait.widgets.find((w) => w.id === 'w');
    expect(drawn).toMatchObject({
      id: 'w', type: 'notes', x: 0.2, y: 0.4, w: 0.5, h: 0.25, z: 3,
      config: { text: 'Bins go out Tuesday' }, substituted: true,
    });
  });

  it('never replaces a widget that has something to say', () => {
    /*
     * The sentence the whole design rests on. A fallback is what an *empty* box
     * draws, so a Weather box with a location draws weather whatever it names —
     * on the wall and, through the same function, on the panel.
     */
    const layout = buildLayout(HOUSEHOLD(), [withFallback('w', 'weather', notes)], [], ['weather']);
    const [drawn] = layout.portrait.widgets;
    expect(drawn?.type).toBe('weather');
    expect(drawn && 'substituted' in drawn).toBe(false);
    const resolved = keepWidgetsWithSomethingToSay([withFallback('w', 'weather', notes)], {
      modules: ['weather'], shift: false, todoLists: [],
    });
    expect(resolved.map((r) => [r.type, r.substituted])).toEqual([['weather', undefined]]);
  });

  it('checks the fallback for something to say, and drops the box when it has none', () => {
    // A Weather box falling back to a Shift badge on a household with no rota
    // has two things with nothing to say, and is left out exactly as before.
    const layout = buildLayout(
      HOUSEHOLD(),
      [widget('a', 'clock'), withFallback('w', 'weather', { type: 'shift' })],
      [],
      [],
    );
    expect(layout.portrait.widgets.map((w) => w.id)).toEqual(['a']);
  });

  it('draws the fallbacks on a canvas of nothing but empty boxes, not the originals', () => {
    /*
     * The ordering trap. The guard keeps every original when nothing survives,
     * so guarding *before* substituting sees two empty boxes, keeps both, and
     * draws a forecast placeholder and a rota placeholder over two notes the
     * household had already written. Substitute first, then guard.
     */
    const layout = buildLayout(
      HOUSEHOLD(),
      [
        withFallback('w', 'weather', notes, 0),
        withFallback('s', 'shift', { type: 'countdown', config: { target: '2026-12-25' } }, 1),
      ],
      [],
      [],
    );
    expect(layout.portrait.widgets.map((w) => [w.id, w.type, w.substituted])).toEqual([
      ['w', 'notes', true],
      ['s', 'countdown', true],
    ]);
  });

  it('hands back the arranged originals when even the fallbacks have nothing to say', () => {
    // Rule nine, unchanged: the canvas somebody arranged, unedited — never a
    // mixture of their boxes and fallbacks that could not draw either.
    const layout = buildLayout(HOUSEHOLD(), [withFallback('w', 'weather', { type: 'shift' })], [], []);
    expect(layout.portrait.widgets.map((w) => [w.type, 'substituted' in w])).toEqual([['weather', false]]);
  });

  it('turns a to-do fallback’s list into its handle, as it does for any to-do box', () => {
    // The fallback is placed like any widget, so rule 12 reaches it too: the
    // entity id stays on the server.
    const layout = buildLayout(
      HOUSEHOLD(),
      [withFallback('w', 'weather', { type: 'todo', config: { list: 'todo.shopping' } })],
      [],
      [],
      ['todo.shopping'],
    );
    const [drawn] = layout.portrait.widgets;
    expect(drawn?.type).toBe('todo');
    expect(JSON.stringify(layout)).not.toContain('todo.shopping');
  });

  it('never sends the fallback itself to the wall, so a to-do fallback’s entity id stays home', () => {
    /*
     * Rule 12 one level down. A Weather box with a location is not substituted,
     * and its config goes to the wall — so if `whenEmpty` rode along, a to-do
     * fallback's entity id would travel inside a box that is not a to-do widget,
     * where `list`'s rewrite never looks.
     */
    const layout = buildLayout(
      HOUSEHOLD(),
      [withFallback('w', 'weather', { type: 'todo', config: { list: 'todo.shopping' } })],
      [],
      ['weather'],
      ['todo.shopping'],
    );
    expect(layout.portrait.widgets[0]?.type).toBe('weather');
    expect(JSON.stringify(layout)).not.toContain('todo.shopping');
    expect(JSON.stringify(layout)).not.toContain('whenEmpty');
  });

  it('ignores a fallback this build cannot draw, rather than handing the wall one', () => {
    const layout = buildLayout(
      HOUSEHOLD(),
      [widget('a', 'clock'), withFallback('w', 'weather', { type: 'website' })],
      [],
      [],
    );
    expect(layout.portrait.widgets.map((w) => w.id)).toEqual(['a']);
  });
});

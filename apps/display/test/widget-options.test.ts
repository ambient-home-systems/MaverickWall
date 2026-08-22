import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  clockWidgetView,
  panelRowLimit,
  shiftWidgetView,
  weatherWidgetView,
} from '../src/widget-options.js';
import type { TodayShiftModel, WeatherDayModel } from '../src/viewmodel.js';

/**
 * What each widget shows.
 *
 * These are the wall's half of the same options the `epaper-*-widget` tests
 * drive on the panel, and they are asserted here rather than against a DOM
 * because the decisions live in a pure module — which is the whole reason they
 * do. The two renderers reading one set of keys is what stops them drifting
 * again: until 0.45.0 the wall drew `shifts[0]` while the panel drew everybody,
 * so a two-worker household saw different answers on different screens.
 */

const entry = (personId: string, over: Record<string, unknown> = {}): TodayShiftModel =>
  ({
    shift: {
      key: 'day',
      label: 'Days',
      shortCode: 'D',
      colorToken: '--s-day',
      isWorking: true,
      source: 'pattern',
      personId,
      personName: personId,
      personColor: '#888',
      ...over,
    },
    run: 'Day 2 of 4 · 2 more',
  }) as unknown as TodayShiftModel;

const amy = entry('amy');
const ben = entry('ben', { key: 'night', label: 'Nights', shortCode: 'N' });

describe('the shift widget view', () => {
  it('shows everyone on a rota when nobody is picked out', () => {
    // The bug, stated as the behaviour that replaced it. An untouched widget
    // has no config at all, and used to resolve to whoever sorted first.
    expect(shiftWidgetView([amy, ben]).entries.map((e) => e.shift.personId)).toEqual([
      'amy',
      'ben',
    ]);
    expect(shiftWidgetView([amy, ben], {}).entries).toHaveLength(2);
    // An empty selection is the same request as no selection, the way the
    // calendar and reading pickers already read.
    expect(shiftWidgetView([amy, ben], { people: [] }).entries).toHaveLength(2);
  });

  it('shows only the people the household picked, in the household order', () => {
    expect(
      shiftWidgetView([amy, ben], { people: ['ben'] }).entries.map((e) => e.shift.personId),
    ).toEqual(['ben']);
    // Order comes from the manifest, not from the order they were ticked.
    expect(
      shiftWidgetView([amy, ben], { people: ['ben', 'amy'] }).entries.map((e) => e.shift.personId),
    ).toEqual(['amy', 'ben']);
  });

  it('resolves to nothing when the person it watches is off today', () => {
    // The renderer draws the canvas's "nothing to show yet" note for this, the
    // same as weather and house with no data. It must never fall back to
    // somebody else's shift: a box aimed at Amy saying Ben is on nights is the
    // wall answering a question nobody asked.
    expect(shiftWidgetView([ben], { people: ['amy'] }).entries).toEqual([]);
    expect(shiftWidgetView([], {}).entries).toEqual([]);
  });

  it('ignores a person who is not on a rota today rather than drawing a hole', () => {
    expect(
      shiftWidgetView([amy], { people: ['amy', 'nobody'] }).entries.map((e) => e.shift.personId),
    ).toEqual(['amy']);
  });

  it('keeps the photo unless it is switched off', () => {
    // Absence means on: it has been drawn since the badge existed, so a canvas
    // arranged around it survives the schema change.
    expect(shiftWidgetView([amy])).toMatchObject({ face: true, name: 'label' });
    expect(shiftWidgetView([amy], {})).toMatchObject({ face: true });
    expect(shiftWidgetView([amy], { showFace: false })).toMatchObject({ face: false });
  });

  it('carries the ladder, which is the one place rows are decided', () => {
    // The hours and the run stopped being flags on this view when the ladder
    // arrived — two representations of one fact is the drift the seam exists to
    // stop. `shiftLadder` is what still honours the old switches.
    expect(shiftWidgetView([amy]).ladder).toEqual(['person', 'shift', 'hours', 'run']);
    expect(shiftWidgetView([amy], { showHours: false }).ladder).toEqual([
      'person',
      'shift',
      'run',
    ]);
    expect(shiftWidgetView([amy], { fields: ['shift', 'person'] }).ladder).toEqual([
      'shift',
      'person',
    ]);
  });

  it('offers the short code only when it is asked for by name', () => {
    expect(shiftWidgetView([amy], { shiftName: 'code' }).name).toBe('code');
    expect(shiftWidgetView([amy], { shiftName: 'label' }).name).toBe('label');
    // Anything else is the full name, which is what an unset widget draws.
    expect(shiftWidgetView([amy], { shiftName: 'nonsense' }).name).toBe('label');
  });

  it('reads a config it cannot make sense of as an untouched one', () => {
    // The manifest is validated server-side, but a wall can be a version ahead
    // of its server or drawing a document out of IndexedDB, so a config of the
    // wrong shape has to degrade to the default rather than empty the box.
    for (const config of [undefined, null, 'people', 42, { people: 'amy' }, { people: [7] }]) {
      const view = shiftWidgetView([amy, ben], config);
      expect(view.entries).toHaveLength(2);
      expect(view.name).toBe('label');
      expect(view.ladder).toEqual(['person', 'shift', 'hours', 'run']);
    }
  });
});

/* ---------------------------------------------------------------- CLOCK --- */

describe('the clock widget view', () => {
  it('follows the household unless a format is named', () => {
    // Stored as an absence, so a wall that switches to 24-hour later takes its
    // clocks with it rather than leaving them pinned to what they were.
    expect(clockWidgetView().format).toBe('follow');
    expect(clockWidgetView({}).format).toBe('follow');
    expect(clockWidgetView({ clockFormat: '12' }).format).toBe('12');
    expect(clockWidgetView({ clockFormat: '24' }).format).toBe('24');
    // Anything else is the household's, not a third behaviour.
    expect(clockWidgetView({ clockFormat: 'am/pm' }).format).toBe('follow');
  });

  it('keeps the date unless it is switched off', () => {
    expect(clockWidgetView().date).toBe(true);
    expect(clockWidgetView({ showDate: false }).date).toBe(false);
    expect(clockWidgetView({ showDate: true }).date).toBe(true);
  });
});

/* -------------------------------------------------------------- WEATHER --- */

const forecast = (count: number): WeatherDayModel[] =>
  Array.from({ length: count }, (_, i) => ({
    name: `Day ${i}`,
    icon: '*',
    high: `${20 + i}°`,
    low: `${10 + i}°C`,
    date: undefined,
  })) as WeatherDayModel[];

describe('the weather widget view', () => {
  it('shows every day the forecast has when no count is set', () => {
    expect(weatherWidgetView(forecast(7)).days).toHaveLength(7);
    expect(weatherWidgetView(forecast(7), {}).days).toHaveLength(7);
  });

  it('takes the first N days, in order, when one is', () => {
    const view = weatherWidgetView(forecast(7), { count: 3 });
    expect(view.days.map((d) => d.name)).toEqual(['Day 0', 'Day 1', 'Day 2']);
  });

  it('asks for more days than there are without inventing any', () => {
    expect(weatherWidgetView(forecast(3), { count: 10 }).days).toHaveLength(3);
  });

  it('keeps the low and the symbol unless they are switched off', () => {
    expect(weatherWidgetView(forecast(1))).toMatchObject({ low: true, icon: true });
    expect(weatherWidgetView(forecast(1), { showLow: false, showIcon: false })).toMatchObject({
      low: false,
      icon: false,
    });
  });

  it('reads a count it cannot use as no count at all', () => {
    // Never an empty strip: a bad number means "all", not "none" (rule nine).
    for (const count of ['3', 0, -1, NaN, null, {}]) {
      expect(weatherWidgetView(forecast(4), { count }).days, JSON.stringify(count)).toHaveLength(4);
    }
    // A fraction is truncated rather than refused — 2.7 days is two days.
    expect(weatherWidgetView(forecast(4), { count: 2.7 }).days).toHaveLength(2);
  });
});

/* --------------------------------------------------------- MODULE PANEL --- */

describe('the module panel row limit', () => {
  it('is absent until the household sets one', () => {
    expect(panelRowLimit()).toBeUndefined();
    expect(panelRowLimit({})).toBeUndefined();
    expect(panelRowLimit({ module: 'bins' })).toBeUndefined();
  });

  it('is capped at what the panel schema can carry', () => {
    // `panelDataSchema` allows at most twelve items, so a larger number is a
    // control that does nothing past its cap.
    expect(panelRowLimit({ count: 3 })).toBe(3);
    expect(panelRowLimit({ count: 40 })).toBe(12);
  });
});

/* ------------------------------------------------------------ THE SHEET --- */

/**
 * The clock's type is sized per character, and that lives in CSS.
 *
 * Pinned here because there is no DOM in this suite to measure it in, and the
 * bug it fixes is invisible to every other check: a 12-hour clock in a box
 * sized for a 24-hour one wrapped onto two lines. The renderer sets
 * `--clock-chars` from the string it is about to draw; a constant in its place
 * is the bug coming back.
 */
describe('the clock rule in display.css', () => {
  const css = readFileSync(new URL('../src/display.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('.fw-clock .clock {'));
  const block = rule.slice(0, rule.indexOf('}'));

  it('derives the width term from the character count', () => {
    expect(block).toContain('var(--clock-chars');
    // The old constant, which is right for five characters and wrong for eight.
    expect(block).not.toMatch(/--buw\) \* 26\b/);
  });

  it('refuses to wrap even if the sizing is ever wrong again', () => {
    // A clock on two lines does not read as a clock; clipping at the box edge
    // is the better failure.
    expect(block).toContain('white-space: nowrap');
  });

  it('falls back to the five characters it always assumed', () => {
    // A stylesheet newer than the bundle that sets it must still draw a clock.
    expect(block).toMatch(/var\(--clock-chars,\s*5\)/);
  });
});

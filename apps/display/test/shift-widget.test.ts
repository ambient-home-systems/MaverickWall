import { describe, expect, it } from 'vitest';

import { shiftWidgetView } from '../src/shift-widget.js';
import type { TodayShiftModel } from '../src/viewmodel.js';

/**
 * What the Shift widget shows.
 *
 * These are the wall's half of the same options `epaper-shift-widget.test.ts`
 * drives on the panel, and they are asserted here rather than against a DOM
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

  it('keeps the face, the hours and the run unless they are switched off', () => {
    // Absence means on, for all three: they have been drawn since the badge
    // existed, so a canvas arranged around them survives the schema change.
    const untouched = shiftWidgetView([amy]);
    expect(untouched).toMatchObject({ face: true, hours: true, run: true, name: 'label' });
    expect(shiftWidgetView([amy], {})).toMatchObject({ face: true, hours: true, run: true });

    const off = shiftWidgetView([amy], { showFace: false, showHours: false, showRun: false });
    expect(off).toMatchObject({ face: false, hours: false, run: false });
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
    }
  });
});

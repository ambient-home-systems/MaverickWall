import { describe, expect, it } from 'vitest';
import {
  boxAriaLabel,
  drawnWidgets,
  notDrawnFor,
  omissionFlag,
  omissionNote,
  omittedReason,
  widgetOmitted,
  type NotDrawn,
  type OmissionFacts,
} from '../src/omission.js';

/**
 * Which boxes the wall leaves out, and what the editor says about them.
 *
 * Two answers about one widget — the preview draws what the wall will, and the
 * box on top of it says why it is missing — and the whole risk is that they
 * disagree. A box flagged "Not on the wall" over a preview that draws it is a
 * screen contradicting itself, and so is the other way round.
 *
 * The never-empty guard is the reason they can: a canvas that filtered away to
 * nothing keeps everything (rule nine), so on a canvas of only unconfigured
 * widgets every one of them *is* drawn and none may be flagged.
 *
 * Keyed by box since RFC 012 §6.2 — a to-do widget is flagged or not by the
 * list its own settings name, so the flags are a function of the widgets and
 * the facts (`notDrawnFor`), and the server's seed is the same function run
 * once at page load.
 */
const w = (id: string, type: string) => ({ id, type });
const notDrawn = (...pairs: [string, string][]): NotDrawn => new Map(pairs);

const NO_LOCATION = 'Set a location on the Weather screen.';
const NO_PEOPLE = 'Add a person on the Household screen.';

describe('what the preview draws', () => {
  it('is the whole canvas when nothing is flagged', () => {
    const widgets = [w('a', 'clock'), w('b', 'weather')];
    // The same array, not a copy: the editor hands this to the preview on every
    // pointer release, and a fresh array each time is a fresh render each time.
    expect(drawnWidgets(widgets, notDrawn())).toBe(widgets);
  });

  it('leaves out the flagged boxes', () => {
    const widgets = [w('a', 'clock'), w('b', 'weather'), w('c', 'shift')];
    expect(drawnWidgets(widgets, notDrawn(['b', NO_LOCATION])).map((one) => one.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('keeps everything rather than draw an empty wall', () => {
    /*
     * Rule nine. A canvas of nothing but unconfigured widgets would otherwise
     * filter to zero and the preview would draw "Nothing on this wall yet" —
     * a lie about a canvas somebody is looking at while they arrange it.
     */
    const widgets = [w('a', 'weather'), w('b', 'shift')];
    const flags = notDrawn(['a', NO_LOCATION], ['b', NO_PEOPLE]);
    expect(drawnWidgets(widgets, flags)).toBe(widgets);
  });
});

describe('why a box is flagged', () => {
  it('says nothing about a box the wall is happy with', () => {
    expect(omittedReason(w('a', 'clock'), [w('a', 'clock')], notDrawn(['b', NO_LOCATION]))).toBeUndefined();
  });

  it('names the reason the server gave', () => {
    const widgets = [w('a', 'clock'), w('b', 'weather')];
    expect(omittedReason(widgets[1]!, widgets, notDrawn(['b', NO_LOCATION]))).toBe(NO_LOCATION);
  });

  it('says nothing when the never-empty guard put the type back', () => {
    /*
     * The half that cannot be answered from the type alone, and the reason this
     * is a function of the whole canvas. These two widgets are both flagged
     * types, so the guard above keeps both — and flagging either would label a
     * box "not on the wall" while the preview underneath it drew that very box.
     */
    const widgets = [w('a', 'weather'), w('b', 'shift')];
    const flags = notDrawn(['a', NO_LOCATION], ['b', NO_PEOPLE]);
    expect(omittedReason(widgets[0]!, widgets, flags)).toBeUndefined();
    expect(omittedReason(widgets[1]!, widgets, flags)).toBeUndefined();
  });

  it('flags again as soon as one drawable box joins them', () => {
    // The same two widgets, plus a clock: the canvas no longer filters to
    // nothing, so the guard stands down and both flags are honest again.
    const widgets = [w('a', 'weather'), w('b', 'shift'), w('c', 'clock')];
    const flags = notDrawn(['a', NO_LOCATION], ['b', NO_PEOPLE]);
    expect(omittedReason(widgets[0]!, widgets, flags)).toBe(NO_LOCATION);
    expect(omittedReason(widgets[1]!, widgets, flags)).toBe(NO_PEOPLE);
    expect(drawnWidgets(widgets, flags).map((one) => one.id)).toEqual(['c']);
  });

  it('agrees with the preview on every widget, either way round', () => {
    /*
     * The invariant behind both, stated once: a box is flagged exactly when the
     * preview leaves it out. Checked over both canvases above, because each
     * exercises a different side of the guard.
     */
    for (const widgets of [
      [w('a', 'weather'), w('b', 'shift')],
      [w('a', 'weather'), w('b', 'shift'), w('c', 'clock')],
    ]) {
      const flags = notDrawn(['a', NO_LOCATION], ['b', NO_PEOPLE]);
      const drawn = new Set(drawnWidgets(widgets, flags).map((one) => one.id));
      for (const one of widgets) {
        expect(omittedReason(one, widgets, flags) === undefined).toBe(drawn.has(one.id));
      }
    }
  });
});

describe('what the editor says about it', () => {
  it('follows the host, because the same editor arranges a panel', () => {
    // "Not on the wall" beside a 1-bit frame is the wrong object, on a page
    // that says "panel" everywhere else.
    expect(omissionFlag('wall')).toBe('Not on the wall');
    expect(omissionFlag('panel')).toBe('Not on the panel');
    expect(omissionNote(NO_LOCATION, 'panel')).toBe(`Not on the panel yet. ${NO_LOCATION}`);
  });

  it('gives a plain box its plain name', () => {
    expect(boxAriaLabel('Calendar — Month grid', undefined, 'wall')).toBe(
      'Calendar — Month grid widget',
    );
  });

  it('carries the flag and the reason into the name a screen reader hears', () => {
    /*
     * One function for the built box and for `refreshLabels`, which re-reads
     * every name in place when a widget's view changes. The flagged sentence
     * used to be composed only where the box is built, so `refreshLabels`
     * skipped flagged boxes — a Weather box switched to another view showed the
     * new name on its chip and went on announcing the old one, and the visible
     * half updating is exactly what hid it.
     */
    expect(boxAriaLabel('Weather', NO_LOCATION, 'wall')).toBe(
      `Weather widget — not on the wall. ${NO_LOCATION}`,
    );
    expect(boxAriaLabel('Weather', NO_LOCATION, 'panel')).toBe(
      `Weather widget — not on the panel. ${NO_LOCATION}`,
    );
  });
});

describe('deciding the flags from the facts (RFC 012 §6.2)', () => {
  /*
   * The predicate is the transcription of `widgetIsSetUp`, and these are its
   * cases: every type answers from `drawn`, except a to-do box, which is never
   * left out while it draws typed items and is left out when the list it names
   * is no longer one the household watches.
   */
  const facts: OmissionFacts = {
    drawn: { clock: true, weather: false, todo: true, chores: false },
    todoLists: ['todo.shopping'],
    why: { weather: NO_LOCATION, todo: 'Pick a list that is still on Home Assistant.' },
  };
  const typed = { id: 't1', type: 'todo', config: { items: ['Milk'] } };
  const shopping = { id: 't2', type: 'todo', config: { list: 'todo.shopping' } };
  const gone = { id: 't3', type: 'todo', config: { list: 'todo.read_only' } };

  it('answers every other type from what the server said is set up', () => {
    expect(widgetOmitted(w('a', 'clock'), facts)).toBe(false);
    expect(widgetOmitted(w('b', 'weather'), facts)).toBe(true);
    expect(widgetOmitted(w('c', 'chores'), facts)).toBe(true);
    // A type the facts do not name is drawn: absence is not a flag.
    expect(widgetOmitted(w('d', 'notes'), facts)).toBe(false);
  });

  it('never flags a typed checklist, whatever else is set up', () => {
    expect(widgetOmitted(typed, facts)).toBe(false);
    expect(widgetOmitted(typed, { ...facts, todoLists: [] })).toBe(false);
    // An empty string is an absence, not a list called "".
    expect(widgetOmitted({ id: 't0', type: 'todo', config: { list: '', items: ['Milk'] } }, facts)).toBe(false);
  });

  it('flags a to-do box by the list it names, not by its type', () => {
    expect(widgetOmitted(shopping, facts)).toBe(false);
    expect(widgetOmitted(gone, facts)).toBe(true);
    // And follows the list being un-watched, which is the reload case.
    expect(widgetOmitted(shopping, { ...facts, todoLists: [] })).toBe(true);
  });

  it('keys the flags by box, with the type’s sentence', () => {
    const flags = notDrawnFor([w('a', 'clock'), w('b', 'weather'), typed, shopping, gone], facts);
    expect([...flags.entries()]).toEqual([
      ['b', NO_LOCATION],
      ['t3', 'Pick a list that is still on Home Assistant.'],
    ]);
  });

  it('gives a flagged type with no sentence a plain one rather than nothing', () => {
    const flags = notDrawnFor([w('c', 'chores')], facts);
    expect(flags.get('c')).toMatch(/left out/);
  });

  it('agrees with the preview and the reason, so the three cannot disagree', () => {
    // The whole chain, end to end: the same facts decide the map, the map
    // decides the preview, and the reason is read off the map. Two to-do boxes
    // of one type get two answers, which is the case a type-keyed map could not
    // express.
    const widgets = [w('a', 'clock'), typed, gone];
    const flags = notDrawnFor(widgets, facts);
    expect(drawnWidgets(widgets, flags).map((one) => one.id)).toEqual(['a', 't1']);
    expect(omittedReason(gone, widgets, flags)).toBe('Pick a list that is still on Home Assistant.');
    expect(omittedReason(typed, widgets, flags)).toBeUndefined();
  });
});

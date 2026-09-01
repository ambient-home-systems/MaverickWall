import { describe, expect, it } from 'vitest';
import {
  boxAriaLabel,
  drawnWidgets,
  omissionFlag,
  omissionNote,
  omittedReason,
  type NotDrawn,
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

  it('leaves out the flagged types', () => {
    const widgets = [w('a', 'clock'), w('b', 'weather'), w('c', 'shift')];
    expect(drawnWidgets(widgets, notDrawn(['weather', NO_LOCATION])).map((one) => one.id)).toEqual([
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
    const flags = notDrawn(['weather', NO_LOCATION], ['shift', NO_PEOPLE]);
    expect(drawnWidgets(widgets, flags)).toBe(widgets);
  });
});

describe('why a box is flagged', () => {
  it('says nothing about a type the wall is happy with', () => {
    expect(omittedReason(w('a', 'clock'), [w('a', 'clock')], notDrawn(['weather', NO_LOCATION]))).toBeUndefined();
  });

  it('names the reason the server gave', () => {
    const widgets = [w('a', 'clock'), w('b', 'weather')];
    expect(omittedReason(widgets[1]!, widgets, notDrawn(['weather', NO_LOCATION]))).toBe(NO_LOCATION);
  });

  it('says nothing when the never-empty guard put the type back', () => {
    /*
     * The half that cannot be answered from the type alone, and the reason this
     * is a function of the whole canvas. These two widgets are both flagged
     * types, so the guard above keeps both — and flagging either would label a
     * box "not on the wall" while the preview underneath it drew that very box.
     */
    const widgets = [w('a', 'weather'), w('b', 'shift')];
    const flags = notDrawn(['weather', NO_LOCATION], ['shift', NO_PEOPLE]);
    expect(omittedReason(widgets[0]!, widgets, flags)).toBeUndefined();
    expect(omittedReason(widgets[1]!, widgets, flags)).toBeUndefined();
  });

  it('flags again as soon as one drawable box joins them', () => {
    // The same two widgets, plus a clock: the canvas no longer filters to
    // nothing, so the guard stands down and both flags are honest again.
    const widgets = [w('a', 'weather'), w('b', 'shift'), w('c', 'clock')];
    const flags = notDrawn(['weather', NO_LOCATION], ['shift', NO_PEOPLE]);
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
      const flags = notDrawn(['weather', NO_LOCATION], ['shift', NO_PEOPLE]);
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

import { describe, expect, it } from 'vitest';
import { inspectorView, type InspectorInput } from '../src/inspector.js';
import type { NotDrawn } from '../src/omission.js';

/**
 * What the widget inspector should show.
 *
 * Every question here used to be answered in the middle of building the DOM,
 * where this package's test suite — which has no DOM — could not reach any of
 * them. Asked together, the contradictions are visible: an ink lane showing
 * while the lane switch is hidden, a "not on the wall" note over a panel's
 * overrides, a tab chosen for a lane that has no tabs.
 */
const clock = { id: 'c1', type: 'clock' };
const weather = { id: 'w1', type: 'weather' };
const NO_LOCATION = 'Set a location on the Weather screen.';

const ask = (over: Partial<InspectorInput> = {}) =>
  inspectorView({
    widgets: [clock, weather],
    selected: clock.id,
    lane: 'wall',
    inkAvailable: false,
    tab: 'content',
    notDrawn: new Map() as NotDrawn,
    surface: 'wall',
    ...over,
  });

describe('whether there is anything to show', () => {
  it('is empty with nothing selected', () => {
    expect(ask({ selected: undefined }).kind).toBe('empty');
  });

  it('is empty for a selection whose widget has gone', () => {
    // An undo can remove the widget the inspector is describing. The panel
    // closes rather than describe a box that is not on the canvas.
    expect(ask({ selected: 'deleted' }).kind).toBe('empty');
  });
});

describe('what it calls the widget', () => {
  it('names the type in the heading and in what Remove destroys', () => {
    const view = ask();
    expect(view).toMatchObject({ title: 'Clock widget', removeLabel: 'Remove this clock widget' });
  });

  it('falls back to the raw type rather than an unnamed box', () => {
    // A canvas saved by a newer bundle can carry a type this one has no label
    // for. "future widget" is a poorer heading than a real name and is not a
    // blank one, which is the only unacceptable answer.
    const view = ask({ widgets: [{ id: 'x', type: 'future' }], selected: 'x' });
    expect(view).toMatchObject({ title: 'future widget' });
  });
});

describe('the lane', () => {
  it('hides the switch and forces the wall lane when no panel follows', () => {
    /*
     * The forcing is the load-bearing half. A widget left on the ink lane by an
     * earlier selection, on a canvas no panel follows, would offer controls
     * whose writes land in `config.ink` — overrides nothing will ever read.
     */
    const view = ask({ lane: 'ink', inkAvailable: false });
    expect(view).toMatchObject({ laneBarVisible: false, lane: 'wall' });
  });

  it('offers the switch and keeps the lane when a panel follows', () => {
    expect(ask({ lane: 'ink', inkAvailable: true })).toMatchObject({
      laneBarVisible: true,
      lane: 'ink',
    });
  });

  it('marks the lane that is already carrying overrides', () => {
    const withInk = { id: 'c1', type: 'clock', config: { ink: { count: 3 } } };
    expect(ask({ widgets: [withInk], inkAvailable: true }).kind === 'widget').toBe(true);
    expect(ask({ widgets: [withInk], inkAvailable: true })).toMatchObject({
      hasInkOverrides: true,
    });
    // An empty `ink` object is not an override, the same way an empty config is
    // not a stored row.
    expect(
      ask({ widgets: [{ id: 'c1', type: 'clock', config: { ink: {} } }], inkAvailable: true }),
    ).toMatchObject({ hasInkOverrides: false });
    expect(ask()).toMatchObject({ hasInkOverrides: false });
  });

  it('gives the ink lane no tabs, because it has none to fill', () => {
    // A panel honours a handful of keys and they are one short list; two tabs
    // over them would be two mostly-empty tabs.
    const view = ask({ lane: 'ink', inkAvailable: true, tab: 'style' });
    expect(view.kind === 'widget' && view.tab).toBeUndefined();
  });

  it('carries the chosen tab on the wall lane', () => {
    expect(ask({ tab: 'style' })).toMatchObject({ tab: 'style' });
    expect(ask({ tab: 'content' })).toMatchObject({ tab: 'content' });
  });
});

describe('the note about a box the wall leaves out', () => {
  const flagged = new Map([['weather', NO_LOCATION]]) as NotDrawn;

  it('says nothing for a widget the wall draws', () => {
    const view = ask({ selected: clock.id, notDrawn: flagged });
    expect(view.kind === 'widget' && view.note).toBeUndefined();
  });

  it('answers "I put a Weather box on and my wall has not got one"', () => {
    expect(ask({ selected: weather.id, notDrawn: flagged })).toMatchObject({
      note: `Not on the wall yet. ${NO_LOCATION}`,
    });
  });

  it('uses the host’s own noun', () => {
    expect(ask({ selected: weather.id, notDrawn: flagged, surface: 'panel' })).toMatchObject({
      note: `Not on the panel yet. ${NO_LOCATION}`,
    });
  });

  it('says nothing on the ink lane, which is about what a panel says differently', () => {
    const view = ask({
      selected: weather.id,
      notDrawn: flagged,
      lane: 'ink',
      inkAvailable: true,
    });
    expect(view.kind === 'widget' && view.note).toBeUndefined();
  });

  it('says nothing when the never-empty guard means the wall draws it after all', () => {
    // The canvas is nothing but flagged widgets, so every one of them is drawn
    // (rule nine) — and a note explaining an omission that is not happening is
    // the same contradiction on the panel that the flag would be on the box.
    const view = ask({
      widgets: [weather],
      selected: weather.id,
      notDrawn: flagged,
    });
    expect(view.kind === 'widget' && view.note).toBeUndefined();
  });
});

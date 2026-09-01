import { describe, expect, it } from 'vitest';
import {
  canvasSnapshot,
  isCanvasDirty,
  postedBackground,
  widgetsForSave,
  type CanvasShape,
  type EditorWidget,
} from '../src/canvas-state.js';

/**
 * Whether the save bar has anything to write.
 *
 * The editor answers that by comparing what it *would* post with what it last
 * posted, rather than by setting a flag — so what is under test here is not
 * "does the string differ" but the canonical form both sides are built from.
 * The fault this guards is the quiet one: a canvas byte-identical to the one
 * the server holds that reports unsaved changes for ever, because the snapshot
 * and the request body disagree about one field. A household then leaves the
 * page, is asked whether they meant to abandon changes they never made, and
 * learns to ignore the question.
 *
 * The other direction is the expensive one and has already shipped once in this
 * project: a switch that reported a failed save as a success.
 */
const widget = (over: Partial<EditorWidget> = {}): EditorWidget => ({
  id: 'w1',
  type: 'clock',
  x: 0.1,
  y: 0.1,
  w: 0.4,
  h: 0.2,
  z: 0,
  ...over,
});

const canvas = (over: Partial<CanvasShape> = {}): CanvasShape => ({
  aspect: 0.5625,
  widgets: [widget()],
  ...over,
});

describe('the canvas as the server wants it', () => {
  it('renumbers z as the back-to-front index, so a raised box is not a change', () => {
    // A drag raises the grabbed box by setting z one above every other, so a
    // canvas that has been dragged carries 0, 1, 2, 5. The server is posted the
    // index, and comes back 0, 1, 2, 3 — comparing the raw numbers would report
    // a difference on every save that had none.
    const saved = widgetsForSave([
      widget({ id: 'a', z: 5 }),
      widget({ id: 'b', z: 0 }),
      widget({ id: 'c', z: 2 }),
    ]);
    expect(saved.map((one) => [one.id, one.z])).toEqual([
      ['b', 0],
      ['c', 1],
      ['a', 2],
    ]);
  });

  it('leaves out an empty config, so an untouched widget stores no row', () => {
    expect(widgetsForSave([widget({ config: {} })])[0]).not.toHaveProperty('config');
    expect(widgetsForSave([widget()])[0]).not.toHaveProperty('config');
    expect(widgetsForSave([widget({ config: { mode: 'list' } })])[0]?.config).toEqual({
      mode: 'list',
    });
  });

  it('clamps a box to the canvas and to the size floor', () => {
    const [one] = widgetsForSave([widget({ x: -0.5, y: 2, w: 0.01, h: 4 })]);
    expect(one).toMatchObject({ x: 0, y: 1, w: 0.05, h: 1 });
  });

  it('rounds to the three places the canvas is stored in', () => {
    const [one] = widgetsForSave([widget({ x: 0.123456, w: 0.987654 })]);
    expect([one?.x, one?.w]).toEqual([0.123, 0.988]);
  });
});

describe('the background as it is posted', () => {
  it('is null for no background at all', () => {
    expect(postedBackground(undefined)).toBeNull();
  });

  it('is null for an image type with no picture chosen', () => {
    // The editor holds `{type:'image', image:''}` the moment somebody picks
    // Image and before they pick a file. That is "no background", not a save
    // the server would refuse — and the snapshot has to agree, or a canvas
    // nobody has touched reports unsaved changes.
    expect(postedBackground({ type: 'image', image: '' })).toBeNull();
  });

  it('is the background itself once there is one', () => {
    expect(postedBackground({ type: 'image', image: 'cat.png' })).toEqual({
      type: 'image',
      image: 'cat.png',
    });
    expect(postedBackground({ type: 'solid', color: '#101418' })).toEqual({
      type: 'solid',
      color: '#101418',
    });
  });
});

describe('whether anything is unsaved', () => {
  it('is quiet on the canvas the server was given', () => {
    const now = canvas();
    expect(isCanvasDirty(now, canvasSnapshot(now), false)).toBe(false);
  });

  it('is quiet after an undo that arrives back where it started', () => {
    // The whole reason dirtiness is a comparison rather than a flag: a flag set
    // by the edit is never cleared by the undo of it.
    const start = canvas();
    const saved = canvasSnapshot(start);
    const moved = canvas({ widgets: [widget({ x: 0.5 })] });
    expect(isCanvasDirty(moved, saved, false)).toBe(true);
    expect(isCanvasDirty(start, saved, false)).toBe(false);
  });

  it('speaks up for a canvas whose only difference is the other orientation', () => {
    // Dirtiness is per canvas. The one waiting in the stash keeps the bar live
    // while the household is looking at the other, which is what stops a switch
    // from having to perform a hidden save to record it.
    const now = canvas();
    expect(isCanvasDirty(now, canvasSnapshot(now), true)).toBe(true);
  });

  it('does not mistake a raised box, an empty config or a blank image for work', () => {
    /*
     * Three ways a canvas can look different and be the same. Each of these was
     * a live phantom-dirty candidate: the drag renumbers z, the inspector can
     * leave `{}` behind by clearing the last option, and choosing Image before
     * choosing a file leaves an empty picture. All three would have left the
     * save bar lit on a canvas identical to what the server holds.
     */
    const saved = canvasSnapshot(
      canvas({ widgets: [widget({ id: 'a', z: 0 }), widget({ id: 'b', z: 1 })] }),
    );
    const same = canvas({
      widgets: [widget({ id: 'a', z: 0, config: {} }), widget({ id: 'b', z: 9 })],
      background: { type: 'image', image: '' },
    });
    expect(isCanvasDirty(same, saved, false)).toBe(false);
  });

  it('speaks up for an option written, a box moved and an aspect changed', () => {
    const saved = canvasSnapshot(canvas());
    expect(isCanvasDirty(canvas({ widgets: [widget({ config: { mode: 'list' } })] }), saved, false)).toBe(true);
    expect(isCanvasDirty(canvas({ widgets: [widget({ x: 0.2 })] }), saved, false)).toBe(true);
    expect(isCanvasDirty(canvas({ aspect: 1.7778 }), saved, false)).toBe(true);
    expect(isCanvasDirty(canvas({ background: { type: 'solid', color: '#000' } }), saved, false)).toBe(true);
  });

  it('speaks up for a box added and for one removed', () => {
    const saved = canvasSnapshot(canvas());
    expect(isCanvasDirty(canvas({ widgets: [] }), saved, false)).toBe(true);
    expect(
      isCanvasDirty(canvas({ widgets: [widget(), widget({ id: 'w2', z: 1 })] }), saved, false),
    ).toBe(true);
  });
});

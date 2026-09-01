import { describe, expect, it } from 'vitest';
import {
  MIN_SIZE,
  NUDGE_STEP,
  SNAP,
  moveTo,
  nextZ,
  nudge,
  resizeTo,
  resolveDrag,
  setDimension,
  snapValue,
} from '../src/placement.js';

/**
 * Where a widget lands, in the three ways it can be moved.
 *
 * A pointer drag, an arrow key and a typed number all answer the same question,
 * and this is the module they answer it in. The point of the extraction is that
 * they cannot disagree: a nudge that stopped at a different edge than a drag is
 * two rules for one canvas, which is the shape of most of the faults in this
 * project's own list.
 */
const box = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };
/** The three places every coordinate here is stored in. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

describe('moving a box', () => {
  it('keeps the whole box on the canvas', () => {
    // Not the top-left corner: a box pushed right stops when its *right* edge
    // reaches the edge, which is 1 - w.
    expect(moveTo(box, 0.9, 0.3)).toEqual({ x: 0.6, y: 0.3, w: 0.4, h: 0.2 });
    expect(moveTo(box, -0.5, -0.5)).toEqual({ x: 0, y: 0, w: 0.4, h: 0.2 });
  });

  it('rounds to the three places the canvas is saved in', () => {
    expect(moveTo(box, 0.123456, 0.987654).x).toBe(0.123);
  });

  it('leaves the size alone', () => {
    const moved = moveTo(box, 0.1, 0.1);
    expect([moved.w, moved.h]).toEqual([box.w, box.h]);
  });
});

describe('resizing a box', () => {
  it('grows from the top-left, so the origin does not move', () => {
    const bigger = resizeTo(box, 0.5, 0.4);
    expect([bigger.x, bigger.y]).toEqual([box.x, box.y]);
    expect([bigger.w, bigger.h]).toEqual([0.5, 0.4]);
  });

  it('stops at the edge of the canvas', () => {
    expect(resizeTo(box, 2, 2)).toEqual({ x: 0.2, y: 0.3, w: 0.8, h: 0.7 });
  });

  it('refuses to shrink below a box anybody could grab again', () => {
    expect(resizeTo(box, 0, 0)).toEqual({ x: 0.2, y: 0.3, w: MIN_SIZE, h: MIN_SIZE });
  });

  it('keeps the floor even against an edge with less room than the floor', () => {
    // x = 0.99 leaves a hundredth of the canvas, which is smaller than the
    // floor. The floor wins: a 1% box is one nobody can find again.
    const cornered = resizeTo({ x: 0.99, y: 0.99, w: 0.1, h: 0.1 }, 0.5, 0.5);
    expect([cornered.w, cornered.h]).toEqual([MIN_SIZE, MIN_SIZE]);
  });
});

describe('an arrow key', () => {
  it('moves one per cent of the canvas', () => {
    expect(NUDGE_STEP).toBe(0.01);
    expect(nudge(box, 'ArrowRight', { resize: false })).toEqual({ ...box, x: 0.21 });
    expect(nudge(box, 'ArrowLeft', { resize: false })).toEqual({ ...box, x: 0.19 });
    expect(nudge(box, 'ArrowDown', { resize: false })).toEqual({ ...box, y: 0.31 });
    expect(nudge(box, 'ArrowUp', { resize: false })).toEqual({ ...box, y: 0.29 });
  });

  it('resizes with Shift, along the same axes', () => {
    expect(nudge(box, 'ArrowRight', { resize: true })).toEqual({ ...box, w: 0.41 });
    expect(nudge(box, 'ArrowUp', { resize: true })).toEqual({ ...box, h: 0.19 });
  });

  it('answers nothing for a key that is not an arrow', () => {
    // Which is what lets the editor leave the event alone: an arrow that is not
    // a nudge has to keep scrolling the page, and one that is must not.
    for (const key of ['Enter', ' ', 'a', 'Tab', 'Escape', 'PageUp']) {
      expect(nudge(box, key, { resize: false })).toBeUndefined();
    }
  });

  it('stops at the same edge a drag does', () => {
    const atEdge = { x: 0.6, y: 0.3, w: 0.4, h: 0.2 };
    expect(nudge(atEdge, 'ArrowRight', { resize: false })).toEqual(atEdge);
  });
});

describe('a typed number', () => {
  it('writes one edge and clamps it like everything else', () => {
    expect(setDimension(box, 'x', 0.5).x).toBe(0.5);
    expect(setDimension(box, 'x', 1.4).x).toBe(0.6);
    expect(setDimension(box, 'w', 0.9).w).toBe(0.8);
    expect(setDimension(box, 'h', 0.01).h).toBe(MIN_SIZE);
  });

  it('ignores a value that is not one', () => {
    // A field mid-edit hands over NaN, and a widget at NaN draws nowhere.
    expect(setDimension(box, 'x', Number.NaN)).toEqual(box);
    expect(setDimension(box, 'w', Number.POSITIVE_INFINITY)).toEqual(box);
  });
});

describe('snapping', () => {
  it('is the identity, rounded, while it is off', () => {
    expect(snapValue(0.318, false)).toBe(0.318);
    expect(snapValue(0.3181234, false)).toBe(0.318);
  });

  it('lands on the grid while it is on', () => {
    // 24 steps across the axis, so a step is 0.0417 and a coordinate a third of
    // the way across lands on the eighth line.
    expect(snapValue(0.32, true)).toBe(round3(8 * SNAP));
    expect(snapValue(0, true)).toBe(0);
    expect(snapValue(1, true)).toBe(1);
  });
});

describe('a pointer drag', () => {
  const origin = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };
  const free = { resize: false, snap: false };

  it('moves the box by the distance the pointer went', () => {
    expect(resolveDrag(origin, { dx: 0.1, dy: -0.1 }, free)).toEqual({
      x: 0.3,
      y: 0.2,
      w: 0.4,
      h: 0.2,
    });
  });

  it('resizes from the top-left, leaving the origin where it was', () => {
    expect(resolveDrag(origin, { dx: 0.1, dy: 0.1 }, { resize: true, snap: false })).toEqual({
      x: 0.2,
      y: 0.3,
      w: 0.5,
      h: 0.3,
    });
  });

  it('stops where an arrow key stops', () => {
    /*
     * The whole reason the drag, the arrow keys and the numeric fields share
     * this module. A drag pulled far past the right-hand edge has to settle on
     * exactly the box a hundred arrow presses would reach.
     */
    const dragged = resolveDrag(origin, { dx: 5, dy: 5 }, free);
    let nudged = origin;
    for (let i = 0; i < 200; i += 1) {
      nudged = nudge(nudged, 'ArrowRight', { resize: false }) ?? nudged;
      nudged = nudge(nudged, 'ArrowDown', { resize: false }) ?? nudged;
    }
    expect(dragged).toEqual(nudged);
    expect(dragged).toEqual(moveTo(origin, 1, 1));
  });

  it('snaps before it clamps, so a snap cannot push a box off the canvas', () => {
    /*
     * Rounding *after* the clamp is the way to get this wrong: a box held
     * against the right-hand edge at x = 0.6 would round up to 0.625 and end up
     * over the edge it had just been kept inside. Snapped first, the clamp has
     * the last word.
     */
    const wide = { x: 0.2, y: 0.3, w: 0.38, h: 0.2 };
    const snapped = resolveDrag(wide, { dx: 0.42, dy: 0 }, { resize: false, snap: true });
    // Snapped first: 0.62 rounds up to the 15th line, 0.625, and the clamp puts
    // it back on 0.62. Clamped first it would land on 0.62 and the snap would
    // then round it to 0.625 — off the right-hand edge by 0.005, with nothing
    // left to bring it back.
    expect(snapped.x).toBe(0.62);
    expect(snapped.x + snapped.w).toBeLessThanOrEqual(1);
  });

  it('lands on the grid while snapping, and between it while not', () => {
    const snapped = resolveDrag(origin, { dx: 0.031, dy: 0 }, { resize: false, snap: true });
    expect(snapped.x).toBe(round3(6 * SNAP));
    expect(resolveDrag(origin, { dx: 0.031, dy: 0 }, free).x).toBe(0.231);
  });

  it('keeps the size through a move and the origin through a resize', () => {
    // Which is what lets one `origin` serve as both the base box and the base
    // coordinates: the drag reads a box that never changed in the axes it is
    // clamping against.
    const moved = resolveDrag(origin, { dx: 0.1, dy: 0.1 }, free);
    expect([moved.w, moved.h]).toEqual([origin.w, origin.h]);
    const sized = resolveDrag(origin, { dx: 0.1, dy: 0.1 }, { resize: true, snap: false });
    expect([sized.x, sized.y]).toEqual([origin.x, origin.y]);
  });

  it('cannot shrink a box below the floor however far the handle is dragged', () => {
    const sized = resolveDrag(origin, { dx: -5, dy: -5 }, { resize: true, snap: false });
    expect([sized.w, sized.h]).toEqual([MIN_SIZE, MIN_SIZE]);
  });
});

describe('bringing a box to the front', () => {
  it('answers one above the highest, so a grabbed box is drawn over the rest', () => {
    expect(nextZ([{ z: 0 }, { z: 4 }, { z: 2 }])).toBe(5);
  });

  it('answers 1 on an empty canvas, leaving 0 free', () => {
    // `Math.max()` of nothing is -Infinity, which is why the floor is stated.
    expect(nextZ([])).toBe(1);
  });

  it('ignores a negative z rather than going below it', () => {
    expect(nextZ([{ z: -3 }])).toBe(1);
  });
});

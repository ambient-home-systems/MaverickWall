import { describe, expect, it } from 'vitest';
import { MIN_SIZE, NUDGE_STEP, moveTo, nudge, resizeTo, setDimension } from '../src/placement.js';

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

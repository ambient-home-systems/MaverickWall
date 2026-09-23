import { describe, expect, it } from 'vitest';

import { MARQUEE_MIN, enclosedBy, marqueeBetween, toggleSelected } from '../src/selection.js';

/**
 * The selection as a set (RFC 014 §5.1): what a Shift+click and a marquee
 * make of it, with no pointer anywhere near.
 */
describe('a Shift+click', () => {
  it('adds a box that is out and removes one that is in, keeping the order', () => {
    expect(toggleSelected([], 'a')).toEqual(['a']);
    expect(toggleSelected(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelected(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});

describe('a marquee', () => {
  it('is the rectangle between two points whichever corner it started from', () => {
    expect(marqueeBetween({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.125 })).toEqual({ x: 0.25, y: 0.125, w: 0.5, h: 0.375 });
    expect(MARQUEE_MIN).toBeLessThan(0.01);
  });

  it('selects what it encloses and not what it merely touches', () => {
    const boxes = [
      { id: 'in', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { id: 'edge', x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
      { id: 'touched', x: 0.4, y: 0.4, w: 0.3, h: 0.3 },
      { id: 'out', x: 0.8, y: 0.8, w: 0.1, h: 0.1 },
    ];
    // Exactly on the far edge is inside; a box that crosses it is not.
    expect(enclosedBy(boxes, { x: 0, y: 0, w: 0.5, h: 0.5 })).toEqual(['in', 'edge']);
    expect(enclosedBy(boxes, { x: 0.05, y: 0.05, w: 0.1, h: 0.1 })).toEqual([]);
  });
});

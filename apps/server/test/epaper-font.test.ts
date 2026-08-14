import { describe, expect, it } from 'vitest';

import { Framebuffer } from '../src/epaper/framebuffer.js';
import { drawText, measureText } from '../src/epaper/font.js';

/**
 * The bitmap font renders the right shapes the right way round.
 *
 * A glyph rendered mirror-imaged or upside down passes any "did it draw
 * something" check, so this asserts an actual, hand-derived shape. The 'A' grid
 * below was read off the canonical font8x8 bytes (0C 1E 33 33 3F 33 33 00) by
 * hand, LSB = leftmost column — so if the blitter's bit order were wrong, this
 * would not match.
 */

/** Render text onto a fresh canvas and read it back as an ASCII-art grid. */
function render(text: string, w: number, h: number, scale = 1): string[] {
  const fb = new Framebuffer(w, h);
  drawText(fb, 0, 0, text, { scale, tracking: 0 });
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = '';
    for (let x = 0; x < w; x++) line += fb.get(x, y) ? 'X' : '.';
    rows.push(line);
  }
  return rows;
}

describe('glyph shapes', () => {
  it("draws 'A' the right way up and the right way round", () => {
    const expected = [
      '..XX....',
      '.XXXX...',
      'XX..XX..',
      'XX..XX..',
      'XXXXXX..',
      'XX..XX..',
      'XX..XX..',
      '........',
    ];
    expect(render('A', 8, 8)).toEqual(expected);
  });

  it('a space is blank and a digit is not', () => {
    expect(render(' ', 8, 8).every((r) => r === '........')).toBe(true);
    expect(render('7', 8, 8).some((r) => r.includes('X'))).toBe(true);
  });
});

describe('layout', () => {
  it('measures monospace width with tracking', () => {
    // 8px cell + 1px tracking, minus the trailing tracking on the last glyph.
    expect(measureText('AB', { scale: 1, tracking: 1 })).toBe(8 + 1 + 8);
    expect(measureText('AB', { scale: 2, tracking: 1 })).toBe((8 + 1 + 8) * 2 - 2 + 2);
    expect(measureText('', {})).toBe(0);
  });

  it('scale doubles every drawn pixel', () => {
    const one = render('A', 8, 8, 1);
    const two = render('A', 16, 16, 2);
    // The top of the 'A' apex is at (2,0) at scale 1; at scale 2 it is the
    // 2×2 block anchored at (4,0).
    expect(one[0]![2]).toBe('X');
    expect(two[0]![4]).toBe('X');
    expect(two[0]![5]).toBe('X');
    expect(two[1]![4]).toBe('X');
  });

  it('drawText returns the x past the last glyph for chaining', () => {
    const fb = new Framebuffer(64, 8);
    const end = drawText(fb, 0, 0, 'AB', { scale: 1, tracking: 1 });
    expect(end).toBe(measureText('AB', { scale: 1, tracking: 1 }));
  });
});

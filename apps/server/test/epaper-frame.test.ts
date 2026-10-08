import { describe, expect, it } from 'vitest';

import { Framebuffer } from '../src/epaper/framebuffer.js';
import { bitString } from './epaper-frame.js';

/** The way every e-paper test built this string before `bitString`: one `get` per pixel. */
function slowly(fb: Framebuffer, width = fb.width, height = fb.height): string {
  let out = '';
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out += fb.get(x, y) ? '1' : '0';
  return out;
}

/** A framebuffer with pixels set by a fixed pseudo-random sequence, so every byte value turns up. */
function scattered(width: number, height: number, seed: number): Framebuffer {
  const fb = new Framebuffer(width, height);
  let state = seed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      if (state % 3 === 0) fb.set(x, y);
    }
  }
  return fb;
}

describe('a frame as a string of pixels', () => {
  it('is exactly what reading every pixel gave, at widths on and off a byte boundary', () => {
    for (const [width, height] of [[8, 1], [520, 300], [13, 7], [801, 3], [1, 1]] as const) {
      const fb = scattered(width, height, width * 31 + height);
      expect(bitString(fb), `${width}x${height}`).toBe(slowly(fb));
    }
  });

  it('reads a window larger or smaller than the frame the way get() does', () => {
    const fb = scattered(20, 10, 7);
    expect(bitString(fb, 24, 12)).toBe(slowly(fb, 24, 12));
    expect(bitString(fb, 9, 4)).toBe(slowly(fb, 9, 4));
  });

  it('never shows the padding past the last pixel of a row', () => {
    // A frame filled with ink sets the padding bits too; a width of 13 has three.
    const fb = new Framebuffer(13, 2);
    fb.clear(true);
    expect(bitString(fb)).toBe('1'.repeat(26));
  });
});

import { describe, expect, it } from 'vitest';

import { encodeQr } from '../src/qr.js';
import { QR_STYLE_MIN_PX, qrPaths, qrShapes, qrStyleFits } from '../src/qr-shapes.js';

/**
 * The QR code's dot and eye styles (plan item M5.3). Whether each style reads
 * is the browser test's, by decoding a screenshot; this holds the paths: that
 * square is the code it always was, and that a style draws every dark module
 * once — the eyes as eyes and everything else as a module — and nothing more.
 */

/** The path every code was drawn with before the styles existed: runs of unit squares. */
function runs(matrix: { size: number; modules: readonly (readonly boolean[])[] }, quiet: number): string {
  let d = '';
  for (let row = 0; row < matrix.size; row++) {
    const line = matrix.modules[row] as readonly boolean[];
    let column = 0;
    while (column < matrix.size) {
      if (!line[column]) {
        column++;
        continue;
      }
      let end = column;
      while (end < matrix.size && line[end]) end++;
      d += `M${column + quiet} ${row + quiet}h${end - column}v1h${column - end}z`;
      column = end;
    }
  }
  return d;
}

const matrix = encodeQr('https://example.com/menu');
if (matrix === undefined) throw new Error('fixture does not encode');
const dark = matrix.modules.flat().filter(Boolean).length;
// Each eye is 7x7: a ring of 24, a light ring of 16, a centre of 9.
const EYE_DARK = 3 * (24 + 9);
// A version 2 code has one alignment pattern, a 5x5 ring round a centre.
const ALIGN_DARK = 16 + 1;

describe('qrPaths', () => {
  it('draws a code nobody restyled exactly as it always was: one crisp path of runs, no separate eyes', () => {
    const paths = qrPaths(matrix, 4, { dots: 'square', eyes: 'square' });
    expect(paths).toEqual({ modules: runs(matrix, 4), eyes: '', crisp: true });
  });

  it('draws each dark module outside the eyes once as a dot, and the eyes as three rings and centres', () => {
    const paths = qrPaths(matrix, 4, { dots: 'dots', eyes: 'circle' });
    expect(paths.modules.match(/M/g)?.length).toBe(dark - EYE_DARK);
    // Two arcs a dot; the alignment pattern, 16 dark modules round one, is rounded squares of four.
    expect(paths.modules.match(/a/g)?.length).toBe(2 * (dark - EYE_DARK - ALIGN_DARK) + 4 * ALIGN_DARK);
    expect(paths.eyes.match(/M/g)?.length).toBe(9);
    expect(paths.crisp).toBe(false);
  });

  it('draws rounded modules one a module, and square eyes as squares when only the dots are styled', () => {
    const paths = qrPaths(matrix, 4, { dots: 'rounded', eyes: 'square' });
    expect(paths.modules.match(/M/g)?.length).toBe(dark - EYE_DARK);
    expect(paths.eyes).toBe(
      'M4 4h7v7h-7zM5 5h5v5h-5zM6 6h3v3h-3z' +
        `M${4 + matrix.size - 7} 4h7v7h-7zM${5 + matrix.size - 7} 5h5v5h-5zM${6 + matrix.size - 7} 6h3v3h-3z` +
        `M4 ${4 + matrix.size - 7}h7v7h-7zM5 ${5 + matrix.size - 7}h5v5h-5zM6 ${6 + matrix.size - 7}h3v3h-3z`,
    );
  });

  it('keeps square runs for the modules when only the eyes are styled, and leaves the eyes out of them', () => {
    const paths = qrPaths(matrix, 4, { dots: 'square', eyes: 'rounded' });
    expect(paths.modules).not.toContain('a');
    expect(paths.modules).not.toBe(runs(matrix, 4));
    expect(paths.eyes.match(/M/g)?.length).toBe(9);
  });
});

describe('qrShapes', () => {
  it('reads absence, and any value this bundle does not know, as square', () => {
    expect(qrShapes(undefined)).toEqual({ dots: 'square', eyes: 'square' });
    expect(qrShapes({ qrDots: 'hearts', qrEyes: 7 })).toEqual({ dots: 'square', eyes: 'square' });
    expect(qrShapes({ qrDots: 'dots', qrEyes: 'circle' })).toEqual({ dots: 'dots', eyes: 'circle' });
  });
});

describe('qrStyleFits', () => {
  it('keeps a style only while a module is at least QR_STYLE_MIN_PX screen pixels', () => {
    // A version 2 code is 25 modules and 8 of quiet zone: 33 across.
    expect(qrStyleFits(33 * QR_STYLE_MIN_PX, 25, 4)).toBe(true);
    expect(qrStyleFits(33 * QR_STYLE_MIN_PX - 1, 25, 4)).toBe(false);
  });
});

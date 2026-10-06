import jsQR from 'jsqr';

import type { QrMatrix } from '../src/http/qr.js';

/**
 * Reading a QR code back, for the tests that hold one to what it says (plan
 * item M5.3). `jsqr` is an independent decoder and a dev dependency only —
 * the image never carries it — and decoding is the only check that settles a
 * code: every structural one passed over a version 7 code nobody could read.
 */

/** The matrix as RGBA pixels, `scale` a module, with the quiet zone a scanner needs. */
export function qrPixels(matrix: QrMatrix, scale = 4): { data: Uint8ClampedArray; side: number } {
  const quiet = 4;
  const side = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (!(matrix.modules[row] as boolean[])[column]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = (((row + quiet) * scale + y) * side + (column + quiet) * scale + x) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
      }
    }
  }
  return { data, side };
}

/** What a matrix says, or undefined when no decoder can find a code in it. */
export function decodeMatrix(matrix: QrMatrix): string | undefined {
  const { data, side } = qrPixels(matrix);
  return jsQR(data, side, side)?.data;
}

/** What a picture of a code says: any RGBA image, as a canvas hands one back. */
export function decodePixels(data: Uint8ClampedArray, width: number, height: number): string | undefined {
  return jsQR(data, width, height)?.data;
}

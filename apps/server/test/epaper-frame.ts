import type { Framebuffer } from '../src/epaper/framebuffer.js';

/** Each byte's eight pixels as the characters the tests read, most significant first. */
const BYTE_BITS: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(2).padStart(8, '0'));

/**
 * A frame as one character per pixel, row by row: '1' where there is ink and
 * '0' where there is none — and identical, character for character, to
 * reading `fb.get(x, y)` over a `width` x `height` window from the top left,
 * off-canvas reading as no ink.
 *
 * Identical rather than merely equivalent, because the e-paper tests do more
 * with this string than compare it: they index into it by `y * width + x`,
 * look for a '1' in a row, and hash it against values pinned on a clean
 * `main` (`epaper-house-tiles`, `epaper-countdown-looks`). Built the old way —
 * a character appended per `get` — it was most of what those files spent:
 * `epaper-ink` took 15.3s that way and 0.66s without it. Here it is a table
 * lookup per byte, and a row's last byte is cut to the width, so a panel whose
 * width is not a multiple of eight cannot show its padding bits.
 */
export function bitString(fb: Framebuffer, width = fb.width, height = fb.height): string {
  const rows: string[] = [];
  const drawn = Math.min(width, fb.width);
  const bytes = (drawn + 7) >> 3;
  for (let y = 0; y < height; y++) {
    if (y >= fb.height) {
      rows.push('0'.repeat(width));
      continue;
    }
    const start = y * fb.stride;
    let row = '';
    for (let b = 0; b < bytes; b++) row += BYTE_BITS[fb.bits[start + b]!]!;
    rows.push(row.slice(0, drawn) + '0'.repeat(width - drawn));
  }
  return rows.join('');
}

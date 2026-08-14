/**
 * An 8×8 bitmap font and a text blitter for e-paper frames (RFC 006).
 *
 * The display fonts (Oswald, Roboto Condensed) are drawn for a backlit screen
 * and antialiased; at 1-bit, small, on e-paper, thin condensed strokes break
 * up into gravel. A bitmap font is drawn *for* this medium — every pixel is on
 * or off by design — so it stays crisp, and integer scaling keeps it crisp at
 * larger sizes too (blocky, but never blurred or half-lit). That is why the
 * eInk theme uses this rather than the brand type.
 *
 * The glyphs are the public-domain `font8x8` set (Daniel Hepper, from the IBM
 * PC OEM VGA fonts — public domain), covering ASCII 0x20–0x7E. Embedded as a
 * hex string rather than fetched, because rule three means the image carries
 * everything it draws. Symbols the font does not have (bullets, blocks) are
 * drawn as primitives by the rasterizer, not faked here.
 *
 * Row byte convention: the least significant bit is the *leftmost* column, so
 * a glyph column `c` in row `r` is `(row >> c) & 1`. Verified against the
 * canonical 'A' = 0C 1E 33 33 3F 33 33 00.
 */
import type { Framebuffer } from './framebuffer.js';

const FONT_HEX =
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '000000000000000000000000000000000000000000000000183c3c1818001800363600000000000036367f367f363600' +
  '0c3e031e301f0c00006333180c6663001c361c6e3b336e000606030000000000180c0606060c1800060c1818180c0600' +
  '00663cff3c660000000c0c3f0c0c000000000000000c0c060000003f0000000000000000000c0c006030180c06030100' +
  '3e63737b6f673e000c0e0c0c0c0c3f001e33301c06333f001e33301c30331e00383c36337f3078003f031f3030331e00' +
  '1c06031f33331e003f3330180c0c0c001e33331e33331e001e33333e30180e00000c0c00000c0c00000c0c00000c0c06' +
  '180c0603060c180000003f00003f0000060c1830180c06001e3330180c000c003e637b7b7b031e000c1e33333f333300' +
  '3f66663e66663f003c66030303663c001f36666666361f007f46161e16467f007f46161e16060f003c66030373667c00' +
  '3333333f333333001e0c0c0c0c0c1e007830303033331e006766361e366667000f06060646667f0063777f7f6b636300' +
  '63676f7b736363001c36636363361c003f66663e06060f001e3333333b1e38003f66663e366667001e33070e38331e00' +
  '3f2d0c0c0c0c1e003333333333333f0033333333331e0c006363636b7f7763006363361c1c3663003333331e0c0c1e00' +
  '7f6331184c667f001e06060606061e0003060c18306040001e18181818181e00081c36630000000000000000000000ff' +
  '0c0c18000000000000001e303e336e000706063e66663b0000001e3303331e003830303e33336e0000001e333f031e00' +
  '1c36060f06060f0000006e33333e301f0706366e666667000c000e0c0c0c1e00300030303033331e070666361e366700' +
  '0e0c0c0c0c0c1e000000337f7f6b630000001f333333330000001e3333331e0000003b66663e060f00006e33333e3078' +
  '00003b6e66060f0000003e031e301f00080c3e0c0c2c18000000333333336e0000003333331e0c000000636b7f7f3600' +
  '000063361c36630000003333333e301f00003f190c263f00380c0c070c0c38001818180018181800070c0c380c0c0700' +
  '6e3b0000000000000000000000000000';

/** 128 glyphs × 8 rows, decoded once. */
const GLYPHS = (() => {
  const bytes = new Uint8Array(FONT_HEX.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(FONT_HEX.substr(i * 2, 2), 16);
  return bytes;
})();

export const GLYPH_SIZE = 8;

export interface TextOptions {
  /** Integer pixel multiplier. 1 = 8px tall, 2 = 16px, and so on. */
  scale?: number;
  /** Pixels between glyph cells, before scaling. Default 1. */
  tracking?: number;
  /** Draw ink (dark) glyphs; false clears, for knocking text out of a fill. */
  ink?: boolean;
}

/** Advance per glyph in final pixels, including tracking. */
function advance(scale: number, tracking: number): number {
  return (GLYPH_SIZE + tracking) * scale;
}

/** Width in pixels a string will occupy. */
export function measureText(text: string, options: TextOptions = {}): number {
  const scale = Math.max(1, Math.floor(options.scale ?? 1));
  const tracking = options.tracking ?? 1;
  if (text.length === 0) return 0;
  // The last glyph does not need trailing tracking.
  return text.length * advance(scale, tracking) - tracking * scale;
}

/**
 * Blit a string at (x, y) as its top-left corner. Returns the x past the last
 * glyph, so callers can chain. Characters outside 0x20–0x7E draw as blank
 * cells rather than tofu — the rasterizer supplies real symbols itself.
 */
export function drawText(fb: Framebuffer, x: number, y: number, text: string, options: TextOptions = {}): number {
  const scale = Math.max(1, Math.floor(options.scale ?? 1));
  const tracking = options.tracking ?? 1;
  const ink = options.ink ?? true;
  let cursor = x;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x20;
    if (code >= 0x20 && code <= 0x7e) {
      const base = code * GLYPH_SIZE;
      for (let row = 0; row < GLYPH_SIZE; row++) {
        const bits = GLYPHS[base + row]!;
        for (let col = 0; col < GLYPH_SIZE; col++) {
          if ((bits >> col) & 1) {
            if (scale === 1) fb.set(cursor + col, y + row, ink);
            else fb.fillRect(cursor + col * scale, y + row * scale, scale, scale, ink);
          }
        }
      }
    }
    cursor += advance(scale, tracking);
  }
  return cursor - tracking * scale;
}

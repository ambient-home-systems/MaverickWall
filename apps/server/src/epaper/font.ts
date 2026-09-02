/**
 * Three bitmap faces and a text blitter for e-paper frames (RFC 006).
 *
 * The display fonts (Oswald, Roboto Condensed) are drawn for a backlit screen
 * and antialiased; at 1-bit, small, on e-paper, thin condensed strokes break
 * up into gravel. A bitmap face is drawn *for* this medium — every pixel is on
 * or off by design — so it stays crisp, and integer scaling keeps it crisp at
 * larger sizes too (blocky, but never blurred or half-lit). That is why the
 * eInk theme uses these rather than the brand type.
 *
 * ## Three faces, not one face at three sizes
 *
 * This shipped as **one** 8x8 face at integer scales, so a bigger panel got
 * bigger type by multiplying a square: 8, 16, 24, 32 pixels and nothing
 * between. Two faults follow and both were measured before this was written.
 * The rungs are eight pixels apart, so `smallScale` — the role that carries a
 * month cell's event names, a widget's title and every "+N" — is `round(body /
 * 2)`, which is **2 on a 10.3" panel and 2 on a 13.3" one**: 16px at 6.24
 * px/mm read at 700mm is 12.6 arc-minutes and 16px at 6.93 px/mm read at 800mm
 * is **9.9**, so the larger, further panel draws it smaller. And a doubled 8x8
 * is a photographic enlargement: at 16px it needs 18px of advance where a face
 * drawn on a 12x16 grid needs 13, so it says a third less in the same column
 * and says it in a square letterform.
 *
 * **This is the brand mark's argument.** `lit-cell-small.svg` is a five-column
 * *redraw* rather than the seven-column mark scaled down, because below about
 * 20px a seven-column field stops being a grid and becomes grey texture with a
 * dot in it. A glyph is the same. `font-12x16.ts` and `font-16x24.ts` are
 * drawn at the size they are used, and both keep the 8x8's stem-to-height
 * ratio (1px in 8, 2px in 16, 3px in 24) so **no panel that adopts a new rung
 * draws lighter type than it draws today** — what they buy is the width.
 *
 * The 8x8 face is unchanged, byte for byte. It is somebody else's shipped,
 * verified public-domain data (`font8x8`, Daniel Hepper, from the IBM PC OEM
 * VGA fonts) and retyping it as art would be a transcription with a chance of
 * being wrong and nothing to gain.
 *
 * ## Rungs, and why the ladder is monotone in both directions
 *
 * `TYPE_RUNGS` is every (face, scale) pair a panel may draw, ordered. It is
 * monotone in **height and advance together**, which is not decoration: a
 * caller that steps down the ladder until a string fits has to know that a
 * shorter rung is also a narrower one. Left unsorted the ladder contains
 * `f8@5` (40px tall, 45px of advance) sitting between `f16@2` (48/34) and
 * `f16@1` (24/17), where stepping *down* would make the text wider. Every rung
 * that is not the narrowest at its height is left out for that reason.
 *
 * ## The grade
 *
 * Reversed type is the panel's dark theme. On e-paper the black bleeds into the
 * white, so a white stroke knocked out of a filled ground closes up — the
 * header band, today's cell and a span bar's label are the only places this
 * renderer draws light-on-dark, and they are exactly where a 1px stroke is
 * eaten. The correction is the browser wall's: a **grade**, which thickens a
 * stroke without moving an advance (`--f-grade` in `display.css`, and the
 * reason that token exists at all). On a bitmap that is a one-pixel horizontal
 * dilation of each row — `row | (row << 1)` — which is the next weight at the
 * **same cell width**, so no metric moves. A metric change is a reflow, and
 * reflow is what forecloses partial refresh.
 *
 * It follows the ground rather than a flag, so no call site can forget it: an
 * `ink: false` run is graded unless it says otherwise.
 *
 * **The 8x8 face is not graded, and that is measured rather than assumed.** It
 * has 1px stems and 1px counters: swept over all 95 glyphs, a one-pixel grade
 * closes a counter in three of them and two more already carry ink in the last
 * column, where the dilation would leave the cell. The two drawn faces are
 * clean on both counts and `font-faces.test.ts` is what keeps them so.
 *
 * ## Row byte convention
 *
 * The least significant bit is the *leftmost* column, so a glyph column `c` in
 * row `r` is `(row >> c) & 1`. Verified against the canonical 8x8 'A' =
 * 0C 1E 33 33 3F 33 33 00, and against the drawn faces' own art, which is
 * checked character by character rather than as a hash.
 */
import type { Framebuffer } from './framebuffer.js';
import { FACE_12X16, FACE_12X16_HEIGHT, FACE_12X16_WIDTH } from './font-12x16.js';
import { FACE_16X24, FACE_16X24_HEIGHT, FACE_16X24_WIDTH } from './font-16x24.js';

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

/** The first and last code points every face covers. */
const FIRST_CODE = 0x20;
const LAST_CODE = 0x7e;

/** The faces this build ships, smallest first. Stable: read by two renderers. */
export const FACE_KEYS = ['f8', 'f12', 'f16'] as const;
export type FaceKey = (typeof FACE_KEYS)[number];

export interface BitmapFace {
  readonly key: FaceKey;
  /** The cell, in pixels at scale 1. An advance is this plus the tracking. */
  readonly width: number;
  readonly height: number;
  /** Whether a one-pixel grade is safe on this face — see the header. */
  readonly graded: boolean;
  /** One entry per glyph row, bit `c` set for an inked column `c`. */
  readonly rows: Uint16Array;
}

/** The 8x8 hex, decoded once. */
function decodeHex(hex: string, height: number): Uint16Array {
  const rows = new Uint16Array((LAST_CODE - FIRST_CODE + 1) * height);
  for (let code = FIRST_CODE; code <= LAST_CODE; code++) {
    for (let r = 0; r < height; r++) {
      rows[(code - FIRST_CODE) * height + r] = parseInt(hex.substr((code * height + r) * 2, 2), 16);
    }
  }
  return rows;
}

/**
 * The drawn faces' art, packed.
 *
 * `#` is ink and the least significant bit is the leftmost column, so the
 * packed form reads back exactly as the art was written. A glyph the art does
 * not carry is a build error rather than a blank: a face with a hole in it
 * draws a hole in a household's event title.
 */
function packArt(art: Readonly<Record<string, readonly string[]>>, width: number, height: number): Uint16Array {
  const rows = new Uint16Array((LAST_CODE - FIRST_CODE + 1) * height);
  for (let code = FIRST_CODE; code <= LAST_CODE; code++) {
    const glyph = art[String.fromCodePoint(code)];
    if (glyph === undefined || glyph.length !== height) {
      throw new Error(`bitmap face: no ${height}-row glyph for U+${code.toString(16)}`);
    }
    for (let r = 0; r < height; r++) {
      const line = glyph[r] as string;
      if (line.length !== width) throw new Error(`bitmap face: row "${line}" is not ${width} wide`);
      let bits = 0;
      for (let c = 0; c < width; c++) if (line[c] === '#') bits |= 1 << c;
      rows[(code - FIRST_CODE) * height + r] = bits;
    }
  }
  return rows;
}

export const FACES: Readonly<Record<FaceKey, BitmapFace>> = {
  f8: { key: 'f8', width: 8, height: 8, graded: false, rows: decodeHex(FONT_HEX, 8) },
  f12: {
    key: 'f12',
    width: FACE_12X16_WIDTH,
    height: FACE_12X16_HEIGHT,
    graded: true,
    rows: packArt(FACE_12X16, FACE_12X16_WIDTH, FACE_12X16_HEIGHT),
  },
  f16: {
    key: 'f16',
    width: FACE_16X24_WIDTH,
    height: FACE_16X24_HEIGHT,
    graded: true,
    rows: packArt(FACE_16X24, FACE_16X24_WIDTH, FACE_16X24_HEIGHT),
  },
};

/** The tracking every rung's own advance is stated at. */
export const DEFAULT_TRACKING = 1;

/** One position on the type ladder: a face and a whole-number multiplier. */
export interface TypeRung {
  /** Its own place in `TYPE_RUNGS`, so a caller can step without searching. */
  readonly index: number;
  readonly face: FaceKey;
  readonly scale: number;
  /** The drawn cell, in pixels. */
  readonly height: number;
  /** Cell plus one pixel of tracking — what one character costs on a line. */
  readonly advance: number;
}

function rung(index: number, face: FaceKey, scale: number): TypeRung {
  const f = FACES[face];
  return { index, face, scale, height: f.height * scale, advance: (f.width + DEFAULT_TRACKING) * scale };
}

/**
 * The ladder. Height and advance both increase, strictly, all the way up.
 *
 *     rung  face    height  advance     replaces (8x8 only)
 *     0     f8@1        8        9      8 / 9
 *     1     f12@1      16       13      16 / 18
 *     2     f16@1      24       17      24 / 27
 *     3     f12@2      32       26      32 / 36
 *     4     f16@2      48       34      48 / 54
 *     5     f16@3      72       51      72 / 81
 *     6     f16@4      96       68
 *     7     f16@5     120       85
 *     8     f16@6     144      102
 *     9     f16@8     192      136
 *
 * Every height a panel in the supported range asks for is on it, and every one
 * of them is narrower than the 8x8 could reach it at. The gap between 48 and 72
 * is deliberate: `f8@7` and `f12@4` both land inside it and both are wider than
 * the 72 above them, so putting either in would break the one property a
 * step-down search depends on.
 */
export const TYPE_RUNGS: readonly TypeRung[] = [
  rung(0, 'f8', 1),
  rung(1, 'f12', 1),
  rung(2, 'f16', 1),
  rung(3, 'f12', 2),
  rung(4, 'f16', 2),
  rung(5, 'f16', 3),
  rung(6, 'f16', 4),
  rung(7, 'f16', 5),
  rung(8, 'f16', 6),
  rung(9, 'f16', 8),
];

/** The rung at `index`, clamped to the ladder rather than thrown. */
export function rungAt(index: number): TypeRung {
  const clamped = Math.min(TYPE_RUNGS.length - 1, Math.max(0, Math.round(index)));
  return TYPE_RUNGS[clamped] as TypeRung;
}

/** The rung `steps` along from this one, clamped. Negative steps go down. */
export function rungStep(from: TypeRung, steps: number): TypeRung {
  return rungAt(from.index + steps);
}

/**
 * The rung whose drawn height is nearest `px`.
 *
 * Nearest rather than floor: the widget caps this replaces were multiples of
 * the body scale (a clock at 4x, a countdown at 4.5x) and flooring every one of
 * them onto a ladder with a gap in it would shrink a headline by a quarter for
 * the sake of a rounding rule nobody asked for.
 */
export function nearestRung(px: number): TypeRung {
  let best = TYPE_RUNGS[0] as TypeRung;
  for (const candidate of TYPE_RUNGS) {
    if (Math.abs(candidate.height - px) < Math.abs(best.height - px)) best = candidate;
  }
  return best;
}

/**
 * The tallest rung whose drawn height fits `px`, never below the floor.
 *
 * The height-bounded twin of `nearestRung`: a headline sized from its box has
 * to *fit* it, so this floors where that rounds. Rung 0 is the answer for a box
 * too short for anything, because a widget that draws nothing is an empty
 * rectangle with a heading on it (rule nine).
 */
export function rungAtMost(px: number): TypeRung {
  let best = TYPE_RUNGS[0] as TypeRung;
  for (const candidate of TYPE_RUNGS) {
    if (candidate.height <= px) best = candidate;
  }
  return best;
}

/** The shorter of two rungs, and the taller. Named, because `Math.min` cannot. */
export function shorterRung(a: TypeRung, b: TypeRung): TypeRung {
  return a.index <= b.index ? a : b;
}

export function tallerRung(a: TypeRung, b: TypeRung): TypeRung {
  return a.index >= b.index ? a : b;
}

export interface TextOptions {
  /** Which face at which multiplier. */
  readonly rung: TypeRung;
  /** Pixels between glyph cells, before scaling. Default 1. */
  readonly tracking?: number;
  /** Draw ink (dark) glyphs; false clears, for knocking text out of a fill. */
  readonly ink?: boolean;
  /**
   * Thicken the stroke by a pixel without moving the advance.
   *
   * Absent means *follow the ground*: reversed text is graded and ordinary text
   * is not, so no call site has to remember. See the header for why, and for
   * why the 8x8 face ignores it.
   */
  readonly grade?: boolean;
}

/** Advance per glyph in final pixels, including tracking. */
function advanceOf(options: TextOptions): number {
  const tracking = options.tracking ?? DEFAULT_TRACKING;
  return (FACES[options.rung.face].width + tracking) * options.rung.scale;
}

/** Width in pixels a string will occupy. */
export function measureText(text: string, options: TextOptions): number {
  const tracking = options.tracking ?? DEFAULT_TRACKING;
  if (text.length === 0) return 0;
  // The last glyph does not need trailing tracking.
  return text.length * advanceOf(options) - tracking * options.rung.scale;
}

/** Whether this run is drawn at the next weight up. */
function gradedRun(options: TextOptions): boolean {
  if (!FACES[options.rung.face].graded) return false;
  return options.grade ?? options.ink === false;
}

/**
 * Blit a string at (x, y) as its top-left corner. Returns the x past the last
 * glyph, so callers can chain. Characters outside 0x20-0x7E draw as blank
 * cells rather than tofu — the rasterizer supplies real symbols itself.
 */
export function drawText(fb: Framebuffer, x: number, y: number, text: string, options: TextOptions): number {
  const face = FACES[options.rung.face];
  const scale = options.rung.scale;
  const tracking = options.tracking ?? DEFAULT_TRACKING;
  const ink = options.ink ?? true;
  const grade = gradedRun(options);
  const step = advanceOf(options);
  let cursor = x;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x20;
    if (code >= FIRST_CODE && code <= LAST_CODE) {
      const base = (code - FIRST_CODE) * face.height;
      for (let row = 0; row < face.height; row++) {
        const raw = face.rows[base + row] as number;
        const bits = grade ? raw | (raw << 1) : raw;
        for (let col = 0; col < face.width; col++) {
          if ((bits >> col) & 1) {
            if (scale === 1) fb.set(cursor + col, y + row, ink);
            else fb.fillRect(cursor + col * scale, y + row * scale, scale, scale, ink);
          }
        }
      }
    }
    cursor += step;
  }
  return cursor - tracking * scale;
}

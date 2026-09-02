/**
 * The same glyphs, redrawn for one bit (RFC 006).
 *
 * The panel has drawn no icon at all since it was written: the modules chose an
 * emoji, `asciiTitle` drops every code point above 0x7E, and so the forecast
 * strip on an e-paper wall has been a column of temperatures with a hole where
 * the weather goes. With a first-party vocabulary it can draw one.
 *
 * ## Why these are redrawn rather than rasterised
 *
 * `apps/display/src/glyphs.ts` holds the same twenty-nine silhouettes as paths
 * on a 24 grid, and the obvious thing is to fill those paths at 12x12 and keep
 * the answer. It was tried first, and it is the brand mark's lesson exactly:
 * `lit-cell-small.svg` is a five-column *redraw* because below about 20px a
 * seven-column field stops being a grid and becomes grey texture with a dot in
 * it. Measured here, filling the paths at 12x12 with a coverage threshold gives
 * a sun with no rays at all, and `rain` and `drizzle` byte-identical — the
 * feature that separates them is 1.8 grid units wide, which is 0.9 of a pixel.
 *
 * So these are drawn at the size they are used, the way `font.ts`'s alphabet
 * is. What is shared is the **vocabulary and the silhouette** — a person for
 * `person`, that person inside a frame for `occupancy`, a drop for `humidity`
 * and that drop over a puddle for `moisture` — never the coordinates.
 *
 * ## The cell, and why it scales by whole numbers only
 *
 * One cell is 12x12 and a panel draws it at 1x, 2x or 3x. A 1-bit raster has no
 * half-lit pixel, so a fractional scale is a grey smear that survives until the
 * next full refresh — the rule `epaper/metrics.ts` already states for a row
 * boundary and `font.ts` for a character. Three sizes, chosen from the panel's
 * own type ladder, and nothing between them.
 */
import type { Framebuffer } from './framebuffer.js';
import { GLYPH_KEYS, isGlyphKey, type GlyphKey } from '../glyphs.js';

export { GLYPH_KEYS, isGlyphKey };
export type { GlyphKey };

/** One cell, square, in pixels at 1x. Twelve is the 24 grid at one half. */
export const GLYPH_CELL = 12;

/** The scales a panel may draw a glyph at. Whole numbers, smallest first. */
export const GLYPH_SCALES = [1, 2, 3] as const;
export type GlyphScale = (typeof GLYPH_SCALES)[number];

/**
 * The cells. Twelve rows of twelve, `#` is ink.
 *
 * Written as text rather than as hex because this is the only form a person can
 * review, and a glyph nobody has looked at is the fault this whole change is
 * about. `glyph-bitmaps.test.ts` holds every one of them to being 12 by 12 and
 * to having ink in it.
 */
const CELLS: Readonly<Record<GlyphKey, readonly string[]>> = {
  clear: [
    '.....##.....',
    '.....##.....',
    '..#......#..',
    '.....##.....',
    '....####....',
    '##.######.##',
    '##.######.##',
    '....####....',
    '.....##.....',
    '..#......#..',
    '.....##.....',
    '.....##.....',
  ],
  'mostly-clear': [
    '....#.......',
    '.#..........',
    '...###......',
    '..#####.....',
    '#.#####.....',
    '..#####.....',
    '...###......',
    '.......###..',
    '.....#######',
    '.....#######',
    '............',
    '............',
  ],
  'partly-cloudy': [
    '...#........',
    '..###.......',
    '#.###.......',
    '..###.......',
    '............',
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '............',
  ],
  cloudy: [
    '............',
    '............',
    '............',
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '............',
    '............',
    '............',
  ],
  fog: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '..########..',
    '............',
    '.########...',
    '............',
    '...#######..',
    '............',
  ],
  drizzle: [
    '............',
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '..#..#..#...',
    '..#..#..#...',
    '............',
    '............',
    '............',
  ],
  rain: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '..#..#..#...',
    '..#..#..#...',
    '..#..#..#...',
    '..#..#..#...',
    '..#..#..#...',
    '............',
  ],
  showers: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '...#..#..#..',
    '...#..#..#..',
    '..#..#..#...',
    '..#..#..#...',
    '.#..#..#....',
    '............',
  ],
  snow: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '............',
    '..#...#...#.',
    '.###.###.###',
    '..#...#...#.',
    '............',
    '............',
  ],
  sleet: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '..#.......#.',
    '..#...#...#.',
    '..#..###..#.',
    '..#...#...#.',
    '..#.......#.',
    '............',
  ],
  thunderstorm: [
    '....####....',
    '..#######...',
    '.#########..',
    '.##########.',
    '.##########.',
    '............',
    '......##....',
    '.....##.....',
    '....####....',
    '......##....',
    '.....##.....',
    '....#.......',
  ],
  wind: [
    '............',
    '............',
    '.########...',
    '........#...',
    '............',
    '.##########.',
    '............',
    '............',
    '.#####......',
    '.....#......',
    '............',
    '............',
  ],
  temperature: [
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '....####....',
    '...######...',
    '...######...',
    '....####....',
    '............',
  ],
  humidity: [
    '.....##.....',
    '.....##.....',
    '....####....',
    '....####....',
    '...######...',
    '..########..',
    '.##########.',
    '.##########.',
    '.##########.',
    '..########..',
    '...######...',
    '............',
  ],
  pressure: [
    '....####....',
    '..##....##..',
    '.##......##.',
    '##.....#..##',
    '##....#...##',
    '##...##...##',
    '##...##...##',
    '##........##',
    '.##......##.',
    '..##....##..',
    '....####....',
    '............',
  ],
  battery: [
    '............',
    '............',
    '............',
    '.#########..',
    '.#.......#..',
    '.#.###...#.#',
    '.#.###...#.#',
    '.#.......#..',
    '.#########..',
    '............',
    '............',
    '............',
  ],
  power: [
    '.......##...',
    '......##....',
    '.....##.....',
    '....##......',
    '...######...',
    '......##....',
    '.....##.....',
    '....##......',
    '...##.......',
    '..##........',
    '............',
    '............',
  ],
  illuminance: [
    '....####....',
    '..########..',
    '.##########.',
    '.##########.',
    '.##########.',
    '..########..',
    '...######...',
    '....####....',
    '............',
    '....####....',
    '............',
    '.....##.....',
  ],
  door: [
    '.##########.',
    '.#........#.',
    '.#........#.',
    '.#........#.',
    '.#........#.',
    '.#......#.#.',
    '.#........#.',
    '.#........#.',
    '.#........#.',
    '.#........#.',
    '.##########.',
    '............',
  ],
  garage: [
    '.....##.....',
    '...######...',
    '.##########.',
    '.##########.',
    '.#........#.',
    '.#.######.#.',
    '.#........#.',
    '.#.######.#.',
    '.#........#.',
    '.#.######.#.',
    '.##########.',
    '............',
  ],
  window: [
    '.##########.',
    '.#...##...#.',
    '.#...##...#.',
    '.#...##...#.',
    '.#...##...#.',
    '.##########.',
    '.#...##...#.',
    '.#...##...#.',
    '.#...##...#.',
    '.#...##...#.',
    '.##########.',
    '............',
  ],
  motion: [
    '............',
    '.......##...',
    '......####..',
    '###...####..',
    '.......##...',
    '###.........',
    '......###...',
    '###..#####..',
    '....#######.',
    '....#######.',
    '....#######.',
    '............',
  ],
  occupancy: [
    '............',
    '.##########.',
    '.#........#.',
    '.#...##...#.',
    '.#..####..#.',
    '.#...##...#.',
    '.#........#.',
    '.#...##...#.',
    '.#..####..#.',
    '.#.######.#.',
    '.##########.',
    '............',
  ],
  moisture: [
    '.....##.....',
    '....####....',
    '....####....',
    '...######...',
    '..########..',
    '.##########.',
    '.##########.',
    '..########..',
    '...######...',
    '............',
    '.##########.',
    '............',
  ],
  smoke: [
    '..##....##..',
    '..##....##..',
    '.##....##...',
    '.##....##...',
    '..##....##..',
    '..##....##..',
    '...##....##.',
    '...##....##.',
    '..##....##..',
    '..##....##..',
    '.##....##...',
    '.##....##...',
  ],
  gas: [
    '.....#......',
    '.....##.....',
    '....##......',
    '....###.....',
    '...####.#...',
    '..#####.##..',
    '..#########.',
    '.##########.',
    '.##########.',
    '.##########.',
    '..########..',
    '...######...',
  ],
  problem: [
    '............',
    '.....##.....',
    '....####....',
    '....#..#....',
    '...##..##...',
    '...##..##...',
    '..###..###..',
    '..########..',
    '.####..####.',
    '.##########.',
    '.##########.',
    '............',
  ],
  lock: [
    '............',
    '....####....',
    '...##..##...',
    '...##..##...',
    '...##..##...',
    '.##########.',
    '.##########.',
    '.####..####.',
    '.####..####.',
    '.##########.',
    '.##########.',
    '............',
  ],
  person: [
    '....####....',
    '...######...',
    '...######...',
    '....####....',
    '............',
    '.....##.....',
    '...######...',
    '..########..',
    '.##########.',
    '.##########.',
    '.##########.',
    '............',
  ],
};

/** The cell for a key, or `undefined` for a key this panel cannot draw. */
export function glyphCell(key: unknown): readonly string[] | undefined {
  return isGlyphKey(key) ? CELLS[key] : undefined;
}

/**
 * Draw one glyph with its top-left at (x, y), and say whether anything was
 * drawn.
 *
 * `false` for an unknown key rather than a placeholder, and the callers all act
 * on it the same way: draw nothing and give the room back. A newer server can
 * name a glyph an older panel has never heard of, and a box with a question
 * mark in it is worse than a box with a temperature in it.
 */
export function drawGlyph(
  fb: Framebuffer,
  x: number,
  y: number,
  key: unknown,
  scale: GlyphScale,
): boolean {
  const cell = glyphCell(key);
  if (cell === undefined) return false;
  const left = Math.round(x);
  const top = Math.round(y);
  for (let row = 0; row < cell.length; row++) {
    const line = cell[row] as string;
    for (let col = 0; col < line.length; col++) {
      if (line[col] !== '#') continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          fb.set(left + col * scale + dx, top + row * scale + dy, true);
        }
      }
    }
  }
  return true;
}

/**
 * How much taller than its type a glyph is drawn.
 *
 * The wall draws `.wx-ico` at 2rem beside a 1.7rem temperature and `.hs-ico` at
 * 1.6rem beside a 1.75rem value — so on the glass a mark is roughly the size of
 * the words, a little over for the forecast and a little under for a reading.
 * The panel goes deliberately larger than both, and the reason is the reason
 * these are filled silhouettes at all: at one bit, read across a kitchen, a mark
 * the size of the type is a smudge. Rendered at parity and looked at, the 7.5"
 * panel's forecast drew four specks and a temperature.
 *
 * One factor rather than one per widget, because what it is compensating for is
 * a property of the *medium* and not of the widget — unlike `scaleRung`'s
 * per-call factors, which are facts about a clock's shape or a countdown's.
 */
const GLYPH_OVER_TYPE = 1.4;

/**
 * The scale a glyph is drawn at beside a run of type `typePx` pixels tall.
 *
 * Rounded to the nearest whole cell, because a 1-bit raster has no half-lit
 * pixel and every caller reserves the glyph's *own* height (`glyphHeight`)
 * rather than the type's — the count-and-loop rule this file's neighbours
 * already state, and the reason flooring would buy nothing here.
 *
 * The panel's type ladder is 16, 16, 24 and 32 pixels of body ink across the
 * supported range (`metrics.ts`), so this reaches 24, 24, 36 and 36: all three
 * sizes are live hardware rather than a table with a rung nothing reaches.
 */
export function glyphScaleFor(typePx: number): GlyphScale {
  const wanted = Math.round((typePx * GLYPH_OVER_TYPE) / GLYPH_CELL);
  if (wanted >= 3) return 3;
  if (wanted === 2) return 2;
  return 1;
}

/** The height one glyph occupies at a scale — the room a caller must reserve. */
export function glyphHeight(scale: GlyphScale): number {
  return GLYPH_CELL * scale;
}

/**
 * The room a leading glyph takes on a line, mark plus gutter.
 *
 * A quarter of the cell, so the gutter grows with the mark. Measured at parity
 * with the font's own `linePad` the reading read as one word — "Front door"
 * with a door welded to the F.
 */
export function glyphAdvance(scale: GlyphScale): number {
  const cell = GLYPH_CELL * scale;
  return cell + Math.max(2, Math.round(cell / 4));
}

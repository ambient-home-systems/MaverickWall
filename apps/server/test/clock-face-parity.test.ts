import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Framebuffer } from '../src/epaper/framebuffer.js';
import {
  FACE_CENTRE,
  FACE_HOUR_HAND,
  FACE_MINUTE_HAND,
  drawAnalogueFace,
  handAngles,
  handPolygon,
} from '../src/epaper/clock-face.js';

/**
 * The wall and the panel draw one analogue face, and this proves it by reading
 * both files (RFC 014 §4.2).
 *
 * A panel can follow a wall, so a clock set to `analogue` is drawn as an SVG on
 * one and rasterised on the other — and a face whose hands pointed somewhere
 * different on the two would be the bug this repository has recorded most:
 * two renderers taking one decision separately (`shifts[0]`, `display_mode`,
 * `cellEvents`, `mode`). So the geometry is written twice, for the reason
 * `glyphs.ts`, `tiers.ts` and `month-spans.ts` are — the display bundle has no
 * bundler and the server cannot import it — and the block between the
 * `clock-face:begin` and `clock-face:end` markers is **character-identical**
 * in both. Comparing the two texts is the sharpest guard there is: a hand
 * lengthened, a tick widened or an angle's sign flipped on either side turns
 * this red and names the line.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'clock-face.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'clock-face.ts');

function block(source: string, where: string): string {
  const from = source.indexOf('/*\n * clock-face:begin');
  const to = source.indexOf('/* clock-face:end */');
  if (from < 0 || to < from) throw new Error(`no clock-face block in ${where}`);
  return source.slice(from, to);
}

describe('the wall and the panel draw one face', () => {
  it('holds the two geometry blocks to the same text, character for character', () => {
    const left = block(readFileSync(WALL_PATH, 'utf8'), WALL_PATH).split('\n');
    const right = block(readFileSync(PANEL_PATH, 'utf8'), PANEL_PATH).split('\n');
    const shared = Math.min(left.length, right.length);
    for (let line = 0; line < shared; line++) {
      expect(right[line], `line ${line + 1} of the block: ${PANEL_PATH} differs from ${WALL_PATH}`).toBe(left[line]);
    }
    expect(right.length, 'the two blocks are different lengths').toBe(left.length);
  });

  it('points the hands at eleven o’clock the way a kitchen clock does', () => {
    // The harness's pinned hour, and the case the browser test reads back off
    // the wall: the minute hand straight up, the hour hand a twelfth short.
    expect(handAngles(11, 0)).toEqual({ hour: 330, minute: 0 });
    expect(handAngles(23, 0)).toEqual({ hour: 330, minute: 0 });
    // Half past three reads as half past three, not as three.
    expect(handAngles(15, 30)).toEqual({ hour: 105, minute: 180 });
    // The first point of a hand is its tip, which is what "where it points" means.
    const tip = handPolygon(90, FACE_MINUTE_HAND)[0]!;
    expect(tip.x).toBeCloseTo(FACE_CENTRE + FACE_MINUTE_HAND.length, 3);
    expect(tip.y).toBeCloseTo(FACE_CENTRE, 3);
  });

  it('rasterises the hands where the geometry says they point', () => {
    /*
     * Decoded rather than trusted: at 11:00 on a 96-pixel face the minute hand
     * is a column of ink straight up from the hub and the hour hand leans to
     * eleven, and at 15:00 both have moved — so a rasteriser that ignored the
     * angle, or turned the other way, draws the wrong pixels here.
     */
    const size = 96;
    const at = (hour: number, minute: number): Framebuffer => {
      const fb = new Framebuffer(size, size);
      drawAnalogueFace(fb, 0, 0, size, hour, minute);
      return fb;
    };
    const scale = size / 24;
    const pixel = (fb: Framebuffer, gx: number, gy: number): boolean =>
      fb.get(Math.floor(gx * scale), Math.floor(gy * scale));
    // Two thirds of the way along each hand, in grid units.
    const along = (degrees: number, length: number): [number, number] => {
      const rad = (degrees * Math.PI) / 180;
      return [FACE_CENTRE + Math.sin(rad) * length * 0.66, FACE_CENTRE - Math.cos(rad) * length * 0.66];
    };
    const eleven = at(11, 0);
    expect(pixel(eleven, ...along(0, FACE_MINUTE_HAND.length)), 'the minute hand at 11:00').toBe(true);
    expect(pixel(eleven, ...along(330, FACE_HOUR_HAND.length)), 'the hour hand at 11:00').toBe(true);
    expect(pixel(eleven, ...along(90, FACE_MINUTE_HAND.length)), 'nothing at three o’clock').toBe(false);
    const three = at(15, 0);
    expect(pixel(three, ...along(90, FACE_HOUR_HAND.length)), 'the hour hand at 15:00').toBe(true);
    expect(pixel(three, ...along(330, FACE_HOUR_HAND.length)), 'no hour hand left at eleven').toBe(false);
    // And the ring reaches the square's edge, as it reaches the SVG's.
    expect(eleven.get(size / 2, 0) || eleven.get(size / 2, 1)).toBe(true);
    expect(eleven.get(0, 0)).toBe(false);
  });
});

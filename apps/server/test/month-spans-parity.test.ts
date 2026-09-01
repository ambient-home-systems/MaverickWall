import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DENSITY_STEPS, MAX_SPAN_LANES } from '../src/epaper/month-spans.js';

/**
 * The wall and the panel decide which events are one bar the same way, and
 * this proves it by reading both files.
 *
 * A panel can *follow* a wall (`screens.layout_mode = 'follow'`), so the two
 * draw one household's arrangement on two media — and "the same month" now
 * includes which multi-day events are a bar, which cells must not repeat them
 * as rows, and how long the density mark under each numeral is. Every one of
 * those is a decision, and this repository's most repeated bug is two
 * renderers taking one decision separately: `shifts[0]`, `display_mode`,
 * `cellEvents`, `mode`. The cure each time was to resolve it once.
 *
 * So `month-spans.ts` is written twice, for the reason `ladder.ts` and
 * `calendar-view.ts` are: the display bundle has no bundler — plain `tsc`
 * output with `rootDir` pinned to its own `src` — so the server cannot import
 * it, and a test here cannot import *from* it without falling outside
 * `tsconfig.test.json`'s root and failing the typecheck `pnpm test` exists to
 * run. Everything below each file's own header comment is written to be
 * **character-identical**, so comparing the two texts is the sharpest guard
 * available: any drift on either side — a `<` become a `<=`, a lane cap
 * raised, the `allDay` half of the span test dropped — turns this red and the
 * message says which file to fix.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'month-spans.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'month-spans.ts');

/**
 * Everything after the file's own header comment.
 *
 * The headers differ on purpose — one says what the rule is, the other says it
 * is a transcription and must never become a second opinion — so the compared
 * region starts at the first thing either file *exports*.
 */
function body(source: string, where: string): string {
  const from = source.indexOf('/** The least a cell has to say');
  if (from < 0) throw new Error(`no exported body found in ${where}`);
  return source.slice(from);
}

const wall = readFileSync(WALL_PATH, 'utf8');
const panel = readFileSync(PANEL_PATH, 'utf8');

describe('the wall and the panel read one span rule', () => {
  it('holds the two files to the same text, character for character', () => {
    const left = body(wall, WALL_PATH).split('\n');
    const right = body(panel, PANEL_PATH).split('\n');
    // Line by line, so a failure names the line rather than printing 200 of
    // them and leaving somebody to diff it by eye.
    const differing = left
      .map((line, index) => ({ index, line, other: right[index] ?? '<missing>' }))
      .filter((row) => row.line !== row.other);
    expect(
      differing.slice(0, 5).map((row) => `line ${row.index + 1}\n  wall:  ${row.line}\n  panel: ${row.other}`),
      'apps/display/src/month-spans.ts is the spec; copy it into apps/server/src/epaper/month-spans.ts',
    ).toEqual([]);
    expect(left.length, 'the two files are different lengths').toBe(right.length);
  });

  it('exports the same constants on both sides', () => {
    /*
     * Read out of the wall's source rather than imported, because importing
     * the wall is exactly what this seam cannot do — and asserting the *server*
     * copy against a number typed here would prove only that this file agrees
     * with itself.
     */
    const numberIn = (name: string): number => {
      const match = new RegExp(`export const ${name} = (\\d+);`).exec(wall);
      if (match?.[1] === undefined) throw new Error(`no ${name} in ${WALL_PATH}`);
      return Number(match[1]);
    };
    expect(MAX_SPAN_LANES).toBe(numberIn('MAX_SPAN_LANES'));
    expect(DENSITY_STEPS).toBe(numberIn('DENSITY_STEPS'));
  });

  it('leaves the panel with nothing of its own to decide', () => {
    // A guard on the shape of the seam rather than on its contents: the panel
    // copy may not grow a branch the wall has not got. `epaper/render.ts` is
    // free to decide how *many* lanes fit — that is a fact about an 800x480
    // panel — but never which events are a bar.
    expect(body(panel, PANEL_PATH)).not.toMatch(/epaper|panel|framebuffer/i);
  });
});

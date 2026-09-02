import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPH_KEYS, GLYPH_PATHS, isGlyphKey } from '../src/glyphs.js';
import { GLYPH_CELL, glyphCell, glyphScaleFor } from '../src/epaper/glyphs.js';

/**
 * One vocabulary, three files — held to each other as text.
 *
 * `apps/display/src/glyphs.ts` is the wall's copy and the spec;
 * `apps/server/src/glyphs.ts` is the transcription the modules and the admin
 * read; `apps/server/src/epaper/glyphs.ts` redraws the same silhouettes for one
 * bit. The display bundle has no bundler and cannot import the server's copy,
 * and a server test cannot import *from* it — the seam
 * `epaper-ladder-parity`, `month-spans-parity`, `tier-parity` and
 * `calendar-view-parity` already sit at, and for the reason they sit at it: two
 * renderers holding one rule is this project's most repeated bug, and the cure
 * each time was to resolve it once and hand over the answer.
 *
 * The keys and the paths are compared **character for character** rather than
 * value by value, because the failure this catches is a drawing edited on one
 * side. The panel's cells are deliberately *not* compared to anything: they are
 * a redraw, which is the whole argument in `epaper/glyphs.ts` and the brand
 * mark's before it. What is asserted there is coverage — every key has a cell,
 * and no cell exists for a key nobody named.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = readFileSync(join(HERE, '..', '..', 'display', 'src', 'glyphs.ts'), 'utf8');
const SERVER = readFileSync(join(HERE, '..', 'src', 'glyphs.ts'), 'utf8');

function block(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `missing "${from}"`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start);
  expect(end, `missing "${to}" after "${from}"`).toBeGreaterThan(start);
  return source.slice(start, end + to.length);
}

describe('the glyph vocabulary is one vocabulary', () => {
  it('has the same key block on both sides, character for character', () => {
    const from = 'export const GLYPH_KEYS = [';
    expect(block(SERVER, from, '] as const;')).toBe(block(DISPLAY, from, '] as const;'));
  });

  it('has the same drawings on both sides, character for character', () => {
    const from = 'const CLOUD =';
    expect(block(SERVER, from, '\n};')).toBe(block(DISPLAY, from, '\n};'));
  });

  it('is comparing something — both blocks carry every key and the cloud', () => {
    // A block extractor that quietly matched an empty string would pass the two
    // assertions above for ever, which is the shape of assertion this file's
    // own neighbours have twice been caught being.
    const keys = block(DISPLAY, 'export const GLYPH_KEYS = [', '] as const;');
    for (const key of GLYPH_KEYS) expect(keys).toContain(`'${key}'`);
    expect(block(SERVER, 'const CLOUD =', '\n};')).toContain('thunderstorm:');
    expect(GLYPH_KEYS.length).toBe(29);
  });
});

describe('every key has a drawing in both media', () => {
  it('has a path on the wall', () => {
    for (const key of GLYPH_KEYS) {
      expect(GLYPH_PATHS[key], key).toMatch(/^M/);
      // A path with no subpath of its own is a key that quietly draws whatever
      // the entry above it draws, which reads as a working glyph.
      expect(GLYPH_PATHS[key].length, key).toBeGreaterThan(20);
    }
    expect(Object.keys(GLYPH_PATHS).sort()).toEqual([...GLYPH_KEYS].sort());
  });

  it('has a cell on the panel, square and with ink in it', () => {
    for (const key of GLYPH_KEYS) {
      const cell = glyphCell(key);
      expect(cell, key).toBeDefined();
      expect(cell, key).toHaveLength(GLYPH_CELL);
      for (const row of cell as readonly string[]) {
        expect(row, key).toHaveLength(GLYPH_CELL);
        expect(row, key).toMatch(/^[.#]+$/);
      }
      const ink = (cell as readonly string[]).join('').split('#').length - 1;
      expect(ink, `${key} draws nothing`).toBeGreaterThan(8);
    }
  });

  it('draws no two skies identically', () => {
    // `rain` and `drizzle` came out byte-identical when the paths were
    // rasterised at 12x12 rather than redrawn, and that is the measurement that
    // said a redraw was needed at all. Two keys resolving to one picture is a
    // household who cannot tell what the weather is.
    const seen = new Map<string, string>();
    for (const key of GLYPH_KEYS) {
      const bits = (glyphCell(key) as readonly string[]).join('\n');
      expect(seen.get(bits), `${key} draws the same cell as ${seen.get(bits)}`).toBeUndefined();
      seen.set(bits, key);
    }
  });
});

describe('a key nobody drew', () => {
  it('is not a key', () => {
    expect(isGlyphKey('thunderstorm')).toBe(true);
    expect(isGlyphKey('hailstorm')).toBe(false);
    expect(isGlyphKey(undefined)).toBe(false);
    expect(isGlyphKey(7)).toBe(false);
    // The one that matters: a *newer server* naming a glyph an older bundle has
    // never heard of. Drawing nothing is the answer; drawing the word is not.
    expect(glyphCell('hailstorm')).toBeUndefined();
  });
});

describe('the panel picks a whole-number scale', () => {
  it('reaches all three across the panel type ladder', () => {
    // The ladder is 16, 16, 24 and 32 pixels of body ink across the supported
    // range (`metrics.ts`), so every rung is live hardware rather than a table
    // with a size nothing reaches. A mark is drawn larger than its type here
    // (`GLYPH_OVER_TYPE`) and the panel renders say why: at parity a 7.5" panel
    // drew four specks and a temperature.
    expect(glyphScaleFor(16)).toBe(2);
    expect(glyphScaleFor(24)).toBe(3);
    expect(glyphScaleFor(32)).toBe(3);
    // And nothing outside them, however small or large the caller's type. The
    // top of the range is where the cap binds: a 13.3" panel would take a
    // fourth cell if there were one, and draws its mark at 1.13x its type
    // instead of 1.4x. Stated rather than hidden — it is the one place the
    // three sizes do not reach.
    expect(glyphScaleFor(1)).toBe(1);
    expect(glyphScaleFor(8)).toBe(1);
    expect(glyphScaleFor(400)).toBe(3);
  });
});

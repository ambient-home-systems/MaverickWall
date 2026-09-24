import { describe, expect, it } from 'vitest';

import { GLYPH_KEYS, GLYPH_PARTS, GLYPH_PATHS, glyphParts, subpaths, type GlyphKey } from '../src/glyphs.js';

/**
 * The two-tone skies (plan item P5.1): a part is a run of the drawing's own
 * subpaths, and the runs have to be exactly the drawing — every subpath in
 * one run, in order, none left over. A drawing edited in `GLYPH_PATHS` without
 * its runs being re-counted is the fault this catches: the colour style would
 * otherwise paint a cloud's last disc the colour of the rain under it.
 */
const SKIES = GLYPH_KEYS.slice(0, GLYPH_KEYS.indexOf('temperature')) as readonly GlyphKey[];

describe('the parts of a sky', () => {
  it('names every sky and no device class', () => {
    expect(Object.keys(GLYPH_PARTS).sort()).toEqual([...SKIES].sort());
    expect(SKIES).toHaveLength(12);
  });

  it('covers each drawing exactly, subpath for subpath', () => {
    for (const key of SKIES) {
      const runs = GLYPH_PARTS[key] ?? [];
      const total = runs.reduce((sum, [, count]) => sum + count, 0);
      expect(total, key).toBe(subpaths(GLYPH_PATHS[key]).length);
      const parts = glyphParts(key);
      expect(parts, key).toBeDefined();
      // The pieces, joined, are the drawing: nothing moved, nothing lost.
      expect(parts!.map(([, d]) => d).join(''), key).toBe(GLYPH_PATHS[key]);
    }
  });

  it('draws the sun behind the cloud, and lights the bolt', () => {
    expect(glyphParts('partly-cloudy')!.map(([part]) => part)).toEqual(['sun', 'cloud']);
    expect(glyphParts('mostly-clear')!.map(([part]) => part)).toEqual(['sun', 'cloud']);
    expect(glyphParts('thunderstorm')!.map(([part]) => part)).toEqual(['storm', 'bolt']);
    expect(glyphParts('sleet')!.map(([part]) => part)).toEqual(['cloud', 'rain', 'snow', 'rain']);
  });

  it('gives a device class no parts, so it is drawn in one ink', () => {
    expect(glyphParts('lock')).toBeUndefined();
    expect(glyphParts('temperature')).toBeUndefined();
  });

  it('starts every subpath of every sky with a move, which is what the cut relies on', () => {
    for (const key of SKIES) {
      for (const piece of subpaths(GLYPH_PATHS[key])) expect(piece.startsWith('M'), key).toBe(true);
    }
  });
});

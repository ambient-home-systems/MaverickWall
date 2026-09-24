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

  it('names each subpath for the object it draws: a sun above its cloud, the weather under it', () => {
    /*
     * Coverage alone cannot see a subpath given to the wrong part — three
     * cloud discs and four raindrops cover the same seven subpaths as four and
     * three, and the rain would paint a cloud's last disc blue. So each part
     * is placed where its object is drawn: every subpath of a cloud is the
     * shared cloud's own (the family every overcast sky is built on), a sun's
     * subpaths all start above the cloud's, and what falls — rain, snow, fog,
     * a bolt — starts below the cloud's top.
     */
    const cloud = subpaths(GLYPH_PATHS.cloudy);
    const top = (d: string): number => Number(/^M\s*-?[\d.]+[ ,]+(-?[\d.]+)/.exec(d)?.[1]);
    for (const key of SKIES) {
      const parts = glyphParts(key)!;
      const clouds = parts.filter(([part]) => part === 'cloud' || part === 'storm').flatMap(([, d]) => subpaths(d));
      if (clouds.length === 0) continue;
      // Every overcast sky's cloud is the shared one exactly; the two skies
      // with a sun draw their own, and a cloud is discs and then its flat base.
      if (key !== 'mostly-clear' && key !== 'partly-cloudy') expect(clouds, `${key}'s cloud`).toEqual(cloud);
      clouds.forEach((piece, i) => {
        const base = i === clouds.length - 1;
        expect(/a/.test(piece), `${key}'s cloud subpath ${i} is ${base ? 'a base' : 'a disc'}`).toBe(!base);
      });
      // A sun is a disc and then its rays, which are straight.
      for (const [part, d] of parts.filter(([one]) => one === 'sun')) {
        subpaths(d).forEach((piece, i) => expect(/a/.test(piece), `${key}'s ${part} subpath ${i}`).toBe(i === 0));
      }
      const cloudTop = Math.min(...clouds.map(top));
      for (const [part, d] of parts) {
        for (const piece of subpaths(d)) {
          if (part === 'sun') expect(top(piece), `${key} ${part} ${piece.slice(0, 12)}`).toBeLessThan(cloudTop);
          if (part === 'rain' || part === 'snow' || part === 'fog' || part === 'bolt') {
            expect(top(piece), `${key} ${part} ${piece.slice(0, 12)}`).toBeGreaterThan(cloudTop + 4);
          }
        }
      }
    }
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

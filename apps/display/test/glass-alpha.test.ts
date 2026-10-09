import { describe, expect, it } from 'vitest';
import {
  GLASS_MARGIN,
  GLASS_UNMEASURED_ALPHA,
  backdropOfPixels,
  colourBackdrop,
  contrast,
  glassFill,
  parseRgb,
  readBackdrop,
  saturate,
  solveGlassAlpha,
  type Rgb,
} from '../src/glass-alpha.js';

/**
 * How much card colour Glass needs over a picture (plan item M4.2). The
 * solver is checked against the promise it makes, not against a table of
 * answers: at the opacity it returns every ink holds 4.5:1 on both patches
 * pushed apart by `GLASS_MARGIN`, and one hundredth less fails somewhere.
 */

const PANELS = { panel: '#1B212A', ink: '#E8ECF1', scaffold: '#8D97A3' };
const HOUSEHOLD = { panel: '#FFFDF8', ink: '#2B2620', scaffold: '#6E665C' };

const over = (panel: string, alpha: number, patch: string): Rgb => {
  const p = parseRgb(panel) as Rgb;
  const b = parseRgb(patch) as Rgb;
  return [0, 1, 2].map((i) => Math.round(alpha * (p[i] ?? 0) + (1 - alpha) * (b[i] ?? 0))) as unknown as Rgb;
};
const widen = (hexes: readonly string[]): string[] => {
  const shift = (h: string, by: number): string =>
    `#${(parseRgb(h) as Rgb).map((v) => Math.max(0, Math.min(255, v + by)).toString(16).padStart(2, '0')).join('')}`;
  return [shift(hexes[0] ?? '#000000', GLASS_MARGIN), shift(hexes[1] ?? '#000000', -GLASS_MARGIN)];
};
const holds = (theme: typeof PANELS, alpha: number, raw: readonly string[]): boolean =>
  widen(raw).every((patch) =>
    [theme.ink, theme.scaffold].every((ink) => contrast(parseRgb(ink) as Rgb, over(theme.panel, alpha, patch)) >= 4.5),
  );

describe('solveGlassAlpha', () => {
  it('returns the lowest opacity, in hundredths, at which both inks keep 4.5:1 on both patches pushed apart by the margin', () => {
    expect(GLASS_MARGIN).toBe(3);
    for (const [theme, backdrop] of [
      [PANELS, { light: '#7F7F7F', dark: '#101010' }],
      [PANELS, { light: '#FFFFFF', dark: '#000000' }],
      [PANELS, { light: '#4B355B', dark: '#121A35' }],
      [HOUSEHOLD, { light: '#F6F0E3', dark: '#EBE3D1' }],
      [HOUSEHOLD, { light: '#FFFFFF', dark: '#202020' }],
    ] as const) {
      const alpha = solveGlassAlpha(theme.panel, [theme.ink, theme.scaffold], backdrop);
      expect(holds(theme, alpha, [backdrop.light, backdrop.dark])).toBe(true);
      if (alpha > 0) expect(holds(theme, Math.round(alpha * 100 - 1) / 100, [backdrop.light, backdrop.dark])).toBe(false);
    }
  });

  it('needs none over the card colour itself, and all of it where nothing less will do', () => {
    // The card colour itself, with the margin's few levels either side: next to nothing.
    expect(solveGlassAlpha(PANELS.panel, [PANELS.ink, PANELS.scaffold], { light: PANELS.panel, dark: PANELS.panel })).toBeLessThanOrEqual(0.05);
    // An ink the card colour itself fails: the card opaque, which is Solid.
    expect(solveGlassAlpha('#808080', ['#808080'], { light: '#FFFFFF', dark: '#000000' })).toBe(1);
  });

  it('answers Soft’s opacity for anything it cannot read', () => {
    expect(GLASS_UNMEASURED_ALPHA).toBe(0.86);
    expect(solveGlassAlpha('var(--panel)', [PANELS.ink], { light: '#FFFFFF', dark: '#000000' })).toBe(0.86);
    expect(solveGlassAlpha(PANELS.panel, ['nope'], { light: '#FFFFFF', dark: '#000000' })).toBe(0.86);
    expect(solveGlassAlpha(PANELS.panel, [], { light: '#FFFFFF', dark: '#000000' })).toBe(0.86);
  });
});

describe('the backdrop', () => {
  it('saturates as CSS saturate() does: a grey is unchanged and a colour moves away from grey', () => {
    expect(saturate([128, 128, 128], 1.4).map(Math.round)).toEqual([128, 128, 128]);
    const red = saturate([200, 100, 100], 1.4);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[1]).toBeLessThan(100);
  });

  it('of a colour or a gradient is its colours, saturated, lightest first', () => {
    expect(colourBackdrop('#808080')).toEqual({ light: '#808080', dark: '#808080' });
    expect(colourBackdrop('#101010', '#F0F0F0')).toEqual({ light: '#F0F0F0', dark: '#101010' });
    // A colour comes back saturated, as Glass draws it, not as stored.
    const red = colourBackdrop('#C86464');
    expect(red?.light).not.toBe('#C86464');
    expect(parseRgb(red?.light ?? '')?.[0]).toBeGreaterThan(0xc8);
    expect(colourBackdrop('nope')).toBeUndefined();
  });

  it('is read only as two hex colours', () => {
    expect(readBackdrop({ light: '#FFFFFF', dark: '#000000' })).toEqual({ light: '#FFFFFF', dark: '#000000' });
    expect(readBackdrop({ light: '#FFF', dark: '#000000' })).toBeUndefined();
    expect(readBackdrop({ light: 'red', dark: '#000000' })).toBeUndefined();
    expect(readBackdrop('#FFFFFF')).toBeUndefined();
  });

  it('of a picture is its lightest and darkest block', () => {
    // 4x4 pixels, 2x2 blocks: white, black, mid-grey and a two-tone block.
    const px = (r: number, g: number, b: number): number[] => [r, g, b, 255];
    const W = [255, 255, 255];
    const K = [0, 0, 0];
    const G = [128, 128, 128];
    const rows: number[][][] = [
      [W, W, K, K],
      [W, W, K, K],
      [G, G, W, K],
      [G, G, K, W],
    ];
    const data = rows.flat().flatMap(([r, g, b]) => px(r ?? 0, g ?? 0, b ?? 0));
    expect(backdropOfPixels(data, 4, 4, 2)).toEqual({ light: '#FFFFFF', dark: '#000000' });
    expect(backdropOfPixels([], 0, 0, 2)).toBeUndefined();
  });
});

describe('glassFill', () => {
  it('is the card colour at the opacity, clamped', () => {
    expect(glassFill('#1B212A', 0.37)).toBe('rgba(27, 33, 42, 0.37)');
    expect(glassFill('#1B212A', 2)).toBe('rgba(27, 33, 42, 1)');
    expect(glassFill('#1B212A', -1)).toBe('rgba(27, 33, 42, 0)');
    expect(glassFill('nope', 0.5)).toBeUndefined();
    expect(glassFill('#1B212A', Number.NaN)).toBeUndefined();
  });
});

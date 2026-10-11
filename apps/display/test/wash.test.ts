import { describe, expect, it } from 'vitest';
import { WASH_PRESETS, washOf, washOpacities, washRatio } from '../src/wash.js';
import { currentPicture } from '../src/wallpaper.js';
import { solveGlassAlpha } from '../src/glass-alpha.js';

/**
 * A picture toned down towards the canvas's ground (plan item M4.7), as pure
 * arithmetic. `browser-picture-wash.test.ts` reads the same answers back off a
 * real wall's computed style.
 */

const FILES = { small: 'dusk-1600.1fb6019ff3.jpg', large: 'dusk-2880.2be39b376b.jpg' };

describe('washOf', () => {
  it('reads a picture’s wash and nothing else’s', () => {
    expect(washOf({ type: 'wallpaper', id: 'dusk', ...FILES, wash: 'light' })).toBe('light');
    expect(washOf({ type: 'image', image: 'a.jpg', wash: 'strong' })).toBe('strong');
    expect(washOf({ type: 'wallpaper', id: 'dusk', ...FILES })).toBeUndefined();
    expect(washOf(undefined)).toBeUndefined();
    // A colour is the household's own and flat: a stored copy carrying a wash
    // on one is not a wash.
    expect(washOf({ type: 'solid', color: '#000000', wash: 'strong' } as never)).toBeUndefined();
  });

  it('reads a value it does not know as none, not as a guess', () => {
    expect(washOf({ type: 'wallpaper', id: 'dusk', ...FILES, wash: 'heavy' } as never)).toBeUndefined();
  });
});

describe('washOpacities', () => {
  it('is the preset when nothing is solved', () => {
    expect(washOpacities('light')).toEqual(WASH_PRESETS.light);
    expect(washOpacities('strong')).toEqual(WASH_PRESETS.strong);
    expect(washOpacities('strong', Number.NaN)).toEqual(WASH_PRESETS.strong);
  });

  it('never draws a solved centre thinner than the preset', () => {
    expect(washOpacities('strong', 0.1)).toEqual(WASH_PRESETS.strong);
  });

  it('raises the centre to what the picture needs, and the edge with it', () => {
    expect(washOpacities('strong', 0.62)).toEqual({ centre: 0.62, edge: 0.8 });
    expect(washOpacities('strong', 0.9)).toEqual({ centre: 0.9, edge: 0.9 });
    expect(washOpacities('strong', 1.4)).toEqual({ centre: 1, edge: 1 });
  });

  it('is solved by the same solver as Soft, so a dark picture needs little and a bright one much', () => {
    const panel = '#1B212A';
    const inks = ['#E8E2D6', '#A3ABB5'];
    const dark = solveGlassAlpha(panel, inks, { light: '#202020', dark: '#050505' });
    const bright = solveGlassAlpha(panel, inks, { light: '#F2E2AD', dark: '#1B140A' });
    expect(washOpacities('strong', dark).centre).toBe(WASH_PRESETS.strong.centre);
    expect(washOpacities('strong', bright).centre).toBeGreaterThan(WASH_PRESETS.strong.centre);
  });
});

describe('washRatio', () => {
  it('is the centre over the edge, which the stylesheet masks the layer down by', () => {
    expect(washRatio(WASH_PRESETS.light)).toBe(0.455);
    expect(washRatio(WASH_PRESETS.strong)).toBe(0.625);
    expect(washRatio({ centre: 0.9, edge: 0.9 })).toBe(1);
    expect(washRatio({ centre: 0, edge: 0 })).toBe(0);
  });
});

describe('a rotation’s wash', () => {
  it('is every picture’s, with the patches it is solved from', () => {
    const now = Date.UTC(2026, 9, 11, 10);
    const bare = { light: '#F76B31', dark: '#15112C' };
    const shown = currentPicture(
      {
        type: 'rotation',
        every: 60,
        wash: 'strong',
        pictures: [
          { id: 'dusk', ...FILES, bare },
          { id: 'midnight', small: 'midnight-1600.087621749b.jpg', large: 'midnight-2880.0123456789.jpg', bare },
        ],
      },
      now,
      'Europe/London',
      undefined,
    );
    expect(shown?.type).toBe('wallpaper');
    expect(washOf(shown)).toBe('strong');
    expect((shown as { bare?: unknown }).bare).toEqual(bare);
  });

  it('is none when the rotation has none', () => {
    const shown = currentPicture(
      { type: 'rotation', every: 60, pictures: [{ id: 'dusk', ...FILES }, { id: 'dusk', ...FILES }] },
      0,
      'UTC',
      undefined,
    );
    expect(washOf(shown)).toBeUndefined();
  });
});

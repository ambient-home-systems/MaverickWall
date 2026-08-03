import { describe, expect, it } from 'vitest';
import {
  canvasFor,
  geometryFor,
  normaliseOrientation,
  normaliseRotation,
  resolveLayout,
} from '../src/orientation.js';

/**
 * Rotation and orientation, which are easy to conflate and mean different
 * things: one is how the panel is hung, the other is which layout to draw.
 * The relationship between them — a turned widescreen is a portrait canvas —
 * is the whole reason this is a pure function rather than a media query.
 */

const TV = { width: 1920, height: 1080 };
const TABLET = { width: 1080, height: 1920 };

describe('normalising what the database holds', () => {
  it('accepts only quarter turns', () => {
    expect(normaliseRotation(0)).toBe(0);
    expect(normaliseRotation(90)).toBe(90);
    expect(normaliseRotation(270)).toBe(270);
  });

  it('wraps a turn that has gone round, and reads a negative one the short way', () => {
    expect(normaliseRotation(360)).toBe(0);
    expect(normaliseRotation(450)).toBe(90);
    // -90 is 270. A household typing that means "the other way".
    expect(normaliseRotation(-90)).toBe(270);
  });

  it('falls back rather than throwing on nonsense', () => {
    // A hand-edited row must not be able to stop a wall drawing.
    expect(normaliseRotation('sideways')).toBe(0);
    expect(normaliseRotation(undefined)).toBe(0);
    expect(normaliseRotation(Number.NaN)).toBe(0);
    expect(normaliseOrientation('diagonal')).toBe('auto');
    expect(normaliseOrientation(undefined)).toBe('auto');
    expect(normaliseOrientation('portrait')).toBe('portrait');
  });

  it('snaps a near-miss to the turn that was meant', () => {
    expect(normaliseRotation(89)).toBe(90);
    expect(normaliseRotation(181)).toBe(180);
  });
});

describe('the canvas a quarter turn produces', () => {
  it('swaps the axes on 90 and 270, and leaves them alone otherwise', () => {
    expect(canvasFor(TV, 90)).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor(TV, 270)).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor(TV, 180)).toEqual(TV);
    expect(canvasFor(TV, 0)).toEqual(TV);
  });
});

describe('which layout to draw', () => {
  it('follows the screen when nothing is pinned', () => {
    expect(resolveLayout(TV, 0, 'auto')).toBe('landscape');
    expect(resolveLayout(TABLET, 0, 'auto')).toBe('portrait');
  });

  it('gives a rotated widescreen the portrait wall', () => {
    // The case this exists for. A television turned on its end still reports a
    // landscape viewport, and a media query would draw the wrong layout on the
    // one screen the household deliberately mounted sideways.
    expect(resolveLayout(TV, 90, 'auto')).toBe('portrait');
    expect(resolveLayout(TV, 270, 'auto')).toBe('portrait');
  });

  it('gives a rotated tablet the landscape wall', () => {
    expect(resolveLayout(TABLET, 90, 'auto')).toBe('landscape');
  });

  it('is unchanged by a half turn, which only flips the picture', () => {
    expect(resolveLayout(TV, 180, 'auto')).toBe('landscape');
    expect(resolveLayout(TABLET, 180, 'auto')).toBe('portrait');
  });

  it('obeys a pinned orientation over everything the screen reports', () => {
    // A kiosk frame can report a viewport with no relation to how the thing is
    // hung, and there is nobody on site to argue with it.
    expect(resolveLayout(TV, 0, 'portrait')).toBe('portrait');
    expect(resolveLayout(TABLET, 0, 'landscape')).toBe('landscape');
    expect(resolveLayout(TV, 90, 'landscape')).toBe('landscape');
  });

  it('treats a square canvas as portrait', () => {
    // The stacked layout degrades into a narrow column better than the
    // two-column one does.
    expect(resolveLayout({ width: 1000, height: 1000 }, 0, 'auto')).toBe('portrait');
  });
});

describe('the geometry handed to the page', () => {
  it('swaps the frame and the rem basis on a quarter turn', () => {
    // After turning, the canvas height is the viewport *width*. A rem still
    // reading from vh would size the whole design against the wrong axis on
    // exactly the screens that needed rotating.
    const turned = geometryFor(TV, 90, 'auto');
    expect(turned.frame).toEqual({ width: '100vh', height: '100vw' });
    expect(turned.rootFontSize).toBe('calc(100vw / 100)');
    expect(turned.layout).toBe('portrait');
  });

  it('leaves both alone when the screen is the right way up', () => {
    const upright = geometryFor(TABLET, 0, 'auto');
    expect(upright.frame).toEqual({ width: '100vw', height: '100vh' });
    expect(upright.rootFontSize).toBe('calc(100vh / 100)');
  });

  it('keeps the viewport basis on a half turn', () => {
    // 180 does not swap the axes, so nothing about sizing changes.
    const flipped = geometryFor(TV, 180, 'auto');
    expect(flipped.frame).toEqual({ width: '100vw', height: '100vh' });
    expect(flipped.rootFontSize).toBe('calc(100vh / 100)');
  });

  it('reports the rotation it was given, so the page can turn itself', () => {
    expect(geometryFor(TV, 270, 'auto').rotation).toBe(270);
  });
});

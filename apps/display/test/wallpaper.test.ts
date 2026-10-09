import { describe, expect, it } from 'vitest';
import {
  SMALL_WALLPAPER_EDGE,
  WALLPAPER_FILE,
  wallpaperFile,
  wallpaperPosition,
  widgetGroundFor,
  currentPicture,
} from '../src/wallpaper.js';
import { rotationIndex, rotationSteps } from '../src/picture-rotation.js';

/**
 * Which of a wallpaper's two files a canvas draws, and what its widgets draw
 * behind themselves (plan items P6.1 and P6.3).
 *
 * Pure, because a rule decided inside `renderFreeform` is one this package's
 * DOM-free tests cannot reach; `browser-wallpaper.test.ts` is where the same
 * answers are read back off a real wall's computed style.
 */

const DUSK = {
  type: 'wallpaper' as const,
  id: 'dusk',
  small: 'dusk-1600.82505dfb45.jpg',
  large: 'dusk-2880.2be39b376b.jpg',
};

describe('wallpaperFile', () => {
  it('draws the small file up to its own long edge and the large one past it', () => {
    expect(SMALL_WALLPAPER_EDGE).toBe(1600);
    expect(wallpaperFile(DUSK, { width: 900, height: 1600 }, 1)).toBe(DUSK.small);
    expect(wallpaperFile(DUSK, { width: 1601, height: 900 }, 1)).toBe(DUSK.large);
    // The longer side decides, whichever way the canvas is hung: `cover`
    // scales a square picture to it.
    expect(wallpaperFile(DUSK, { width: 1080, height: 1920 }, 1)).toBe(DUSK.large);
    expect(wallpaperFile(DUSK, { width: 1920, height: 1080 }, 1)).toBe(DUSK.large);
  });

  it('counts device pixels, so a 2x tablet takes the large file at half the CSS size', () => {
    expect(wallpaperFile(DUSK, { width: 810, height: 1080 }, 1)).toBe(DUSK.small);
    expect(wallpaperFile(DUSK, { width: 810, height: 1080 }, 2)).toBe(DUSK.large);
    // A ratio that is not one is read as 1 rather than as a reason to draw nothing.
    expect(wallpaperFile(DUSK, { width: 810, height: 1080 }, Number.NaN)).toBe(DUSK.small);
    expect(wallpaperFile(DUSK, { width: 810, height: 1080 }, 0)).toBe(DUSK.small);
  });

  it('takes the small file for a canvas with no size yet', () => {
    expect(wallpaperFile(DUSK, { width: 0, height: 0 }, 2)).toBe(DUSK.small);
  });

  it('draws nothing when either name is not a wallpaper file — the theme ground shows', () => {
    for (const bad of ['../secret.jpg', 'dusk.jpg', 'dusk-1600.png', 'https://x.example/a.jpg', 'dusk-1600.xyz.jpg', '']) {
      expect(wallpaperFile({ ...DUSK, small: bad }, { width: 400, height: 400 }, 1), bad).toBeUndefined();
      // The one not chosen is checked too: a document with one bad name is not
      // a document to half-trust.
      expect(wallpaperFile({ ...DUSK, large: bad }, { width: 400, height: 400 }, 1), bad).toBeUndefined();
    }
    expect(WALLPAPER_FILE.test(DUSK.small)).toBe(true);
    expect(WALLPAPER_FILE.test(DUSK.large)).toBe(true);
  });
});

describe('widgetGroundFor', () => {
  it('is Soft over a wallpaper and nothing anywhere else, until the household chooses', () => {
    expect(widgetGroundFor(undefined, DUSK)).toBe('soft');
    expect(widgetGroundFor(undefined, undefined)).toBe('none');
    // Every background a wall could carry before wallpapers existed draws what
    // it drew: nothing behind its widgets.
    expect(widgetGroundFor(undefined, { type: 'solid', color: '#000000' })).toBe('none');
    expect(widgetGroundFor(undefined, { type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 90 })).toBe('none');
    expect(widgetGroundFor(undefined, { type: 'image', image: 'a'.repeat(64) + '.png' })).toBe('none');
  });

  it('honours a choice whatever the background, and reads anything else as never chosen', () => {
    expect(widgetGroundFor('none', DUSK)).toBe('none');
    expect(widgetGroundFor('solid', DUSK)).toBe('solid');
    expect(widgetGroundFor('soft', undefined)).toBe('soft');
    expect(widgetGroundFor('opaque', DUSK)).toBe('soft');
    expect(widgetGroundFor(3, undefined)).toBe('none');
  });

  it('honours Glass, which only a server with the prototype on sends (plan item M4.1)', () => {
    expect(widgetGroundFor('glass', DUSK)).toBe('glass');
    expect(widgetGroundFor('glass', undefined)).toBe('glass');
  });
});

describe('wallpaperPosition', () => {
  it('is the focal point in percent, and the centre for none or for anything that is not one', () => {
    expect(wallpaperPosition({ focal: { x: 50, y: 58 } })).toBe('50% 58%');
    expect(wallpaperPosition({})).toBe('center');
    // A stored copy of the manifest may carry any shape.
    for (const bad of [null, 'centre', { x: 50 }, { x: '50', y: '58' }, { x: 120, y: 50 }, { x: -1, y: 50 }, { x: Number.NaN, y: 50 }]) {
      expect(wallpaperPosition({ focal: bad }), JSON.stringify(bad)).toBe('center');
    }
  });
});

describe('currentPicture (plan items M4.10, M1.4)', () => {
  const picture = (id: string) => ({ id, small: `${id}-1600.0123456789.jpg`, large: `${id}-2880.0123456789.jpg` });
  const rotation = {
    type: 'rotation' as const,
    collection: 'gradient',
    tone: 'dark' as const,
    every: 15,
    pictures: [picture('dusk'), picture('midnight'), picture('ember')],
  };
  const at = Date.UTC(2026, 9, 6, 10, 7, 0);

  it('turns a rotation into the wallpaper its step lands on, by the wall’s own clock', () => {
    const steps = rotationSteps(15, at, 'UTC', undefined, 0);
    expect(currentPicture(rotation, at, 'UTC', undefined)).toEqual({
      type: 'wallpaper',
      ...rotation.pictures[rotationIndex(3, steps)]!,
    });
    // A quarter of an hour later, the next one.
    expect(currentPicture(rotation, at + 15 * 60_000, 'UTC', undefined)).toEqual({
      type: 'wallpaper',
      ...rotation.pictures[rotationIndex(3, steps + 1)]!,
    });
  });

  it('counts from where Next picture moved it, and only with both halves of that', () => {
    expect(currentPicture(rotation, at, 'UTC', { picturePressedAt: at, pictureStep: 2 })).toMatchObject({ id: 'ember' });
    expect(currentPicture(rotation, at + 14 * 60_000, 'UTC', { picturePressedAt: at, pictureStep: 2 })).toMatchObject({ id: 'ember' });
    expect(currentPicture(rotation, at + 15 * 60_000, 'UTC', { picturePressedAt: at, pictureStep: 2 })).toMatchObject({ id: 'dusk' });
    // A step with nothing to count from is not a position: the epoch count stands.
    expect(currentPicture(rotation, at, 'UTC', { pictureStep: 2 })).toEqual(currentPicture(rotation, at, 'UTC', undefined));
  });

  it('draws only pictures with files it would draw, and passes every other background through', () => {
    const broken = { ...rotation, pictures: [{ id: 'x', small: 'javascript:alert(1)', large: 'nope' }] };
    expect(currentPicture(broken, at, 'UTC', undefined)).toBeUndefined();
    expect(currentPicture({ ...rotation, pictures: undefined }, at, 'UTC', undefined)).toBeUndefined();
    const solid = { type: 'solid' as const, color: '#112233' };
    expect(currentPicture(solid, at, 'UTC', undefined)).toBe(solid);
    expect(currentPicture(undefined, at, 'UTC', undefined)).toBeUndefined();
  });
});

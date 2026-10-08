import { describe, expect, it } from 'vitest';
import { FAILED_PHOTO_MS, MAX_FAILED_PHOTOS, createFailedPhotos, standIn, standInFile } from '../src/photo-fallback.js';

/** A slideshow box never goes blank (plan item M3.8): what failed, and the stand-in drawn instead. */

const SMALL = 'dusk-1600.8cdf4d0b6d.jpg';
const LARGE = 'dusk-2880.3c3cb90dbb.jpg';

describe('the failure memory', () => {
  it('remembers a photo that would not load for a few minutes, then tries it again', () => {
    const memory = createFailedPhotos();
    expect(memory.failed('/d/media/a.jpg', 1_000)).toBe(false);
    memory.mark('/d/media/a.jpg', 1_000);
    expect(memory.failed('/d/media/a.jpg', 1_000 + FAILED_PHOTO_MS - 1)).toBe(true);
    expect(memory.failed('/d/media/b.jpg', 1_000)).toBe(false);
    expect(memory.failed('/d/media/a.jpg', 1_000 + FAILED_PHOTO_MS)).toBe(false);
    // Forgotten once tried again, so an earlier clock cannot bring it back.
    expect(memory.failed('/d/media/a.jpg', 1_000)).toBe(false);
  });

  it('forgets a failure from a clock that has gone backwards, and keeps only the latest few', () => {
    const memory = createFailedPhotos();
    memory.mark('x', 10_000);
    expect(memory.failed('x', 9_000)).toBe(false);
    for (let i = 0; i <= MAX_FAILED_PHOTOS; i++) memory.mark(`p${i}`, 5_000);
    expect(memory.failed('p0', 5_000)).toBe(false);
    expect(memory.failed('p1', 5_000)).toBe(true);
    expect(memory.failed(`p${MAX_FAILED_PHOTOS}`, 5_000)).toBe(true);
    memory.mark('y', Number.NaN);
    expect(memory.failed('y', 5_000)).toBe(false);
  });
});

describe('the stand-in', () => {
  it('is read only from two wallpaper file names, with its focal point or the centre', () => {
    expect(standIn({ small: SMALL, large: LARGE })).toEqual({ small: SMALL, large: LARGE, position: 'center' });
    expect(standIn({ small: SMALL, large: LARGE, focal: { x: 50, y: 62 } })?.position).toBe('50% 62%');
    expect(standIn({ small: SMALL, large: '../secret.jpg' })).toBeUndefined();
    expect(standIn({ small: 'javascript:alert(1)', large: LARGE })).toBeUndefined();
    expect(standIn('dusk')).toBeUndefined();
    expect(standIn(undefined)).toBeUndefined();
  });

  it('takes the large file only for a screen past the small one’s edge', () => {
    const stand = { small: SMALL, large: LARGE, position: 'center' };
    expect(standInFile(stand, { width: 1280, height: 800 }, 1)).toBe(SMALL);
    expect(standInFile(stand, { width: 1280, height: 800 }, 2)).toBe(LARGE);
    expect(standInFile(stand, { width: 1920, height: 1080 }, 1)).toBe(LARGE);
    expect(standInFile(stand, { width: 1000, height: 1000 }, Number.NaN)).toBe(SMALL);
  });
});

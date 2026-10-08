import { describe, expect, it } from 'vitest';
import { displayConfig } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';

/**
 * An Image widget showing an album (plan item M5.12): what the schema takes,
 * and what leaves for the wall. The wall is measured in
 * `browser-image-slideshow.test.ts`; this is the boundary and the rewrite.
 */

const PHOTOS = ['a'.repeat(64) + '.jpg', 'b'.repeat(64) + '.png'];
const ALBUMS = [{ id: '0123456789abcdef', name: 'Holidays', photos: PHOTOS }];

describe('the manifest', () => {
  it('hands the wall the album’s photos and name, and never its id', () => {
    const out = displayConfig('image', { album: '0123456789abcdef', slideSeconds: 60, title: 'Us' }, [], ALBUMS);
    expect(out).toEqual({ slideSeconds: 60, title: 'Us', slides: PHOTOS, albumName: 'Holidays' });
  });

  it('hands over no photos and no name for an album that has gone, so the wall says so', () => {
    expect(displayConfig('image', { album: 'fedcba9876543210' }, [], ALBUMS)).toEqual({ slides: [] });
  });

  it('leaves one picture, and every other widget, exactly as stored', () => {
    const one = { image: PHOTOS[0] };
    expect(displayConfig('image', one, [], ALBUMS)).toBe(one);
    const other = { album: '0123456789abcdef' };
    expect(displayConfig('notes', other, [], ALBUMS)).toBe(other);
  });
});

describe('the schema', () => {
  it('takes an album, the four intervals and the two orders, and refuses anything else', () => {
    const ok = (config: unknown): boolean => widgetConfigBody.safeParse(config).success;
    expect(ok({ album: '0123456789abcdef', slideSeconds: 3600, slideOrder: 'shuffle' })).toBe(true);
    for (const seconds of [60, 300, 900, 3600]) expect(ok({ slideSeconds: seconds })).toBe(true);
    expect(ok({ album: '../media/x' })).toBe(false);
    expect(ok({ album: '0123456789ABCDEF' })).toBe(false);
    expect(ok({ slideSeconds: 30 })).toBe(false);
    expect(ok({ slideSeconds: '300' })).toBe(false);
    expect(ok({ slideOrder: 'random' })).toBe(false);
  });

  it('takes the three fits and refuses any other (plan item M3.5)', () => {
    const ok = (config: unknown): boolean => widgetConfigBody.safeParse(config).success;
    for (const fit of ['cover', 'contain', 'blur']) expect(ok({ fit })).toBe(true);
    expect(ok({ fit: 'stretch' })).toBe(false);
    expect(ok({ fit: '' })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { displayConfig } from '../src/api/manifest.js';
import { PHOTO_FALLBACK, photoFallback, themeTone, wallpaperById } from '../src/wallpapers.js';
import { builtinThemeTokens } from '../src/api/builtin-themes.js';

/**
 * A slideshow box never goes blank (plan item M3.8): which bundled picture
 * stands in, and what the manifest hands a wall. The wall drawing it is
 * `browser-photo-fallback.test.ts`.
 */

const PHOTOS = ['a'.repeat(64) + '.jpg', 'b'.repeat(64) + '.jpg'];
const OWN = { id: '0123456789abcdef', name: 'Us', photos: PHOTOS };
const EMPTY_OWN = { id: '1111111111111111', name: 'Garden', photos: [] };
const REMOTE = { id: '2222222222222222', name: 'Faves (Immich)', photos: PHOTOS, remote: true as const };
const EMPTY_REMOTE = { id: '3333333333333333', name: 'Memories (Immich)', photos: [], remote: true as const };
const ALBUMS = [OWN, EMPTY_OWN, REMOTE, EMPTY_REMOTE];
const STAND = photoFallback('dark');

describe('the stand-in', () => {
  it('is a quiet gradient of the wall’s own tone, from the catalogue', () => {
    expect(PHOTO_FALLBACK).toEqual({ dark: 'dusk', light: 'mist' });
    for (const tone of ['dark', 'light'] as const) {
      const picture = wallpaperById(PHOTO_FALLBACK[tone]);
      expect(picture?.tone).toBe(tone);
      expect(photoFallback(tone)).toEqual({ small: picture?.small, large: picture?.large });
    }
    // Every built-in theme lands on the picture of its own tone.
    expect(themeTone(builtinThemeTokens('panels')['--bg'] ?? '')).toBe('dark');
    expect(themeTone(builtinThemeTokens('household')['--bg'] ?? '')).toBe('light');
  });
});

describe('the manifest', () => {
  const sent = (album: string): unknown => displayConfig('image', { album }, [], ALBUMS, {}, STAND);

  it('sends every album its stand-in beside its photos', () => {
    expect(sent(OWN.id)).toEqual({ slides: PHOTOS, albumName: 'Us', fallback: STAND });
    expect(sent(REMOTE.id)).toEqual({ slides: PHOTOS, albumName: 'Faves (Immich)', fallback: STAND });
  });

  it('sends an empty source no name, so the wall draws the stand-in rather than asking for photos', () => {
    expect(sent(EMPTY_REMOTE.id)).toEqual({ slides: [], fallback: STAND });
  });

  it('still asks for photos for an empty album of the household’s own, and says a deleted one is gone', () => {
    expect(sent(EMPTY_OWN.id)).toEqual({ slides: [], albumName: 'Garden', fallback: STAND });
    expect(sent('ffffffffffffffff')).toEqual({ slides: [] });
  });

  it('sends what it sent before this existed when it has no stand-in to send', () => {
    expect(displayConfig('image', { album: EMPTY_REMOTE.id }, [], ALBUMS)).toEqual({ slides: [], albumName: 'Memories (Immich)' });
    expect(displayConfig('image', { album: OWN.id }, [], ALBUMS)).toEqual({ slides: PHOTOS, albumName: 'Us' });
    // One picture, not an album: untouched.
    const one = { image: PHOTOS[0] };
    expect(displayConfig('image', one, [], ALBUMS, {}, STAND)).toBe(one);
  });
});

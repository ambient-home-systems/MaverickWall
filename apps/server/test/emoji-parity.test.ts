import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOJI_KEYS, isEmojiKey } from '../src/emoji.js';

/**
 * One emoji vocabulary, two files — held to each other as text.
 *
 * `apps/display/src/emoji.ts` is the wall's copy and the spec;
 * `apps/server/src/emoji.ts` is the transcription the store catalogue and a
 * future module read. The display bundle has no bundler and cannot import
 * the server's copy, and a server test cannot import *from* it — the seam
 * `glyph-parity.test.ts` already sits at, for the reason it sits there: two
 * renderers holding one vocabulary is this project's most repeated bug.
 *
 * Compared **character for character** rather than value by value, because
 * the failure this catches is a key or a label edited on one side only.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DISPLAY = readFileSync(join(HERE, '..', '..', 'display', 'src', 'emoji.ts'), 'utf8');
const SERVER = readFileSync(join(HERE, '..', 'src', 'emoji.ts'), 'utf8');

function block(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `missing "${from}"`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start);
  expect(end, `missing "${to}" after "${from}"`).toBeGreaterThan(start);
  return source.slice(start, end + to.length);
}

describe('the emoji vocabulary is one vocabulary', () => {
  it('has the same key block on both sides, character for character', () => {
    const from = 'export const EMOJI_KEYS = [';
    expect(block(SERVER, from, '] as const;')).toBe(block(DISPLAY, from, '] as const;'));
  });

  it('has the same label block on both sides, character for character', () => {
    const from = 'const LABELS: Readonly<Record<EmojiKey, string>> = {';
    expect(block(SERVER, from, '\n};')).toBe(block(DISPLAY, from, '\n};'));
  });

  it('is comparing something — both blocks carry every key', () => {
    // A block extractor that quietly matched an empty string would pass the
    // two assertions above for ever, which is the shape of assertion this
    // file's own neighbours have twice been caught being.
    const keys = block(DISPLAY, 'export const EMOJI_KEYS = [', '] as const;');
    for (const key of EMOJI_KEYS) expect(keys).toContain(`'${key}'`);
    const labels = block(DISPLAY, 'const LABELS: Readonly<Record<EmojiKey, string>> = {', '\n};');
    for (const key of EMOJI_KEYS) expect(labels).toContain(`'${key}':`);
    expect(EMOJI_KEYS.length).toBeGreaterThanOrEqual(150);
  });
});

describe('every key has a label and no key is repeated', () => {
  it('has a non-empty label', () => {
    for (const key of EMOJI_KEYS) {
      // isEmojiKey is the only door to the label table, so this is also the
      // proof the table has no hole in it — a missing entry throws rather
      // than reading undefined.
      expect(isEmojiKey(key)).toBe(true);
    }
  });

  it('has no duplicate key', () => {
    expect(new Set(EMOJI_KEYS).size).toBe(EMOJI_KEYS.length);
  });

  it('is kebab-case, ASCII, and carries no code point of its own', () => {
    // The manifest carries keys, never emoji: a key that was itself an emoji
    // character would smuggle a code point back in through the one door this
    // whole vocabulary exists to close.
    for (const key of EMOJI_KEYS) expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('a key nobody curated', () => {
  it('is not a key', () => {
    expect(isEmojiKey('sun')).toBe(true);
    expect(isEmojiKey('hourglass')).toBe(true);
    expect(isEmojiKey('unicorn')).toBe(false);
    expect(isEmojiKey(undefined)).toBe(false);
    expect(isEmojiKey(7)).toBe(false);
  });
});

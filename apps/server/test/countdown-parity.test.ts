import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  TODAY_WORDS,
  celebrates,
  countdownWords,
  daysUntil,
  previousDigits,
  ticketLine,
  unitWords,
} from '../src/epaper/countdown.js';

/**
 * The wall and the panel count in one set of words, and this proves it by
 * reading both files (plan item P5.2).
 *
 * A panel can follow a wall, so one stored countdown is worded twice — once in
 * the browser, once on one bit — and a panel reading "12 days" beside a wall
 * reading "12 sleeps" would be `shifts[0]` in a countdown. The words are
 * written twice for the reason `variants.ts`, `tiers.ts` and `clock-face.ts`
 * are — the display bundle has no bundler and the server cannot import it —
 * and the block between the `countdown-words` markers is
 * **character-identical** in both.
 *
 * The block is the whole of the panel's file, and that is asserted rather than
 * assumed: `tier-parity`'s lesson is that something added on one side
 * *outside* the compared text sails straight through a comparison of the text.
 *
 * **The wall is the spec.** Where these disagree, the display file is right.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WALL_PATH = join(HERE, '..', '..', 'display', 'src', 'countdown.ts');
const PANEL_PATH = join(HERE, '..', 'src', 'epaper', 'countdown.ts');
const BEGIN = '/* countdown-words:begin */';
const END = '/* countdown-words:end */';

function block(source: string, where: string): string {
  const from = source.indexOf(BEGIN);
  const to = source.indexOf(END);
  if (from < 0 || to < from) throw new Error(`no countdown-words block in ${where}`);
  return source.slice(from, to + END.length);
}

/** Every declaration a text makes at the top level. */
function declarationsOf(text: string): string[] {
  return [...text.matchAll(/^(?:export )?(?:const|function|type|interface) (\w+)/gm)].map((m) => m[1] as string).sort();
}

describe('the wall and the panel count in one set of words', () => {
  const wall = readFileSync(WALL_PATH, 'utf8');
  const panel = readFileSync(PANEL_PATH, 'utf8');

  it('holds the two blocks to the same text, character for character', () => {
    const left = block(wall, WALL_PATH).split('\n');
    const right = block(panel, PANEL_PATH).split('\n');
    const shared = Math.min(left.length, right.length);
    for (let line = 0; line < shared; line++) {
      expect(right[line], `line ${line + 1} of the block: ${PANEL_PATH} differs from ${WALL_PATH}`).toBe(left[line]);
    }
    expect(right.length, 'the two blocks are different lengths').toBe(left.length);
  });

  it('declares nothing on the panel outside the block', () => {
    const outside = panel.replace(block(panel, PANEL_PATH), '');
    expect(declarationsOf(outside)).toEqual([]);
    // …and the block declares something, or the comparison above compares nothing.
    expect(declarationsOf(block(panel, PANEL_PATH)).length).toBeGreaterThan(8);
  });
});

describe('the words themselves', () => {
  it('counts days the way the number always has, in both directions', () => {
    expect([12, 1, -1, -3].map((days) => unitWords(days, 'days'))).toEqual(['days', 'day', 'day ago', 'days ago']);
    expect(unitWords(0, 'days')).toBe('');
  });

  it('counts sleeps forward only: a date that has passed is days ago', () => {
    expect([12, 1].map((days) => unitWords(days, 'sleeps'))).toEqual(['sleeps', 'sleep']);
    expect([-1, -3].map((days) => unitWords(days, 'sleeps'))).toEqual(['day ago', 'days ago']);
  });

  it('writes the ticket’s line, and says "Today!" on the day', () => {
    expect(ticketLine(12, 'days')).toBe('Departs in 12 days');
    expect(ticketLine(12, 'sleeps')).toBe('Departs in 12 sleeps');
    expect(ticketLine(1, 'sleeps')).toBe('Departs in 1 sleep');
    expect(ticketLine(-3, 'sleeps')).toBe('Departed 3 days ago');
    expect(ticketLine(0, 'days')).toBe(TODAY_WORDS);
    expect(TODAY_WORDS).toBe('Today!');
  });

  it('reads anything but "sleeps" as days, and anything but false as celebrating', () => {
    expect(countdownWords({})).toBe('days');
    expect(countdownWords({ unitWords: 'sleeps' })).toBe('sleeps');
    expect(countdownWords({ unitWords: 'fortnights' })).toBe('days');
    expect(countdownWords(null)).toBe('days');
    expect(celebrates({})).toBe(true);
    expect(celebrates({ celebrate: true })).toBe(true);
    expect(celebrates({ celebrate: false })).toBe(false);
    expect(celebrates({ celebrate: 'no' })).toBe(true);
  });

  it('counts whole days across a clock change, noon to noon', () => {
    // The last Sunday in October: 25 hours between the two midnights in London.
    expect(daysUntil('2026-10-24', '2026-10-26')).toBe(2);
    expect(daysUntil('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysUntil('2026-09-23', '2026-09-23')).toBe(0);
    expect(daysUntil('2026-09-23', '2026-09-20')).toBe(-3);
  });

  it('knows what the board read yesterday, right-aligned to today’s digits', () => {
    expect(previousDigits(11, 2)).toEqual(['1', '2']);
    expect(previousDigits(99, 2)).toEqual(['0', '0']); // 100 → 99: the two flaps that are there.
    expect(previousDigits(9, 1)).toEqual(['0']); // 10 → 9
    expect(previousDigits(-1, 1)).toEqual([' ']); // the day after: the board read "Today!"
    expect(previousDigits(-3, 1)).toEqual(['2']); // 2 days ago → 3 days ago
  });
});

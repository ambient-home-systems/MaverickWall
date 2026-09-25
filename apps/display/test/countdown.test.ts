import { describe, expect, it } from 'vitest';

import {
  CELEBRATION_EVERY_MS,
  CONFETTI_PIECES,
  confettiPieces,
  countdownEmoji,
  targetDateWords,
} from '../src/countdown.js';
import { NO_ONE_SHOTS, changedAt, createOneShotMemory, repeatFiredAt } from '../src/motion.js';
import { PAGE_PARTS, PAGE_TIERS, TICKET_PARTS, TICKET_TIERS, partsAt, widgetTierFor } from '../src/widget-tiers.js';

/**
 * A countdown's looks, without a DOM (plan item P5.2).
 *
 * The browser files (`browser-countdown-*`) measure what a real wall draws;
 * this asks what a page cannot: the two one-shot rules across every draw
 * rather than the few a test happens to sample, and the tables across every
 * box. The words are the panel's too and live in the server's
 * `countdown-parity.test.ts`, which reads both files.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const TICK = 15_000;

describe('a change fires once, when it happens, and never on a first draw', () => {
  it('draws nothing moving on the draw that first shows the widget', () => {
    const memory = createOneShotMemory();
    expect(changedAt(memory, 'w1', 'page', '2026-09-23', 1_000)).toBeUndefined();
    // …nor on any tick after, while the value holds.
    for (let at = 1_000 + TICK; at < 1_000 + 20 * TICK; at += TICK) {
      expect(changedAt(memory, 'w1', 'page', '2026-09-23', at)).toBeUndefined();
    }
  });

  it('fires at the first draw with the new value, and answers that moment on every draw after', () => {
    const memory = createOneShotMemory();
    const start = 1_000;
    let at = start;
    for (; at < start + 10 * TICK; at += TICK) changedAt(memory, 'w1', 'page', '2026-09-23', at);
    const midnight = at;
    expect(changedAt(memory, 'w1', 'page', '2026-09-24', midnight)).toBe(midnight);
    // A redraw part-way through the tear resumes it: same moment, not a new one.
    expect(changedAt(memory, 'w1', 'page', '2026-09-24', midnight + TICK)).toBe(midnight);
    expect(changedAt(memory, 'w1', 'page', '2026-09-24', midnight + 40 * TICK)).toBe(midnight);
  });

  it('keeps two widgets and two names apart', () => {
    const memory = createOneShotMemory();
    changedAt(memory, 'w1', 'page', 'a', 0);
    changedAt(memory, 'w2', 'page', 'a', 0);
    expect(changedAt(memory, 'w1', 'page', 'b', TICK)).toBe(TICK);
    // w2 has not changed; and the board on w1 is drawn for the first time.
    expect(changedAt(memory, 'w2', 'page', 'a', TICK)).toBeUndefined();
    expect(changedAt(memory, 'w1', 'board', 'b', TICK)).toBeUndefined();
  });

  it('draws the still frame on a surface with no memory', () => {
    expect(changedAt(NO_ONE_SHOTS, 'w1', 'page', 'a', 0)).toBeUndefined();
  });
});

describe('a celebration fires on the day, then at most once an hour', () => {
  /** Every draw of a wall left up all day on the target, at the tick. */
  function bursts(firstDraw: number, until: number, gap?: { from: number; to: number }): number[] {
    const memory = createOneShotMemory();
    const fired = new Set<number>();
    for (let at = firstDraw; at <= until; at += TICK) {
      if (gap !== undefined && at >= gap.from && at < gap.to) continue;
      const when = repeatFiredAt(memory, 'cd', 'celebrate:2026-12-25', CELEBRATION_EVERY_MS, at);
      if (when !== undefined) fired.add(when);
      memory.sweep(at);
    }
    return [...fired].sort((a, b) => a - b);
  }

  it('fires on the first draw, and not again on the next tick', () => {
    const fired = bursts(10 * HOUR, 10 * HOUR + 4 * TICK);
    expect(fired).toEqual([10 * HOUR]);
  });

  it('fires a whole day at most once an hour, and never twice inside one', () => {
    const first = 7 * HOUR + 42 * 60_000;
    const fired = bursts(first, DAY - TICK);
    // 07:42, then 08:42 … 23:42: seventeen bursts, each an hour or more after the last.
    expect(fired.length).toBe(17);
    for (let i = 1; i < fired.length; i++) {
      expect((fired[i] as number) - (fired[i - 1] as number)).toBeGreaterThanOrEqual(CELEBRATION_EVERY_MS);
      expect((fired[i] as number) - (fired[i - 1] as number)).toBeLessThan(CELEBRATION_EVERY_MS + TICK);
    }
  });

  it('is not fooled by a clock hour: first seen at 10:59:50, it does not fire again at 11:00', () => {
    const fired = bursts(11 * HOUR - 10_000, 11 * HOUR + 10 * TICK);
    expect(fired).toEqual([11 * HOUR - 10_000]);
  });

  it('counts the hour from the last burst, so a takeover cannot bring the next one early', () => {
    // Drawn at 09:00, an alert takeover from 09:50 to 10:20, then the wall again
    // until noon: 09:00, 10:20 when the wall comes back, and 11:20 — never 11:00,
    // which is an hour after nothing and forty minutes after the last burst.
    const fired = bursts(9 * HOUR, 12 * HOUR, { from: 9 * HOUR + 50 * 60_000, to: 10 * HOUR + 20 * 60_000 });
    expect(fired).toEqual([9 * HOUR, 10 * HOUR + 20 * 60_000, 11 * HOUR + 20 * 60_000]);
  });
});

describe('the confetti is laid out the same way on every draw', () => {
  it('is deterministic, capped and inside the box', () => {
    const one = confettiPieces();
    expect(one).toEqual(confettiPieces());
    expect(one.length).toBe(CONFETTI_PIECES);
    expect(CONFETTI_PIECES).toBeLessThanOrEqual(32);
    for (const piece of one) {
      expect(piece.left).toBeGreaterThanOrEqual(0);
      expect(piece.left).toBeLessThan(100);
      expect(Math.abs(piece.drift)).toBeLessThanOrEqual(4);
    }
    // Spread across the width rather than bunched: every tenth of it has a piece.
    const tenths = new Set(one.map((piece) => Math.floor(piece.left / 10)));
    expect(tenths.size).toBe(10);
  });
});

describe('a picture and a date', () => {
  it('takes a picture only from the bundled set', () => {
    expect(countdownEmoji({ emoji: 'christmas-tree' })).toBe('christmas-tree');
    expect(countdownEmoji({ emoji: '🎄' })).toBeUndefined();
    expect(countdownEmoji({ emoji: 'not-a-key' })).toBeUndefined();
    expect(countdownEmoji({})).toBeUndefined();
  });

  it('prints the target as a calendar date, never a day early west of Greenwich', () => {
    expect(targetDateWords('2026-12-25', 'en-GB')).toBe('Fri 25 Dec');
    expect(targetDateWords('not a date', 'en-GB')).toBe('');
  });
});

describe('the page and the ticket give up what their tables say', () => {
  // A label run 20px tall and 8px a character: widths in ch, heights in em.
  const CH = 8;
  const EM = 20;
  const at = (table: typeof PAGE_TIERS, ch: number, em: number) => widgetTierFor(table, ch * CH, em * EM, CH, EM);

  it('keeps the page’s count at every size, and its date only in the largest', () => {
    expect(partsAt(PAGE_PARTS, at(PAGE_TIERS, 2, 1))).toEqual(['num', 'unit']);
    expect(partsAt(PAGE_PARTS, at(PAGE_TIERS, 40, 40))).toEqual(['num', 'unit', 'label', 'date']);
    // Wide and short is held to its height.
    expect(partsAt(PAGE_PARTS, at(PAGE_TIERS, 40, 3.5))).toEqual(['num', 'unit']);
  });

  it('keeps the ticket’s destination and line at every size, and its head only in the largest', () => {
    expect(partsAt(TICKET_PARTS, at(TICKET_TIERS, 2, 1))).toEqual(['dest', 'when']);
    expect(partsAt(TICKET_PARTS, at(TICKET_TIERS, 40, 40))).toEqual(['dest', 'when', 'board', 'head']);
  });

  it('states each table in rising order, so a bigger box never says less', () => {
    for (const table of [PAGE_TIERS, TICKET_TIERS]) {
      for (let i = 1; i < table.length; i++) {
        expect((table[i] as { minCh: number }).minCh).toBeGreaterThanOrEqual((table[i - 1] as { minCh: number }).minCh);
        expect((table[i] as { minEm: number }).minEm).toBeGreaterThan((table[i - 1] as { minEm: number }).minEm);
        expect((table[i] as { rungs: number }).rungs).toBeGreaterThan((table[i - 1] as { rungs: number }).rungs);
      }
    }
  });
});

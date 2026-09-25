import { describe, expect, it } from 'vitest';

import {
  CELEBRATION_EVERY_MS,
  CONFETTI_PIECES,
  FIREWORK_BURSTS,
  OCCASIONS,
  OCCASION_LABELS,
  OCCASION_LOOKS,
  OCCASION_SCENE_MS,
  SCENE_SPOTS,
  SPARKS,
  WAVE_BAND_MS,
  confettiPieces,
  countdownEmoji,
  countdownFrom,
  countdownOccasion,
  countdownProgress,
  miniMonth,
  monthTitleWords,
  percentWords,
  sparkReach,
  targetDateWords,
  todayInMonth,
  weekdayHeads,
} from '../src/countdown.js';
import { isEmojiKey } from '../src/emoji.js';
import { NO_ONE_SHOTS, changedAt, createOneShotMemory, repeatFiredAt } from '../src/motion.js';
import { customTokens } from '../src/theme.js';
import {
  COUNTDOWN_PARTS,
  COUNTDOWN_TIERS,
  MONTH_PARTS,
  MONTH_TIERS,
  OCCASION_PARTS,
  OCCASION_TIERS,
  PAGE_PARTS,
  PAGE_TIERS,
  PROGRESS_PARTS,
  PROGRESS_TIERS,
  TICKET_PARTS,
  TICKET_TIERS,
  partsAt,
  widgetTierFor,
} from '../src/widget-tiers.js';

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

describe('an occasion is dressed from the theme’s own tokens (P5.2, the second half)', () => {
  it('reads an absent or unknown occasion as `custom`', () => {
    expect(countdownOccasion({})).toBe('custom');
    expect(countdownOccasion(undefined)).toBe('custom');
    expect(countdownOccasion({ occasion: 'easter' })).toBe('custom');
    expect(countdownOccasion({ occasion: 'christmas' })).toBe('christmas');
    expect(countdownOccasion({ occasion: 'schools-out' })).toBe('schools-out');
  });

  it('names a pair of tokens a custom theme derives, and a motif from the bundled set, for every occasion', () => {
    // Tokens a theme is built from, plus what `customTokens` derives from
    // them: the palette (S13). A pair naming a colour, or a token nothing
    // derives, would be an accent some theme does not have.
    const derived = customTokens({
      '--bg': '#F6F1E7', '--panel': '#FFFFFF', '--rule': '#D8D0C0', '--ink': '#2A2A2A', '--muted': '#6B6B6B',
      '--faint': '#B0A898', '--accent': '#B4532A', '--s-day': '#3A7BD5', '--s-night': '#5B4BB5',
      '--s-break': '#8A8A8A', '--s-straight': '#2E8B57',
    });
    expect(Object.keys(OCCASION_LOOKS).sort()).toEqual([...OCCASIONS].sort());
    for (const occasion of OCCASIONS) {
      const look = OCCASION_LOOKS[occasion];
      expect(derived[look.a], `${occasion}'s ${look.a}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(derived[look.b], `${occasion}'s ${look.b}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(look.a, `${occasion} wears one token twice`).not.toBe(look.b);
      if (occasion === 'custom') expect(look.motif, 'custom wears the household’s picture').toBeUndefined();
      else expect(isEmojiKey(look.motif), `${occasion}'s motif ${look.motif}`).toBe(true);
      expect(OCCASION_LABELS[occasion].length).toBeGreaterThan(0);
    }
    // Six named occasions, six different scenes, and six different pairs.
    const named = OCCASIONS.filter((one) => one !== 'custom');
    expect(new Set(named.map((one) => OCCASION_LOOKS[one].scene)).size).toBe(named.length);
    expect(new Set(named.map((one) => `${OCCASION_LOOKS[one].a} ${OCCASION_LOOKS[one].b}`)).size).toBe(named.length);
  });

  it('holds every scene’s cycle clear of the fifteen-second redraw, so a restart could never hide', () => {
    // `SKY_MOTION_MS`' rule: a restart lands `15000 mod cycle` into it, and
    // that has to be at least a quarter of a cycle from either end.
    const cycles = [...Object.values(OCCASION_SCENE_MS), ...WAVE_BAND_MS];
    for (const cycle of cycles) {
      const into = 15_000 % cycle;
      expect(Math.min(into, cycle - into), `a ${cycle}ms cycle`).toBeGreaterThanOrEqual(cycle / 4);
    }
  });

  it('rests every piece inside the box, and throws each burst’s sparks evenly round a circle', () => {
    for (const [scene, spots] of Object.entries(SCENE_SPOTS)) {
      for (const spot of spots) {
        expect(spot.left, scene).toBeGreaterThanOrEqual(0);
        expect(spot.left, scene).toBeLessThanOrEqual(100);
        expect(spot.top, scene).toBeGreaterThanOrEqual(0);
        expect(spot.top, scene).toBeLessThanOrEqual(100);
      }
    }
    expect(FIREWORK_BURSTS.length * SPARKS).toBeLessThanOrEqual(CONFETTI_PIECES);
    for (let i = 0; i < SPARKS; i++) {
      const { dx, dy } = sparkReach(i);
      expect(Math.hypot(dx, dy)).toBeCloseTo(1, 1);
    }
    expect(sparkReach(0)).toEqual({ dx: 1, dy: 0 });
    expect(sparkReach(SPARKS / 2)).toEqual({ dx: -1, dy: 0 });
  });
});

describe('a progress bar counts from a start before its target, and never makes one up', () => {
  it('refuses a start that is not a date, or not before the target, rather than drawing one', () => {
    expect(countdownFrom({ target: '2026-12-25', from: '2026-09-01' })).toBe('2026-09-01');
    expect(countdownFrom({ target: '2026-12-25', from: '2026-12-25' })).toBeUndefined();
    expect(countdownFrom({ target: '2026-12-25', from: '2027-01-01' })).toBeUndefined();
    expect(countdownFrom({ target: '2026-12-25', from: '1 Sept' })).toBeUndefined();
    expect(countdownFrom({ from: '2026-09-01' })).toBeUndefined();
    expect(countdownFrom({ target: '2026-12-25' })).toBeUndefined();
  });

  it('floors the percentage, so the day before is 99% and only the day is 100%', () => {
    // 1 September to 25 December is 115 days.
    expect(countdownProgress('2026-09-25', '2026-09-01', '2026-12-25')).toEqual({
      total: 115,
      gone: 24,
      fraction: 24 / 115,
      percent: 20,
    });
    expect(countdownProgress('2026-12-24', '2026-09-01', '2026-12-25')?.percent).toBe(99);
    expect(countdownProgress('2026-12-25', '2026-09-01', '2026-12-25')?.percent).toBe(100);
    // After the target it stays full, and before the start it is empty.
    expect(countdownProgress('2027-01-03', '2026-09-01', '2026-12-25')).toMatchObject({ fraction: 1, percent: 100 });
    expect(countdownProgress('2026-08-20', '2026-09-01', '2026-12-25')).toMatchObject({ gone: 0, fraction: 0, percent: 0 });
    expect(countdownProgress('2026-09-25', '2026-12-25', '2026-12-25')).toBeUndefined();
    expect(percentWords(countdownProgress('2026-09-25', '2026-09-01', '2026-12-25')!)).toBe('20% of the way');
  });
});

describe('a mini month is the target’s own month, in the household’s week', () => {
  it('starts on the household’s first day, and pads whole weeks', () => {
    // 1 October 2026 is a Thursday.
    const sunday = miniMonth('2026-10-07', 'sunday');
    expect(sunday.year).toBe(2026);
    expect(sunday.month).toBe(10);
    expect(sunday.weeks[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(miniMonth('2026-10-07', 'monday').weeks[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    for (const week of sunday.weeks) expect(week).toHaveLength(7);
    expect(sunday.weeks.flat().filter((day) => day !== null)).toHaveLength(31);
  });

  it('takes four rows for a February that starts a week, and six for a month that runs over', () => {
    // 1 February 2026 is a Sunday: exactly four weeks.
    expect(miniMonth('2026-02-14', 'sunday').weeks).toHaveLength(4);
    // 1 August 2026 is a Saturday: thirty-one days from the last column.
    expect(miniMonth('2026-08-30', 'sunday').weeks).toHaveLength(6);
    // A leap February has its 29th.
    expect(miniMonth('2028-02-10', 'monday').weeks.flat()).toContain(29);
  });

  it('marks today only when today is in the target’s month', () => {
    expect(todayInMonth('2026-10-03', '2026-10-25')).toBe(3);
    expect(todayInMonth('2026-09-30', '2026-10-25')).toBeUndefined();
    expect(todayInMonth('2025-10-03', '2026-10-25')).toBeUndefined();
  });

  it('names the month, and heads its columns in the household’s order', () => {
    expect(monthTitleWords('2026-10-07', 'en-GB')).toBe('October 2026');
    expect(weekdayHeads('sunday', 'en-GB')).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(weekdayHeads('monday', 'en-GB')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });
});

describe('the occasion, the bar and the month give up what their tables say', () => {
  const CH = 8;
  const EM = 20;
  const at = (table: typeof PAGE_TIERS, ch: number, em: number) => widgetTierFor(table, ch * CH, em * EM, CH, EM);

  it('keeps each look’s count at every size, and all of it in a large box', () => {
    expect(partsAt(OCCASION_PARTS, at(OCCASION_TIERS, 2, 1))).toEqual(['num', 'unit']);
    expect(partsAt(OCCASION_PARTS, at(OCCASION_TIERS, 40, 40))).toEqual(['num', 'unit', 'label', 'motif']);
    expect(partsAt(PROGRESS_PARTS, at(PROGRESS_TIERS, 2, 1))).toEqual(['count']);
    expect(partsAt(PROGRESS_PARTS, at(PROGRESS_TIERS, 40, 40))).toEqual(['count', 'bar', 'label', 'pct']);
    expect(partsAt(MONTH_PARTS, at(MONTH_TIERS, 2, 1))).toEqual(['count']);
    expect(partsAt(MONTH_PARTS, at(MONTH_TIERS, 40, 40))).toEqual(['count', 'grid', 'label', 'title', 'heads']);
  });

  it('lets a wide, short box keep the occasion’s motif, and a narrow one give it up first', () => {
    // The motif sits beside the count, so it costs width and not height.
    expect(partsAt(OCCASION_PARTS, at(OCCASION_TIERS, 40, 4))).toEqual(['num', 'unit', 'label', 'motif']);
    expect(partsAt(OCCASION_PARTS, at(OCCASION_TIERS, 11, 40))).toEqual(['num', 'unit', 'label']);
  });

  it('gives up the heads and the name together, before the grid', () => {
    expect(partsAt(MONTH_PARTS, at(MONTH_TIERS, 40, 10))).toEqual(['count', 'grid', 'label']);
    expect(partsAt(MONTH_PARTS, at(MONTH_TIERS, 40, 9))).toEqual(['count', 'grid']);
    // Classic's own box, 4.4 ledes: a month does not fit, and the count does.
    expect(partsAt(MONTH_PARTS, at(MONTH_TIERS, 70, 4.4))).toEqual(['count']);
  });

  it('states every countdown table in rising order, and names its parts', () => {
    expect(Object.keys(COUNTDOWN_TIERS).sort()).toEqual(['month', 'occasion', 'page', 'progress', 'ticket']);
    expect(Object.keys(COUNTDOWN_PARTS).sort()).toEqual(Object.keys(COUNTDOWN_TIERS).sort());
    for (const [look, table] of Object.entries(COUNTDOWN_TIERS)) {
      const parts = COUNTDOWN_PARTS[look] ?? [];
      expect((table[table.length - 1] as { rungs: number }).rungs, look).toBe(parts.length);
      for (let i = 1; i < table.length; i++) {
        const a = table[i - 1] as { minCh: number; minEm: number; rungs: number };
        const b = table[i] as { minCh: number; minEm: number; rungs: number };
        expect(b.minCh, look).toBeGreaterThanOrEqual(a.minCh);
        expect(b.minEm, look).toBeGreaterThanOrEqual(a.minEm);
        expect(b.minCh > a.minCh || b.minEm > a.minEm, `${look} ${b.minCh}x${b.minEm} asks for nothing more`).toBe(true);
        expect(b.rungs, look).toBeGreaterThan(a.rungs);
      }
    }
  });
});

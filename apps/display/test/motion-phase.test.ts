import { describe, expect, it } from 'vitest';

import {
  NO_ONE_SHOTS,
  ONE_SHOT_FORGET_MS,
  ONE_SHOT_MAX,
  createOneShotMemory,
  lockLoop,
  lockOnce,
  oneShotPhase,
  phaseDelay,
} from '../src/motion.js';

/**
 * The arithmetic that lets a wall move without restarting (plan P4.3).
 *
 * `browser-motion.test.ts` measures the animation a real Chromium computes on a
 * real paired wall across a real tick; this asks what a rendered page cannot,
 * which is the rule across every instant rather than the two a test happens to
 * sample — and the edges (a clock before the epoch, a duration of nothing, a
 * resync that moves the clock back) that no fifteen-second wait will ever meet.
 */

/** A delay string as a number of milliseconds. */
const ms = (delay: string): number => Number(/^(-?\d+)ms$/.exec(delay)?.[1] ?? NaN);

describe('a loop, locked to the wall clock', () => {
  it('starts however far into its cycle the wall clock is', () => {
    expect(phaseDelay(6_000, 15_000)).toBe('-3000ms');
    expect(phaseDelay(6_000, 6_000 * 1e8 + 1_234)).toBe('-1234ms');
    // On a cycle boundary there is nothing to skip.
    expect(phaseDelay(6_000, 12_000)).toBe('0ms');
  });

  it('puts a rebuilt element exactly where the one it replaced had got to', () => {
    /*
     * The property the whole module exists for, stated as the arithmetic:
     * an element made at t1 has, by t2, run `phase(t1) + (t2 - t1)` into its
     * loop — and the element made at t2 in its place starts at `phase(t2)`.
     * Equal modulo the cycle, at every instant and for every redraw gap, the
     * tick's own fifteen seconds included.
     */
    const cycle = 6_000;
    for (let t1 = 1_790_000_000_000; t1 < 1_790_000_000_000 + 40_000; t1 += 997) {
      for (const gap of [15_000, 60_000, 250, 6_000, 14_999]) {
        const old = (-ms(phaseDelay(cycle, t1)) + gap) % cycle;
        const rebuilt = -ms(phaseDelay(cycle, t1 + gap));
        expect(rebuilt, `made at ${t1}, redrawn ${gap}ms later`).toBe(old);
      }
    }
  });

  it('never hands CSS a positive delay, which would hold an element still', () => {
    // A clock before the epoch: `%` in JavaScript keeps the sign of the left
    // side, and `-(-1000 % 6000)` would be a *wait* of a second.
    expect(phaseDelay(6_000, -1_000)).toBe('-5000ms');
    for (let now = -20_000; now < 20_000; now += 777) {
      expect(ms(phaseDelay(6_000, now)), `at ${now}`).toBeLessThanOrEqual(0);
      expect(ms(phaseDelay(6_000, now)), `at ${now}`).toBeGreaterThan(-6_000);
    }
  });

  it('answers no delay at all for a duration or a clock that is not one', () => {
    // A draw must never be what fails, so nothing here throws.
    for (const duration of [0, -5, NaN, Infinity]) {
      expect(phaseDelay(duration, 15_000), `duration ${duration}`).toBe('0ms');
    }
    expect(phaseDelay(6_000, NaN)).toBe('0ms');
  });
});

describe('a one-shot, locked to the moment it fired', () => {
  it('plays from where it is while it is still playing, and is done after', () => {
    expect(oneShotPhase(10_000, 2_400, 10_000)).toEqual({ playing: true, delay: '0ms' });
    expect(oneShotPhase(10_000, 2_400, 11_000)).toEqual({ playing: true, delay: '-1000ms' });
    expect(oneShotPhase(10_000, 2_400, 12_399)).toEqual({ playing: true, delay: '-2399ms' });
    expect(oneShotPhase(10_000, 2_400, 12_400)).toEqual({ playing: false });
    expect(oneShotPhase(10_000, 2_400, 25_000)).toEqual({ playing: false });
  });

  it('draws the still frame on a surface with no memory', () => {
    // An admin preview: nobody to remember an event for, and a preview that
    // went off whenever a control was touched is the fault one screen along.
    expect(oneShotPhase(undefined, 2_400, 25_000)).toEqual({ playing: false });
    expect(NO_ONE_SHOTS.firedAt('w1', 'e1', 25_000)).toBeUndefined();
  });

  it('reads a clock moved back by a resync as "just fired", never as a positive delay', () => {
    expect(oneShotPhase(10_000, 2_400, 9_950)).toEqual({ playing: true, delay: '0ms' });
  });

  it('is done at once for a duration that is not one', () => {
    for (const duration of [0, -1, NaN]) {
      expect(oneShotPhase(10_000, duration, 10_000), `duration ${duration}`).toEqual({ playing: false });
    }
  });
});

describe("the wall's one-shot memory", () => {
  it('fires an event once, and answers the same moment on every tick after', () => {
    const memory = createOneShotMemory();
    const first = 1_790_000_000_000;
    expect(memory.firedAt('w1', '2026-12-25', first)).toBe(first);
    // The next four ticks: the same moment, so a 2.4s burst plays once and
    // every draw after it is the still frame — it does not refire.
    for (let tick = 1; tick <= 4; tick += 1) {
      const now = first + tick * 15_000;
      expect(memory.firedAt('w1', '2026-12-25', now), `tick ${tick}`).toBe(first);
      expect(oneShotPhase(memory.firedAt('w1', '2026-12-25', now), 2_400, now)).toEqual({ playing: false });
    }
    // A redraw part-way through resumes rather than restarts.
    expect(oneShotPhase(memory.firedAt('w1', '2026-12-25', first + 900), 2_400, first + 900)).toEqual({
      playing: true,
      delay: '-900ms',
    });
  });

  it('keys by widget and by event, so each is its own occasion', () => {
    const memory = createOneShotMemory();
    expect(memory.firedAt('w1', 'e1', 1_000)).toBe(1_000);
    // A second countdown reaching its day on the same wall fires for itself…
    expect(memory.firedAt('w2', 'e1', 5_000)).toBe(5_000);
    // …and the first one's next occasion is a new event.
    expect(memory.firedAt('w1', 'e2', 9_000)).toBe(9_000);
    expect(memory.firedAt('w1', 'e1', 9_000)).toBe(1_000);
    // A key built by joining the two with a separator would call these one.
    expect(memory.firedAt('a|b', 'c', 11_000)).toBe(11_000);
    expect(memory.firedAt('a', 'b|c', 12_000)).toBe(12_000);
  });

  it('forgets an event nobody has asked about for an hour, and not one still being drawn', () => {
    const memory = createOneShotMemory();
    memory.firedAt('w1', 'ended', 0);
    memory.firedAt('w1', 'current', 0);
    // `current` is asked about on every tick; `ended` stopped being drawn.
    for (let now = 15_000; now <= ONE_SHOT_FORGET_MS + 15_000; now += 15_000) {
      memory.firedAt('w1', 'current', now);
      memory.sweep(now);
    }
    const later = ONE_SHOT_FORGET_MS + 15_000;
    expect(memory.firedAt('w1', 'current', later), 'still drawn, still remembered').toBe(0);
    expect(memory.firedAt('w1', 'ended', later), 'forgotten, so it would fire again').toBe(later);
  });

  it('keeps an event through an alert takeover of less than an hour', () => {
    // A takeover draws no canvas, so nothing asks; the canvas coming back must
    // not set the confetti off a second time.
    const memory = createOneShotMemory();
    memory.firedAt('w1', 'day', 0);
    memory.sweep(50 * 60_000);
    expect(memory.firedAt('w1', 'day', 50 * 60_000)).toBe(0);
  });

  it('holds no more than its bound, dropping the oldest first', () => {
    const memory = createOneShotMemory();
    for (let n = 0; n < ONE_SHOT_MAX + 10; n += 1) memory.firedAt('w', `e${n}`, n);
    expect(memory.size).toBe(ONE_SHOT_MAX);
    expect(memory.firedAt('w', 'e0', 99_999), 'the oldest went first').toBe(99_999);
    expect(memory.firedAt('w', `e${ONE_SHOT_MAX + 9}`, 99_999)).toBe(ONE_SHOT_MAX + 9);
  });
});

/** Just enough of an element for the two writers: its inline style and its classes. */
function fakeNode(): { node: HTMLElement; style: Record<string, string>; classes: string[] } {
  const style: Record<string, string> = {};
  const classes: string[] = [];
  const node = { style, classList: { add: (name: string) => classes.push(name) } } as unknown as HTMLElement;
  return { node, style, classes };
}

describe('the two writers', () => {
  it('write a loop’s duration and delay and nothing else', () => {
    const { node, style, classes } = fakeNode();
    lockLoop(node, 6_000, 15_000);
    expect(style).toEqual({ animationDuration: '6000ms', animationDelay: '-3000ms' });
    expect(classes).toEqual([]);
  });

  it('write a playing one-shot’s timing and class, and leave a finished one untouched', () => {
    const playing = fakeNode();
    expect(lockOnce(playing.node, 2_400, { playing: true, delay: '-900ms' })).toBe(true);
    expect(playing.style).toEqual({ animationDuration: '2400ms', animationDelay: '-900ms' });
    expect(playing.classes).toEqual(['fx-playing']);

    const done = fakeNode();
    expect(lockOnce(done.node, 2_400, { playing: false })).toBe(false);
    expect(done.style).toEqual({});
    expect(done.classes).toEqual([]);
  });
});

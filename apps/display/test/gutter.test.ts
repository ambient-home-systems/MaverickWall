import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GUTTER_STEPS, gutterValue } from '../src/gutter.js';

/**
 * The gutter ladder, and the two properties the wall depends on (RFC 014 §4.4).
 *
 * The browser test next door (`apps/server/test/browser-canvas-gutter.test.ts`)
 * measures what a real wall draws at the two ends of this ladder; this asks the
 * questions a rendered page cannot, which are about the values the table does
 * *not* produce — the ones that decide whether an untouched wall, or a wall
 * talking to a server newer than its bundle, keeps the spacing it has.
 */
describe('the step a household chose, as a length', () => {
  it('answers a value for every step and nothing outside the ladder', () => {
    for (let step = 0; step < GUTTER_STEPS.length; step += 1) {
      expect(gutterValue(step), `step ${step}`).toBe(GUTTER_STEPS[step]);
    }
    /*
     * Everything here has to reach the *absent* branch, because that is the
     * one that leaves `.fw`'s own fallback standing. A value written into the
     * property instead would be a wall silently re-spaced by a document it did
     * not understand — the opposite of rule nine's side.
     */
    for (const outside of [-1, GUTTER_STEPS.length, 99, 1.5, NaN, Infinity]) {
      expect(gutterValue(outside), `${outside} is not a step`).toBeUndefined();
    }
    for (const notANumber of [undefined, null, '2', '', {}, [], true]) {
      expect(gutterValue(notANumber), `${String(notANumber)} is not a step`).toBeUndefined();
    }
  });

  it('spends nothing at step 0 and the wall’s own step 4 at the top', () => {
    // The two ends the browser test measures. Stated here as well because the
    // browser reads pixels and cannot say *which* token produced them.
    expect(gutterValue(0)).toBe('0px');
    expect(gutterValue(4)).toBe('var(--s4)');
  });

  it('gives step 0 a unit, because it is divided in CSS', () => {
    /*
     * `.fw` writes `calc(var(--fw-gutter, var(--s4)) / 2)`, and `calc(0 / 2)`
     * is invalid — a bare zero in `calc` has no unit to divide. An invalid
     * substitution makes the whole declaration compute to `padding`'s unset
     * value, which is `0` and so *looks* right at exactly the step where it is
     * wrong for the wrong reason. The browser test measures the pixels; this
     * is what says they came from the arithmetic.
     */
    expect(GUTTER_STEPS[0]).toMatch(/[a-z%]$/);
  });
});

describe('the stylesheet the ladder is written against', () => {
  const css = readFileSync(new URL('../src/display.css', import.meta.url), 'utf8');

  it('reads the property with today’s value as its fallback', () => {
    /*
     * The rule-nine half, asserted on the source rather than on a render,
     * because a rendered wall with the property set cannot show what an
     * *absent* one falls back to. `--s4` is the fallback and the top of the
     * ladder is `var(--s4)`, which is what makes "the household has not
     * chosen" and "the household chose Normal" the same pixels.
     */
    expect(css).toContain('padding: calc(var(--fw-gutter, var(--s4)) / 2);');
    expect(GUTTER_STEPS[GUTTER_STEPS.length - 1]).toBe('var(--s4)');
  });

  it('declares every token the ladder spends', () => {
    // A step naming a custom property nothing declares resolves to nothing,
    // which takes `calc()` with it and lands on `padding`'s unset value — a
    // touching wall, silently, at whichever step was mistyped.
    for (const step of GUTTER_STEPS) {
      const token = /^var\((--[a-z0-9-]+)\)$/.exec(step)?.[1];
      if (token === undefined) continue;
      expect(css, `${token} is spent by the gutter ladder and declared nowhere`).toContain(`${token}:`);
    }
  });
});

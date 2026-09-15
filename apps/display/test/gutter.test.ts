import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GUTTER_DEFAULT_STEP, GUTTER_STEPS, boxRect, gutterStepFor } from '../src/gutter.js';

/** The step's padding, or undefined — what the first half of this file asks about. */
const gutterValue = (step: unknown): string | undefined => gutterStepFor(step)?.padding;

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
      expect(gutterStepFor(step), `step ${step}`).toBe(GUTTER_STEPS[step]);
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

  it('spends nothing at step 0 and the wall’s own step 4 in the middle', () => {
    // Three of the ends the browser test measures. Stated here as well because
    // the browser reads pixels and cannot say *which* token produced them.
    expect(gutterValue(0)).toBe('0px');
    expect(gutterValue(4)).toBe('var(--s4)');
    expect(gutterValue(6)).toBe('var(--s4)');
  });

  it('pays the tighter half out of padding and the airier half out of the canvas', () => {
    /*
     * The whole of the two-budget rule, read off the table. Below the widget
     * box's own permission the padding *is* the gutter and the boxes tile;
     * above it the padding is pinned at that permission and the canvas pays
     * instead. A step that raised the padding past `--s4` would be spending
     * the canvas's budget out of the widget's, which is the thing the scale
     * forbids and the reason these are two properties.
     */
    for (const step of GUTTER_STEPS.slice(0, 5)) {
      expect(step.canvas, `${step.padding} should tile`).toBe('0px');
    }
    for (const step of GUTTER_STEPS.slice(5)) {
      expect(step.padding, 'the airier rungs must pin the padding at its permission').toBe('var(--s4)');
      expect(step.canvas).not.toBe('0px');
    }
    // Never past the canvas's own stated ceiling, which is step 5 of the scale.
    expect(GUTTER_STEPS[GUTTER_STEPS.length - 1]?.canvas).toBe('var(--s5)');
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
    expect(GUTTER_STEPS[0]?.padding).toMatch(/[a-z%]$/);
    expect(GUTTER_STEPS[0]?.canvas).toMatch(/[a-z%]$/);
  });
});

describe('the stylesheet the ladder is written against', () => {
  const css = readFileSync(new URL('../src/display.css', import.meta.url), 'utf8');

  it('reads the property with today’s value as its fallback', () => {
    /*
     * The rule-nine half, asserted on the source rather than on a render,
     * because a rendered wall with the property set cannot show what an
     * *absent* one falls back to. `--s4` is the fallback and the default rung
     * spends exactly that and nothing at the canvas, which is what makes "the
     * household has not chosen" and "the household chose Normal" the same
     * pixels — the pair the browser test then measures.
     */
    expect(css).toContain('padding: calc(var(--fw-gutter, var(--s4)) / 2);');
    expect(GUTTER_STEPS[GUTTER_DEFAULT_STEP]).toEqual({ padding: 'var(--s4)', canvas: '0px' });
  });

  it('nets the box units of what the canvas took, with 0px as the identity', () => {
    /*
     * `--bw`/`--bh` stay the authored fractions, so a widget that sizes its
     * type against its box has to subtract what it lost or it sizes for room
     * the canvas has taken — a `nowrap` clock clipping by exactly the gutter.
     * The `0px` default is what keeps an unchosen wall's computed value
     * identical rather than merely close.
     */
    expect(css).toContain('var(--canvas-w) * var(--bw, 0.25) - var(--in-x, 0px)');
    expect(css).toContain('var(--canvas-h) * var(--bh, 0.15) - var(--in-y, 0px)');
  });

  it('declares every token the ladder spends', () => {
    // A step naming a custom property nothing declares resolves to nothing,
    // which takes `calc()` with it and lands on `padding`'s unset value — a
    // touching wall, silently, at whichever step was mistyped.
    for (const token of GUTTER_STEPS.flatMap((step) => [step.padding, step.canvas])
      .map((value) => /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1])
      .filter((token): token is string => token !== undefined)) {
      expect(css, `${token} is spent by the gutter ladder and declared nowhere`).toContain(`${token}:`);
    }
  });
});

/**
 * Where a box lands once the canvas has taken its share.
 *
 * The browser test measures two adjacent boxes on a real wall; this asks the
 * questions a rendered page cannot, which are about the boxes it does *not*
 * inset — the ones against the edge of the layout, where a wall with the wrong
 * rule loses a border of itself and nothing in a gap measurement would say so.
 */
describe('the canvas taking room out of a box', () => {
  /** Classic's own shape: a top strip, and two boxes sharing a seam below it. */
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  const TOP = { x: 0, y: 0, w: 1, h: 0.2 };
  const LEFT = { x: 0, y: 0.2, w: 0.5, h: 0.8 };
  const RIGHT = { x: 0.5, y: 0.2, w: 0.5, h: 0.8 };
  const MIDDLE = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

  it('places every box exactly where it was authored when nothing is chosen', () => {
    /*
     * Rule nine, as strings rather than as pixels: an unchosen wall must get
     * the identical four declarations it got before this existed, and `0px`
     * for what it lost, or `--buw` stops being one per cent of the box.
     */
    for (const box of [FULL, TOP, LEFT, RIGHT, MIDDLE]) {
      for (const nothing of [undefined, '0px']) {
        expect(boxRect(box, nothing)).toEqual({
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.w * 100}%`,
          height: `${box.h * 100}%`,
          insetX: '0px',
          insetY: '0px',
        });
      }
    }
  });

  it('keeps the edges of the layout and opens only the seams', () => {
    /*
     * The placement rule, on the shape it was written for. `TOP` reaches left,
     * right and top, so it gives up its bottom alone; `LEFT` reaches left,
     * bottom and top of nothing — it shares its top with `TOP` and its right
     * with `RIGHT`. A rule that inset every side would pull all three off the
     * edge of the layout and hand a border of air back, which is what the
     * tiling rework spent a phase removing.
     */
    const top = boxRect(TOP, 'var(--s5)');
    expect(top.left).toBe('0%');
    expect(top.top).toBe('0%');
    expect(top.width).toBe('100%');
    expect(top.insetX).toBe('0px');
    expect(top.height).toContain('-');
    expect(top.insetY).toBe('calc(var(--s5) / 2)');

    const left = boxRect(LEFT, 'var(--s5)');
    expect(left.left).toBe('0%');
    expect(left.top).toContain('+');
    // Its right edge is a seam and its left is the layout's, so one half only.
    expect(left.insetX).toBe('calc(var(--s5) / 2)');
    expect(left.insetY).toBe('calc(var(--s5) / 2)');
  });

  it('takes both halves from a box that touches no edge', () => {
    const middle = boxRect(MIDDLE, 'var(--s3)');
    const half = 'calc(var(--s3) / 2)';
    expect(middle.left).toBe(`calc(25% + ${half})`);
    expect(middle.top).toBe(`calc(25% + ${half})`);
    expect(middle.insetX).toBe(`calc(${half} + ${half})`);
    expect(middle.insetY).toBe(`calc(${half} + ${half})`);
    expect(middle.width).toBe(`calc(50% - calc(${half} + ${half}))`);
  });

  it('leaves a box that is the whole layout alone', () => {
    // A full-bleed background shares a seam with nothing, so there is no gutter
    // for it to be on one side of. Insetting it would letterbox the wall.
    expect(boxRect(FULL, 'var(--s5)')).toEqual(boxRect(FULL, undefined));
  });

  it('reads a hand-authored edge as an edge', () => {
    // A template's fractions are typed rather than dragged, so `0.9999` is a
    // box somebody meant to reach the edge — under a pixel on any wall here.
    const nearly = boxRect({ x: 0, y: 0, w: 0.9999, h: 1 }, 'var(--s5)');
    expect(nearly.width).toBe('99.99%');
    expect(nearly.insetX).toBe('0px');
  });
});

/**
 * How much room a wall leaves between its widgets, measured (RFC 014 §4.4).
 *
 * The boxes on a wall tile — they share edges and reach the edge of the layout
 * — so the only room between two adjacent widgets is twice the `.fw` padding
 * and nothing else. That padding was one fixed value for every household, and
 * this is the step that lets one of them spend less of a fixed number of
 * pixels on chrome and more on what is drawn.
 *
 * Measured on the glass rather than read back out of the stylesheet, which for
 * this feature is the only honest way round: every one of these values is a
 * `calc()` over a custom property whose own base is `var(--t-wall-event,
 * var(--t-base))`, so the number a household actually gets is a product this
 * file cannot work out and a browser can. The gap asserted is between two
 * boxes' **content** edges, which is what a household sees; the padding that
 * produces it is half of it on each side and is never asserted on its own.
 *
 * Three questions, and the third is the one with rule nine in it:
 *
 *  - step 0 spends nothing, so two adjacent widgets' content touches;
 *  - step 4 spends exactly `--s4`, read off a probe planted in the same wall's
 *    layout so every `var()` in it resolves through the live cascade;
 *  - **a wall whose household has never been asked draws the identical wall it
 *    drew before the column existed**, which is `.fw`'s `var(--fw-gutter,
 *    var(--s4))` fallback and nothing else. Reverting that fallback turns the
 *    identity block below red and leaves the two ends green, which is why it
 *    is a block of its own rather than a line inside one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  measureWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { GUTTER_DEFAULT_STEP, GUTTER_MAX } from '../src/gutter.js';

/* A container installs with no `TZ` and the wizard is told Europe/London. */
process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and settles a wall per case. */
const SLOW = 180_000;

/** The floor, in CSS pixels. `--t-floor` in `display.css` carries the reason. */
const FLOOR_PX = 22;

/**
 * 1080x1920, and the size is load-bearing.
 *
 * This is the one viewport in the suite where the shipped Classic seed draws
 * **no run under the floor at all** on a wall nobody has measured
 * (`wall-density.test.ts`'s own `BASELINE`, `runsUnderFloor: 0`). Anywhere
 * smaller the answer is 48 before this feature exists, so "no run under the
 * floor" would be a claim about the panel rather than about the gutter, and
 * could not fail for anything this file changes.
 */
const VIEWPORT = { width: 1080, height: 1920 } as const;

/**
 * How far apart two border edges can be and still be one seam.
 *
 * Below step 5 the boxes tile and two edges that meet land a rounding error
 * apart, so a pixel would do. Above it the canvas takes room out of every
 * shared edge — which is the whole point — and the neighbours this is looking
 * for are deliberately no longer touching. So the search is loose and the
 * *assertion* is exact: the widest gutter the ladder can produce is the sum of
 * the two permissions, `--s4 + --s5`, and anything inside that with an overlap
 * on the other axis is a neighbour on a canvas whose boxes were authored to
 * tile. Selecting the pairs loosely cannot flatter the measurement, because
 * what is then measured is compared against an exact expected length — and
 * `expectATiledWall` holds the pair *count* to the same number at every rung,
 * which is what would catch a loose search wandering onto a new pair.
 */
const TOUCHING_SLACK_PX = 1;

/**
 * What a gap has to match, in pixels.
 *
 * "To the pixel" as the sub-pixel arithmetic actually allows: a gap is two
 * independently-rounded halves of one `calc()`, read off two rectangles a
 * browser reports in fractions. Anything this feature could get *wrong* is a
 * whole step out — the narrowest gap between two steps here is `--s1`, which
 * is 0.14 of the event role and several pixels at this size — so a tolerance
 * of a twentieth of a pixel cannot hide one.
 */
const EXACT_PX = 0.05;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  // The real `POST /admin/screens`, which is where a new wall is seeded with
  // Classic — so this measures the seed a household actually gets.
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Choose a step the way a household does — the settings form, not an `UPDATE`.
 *
 * The form is part of the subject here: the whole feature is a household
 * reaching this, and a test that wrote the column directly would pass over a
 * schema that refuses the field, a handler that never reads it and a control
 * that posts the wrong name.
 */
async function chooseGutter(step: number, clock24 = ''): Promise<void> {
  const saved = await wall.post(`/admin/screens/${screenId}`, {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: 'panels',
    clock_24: clock24,
    layout_gutter: String(step),
  });
  expect(saved.status, `saving step ${step}`).toBe(302);
  const stored = wall.db
    .prepare('SELECT layout_gutter AS g FROM screens WHERE id = ?')
    .get(screenId) as { g: number | null };
  expect(stored.g, `step ${step} reached the column`).toBe(step);
}

/**
 * A wall whose household has never been asked.
 *
 * Deliberately an `UPDATE` and not a form post, because that state is
 * unreachable through the form by design: the control always renders one
 * segment checked. It is what every wall in the world is on the day this
 * ships, and it is the state the identity block below is about.
 */
function neverAsked(): void {
  wall.db.prepare('UPDATE screens SET layout_gutter = NULL WHERE id = ?').run(screenId);
  const stored = wall.db
    .prepare('SELECT layout_gutter AS g FROM screens WHERE id = ?')
    .get(screenId) as { g: number | null };
  expect(stored.g, 'the wall is back to never having been asked').toBeNull();
}

interface GutterMeasurement {
  /** Every adjacent pair's content-edge gap, in CSS pixels. */
  readonly gaps: readonly number[];
  /** `--s4` and `--s5`, resolved through this wall's own cascade. */
  readonly s4: number;
  readonly s5: number;
  /** Every visible run drawn under the floor, for the message. */
  readonly under: readonly string[];
  /** How many boxes were on the layout, so an empty wall cannot pass quietly. */
  readonly boxes: number;
  /**
   * The widest padding any box spends on one axis, in total.
   *
   * The widget box's own permission is step 4, and the airier rungs must pay
   * the canvas rather than raise this — so it is the number that says the two
   * budgets stayed separate rather than one growing past its limit.
   */
  readonly widestPadding: number;
  /** How far the union of the boxes falls short of the layout, per edge. */
  readonly edgeSlack: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  /**
   * Anything drawn wider or taller than the box it is in, named.
   *
   * `--bw`/`--bh` are the *authored* fractions, so a widget that sizes its own
   * type against its box — the clock, the countdown — would size for room the
   * canvas has just taken away unless `.fw` subtracts it. The clock is
   * `white-space: nowrap` precisely so an oversized one clips rather than
   * wrapping, which means neither its rectangle nor a line count can see this:
   * `scrollWidth` past `clientWidth` can, which is the idiom the landscape
   * clock's own fix already had to reach for.
   *
   * **Width only, and that is a correction rather than a narrowing.** The
   * first draft asked the same question of the height and reported the clock
   * overflowing 84 into 78 at every rung, this change or not: `.clock` sets
   * `line-height` below 1, so it exceeds its own client height by the leading
   * alone with nothing hidden. That exact false positive is written up in
   * CLAUDE.md, where a clip detector flagged `.clock` and `.dr-num` for it and
   * the flag was confirmed pre-existing by stashing the change and measuring
   * the identical numbers. Horizontal is where this widget actually clips.
   */
  readonly clipped: readonly string[];
  /**
   * The clock's drawn type as a fraction of the box it is actually in.
   *
   * The one number that can see `--buw`/`--buh` being netted of what the
   * canvas took. `--bw`/`--bh` stay the *authored* fractions, so without the
   * subtraction a box-relative widget sizes itself for room it no longer has —
   * and on this wall the clock is bound by its box's **height** term, measured:
   * 89.9px in a 173px box at the default rung and 78.0px in a 150px box at the
   * airiest, which is the same 0.52 twice. Leave the netting out and the
   * numerator stays at the default rung's size while the denominator shrinks.
   */
  readonly clockToBox: number | undefined;
}

async function measureGutter(): Promise<GutterMeasurement> {
  const { page, close } = await loadWallSettled(link, VIEWPORT);
  try {
    await page.waitForSelector('.canvas .fw', { timeout: 20_000 });
    const geometry = await readGaps(page);
    const measured = await measureWall(page);
    const under = measured.runs
      .filter((run) => run.text.trim() !== '' && run.effectivePx < FLOOR_PX)
      .map((run) => `${run.effectivePx.toFixed(1)}px ${run.where} — ${run.text.slice(0, 40)}`);
    return { ...geometry, under };
  } finally {
    await close();
  }
}

/**
 * Every pair of boxes whose borders meet, and the room between their content.
 *
 * Derived from the drawn rectangles rather than from a list of widget names,
 * so this does not quietly stop measuring anything the day Classic's boxes
 * move — and so it fails loudly, on the box count, if they ever stop tiling.
 */
async function readGaps(page: Page): Promise<Omit<GutterMeasurement, 'under'>> {
  return page.evaluate(
    ({ touching }) => {
      const canvas = document.querySelector('.canvas') as HTMLElement;

      /*
       * `--s4` and `--s5` as this wall resolves them, from a probe in the
       * layout itself — resolved first, because the seam search below is bounded
       * by their sum.
       *
       * `getComputedStyle().getPropertyValue('--s4')` answers the token stream
       * — `calc(… * 0.85)` — and not a length, because the property is
       * unregistered. A real element with that height is the only thing that
       * makes the browser do the arithmetic, and planting it inside `.canvas`
       * is what makes it the *same* arithmetic: `--s4`'s base is
       * `var(--t-wall-event, var(--t-base))`, which is inherited from here.
       */
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      canvas.appendChild(probe);
      const resolve = (token: string): number => {
        probe.style.height = token;
        return probe.getBoundingClientRect().height;
      };
      const s4 = resolve('var(--s4)');
      const s5 = resolve('var(--s5)');
      probe.remove();
      const seam = s4 + s5 + touching;

      const boxes = [...canvas.querySelectorAll(':scope > .fw')].map((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          rect,
          top: parseFloat(style.paddingTop),
          right: parseFloat(style.paddingRight),
          bottom: parseFloat(style.paddingBottom),
          left: parseFloat(style.paddingLeft),
        };
      });

      const gaps: number[] = [];
      const overlaps = (aLow: number, aHigh: number, bLow: number, bHigh: number): boolean =>
        Math.min(aHigh, bHigh) - Math.max(aLow, bLow) > touching;
      for (const a of boxes) {
        for (const b of boxes) {
          if (a === b) continue;
          // b sits below a, with at most one seam between them.
          const below = b.rect.top - a.rect.bottom;
          if (below >= -touching && below <= seam &&
            overlaps(a.rect.left, a.rect.right, b.rect.left, b.rect.right)
          ) {
            gaps.push(b.rect.top + b.top - (a.rect.bottom - a.bottom));
          }
          // b sits to the right of a, with at most one seam between them.
          const right = b.rect.left - a.rect.right;
          if (right >= -touching && right <= seam &&
            overlaps(a.rect.top, a.rect.bottom, b.rect.top, b.rect.bottom)
          ) {
            gaps.push(b.rect.left + b.left - (a.rect.right - a.right));
          }
        }
      }

      const widestPadding = Math.max(
        0,
        ...boxes.map((box) => Math.max(box.left + box.right, box.top + box.bottom)),
      );

      /*
       * How far the boxes fall short of the layout's own edges.
       *
       * The placement rule keeps the edges of the layout and opens only the
       * seams, so this must stay at zero at every step — a rule that inset
       * every side would letterbox the wall, which no gap measurement can see.
       */
      const frame = canvas.getBoundingClientRect();
      const edgeSlack = {
        left: Math.min(...boxes.map((b) => b.rect.left)) - frame.left,
        top: Math.min(...boxes.map((b) => b.rect.top)) - frame.top,
        right: frame.right - Math.max(...boxes.map((b) => b.rect.right)),
        bottom: frame.bottom - Math.max(...boxes.map((b) => b.rect.bottom)),
      };

      const clipped: string[] = [];
      for (const node of canvas.querySelectorAll('.clock, .cd, .fw-content > *')) {
        const el = node as HTMLElement;
        if (el.scrollWidth > el.clientWidth + 1) {
          clipped.push(`${el.className || el.tagName} ${el.scrollWidth} wide in ${el.clientWidth}`);
        }
      }

      const clockBox = canvas.querySelector(':scope > .fw-clock') as HTMLElement | null;
      const clock = clockBox?.querySelector('.clock') as HTMLElement | null;
      const clockToBox =
        clockBox !== null && clock !== null && clockBox.clientHeight > 0
          ? parseFloat(window.getComputedStyle(clock).fontSize) / clockBox.clientHeight
          : undefined;

      return { gaps, s4, s5, boxes: boxes.length, widestPadding, edgeSlack, clipped, clockToBox };
    },
    { touching: TOUCHING_SLACK_PX },
  );
}

/**
 * How many seams this fixture's Classic seed has.
 *
 * Recorded rather than derived, and it is what keeps the loose seam search
 * honest: the same pairs must be found at every rung, so a search widened to
 * span the gutter cannot quietly pick up a *new* neighbour at the airy end and
 * average it into the answer. Seeded from the first measurement of the run so
 * the number is this wall's own rather than one transcribed from a template.
 */
let seams: number | undefined;

/** Every measurement here is about pairs, so a wall with none proves nothing. */
function expectATiledWall(measured: GutterMeasurement): void {
  expect(measured.boxes, 'the Classic seed drew no widgets').toBeGreaterThan(2);
  expect(
    measured.gaps.length,
    'no two boxes on this wall share an edge, so there is no gutter to measure',
  ).toBeGreaterThan(2);
  expect(measured.s4, '--s4 resolved to nothing on this wall').toBeGreaterThan(1);
  expect(measured.s5, '--s5 resolved to nothing on this wall').toBeGreaterThan(measured.s4);
  seams ??= measured.gaps.length;
  expect(
    measured.gaps.length,
    `the seam search found ${measured.gaps.length} pairs where it found ${seams} on this same wall`,
  ).toBe(seams);
  /*
   * The edges of the layout are kept at every step, which is the half of the
   * placement rule a gap measurement cannot see. A rule that inset every side
   * would read as a perfectly good gutter and quietly letterbox the wall —
   * handing back the border of air the tiling rework spent a phase removing.
   */
  for (const [edge, slack] of Object.entries(measured.edgeSlack)) {
    expect(Math.abs(slack), `the boxes leave ${slack.toFixed(2)}px of the layout bare at the ${edge}`)
      .toBeLessThan(EXACT_PX);
  }
}

describe('the room between a wall’s widgets, at both ends of the ladder', () => {
  it(
    'spends nothing at step 0: two adjacent widgets’ content touches',
    async () => {
      await chooseGutter(0);
      const measured = await measureGutter();
      expectATiledWall(measured);

      for (const gap of measured.gaps) {
        expect(gap, `a gap of ${gap.toFixed(2)}px where the household asked for none`).toBeLessThan(
          EXACT_PX,
        );
      }
      expect(
        measured.under,
        `${measured.under.length} runs under the ${FLOOR_PX}px floor at step 0:\n  ${measured.under.join('\n  ')}`,
      ).toEqual([]);
    },
    SLOW,
  );

  it(
    'spends exactly --s4 at step 4, and takes no run under the floor',
    async () => {
      await chooseGutter(GUTTER_DEFAULT_STEP);
      const measured = await measureGutter();
      expectATiledWall(measured);

      for (const gap of measured.gaps) {
        expect(
          Math.abs(gap - measured.s4),
          `a gap of ${gap.toFixed(2)}px against --s4 at ${measured.s4.toFixed(2)}px`,
        ).toBeLessThan(EXACT_PX);
      }
      expect(
        measured.under,
        `${measured.under.length} runs under the ${FLOOR_PX}px floor at step 4:\n  ${measured.under.join('\n  ')}`,
      ).toEqual([]);
    },
    SLOW,
  );

  it(
    'pays the airier rungs from the canvas and never from the widget box',
    async () => {
      /*
       * **The two budgets, measured.** The spacing scale lets a widget box
       * spend at most step 4 on padding, total per axis, and lets the canvas
       * spend at most step 5 between the boxes it holds. Every rung past 4
       * therefore has to arrive as room taken *out of the box rectangle* — the
       * boxes stop sharing edges and the wall's ground opens between them —
       * rather than as more padding, which would be the widget paying the
       * canvas's bill out of a budget already spent to its limit.
       *
       * So: the gap grows, and `widestPadding` does not.
       */
      await chooseGutter(GUTTER_DEFAULT_STEP);
      const normal = await measureGutter();
      expectATiledWall(normal);

      await chooseGutter(GUTTER_MAX);
      const airy = await measureGutter();
      expectATiledWall(airy);

      // The airiest rung is the widget's whole padding plus the canvas's whole
      // ceiling: `--s4 + --s5`, which is the sum of the two permissions.
      for (const gap of airy.gaps) {
        expect(
          Math.abs(gap - (airy.s4 + airy.s5)),
          `a gap of ${gap.toFixed(2)}px against --s4 + --s5 at ${(airy.s4 + airy.s5).toFixed(2)}px`,
        ).toBeLessThan(EXACT_PX);
      }
      expect(
        airy.widestPadding,
        'the airier rung raised the widget box past its own step-4 permission',
      ).toBeCloseTo(normal.widestPadding, 1);
      expect(airy.widestPadding, 'the padding is not the step-4 permission').toBeCloseTo(airy.s4, 1);

      expect(
        airy.under,
        `${airy.under.length} runs under the ${FLOOR_PX}px floor at the airiest rung:\n  ${airy.under.join('\n  ')}`,
      ).toEqual([]);

      /*
       * And nothing overflows the box it was given. This is what says `.fw`
       * nets `--buw`/`--buh` of what the canvas took: leave them on the
       * authored fraction and a box-relative widget sizes itself for room it
       * no longer has, by exactly the gutter.
       */
      expect(
        airy.clipped,
        `${airy.clipped.length} things overflow their box at the airiest rung:\n  ${airy.clipped.join('\n  ')}`,
      ).toEqual([]);
      expect(normal.clipped, 'something already overflowed at the default rung').toEqual([]);
    },
    SLOW,
  );

  it(
    'sizes a box-relative widget against the box the canvas left it',
    async () => {
      /*
       * **The netting, measured as a proportion — and the two assertions that
       * could not see it at all.** `--bw`/`--bh` stay the authored fractions,
       * so `.fw` has to subtract what the canvas took or a widget sizing itself
       * against its box sizes for room it no longer has.
       *
       * Asking whether anything *overflows* cannot see that, and neither can a
       * 12-hour clock, which is where this went first on CLAUDE.md's own
       * evidence that "08:26 pm" puts the clock on its width term. Both were
       * written, both stayed green with the netting reverted, and probing the
       * live wall is what said why: `.clock` is a block, so its `scrollWidth`
       * is its parent's width until the text is genuinely wider — and on this
       * fixture the text fits at either size, in either format. The clock here
       * is bound by its box's **height** term.
       *
       * So the observable is the proportion. Measured: 89.9px of type in a
       * 173px box at the default rung, 78.0px in a 150px box at the airiest —
       * the same 0.52 twice, because the widget followed its box down. Without
       * the subtraction the numerator stays at the default rung's size while
       * the denominator shrinks, and the ratio moves by the whole gutter.
       */
      await chooseGutter(GUTTER_DEFAULT_STEP);
      const normal = await measureGutter();
      await chooseGutter(GUTTER_MAX);
      const airy = await measureGutter();
      expectATiledWall(airy);

      expect(normal.clockToBox, 'no clock on this wall to measure').toBeDefined();
      expect(airy.clockToBox, 'no clock on this wall to measure').toBeDefined();
      expect(
        airy.clockToBox!,
        `the clock is ${(airy.clockToBox! * 100).toFixed(1)}% of its box at the airiest rung and ` +
          `${(normal.clockToBox! * 100).toFixed(1)}% at the default one — it is sizing against a box it has not got`,
      ).toBeCloseTo(normal.clockToBox!, 2);

      // And the boxes really did get smaller, or the ratio above held for the
      // uninteresting reason that nothing moved.
      expect(airy.clipped, `something overflows its box at the airiest rung:\n  ${airy.clipped.join('\n  ')}`).toEqual([]);
    },
    SLOW,
  );

  it(
    'grows the gap at every rung of the ladder, and never shrinks it',
    async () => {
      /*
       * Monotone, measured end to end, which is what says the ladder is one
       * scale across two mechanisms rather than two ladders with a seam in the
       * middle. The interesting rung is 5, where the padding stops growing and
       * the canvas starts paying: a break in the progression there would be the
       * hand-off going wrong and would read, on a wall, as a setting that does
       * nothing once.
       */
      const widest: number[] = [];
      for (let step = 0; step <= GUTTER_MAX; step += 1) {
        await chooseGutter(step);
        const measured = await measureGutter();
        expectATiledWall(measured);
        widest.push(Math.max(...measured.gaps));
      }
      for (let step = 1; step < widest.length; step += 1) {
        expect(
          widest[step]!,
          `step ${step} (${widest[step]!.toFixed(2)}px) is not airier than step ${step - 1} (${widest[step - 1]!.toFixed(2)}px)`,
        ).toBeGreaterThan(widest[step - 1]! + EXACT_PX);
      }
    },
    SLOW,
  );

  it(
    'draws a step the household did not choose at the two ends and nowhere between',
    async () => {
      /*
       * The ladder is monotone and its two ends are the whole of its range —
       * which is what says step 0 and step 4 are not the same wall measured
       * twice, and that the assertions above are reading the property rather
       * than a constant the stylesheet would have produced anyway.
       */
      await chooseGutter(0);
      const tight = await measureGutter();
      await chooseGutter(GUTTER_DEFAULT_STEP);
      const normal = await measureGutter();
      expect(Math.max(...tight.gaps)).toBeLessThan(Math.min(...normal.gaps));
    },
    SLOW,
  );
});

describe('a wall whose household has never been asked', () => {
  it(
    'draws exactly what it drew before the column existed',
    async () => {
      /*
       * **The assertion the `.fw` fallback is for.** With `var(--fw-gutter,
       * var(--s4))` reverted to a bare `var(--fw-gutter)`, an absent property
       * makes the whole `calc()` invalid and `padding` computes to its unset
       * value — zero — so an untouched wall in every kitchen goes from `--s4`
       * to touching at one image pull. Measured here as the pixels rather than
       * as the declaration, and the two ends above stay green through it,
       * which is what makes this its own block.
       */
      neverAsked();
      const measured = await measureGutter();
      expectATiledWall(measured);

      for (const gap of measured.gaps) {
        expect(
          Math.abs(gap - measured.s4),
          `an unasked wall drew ${gap.toFixed(2)}px where it has always drawn --s4 (${measured.s4.toFixed(2)}px)`,
        ).toBeLessThan(EXACT_PX);
      }
    },
    SLOW,
  );

  it(
    'sends the manifest it sent before the column existed, and step 4 is the same wall',
    async () => {
      /*
       * Absence is spread out of the document rather than emitted as a null,
       * because `manifestEtag` hashes the serialisation — a `"layoutGutter":
       * null` on every wall in the world would churn every stored ETag, and
       * every e-paper frame with it, at one image pull for a setting nobody
       * opened. And the pair below is the other half of why the control can
       * honestly check `Normal` on a wall that has never been asked: the two
       * states are different documents and the same wall.
       */
      neverAsked();
      const absent = await manifestScreen();
      expect(absent).not.toHaveProperty('layoutGutter');

      await chooseGutter(GUTTER_DEFAULT_STEP);
      const chosen = await manifestScreen();
      expect(chosen).toHaveProperty('layoutGutter', GUTTER_DEFAULT_STEP);
      // Everything else about the screen is untouched by the choice.
      expect({ ...chosen, layoutGutter: undefined }).toEqual({ ...absent, layoutGutter: undefined });
    },
    SLOW,
  );

  it(
    'refuses a step it has never heard of rather than clamping it',
    async () => {
      /*
       * Reachable only by hand — every value the form offers is in range — so
       * this is about what a hand-edited row draws, which is `physicalWall`'s
       * rule one setting along: the wall the household had yesterday, not a
       * confident guess at which end of the ladder somebody meant.
       */
      wall.db.prepare('UPDATE screens SET layout_gutter = 9 WHERE id = ?').run(screenId);
      expect(await manifestScreen()).not.toHaveProperty('layoutGutter');
      neverAsked();
    },
    SLOW,
  );
});

describe('the control a household reaches it through', () => {
  /** The wall's own settings page, as a household is served it. */
  async function settingsHtml(): Promise<string> {
    return (await wall.call(`/admin/walls/${screenId}`)).text();
  }

  /** Which `layout_gutter` radio carries `checked`, and which values exist. */
  function segments(html: string): { readonly values: string[]; readonly checked: string[] } {
    const values: string[] = [];
    const checked: string[] = [];
    for (const tag of html.matchAll(/<input[^>]*name="layout_gutter"[^>]*>/g)) {
      const value = /value="([^"]*)"/.exec(tag[0])?.[1] ?? '';
      values.push(value);
      if (/\bchecked\b/.test(tag[0])) checked.push(value);
    }
    return { values, checked };
  }

  it('offers the whole ladder, and exactly one of it', async () => {
    await chooseGutter(1);
    const { values, checked } = segments(await settingsHtml());
    expect(values).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    // Exactly one, because a radio group with two checked posts the last and a
    // radio group with none posts nothing — and nothing is what this handler
    // reads as "leave the column alone", so the control would silently stop
    // working rather than fail.
    expect(checked).toEqual(['1']);
  });

  it('checks the step that draws what the wall is drawing, on a wall nobody has asked', async () => {
    /*
     * Null and step 4 are the same pixels, which is what makes this honest
     * rather than a default wearing a different hat. A grid with nothing
     * checked would read as "this wall has no spacing" on the one screen whose
     * whole subject is that it has some — RFC 015 §3.5, one row along.
     */
    neverAsked();
    expect(segments(await settingsHtml()).checked).toEqual([String(GUTTER_DEFAULT_STEP)]);
  });

  it('leaves the column alone when a page that predates the row saves', async () => {
    /*
     * A tab rendered before this control existed posts no step at all. It must
     * not be read as a choice: a household saving a timezone from a stale page
     * would otherwise write a spacing nobody picked, onto the wall they are
     * looking at.
     */
    await chooseGutter(2);
    const saved = await wall.post(`/admin/screens/${screenId}`, {
      name: 'Kitchen',
      orientation: 'auto',
      rotation: '0',
      theme: 'panels',
    });
    expect(saved.status).toBe(302);
    const stored = wall.db
      .prepare('SELECT layout_gutter AS g FROM screens WHERE id = ?')
      .get(screenId) as { g: number | null };
    expect(stored.g, 'a body with no step rewrote the column').toBe(2);

    // And the same body against a wall that has never been asked leaves it null,
    // which is the state that keeps its manifest byte-identical.
    neverAsked();
    expect((await wall.post(`/admin/screens/${screenId}`, {
      name: 'Kitchen', orientation: 'auto', rotation: '0', theme: 'panels',
    })).status).toBe(302);
    expect(
      (wall.db.prepare('SELECT layout_gutter AS g FROM screens WHERE id = ?').get(screenId) as {
        g: number | null;
      }).g,
      'a body with no step invented one for an unasked wall',
    ).toBeNull();
  });

  it('refuses a step outside the ladder rather than saving the nearest', async () => {
    neverAsked();
    const refused = await wall.post(`/admin/screens/${screenId}`, {
      name: 'Kitchen',
      orientation: 'auto',
      rotation: '0',
      theme: 'panels',
      layout_gutter: '9',
    });
    expect(refused.status).toBe(400);
    expect(
      (wall.db.prepare('SELECT layout_gutter AS g FROM screens WHERE id = ?').get(screenId) as {
        g: number | null;
      }).g,
      'a refused save wrote something anyway',
    ).toBeNull();
  });
});

/** The `screen` block of the manifest this wall is actually served. */
async function manifestScreen(): Promise<Record<string, unknown>> {
  const { page, close } = await loadWallSettled(link, VIEWPORT);
  try {
    const body = (await page.evaluate(async () => {
      const answer = await fetch('/d/manifest');
      return (await answer.json()) as { screen?: Record<string, unknown> };
    })) as { screen?: Record<string, unknown> };
    return body.screen ?? {};
  } finally {
    await close();
  }
}

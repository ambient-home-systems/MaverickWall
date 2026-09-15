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
import { GUTTER_DEFAULT_STEP } from '../src/gutter.js';

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
 * Two boxes are adjacent when their border edges meet, within this.
 *
 * The boxes are placed as percentages of a letterboxed layout, so two edges
 * that tile land a rounding error apart rather than on the same number.
 */
const TOUCHING_PX = 1;

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
async function chooseGutter(step: number): Promise<void> {
  const saved = await wall.post(`/admin/screens/${screenId}`, {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: 'panels',
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
  /** `--s4`, resolved through this wall's own cascade. */
  readonly s4: number;
  /** Every visible run drawn under the floor, for the message. */
  readonly under: readonly string[];
  /** How many boxes were on the layout, so an empty wall cannot pass quietly. */
  readonly boxes: number;
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
          // b sits directly below a.
          if (
            Math.abs(b.rect.top - a.rect.bottom) <= touching &&
            overlaps(a.rect.left, a.rect.right, b.rect.left, b.rect.right)
          ) {
            gaps.push(b.rect.top + b.top - (a.rect.bottom - a.bottom));
          }
          // b sits directly to the right of a.
          if (
            Math.abs(b.rect.left - a.rect.right) <= touching &&
            overlaps(a.rect.top, a.rect.bottom, b.rect.top, b.rect.bottom)
          ) {
            gaps.push(b.rect.left + b.left - (a.rect.right - a.right));
          }
        }
      }

      /*
       * `--s4` as this wall resolves it, from a probe in the layout itself.
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
      probe.style.height = 'var(--s4)';
      canvas.appendChild(probe);
      const s4 = probe.getBoundingClientRect().height;
      probe.remove();

      return { gaps, s4, boxes: boxes.length };
    },
    { touching: TOUCHING_PX },
  );
}

/** Every measurement here is about pairs, so a wall with none proves nothing. */
function expectATiledWall(measured: GutterMeasurement): void {
  expect(measured.boxes, 'the Classic seed drew no widgets').toBeGreaterThan(2);
  expect(
    measured.gaps.length,
    'no two boxes on this wall share an edge, so there is no gutter to measure',
  ).toBeGreaterThan(2);
  expect(measured.s4, '--s4 resolved to nothing on this wall').toBeGreaterThan(1);
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
    expect(values).toEqual(['0', '1', '2', '3', '4']);
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

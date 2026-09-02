/**
 * The wall's geometry does not depend on when its webfonts arrive.
 *
 * **This file used to be about a fit, and what it was about is now impossible.**
 * `fitToBox` measured its section as it appended it and wrote a `scale()` that
 * nothing recomputed; the faces are `font-display: swap`, so a paint arriving
 * before the font measured *fallback* metrics and the wall kept that
 * arithmetic. Measured on the 1080x1920 Classic wall this file drives, the
 * agenda was **812px** tall on the fallback and **816px** with the real face,
 * against an available height of 532.24 — so the fit landed on
 * `532.24/812 = 0.655468` instead of `532.24/816 = 0.652255`. Half a percent
 * too large, permanently, on a section whose box is `overflow: hidden`, so the
 * bottom row clipped and nothing on the wall said why. It was found as a flake
 * rather than as a bug: `browser-empty-bands` compares two templates measured
 * seconds apart, either of which can lose the race, and it failed about one run
 * in thirty with the *baseline* reading larger. The flake rate was the bug
 * rate, as it was in `redact.test.ts`.
 *
 * There is no fit any more. A section is drawn at its role's own size and the
 * box picks a form, so nothing is measured once and kept — which means the
 * class of fault this file was written for cannot recur, and asserting that a
 * scale converges would be asserting the behaviour of a deleted function.
 *
 * **So the invariant is the one that replaced it: the wall's geometry is
 * identical whether or not the fonts have arrived.** Every widget box, every
 * month cell, every day row, to the pixel. Content is deliberately *not* part
 * of that claim and cannot be — a month cell's density tier is read from the
 * measured advance of the face it is drawing in, so a cold wall may name a
 * different number of cells until the next tick. That is a form chosen from
 * live metrics and corrected from live metrics, not a number kept against
 * metrics that have since changed, and the difference is the whole of this
 * change.
 *
 * **The control is the same page, and that is a deliberate correction of this
 * file's own recorded mistake.** Its first draft compared a raced context
 * against a "load it normally and measure" baseline — taken on a cold context
 * whose fonts are also fetched over the network, so the control lost the same
 * race it existed to be a control for and read correctly only *because the fix
 * was applied*. Reverting the fix turned the file red on its premise instead of
 * its conclusion. Here there is no second context to be wrong: the two readings
 * are the same page, the same viewport and the same manifest, with exactly one
 * variable between them — whether the face has landed.
 *
 * Two things make it measurable at all, and both are asserted rather than
 * assumed:
 *
 *  - **The race is forced, not waited for.** The font responses are delayed on
 *    a cold context, so the first reading is guaranteed to be taken on the
 *    fallback. Waiting for a one-in-thirty coincidence is not a test.
 *  - **The fonts really did change something.** The advance of a fixed specimen
 *    is measured on both readings and must differ, or this file can no longer
 *    see the thing it exists for — on a machine whose fallback happens to match
 *    the bundled face, every geometry assertion below would pass having proved
 *    nothing. It is also the assertion that fails if somebody "fixes" a font
 *    problem by removing `font-display: swap`, which is a different change with
 *    different consequences and should not pass quietly here.
 *
 * And the window is asserted too: the wall redraws unconditionally every 15
 * seconds, so a second reading taken after a tick would be a reading of a
 * different draw rather than of the same one with the fonts in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  shutDownBrowser,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { applyTemplate } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';

process.env['TZ'] = 'UTC';

const SLOW = 180_000;

/** Long enough that the first reading certainly lands on the fallback face. */
const FONT_DELAY_MS = 3_000;

/**
 * The wall's own redraw interval (`TICK_MS` in `apps/display/src/main.ts`).
 *
 * Not imported — the display bundle is compiled with its own `rootDir` and a
 * server test cannot import from it. Transcribed, and both readings below are
 * asserted to land inside it, so a drift in either direction shows up here as a
 * failure rather than as a test that quietly stopped proving anything.
 */
const WALL_TICK_MS = 15_000;

/**
 * One ordinary family calendar, spread across six days.
 *
 * The agenda's height is mostly its day headers, so a spread feed is the shape
 * whose geometry actually moves when anything about the type changes. Bunched
 * onto three days it fits with room to spare and every arrangement measures the
 * same, which is a fixture that cannot see this.
 */
const CALENDARS: readonly NamedFeed[] = [
  {
    name: 'Family',
    events: [
      { title: 'Bin day', day: 2 },
      { title: "Grandma's 80th birthday", day: 4 },
      { title: 'Dentist', day: 1, from: '0900', to: '1000' },
      { title: 'Swimming lesson', day: 0, from: '0730', to: '0830' },
      { title: 'Car service', day: 6, from: '0800', to: '1200' },
    ],
  },
];

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: CALENDARS });
  /*
   * A location and a rota, so the forecast strip and the rota badge are on the
   * wall at all — `keepWidgetsWithSomethingToSay` drops a widget a household
   * has nothing behind, and a Classic canvas with three boxes on it cannot say
   * whether a strip of forecast columns moved.
   */
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');
  const screen = (wall.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;
  applyTemplate(wall.db, screen, classicFor({ modules: ['weather'], shift: true }));
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * Everything about the wall that is a *rectangle*, plus two witnesses.
 *
 * Rounded to hundredths rather than compared raw: a browser reports layout to
 * sub-pixel precision and two identical layouts can differ in the twelfth
 * decimal on a re-measure. A hundredth of a CSS pixel is finer than anything on
 * a wall and coarse enough that the comparison is about the layout.
 *
 * `advance` is the specimen witness — the width of a fixed string in the date
 * numeral's face, which is the premise this file rests on. It is measured in
 * `.dr-num` and **deliberately not in `.dr-ev-title`**: the event title is
 * `--f-sans`, which is `system-ui` and a stack of names the device already has,
 * so it measures identically before and after the download and would make this
 * witness read "no race" on a wall that is plainly having one. `--disp` is a
 * bundled face — measured, the same specimen is 1138px on the fallback and
 * 799px once it lands. `scale` is the structural witness: the cumulative
 * transform above the agenda's label, which is what `fitToBox` used to write
 * and which must now be exactly 1 in every reading.
 */
const MEASURE = `(() => {
  const round = (n) => Math.round(n * 100) / 100;
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return [round(box.x), round(box.y), round(box.width), round(box.height)].join(' ');
  };
  const shown = (node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const all = (selector) =>
    [...document.querySelectorAll('#wall .canvas ' + selector)].filter(shown).map(rect);

  let scale = 1;
  const label = document.querySelector('#wall .canvas .section-label');
  for (let node = label; node !== null; node = node.parentElement) {
    const matched = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(node).transform);
    if (matched === null) continue;
    const n = matched[1].split(',').map(Number);
    const determinant = Math.abs(n[0] * n[3] - n[1] * n[2]);
    if (determinant > 0) scale *= Math.sqrt(determinant);
  }

  let advance = 0;
  const host = document.querySelector('#wall .canvas .dr-num');
  if (host !== null) {
    const probe = document.createElement('span');
    probe.className = 'dr-num';
    probe.textContent = 'The quick brown fox jumps over the lazy dog';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.display = 'inline-block';
    host.appendChild(probe);
    advance = round(probe.offsetWidth);
    probe.remove();
  }

  return {
    boxes: all('.fw'),
    cells: all('.hz-cell'),
    days: all('.day-row'),
    columns: all('.wx-day'),
    scale: round(scale),
    advance,
  };
})()`;

interface Geometry {
  readonly boxes: readonly string[];
  readonly cells: readonly string[];
  readonly days: readonly string[];
  readonly columns: readonly string[];
  readonly scale: number;
  readonly advance: number;
}

async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
  const page: Page = await context.newPage();
  try {
    return await work(page);
  } finally {
    await context.close();
  }
}

describe('a wall whose first paint beats its webfonts', () => {
  it(
    'draws the same geometry before and after the face arrives',
    async () => {
      const raced = await withPage(async (page) => {
        // A cold context, so the fonts are really fetched and the route bites.
        // On a reload they come from cache and never reach it.
        await page.route('**/assets/fonts/**', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, FONT_DELAY_MS));
          await route.continue();
        });
        await page.goto(link, { waitUntil: 'commit' });
        await page.waitForSelector('#wall .canvas .day-row', { timeout: 30_000 });
        const paintedAt = Date.now();

        // The wall as the household first sees it: drawn, with the real face
        // still in flight.
        await page.waitForTimeout(300);
        const onFallback = (await page.evaluate(MEASURE)) as Geometry;

        // And once the face has landed, on the same page and the same draw.
        await page.evaluate(() => {
          const set = (document as unknown as { readonly fonts?: { readonly ready?: Promise<unknown> } }).fonts;
          return set?.ready === undefined ? undefined : set.ready.then(() => undefined);
        });
        await page.waitForTimeout(500);
        const afterFonts = (await page.evaluate(MEASURE)) as Geometry;

        return { onFallback, afterFonts, elapsed: Date.now() - paintedAt };
      });

      /*
       * There is a wall to measure at all. Without this every identity below
       * would hold trivially on two empty lists, which is the shape of assertion
       * this project keeps finding it cannot turn red.
       */
      expect(raced.onFallback.boxes.length, 'no widget boxes were drawn').toBeGreaterThan(4);
      expect(raced.onFallback.cells.length, 'no month cells were drawn').toBeGreaterThan(27);
      expect(raced.onFallback.days.length, 'no agenda days were drawn').toBeGreaterThan(0);
      expect(raced.onFallback.columns.length, 'no forecast columns were drawn').toBeGreaterThan(0);

      /*
       * The premise: the face really did land, and it really does measure
       * differently from the fallback. If these ever read alike this file can no
       * longer see what it exists for and says so rather than passing.
       */
      expect(raced.onFallback.advance, 'no specimen was measurable').toBeGreaterThan(0);
      expect(
        raced.afterFonts.advance,
        `the fallback and the bundled face measure the same specimen at ` +
          `${raced.onFallback.advance}px; this test can no longer see a font race`,
      ).not.toBe(raced.onFallback.advance);

      /*
       * The structural half, and the reason the rest of this file could be
       * rewritten rather than deleted: there is no scale to keep. `fitToBox`
       * wrote one here and every fault this file records followed from it.
       */
      expect(raced.onFallback.scale, 'a laid-out section carries a transform').toBe(1);
      expect(raced.afterFonts.scale, 'a laid-out section carries a transform').toBe(1);

      /*
       * The invariant. One page, one draw, one variable — the face — and every
       * rectangle on the wall identical across it.
       */
      expect(raced.afterFonts.boxes, 'a widget box moved when the face landed').toEqual(
        raced.onFallback.boxes,
      );
      expect(raced.afterFonts.cells, 'a month cell moved when the face landed').toEqual(
        raced.onFallback.cells,
      );
      expect(raced.afterFonts.days, 'an agenda day moved when the face landed').toEqual(
        raced.onFallback.days,
      );
      expect(raced.afterFonts.columns, 'a forecast column moved when the face landed').toEqual(
        raced.onFallback.columns,
      );

      /*
       * And both readings are of the same draw. The wall redraws unconditionally
       * every 15 seconds, so a second reading past that would be comparing two
       * different draws — which would pass whatever the fonts did.
       */
      expect(
        raced.elapsed,
        `both readings must land inside one ${WALL_TICK_MS}ms wall tick, or they are ` +
          `readings of two different draws; it took ${raced.elapsed}ms`,
      ).toBeLessThan(WALL_TICK_MS);
    },
    SLOW,
  );
});

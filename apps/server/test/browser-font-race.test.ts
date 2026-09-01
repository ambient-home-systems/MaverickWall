/**
 * The fit a wall keeps when the first paint beats the webfont.
 *
 * `fitToBox` measures its section as it appends it and writes a `scale()` that
 * nothing recomputes. The faces are `font-display: swap`, so a paint that
 * arrives before the font measures *fallback* metrics and the wall keeps that
 * arithmetic. Measured on the 1080x1920 Classic wall this file drives: the
 * agenda is **812px** tall on the fallback and **816px** with the real face,
 * against an available height of 532.24 — so the fit lands on `532.24/812 =
 * 0.655468` instead of `532.24/816 = 0.652255`. Half a percent too large,
 * permanently, on a section whose box is `overflow: hidden`, so the bottom row
 * clips and nothing on the wall says why.
 *
 * It was found as a flake rather than as a bug: `browser-empty-bands` compares
 * two templates measured seconds apart, either of which can lose the race, and
 * it failed about one run in thirty with the *baseline* reading larger. The
 * flake rate was the bug rate — this project has been here before, with
 * `redact.test.ts`.
 *
 * Two things make this measurable at all, and both are why the assertions read
 * the way they do:
 *
 *  - **The race is forced, not waited for.** The font responses are delayed on
 *    a cold context, so the first draw is guaranteed to measure the fallback.
 *    Waiting for a one-in-thirty coincidence is not a test.
 *  - **The window is asserted, not assumed.** The wall redraws unconditionally
 *    every 15 seconds and that tick corrects the fit on its own, so a
 *    measurement taken late would pass with the fix reverted. Every reading
 *    here is taken well inside one tick, and the elapsed time is asserted.
 *
 * The comparison is against the same wall loaded with the fonts already in
 * hand, rather than against `0.652255` written down — a literal would go stale
 * the first time anybody touches the template, and would pass for the wrong
 * reason on a machine whose fallback happens to match.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  settleWall,
  shutDownBrowser,
  type Installation,
  type NamedFeed,
} from './browser-harness.js';
import { applyTemplate } from '../src/api/templates.js';
import { classicFor } from '../src/templates/classic.js';

process.env['TZ'] = 'UTC';

const SLOW = 180_000;

/** Long enough that the first draw certainly measures the fallback face. */
const FONT_DELAY_MS = 3_000;

/**
 * The wall's own redraw interval (`TICK_MS` in `apps/display/src/main.ts`).
 *
 * Not imported — the display bundle is compiled with its own `rootDir` and a
 * server test cannot import from it. Transcribed, and the readings below are
 * asserted to land inside it, so a drift in either direction shows up here as
 * a failure rather than as a test that quietly stopped proving anything.
 */
const WALL_TICK_MS = 15_000;

/**
 * One ordinary family calendar, spread across six days.
 *
 * The agenda's height is mostly its day headers, so a spread feed is the shape
 * whose height actually moves when the metrics change. Bunched onto three days
 * it fits with room to spare and the fallback and the real face measure the
 * same, which is a fixture that cannot see this bug.
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
  link = await wall.pairLink('Kitchen');
  const screen = (wall.db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;
  applyTemplate(wall.db, screen, classicFor({ modules: ['weather'], shift: true }));
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * The cumulative transform above the agenda's label — what `fitToBox` decided.
 *
 * Read off the computed style rather than off a class or an inline attribute:
 * the scale is the thing that is wrong, and this project has shipped a bug
 * where the class was right and the pixels were not.
 */
const AGENDA_SCALE = `(() => {
  const label = document.querySelector('.canvas .section-label');
  if (label === null) return -1;
  let scale = 1;
  for (let node = label; node !== null; node = node.parentElement) {
    const matched = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(node).transform);
    if (matched === null) continue;
    const n = matched[1].split(',').map(Number);
    const determinant = Math.abs(n[0] * n[3] - n[1] * n[2]);
    if (determinant > 0) scale *= Math.sqrt(determinant);
  }
  return scale;
})()`;

async function withPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
  const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
  const page: Page = await context.newPage();
  try {
    return await work(page);
  } finally {
    await context.close();
  }
}

describe('a wall whose first paint beat its webfonts', () => {
  it(
    'settles on the same fit as a wall that had the fonts in hand',
    async () => {
      /*
       * The converged fit: what this wall settles on once the fonts are in
       * *and* a redraw has happened with them in.
       *
       * Deliberately taken after a full tick, and that is the whole
       * correctness of this test. The obvious baseline — load, `settleWall`,
       * read — is measured on a cold context whose fonts are also fetched over
       * the network, so it loses the same race it is supposed to be the
       * control for. It happens to read correctly *with the fix applied*,
       * which makes it a baseline that moves when the thing under test moves:
       * reverting the fix turned this file red on its own premise rather than
       * on its conclusion. A value the wall reaches unaided is the only
       * baseline the fix cannot flatter.
       */
      const settled = await withPage(async (page) => {
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        await page.waitForTimeout(WALL_TICK_MS + 1_000);
        return (await page.evaluate(AGENDA_SCALE)) as number;
      });
      expect(settled, 'the agenda should be scaled at all').toBeGreaterThan(0);

      const raced = await withPage(async (page) => {
        // A cold context, so the fonts are really fetched and the route bites.
        // On a reload they come from cache and never reach it — which is why
        // `browser-empty-bands`' hold-and-reload narrows this window without
        // closing it.
        await page.route('**/assets/fonts/**', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, FONT_DELAY_MS));
          await route.continue();
        });
        await page.goto(link, { waitUntil: 'commit' });
        await page.waitForSelector('#wall .canvas', { timeout: 30_000 });
        const paintedAt = Date.now();

        // The wall as the household first sees it: drawn, with the real face
        // still in flight.
        await page.waitForTimeout(300);
        const onFallback = (await page.evaluate(AGENDA_SCALE)) as number;

        // And after the face lands. This is the reading the fix changes.
        await page.evaluate(() => {
          const set = (document as unknown as { readonly fonts?: { readonly ready?: Promise<unknown> } }).fonts;
          return set?.ready === undefined ? undefined : set.ready.then(() => undefined);
        });
        await page.waitForTimeout(500);
        const afterFonts = (await page.evaluate(AGENDA_SCALE)) as number;

        return { onFallback, afterFonts, elapsed: Date.now() - paintedAt };
      });

      /*
       * The premise, asserted rather than assumed: the fallback really does
       * produce a different fit. Without this the test could pass on a machine
       * where the two faces measure alike, having proved nothing — and it is
       * the assertion that fails if somebody "fixes" this by removing
       * `font-display: swap`, which would be a different change with different
       * consequences and should not pass silently here.
       */
      expect(
        raced.onFallback,
        `the fallback fit (${raced.onFallback}) should differ from the settled fit (${settled}); ` +
          'if it does not, this test can no longer see the bug it exists for',
      ).not.toBeCloseTo(settled, 5);

      /*
       * The fix. Reverted, this reads the fallback's fit — the wall keeps
       * arithmetic taken against metrics that are no longer on screen.
       */
      expect(
        raced.afterFonts,
        `the agenda is scaled ${raced.afterFonts} after the fonts arrived, ` +
          `against ${settled} on a wall that had them; it was ${raced.onFallback} on the fallback`,
      ).toBeCloseTo(settled, 5);

      /*
       * And it was the fonts that fixed it, not the clock. The wall's own
       * 15-second redraw corrects this fit unaided, so a reading taken after
       * one tick passes with the fix removed and proves nothing at all.
       */
      expect(
        raced.elapsed,
        `the reading must land inside one ${WALL_TICK_MS}ms wall tick, or the tick ` +
          `is what corrected the fit; it took ${raced.elapsed}ms`,
      ).toBeLessThan(WALL_TICK_MS);
    },
    SLOW,
  );
});

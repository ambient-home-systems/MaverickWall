/**
 * The last link in the chain, and the only one a unit test cannot reach.
 *
 * `orientation.test.ts` proves the arithmetic and `wall-editor.test.ts` proves
 * the form reaches `/d/manifest`. What neither can see is whether the wall ever
 * *asks*: `main.ts` calls `pxPerArcminute` through `geometryFor` and writes the
 * answer onto the root, and a one-line wiring slip there is precisely the class
 * of fault this project keeps finding — the `autofocus` that did nothing, the
 * dead landscape column rule, the setting two renderers read opposite ways.
 * There is no DOM in the display's test suite, so a real browser is the only
 * place to ask.
 *
 * It also pins the branch that is easy to leave out: a measurement taken *back*
 * has to remove the property, not merely stop updating it. A wall redraws every
 * fifteen seconds and reloads rarely, so a stale value would outlive the setting
 * by months.
 *
 * **Checking this one by breaking its fix needs a rebuild**, which is worth
 * saying because the first attempt did not and proved nothing: the server
 * serves `apps/display/dist`, so vitest's on-the-fly transpiling never touches
 * the bundle under test and both mutations sailed through green. That is
 * `pnpm test`'s own "vitest only transpiles" note one layer along — here it is
 * not a dependency's declarations that go unresolved but the whole subject of
 * the test. Run `pnpm --filter @maverick-wall/display build` between the edit
 * and the run, or the red you are looking for cannot appear.
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
} from './browser-harness.js';

const SLOW = 60_000;

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install();
  link = await wall.pairLink('Kitchen');
  screenId = (
    wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }
  ).id;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** A 32" television hung portrait: 708mm of picture down the wall. */
function measure(widthMm: number | null, heightMm: number | null, distanceMm: number | null): void {
  wall.db
    .prepare(
      `UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ?
        WHERE id = ?`,
    )
    .run(widthMm, heightMm, distanceMm, screenId);
}

/**
 * What the page believes, read off the root — plus the frame it measured
 * against, so a failure says which half is wrong rather than only that a number
 * differs.
 */
async function readRoot(page: Page): Promise<{
  readonly pxArcmin: string;
  readonly innerHeight: number;
  readonly innerWidth: number;
}> {
  await settleWall(page);
  return page.evaluate(() => ({
    // The inline style, which is what `applyGeometry` writes — a computed read
    // would not tell a property that was never set from one set to ''.
    pxArcmin: document.documentElement.style.getPropertyValue('--px-arcmin'),
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
  }));
}

describe('a wall that has been measured', () => {
  it('derives its own arc-minute from the facts, and forgets it when they go', async () => {
    const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
    const page = await context.newPage();
    try {
      // 1. Nothing measured: the property is not there at all, which is every
      //    household who never opens the setting.
      await page.goto(link, { waitUntil: 'load' });
      expect((await readRoot(page)).pxArcmin).toBe('');

      // 2. Measured. The expectation is computed from the frame the page
      //    actually got rather than from the viewport this test asked for —
      //    a scrollbar or a chrome inset would otherwise read as a broken
      //    derivation.
      measure(398, 708, 1200);
      await page.reload({ waitUntil: 'load' });
      const measured = await readRoot(page);
      const expected = (1200 * (Math.PI / 10_800)) / (708 / measured.innerHeight);
      expect(Number(measured.pxArcmin)).toBeCloseTo(expected, 6);
      // And it is the number the design argument is made from, not a
      // coincidence of this viewport.
      expect(Number(measured.pxArcmin)).toBeCloseTo(0.9466, 3);

      // 3. Taken back. Removed rather than left stale: the wall redraws every
      //    fifteen seconds and reloads once in months.
      measure(null, null, null);
      await page.reload({ waitUntil: 'load' });
      expect((await readRoot(page)).pxArcmin).toBe('');
    } finally {
      await context.close();
    }
  }, SLOW);
});

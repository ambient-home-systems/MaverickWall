/**
 * The wall editor's canvas is the size of the room it has, whenever it gets it.
 *
 * The report: "when you first open a browser display, the layout section in the
 * middle is very tiny, but if you resize the window at all it fills in the space
 * and is much bigger like it should be."
 *
 * The mechanism is two modules and one `localStorage` key. `sizeCanvas()` reads
 * `stage.clientWidth`, and a `display:none` stage reports 0 — so the `|| 360`
 * fallback runs and the canvas is laid out for a stage a third of the real one.
 * `display-editor.ts` restores the Layout/Wall-settings tab this browser last
 * left off on, and it runs *before* `layout-editor.ts`; so for every household
 * who has ever looked at Wall settings, the editor boots against a hidden pane.
 * Switching back to Layout un-hides it and nothing recomputed, so the canvas
 * stayed a third of its size until the window happened to be resized.
 *
 * Measured on a 1440px window before the fix: a 992px stage drew a 328x583
 * canvas where it draws 477x848.
 *
 * The control is deliberately **the same page opened the ordinary way**, rather
 * than a number written down here. An absolute floor passes just as happily on
 * a canvas that is the wrong size for some other reason, and this project has
 * shipped that mistake; "these two routes into the same editor agree" is the
 * actual claim, and it is one the fix cannot flatter.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

process.env['TZ'] = 'UTC';

/** Long: each case boots a server, a browser context and the editor twice. */
const SLOW = 60_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** The canvas and the stage it is sized against, as the browser lays them out. */
interface Measured {
  readonly canvasW: number;
  readonly canvasH: number;
  readonly stageW: number;
}

const measure = (page: Page): Promise<Measured> =>
  page.evaluate(() => {
    const canvas = document.querySelector('.le-canvas')?.getBoundingClientRect();
    const stage = document.querySelector('.le-stage');
    return {
      canvasW: Math.round(canvas?.width ?? 0),
      canvasH: Math.round(canvas?.height ?? 0),
      stageW: Math.round(stage?.clientWidth ?? 0),
    };
  });

/**
 * Open a wall's editor with the mode this browser "last left off on" already
 * stored, the way a returning household arrives.
 *
 * The value is planted from an init script rather than by clicking through the
 * tabs first, because what is under test is the *boot*: the editor has to be
 * mounted against a stage that is `display:none` at the moment it first
 * measures, and only a page that loads with the key already set does that.
 */
async function openEditor(
  wall: Installation,
  page: Page,
  wallId: string,
  storedMode: 'layout' | 'settings',
): Promise<void> {
  await wall.signIn(page);
  await page.addInitScript((mode) => {
    try {
      localStorage.setItem('mw-wall-mode', mode as string);
    } catch {
      // A browser with storage disabled simply forgets, as the editor allows.
    }
  }, storedMode);
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(wallId)}`, { waitUntil: 'load' });
  /*
   * Attached, not visible: arriving on Wall settings the whole Layout pane is
   * `display:none`, so its boxes are built and unseen — which is the state
   * under test, and waiting for one to be *visible* would time out on exactly
   * the case this file exists for.
   */
  await page.waitForSelector('.le-overlay .le-widget', { state: 'attached', timeout: 20_000 });
}

describe('the layout canvas fills its stage however the editor was reached', () => {
  it(
    'is the same size arriving on Wall settings as arriving on Layout',
    async () => {
      const wall = await install();
      installations.push(wall);
      const wallId = await wall.pairWall('Editor wall');
      const context = await (await browser()).newContext({
        viewport: { width: 1440, height: 1000 },
      });
      try {
        // The control: the ordinary route, with the Layout pane on screen from
        // the first paint.
        const straight = await context.newPage();
        await openEditor(wall, straight, wallId, 'layout');
        const wanted = await measure(straight);
        // The premise, so a canvas that is tiny in *both* cannot pass this file.
        expect(
          wanted.canvasW,
          'the control canvas is not filling its stage either, so this test is ' +
            'measuring something other than the fault it was written for',
        ).toBeGreaterThan(wanted.stageW * 0.4);

        // The reported route: the editor boots with its own pane hidden, and
        // the household then taps Layout.
        const returning = await context.newPage();
        await openEditor(wall, returning, wallId, 'settings');
        await returning.waitForSelector('[data-mode-panel="settings"]:not([hidden])');
        await returning.click('[data-mode="layout"]');
        await returning.waitForSelector('[data-mode-panel="layout"]:not([hidden])');
        // A frame for the observer to deliver on; not a settle-by-polling.
        await returning.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const seen = await measure(returning);

        expect(seen.stageW, 'the two routes must be measured against one stage').toBe(
          wanted.stageW,
        );
        expect(
          seen.canvasW,
          `the canvas is ${seen.canvasW}x${seen.canvasH} in a ${seen.stageW}px stage, ` +
            `where opening straight onto Layout draws ${wanted.canvasW}x${wanted.canvasH}`,
        ).toBe(wanted.canvasW);
        expect(seen.canvasH).toBe(wanted.canvasH);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /*
   * And it keeps following the stage afterwards.
   *
   * The old behaviour was corrected by a window resize, so a test that resized
   * the window would pass with the fix removed. This one narrows the *stage*
   * with the window untouched — the inspector column arriving, a scrollbar, a
   * settings pane taking its share — which is the case a `resize` listener
   * cannot see at all.
   *
   * The claim is the **aspect ratio**, not the width, and the difference is the
   * whole test. The canvas is a flex item, so a narrowed stage squeezes its
   * rendered width whether or not anything recomputed — a first draft asserted
   * that and was green with the fix deleted. What only `sizeCanvas()` can do is
   * bring the *height* with it: without it the canvas keeps the inline height it
   * was given for a stage twice as wide, and a 9:16 wall is drawn at 4:7.
   */
  it(
    'keeps the wall’s shape when the stage narrows and the window does not',
    async () => {
      const wall = await install();
      installations.push(wall);
      const wallId = await wall.pairWall('Editor wall');
      const context = await (await browser()).newContext({
        viewport: { width: 1440, height: 1000 },
      });
      try {
        const page = await context.newPage();
        await openEditor(wall, page, wallId, 'layout');
        const before = await measure(page);
        const shape = before.canvasW / before.canvasH;

        await page.evaluate(() => {
          const stage = document.querySelector<HTMLElement>('.le-stage');
          if (stage !== null) stage.style.maxWidth = '320px';
        });
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
        );
        const after = await measure(page);

        expect(after.stageW, 'the stage did not actually narrow').toBeLessThan(before.stageW);
        expect(after.canvasW, 'the canvas did not follow the stage in').toBeLessThan(
          before.canvasW,
        );
        expect(
          after.canvasW / after.canvasH,
          `the canvas is ${after.canvasW}x${after.canvasH} — ` +
            `${(after.canvasW / after.canvasH).toFixed(3)} where the wall is ` +
            `${shape.toFixed(3)}, so its height was left behind`,
        ).toBeCloseTo(shape, 2);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

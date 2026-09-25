/**
 * The countdown's `page` look — a tear-off calendar page — measured on a real
 * wall (plan item P5.2).
 *
 * The shipped Classic wall with three family calendars, its forecast's box
 * made a countdown, at 1080x1920 and 1920x1080, on a wall nobody has measured
 * and on one set to a 32" television read from 1.2 metres:
 *
 *  1. **A form from the box, and nothing cut.** In Classic's own box, the same
 *     box grown to hold the whole page, and a narrow column: every run and
 *     picture inside the box, no `nowrap` run cut, the belt with nothing to
 *     do — which is what says `PAGE_TIERS` was measured right rather than
 *     rescued — the parts on the glass exactly the parts the tier names, and
 *     every figure `tabular-nums` as computed.
 *  2. **Roles, not the box.** On the measured wall the label is the lede and
 *     the unit and the date the scaffold, to the px the page resolves them to.
 *  3. **One large reading, capped (D1).** The count is never more than 1.8
 *     times the lede, at three sizes on both walls — and in a box with room it
 *     *is* the clock's role, so the cap is what binds rather than luck.
 *  4. **It tears off once, at midnight.** Loaded twenty seconds before
 *     midnight with the server cut off: nothing tears on the load or on the
 *     ticks before; the first draw after midnight lifts yesterday's page away
 *     over today's, under the scoped keyframes; the tick after draws today's
 *     page with nothing over it.
 *  5. **On the day it says "Today!"** with its popper, where the count goes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, instantAt, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  RATIO_SIZES,
  SIZES,
  WALLS,
  ZONE,
  civilDate,
  countdownWall,
  fontSizeIn,
  loadBeforeMidnight,
  measureScreen,
  motionOf,
  picturesIn,
  readCountdownBox,
  roleSizes,
  runUntil,
  setCountdown,
  wallName,
  type CountdownWall,
} from './browser-countdown-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 300_000;
const TICK = 15_000;

let cw: CountdownWall;

beforeAll(async () => {
  cw = await countdownWall();
}, SLOW);

afterAll(async () => {
  await cw?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Classic's box, the box grown to hold the whole page, and a narrow column. */
const BOXES: readonly { readonly name: string; readonly resize?: { readonly w?: number; readonly h?: number } }[] = [
  { name: "Classic's box" },
  { name: 'a tall box', resize: { w: 0.9, h: 0.45 } },
  { name: 'a narrow column', resize: { w: 0.18, h: 0.35 } },
];

async function partsOn(page: Page, id: string): Promise<string[]> {
  return page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] [data-part]`, (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['part'] ?? ''),
  );
}

describe('the page on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `takes a form from its box and cuts nothing, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(cw, preset);
          const id = cw.box[size.orientation].id;
          for (const { name, resize } of BOXES) {
            await setCountdown(
              cw,
              { variant: 'page', target: civilDate(cw.wall.now(), 345), title: 'Summer holiday', unitWords: 'sleeps' },
              resize,
            );
            const { page, close } = await loadWallSettled(cw.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${name}`;
              const box = await readCountdownBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.tier, `${where}: no tier stamped`).not.toBeNull();
              expect(box.numerals.length, `${where}: no figures drawn`).toBeGreaterThan(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');
              // What is on the glass is what the tier says, in the page's own order.
              const parts = await partsOn(page, id);
              expect([...parts].sort(), where).toEqual((box.rungs ?? '').split(' ').sort());
              expect(parts, `${where}: the count is gone`).toContain('num');
              if (name === 'a tall box') expect(box.tier, where).toBe('T2');
              // The binder keeps its height in every box: it is what makes the
              // sheet a page, and in a short box it is the count that gives way.
              const binder = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdp-binder`, (n) => ({
                height: n.getBoundingClientRect().height,
                font: parseFloat(getComputedStyle(n).fontSize),
              }));
              expect(Math.abs(binder.height - binder.font * 0.5), `${where}: the binder was squeezed to ${binder.height}px`).toBeLessThanOrEqual(1);

              if (preset !== undefined) {
                const roles = await roleSizes(page);
                expect(await fontSizeIn(page, id, '.cdp-unit'), `${where}: unit`).toBeCloseTo(roles['scaffold']!, 1);
                if (parts.includes('label')) {
                  expect(await fontSizeIn(page, id, '.cdp-label'), `${where}: label`).toBeCloseTo(roles['lede']!, 1);
                }
                if (parts.includes('date')) {
                  expect(await fontSizeIn(page, id, '.cdp-date'), `${where}: date`).toBeCloseTo(roles['scaffold']!, 1);
                }
              }
            } finally {
              await close();
            }
          }
        },
        SLOW,
      );
    }
  }
});

describe('the count is one large reading, capped against the lede (D1)', () => {
  for (const preset of WALLS) {
    it(
      `is at most 1.8 ledes at three sizes, and the clock's role where there is room, on the ${wallName(preset)} wall`,
      async () => {
        measureScreen(cw, preset);
        await setCountdown(cw, { variant: 'page', target: civilDate(cw.wall.now(), 12), title: 'Summer holiday' }, { w: 0.9, h: 0.45 });
        for (const size of RATIO_SIZES) {
          const { page, close } = await loadWallSettled(cw.link, size);
          try {
            const id = cw.box[size.orientation].id;
            const where = `${wallName(preset)} ${size.width}x${size.height}`;
            const count = (await fontSizeIn(page, id, '.cdp-num'))!;
            const lede = (await fontSizeIn(page, id, '.cdp-label'))!;
            expect(count / lede, `${where}: ${count}px over ${lede}px`).toBeLessThanOrEqual(1.8 + 1e-3);
            // …and that is the cap binding, not a box too small to reach it.
            const clock = await page.evaluate(() => {
              const probe = document.createElement('span');
              probe.style.fontSize = 'var(--t-wall-clock, calc(var(--t-event) * 1.8))';
              document.querySelector('#wall .canvas')?.appendChild(probe);
              const px = parseFloat(getComputedStyle(probe).fontSize);
              probe.remove();
              return px;
            });
            expect(count, where).toBeCloseTo(clock, 1);
          } finally {
            await close();
          }
        }
      },
      SLOW,
    );
  }
});

describe('the page tears off once, at midnight', () => {
  it(
    'tears nothing on the load, lifts yesterday away on the first draw after midnight, and nothing after',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const eve = instantAt(ZONE, 1, 0, 0) - 20_000;
      await setCountdown(cw, { variant: 'page', target: civilDate(eve, 12), title: 'Summer holiday' });
      const { page, close, toMidnight } = await loadBeforeMidnight(cw, size);
      const leaf = `#wall .canvas .fw[data-widget-id="${id}"] .cdp-leaf`;
      const count = `#wall .canvas .fw[data-widget-id="${id}"] .cdp-sheet > .cdp-num`;
      try {
        // A wall that has just been loaded has not seen a page go.
        expect(await page.$$(leaf), 'a page tore off on the load').toHaveLength(0);
        expect(await page.$eval(count, (n) => n.textContent)).toBe('12');
        // Up to three seconds before midnight, through a tick or more: nothing.
        await page.clock.runFor(Math.max(0, toMidnight() - 3_000));
        expect(await page.$$(leaf), 'a page tore off before midnight').toHaveLength(0);

        const took = await runUntil(page, leaf, 25);
        expect(took, 'no page tore off in the draw after midnight').toBeDefined();
        const torn = await page.$eval(leaf, (n) => n.querySelector('.cdp-num')?.textContent);
        expect(torn, 'the leaf is not yesterday’s page').toBe('12');
        expect(await page.$eval(count, (n) => n.textContent), 'the page under it is not today’s').toBe('11');
        expect(await motionOf(page, leaf)).toEqual({ name: 'cd-page-tear', running: 1 });

        // The tick after: today's page, and nothing tearing.
        await page.clock.runFor(TICK);
        expect(await page.$$(leaf), 'the page tore off again on the next tick').toHaveLength(0);
        expect(await page.$eval(count, (n) => n.textContent)).toBe('11');
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the day itself', () => {
  for (const size of SIZES) {
    it(
      `says "Today!" with its popper where the count goes, at ${size.width}x${size.height}`,
      async () => {
        measureScreen(cw, undefined);
        const id = cw.box[size.orientation].id;
        await setCountdown(cw, { variant: 'page', target: civilDate(cw.wall.now(), 0), title: 'Summer holiday' }, { w: 0.9, h: 0.45 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const num = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdp-sheet > .cdp-num`, (n) => ({
            text: n.textContent,
            img: n.querySelector('img')?.getAttribute('src') ?? null,
          }));
          expect(num).toEqual({ text: 'Today!', img: '/assets/emoji/party-popper.svg' });
          expect((await picturesIn(page, id)).codePoints).toEqual([]);
          const box = await readCountdownBox(page, id);
          expect(box.clipped).toEqual([]);
          expect(box.belted).toBe(0);
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }
});

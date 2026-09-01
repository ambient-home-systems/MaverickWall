/**
 * The wall's type hierarchy, measured on a real paired wall (RFC — wall type
 * hierarchy).
 *
 * Measured on a paired 1920x1080 Classic wall with three ordinary family
 * calendars, the clock drew at 137.7px and an actual event name at 31.6px —
 * 4.4x. A month cell's date numeral drew at 1.4x the event in that same cell.
 * The two largest things on the wall were the two facts a household already
 * possesses; the one thing they do not — an event — was drawn smaller than
 * either. The token changes hold two ratios: a month numeral (`.hz-num`) is at
 * most 1.2x its cell's event text (`.hz-rowtext`), and the clock (`.clock`) is
 * at most 1.8x an agenda event name (`.dr-ev-title`).
 *
 * This measures the *stylesheet's* ratio — `getComputedStyle` on each class,
 * in the live document, so the real cascade resolves every `var()` and
 * `calc()` exactly as it would for real content — rather than either of the
 * two things that would make a wrong ratio look right:
 *
 *  - a declared `font-size` read off the *source*, which would not catch a
 *    mistyped token name or a stale value nothing recomputed;
 *  - an actual rendered word's on-glass size, which depends on which box the
 *    household dragged each widget to. `fitToBox` scales a whole section
 *    independently of its neighbours, so `.clock` and `.dr-ev-title` sitting
 *    in differently-sized boxes can carry the *right* ratio in their own
 *    `font-size` and still land nowhere near it on the glass — measured, the
 *    Classic seed alone put them at 2.44x in portrait even after this file's
 *    fix. That is real and is exactly what the arc-minute scale (a later
 *    phase) exists to close; a layout change to Classic's own box sizes is
 *    explicitly out of scope here (token changes only), so this file holds
 *    the ratio this phase actually owns rather than a number no CSS-only
 *    change here could satisfy.
 *  - a real month cell's `.hz-rowtext`, which `trimCellRows` may hide
 *    entirely at a small enough box — measured, every cell on a paired
 *    1280x720 Classic wall falls back to "+N" with no event text drawn at
 *    all, which is a pre-existing fact about that template's cell size and
 *    not something this change caused (confirmed by measuring the same wall
 *    with `.hz-num` reverted to its old size — still nothing).
 *
 * Reading the cascade directly sidesteps both: a bare, undropped element with
 * the right class, appended to the live wall so it inherits the same
 * `--t-*`/`--rule` tokens a real one would, is what the stylesheet actually
 * promises for that class — independent of which box a household drags a
 * widget into and of whether this particular calendar's events happened to
 * fit a cell today.
 *
 * Three viewports, because a ratio expressed in `rem` and `calc()` has to
 * survive the wall it is measured on: the portrait design target, a landscape
 * television and the smallest wall this project measures anywhere
 * (`--t-floor`'s own 1280x720).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, settleWall, shutDownBrowser, type Installation } from './browser-harness.js';

process.env['TZ'] = 'UTC';

/** Long: this boots a server, a browser context and a paired wall. */
const SLOW = 180_000;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install();
  link = await wall.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * The cascade's own `font-size` for a class, read off a bare element planted
 * inside `.canvas` (so it inherits the same `--t-*` tokens and rem basis a
 * real widget's content would) and removed immediately after.
 */
async function stylesheetFontSize(page: Page, className: string): Promise<number> {
  return page.evaluate((cls) => {
    const canvas = document.querySelector('.canvas');
    if (canvas === null) throw new Error('no .canvas on the paired wall');
    const probe = document.createElement('div');
    probe.className = cls;
    canvas.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  }, className);
}

async function measureAt(size: { readonly width: number; readonly height: number }): Promise<{
  readonly numeralRatio: number;
  readonly clockRatio: number;
}> {
  const context = await (await browser()).newContext({ viewport: size });
  const page: Page = await context.newPage();
  try {
    await page.goto(link, { waitUntil: 'load' });
    await settleWall(page);
    const numeralPx = await stylesheetFontSize(page, 'hz-num');
    const eventPx = await stylesheetFontSize(page, 'hz-rowtext');
    const clockPx = await stylesheetFontSize(page, 'clock');
    const agendaEventPx = await stylesheetFontSize(page, 'dr-ev-title');
    return { numeralRatio: numeralPx / eventPx, clockRatio: clockPx / agendaEventPx };
  } finally {
    await context.close();
  }
}

/*
 * A whisker of slack over the exact ratio: browsers round a resolved
 * `font-size` to hundredths of a pixel independently on each side of a
 * `calc()`, so a bare `<=` would go red on rounding rather than on a real
 * regression.
 */
const SLACK = 1.001;

const VIEWPORTS: readonly { readonly label: string; readonly width: number; readonly height: number }[] = [
  { label: 'portrait (design target)', width: 1080, height: 1920 },
  { label: 'landscape television', width: 1920, height: 1080 },
  { label: 'the smallest wall this project measures', width: 1280, height: 720 },
];

describe('the type hierarchy, on a real paired wall', () => {
  for (const { label, width, height } of VIEWPORTS) {
    it(
      `holds both ratios in ${label}`,
      async () => {
        const { numeralRatio, clockRatio } = await measureAt({ width, height });
        expect(numeralRatio, `.hz-num is ${numeralRatio.toFixed(3)}x .hz-rowtext`).toBeLessThanOrEqual(
          1.2 * SLACK,
        );
        expect(clockRatio, `.clock is ${clockRatio.toFixed(3)}x .dr-ev-title`).toBeLessThanOrEqual(
          1.8 * SLACK,
        );
      },
      SLOW,
    );
  }
});

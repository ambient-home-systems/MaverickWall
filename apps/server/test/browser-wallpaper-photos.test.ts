import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { DRAWN_CATEGORIES, WALLPAPERS, type Wallpaper } from '../src/wallpapers.js';

/**
 * A bundled photograph or painting on a real wall (plan item M4.5), measured.
 *
 * Two things a photograph needs that a drawn wallpaper does not, both read off
 * the computed style of a paired wall rather than a class:
 *
 *  - **Soft is solved for it.** A drawn wallpaper was drawn to keep 4.5:1 under
 *    the Soft ground at 0.86; a painting was not, so it carries the lightest and
 *    darkest patch of its file and the wall solves the opacity from them and the
 *    theme's own inks — never below 0.86, so a photograph is never shown
 *    through more than a drawing is. The expectation is solved here, written
 *    out rather than imported, from the tokens the canvas computes: an
 *    expectation computed by the code under test agrees with it whatever it does.
 *  - **Each orientation has its own focal point**, because a 3:2 painting cropped
 *    to a portrait wall loses its sides and a landscape one its top and bottom.
 *
 * And a drawn wallpaper is held to what it drew before: no `--soft-alpha`, the
 * ground at 0.86. Last, the picker: a picture under CC BY shows the credit its
 * licence asks for on its tile, where a household chooses it.
 */

process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const PORTRAIT = { width: 1080, height: 1920 } as const;
const LANDSCAPE = { width: 1920, height: 1080 } as const;
const SOFT = 0.86;
const MARGIN = 3;

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const linear = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (panel: Rgb, alpha: number, patch: Rgb): Rgb =>
  [0, 1, 2].map((i) => alpha * (panel[i] ?? 0) + (1 - alpha) * (patch[i] ?? 0)) as unknown as Rgb;

/** `max(0.86, the lowest hundredth at which both inks keep 4.5:1 over both widened patches)`. */
function expectedSoft(panel: string, inks: readonly string[], soft: { light: string; dark: string }): number {
  const patches = [hex(soft.light).map((v) => Math.min(255, v + MARGIN)), hex(soft.dark).map((v) => Math.max(0, v - MARGIN))] as unknown as Rgb[];
  const card = hex(panel);
  for (let step = 0; step <= 100; step++) {
    const alpha = step / 100;
    if (patches.every((patch) => inks.every((ink) => contrast(hex(ink), over(card, alpha, patch)) >= 4.5))) return Math.max(SOFT, alpha);
  }
  return 1;
}

const PHOTOS = WALLPAPERS.filter((w) => !DRAWN_CATEGORIES.includes(w.category));

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
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

function wear(theme: string, wallpaper: string): void {
  const json = JSON.stringify({ type: 'wallpaper', id: wallpaper });
  wall.db
    .prepare('UPDATE screens SET theme = ?, layout_background = ?, layout_landscape_background = ?, widget_ground = NULL WHERE id = ?')
    .run(theme, json, json, screenId);
}

interface Reading {
  readonly softAlpha: string;
  readonly opacity: string;
  readonly position: string;
  readonly panel: string;
  readonly inks: readonly string[];
}

/** The canvas's tokens and `--soft-alpha`, a leaf's ground opacity, and the picture's position. */
function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('.canvas');
    const leaf = document.querySelector<HTMLElement>('.canvas .fw.has-ground');
    if (canvas === null || leaf === null) throw new Error('no canvas, or no widget with a ground');
    const style = getComputedStyle(canvas);
    // The tokens as hex, through a probe: `getPropertyValue` answers the token stream.
    const resolve = (name: string): string => {
      const probe = document.createElement('i');
      probe.style.color = `var(${name})`;
      canvas.appendChild(probe);
      const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? [];
      probe.remove();
      return `#${rgb.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    };
    return {
      softAlpha: style.getPropertyValue('--soft-alpha').trim(),
      opacity: getComputedStyle(leaf, '::before').opacity,
      position: style.backgroundPosition,
      panel: resolve('--panel'),
      inks: [resolve('--ink'), resolve('--ink-scaffold')],
    };
  });
}

/** The photograph of `tone` that `theme` needs the most Soft for — the one where 0.86 would fail. */
function hardest(tone: 'light' | 'dark', reading: Reading): { photo: Wallpaper; alpha: number } {
  const ranked = PHOTOS.filter((w) => w.tone === tone)
    .map((photo) => ({ photo, alpha: expectedSoft(reading.panel, reading.inks, photo.soft!) }))
    .sort((a, b) => b.alpha - a.alpha);
  return ranked[0]!;
}

describe('a photograph under the Soft ground', () => {
  for (const [theme, tone] of [
    ['panels', 'dark'],
    ['household', 'light'],
  ] as const) {
    it(
      `is solved from its own patches on ${theme}, and never below 0.86`,
      async () => {
        // The theme's tokens, read once with any photograph of its tone up.
        wear(theme, PHOTOS.find((w) => w.tone === tone)!.id);
        const first = await loadWallSettled(link, LANDSCAPE);
        const tokens = await read(first.page);
        await first.close();

        const { photo, alpha } = hardest(tone, tokens);
        // The premise: this picture needs more than a drawing gets, so 0.86 would be wrong.
        expect(alpha, `${photo.id} on ${theme} needs no more than 0.86, so this cannot tell`).toBeGreaterThan(SOFT);

        wear(theme, photo.id);
        const { page, close } = await loadWallSettled(link, LANDSCAPE);
        try {
          const reading = await read(page);
          expect(Number(reading.softAlpha), `${photo.id} on ${theme}: --soft-alpha`).toBeCloseTo(alpha, 5);
          expect(Number(reading.opacity), `${photo.id} on ${theme}: the ground's computed opacity`).toBeCloseTo(alpha, 5);
        } finally {
          await close();
        }

        // And a photograph that needs less still gets 0.86, not its own lower answer.
        const easiest = PHOTOS.filter((w) => w.tone === tone)
          .map((one) => ({ one, solved: expectedSoft(tokens.panel, tokens.inks, one.soft!) }))
          .sort((a, b) => a.solved - b.solved)[0]!;
        wear(theme, easiest.one.id);
        const second = await loadWallSettled(link, LANDSCAPE);
        try {
          expect(Number((await read(second.page)).opacity)).toBeGreaterThanOrEqual(SOFT);
        } finally {
          await second.close();
        }
      },
      SLOW,
    );
  }

  it(
    'leaves a drawn wallpaper exactly as it was: no --soft-alpha, the ground at 0.86',
    async () => {
      wear('panels', 'dusk');
      const { page, close } = await loadWallSettled(link, LANDSCAPE);
      try {
        const reading = await read(page);
        expect(reading.softAlpha).toBe('');
        expect(Number(reading.opacity)).toBeCloseTo(SOFT, 5);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('a photograph’s focal point', () => {
  it(
    'is its portrait point on a portrait wall and its landscape point on a landscape one',
    async () => {
      const photo = PHOTOS.find((w) => w.portraitFocal !== undefined && w.portraitFocal.x !== w.focal?.x);
      expect(photo, 'no photograph names a portrait point different from its landscape one').toBeDefined();
      wear(photo!.tone === 'dark' ? 'panels' : 'household', photo!.id);
      for (const [size, point] of [
        [PORTRAIT, photo!.portraitFocal!],
        [LANDSCAPE, photo!.focal!],
      ] as const) {
        const { page, close } = await loadWallSettled(link, size);
        try {
          expect((await read(page)).position, `${photo!.id} at ${size.width}x${size.height}`).toBe(`${point.x}% ${point.y}%`);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );
});

describe('a photograph in the picker', () => {
  it(
    'shows its credit under its name: the CC BY line where the licence asks for one, the painter otherwise',
    async () => {
      wear('panels', 'dusk');
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await page.click('.le-background-btn');
        await page.selectOption('.le-bg select', 'wallpaper');
        const lines = await page.$$eval('.le-wallpapers [data-wallpaper]', (tiles) =>
          tiles.map((tile) => {
            const credit = tile.querySelector<HTMLElement>('.le-wp-credit');
            const box = credit?.getBoundingClientRect();
            const outer = tile.getBoundingClientRect();
            return {
              id: (tile as HTMLElement).dataset['wallpaper'] ?? '',
              text: credit?.textContent ?? null,
              // Drawn, and inside its tile: a credit clipped by the tile is not shown.
              shown:
                box !== undefined && box.height > 0 && box.width > 0 && box.bottom <= outer.bottom + 0.5 && box.top >= outer.top,
            };
          }),
        );
        const byId = new Map(lines.map((l) => [l.id, l]));
        const dark = WALLPAPERS.filter((w) => w.tone === 'dark');
        let ccBy = 0;
        for (const w of dark) {
          const line = byId.get(w.id);
          expect(line, `${w.id} has no tile`).toBeDefined();
          if (w.credit === undefined) {
            expect(line?.text, `${w.id} is drawn and credits nobody`).toBeNull();
          } else if (w.credit.attribution !== undefined) {
            ccBy++;
            expect(line?.text).toBe(`Credit: ${w.credit.attribution} (CC BY 4.0)`);
            expect(line?.shown, `${w.id}'s credit is not visible on its tile`).toBe(true);
          } else {
            expect(line?.text).toBe(w.credit.author);
            expect(line?.shown, `${w.id}'s painter is not visible on its tile`).toBe(true);
          }
        }
        // The premise: the dark set really has pictures whose licence asks for a credit.
        expect(ccBy).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

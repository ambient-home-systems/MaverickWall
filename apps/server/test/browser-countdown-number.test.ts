/**
 * The countdown's `number` look, and the day itself, on a real wall (plan
 * item P5.2).
 *
 * A real paired Classic wall with three family calendars, its forecast's box
 * made a countdown (`browser-countdown-looks.ts`), at 1080x1920 and 1920x1080:
 *
 *  1. **A countdown with none of the new keys is the countdown it always
 *     was**, on every day but its own. Two readings, because either alone can
 *     be fooled. The section's markup is held to the old renderer's, written
 *     out below from `main` at 4ed99e0 — same nodes, same classes, same words.
 *     And that same old markup is dropped into a twin of the box on the same
 *     page, under the same stylesheet, and every element in the two is held to
 *     the same rectangle, size, weight and colour — which is what "pixel
 *     identical" means for a drawing whose type is the box's own.
 *  2. **Sleeps** are the unit before the day and days after it.
 *  3. **The picture is bundled artwork** beside the label: a same-origin
 *     `<img>` that has loaded, as tall as the words beside it, never a code
 *     point in the text.
 *  4. **On the day it says "Today!" with a popper, and celebrates once**:
 *     a burst the first time the day is drawn, running under the scoped
 *     keyframes; nothing on the ticks after; again after an hour and not
 *     before; nothing moving for a device that asks for less motion, and no
 *     burst at all when `celebrate` is off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  SIZES,
  civilDate,
  countdownWall,
  measureScreen,
  picturesIn,
  readCountdownBox,
  setCountdown,
  type CountdownWall,
} from './browser-countdown-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
const TICK = 15_000;
/** `CELEBRATION_MS` and `CELEBRATION_EVERY_MS` in `apps/display/src/countdown.ts`. */
const BURST_MS = 4_800;
const HOUR = 60 * 60_000;

let cw: CountdownWall;

beforeAll(async () => {
  cw = await countdownWall();
}, SLOW);

afterAll(async () => {
  await cw?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * What `renderCountdownWidget` drew on `main` at 4ed99e0, as markup — the
 * whole of that function, transcribed so this file can say what "unchanged"
 * means without trusting the tree it is testing.
 */
function oldMarkup(days: number | undefined, label: string): string {
  if (days === undefined) return '<section class="cd"><div class="cd-empty">Set a date in this widget’s options.</div></section>';
  const abs = Math.abs(days);
  const count =
    days === 0
      ? '<div class="cd-num">Today</div>'
      : `<div class="cd-num">${abs}</div><div class="cd-unit">${abs === 1 ? 'day' : 'days'}${days < 0 ? ' ago' : ''}</div>`;
  return `<section class="cd">${count}${label === '' ? '' : `<div class="cd-label">${label}</div>`}</section>`;
}

interface Element {
  readonly cls: string;
  readonly text: string;
  readonly rect: readonly number[];
  readonly font: string;
}

/**
 * Every element in a box, relative to the box: its class, its own words, its
 * rectangle, and its computed size, weight and colour.
 */
async function signature(page: Page, selector: string): Promise<Element[]> {
  return page.evaluate((sel) => {
    const box = document.querySelector<HTMLElement>(sel);
    if (box === null) throw new Error(`nothing matches ${sel}`);
    const origin = box.getBoundingClientRect();
    return Array.from(box.querySelectorAll<HTMLElement>('*')).map((node) => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        cls: node.className,
        text: Array.from(node.childNodes)
          .filter((one) => one.nodeType === Node.TEXT_NODE)
          .map((one) => one.textContent)
          .join(''),
        rect: [r.left - origin.left, r.top - origin.top, r.width, r.height].map((v) => Math.round(v * 100) / 100),
        font: `${style.fontSize} ${style.fontWeight} ${style.color} ${style.lineHeight}`,
      };
    });
  }, selector);
}

/**
 * A twin of the countdown's box, beside it on the same canvas and under the
 * same stylesheet, drawn from the old renderer's markup.
 */
async function drawTwin(page: Page, widgetId: string, markup: string): Promise<string> {
  await page.evaluate(
    ({ id, html }) => {
      const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
      if (box === null) throw new Error('no countdown box');
      const twin = box.cloneNode(false) as HTMLElement;
      twin.setAttribute('data-widget-id', 'twin');
      twin.innerHTML = html;
      box.parentElement?.appendChild(twin);
    },
    { id: widgetId, html: markup },
  );
  return '#wall .canvas .fw[data-widget-id="twin"]';
}

describe('a countdown with none of the new keys', () => {
  const DAYS: readonly (number | undefined)[] = [12, 1, -1, -3, 365, undefined];

  for (const size of SIZES) {
    it(
      `is the markup and the pixels it always was, every day but its own, at ${size.width}x${size.height}`,
      async () => {
        measureScreen(cw, undefined);
        const id = cw.box[size.orientation].id;
        for (const label of ['', 'Summer holiday']) {
          for (const days of DAYS) {
            const config: Record<string, unknown> = {};
            if (days !== undefined) config['target'] = civilDate(cw.wall.now(), days);
            if (label !== '') config['title'] = label;
            await setCountdown(cw, config);
            const { page, close } = await loadWallSettled(cw.link, size);
            try {
              const where = `${size.width}x${size.height} ${days ?? 'no date'} "${label}"`;
              const drawn = await page.$eval(
                `#wall .canvas .fw[data-widget-id="${id}"] section`,
                (node) => node.outerHTML,
              );
              expect(drawn, where).toBe(oldMarkup(days, label));
              // No table: a number sizes to its box and states no tier.
              expect(await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"]`, (n) => n.getAttribute('data-tier')), where).toBeNull();
              const twin = await drawTwin(page, id, oldMarkup(days, label));
              const mine = await signature(page, `#wall .canvas .fw[data-widget-id="${id}"]`);
              const theirs = await signature(page, twin);
              expect(mine.length, `${where}: drew nothing`).toBeGreaterThan(1);
              expect(mine, where).toEqual(theirs);
            } finally {
              await close();
            }
          }
        }
      },
      SLOW,
    );
  }
});

describe('the new keys, on a real wall', () => {
  it(
    'counts in sleeps before the day and in days after it',
    async () => {
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      const cases: readonly [number, string][] = [
        [12, 'sleeps'],
        [1, 'sleep'],
        [-3, 'days ago'],
      ];
      for (const [days, unit] of cases) {
        await setCountdown(cw, { target: civilDate(cw.wall.now(), days), title: 'Christmas', unitWords: 'sleeps' });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const text = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-unit`, (n) => n.textContent);
          expect(text, `${days} days`).toBe(unit);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );

  for (const size of SIZES) {
    it(
      `draws the picture as bundled artwork beside the label, as tall as its words, at ${size.width}x${size.height}`,
      async () => {
        const id = cw.box[size.orientation].id;
        await setCountdown(cw, { target: civilDate(cw.wall.now(), 12), title: 'Christmas', emoji: 'christmas-tree' });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const found = await picturesIn(page, id);
          expect(found.codePoints, 'an emoji reached the glass as text').toEqual([]);
          expect(found.images.length).toBe(1);
          const [tree] = found.images;
          expect(new URL(tree!.src).pathname).toBe('/assets/emoji/christmas-tree.svg');
          expect(new URL(tree!.src).origin).toBe(new URL(cw.link).origin);
          expect(tree!.loaded, 'the artwork did not load').toBe(true);
          expect(tree!.alt).toBe('Christmas tree');
          expect(Math.abs(tree!.height - tree!.parentFont), 'the picture is not the height of its words').toBeLessThanOrEqual(1);
          const label = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-label`, (n) => n.textContent);
          expect(label).toBe('Christmas');
          const box = await readCountdownBox(page, id);
          expect(box.clipped).toEqual([]);
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }
});

/** Every piece of confetti on the glass, and what the browser is running on each. */
async function confetti(page: Page, widgetId: string): Promise<{ pieces: number; running: number; names: string[]; opacity: string[] }> {
  return page.evaluate((id) => {
    const bits = Array.from(document.querySelectorAll<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"] .cd-bit`));
    return {
      pieces: bits.length,
      running: bits.filter((bit) => bit.getAnimations().some((one) => one.playState === 'running')).length,
      names: [...new Set(bits.map((bit) => getComputedStyle(bit).animationName))],
      opacity: [...new Set(bits.map((bit) => getComputedStyle(bit).opacity))],
    };
  }, widgetId);
}

describe('the day itself', () => {
  for (const size of SIZES) {
    it(
      `says "Today!" with a popper, at ${size.width}x${size.height}`,
      async () => {
        const id = cw.box[size.orientation].id;
        await setCountdown(cw, { target: civilDate(cw.wall.now(), 0), title: 'Summer holiday' });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const num = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-num`, (n) => ({
            text: n.textContent,
            img: n.querySelector('img')?.getAttribute('src') ?? null,
          }));
          expect(num).toEqual({ text: 'Today!', img: '/assets/emoji/party-popper.svg' });
          const pictures = await picturesIn(page, id);
          expect(pictures.codePoints).toEqual([]);
          expect(pictures.images.every((one) => one.loaded)).toBe(true);
          const box = await readCountdownBox(page, id);
          expect(box.clipped).toEqual([]);
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }

  it(
    'celebrates once when the day is first drawn, not on the ticks after, and again only after an hour',
    async () => {
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      await setCountdown(cw, { target: civilDate(cw.wall.now(), 0), title: 'Summer holiday' });
      const { page, close } = await loadWallSettled(cw.link, size, { clock: 'installed' });
      try {
        // Fired: every piece, under the scoped keyframes, and the browser running them.
        const first = await confetti(page, id);
        expect(first.pieces, 'no confetti on the day').toBe(28);
        expect(first.names).toEqual(['cd-confetti-fall']);
        expect(first.running, 'the pieces are not moving').toBe(28);

        /*
         * From here the wall hears nothing from its server, so the hour below is
         * an hour of the wall's own clock: every poll would otherwise re-take the
         * offset from `x-server-time`, which runs at the ordinary rate, and pull
         * the wall's clock straight back to where the server's is.
         */
        await page.route('**/d/manifest*', (route) => route.abort('connectionrefused'));

        // The next ticks draw the day with no burst, and the wall did redraw.
        const draws = await page.evaluate(() => {
          const counter = window as unknown as { __draws: number };
          counter.__draws = 0;
          new MutationObserver((records) => {
            for (const record of records) {
              record.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement && (node.classList.contains('canvas') || node.querySelector('.canvas') !== null)) {
                  counter.__draws += 1;
                }
              });
            }
          }).observe(document.getElementById('wall') as HTMLElement, { childList: true, subtree: true });
          return true;
        });
        expect(draws).toBe(true);
        await page.clock.runFor(Math.max(BURST_MS, TICK) + 2_000);
        await page.clock.runFor(TICK);
        const drawnSince = await page.evaluate(() => (window as unknown as { __draws: number }).__draws);
        expect(drawnSince, 'no tick redrew the wall, so "no burst" proves nothing').toBeGreaterThanOrEqual(2);
        expect((await confetti(page, id)).pieces, 'the burst fired again on a tick').toBe(0);

        // Not before the hour is up…
        await page.clock.runFor(HOUR - 4 * TICK);
        expect((await confetti(page, id)).pieces, 'a second burst inside the hour').toBe(0);
        // …and once, on the first draw after it.
        let found = 0;
        for (let step = 0; step < 6 && found === 0; step++) {
          await page.clock.runFor(TICK);
          found = (await confetti(page, id)).pieces;
        }
        expect(found, 'no second burst an hour after the first').toBe(28);
        await page.clock.runFor(TICK);
        expect((await confetti(page, id)).pieces, 'the second burst fired twice').toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'throws nothing that moves for a device that asks for less motion, and nothing at all with the celebration off',
    async () => {
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      await setCountdown(cw, { target: civilDate(cw.wall.now(), 0), title: 'Summer holiday' });
      const { page, close, context } = await loadWallSettled(cw.link, size);
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await confetti(page, id);
        // The pieces of the burst still in the DOM are transparent and unmoved:
        // the still frame of a burst is nothing.
        expect(still.running).toBe(0);
        expect(still.names.every((one) => one === 'none')).toBe(true);
        expect(still.opacity.every((one) => one === '0')).toBe(true);
      } finally {
        await close();
        void context;
      }

      await setCountdown(cw, { target: civilDate(cw.wall.now(), 0), title: 'Summer holiday', celebrate: false });
      const off = await loadWallSettled(cw.link, size);
      try {
        expect(await off.page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-confetti`, (n) => n.length)).toBe(0);
        // …and it still says so.
        expect(await off.page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-num`, (n) => n.textContent)).toBe('Today!');
      } finally {
        await off.close();
      }
    },
    SLOW,
  );
});

/**
 * A rotating wallpaper's crossfade (plan item M4.10), on a real paired wall in
 * a real Chromium.
 *
 * `wallpaper.test.ts` in the display holds when the next swap is and which
 * picture it turns to. What only a browser can say, read through the Web
 * Animations API and the canvas's own computed style rather than off a class:
 *
 *  1. **The fade is scheduled on the wall clock**: the next picture's layer
 *     waits clear, starts to fade in two seconds before the swap the clock
 *     names, and is the picture the canvas then draws.
 *  2. **Nothing flashes back**: sampled every frame across the swap and the
 *     redraw after it, the picture a household sees changes once, through
 *     frames part-way, and never back.
 *  3. **It is a cut without motion**: with the wall's Motion switch off the
 *     layer is drawn, never animates and stays clear.
 *  4. **A rotation that cuts draws no layer at all**, which is every rotation
 *     saved before this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const VIEWPORT = { width: 1080, height: 1920 } as const;
/** `ROTATION_FADE_MS` in `apps/display/src/wallpaper.ts`, and the rotation's period. */
const FADE_MS = 2_000;
const PERIOD_MS = 5 * 60_000;
/** How far a scheduled moment may land from where the clock puts it: the draw's own latency. */
const TOLERANCE_MS = 500;

let home: Installation;
let screen: string;
let link: string;

beforeAll(async () => {
  home = await install({});
  link = await home.pairLink('Hall');
  screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
}, SLOW);

afterAll(async () => {
  await home.dispose();
  await shutDownBrowser();
}, TEARDOWN);

function rotate(between: 'fade' | undefined): void {
  const json = JSON.stringify({
    type: 'rotation',
    collection: 'gradient',
    tone: 'dark',
    every: 5,
    ...(between === undefined ? {} : { between }),
  });
  home.db
    .prepare('UPDATE screens SET layout_background = ?, layout_landscape_background = ?, picture_pressed_at = NULL, picture_step = NULL WHERE id = ?')
    .run(json, json, screen);
}

/** Move the server's clock so the next swap is `ms` away; the wall reads it off its first poll. */
function swapIn(ms: number): void {
  const into = home.now() % PERIOD_MS;
  home.shiftClock((((PERIOD_MS - ms - into) % PERIOD_MS) + PERIOD_MS) % PERIOD_MS);
}

const CANVAS = '#wall .canvas';
const NEXT = `${CANVAS} > .canvas-next`;

/** The wallpaper's id, out of a `url(...)`. */
const idOf = (image: string): string | undefined => /wallpapers\/([a-z0-9-]+)-\d{3,4}\./.exec(image)?.[1];

interface Scheduled {
  readonly name: string;
  readonly opacity: string;
  readonly startsAt: number | undefined;
  readonly at: number;
  readonly image: string;
  readonly canvasImage: string;
  /** Whether the layer is under every widget: no widget box precedes it. */
  readonly underWidgets: boolean;
}

async function read(page: Page, mark = false): Promise<Scheduled> {
  return page.evaluate(
    async ({ selector, canvas, mark }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error('no next picture on the wall');
      await Promise.all(node.getAnimations().map((one) => one.ready));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const first = node.getAnimations()[0];
      const timing = first?.effect?.getComputedTiming();
      const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      const at = document.timeline.currentTime;
      const now = typeof at === 'number' ? at : 0;
      if (mark) node.dataset['seen'] = '1';
      const box = document.querySelector<HTMLElement>(canvas);
      const children = Array.from(box?.children ?? []);
      const firstWidget = children.findIndex((one) => one.classList.contains('fw'));
      return {
        name: getComputedStyle(node).animationName,
        opacity: getComputedStyle(node).opacity,
        startsAt: local === undefined ? undefined : now - local + delay,
        at: now,
        image: node.style.backgroundImage,
        canvasImage: box?.style.backgroundImage ?? '',
        underWidgets: firstWidget === -1 || children.indexOf(node) < firstWidget,
      };
    },
    { selector: NEXT, canvas: CANVAS, mark },
  );
}

describe('a rotating wallpaper that fades', () => {
  it(
    'is scheduled on the wall clock, survives a redraw on the same frame, and never shows the old picture again',
    async () => {
      rotate('fade');
      swapIn(40_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        await page.waitForSelector(NEXT, { state: 'attached', timeout: 25_000 });
        const before = await read(page, true);
        const wallNow = home.now();
        const swapAt = (Math.floor(wallNow / PERIOD_MS) + 1) * PERIOD_MS;
        expect(before.name).toBe('mw-photo-in');
        expect(before.opacity, 'the next picture shows before its fade').toBe('0');
        expect(before.underWidgets, 'the next picture is drawn over a widget').toBe(true);
        expect(idOf(before.image)).toBeDefined();
        expect(idOf(before.image), 'the layer is the picture already showing').not.toBe(idOf(before.canvasImage));
        const expected = before.at + (swapAt - FADE_MS - wallNow);
        expect(Math.abs((before.startsAt as number) - expected), 'the fade is not where the clock puts it').toBeLessThan(TOLERANCE_MS);
        // Fetched before it shows.
        const fetched = await page.evaluate(
          (url) => performance.getEntriesByType('resource').some((one) => url !== '' && one.name.endsWith(url)),
          /url\("(.*)"\)/.exec(before.image)?.[1]?.replace(/^\//, '') ?? '',
        );
        expect(fetched, 'the next picture was not fetched ahead of its fade').toBe(true);

        // A redraw: a new layer, scheduled for the same moment.
        await page.waitForFunction(
          (sel) => {
            const node = document.querySelector<HTMLElement>(sel);
            return node !== null && node.dataset['seen'] === undefined;
          },
          NEXT,
          { timeout: 25_000, polling: 50 },
        );
        const after = await read(page);
        expect(after.image).toBe(before.image);
        expect(
          Math.abs((after.startsAt as number) - (before.startsAt as number)),
          'the rebuilt fade is scheduled somewhere else',
        ).toBeLessThan(TOLERANCE_MS);

        // Every frame through the swap and the redraw after it.
        const samples = await page.evaluate(
          async ({ canvas, next, until }) => {
            const out: { opacity: number; layer: string; canvas: string }[] = [];
            await new Promise<void>((done) => {
              const frame = (): void => {
                const t = document.timeline.currentTime as number;
                const box = document.querySelector<HTMLElement>(canvas);
                const layer = document.querySelector<HTMLElement>(next);
                out.push({
                  opacity: layer === null ? 0 : Number(getComputedStyle(layer).opacity),
                  layer: layer?.style.backgroundImage ?? '',
                  canvas: box?.style.backgroundImage ?? '',
                });
                if ((t > until && layer === null) || t > until + 20_000) done();
                else requestAnimationFrame(frame);
              };
              requestAnimationFrame(frame);
            });
            return out;
          },
          { canvas: CANVAS, next: NEXT, until: (before.startsAt as number) + FADE_MS + 500 },
        );
        const visible = samples.map((one) => idOf(one.opacity >= 0.5 ? one.layer : one.canvas));
        const target = idOf(before.image);
        const first = visible.indexOf(target);
        expect(visible[0], 'the sampling started after the swap').not.toBe(target);
        expect(first, 'the next picture never came').toBeGreaterThan(0);
        expect(visible.slice(first).every((one) => one === target), 'the old picture came back after the swap').toBe(true);
        expect(samples.filter((one) => one.opacity > 0.1 && one.opacity < 0.9).length, 'a cut, not a fade').toBeGreaterThan(3);
        // After the redraw the canvas draws it, and nothing waits above it.
        const last = samples[samples.length - 1];
        expect(idOf(last?.canvas ?? '')).toBe(target);
        expect(last?.layer).toBe('');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is a cut on a wall whose Motion switch is off',
    async () => {
      const off = await home.post(`/admin/screens/${screen}`, {
        name: 'Hall',
        orientation: 'auto',
        rotation: '0',
        theme: 'panels',
        clock_24: '',
        motion_shown: '1',
      });
      expect(off.status).toBe(302);
      rotate('fade');
      swapIn(40_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        expect(await page.$eval(CANVAS, (node) => node.getAttribute('data-motion'))).toBe('off');
        await page.waitForSelector(NEXT, { state: 'attached', timeout: 25_000 });
        const still = await read(page);
        expect(still.name).toBe('none');
        expect(still.opacity).toBe('0');
      } finally {
        await close();
        await home.post(`/admin/screens/${screen}`, {
          name: 'Hall',
          orientation: 'auto',
          rotation: '0',
          theme: 'panels',
          clock_24: '',
          motion: '1',
          motion_shown: '1',
        });
      }
    },
    SLOW,
  );
});

describe('a rotating wallpaper that cuts', () => {
  it(
    'draws no next picture at all',
    async () => {
      rotate(undefined);
      swapIn(40_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        expect(idOf(await page.$eval(CANVAS, (node) => (node as HTMLElement).style.backgroundImage))).toBeDefined();
        // Forty seconds from its swap, where a fading one has had its layer since its first draw.
        expect(await page.$$(NEXT)).toHaveLength(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

/**
 * A slideshow's crossfade and slow zoom (plan item M3.6), on a real paired wall
 * in a real Chromium.
 *
 * Read through the Web Animations API rather than off a class, for the reason
 * `browser-motion.test.ts` gives: an inline delay the browser ignores reads
 * exactly like one it honours. What is measured:
 *
 *  1. **The fade is scheduled on the wall clock.** The next photo's layer
 *     starts to fade in two seconds before the swap the clock names, and the
 *     rebuilt layer fifteen seconds later is scheduled for the same moment —
 *     the redraw lands on the same frame rather than restarting anything.
 *  2. **Nothing flashes back.** Sampled every frame across the swap and the
 *     redraw after it, the photo a household sees goes from the old one to the
 *     new one once: through a fade, never by a cut, and never back.
 *  3. **The zoom grows the picture inside a box that clips it**, and moves no
 *     rectangle.
 *  4. **It is a cut without motion**: on a device asking for reduced motion and
 *     on a wall whose Motion switch is off, nothing is animated and the next
 *     photo's layer stays clear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const VIEWPORT = { width: 1080, height: 1920 } as const;
/** `FADE_MS` in `apps/display/src/slideshow.ts`, and the album's interval. */
const FADE_MS = 2_000;
const INTERVAL_MS = 60_000;
/** How far a scheduled moment may land from where the clock puts it: the draw's own latency. */
const TOLERANCE_MS = 300;

function picture(seed: number): Buffer {
  const fb = new Framebuffer(40 + seed, 30);
  for (let x = 0; x < fb.width; x += seed + 2) for (let y = 0; y < 30; y++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

let home: Installation;
let screen: string;
let link: string;

beforeAll(async () => {
  home = await install({});
  const made = await home.post('/admin/photos', { name: 'Holidays' });
  const album = /\/admin\/photos\/([0-9a-f]{16})/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
  const body = new FormData();
  for (let i = 0; i < 3; i++) body.append('photos', new File([new Uint8Array(picture(i))], `p${i}.png`));
  await home.call(`/admin/photos/${album}/upload`, { method: 'POST', body });
  link = await home.pairLink('Hall');
  screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  const at = home.now();
  home.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
  home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  home.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES ('w-show', ?, 'portrait', 'image', 0.05, 0.05, 0.9, 0.5, 0, ?, ?, ?)`,
    )
    .run(screen, JSON.stringify({ album, slideSeconds: 60, slideMotion: 'zoom' }), at, at);
}, SLOW);

afterAll(async () => {
  await home.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Move the server's clock so the next swap is `ms` away; the wall reads it off its first poll. */
function swapIn(ms: number): void {
  const into = home.now() % INTERVAL_MS;
  home.shiftClock((((INTERVAL_MS - ms - into) % INTERVAL_MS) + INTERVAL_MS) % INTERVAL_MS);
}

const SHOW = '#wall [data-widget-id="w-show"]';
const NEXT = `${SHOW} .fw-photo-next`;
const BASE_ZOOM = `${SHOW} .fw-photo:not(.fw-photo-next) > .fw-zoom`;

interface Scheduled {
  /** Computed, not declared. */
  readonly name: string;
  readonly opacity: string;
  readonly running: number;
  /** When, on the page's own timeline, the animation's active phase begins. */
  readonly startsAt: number | undefined;
  /** The page's timeline and the photo on this layer, at the reading. */
  readonly at: number;
  readonly photo: string;
}

/** Read a scheduled animation once the browser has started it and the wall has settled its lock. */
async function read(page: Page, selector: string, mark = false): Promise<Scheduled> {
  return page.evaluate(
    async ({ selector, mark }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`nothing on the wall matches ${selector}`);
      const animations = node.getAnimations();
      await Promise.all(animations.map((one) => one.ready));
      // `settleLocks` moves the delay on once the animation has started: two frames.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const first = node.getAnimations()[0];
      const timing = first?.effect?.getComputedTiming();
      const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      const at = document.timeline.currentTime;
      const now = typeof at === 'number' ? at : 0;
      if (mark) node.dataset['seen'] = '1';
      const style = getComputedStyle(node);
      const layer = node.closest<HTMLElement>('.fw-photo') ?? node;
      const image = layer.querySelector<HTMLElement>('.fw-image') ?? layer;
      return {
        name: style.animationName,
        opacity: style.opacity,
        running: node.getAnimations().filter((one) => one.playState === 'running').length,
        startsAt: local === undefined ? undefined : now - local + delay,
        at: now,
        photo: image.style.backgroundImage,
      };
    },
    { selector, mark },
  );
}

describe('a crossfade with a slow zoom', () => {
  it(
    'is scheduled on the wall clock, survives a redraw on the same frame, and never shows the old photo again',
    async () => {
      // Far enough from the swap that the first redraw lands before the fade.
      swapIn(27_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        await page.waitForSelector(NEXT, { timeout: 25_000 });
        const before = await read(page, NEXT, true);
        const wallNow = home.now();
        const swapAt = (Math.floor(wallNow / INTERVAL_MS) + 1) * INTERVAL_MS;
        expect(before.name).toBe('mw-photo-in');
        expect(before.opacity, 'the next photo shows before its fade').toBe('0');
        expect(before.startsAt).toBeDefined();
        // Two seconds before the swap the clock names, read against the server's clock.
        const expected = before.at + (swapAt - FADE_MS - wallNow);
        expect(Math.abs((before.startsAt as number) - expected), 'the fade is not where the clock puts it').toBeLessThan(TOLERANCE_MS + 200);
        // The photo on show zooms from its own fade-in, an interval earlier.
        const zoom = await read(page, BASE_ZOOM);
        expect(zoom.name).toBe('mw-photo-zoom');
        expect(zoom.running).toBe(1);
        expect(Math.abs((zoom.startsAt as number) - ((before.startsAt as number) - INTERVAL_MS))).toBeLessThan(TOLERANCE_MS);

        // A redraw: a new layer, scheduled for the same moment.
        await page.waitForFunction(
          (sel) => {
            const node = document.querySelector<HTMLElement>(sel);
            return node !== null && node.dataset['seen'] === undefined;
          },
          NEXT,
          { timeout: 25_000, polling: 50 },
        );
        const after = await read(page, NEXT);
        expect(after.photo).toBe(before.photo);
        expect(after.at).toBeLessThan(before.startsAt as number);
        expect(
          Math.abs((after.startsAt as number) - (before.startsAt as number)),
          'the rebuilt fade is scheduled somewhere else',
        ).toBeLessThan(TOLERANCE_MS);

        // Through the swap and the redraw after it, every frame: which photo a
        // household sees, and how far the fade has got.
        const samples = await page.evaluate(
          async ({ show, until }) => {
            const out: { t: number; opacity: number; top: string; base: string; transform: string; clips: string }[] = [];
            await new Promise<void>((done) => {
              let replaced = false;
              const marked = document.querySelector<HTMLElement>(`${show} .fw-photo-next`);
              if (marked !== null) marked.dataset['through'] = '1';
              const frame = (): void => {
                const t = document.timeline.currentTime as number;
                const top = document.querySelector<HTMLElement>(`${show} .fw-photo-next`);
                const base = document.querySelector<HTMLElement>(`${show} .fw-photo:not(.fw-photo-next)`);
                const zoom = base?.querySelector<HTMLElement>('.fw-zoom');
                if (top !== null && base !== null && base !== undefined) {
                  out.push({
                    t,
                    opacity: Number(getComputedStyle(top).opacity),
                    top: top.querySelector<HTMLElement>('.fw-image')?.style.backgroundImage ?? '',
                    base: base.querySelector<HTMLElement>('.fw-image')?.style.backgroundImage ?? '',
                    transform: zoom === null || zoom === undefined ? '' : getComputedStyle(zoom).transform,
                    clips: getComputedStyle(base.parentElement as HTMLElement).overflow,
                  });
                  if (t > until && top.dataset['through'] === undefined) replaced = true;
                }
                if (replaced || t > until + 20_000) done();
                else requestAnimationFrame(frame);
              };
              requestAnimationFrame(frame);
            });
            return out;
          },
          { show: SHOW, until: (before.startsAt as number) + FADE_MS + 500 },
        );
        const visible = samples.map((one) => (one.opacity >= 0.5 ? one.top : one.base));
        const first = visible.indexOf(before.photo);
        expect(visible[0], 'the sampling started after the swap').not.toBe(before.photo);
        expect(first, 'the next photo never came').toBeGreaterThan(0);
        expect(
          visible.slice(first).every((one) => one === before.photo),
          'the old photo came back after the swap',
        ).toBe(true);
        // A fade, not a cut: frames part-way.
        expect(samples.filter((one) => one.opacity > 0.1 && one.opacity < 0.9).length).toBeGreaterThan(3);
        // After the redraw, the new photo is underneath and the one after it waits clear.
        const last = samples[samples.length - 1];
        expect(last?.base).toBe(before.photo);
        expect(last?.opacity).toBe(0);
        expect(last?.top).not.toBe(before.photo);
        // The zoom scales the picture, inside a box that clips it.
        const scales = samples.map((one) => /matrix\(([\d.]+)/.exec(one.transform)?.[1]).filter((one) => one !== undefined).map(Number);
        expect(scales.length).toBeGreaterThan(0);
        expect(Math.max(...scales)).toBeGreaterThan(1);
        expect(Math.max(...scales)).toBeLessThanOrEqual(1.08 + 1e-6);
        expect(new Set(samples.map((one) => one.clips))).toEqual(new Set(['hidden']));
        // And moves no rectangle: each layer is the widget's box.
        const boxes = await page.evaluate((show) => {
          const rect = (node: Element | null): string => {
            const r = node?.getBoundingClientRect();
            return r === undefined ? '' : [r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(',');
          };
          const slides = document.querySelector(`${show} .fw-slides`);
          return { slides: rect(slides), layers: [...document.querySelectorAll(`${show} .fw-photo`)].map(rect) };
        }, SHOW);
        expect(boxes.layers).toEqual([boxes.slides, boxes.slides]);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('without motion', () => {
  it(
    'is a cut on a device that asks for reduced motion',
    async () => {
      swapIn(40_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForSelector(NEXT, { timeout: 25_000 });
        const still = await read(page, NEXT);
        expect(still.name).toBe('none');
        expect(still.running).toBe(0);
        expect(still.opacity).toBe('0');
        expect((await read(page, BASE_ZOOM)).name).toBe('none');
        // …and the same page fades when the preference is lifted, so the
        // stillness is the media query and not a layer that never moved.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await read(page, NEXT)).name).toBe('mw-photo-in');
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
      swapIn(40_000);
      const { page, close } = await loadWallSettled(link, VIEWPORT);
      try {
        expect(await page.$eval('#wall .canvas', (node) => node.getAttribute('data-motion'))).toBe('off');
        await page.waitForSelector(NEXT, { timeout: 25_000 });
        const still = await read(page, NEXT);
        expect(still.name).toBe('none');
        expect(still.opacity).toBe('0');
        expect((await read(page, BASE_ZOOM)).name).toBe('none');
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

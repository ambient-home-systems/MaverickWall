/**
 * How a picture sits in its box (plan item M3.5), on a real paired wall in a
 * real Chromium: a portrait picture in three landscape boxes, filled, whole,
 * and whole over a blur.
 *
 * Read off the glass, not off a class: the computed `background-size`, the
 * blurred copy's computed filter and how far it overhangs a box that clips it,
 * and the pixels beside the picture — the theme's ground for "whole", the
 * picture's own blur for "whole over a blur".
 *
 * What a blur costs a tick was measured once, by hand, rather than here: at 6x
 * CPU throttling, three filled boxes cost 19 and 22ms of main-thread task time
 * a tick and three blurred ones 21 and 31ms. As a test it waited out six
 * redraws under throttling, took up to seven minutes and asserted nothing a
 * fault could turn red, so it is a note and not a test.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 150_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** A tall picture: stripes, so a blur of it is a grey and never the theme's ground. */
function portrait(): Buffer {
  const fb = new Framebuffer(60, 160);
  for (let y = 0; y < 160; y += 4) for (let x = 0; x < 60; x++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

async function wall(fits: readonly (string | undefined)[]): Promise<{ app: Installation; link: string; screen: string; name: string }> {
  const app = await install({});
  installations.push(app);
  const body = new FormData();
  body.append('image', new File([new Uint8Array(portrait())], 'tall.png'));
  const uploaded = (await (await app.call('/admin/media/upload', { method: 'POST', body })).json()) as { name: string };
  const link = await app.pairLink('Hall');
  const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  const at = app.now();
  app.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  fits.forEach((fit, index) => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'image', 0.05, ?, 0.9, 0.28, 0, ?, ?, ?)`,
      )
      .run(`w-${fit ?? 'cover'}${fits.indexOf(fit) === index ? '' : `-${index}`}`, screen, 0.03 + index * 0.32, JSON.stringify({ image: uploaded.name, ...(fit === undefined ? {} : { fit }) }), at, at);
  });
  return { app, link, screen, name: uploaded.name };
}

const box = (fit: string): string => `#wall [data-widget-id="w-${fit}"] .fw-image`;

/** The colour at a point of the page, from a screenshot. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, type: 'png' });
  const decoded = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, shot.toString('base64'));
  return [decoded[0] ?? 0, decoded[1] ?? 0, decoded[2] ?? 0];
}

describe('a portrait picture in a landscape box', () => {
  it(
    'fills it, shows it whole on the theme’s ground, or shows it whole over its own blur, clipped by the box',
    async () => {
      const { link } = await wall([undefined, 'contain', 'blur']);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector(`${box('blur')} .fw-fit-front`, { timeout: 25_000 });
        const read = await page.evaluate(() => {
          const one = (selector: string): HTMLElement => document.querySelector<HTMLElement>(selector) as HTMLElement;
          const rect = (node: HTMLElement): DOMRect => node.getBoundingClientRect();
          const cover = one('#wall [data-widget-id="w-cover"] .fw-image');
          const contain = one('#wall [data-widget-id="w-contain"] .fw-image');
          const blur = one('#wall [data-widget-id="w-blur"] .fw-image');
          const back = blur.querySelector<HTMLElement>('.fw-fit-back') as HTMLElement;
          const front = blur.querySelector<HTMLElement>('.fw-fit-front') as HTMLElement;
          const probe = document.createElement('div');
          probe.style.background = 'var(--panel)';
          contain.appendChild(probe);
          const panel = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            cover: getComputedStyle(cover).backgroundSize,
            contain: getComputedStyle(contain).backgroundSize,
            containGround: getComputedStyle(contain).backgroundColor,
            panel,
            frontSize: getComputedStyle(front).backgroundSize,
            backFilter: getComputedStyle(back).filter,
            backSize: getComputedStyle(back).backgroundSize,
            clips: getComputedStyle(blur).overflow,
            sameUrl: back.style.backgroundImage === front.style.backgroundImage && front.style.backgroundImage !== '',
            box: { x: rect(blur).x, y: rect(blur).y, w: rect(blur).width, h: rect(blur).height },
            back: { x: rect(back).x, y: rect(back).y, w: rect(back).width, h: rect(back).height },
            containBox: { x: rect(contain).x, y: rect(contain).y, w: rect(contain).width, h: rect(contain).height },
          };
        });
        expect(read.cover).toBe('cover');
        expect(read.contain).toBe('contain');
        expect(read.containGround).toBe(read.panel);
        expect(read.frontSize).toBe('contain');
        expect(read.backSize).toBe('cover');
        expect(read.sameUrl).toBe(true);
        expect(read.clips).toBe('hidden');
        const radius = Number(/blur\(([\d.]+)px\)/.exec(read.backFilter)?.[1] ?? 0);
        expect(radius).toBeGreaterThan(10);
        expect(read.backFilter).toContain('brightness(0.8)');
        // The blurred copy overhangs the box by twice its radius on every side.
        expect(read.box.x - read.back.x).toBeCloseTo(2 * radius, 0);
        expect(read.back.x + read.back.w - (read.box.x + read.box.w)).toBeCloseTo(2 * radius, 0);
        expect(read.box.y - read.back.y).toBeCloseTo(2 * radius, 0);

        // Beside the picture: the theme's ground for "whole", the picture's own blur for "whole over a blur".
        const side = (b: { x: number; y: number; w: number; h: number }): [number, number] => [b.x + b.w * 0.08, b.y + b.h / 2];
        const ground = await pixel(page, ...side(read.containBox));
        const blurred = await pixel(page, ...side(read.box));
        const panel = /rgba?\((\d+), (\d+), (\d+)/.exec(read.panel)?.slice(1).map(Number) ?? [];
        const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));
        expect(distance(ground, panel)).toBeLessThan(6);
        expect(distance(blurred, panel)).toBeGreaterThan(30);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('the fit in the editor', () => {
  it(
    'is offered as three choices and saves only what is not the absence',
    async () => {
      const { app, screen } = await wall([undefined]);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await app.signIn(editor);
        await editor.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.click('.insp-tab:has-text("Content")');
        await editor.click('.le-cfg-field:has-text("Fit") .seg button:has-text("Whole, over a blur")');
        await expect
          .poll(() => editor.evaluate(() => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.fw-fit-blur') !== null))
          .toBe(true);
        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = app.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'w-cover'`).get() as { config: string };
        expect(JSON.parse(stored.config)).toMatchObject({ fit: 'blur' });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

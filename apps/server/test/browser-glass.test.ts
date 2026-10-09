/**
 * Glass, the prototype widget ground (plan item M4.1), on a real paired wall
 * in a real Chromium, with the server's `MW_GLASS_PROTOTYPE` flag on.
 *
 * A widget sits over a picture of black and white stripes four pixels apart.
 * What is read is the glass itself, never a class:
 *
 *  - the layer under the widget computes `backdrop-filter: blur(…) saturate(1.4)`
 *    and a fill of the theme's card colour at 0.4;
 *  - on the glass the stripes are gone: a patch of the widget varies far less
 *    than the same patch on Soft, which in turn varies less than on None —
 *    blurred rather than merely tinted, read off the pixels a household sees;
 *  - and the card colour shows through: the glass patch is not the picture's
 *    own grey but leans to the card colour.
 *
 * The flag being off, and a wall sized as an e-ink panel, are the server's and
 * the view model's tests: both send Soft.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Square, and about the canvas's own size, so `cover` draws the stripes near 1:1 rather than enlarged. */
function stripes(): Buffer {
  const fb = new Framebuffer(1600, 1600);
  for (let x = 0; x < 1600; x++) if (Math.floor(x / 4) % 2 === 0) for (let y = 0; y < 1600; y++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

/** The mean and the spread of the luminance over a patch of the page, from a screenshot. */
async function patch(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ mean: number; spread: number; rgb: number[] }> {
  const shot = await page.screenshot({ clip, type: 'png' });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values: number[] = [];
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      red += r;
      green += g;
      blue += b;
    }
    const sum = [red, green, blue];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    return { mean, spread, rgb: sum.map((one) => one / values.length) };
  }, shot.toString('base64'));
}

describe('Glass over a striped picture', () => {
  it(
    'blurs the picture behind a widget, under the card colour at 0.4, where Soft only tints it',
    async () => {
      const home = await install({ glassPrototype: true });
      installations.push(home);
      const body = new FormData();
      body.append('image', new File([new Uint8Array(stripes())], 'stripes.png'));
      const uploaded = (await (await home.call('/admin/media/upload', { method: 'POST', body })).json()) as { name: string };
      const link = await home.pairLink('Hall');
      const screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      const at = home.now();
      home.db
        .prepare(`UPDATE screens SET layout_mode = 'freeform', layout_background = ? WHERE id = ?`)
        .run(JSON.stringify({ type: 'image', image: uploaded.name }), screen);
      home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      home.db
        .prepare(
          `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES ('w-note', ?, 'portrait', 'notes', 0.1, 0.1, 0.8, 0.4, 0, ?, ?, ?)`,
        )
        .run(screen, JSON.stringify({ text: 'Hi' }), at, at);

      const read = async (ground: string): Promise<{ data: string | null; patch: { mean: number; spread: number; rgb: number[] }; layer: { backdrop: string; background: string; opacity: string } }> => {
        home.db.prepare('UPDATE screens SET widget_ground = ? WHERE id = ?').run(ground, screen);
        const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
        try {
          const page = opened.page;
          await page.waitForSelector('#wall [data-widget-id="w-note"]', { timeout: 25_000 });
          // Let the picture decode and paint before reading pixels off it.
          await page.waitForFunction(() => document.querySelector<HTMLElement>('#wall .canvas')?.style.backgroundImage !== '', undefined, { timeout: 10_000 });
          await page.waitForTimeout(400);
          const box = await page.evaluate(() => {
            const node = document.querySelector<HTMLElement>('#wall [data-widget-id="w-note"]') as HTMLElement;
            const r = node.getBoundingClientRect();
            const before = getComputedStyle(node, '::before');
            return {
              data: document.querySelector('#wall .canvas')?.getAttribute('data-ground') ?? null,
              rect: { x: r.x, y: r.y, w: r.width, h: r.height },
              layer: {
                backdrop: before.getPropertyValue('backdrop-filter') || before.getPropertyValue('-webkit-backdrop-filter'),
                background: before.backgroundColor,
                opacity: before.opacity,
              },
            };
          });
          // A patch in the widget's top-left quarter, clear of the note in the middle and of the edge.
          const clip = { x: Math.round(box.rect.x + box.rect.w * 0.1), y: Math.round(box.rect.y + box.rect.h * 0.1), width: 60, height: 60 };
          return { data: box.data, patch: await patch(page, clip), layer: box.layer };
        } finally {
          await opened.close();
        }
      };

      const none = await read('none');
      const soft = await read('soft');
      const glass = await read('glass');

      // None draws no ground, so the canvas carries no attribute for it.
      expect(none.data).toBeNull();
      process.stdout.write(
        `[glass] spread none ${none.patch.spread.toFixed(1)}, soft ${soft.patch.spread.toFixed(1)}, glass ${glass.patch.spread.toFixed(1)}; ` +
          `mean none ${none.patch.mean.toFixed(1)}, soft ${soft.patch.mean.toFixed(1)}, glass ${glass.patch.mean.toFixed(1)}; ${glass.layer.backdrop}\n`,
      );
      expect(soft.data).toBe('soft');
      expect(glass.data).toBe('glass');
      // The layer: blurred and saturated, the card colour at 0.4, fully opaque itself.
      expect(glass.layer.backdrop).toMatch(/^blur\([\d.]+px\) saturate\(1\.4\)$/);
      expect(Number(/blur\(([\d.]+)px\)/.exec(glass.layer.backdrop)?.[1])).toBeGreaterThan(6);
      expect(glass.layer.background).toMatch(/^rgba\(\d+, \d+, \d+, 0\.4\)$/);
      expect(glass.layer.opacity).toBe('1');
      expect(soft.layer.backdrop === '' || soft.layer.backdrop === 'none').toBe(true);

      /*
       * On None the stripes show in full and on Soft faintly. Glass lets more
       * of the picture through than Soft does — 0.6 of it, where Soft lets
       * 0.14 — so what says it is *blurred* rather than thinly tinted is that
       * it varies far less than 0.6 of None would: the stripes are gone, and
       * what comes through is their average.
       */
      expect(none.patch.spread).toBeGreaterThan(60);
      expect(soft.patch.spread).toBeLessThan(none.patch.spread / 3);
      expect(glass.patch.spread).toBeLessThan(none.patch.spread * 0.6 * 0.25);
      // The picture is half black and half white, so a blur of it alone is mid-grey;
      // the card colour at 0.4 pulls the glass towards Panels' dark card.
      expect(glass.patch.mean).toBeLessThan(110);
      expect(glass.patch.mean).toBeGreaterThan(soft.patch.mean);
    },
    SLOW,
  );
});

describe('Glass in the editor', () => {
  it(
    'is offered in the wallpaper picker only where Wall settings offers it, and previews at once',
    async () => {
      for (const glassPrototype of [true, false]) {
        const home = await install({ glassPrototype });
        installations.push(home);
        const screen = await home.pairWall('Hall');
        home.db.prepare(`UPDATE screens SET layout_background = '{"type":"wallpaper","id":"dusk"}' WHERE id = ?`).run(screen);
        const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
        try {
          const page = await context.newPage();
          await home.signIn(page);
          await page.goto(`${home.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
          await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
          await page.click('.le-background-btn');
          await page.waitForSelector('.le-wp-ground [data-ground="soft"]', { timeout: 10_000 });
          const offered = await page.$$eval('.le-wp-ground [data-ground]', (n) => n.map((b) => (b as HTMLElement).dataset['ground'] ?? ''));
          if (!glassPrototype) {
            expect(offered).toEqual(['none', 'soft', 'solid']);
            continue;
          }
          expect(offered).toEqual(['none', 'soft', 'solid', 'glass']);
          await page.click('.le-wp-ground [data-ground="glass"]');
          expect(await page.locator('.le-wp-ground-hint').textContent()).toContain('frosted glass');
          await expect
            .poll(() =>
              page.evaluate(
                () => document.querySelector<HTMLElement>('.le-preview')?.shadowRoot?.querySelector<HTMLElement>('.canvas')?.dataset['ground'] ?? '',
              ),
            )
            .toBe('glass');
          // Written through to Wall settings' own radio, the one value Save sends.
          expect(await page.$eval('input[name="widget_ground"][value="glass"]', (n) => (n as HTMLInputElement).checked)).toBe(true);
        } finally {
          await context.close();
        }
      }
    },
    SLOW,
  );
});

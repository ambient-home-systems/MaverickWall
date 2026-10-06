/**
 * A QR code widget on a real paired wall and in the editor (plan item M5.3).
 *
 * Verified by decoding, never by looking: the wall's code is read back from a
 * **screenshot** of the box, as a phone's camera would read the glass, so the
 * stylesheet's plate and modules are what is decoded rather than the markup
 * that asks for them. Then the parts a phone needs that a decoder in a test
 * does not: dark on white on a dark theme, square, and the words under it
 * giving way before they cost the code more than half its size. Then the
 * editor, where a household types a network and watches the code change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { qrPayload } from '../src/api/qr-payload.js';
import { decodePixels } from './qr-decode.js';

const SLOW = 180_000;

let app: Installation;
let link: string;
let screen: string;

const WIFI = { ssid: 'Guests', wifiPassword: 'welcome-in', showPassword: true };
const LINK = { mode: 'link', link: 'https://example.com/menu' };

function place(widgets: readonly { id: string; x: number; y: number; w: number; h: number; config: object }[]): void {
  const stamp = app.now();
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
  for (const one of widgets) {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'qr', ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(one.id, screen, one.x, one.y, one.w, one.h, JSON.stringify(one.config), stamp, stamp);
  }
}

beforeAll(async () => {
  app = await install();
  link = await app.pairLink('Kitchen');
  screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
}, SLOW);

afterAll(async () => {
  await app.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * What a box's code says, read off the pixels the browser drew: a screenshot
 * of the code's own element, decoded by drawing it into a canvas and handing
 * the canvas's pixels to an independent decoder.
 */
async function readCode(page: Page, selector: string): Promise<string | undefined> {
  const png = await page.locator(selector).screenshot();
  const pixels = await page.evaluate(async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data.data), width: data.width, height: data.height };
  }, png.toString('base64'));
  return decodePixels(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
}

const box = (id: string): string => `#wall .canvas .fw[data-widget-id="${id}"]`;

describe('a QR code on the wall', () => {
  it(
    'reads back, from the glass, as exactly what it was set to carry: a network and a link',
    async () => {
      place([
        { id: 'q-wifi', x: 0.05, y: 0.05, w: 0.9, h: 0.4, config: WIFI },
        { id: 'q-link', x: 0.05, y: 0.5, w: 0.9, h: 0.4, config: LINK },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        expect(await readCode(page, `${box('q-wifi')} .qr-code`)).toBe(qrPayload(WIFI));
        expect(await readCode(page, `${box('q-link')} .qr-code`)).toBe(qrPayload(LINK));
        // The words under it: the network and the password asked for; the link without its scheme.
        expect(await page.$$eval(`${box('q-wifi')} .qr-words`, (nodes) => nodes.map((n) => n.textContent))).toEqual([
          'Guests',
          'Password: welcome-in',
        ]);
        expect(await page.$$eval(`${box('q-link')} .qr-words`, (nodes) => nodes.map((n) => n.textContent))).toEqual([
          'example.com/menu',
        ]);
        expect(await page.getAttribute(`${box('q-wifi')} svg`, 'aria-label')).toBe(
          'QR code to join the Wi-Fi network Guests',
        );
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'is black on white on a dark theme, and square at the shorter side of its room',
    async () => {
      place([{ id: 'q-wifi', x: 0.05, y: 0.05, w: 0.9, h: 0.4, config: WIFI }]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const seen = await page.evaluate((sel) => {
          const root = document.querySelector(sel) as HTMLElement;
          const svg = root.querySelector('.qr-code svg') as SVGSVGElement;
          const room = (root.querySelector('.qr-code') as HTMLElement).getBoundingClientRect();
          const plate = (svg.querySelector('.qr-plate') as SVGGraphicsElement).getBoundingClientRect();
          return {
            ground: getComputedStyle(document.body).backgroundColor,
            plate: getComputedStyle(svg.querySelector('.qr-plate') as Element).fill,
            modules: getComputedStyle(svg.querySelector('.qr-modules') as Element).fill,
            room: { w: room.width, h: room.height },
            drawn: { w: plate.width, h: plate.height },
          };
        }, box('q-wifi'));
        // The harness's walls wear Panels, a dark theme: the code does not follow it.
        expect(seen.ground).not.toBe('rgb(255, 255, 255)');
        expect(seen.plate).toBe('rgb(255, 255, 255)');
        expect(seen.modules).toBe('rgb(0, 0, 0)');
        expect(Math.abs(seen.drawn.w - seen.drawn.h)).toBeLessThan(1);
        expect(Math.abs(seen.drawn.w - Math.min(seen.room.w, seen.room.h))).toBeLessThan(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'gives its words up, last line first, before they cost the code half its size — and still reads',
    async () => {
      // A wide, short box: the password line would leave the code under half
      // the box's height, and the network's name would not.
      place([{ id: 'q-short', x: 0.05, y: 0.05, w: 0.9, h: 0.09, config: WIFI }]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const words = await page.$$eval(`${box('q-short')} .qr-words`, (nodes) => nodes.map((n) => n.textContent));
        expect(words).toEqual(['Guests']);
        expect(await page.getAttribute(box('q-short'), 'data-rungs')).toBe('caption');
        const sizes = await page.evaluate((sel) => {
          const root = document.querySelector(sel) as HTMLElement;
          const body = (root.querySelector('.qr') as HTMLElement).getBoundingClientRect();
          const plate = (root.querySelector('.qr-plate') as SVGGraphicsElement).getBoundingClientRect();
          return { body: Math.min(body.width, body.height), code: plate.height };
        }, box('q-short'));
        expect(sizes.code).toBeGreaterThanOrEqual(sizes.body / 2);
        expect(await readCode(page, `${box('q-short')} .qr-code`)).toBe(qrPayload(WIFI));
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'says what is missing rather than drawing an empty box',
    async () => {
      place([
        { id: 'q-none', x: 0.05, y: 0.05, w: 0.9, h: 0.4, config: { ssid: 'Guests' } },
        { id: 'q-text', x: 0.05, y: 0.5, w: 0.9, h: 0.4, config: { mode: 'text' } },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        expect(await page.textContent(`${box('q-none')} .cd-empty`)).toBe(
          'Add the network’s name and password in this widget’s options.',
        );
        expect(await page.textContent(`${box('q-text')} .cd-empty`)).toBe(
          'Type the words for the code in this widget’s options.',
        );
        expect(await page.locator(`${box('q-none')} svg`).count()).toBe(0);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('a QR code in the editor', () => {
  it(
    'previews the network as it is typed, warns before Save, and saves what was typed',
    async () => {
      place([{ id: 'q-edit', x: 0.05, y: 0.05, w: 0.9, h: 0.4, config: {} }]);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await app.signIn(editor);
        await editor.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.click('.insp-tab:has-text("Content")');
        const preview = (sel: string): Promise<string | null> =>
          editor.evaluate(
            (s) => document.querySelector('.le-preview')?.shadowRoot?.querySelector(s)?.getAttribute('aria-label') ?? null,
            sel,
          );
        expect(await preview('.qr-code svg')).toBeNull();

        await editor.fill('.le-cfg-field:has-text("Network name") input', 'Visitors');
        await editor.fill('.le-cfg-field:has-text("Password") input', 'short');
        // A WPA password no network has is said under the fields, before Save.
        await expect
          .poll(() => editor.textContent('.le-qr-warn'))
          .toBe('A WPA password is at least 8 characters.');
        await editor.fill('.le-cfg-field:has-text("Password") input', 'come-on-in');
        await expect.poll(() => editor.isHidden('.le-qr-warn')).toBe(true);
        await expect
          .poll(() => preview('.qr-code svg'))
          .toBe('QR code to join the Wi-Fi network Visitors');

        // The other two kinds rebuild the fields for what the code carries.
        // 107 accented letters are 214 bytes, one past a code: counted as the encoder counts.
        await editor.selectOption('.le-cfg-field[data-cfg-key="mode"] select', 'text');
        await editor.fill('.le-cfg-field:has-text("Words in the code") textarea', 'é'.repeat(107));
        await expect
          .poll(() => editor.textContent('.le-qr-warn'))
          .toBe('That is more than one QR code can hold. Shorten it.');
        await editor.selectOption('.le-cfg-field[data-cfg-key="mode"] select', '');

        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = app.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'q-edit'`).get() as { config: string };
        // The text typed for the other kind is kept: a household switching back finds it.
        expect(JSON.parse(stored.config)).toEqual({ ssid: 'Visitors', wifiPassword: 'come-on-in', text: 'é'.repeat(107) });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

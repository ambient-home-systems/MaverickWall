/**
 * A News widget on a real paired wall and in the editor (plan item M5.5).
 *
 * Nothing on the wall is a link: the widget is searched for an anchor and for
 * anything that takes a pointer, and the story's address is read back only by
 * decoding a **screenshot** of the code drawn beside a headline. The headline
 * on show in the one-at-a-time view is the wall clock's choice, so the test
 * moves the server's clock, which the wall reads off every answer, and watches
 * the next one come round. And the list gives up rows rather than spilling out of its box.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { decodePixels } from './qr-decode.js';

const SLOW = 180_000;

let app: Installation;
let link: string;
let screen: string;

const ITEMS = [
  { id: 'a', title: 'Library opens late on Thursdays', link: 'https://example.com/news/library' },
  { id: 'b', title: 'A comet passes close enough to see from the garden', link: 'https://example.org/comet' },
  { id: 'c', title: 'Bin collections move to Tuesdays from next month', link: 'https://example.com/news/bins' },
  { id: 'd', title: 'School term dates for next year are out', link: 'https://example.com/news/term' },
];

beforeAll(async () => {
  app = await install();
  link = await app.pairLink('Kitchen');
  screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
  const stamp = app.now();
  // A feed as a read would have stored it: newest first, an hour apart.
  const items = ITEMS.map((item, index) => ({ ...item, publishedAt: stamp - (index + 1) * 3600_000 }));
  app.db
    .prepare(
      `INSERT INTO news_feeds (id, name, url_encrypted, sort_order, items, last_fetched_at, last_success_at, created_at, updated_at)
       VALUES ('nf-aaaaaaaaaaaa', 'Local News', 'sealed', 0, ?, ?, ?, ?, ?)`,
    )
    .run(JSON.stringify(items), stamp, stamp, stamp, stamp);
}, SLOW);

afterAll(async () => {
  await app.dispose();
  await shutDownBrowser();
}, TEARDOWN);

function place(widgets: readonly { id: string; y: number; h: number; config: object }[]): void {
  const stamp = app.now();
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
  for (const one of widgets) {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'news', 0.05, ?, 0.9, ?, 0, ?, ?, ?)`,
      )
      .run(one.id, screen, one.y, one.h, JSON.stringify(one.config), stamp, stamp);
  }
}

const box = (id: string): string => `#wall .canvas .fw[data-widget-id="${id}"]`;

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

describe('news on the wall', () => {
  it(
    'lists the headlines with their source and age, gives up rows rather than spilling, and is no link',
    async () => {
      place([
        { id: 'n-list', y: 0.02, h: 0.4, config: {} },
        { id: 'n-short', y: 0.45, h: 0.08, config: { showTime: false } },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const titles = await page.$$eval(`${box('n-list')} .nw-title`, (nodes) => nodes.map((n) => n.textContent));
        expect(titles).toEqual(ITEMS.map((item) => item.title));
        expect(await page.textContent(`${box('n-list')} .nw-item .nw-meta`)).toBe('Local News · 1 h ago');
        expect(await page.textContent(`${box('n-short')} .nw-item .nw-meta`)).toBe('Local News');
        // The short box draws fewer rows, every one whole and inside it.
        const short = await page.evaluate((sel) => {
          const root = document.querySelector(sel) as HTMLElement;
          const room = root.getBoundingClientRect();
          const rows = [...root.querySelectorAll<HTMLElement>('.nw-item')].filter((row) => row.style.display !== 'none' && row.getBoundingClientRect().height > 0);
          return { shown: rows.length, inside: rows.every((row) => row.getBoundingClientRect().bottom <= room.bottom + 0.5) };
        }, box('n-short'));
        expect(short.shown).toBeGreaterThanOrEqual(1);
        expect(short.shown).toBeLessThan(ITEMS.length);
        expect(short.inside).toBe(true);
        // Nothing on a wall is a link, or anything a pointer could take.
        for (const id of ['n-list', 'n-short']) {
          expect(await page.locator(`${box(id)} a, ${box(id)} button, ${box(id)} [href], ${box(id)} [onclick]`).count()).toBe(0);
        }
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'shows one headline at a time with a code that reads back as its link, and turns by the clock',
    async () => {
      place([{ id: 'n-one', y: 0.05, h: 0.25, config: { mode: 'one', rotateSeconds: 300 } }]);
      // Start just after a five-minute boundary, so the turn below is the one the test makes.
      const step = 300_000;
      app.shiftClock(Math.ceil(app.now() / step) * step + 5_000 - app.now());
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const first = await page.getAttribute(`${box('n-one')} .nw`, 'data-headline');
        const title = await page.textContent(`${box('n-one')} .nw-headline`);
        const item = ITEMS.find((one) => one.title === title);
        expect(item).toBeDefined();
        expect(await readCode(page, `${box('n-one')} .nw-qr`)).toBe(item?.link);
        expect(await page.textContent(`${box('n-one')} .nw-meta`)).toContain(`of ${ITEMS.length}`);
        expect(await page.locator(`${box('n-one')} a, ${box('n-one')} button`).count()).toBe(0);

        // Five minutes on by the server's clock, which the wall learns from the
        // time every answer carries: the next headline, with no timer of its own.
        app.shiftClock(step);
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await expect
          .poll(() => page.getAttribute(`${box('n-one')} .nw`, 'data-headline'), { timeout: 40_000 })
          .not.toBe(first);
        const next = await page.textContent(`${box('n-one')} .nw-headline`);
        expect(ITEMS.findIndex((one) => one.title === next)).toBe((ITEMS.findIndex((one) => one.title === title) + 1) % ITEMS.length);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('news in the editor', () => {
  it(
    'offers the feeds and both views, and saves what was chosen',
    async () => {
      place([{ id: 'n-edit', y: 0.05, h: 0.3, config: {} }]);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await app.signIn(editor);
        await editor.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.click('.insp-tab:has-text("Content")');
        expect(await editor.textContent('.le-cfg-field[data-cfg-key="newsFeeds"]')).toContain('Local News');
        await editor.selectOption('.le-cfg-field[data-cfg-key="mode"] select', 'one');
        await editor.click('.le-cfg-field:has-text("Each headline shows for") .seg button:has-text("30 seconds")');
        await editor.locator('.switch:has-text("QR code to read it on a phone") input').uncheck();
        await expect
          .poll(() =>
            editor.evaluate(() => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.nw-one') !== null),
          )
          .toBe(true);
        expect(
          await editor.evaluate(() => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.nw-qr') !== null),
        ).toBe(false);
        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = app.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'n-edit'`).get() as { config: string };
        expect(JSON.parse(stored.config)).toEqual({ mode: 'one', rotateSeconds: 30, showQr: false });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

/**
 * The editor previewing a layout at each connected wall's real shape (plan
 * item M8.8), driven in a real editor.
 *
 * A household arranges one canvas and hangs it on a tablet and a television
 * whose shapes are not the canvas's; each wall letterboxes it. The chips show
 * that before Save rather than after a walk to the kitchen. What is measured
 * is geometry, never a class: the frame's rectangle at the wall's reported
 * shape, the canvas inside it at the layout's own, the bands where they
 * differ, the orientation the wall is hung in, and nothing saved by looking.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants } from './fake-home-assistant.js';
import { applyTemplate } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';

process.env['TZ'] = 'UTC';

const SLOW = 90_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const rectOf = (page: Page, selector: string): Promise<Rect> =>
  page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

describe('previewing a layout on each connected wall', () => {
  it('frames the canvas at a wall’s reported shape, in its orientation, and saves nothing', async () => {
    const wall = await install();
    installations.push(wall);
    const kitchen = await wall.pairWall('Kitchen');
    const hall = await wall.pairWall('Hall');
    const spare = await wall.pairWall('Spare room');
    applyTemplate(wall.db, kitchen, CLASSIC_TEMPLATE);
    // What each wall last reported; the spare room has never checked in.
    wall.db.prepare('UPDATE screens SET report_w = ?, report_h = ? WHERE id = ?').run(800, 1280, kitchen);
    wall.db.prepare('UPDATE screens SET report_w = ?, report_h = ? WHERE id = ?').run(2560, 1080, hall);
    void spare;

    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(kitchen)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
      const before = await rectOf(page, '.le-canvas');

      await page.locator('.le-size-btn').click();
      const chips = page.locator('.le-wall-chip');
      // In name order, and a wall that has never reported a size has no shape to show.
      expect(await chips.allTextContents()).toEqual(['Hall · 2560×1080', 'Kitchen · 800×1280']);

      // The Hall television: a landscape wall, so the editor turns landscape.
      await chips.nth(0).click();
      await page.waitForTimeout(200);
      expect(await chips.nth(0).getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator('.le-orient [aria-pressed="true"], .le-orient [aria-selected="true"]').first().textContent())
        .toMatch(/Landscape/i);
      const frame = await rectOf(page, '.le-frame');
      const canvas = await rectOf(page, '.le-canvas');
      expect(frame.width / frame.height).toBeCloseTo(2560 / 1080, 1);
      // Classic's landscape canvas is 16:9; the wall is 64:27, so the bands are
      // either side and the canvas is the frame's full height, centred.
      expect(canvas.width / canvas.height).toBeCloseTo(16 / 9, 1);
      expect(Math.abs(canvas.height - frame.height)).toBeLessThan(1.5);
      expect(canvas.width).toBeLessThan(frame.width - 20);
      expect(Math.abs(canvas.x - frame.x - (frame.x + frame.width - canvas.x - canvas.width))).toBeLessThan(1.5);
      expect(await page.locator('.le-frame-note').textContent()).toContain('As Hall shows it, at 2560×1080.');

      // The Kitchen tablet: portrait, 5:8, which is wider than Classic's 9:16 —
      // so the canvas is the frame's height and the bands are at the sides.
      await chips.nth(1).click();
      await page.waitForTimeout(200);
      const tall = await rectOf(page, '.le-frame');
      const inside = await rectOf(page, '.le-canvas');
      expect(tall.width / tall.height).toBeCloseTo(800 / 1280, 2);
      expect(inside.width / inside.height).toBeCloseTo(9 / 16, 2);
      expect(Math.abs(inside.height - tall.height)).toBeLessThan(1.5);
      expect(inside.width).toBeLessThan(tall.width - 10);
      expect(await chips.nth(0).getAttribute('aria-pressed')).toBe('false');

      // Pressed again, the preview ends and the canvas is the size it was.
      await chips.nth(1).click();
      await page.waitForTimeout(200);
      expect(await page.locator('.le-frame-note').isVisible()).toBe(false);
      const after = await rectOf(page, '.le-canvas');
      expect(Math.abs(after.width - before.width)).toBeLessThan(1.5);
      expect(Math.abs(after.height - before.height)).toBeLessThan(1.5);
      const frameAfter = await rectOf(page, '.le-frame');
      expect(Math.abs(frameAfter.width - after.width)).toBeLessThan(1.5);

      // Looking is not editing.
      expect(await page.locator('[data-action="save"]').isEnabled()).toBe(false);
    } finally {
      await context.close();
    }
  }, SLOW);
});

/**
 * The editor's full-window preview, driven in a real editor.
 *
 * A household arranging a wall wants to see it as the wall will show it,
 * larger than the editor's canvas and without the boxes, handles and name
 * chips they drag. What is measured is the preview itself, never a class: its
 * canvas fills the window at the layout's own shape, it draws the same widgets
 * as the preview behind the boxes, unsaved edits included, none of the
 * editor's own furniture is in it, it frames a connected wall's shape while a
 * chip is pressed, the keyboard cannot edit behind it, and nothing is saved.
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

/** Each drawn widget box, as a fraction of its canvas, in document order. */
const boxesIn = (page: Page, host: string): Promise<readonly { type: string; x: number; y: number; w: number; h: number }[]> =>
  page.evaluate((selector) => {
    const root = document.querySelector<HTMLElement>(selector)?.shadowRoot;
    const canvas = root?.querySelector<HTMLElement>('.canvas');
    if (root == null || canvas == null) return [];
    const c = canvas.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLElement>('.canvas > .fw')].map((box) => {
      const r = box.getBoundingClientRect();
      return {
        type: [...box.classList].find((name) => name.startsWith('fw-') && name !== 'fw') ?? '',
        x: (r.x - c.x) / c.width,
        y: (r.y - c.y) / c.height,
        w: r.width / c.width,
        h: r.height / c.height,
      };
    });
  }, host);

describe('the full-window preview of a layout', () => {
  it('draws the unsaved layout as the wall does, as large as the window, with no editing boxes', async () => {
    const wall = await install();
    installations.push(wall);
    const kitchen = await wall.pairWall('Kitchen');
    const hall = await wall.pairWall('Hall');
    applyTemplate(wall.db, kitchen, CLASSIC_TEMPLATE);
    wall.db.prepare('UPDATE screens SET report_w = ?, report_h = ? WHERE id = ?').run(2560, 1080, hall);

    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(kitchen)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
      await page.waitForFunction(
        () => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.canvas') != null,
        undefined,
        { timeout: 20_000 },
      );
      const button = page.locator('.le-fullview-btn');
      await expect.poll(() => button.isEnabled()).toBe(true);

      // An unsaved edit: one widget removed from the canvas.
      const before = await boxesIn(page, '.le-preview');
      await page.locator('.le-overlay .le-widget').first().click();
      await page.locator('.insp-remove').click();
      await expect.poll(async () => (await boxesIn(page, '.le-preview')).length).toBe(before.length - 1);
      const editing = await boxesIn(page, '.le-preview');

      await button.click();
      await page.waitForFunction(
        () => document.querySelector('.le-fullview-canvas')?.shadowRoot?.querySelector('.canvas > .fw') != null,
        undefined,
        { timeout: 10_000 },
      );
      expect(await page.locator('.le-fullview').isVisible()).toBe(true);
      // Focus is on Close, so Enter or Escape ends it at once.
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('le-fullview-close');

      // The layout's own shape, filling the room the window leaves under the bar.
      const stage = await rectOf(page, '.le-fullview-stage');
      const shown = await rectOf(page, '.le-fullview-canvas');
      expect(shown.width / shown.height).toBeCloseTo(9 / 16, 2);
      expect(shown.height).toBeGreaterThan(0.85 * 1000);
      // A tall layout in a wide window: the height binds, and it is the stage's
      // whole height, less its padding.
      expect(Math.abs(shown.height - (stage.height - 2 * 16))).toBeLessThan(1.5);
      expect(shown.height).toBeGreaterThanOrEqual((await rectOf(page, '.le-canvas')).height);

      // The same widgets, in the same places, as the editor's preview draws
      // after the unsaved removal: one renderer, one canvas.
      const full = await boxesIn(page, '.le-fullview-canvas');
      expect(full.map((box) => box.type)).toEqual(editing.map((box) => box.type));
      full.forEach((box, index) => {
        const other = editing[index]!;
        expect(Math.abs(box.x - other.x)).toBeLessThan(0.01);
        expect(Math.abs(box.y - other.y)).toBeLessThan(0.01);
        expect(Math.abs(box.w - other.w)).toBeLessThan(0.01);
        expect(Math.abs(box.h - other.h)).toBeLessThan(0.01);
      });
      // None of the editor's furniture: no drag boxes, handles or name chips.
      expect(
        await page.locator('.le-fullview').evaluate(
          (el) => el.querySelectorAll('.le-widget, .le-handle, .le-label, .le-overlay').length,
        ),
      ).toBe(0);
      expect(
        await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('.le-fullview-canvas')?.shadowRoot;
          return root?.querySelectorAll('.le-widget, .le-handle, .le-overlay').length ?? -1;
        }),
      ).toBe(0);

      // The keyboard cannot edit behind it: Ctrl+Z does not bring the widget back.
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(200);
      expect((await boxesIn(page, '.le-preview')).length).toBe(editing.length);
      // Tab stays on its own buttons.
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.querySelector('.le-fullview')?.contains(document.activeElement))).toBe(true);
      }

      // Escape closes it and hands focus back to the button that opened it.
      await page.keyboard.press('Escape');
      expect(await page.locator('.le-fullview').isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('le-fullview-btn');
      // And the editor's own keys work again.
      await page.locator('.le-canvas').click({ position: { x: 2, y: 2 } }).catch(() => undefined);
      await page.keyboard.press('Control+z');
      await expect.poll(async () => (await boxesIn(page, '.le-preview')).length).toBe(before.length);

      // With a connected wall's chip pressed, the canvas sits in that wall's
      // shape: the Hall television is 64:27 around Classic's 16:9 landscape.
      await page.locator('.le-size-btn').click();
      await page.locator('.le-wall-chip', { hasText: 'Hall' }).click();
      await page.keyboard.press('Escape');
      await button.click();
      await page.waitForTimeout(200);
      const device = await rectOf(page, '.le-fullview-device');
      const inside = await rectOf(page, '.le-fullview-canvas');
      expect(device.width / device.height).toBeCloseTo(2560 / 1080, 1);
      expect(inside.width / inside.height).toBeCloseTo(16 / 9, 1);
      expect(Math.abs(inside.height - device.height)).toBeLessThan(1.5);
      expect(inside.width).toBeLessThan(device.width - 20);
      // A wide wall in a wide window: the width binds, and it is the stage's.
      const wide = await rectOf(page, '.le-fullview-stage');
      expect(Math.abs(device.width - (wide.width - 2 * 16))).toBeLessThan(1.5);
      expect(device.width).toBeGreaterThan(1.3 * (await rectOf(page, '.le-frame')).width);
      expect(await page.locator('.le-fullview-title').textContent()).toContain('As Hall shows it, at 2560×1080.');
      // It is drawn from the clock at the moment, as a wall is: two hours on,
      // a redraw shows a different time. The removed widget above was not the
      // clock, which is still here.
      const clockText = (): Promise<string> =>
        page.evaluate(
          () =>
            document.querySelector<HTMLElement>('.le-fullview-canvas')?.shadowRoot?.querySelector<HTMLElement>('.fw-clock .clock')
              ?.textContent ?? '',
        );
      const earlier = await clockText();
      expect(earlier).toMatch(/\d/);
      await page.evaluate(() => {
        const real = Date.now.bind(Date);
        Date.now = () => real() + 2 * 3_600_000;
        window.dispatchEvent(new Event('resize'));
      });
      await expect.poll(clockText).not.toBe(earlier);

      // The bands are the wall's own ground, its theme's --bg, as a wall
      // letterboxes its canvas, and not the admin page's.
      const bands = await page.evaluate(() => {
        const wall = document.querySelector<HTMLElement>('.le-fullview-canvas')?.shadowRoot?.querySelector<HTMLElement>('.preview-wall');
        const device = document.querySelector<HTMLElement>('.le-fullview-device');
        const stage = document.querySelector<HTMLElement>('.le-fullview');
        if (wall == null || device == null || stage == null) return undefined;
        const probe = document.createElement('div');
        probe.style.background = getComputedStyle(wall).getPropertyValue('--bg').trim();
        document.body.appendChild(probe);
        const ground = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { band: getComputedStyle(device).backgroundColor, ground, page: getComputedStyle(stage).backgroundColor };
      });
      expect(bands?.band).toBe(bands?.ground);
      expect(bands?.band).not.toBe(bands?.page);
      // The page behind is covered: the backdrop is opaque.
      expect(bands?.page).toMatch(/^rgb\(/);

      // Expand leaves only the wall: the bar goes and the picture takes the monitor.
      await page.locator('.le-fullview .le-tool-btn', { hasText: 'Expand' }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className ?? '')).toContain('le-fullview');
      await expect.poll(() => page.locator('.le-fullview-bar').isVisible()).toBe(false);
      await page.evaluate(() => document.exitFullscreen());
      await expect.poll(() => page.locator('.le-fullview-bar').isVisible()).toBe(true);
      await page.locator('.le-fullview-close').click();
      expect(await page.locator('.le-fullview').isVisible()).toBe(false);

      // Looking is not editing: the undo above put the canvas back as it was.
      expect(await page.locator('[data-action="save"]').isEnabled()).toBe(false);
    } finally {
      await context.close();
    }
  }, SLOW);
});

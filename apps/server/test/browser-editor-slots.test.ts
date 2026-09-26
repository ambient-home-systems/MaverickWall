/**
 * The layout editor's named canvases (RFC 014 §5.2), driven.
 *
 * Three things, each the editor's own promise about slots rather than the
 * wall's about drawing them:
 *
 *  - **dirtiness is per canvas, and a slot is a canvas**: an edit on the
 *    morning layout keeps the save bar live after switching to the everyday
 *    one, and undoing it back where it started clears the bar honestly —
 *    which is the comparison-not-flag rule (RFC 009 Phase 5) applied to a
 *    map of canvases rather than to one other canvas;
 *  - **Save writes every canvas that differs**, both slots at once, and the
 *    body carries the slot for the named one and no slot for the everyday one
 *    — counted at the network, because "which canvases were written" is not
 *    something the DOM can say;
 *  - **a layout is started from what is there** and can be removed again:
 *    New layout copies the canvas on screen under a new name, Save writes it
 *    under that name, Remove takes it off the server and the tab off the bar.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants } from './fake-home-assistant.js';
import { applyTemplate } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';
import { readLayoutSlots, readLayoutWidgets } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

const SLOW = 90_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  const made = await install();
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface EditorBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Every box on the canvas, from the overlay — the editor's live opinion. */
const boxes = (page: Page): Promise<EditorBox[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')].map((el) => ({
      id: el.dataset['id'] ?? '',
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
    })),
  );

const canvasState = async (page: Page): Promise<string> =>
  JSON.stringify((await boxes(page)).slice().sort((a, b) => (a.id < b.id ? -1 : 1)));

async function dragBox(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const box = page.locator('.le-overlay .le-widget').nth(index);
  const rect = await box.boundingBox();
  if (rect === null) throw new Error('that widget has no box to drag');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

const saveEnabled = (page: Page): Promise<boolean> => page.locator('[data-action="save"]').isEnabled();

/** The slot tab by its label — "Everyday" for the default. */
const slotTab = (page: Page, label: string) => page.locator(`.le-slots [role="tab"]:has-text("${label}")`);

async function openEditor(wall: Installation, page: Page, id: string): Promise<void> {
  await wall.signIn(page);
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(id)}`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
}

/** A "morning" slot on the server, as the editor would have written it. */
async function seedMorning(wall: Installation, id: string): Promise<void> {
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: id,
      orientation: 'portrait',
      slot: 'morning',
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [
        { id: 'm-clock', type: 'clock', x: 0.05, y: 0.05, w: 0.9, h: 0.2, z: 0 },
        { id: 'm-note', type: 'notes', x: 0.05, y: 0.3, w: 0.9, h: 0.3, z: 1, config: { text: 'Bags by the door' } },
      ],
      background: null,
    }),
  });
  expect(saved.status).toBe(200);
}

describe('a named canvas in the editor', () => {
  it('keeps the standalone Background picker on screen on a phone', async () => {
    const wall = await fresh();
    const id = await wall.pairWall('Phone wall');
    applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
    const context = await (await browser()).newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await openEditor(wall, page, id);
      await page.locator('.le-background-btn').click();
      const bounds = await page.locator('.le-background-pop').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(await page.locator('.le-background-pop .le-pop-sub').textContent()).toContain('Portrait · Everyday');
      await page.keyboard.press('Escape');
      expect(await page.locator('.le-background-pop').isVisible()).toBe(false);
      expect(await page.locator('.le-background-btn').evaluate((button) => document.activeElement === button)).toBe(true);
    } finally {
      await context.close();
    }
  }, SLOW);

  it('opens the everyday background from Look, even after editing a timed layout', async () => {
    const wall = await fresh();
    const id = await wall.pairWall('Editor wall');
    applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
    await seedMorning(wall, id);
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await openEditor(wall, page, id);
      await slotTab(page, 'morning').click();
      await page.locator('[data-mode="settings"]').click();
      await page.locator('[data-wset="look"]').click();
      await page.locator('[data-open-background="landscape"]').click();
      expect(await page.locator('[data-mode="layout"]').getAttribute('aria-selected')).toBe('true');
      expect(await page.locator('.le-orient-btn:has-text("Landscape")').getAttribute('aria-pressed')).toBe('true');
      expect(await slotTab(page, 'Everyday').getAttribute('aria-selected')).toBe('true');
      expect(await page.locator('.le-background-pop').isVisible()).toBe(true);
      expect(await page.locator('.le-canvas-pop:not(.le-background-pop)').isVisible()).toBe(false);
      expect(await page.locator('.le-bg select').evaluate((element) => document.activeElement === element)).toBe(true);
      await page.locator('.le-tool-btn:has-text("Layout")').click();
      expect(await page.locator('.le-background-pop').isVisible()).toBe(false);
      expect(await page.locator('.le-canvas-pop:not(.le-background-pop)').isVisible()).toBe(true);
      expect(await page.locator('.le-canvas-pop:not(.le-background-pop) .le-bg').count()).toBe(0);
    } finally {
      await context.close();
    }
  }, SLOW);

  it(
    'keeps an edit on one slot dirty across a switch, clears it on undo, and saves both slots',
    async () => {
      const wall = await fresh();
      const id = await wall.pairWall('Editor wall');
      applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
      await seedMorning(wall, id);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        const posted: { orientation: string; slot: string | undefined }[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().endsWith('/admin/layout')) {
            const body = JSON.parse(request.postData() ?? '{}') as { orientation?: string; slot?: string };
            posted.push({ orientation: body.orientation ?? '?', slot: body.slot });
          }
        });
        await openEditor(wall, page, id);

        // The tabs: Everyday first and selected, then the slot.
        await expect.poll(() => slotTab(page, 'morning').count()).toBe(1);
        expect(await slotTab(page, 'Everyday').getAttribute('aria-selected')).toBe('true');
        expect(await saveEnabled(page), 'a freshly opened editor reports unsaved work').toBe(false);
        const everydayStart = await canvasState(page);

        // Edit slot B (morning), switch to A (Everyday): the bar stays live.
        await slotTab(page, 'morning').click();
        await page.waitForTimeout(250);
        expect(await slotTab(page, 'morning').getAttribute('aria-selected')).toBe('true');
        const morningStart = await canvasState(page);
        expect(morningStart, 'the morning tab drew the everyday canvas').not.toBe(everydayStart);
        expect((await boxes(page)).map((b) => b.id).sort()).toEqual(['m-clock', 'm-note']);
        await dragBox(page, 0, 60, 80);
        const morningMoved = await canvasState(page);
        expect(morningMoved).not.toBe(morningStart);
        await slotTab(page, 'Everyday').click();
        await page.waitForTimeout(250);
        expect(await canvasState(page), 'switching slots changed the everyday canvas').toBe(everydayStart);
        expect(await saveEnabled(page), 'the unsaved morning canvas was forgotten on the way to Everyday').toBe(true);
        expect(posted, 'the slot tab wrote to the server').toEqual([]);

        // Undo back to the start on B: the bar reports clean.
        await slotTab(page, 'morning').click();
        await page.waitForTimeout(250);
        expect(await canvasState(page), 'the edit on morning was lost across the switch').toBe(morningMoved);
        await page.locator('.le-overlay .le-widget').first().click();
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);
        expect(await canvasState(page)).toBe(morningStart);
        expect(await saveEnabled(page), 'undone to where it started, and the bar still says unsaved').toBe(false);

        // Edit both, Save: both are posted, the named one with its slot.
        await dragBox(page, 0, 40, 60);
        const morningSaved = await canvasState(page);
        await slotTab(page, 'Everyday').click();
        await page.waitForTimeout(250);
        await dragBox(page, 0, -30, 50);
        const everydaySaved = await canvasState(page);
        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(
          posted.map((one) => `${one.orientation}:${one.slot ?? ''}`).sort(),
          'Save wrote one canvas, so the other slot lost its arrangement',
        ).toEqual(['portrait:', 'portrait:morning']);

        // Both survived the reload, each under its own name.
        expect(await canvasState(page)).toBe(everydaySaved);
        await slotTab(page, 'morning').click();
        await page.waitForTimeout(250);
        expect(await canvasState(page)).toBe(morningSaved);
        expect(await saveEnabled(page)).toBe(false);
        expect(readLayoutWidgets(wall.db, id, 'portrait', 'morning').map((w) => w.id).sort()).toEqual(['m-clock', 'm-note']);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'starts a new layout from the one on screen, saves it under its name, and removes it again',
    async () => {
      const wall = await fresh();
      const id = await wall.pairWall('Editor wall');
      applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page, id);
        const everyday = await boxes(page);

        // A wall with no named layout draws no slot tabs at all — the toolbar
        // has no row to spare on a phone — so the way in is the Layout popover.
        expect(await page.locator('.le-slots').isVisible()).toBe(false);
        page.once('dialog', (dialog) => void dialog.accept('School Run'));
        await page.click('.le-bar-main button:has-text("Layout")');
        await page.click('.le-pop-slots button:has-text("New layout")');
        await page.waitForTimeout(250);
        // Named as a key, shown as typed-and-slugged, and selected.
        await expect.poll(() => slotTab(page, 'school-run').count()).toBe(1);
        expect(await slotTab(page, 'school-run').getAttribute('aria-selected')).toBe('true');
        // A copy of what was there: the same boxes at the same places, with
        // ids of their own so the two canvases cannot share a row.
        const copied = await boxes(page);
        expect(copied.map((b) => [b.x, b.y])).toEqual(everyday.map((b) => [b.x, b.y]));
        expect(copied.map((b) => b.id).filter((one) => everyday.some((b) => b.id === one))).toEqual([]);
        expect(await saveEnabled(page), 'a new layout is unsaved work and the bar says nothing').toBe(true);

        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(readLayoutSlots(wall.db, id)).toEqual(['school-run']);
        expect(readLayoutWidgets(wall.db, id, 'portrait', 'school-run')).toHaveLength(everyday.length);
        // The everyday canvas is exactly what it was.
        expect(readLayoutWidgets(wall.db, id, 'portrait').map((w) => w.id).sort()).toEqual(
          everyday.map((b) => b.id).sort(),
        );
        // And the settings pane now offers a rule for it.
        expect(await page.locator('select[name="schedule_slot_1"] option[value="school-run"]').count()).toBe(1);

        // Remove it: confirmed, gone from the server, gone from the bar.
        await slotTab(page, 'school-run').click();
        await page.waitForTimeout(250);
        page.once('dialog', (dialog) => void dialog.accept());
        await page.click('.le-bar-main button:has-text("Layout")');
        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined),
          page.click('.le-pop-slots button:has-text("Remove layout")'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(readLayoutSlots(wall.db, id)).toEqual([]);
        await expect.poll(() => slotTab(page, 'school-run').count()).toBe(0);
        expect(await slotTab(page, 'Everyday').getAttribute('aria-selected')).toBe('true');
        expect((await boxes(page)).map((b) => b.id).sort()).toEqual(everyday.map((b) => b.id).sort());
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

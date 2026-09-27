/**
 * The layout editor's named canvases (RFC 014 §5.2), driven.
 *
 * Every layout and its hours are in one menu, under the button naming the
 * layout on screen ("Everyday ▾"). Four things, each the editor's own
 * promise about slots rather than the wall's about drawing them:
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
 *    New timed layout copies the canvas on screen under a name typed into the
 *    menu, Save writes it under that name, Remove takes it off the server and
 *    the row out of the menu;
 *  - **hours are set beside the layout they belong to**, are unsaved work
 *    like a moved box, are posted after the layouts they name, and a
 *    half-typed one is refused by name before anything is written.
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
import { readLayoutSchedule, readLayoutSlots, readLayoutWidgets } from '../src/api/queries.js';

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

/** The layout on screen, as the button above the wall names it. */
const onScreen = async (page: Page): Promise<string> =>
  ((await page.locator('.le-layouts-name').textContent()) ?? '').trim();

const menuOpen = (page: Page): Promise<boolean> => page.locator('.le-layouts-pop').isVisible();

/** A layout's row in the menu — '' is Everyday. */
const layoutRow = (page: Page, slot: string) => page.locator(`.le-layout-row[data-slot="${slot}"]`);

/** Choose a layout from the menu, then close it so the canvas is clear to drag. */
async function chooseLayout(page: Page, slot: string): Promise<void> {
  if (!(await menuOpen(page))) await page.locator('.le-layouts-btn').click();
  await layoutRow(page, slot).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

async function openEditor(wall: Installation, page: Page, id: string): Promise<void> {
  await wall.signIn(page);
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(id)}`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
}

/** A named slot on the server, as the editor would have written it — "morning" by default. */
async function seedMorning(wall: Installation, id: string, slot = 'morning'): Promise<void> {
  const tag = slot === 'morning' ? 'm' : slot;
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen: id,
      orientation: 'portrait',
      slot,
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [
        { id: `${tag}-clock`, type: 'clock', x: 0.05, y: 0.05, w: 0.9, h: 0.2, z: 0 },
        { id: `${tag}-note`, type: 'notes', x: 0.05, y: 0.3, w: 0.9, h: 0.3, z: 1, config: { text: 'Bags by the door' } },
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

  /*
   * A panel draws one layout — the server refuses a slot at one — so its
   * editor offers no Layouts menu, and nothing hands it a timed layout.
   */
  it('offers no Layouts menu on an e-paper panel', async () => {
    const wall = await fresh();
    await wall.post('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const panel = wall.db
      .prepare("select id from screens where kind = 'epaper' limit 1")
      .get() as { id: string };
    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/epaper/${encodeURIComponent(panel.id)}/design`, { waitUntil: 'load' });
      await page.waitForSelector('.le-panel-chip', { state: 'visible', timeout: 20_000 });
      expect(await page.locator('.le-layouts-btn').count()).toBe(0);
      expect(await page.locator('.le-slot-note').isVisible()).toBe(false);
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
      await chooseLayout(page, 'morning');
      expect(await onScreen(page)).toBe('morning');
      await page.locator('[data-mode="settings"]').click();
      await page.locator('[data-wset="look"]').click();
      await page.locator('[data-open-background="landscape"]').click();
      expect(await page.locator('[data-mode="layout"]').getAttribute('aria-selected')).toBe('true');
      expect(await page.locator('.le-orient-btn:has-text("Landscape")').getAttribute('aria-pressed')).toBe('true');
      expect(await onScreen(page)).toBe('Everyday');
      expect(await page.locator('.le-background-pop').isVisible()).toBe(true);
      expect(await page.locator('.le-size-pop').isVisible()).toBe(false);
      expect(await page.locator('.le-bg select').evaluate((element) => document.activeElement === element)).toBe(true);
      await page.locator('.le-size-btn').click();
      expect(await page.locator('.le-background-pop').isVisible()).toBe(false);
      expect(await page.locator('.le-size-pop').isVisible()).toBe(true);
      expect(await page.locator('.le-size-pop .le-bg').count()).toBe(0);
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

        // The menu: Everyday first and on screen, then the slot.
        expect(await onScreen(page)).toBe('Everyday');
        await page.locator('.le-layouts-btn').click();
        expect(await layoutRow(page, '').getAttribute('aria-pressed')).toBe('true');
        expect(await layoutRow(page, 'morning').count()).toBe(1);
        await page.keyboard.press('Escape');
        expect(await saveEnabled(page), 'a freshly opened editor reports unsaved work').toBe(false);
        const everydayStart = await canvasState(page);

        // Edit slot B (morning), switch to A (Everyday): the bar stays live.
        await chooseLayout(page, 'morning');
        expect(await onScreen(page)).toBe('morning');
        const morningStart = await canvasState(page);
        expect(morningStart, 'the morning tab drew the everyday canvas').not.toBe(everydayStart);
        expect((await boxes(page)).map((b) => b.id).sort()).toEqual(['m-clock', 'm-note']);
        await dragBox(page, 0, 60, 80);
        const morningMoved = await canvasState(page);
        expect(morningMoved).not.toBe(morningStart);
        await chooseLayout(page, '');
        expect(await canvasState(page), 'switching slots changed the everyday canvas').toBe(everydayStart);
        expect(await saveEnabled(page), 'the unsaved morning canvas was forgotten on the way to Everyday').toBe(true);
        expect(posted, 'choosing a layout wrote to the server').toEqual([]);

        // Undo back to the start on B: the bar reports clean.
        await chooseLayout(page, 'morning');
        expect(await canvasState(page), 'the edit on morning was lost across the switch').toBe(morningMoved);
        await page.locator('.le-overlay .le-widget').first().click();
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);
        expect(await canvasState(page)).toBe(morningStart);
        expect(await saveEnabled(page), 'undone to where it started, and the bar still says unsaved').toBe(false);

        // Edit both, Save: both are posted, the named one with its slot.
        await dragBox(page, 0, 40, 60);
        const morningSaved = await canvasState(page);
        await chooseLayout(page, '');
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
        await chooseLayout(page, 'morning');
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
    'starts a new layout from the one on screen, gives it hours, saves both, and removes it again',
    async () => {
      const wall = await fresh();
      const id = await wall.pairWall('Editor wall');
      applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        const posted: string[] = [];
        page.on('request', (request) => {
          if (request.method() !== 'POST') return;
          if (request.url().endsWith('/admin/layout')) {
            posted.push(`layout:${(JSON.parse(request.postData() ?? '{}') as { slot?: string }).slot ?? ''}`);
          } else if (request.url().endsWith('/admin/layout/schedule')) {
            posted.push('hours');
          }
        });
        await openEditor(wall, page, id);
        const everyday = await boxes(page);

        // The button is there on a wall with one layout, because its menu is
        // where the first timed layout is made — a control that appears only
        // after its own first use is one nobody finds.
        expect(await page.locator('.le-layouts-btn').isVisible()).toBe(true);
        expect(await onScreen(page)).toBe('Everyday');
        // Wall settings › Layouts says what a timed layout is and hands its
        // button to the editor, which opens the menu on a name.
        await page.locator('[data-mode="settings"]').click();
        await page.locator('[data-wset="design"]').click();
        expect(await page.locator('#wset-design .wset-steps').isVisible()).toBe(true);
        await page.click('#wset-design [data-new-layout]');
        expect(await page.locator('[data-mode="layout"]').getAttribute('aria-selected')).toBe('true');
        await expect.poll(() => menuOpen(page)).toBe(true);
        const name = page.locator('.le-new-name input');
        await expect.poll(() => name.evaluate((input) => document.activeElement === input)).toBe(true);
        // A name that slugs to nothing is asked for again with the reason,
        // rather than dropped in silence — which from outside is a button
        // that does nothing.
        await name.fill('!!!');
        await name.press('Enter');
        expect(await page.locator('.le-new-layout .le-hours-error').textContent()).toContain('Use letters or numbers');
        expect(await layoutRow(page, '').getAttribute('aria-pressed')).toBe('true');
        await name.fill('School Run');
        await name.press('Enter');
        // Named as a key, shown as typed-and-slugged, on screen — and the menu
        // stays open on its hours, with the cursor in the first one.
        expect(await onScreen(page)).toBe('school-run');
        expect(await layoutRow(page, 'school-run').getAttribute('aria-pressed')).toBe('true');
        expect(await layoutRow(page, 'school-run').textContent()).toContain('not saved yet');
        expect(await layoutRow(page, 'school-run').textContent()).toContain('No hours yet, so never shown');
        const from = page.locator('.le-hours input[data-hours="from"]');
        const until = page.locator('.le-hours input[data-hours="to"]');
        expect(await from.evaluate((input) => document.activeElement === input)).toBe(true);
        // A copy of what was there: the same boxes at the same places, with
        // ids of their own so the two canvases cannot share a row.
        const copied = await boxes(page);
        expect(copied.map((b) => [b.x, b.y])).toEqual(everyday.map((b) => [b.x, b.y]));
        expect(copied.map((b) => b.id).filter((one) => everyday.some((b) => b.id === one))).toEqual([]);
        expect(await saveEnabled(page), 'a new layout is unsaved work and the bar says nothing').toBe(true);
        expect(await page.locator('.le-slot-note').textContent()).toContain('is new. Give it hours');

        // Hours, typed beside the layout they belong to: every line in the
        // menu and the note under the toolbar follow as they are typed.
        await from.fill('06:30');
        await until.fill('08:30');
        expect(await layoutRow(page, 'school-run').textContent()).toContain('Shown 06:30–08:30');
        expect(await layoutRow(page, '').textContent()).toContain('Shown the rest of the time');
        expect(await page.locator('.le-slot-note').textContent()).toContain('shows 06:30–08:30 every day');

        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        // The layout first and its hours after, so the server holds the
        // layout the hours name by the time they arrive.
        expect(posted.filter((one) => one !== 'layout:')).toEqual(['layout:school-run', 'hours']);
        expect(readLayoutSlots(wall.db, id)).toEqual(['school-run']);
        expect(readLayoutSchedule(wall.db, id)).toEqual([{ slot: 'school-run', from: '06:30', to: '08:30' }]);
        expect(readLayoutWidgets(wall.db, id, 'portrait', 'school-run')).toHaveLength(everyday.length);
        // The everyday canvas is exactly what it was.
        expect(readLayoutWidgets(wall.db, id, 'portrait').map((w) => w.id).sort()).toEqual(
          everyday.map((b) => b.id).sort(),
        );
        // And Wall settings › Layouts says so, in the menu's own words.
        expect(await page.locator('#wset-design').textContent()).toContain('Shown 06:30–08:30');

        // A half-typed time is refused by name before anything is written,
        // with the menu opened on it; taking it away leaves nothing unsaved.
        await chooseLayout(page, 'school-run');
        await page.locator('.le-layouts-btn').click();
        await page.locator('.le-hours-more').click();
        await page.locator('.le-hours input[data-hours="from"]').nth(1).fill('15:00');
        expect(await saveEnabled(page)).toBe(true);
        posted.length = 0;
        await page.keyboard.press('Escape');
        await page.click('[data-action="save"]');
        await expect.poll(() => page.locator('#savebar .msg').textContent()).toContain('Give school-run both times');
        await expect.poll(() => menuOpen(page)).toBe(true);
        expect(await page.locator('.le-hours-error').textContent()).toContain('both times');
        expect(posted, 'a refused time wrote to the server anyway').toEqual([]);
        await page.locator('.le-hours-drop').nth(1).click();
        expect(await saveEnabled(page), 'the time was taken away and the bar still says unsaved').toBe(false);

        // Remove it from its own menu: confirmed, gone from the server, its
        // hours with it, gone from the menu.
        page.once('dialog', (dialog) => void dialog.accept());
        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }).catch(() => undefined),
          page.click('.le-layouts-remove'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(readLayoutSlots(wall.db, id)).toEqual([]);
        expect(readLayoutSchedule(wall.db, id)).toEqual([]);
        expect(await onScreen(page)).toBe('Everyday');
        await page.locator('.le-layouts-btn').click();
        expect(await layoutRow(page, 'school-run').count()).toBe(0);
        expect(await layoutRow(page, '').textContent()).toContain('Shown all day');
        expect((await boxes(page)).map((b) => b.id).sort()).toEqual(everyday.map((b) => b.id).sort());
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    'opens from Wall settings, sets two layouts’ hours in written order, and says where they overlap',
    async () => {
      const wall = await fresh();
      const id = await wall.pairWall('Editor wall');
      applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
      await seedMorning(wall, id);
      await seedMorning(wall, id, 'evening');
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        const sent: unknown[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().endsWith('/admin/layout/schedule')) {
            sent.push((JSON.parse(request.postData() ?? '{}') as { rules?: unknown }).rules);
          }
        });
        await openEditor(wall, page, id);
        await page.locator('[data-mode="settings"]').click();
        await page.locator('[data-wset="design"]').click();
        expect(await page.locator('#wset-design').textContent()).toContain('No hours yet, so never shown');
        await page.click('#wset-design [data-open-layouts]');
        expect(await page.locator('[data-mode="layout"]').getAttribute('aria-selected')).toBe('true');
        await expect.poll(() => menuOpen(page)).toBe(true);
        expect(await layoutRow(page, '').textContent()).toContain('Shown all day');
        expect(await layoutRow(page, 'morning').textContent()).toContain('No hours yet, so never shown');
        // Nothing to set on Everyday: it is what the wall shows outside every
        // timed layout's hours.
        expect(await page.locator('.le-hours').count()).toBe(0);

        await layoutRow(page, 'morning').click();
        expect(await menuOpen(page), 'choosing a layout closed the menu it was chosen from').toBe(true);
        await page.locator('.le-hours input[data-hours="from"]').fill('06:30');
        await page.locator('.le-hours input[data-hours="to"]').fill('08:30');
        await layoutRow(page, 'evening').click();
        expect(await onScreen(page)).toBe('evening');
        expect(await page.locator('.le-hours-title').textContent()).toBe('When evening shows');
        await page.locator('.le-hours input[data-hours="from"]').fill('07:00');
        await page.locator('.le-hours input[data-hours="to"]').fill('09:00');
        expect(await page.locator('.le-layouts-overlap').textContent()).toBe(
          'morning and evening overlap from 07:00. There the wall shows morning, whose hours were set first.',
        );
        expect(await layoutRow(page, '').textContent()).toContain('Shown the rest of the time');

        await page.keyboard.press('Escape');
        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(sent).toEqual([
          [
            { slot: 'morning', from: '06:30', to: '08:30' },
            { slot: 'evening', from: '07:00', to: '09:00' },
          ],
        ]);
        expect(readLayoutSchedule(wall.db, id)).toEqual([
          { slot: 'morning', from: '06:30', to: '08:30' },
          { slot: 'evening', from: '07:00', to: '09:00' },
        ]);
        // Opened again, it reads back what was saved and reports nothing unsaved.
        await page.locator('.le-layouts-btn').click();
        expect(await layoutRow(page, 'evening').textContent()).toContain('Shown 07:00–09:00');
        expect(await saveEnabled(page)).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

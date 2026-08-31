/**
 * RFC 009 Phase 5 — the editor, driven, at the things that make it safe.
 *
 * Phase 0's five tests already open a browser on this editor and prove a drag
 * survives a save and that the leave-guard fires. What they could not ask, and
 * what this file exists for, is everything Phase 5 changed:
 *
 *  - **undo, across every kind of mutation**, because an undo that works for
 *    delete and not for a drag is worse than none — it teaches a household to
 *    trust it right up to the edit that loses their afternoon;
 *  - **the keyboard**, which could select a widget and do nothing else with it:
 *    selecting rebuilt the whole overlay, so the box that had focus was
 *    destroyed by the act of choosing it;
 *  - **the 12px resize handle**, in an editor this project redesigned for
 *    phones, whose target is now 44px with nothing moved;
 *  - **the orientation toggle**, which performed a hidden save, discarded the
 *    outcome and cleared the dirty flag either way — so a save that failed was
 *    reported as a success;
 *  - **the phone**, whose first 386 pixels were chrome.
 *
 * Everything here is measured or driven rather than read out of the markup, for
 * the reason `CLAUDE.md` gives at length: a class can be applied while the
 * pixels are wrong, and "the frame changed" never proves a control was read.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { applyTemplate } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';

process.env['TZ'] = 'UTC';

/** Long, because each of these boots a server, a browser context and an editor. */
const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(options?: Parameters<typeof install>[0]): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

// ---------------------------------------------------------------------------
// Driving the editor
// ---------------------------------------------------------------------------

interface EditorBox {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
}

/** Sign in the way a household does, then open a wall's editor. */
async function openEditor(wall: Installation, page: Page): Promise<void> {
  /*
   * On Classic's full canvas, always.
   *
   * A new wall is now seeded with the Classic *variant* matching what the
   * household has set up, so a fresh install with nothing configured has no
   * Shift box and a full-width clock (see `templates/classic.ts`). These tests
   * are about the editor rather than about the seed, and two of them need what
   * that canvas no longer has: a Shift widget to open a ladder on, and a box
   * narrow enough that typing an x of 37 is not clamped to what a 90%-wide box
   * can take. Stating the canvas is also what stops a future change to the
   * seed silently re-answering an editor question.
   */
  applyTemplate(wall.db, null, CLASSIC_TEMPLATE);
  await wall.signIn(page);
  await page.goto(`${wall.base}/admin/displays/default`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
}

/**
 * Every box on the canvas, from the canvas itself.
 *
 * Read out of the overlay rather than out of the mount's `data-json`, which is
 * what the *server* sent and never changes while the editor is open. The
 * inline percentages are what `positionBox` writes, so this is the editor's
 * live opinion of where each widget is.
 */
const boxes = (page: Page): Promise<EditorBox[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')].map((el) => ({
      id: el.dataset['id'] ?? '',
      label: (el.querySelector('.le-widget-label')?.textContent ?? '').trim(),
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      w: parseFloat(el.style.width),
      h: parseFloat(el.style.height),
      z: Number(el.style.zIndex),
    })),
  );

/**
 * The canvas as one comparable string — position, size, stacking and names.
 *
 * Stacking as a *rank* rather than the raw z, because a save renumbers: the
 * server is posted `z` as the index in back-to-front order, so a canvas whose
 * live values are 0,1,2,3,5 comes back 0,1,2,3,4. The order is the thing that
 * means anything, and comparing the numbers instead would report a difference
 * on every save that had none.
 */
async function canvasState(page: Page): Promise<string> {
  const placed = await boxes(page);
  const rank = new Map(
    placed
      .slice()
      .sort((a, b) => a.z - b.z)
      .map((one, index) => [one.id, index] as const),
  );
  return JSON.stringify(
    placed
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((one) => [one.id, one.label, one.x, one.y, one.w, one.h, rank.get(one.id)]),
  );
}

/** Drag a box from its middle, which is the grab that is not the handle. */
async function dragBox(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const box = page.locator('.le-overlay .le-widget').nth(index);
  const rect = await box.boundingBox();
  if (rect === null) throw new Error('that widget has no box to drag');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

/** Undo the way a household does, with the keyboard. */
async function pressUndo(page: Page): Promise<void> {
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(120);
}

// ===========================================================================
// 1 · Undo, across every mutation type
// ===========================================================================

describe('1 · the undo stack', () => {
  /**
   * Every way the canvas can change, changed and taken back.
   *
   * The list is the point. An undo that covers delete and not a drag is the
   * one that will lose somebody's afternoon, because delete is the mutation
   * they were already careful with — the RFC's fault is "an accidental drag
   * after twenty minutes of arranging", and its only recovery was Discard
   * changes, which is `location.reload()` and throws away the twenty minutes.
   *
   * Each step asserts three things in order: the canvas changed, Ctrl+Z put it
   * back exactly, and it was the *whole* canvas that came back rather than the
   * one property being looked at.
   */
  it(
    'takes back a drag, a resize, a nudge, an add, a duplicate, a delete, a restack and a setting',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const step = async (name: string, mutate: () => Promise<void>): Promise<void> => {
          const before = await canvasState(page);
          await mutate();
          await page.waitForTimeout(120);
          const after = await canvasState(page);
          expect(after, `${name} changed nothing, so its undo proves nothing`).not.toBe(before);
          await pressUndo(page);
          expect(await canvasState(page), `undo did not take back ${name}`).toBe(before);
        };

        await step('a drag', () => dragBox(page, 0, 60, 80));

        await step('a resize', async () => {
          const handle = page.locator('.le-overlay .le-widget').first().locator('.le-handle');
          const rect = await handle.boundingBox();
          if (rect === null) throw new Error('no resize handle');
          await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.mouse.down();
          await page.mouse.move(rect.x + rect.width / 2 - 70, rect.y + rect.height / 2 - 40, {
            steps: 6,
          });
          await page.mouse.up();
        });

        await step('an arrow key', async () => {
          await page.locator('.le-overlay .le-widget').first().focus();
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowRight');
        });

        await step('adding a widget', async () => {
          await page.click('.le-add-primary');
          await page.click('.le-modal-item:has-text("Clock")');
        });

        await step('duplicating one', async () => {
          await page.locator('.le-overlay .le-widget').first().click();
          await page.click('.insp-actions button');
        });

        await step('removing one', async () => {
          await page.locator('.le-overlay .le-widget').first().click();
          await page.click('.insp-remove');
        });

        await step('restacking in the Layers list', async () => {
          await page.click('.le-layers-btn');
          const rows = page.locator('.le-layer');
          const last = await rows.last().locator('.le-layer-grip').boundingBox();
          const first = await rows.first().boundingBox();
          if (last === null || first === null) throw new Error('no layer rows to drag');
          await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
          await page.mouse.down();
          await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 6 });
          await page.mouse.up();
          await page.click('.le-layers-btn');
        });

        /*
         * A setting is a mutation too, and this one is pressed with the focus
         * still on the control — which is where a household's hand is when they
         * change their mind. The Ctrl+Z guard has to let a checkbox through
         * while leaving a title being typed alone.
         */
        const showTitle = page.locator('.le-config .switch input[type=checkbox]').first();
        const before = await canvasState(page);
        await page.locator('.le-overlay .le-widget').first().click();
        await page.click('.insp-tab:has-text("Style")');
        await showTitle.click();
        expect(await showTitle.isChecked()).toBe(true);
        await pressUndo(page);
        expect(
          await page.locator('.le-config .switch input[type=checkbox]').first().isChecked(),
          'Ctrl+Z with the focus still on a checkbox did nothing — the guard that ' +
            'protects a title being typed is refusing a control with no undo of its own.',
        ).toBe(false);
        // And the rest of the canvas is where the selection click left it.
        expect(await canvasState(page)).toBe(before);

        /*
         * A ladder edit is one step too, not two.
         *
         * Writing a field list also clears the switches it supersedes, and the
         * clear happens first — so a snapshot taken inside `setConfig` restores
         * the list and leaves the cleared keys deleted. Recording around the
         * pair is the fix, and one Ctrl+Z putting the row back is what proves
         * it is a pair rather than two steps.
         */
        const shift = (await boxes(page)).find((one) => one.label === 'Shift');
        await page.locator(`.le-overlay .le-widget[data-id="${shift?.id ?? ''}"]`).click();
        await page.click('.insp-tab:has-text("Content")');
        // By name, not by position: unticking a rung rewrites the list and
        // moves the row it was on to the bottom, so "the first checkbox" is a
        // different field by the time anything reads it back.
        const rung = (): ReturnType<typeof page.locator> =>
          page.locator('.le-ladder-row[data-field="hours"] input[type=checkbox]');
        expect(await rung().isChecked(), 'the shift ladder opened with its hours rung off').toBe(
          true,
        );
        await rung().click();
        await page.waitForTimeout(200);
        expect(await rung().isChecked()).toBe(false);
        await pressUndo(page);
        expect(
          await rung().isChecked(),
          'one Ctrl+Z did not take back one ladder edit — the clear and the write ' +
            'are two steps rather than one',
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * Removing a widget no longer asks, because the answer it offered was wrong.
   *
   * The dialogue's reassurance was "Discard changes brings it back" — and
   * Discard is a reload, which brings back every *other* edit's absence too. A
   * confirmation nominating a substitute for an undo that does not exist is a
   * confirmation that should be an undo.
   */
  it(
    'deletes without a dialogue, and Ctrl+Z brings the widget back with its options',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        let asked = false;
        page.on('dialog', (dialog) => {
          asked = true;
          void dialog.accept();
        });

        // Give the widget an option first, so what comes back is the widget
        // and not a fresh one with its name.
        await page.locator('.le-overlay .le-widget').first().click();
        await page.click('.insp-tab:has-text("Style")');
        await page.locator('.le-config .switch input[type=checkbox]').first().check();
        await page.waitForTimeout(120);
        const before = await canvasState(page);
        const removed = (await boxes(page))[0]?.id;

        await page.click('.insp-remove');
        await page.waitForTimeout(150);
        expect(asked, 'removing a widget still asks, and undo has made the question wrong').toBe(
          false,
        );
        expect((await boxes(page)).some((one) => one.id === removed)).toBe(false);

        await pressUndo(page);
        expect(await canvasState(page)).toBe(before);
        // The options came back with it: select it again and read the switch.
        await page.locator(`.le-overlay .le-widget[data-id="${removed ?? ''}"]`).click();
        await page.click('.insp-tab:has-text("Style")');
        expect(
          await page.locator('.le-config .switch input[type=checkbox]').first().isChecked(),
          'the widget came back without the options it was carrying',
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * And the shortcut belongs to the pane the canvas is on.
   *
   * The wall's page has two: Layout, and Wall settings, which hides the editor
   * entirely. A Ctrl+Z typed over a settings control would otherwise step the
   * canvas back with nobody able to see it happen — and the next Save writes
   * whatever the canvas is by then.
   */
  it(
    'leaves the canvas alone when the Wall settings pane is the one showing',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await dragBox(page, 0, 40, 60);
        await page.waitForTimeout(150);
        const arranged = await canvasState(page);

        await page.click('[data-mode="settings"]');
        await page.waitForTimeout(150);
        await page.keyboard.press('Control+z');
        await page.keyboard.press('Control+z');
        await page.waitForTimeout(150);

        await page.click('[data-mode="layout"]');
        await page.waitForTimeout(150);
        expect(
          await canvasState(page),
          'Ctrl+Z on the settings pane stepped the canvas back where nobody could see it',
        ).toBe(arranged);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 2 · The keyboard
// ===========================================================================

describe('2 · the keyboard', () => {
  /**
   * An arrow key moves the box, and focus survives it.
   *
   * This is the assertion the whole `selectWidget` change exists for. Selecting
   * used to rebuild the overlay, so the focused box was replaced by a new
   * element mid-keystroke: the first arrow key moved a widget and the second
   * went to the document, which scrolls the page. Nothing about that is visible
   * in the markup — `document.activeElement` is the only place it shows.
   */
  it(
    'nudges a widget by 1%, resizes with Shift, and keeps focus on the box',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const first = page.locator('.le-overlay .le-widget').first();
        const id = (await first.getAttribute('data-id')) ?? '';
        const before = (await boxes(page)).find((one) => one.id === id);
        if (before === undefined) throw new Error('no widget to nudge');

        /*
         * Focused once, then the keys go to the *page*.
         *
         * Not `locator.press()`, which re-resolves the locator and focuses it
         * again before every key — that hands the focus back after each one and
         * hides the exact fault this test exists for. Checked: with selection
         * rebuilding the overlay again, the locator version stays green and
         * this one goes red.
         */
        await first.focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(120);

        const moved = (await boxes(page)).find((one) => one.id === id);
        expect([moved?.x, moved?.y].map((n) => Math.round((n ?? 0) * 10) / 10)).toEqual([
          Math.round((before.x + 2) * 10) / 10,
          Math.round((before.y + 1) * 10) / 10,
        ]);
        expect(
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['id']),
          'focus left the box on the way, so the second arrow key went to the page',
        ).toBe(id);
        // And the page did not scroll instead of the widget moving.
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        // Nudging is editing, so the widget is the one the inspector is on.
        expect(await page.locator('.insp-title').textContent()).toContain('widget');

        // Alt+Left is Back and Cmd+Left is Back — neither is a nudge, and a
        // widget that moved instead would be a browser control taken away.
        await page.keyboard.press('Alt+ArrowLeft');
        await page.keyboard.press('Control+ArrowLeft');
        await page.waitForTimeout(120);
        expect(
          (await boxes(page)).find((one) => one.id === id)?.x,
          'a modifier + arrow moved the widget, so Back does not work here',
        ).toBe(moved?.x);

        await page.keyboard.press('Shift+ArrowRight');
        await page.waitForTimeout(120);
        const bigger = (await boxes(page)).find((one) => one.id === id);
        expect(Math.round(((bigger?.w ?? 0) - (moved?.w ?? 0)) * 10) / 10).toBe(1);
        expect(bigger?.x, 'Shift+arrow moved the box instead of resizing it').toBe(moved?.x);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * The Style tab and the ink lane can be reached without a pointer.
   *
   * Both carried a roving `tabindex` and no arrow handler, which is the worst
   * of both: the inactive tab leaves the tab order, and nothing else reaches
   * it. `display-editor.ts` has had a correct `wireTabs` the whole time — it is
   * one module now and both editors import it.
   *
   * The ink lane needs a panel actually following this wall, which is the same
   * gate the server puts on sending the tables at all.
   */
  it(
    'reaches Style, and the ink lane, with the arrow keys',
    async () => {
      const wall = await fresh();
      // A panel that follows the Default wall, so the lane is offered here.
      await wall.post('/admin/epaper', {
        name: 'Hall panel',
        preset: 'seeed-7in5',
        rotation: '0',
      });
      const panel = wall.db
        .prepare("select id from screens where kind = 'epaper' limit 1")
        .get() as { id: string } | undefined;
      expect(panel?.id, 'no e-paper panel was created, so the lane cannot be tested').toBeTruthy();
      await wall.post(`/admin/epaper/${panel?.id ?? ''}/source`, { source: 'follow:default' });

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await page.locator('.le-overlay .le-widget').first().click();

        // Content is the live tab, so it is the one in the tab order.
        const content = page.locator('.insp-tab').first();
        await content.focus();
        await page.keyboard.press('ArrowRight');
        expect(
          await page.locator('.insp-tab').nth(1).getAttribute('aria-selected'),
          'ArrowRight on the tablist did not reach Style — the roving tabindex is ' +
            'still there with nothing to move it',
        ).toBe('true');
        // And Style is where the numeric position fields live, which are the
        // only way to align two widgets exactly.
        expect(await page.locator('.le-box-grid input[type=number]').count()).toBe(4);
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Style');

        const lane = page.locator('.insp-lane').first();
        expect(await lane.isVisible(), 'no ink lane, so nothing to reach').toBe(true);
        await lane.focus();
        await page.keyboard.press('ArrowRight');
        expect(
          await page.locator('.insp-lane').nth(1).getAttribute('aria-selected'),
          'the ink lane is still pointer-only',
        ).toBe('true');

        /*
         * And "Match the wall again" is a mutation like any other.
         *
         * It drops every override on the widget at once, and it was the one
         * mutation in the editor that took no step back — so the most
         * destructive thing on the panel was also the only unrecoverable one.
         */
        // On the canvas the panel actually draws: the lane picks its panel by
        // orientation, and this one is an 800×480 landscape screen — on
        // portrait it says so instead of offering controls.
        await page.click('.le-orient-btn:has-text("Landscape")');
        await page.waitForTimeout(300);
        const calendar = (await boxes(page)).find((one) => one.label.startsWith('Calendar'));
        expect(calendar, 'the landscape canvas has no calendar to override').toBeDefined();
        await page.locator(`.le-overlay .le-widget[data-id="${calendar?.id ?? ''}"]`).click();
        await page.click('.insp-lane:has-text("On ink")');
        await page.waitForTimeout(200);
        const mode = page.locator('.le-cfg-field[data-cfg-key="mode"] select');
        expect(await mode.count(), 'the ink lane offered no control to override').toBeGreaterThan(0);
        await mode.selectOption('list');
        await page.waitForTimeout(250);

        const reset = page.locator('.insp-ink-reset');
        expect(await reset.count(), 'changing an option on the lane recorded no override').toBe(1);
        await reset.click();
        await page.waitForTimeout(250);
        expect(await page.locator('.insp-ink-reset').count()).toBe(0);

        await page.keyboard.press('Control+z');
        await page.waitForTimeout(250);
        expect(
          await page.locator('.insp-ink-reset').count(),
          'Ctrl+Z did not bring back the overrides "Match the wall again" wiped',
        ).toBe(1);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * The four numbers write the canvas, and the canvas writes them back.
   *
   * A drag lands on a pixel and the snap grid is a twenty-fourth, so "the same
   * left edge as the one above" is otherwise a thing you can approach and never
   * reach. The reverse direction matters as much: a field left showing the old
   * position after a drag gives one widget two positions on one screen, and the
   * number is the one a household would believe.
   */
  it(
    'places a widget by typing, and follows a drag back into the fields',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const first = page.locator('.le-overlay .le-widget').first();
        const id = (await first.getAttribute('data-id')) ?? '';
        await first.click();
        await page.click('.insp-tab:has-text("Style")');

        const x = page.locator('.le-box-grid input[type=number]').first();
        await x.fill('37');
        await page.waitForTimeout(150);
        expect((await boxes(page)).find((one) => one.id === id)?.x).toBe(37);

        // Out of range comes back as what the canvas could take, once the edit
        // is committed — a clamp nobody can see is a field that lies.
        await x.fill('140');
        await x.press('Enter');
        await page.waitForTimeout(150);
        const clamped = (await boxes(page)).find((one) => one.id === id);
        expect(Number(await x.inputValue())).toBe(Math.round(clamped?.x ?? -1));
        expect(Number(await x.inputValue())).toBeLessThan(100);

        /*
         * And a drag writes back into the fields.
         *
         * Dragged by this widget's own box rather than by whatever is topmost
         * at those coordinates: the first cut of this test pushed the widget
         * against the right edge and then grabbed its centre, which by then was
         * underneath another box with a higher z — so it dragged that one, and
         * the fields correctly followed the widget that had actually moved.
         */
        await x.fill('10');
        await x.press('Enter');
        await page.waitForTimeout(150);
        const own = page.locator(`.le-overlay .le-widget[data-id="${id}"]`);
        const rect = await own.boundingBox();
        if (rect === null) throw new Error('the selected widget has no box');
        await page.mouse.move(rect.x + 12, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + 12 + 60, rect.y + rect.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(150);

        const dragged = (await boxes(page)).find((one) => one.id === id);
        expect(dragged?.x, 'the drag moved some other widget').not.toBe(10);
        expect(
          Number(await x.inputValue()),
          'the numeric field kept the old position after a drag',
        ).toBe(Math.round(dragged?.x ?? -1));
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 3 · The resize handle
// ===========================================================================

describe('3 · the resize handle', () => {
  /**
   * 12px drawn, ~30px to hit, and nothing moved.
   *
   * The mark stays exactly where it was — this is the chore tick's idiom, an
   * invisible `::before` with a negative inset — so the assertions are a pair:
   * the drawn square is still 12px, and a press well inside the corner resizes
   * rather than dragging the whole widget.
   *
   * The reachable size is **measured rather than taken from the stylesheet**,
   * and it is not the 44px a symmetric inset reads as: what is reachable is
   * about 30×30 in from the corner, against 12×12 before. Growing it further
   * inward would reach 44 and swallow a small widget's whole drag area — a 5%
   * box on a phone canvas is about 20px.
   *
   * That ceiling used to be an accident of `.le-widget`'s `overflow:hidden`,
   * which clips hit-testing as well as painting. The clip is gone — the widget
   * name chip hangs outside the box now, and a clip would take it away — so the
   * inset stops at the box's own edges instead, and the second measurement
   * below is what holds it there.
   */
  it(
    'takes a press well inside its corner, while the drawn mark stays 12px',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const first = page.locator('.le-overlay .le-widget').first();
        const id = (await first.getAttribute('data-id')) ?? '';
        const handle = first.locator('.le-handle');
        const rect = await handle.boundingBox();
        if (rect === null) throw new Error('no resize handle');
        expect([Math.round(rect.width), Math.round(rect.height)]).toEqual([12, 12]);

        /*
         * The target, as the browser resolves it: walk in from the middle of
         * the drawn square until `elementFromPoint` stops answering the handle.
         * That is the only honest measure — the declaration says 44px and the
         * clip says otherwise.
         */
        const reach = await page.evaluate(
          ([cx, cy]) => {
            const at = (x: number, y: number): boolean =>
              (document.elementFromPoint(x, y)?.className ?? '').toString().includes('le-handle');
            let wide = 0;
            let tall = 0;
            while (wide < 80 && at((cx as number) - wide, cy as number)) wide += 1;
            while (tall < 80 && at(cx as number, (cy as number) - tall)) tall += 1;
            return { wide, tall };
          },
          [rect.x + rect.width / 2, rect.y + rect.height / 2],
        );
        expect(
          [reach.wide, reach.tall],
          `the handle is reachable ${reach.wide}px in and ${reach.tall}px up from ` +
            'its middle — the 12px square is still most of the target',
        ).toEqual([expect.any(Number), expect.any(Number)]);
        expect(reach.wide).toBeGreaterThanOrEqual(22);
        expect(reach.tall).toBeGreaterThanOrEqual(22);

        /*
         * And it stops at the box's own edge.
         *
         * The ceiling used to be free: `.le-widget` was `overflow:hidden`, so
         * the outward half of a symmetric inset was clipped away. The clip is
         * gone — the name chip hangs outside the box now — so the inset is
         * asymmetric and this is what holds it to that. Unpinned, the target
         * reaches 16px past the bottom-right corner and takes presses meant for
         * the neighbour there: a drag that grabs the widget you are not
         * pointing at.
         */
        const boxRect = await first.boundingBox();
        if (boxRect === null) throw new Error('no widget box');
        const outside = await page.evaluate(
          ([right, bottom, midY, midX]) => {
            const name = (x: number, y: number): string =>
              (document.elementFromPoint(x, y)?.className ?? '').toString();
            return {
              past: name((right as number) + 6, midY as number),
              under: name(midX as number, (bottom as number) + 6),
            };
          },
          [
            boxRect.x + boxRect.width,
            boxRect.y + boxRect.height,
            rect.y + rect.height / 2,
            rect.x + rect.width / 2,
          ],
        );
        expect(
          [outside.past.includes('le-handle'), outside.under.includes('le-handle')],
          `the resize target reaches outside its own widget (right: ${outside.past}, ` +
            `below: ${outside.under}), where it takes presses meant for the neighbour`,
        ).toEqual([false, false]);

        const before = (await boxes(page)).find((one) => one.id === id);
        await page.mouse.move(rect.x - 12, rect.y - 12);
        await page.mouse.down();
        await page.mouse.move(rect.x - 12 - 60, rect.y - 12 - 60, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(120);
        const after = (await boxes(page)).find((one) => one.id === id);

        expect(after?.x, 'that press dragged the widget instead of resizing it').toBe(before?.x);
        expect((after?.w ?? 0) < (before?.w ?? 0)).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 4 · The orientation toggle
// ===========================================================================

describe('4 · switching orientation', () => {
  /**
   * It writes nothing, and both canvases survive one Save.
   *
   * The toggle used to post the canvas being left, throw the outcome away and
   * clear the dirty flag regardless — so a save that failed was reported as a
   * success, on the one control a household presses without meaning to save
   * anything. Both canvases are already in the page; what was missing was
   * somewhere to record that the one going into the stash is unsaved.
   *
   * Counted at the network, because "no write happened" is not something the
   * DOM can say.
   */
  it(
    'posts nothing on the toggle, and saves both canvases when Save is pressed',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        const posted: string[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().includes('/admin/layout')) {
            const body = request.postData() ?? '';
            posted.push((JSON.parse(body) as { orientation?: string }).orientation ?? '?');
          }
        });
        await openEditor(wall, page);

        await dragBox(page, 0, 50, 70);
        await page.waitForTimeout(120);
        const portrait = await canvasState(page);

        await page.click('.le-orient-btn:has-text("Landscape")');
        await page.waitForTimeout(250);
        expect(posted, 'the orientation toggle still writes to the server').toEqual([]);
        expect(
          await page.locator('[data-action="save"]').isEnabled(),
          'the unsaved portrait canvas was forgotten on the way to landscape',
        ).toBe(true);

        await dragBox(page, 0, -40, 60);
        await page.waitForTimeout(120);
        const landscape = await canvasState(page);

        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(
          posted.slice().sort(),
          'Save wrote one canvas, so the other orientation lost its arrangement',
        ).toEqual(['landscape', 'portrait']);

        // The editor reopens on the orientation it was left on (landscape), so
        // that is the one to read first.
        expect(await canvasState(page)).toBe(landscape);
        await page.click('.le-orient-btn:has-text("Portrait")');
        await page.waitForTimeout(250);
        expect(await canvasState(page), 'the portrait canvas did not survive').toBe(portrait);
        expect(
          await page.locator('[data-action="save"]').isEnabled(),
          'everything is saved, and the bar still says there is something to save',
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 5 · The screen it is used on
// ===========================================================================

describe('5 · the editor on a phone, a tablet and a desktop', () => {
  /**
   * The canvas gets more than half the phone.
   *
   * Measured before this change: the first pixel of the canvas was 386px down
   * an 844px viewport, and the canvas itself was 388px — 46% of the screen for
   * the thing being edited, and the other 54% for two rows of toolbar, a
   * caption naming the picture beneath it and a mode bar.
   *
   * The bottom edge matters as much as the fraction: the save bar is fixed, so
   * a canvas sized past it puts the resize handle of every widget along its
   * bottom row underneath a bar that cannot be scrolled out of the way.
   */
  it(
    'gives the canvas the screen at 390, 768 and 1440',
    async () => {
      const wall = await fresh();
      for (const [width, height] of [
        [390, 844],
        [768, 1000],
        [1440, 1000],
      ] as const) {
        const context = await (await browser()).newContext({ viewport: { width, height } });
        try {
          const page = await context.newPage();
          await openEditor(wall, page);
          const seen = await page.evaluate(() => {
            const canvas = document.querySelector('.le-canvas')?.getBoundingClientRect();
            const bar = document.getElementById('savebar')?.getBoundingClientRect();
            const toolbar = document.querySelector('.le-toolbar')?.getBoundingClientRect();
            return {
              canvasTop: Math.round((canvas?.top ?? 0) + window.scrollY),
              canvasHeight: Math.round(canvas?.height ?? 0),
              canvasBottom: Math.round((canvas?.bottom ?? 0) + window.scrollY),
              toolbarTop: Math.round((toolbar?.top ?? 0) + window.scrollY),
              barTop: Math.round(bar?.top ?? 0),
              scrollWidth: document.documentElement.scrollWidth,
              viewport: window.innerHeight,
            };
          });

          const half = seen.viewport / 2;
          expect(
            seen.canvasHeight,
            `at ${width}px the canvas is ${seen.canvasHeight}px of a ${seen.viewport}px ` +
              'viewport, which is less than half the screen for the thing being edited',
          ).toBeGreaterThan(half);
          /*
           * And it stops above the save bar — on the widths where the canvas is
           * meant to be whole on screen at once. On a desktop it is deliberately
           * taller than the room below the chrome and the household scrolls to
           * its foot, where the bar is 63px of a 1000px viewport rather than the
           * bottom third of a phone.
           */
          if (width < 900) {
            expect(
              seen.canvasBottom,
              `at ${width}px the canvas runs under the fixed save bar, so the resize ` +
                'handles along its bottom edge cannot be reached',
            ).toBeLessThanOrEqual(seen.barTop + 1);
          }
          expect(
            seen.scrollWidth,
            `at ${width}px the editor scrolls sideways`,
          ).toBeLessThanOrEqual(width);
          // And the first control is near the top rather than a screenful down.
          expect(
            seen.toolbarTop,
            `at ${width}px the first editing control is ${seen.toolbarTop}px down`,
          ).toBeLessThan(seen.viewport * 0.3);
        } finally {
          await context.close();
        }
      }
    },
    SLOW,
  );

  /**
   * And the canvas scales with a desktop viewport instead of stopping at 720px.
   *
   * Measured before this change, on a portrait 1080x1920 wall: the canvas was
   * 383px wide at 1280 **and at 1440** — the same to the pixel, because the
   * height was clamped to a constant 720 and the width follows from the aspect
   * — and 405px at 1920, which is 21% of the monitor with about 500px of empty
   * page beside the inspector. The thing the page exists to arrange was the
   * smallest thing on it.
   *
   * A **landscape** wall is the half the height could not reach: a 16:9 canvas
   * is bound by its width, and that width came from a pane inside the admin's
   * 1180px content column, a measure chosen for a readable line of text. 683px
   * at 1440 and 685px at 1920 — two pixels for 480 more of monitor. So both
   * orientations are measured here, on the same page load, and three fixes
   * have to hold together: the height budget, the wider column, and
   * `sizeCanvas`'s *other* 720, the one on the width.
   *
   * The properties, and the second is the one that would be lost by replacing
   * a constant with a larger constant:
   *
   *  - it *grows* between 1280 and 1920 in both orientations, rather than the
   *    viewport arriving at whichever step happens to cross a cap;
   *  - it uses nearly all of the height the viewport can actually show — the
   *    screen less the app bar and the fixed save bar, both of which stay put
   *    when the page is scrolled;
   *  - and it is still *whole* between those two bars at some scroll position,
   *    which is what stops "bigger" becoming a canvas nobody can see at once;
   *  - and the wider column is the editor's alone, with the settings beside
   *    the canvas keeping their own measure.
   *
   * The small end is asserted rather than assumed: the phone widths run through
   * the compact branch, which is deliberately untouched, and are what a change
   * to the other branch would quietly cost.
   *
   * One page load per width, both orientations measured from it. This file
   * shares a CI runner with fifteen other browser suites, and a wall test on
   * that runner is already racing its own feed sync — so a test that reloads
   * for each half of its question buys nothing and spends somebody else's
   * margin.
   */
  it(
    'sizes the canvas from the viewport, in both orientations, from 320 to 1920',
    async () => {
      const wall = await fresh();
      /*
       * One signed-in context, resized and reloaded, rather than eight — each
       * measurement is still a fresh load at that viewport, which is the
       * journey, and eight sign-ups against one in-memory rate-limit bucket is
       * not.
       */
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        applyTemplate(wall.db, null, CLASSIC_TEMPLATE);

        /** The canvas as drawn now, and the room the viewport can show it in. */
        const read = async () =>
          await page.evaluate(() => {
            const canvas = document.querySelector('.le-canvas')!.getBoundingClientRect();
            const content = document.querySelector('.content')!.getBoundingClientRect();
            const bar = document.getElementById('savebar')?.getBoundingClientRect();
            const top = document.querySelector('.topbar')?.getBoundingClientRect();
            return {
              width: Math.round(canvas.width),
              height: Math.round(canvas.height),
              content: Math.round(content.width),
              // What the viewport can show at once: the screen less the two
              // things that do not scroll away.
              room: Math.round(window.innerHeight - (top?.height ?? 0) - (bar?.height ?? 0)),
              scrollWidth: document.documentElement.scrollWidth,
            };
          });

        const portrait = new Map<number, Awaited<ReturnType<typeof read>>>();
        const landscape = new Map<number, Awaited<ReturnType<typeof read>>>();

        for (const [width, height] of [
          [320, 700],
          [375, 812],
          [390, 844],
          [768, 1000],
          [1024, 768],
          [1280, 900],
          [1440, 900],
          [1920, 1080],
        ] as const) {
          await page.setViewportSize({ width, height });
          await page.goto(`${wall.base}/admin/displays/default`, { waitUntil: 'load' });
          await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });

          /*
           * Stated, not inherited. The editor reopens on the orientation it was
           * left on, so without this the first width measures the seed and
           * every later one measures whatever the previous width chose.
           */
          await page.click('.le-orient-btn:has-text("Portrait")');
          await page.waitForTimeout(250);
          const seen = await read();
          portrait.set(width, seen);

          expect(
            seen.scrollWidth,
            `at ${width}px the editor scrolls sideways`,
          ).toBeLessThanOrEqual(width);

          // Scrolled to the foot of the page, the bottom row of resize handles
          // is still reachable — the save bar is fixed and cannot be scrolled
          // out of the way.
          const foot = await page.evaluate(async () => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((settle) => setTimeout(settle, 150));
            const canvas = document.querySelector('.le-canvas')!.getBoundingClientRect();
            const bar = document.getElementById('savebar')!.getBoundingClientRect();
            return { canvasBottom: Math.round(canvas.bottom), barTop: Math.round(bar.top) };
          });
          expect(
            foot.canvasBottom,
            `at ${width}px the canvas runs under the fixed save bar at the foot of the page`,
          ).toBeLessThanOrEqual(foot.barTop);

          if (width >= 900) {
            /*
             * A desktop canvas fills that room without exceeding it: nearly all
             * of it, so a big monitor is spent on the wall, and never more than
             * all of it, or "bigger" becomes a canvas that is whole at no
             * scroll position. The old constant cap fails the floor at 1920 and
             * only there, because 720px is most of a 900px screen and
             * three-quarters of a 1080px one.
             */
            expect(
              seen.height,
              `at ${width}px the canvas is ${seen.height}px in ${seen.room}px of ` +
                'un-scrollable-away room, so it can never be seen at once',
            ).toBeLessThanOrEqual(seen.room);
            expect(
              seen.height / seen.room,
              `at ${width}px the canvas is ${seen.height}px of ${seen.room}px of usable height`,
            ).toBeGreaterThan(0.85);

            await page.evaluate(() => window.scrollTo(0, 0));
            await page.click('.le-orient-btn:has-text("Landscape")');
            await page.waitForTimeout(250);
            landscape.set(width, await read());
          }
        }

        const phone = portrait.get(390)!;
        expect(
          phone.height,
          `the phone canvas is ${phone.height}px, below the 455px the compact branch was tuned to`,
        ).toBeGreaterThanOrEqual(455);

        const small = portrait.get(1280)!;
        const large = portrait.get(1920)!;
        expect(
          large.width,
          `a portrait wall is ${small.width}px at 1280 and ${large.width}px at 1920 — ` +
            'it should track the viewport, which is 1.2x the height here',
        ).toBeGreaterThan(small.width * 1.2);

        const wideL = landscape.get(1920)!;
        const narrowL = landscape.get(1440)!;
        expect(
          wideL.width,
          `a landscape wall is ${narrowL.width}px at 1440 and ${wideL.width}px at 1920 — ` +
            'the extra monitor reaches the page and stops at the canvas',
        ).toBeGreaterThan(narrowL.width * 1.25);

        /*
         * And the column is the editor's alone. Measured against another admin
         * screen at the same viewport rather than against the literal, because
         * what matters is that widening this page did not widen the measure
         * every other page was designed with.
         */
        await page.goto(`${wall.base}/admin/calendars`, { waitUntil: 'load' });
        const ordinary = await page.evaluate(() =>
          Math.round(document.querySelector('.content')!.getBoundingClientRect().width),
        );
        expect(
          large.content,
          `the editor column is ${large.content}px and every other admin screen is ${ordinary}px`,
        ).toBeGreaterThan(ordinary);
        expect(
          ordinary,
          'widening the editor widened the whole admin, and its lines with it',
        ).toBeLessThanOrEqual(1180);

        /*
         * And the settings *beside* the canvas keep their own measure: a wider
         * page must not become wider rows of settings to read, which is the one
         * thing the 1180px column was protecting.
         */
        await page.goto(`${wall.base}/admin/displays/default`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        const settings = await page.evaluate(async () => {
          (document.querySelector('#mode-tab-settings') as HTMLElement | null)?.click();
          await new Promise((settle) => setTimeout(settle, 300));
          const panels = document.querySelector('.wset-panels')?.getBoundingClientRect();
          return Math.round(panels?.width ?? -1);
        });
        expect(
          settings,
          `the wall's settings rows are ${settings}px wide on the widened page`,
        ).toBeLessThanOrEqual(720);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
  /**
   * Each toolbar popover opens under the button that opened it.
   *
   * They used to anchor to a tools row whose first item was that button, so
   * `left: 0` landed under it by luck. In one row the buttons are at the end,
   * and a popover anchored to the row opens flush with the far edge — a panel
   * with no visible relationship to what was pressed. Measured, because "the
   * popover is open" passes just as happily either way.
   */
  it(
    'opens the Layers and Layout popovers under their own buttons',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        for (const [button, popover] of [
          ['.le-layers-btn', '.le-layers-pop'],
          ['.le-tool-btn:not(:disabled)', '.le-canvas-pop'],
        ] as const) {
          await page.click(button);
          await page.waitForTimeout(150);
          const seen = await page.evaluate(
            ([b, p]) => {
              const one = document.querySelector(b as string)?.getBoundingClientRect();
              const two = document.querySelector(p as string)?.getBoundingClientRect();
              if (one === undefined || two === undefined) return null;
              return {
                buttonRight: Math.round(one.right),
                popoverRight: Math.round(two.right),
                popoverLeft: Math.round(two.left),
                below: two.top >= one.bottom - 1,
                width: window.innerWidth,
              };
            },
            [button, popover],
          );
          expect(seen, `${popover} did not open`).not.toBeNull();
          expect(
            Math.abs((seen?.popoverRight ?? 0) - (seen?.buttonRight ?? 0)),
            `${popover} opened ${(seen?.popoverLeft ?? 0)}px from the left while its ` +
              `button ends at ${seen?.buttonRight ?? 0}px — it is anchored to the row, ` +
              'not to the control that opened it',
          ).toBeLessThanOrEqual(2);
          expect(seen?.below, `${popover} does not hang below its button`).toBe(true);
          expect(seen?.popoverLeft ?? -1).toBeGreaterThanOrEqual(0);
          await page.click(button);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * Two Calendars are two different widgets, and the canvas says which.
   *
   * The default wall ships with both — a month grid and an upcoming list — and
   * they were both labelled "Calendar", on the box and in the Layers list. The
   * only way to tell which was which was to select one and read its Content
   * tab, which is the screen you were trying to decide whether to open.
   *
   * The view is already declared in `widget-views.ts`; this is it reaching the
   * two places a household actually looks, and following a change rather than
   * being stamped once at boot.
   */
  it(
    'names a widget by the view it is set to, on the canvas and in Layers',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const calendars = (await boxes(page)).filter((one) => one.label.startsWith('Calendar'));
        expect(calendars.length, 'the default wall should carry two calendars').toBe(2);
        expect(
          new Set(calendars.map((one) => one.label)).size,
          `both calendars read the same on the canvas: ${calendars
            .map((one) => one.label)
            .join(' / ')}`,
        ).toBe(2);
        expect(calendars.map((one) => one.label).sort()).toEqual([
          'Calendar \u2014 Month grid',
          'Calendar \u2014 Upcoming list',
        ]);

        // Layers says the same thing — it is the other list of the same boxes.
        await page.click('.le-layers-btn');
        const rows = (await page.locator('.le-layer-name').allTextContents()).filter((one) =>
          one.startsWith('Calendar'),
        );
        expect(rows.sort()).toEqual(['Calendar \u2014 Month grid', 'Calendar \u2014 Upcoming list']);
        await page.click('.le-layers-btn');

        // And it follows the setting rather than being stamped once at boot.
        const monthBox = calendars.find((one) => one.label.includes('Month'));
        await page.locator(`.le-overlay .le-widget[data-id="${monthBox?.id ?? ''}"]`).click();
        await page.selectOption('.le-cfg-field[data-cfg-key="mode"] select', 'week');
        await page.waitForTimeout(200);
        expect(
          (await boxes(page)).find((one) => one.id === monthBox?.id)?.label,
          'the box kept the name of the view it no longer draws',
        ).toBe('Calendar \u2014 Week columns');

        // A type with one view says nothing extra: "Clock — Time and date" is
        // a longer way of writing "Clock", and the chip is 10px in a box that
        // is narrow by construction.
        expect((await boxes(page)).some((one) => one.label === 'Clock')).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 7 · The name chip, and the artwork underneath it
// ===========================================================================

/**
 * Every box's rect, its chip's rect, and whether the chip is painting.
 *
 * Read from the browser rather than from the markup, because the whole fault
 * was a chip whose class was right and whose pixels were on top of the widget.
 * `visibility` is the computed value, not the class that sets it.
 */
interface ChipReading {
  readonly id: string;
  readonly label: string;
  readonly visible: boolean;
  readonly box: { x: number; y: number; w: number; h: number };
  readonly chip: { x: number; y: number; w: number; h: number };
}

const chips = (page: Page): Promise<ChipReading[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')].map((el) => {
      const chip = el.querySelector<HTMLElement>('.le-widget-label');
      const boxRect = el.getBoundingClientRect();
      const chipRect = chip?.getBoundingClientRect();
      return {
        id: el.dataset['id'] ?? '',
        label: (chip?.textContent ?? '').trim(),
        visible: chip !== null && getComputedStyle(chip).visibility === 'visible',
        box: { x: boxRect.x, y: boxRect.y, w: boxRect.width, h: boxRect.height },
        chip: {
          x: chipRect?.x ?? 0,
          y: chipRect?.y ?? 0,
          w: chipRect?.width ?? 0,
          h: chipRect?.height ?? 0,
        },
      };
    }),
  );

/** Do two rectangles share any pixels? A shared edge is not an overlap. */
const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean =>
  a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

/**
 * Put a widget exactly where the test needs it, through the editor's own
 * Position and size fields.
 *
 * x and y are written twice, either side of the width and height: every field
 * is clamped against the others as it is typed, so a box still at x=60 refuses
 * a width of 50 and a box still 90% wide refuses an x of 50. Setting the origin
 * to zero first, then the size, then the origin again is the order that lands
 * where it was asked to.
 */
async function placeByField(
  page: Page,
  id: string,
  at: { x: number; y: number; w: number; h: number },
): Promise<void> {
  await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
  await page.click('.insp-tab:has-text("Style")');
  const fields = page.locator('.le-box-grid input[type=number]');
  const write = async (index: number, value: number): Promise<void> => {
    const input = fields.nth(index);
    await input.fill(String(value));
    await input.press('Enter');
  };
  await write(0, 0);
  await write(1, 0);
  await write(2, at.w);
  await write(3, at.h);
  await write(0, at.x);
  await write(1, at.y);
  await page.waitForTimeout(60);
}

/**
 * Nothing selected, nothing focused, the pointer off every box.
 *
 * All three light a chip, each of them correctly — so "at rest" has to mean all
 * three are false, and Escape alone does not get there: it hands focus back to
 * the box it came from, which is a tab stop on the canvas.
 */
async function restToIdle(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(4, 4);
  await page.waitForTimeout(150);
}

describe('7 · the widget name chip', () => {
  /**
   * The chip names the widget from outside it, and never over it.
   *
   * It used to be `position:absolute;top:0;left:0` *inside* a box that is
   * `overflow:hidden` — so it lay on the artwork it was naming. Measured on the
   * default wall: 22px of chip over a 68px Clock is a third of the widget, the
   * Shift box lost 27% of its height, and on the month grid the chip covered
   * the weekday header row exactly, hiding "MON TUE WED" behind a label reading
   * "Calendar — Month grid". The live preview is the entire value of this
   * editor; obscuring the most identifying part of every widget defeats it, and
   * the smallest widgets paid the most.
   *
   * Two properties, and both are measured with the chip *showing*, because a
   * hidden element's rectangle proves nothing about paint. Every widget is
   * hovered in turn: the chip has to become visible (or it is a name nobody can
   * read) and its rectangle has to clear its own box entirely.
   */
  it(
    'draws every name outside the widget it names, at every size on the default wall',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const ids = (await chips(page)).map((one) => one.id);
        expect(ids.length, 'the default wall drew no widgets to label').toBeGreaterThanOrEqual(4);

        const faults: string[] = [];
        for (const id of ids) {
          const selector = `.le-overlay .le-widget[data-id="${id}"]`;
          await page.locator(selector).hover();
          await page.waitForTimeout(40);
          const one = (await chips(page)).find((each) => each.id === id);
          if (one === undefined) {
            faults.push(`${id} vanished while being pointed at`);
            continue;
          }
          if (!one.visible) {
            faults.push(`${one.label || id} shows no name when it is pointed at`);
            continue;
          }
          if (overlaps(one.chip, one.box)) {
            const covered = Math.round((one.chip.h / one.box.h) * 100);
            faults.push(
              `${one.label} — the chip lies over its own widget: chip ` +
                `${Math.round(one.chip.y)}..${Math.round(one.chip.y + one.chip.h)} inside a box ` +
                `${Math.round(one.box.y)}..${Math.round(one.box.y + one.box.h)} ` +
                `(${covered}% of a ${Math.round(one.box.h)}px widget)`,
            );
          }
        }
        expect(
          faults,
          'a widget name is drawn on top of the widget it names. The preview is ' +
            'what this editor is for.',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * The month grid's weekday header row, specifically.
   *
   * It is the row the old chip covered exactly — same height, same corner — so
   * it is the one measured by name rather than by the general rule above. Read
   * through the shadow root the live preview lives in, which is the only way to
   * see the artwork at all.
   */
  it(
    'leaves the month grid’s MON TUE WED row uncovered while naming it',
    async () => {
      const wall = await fresh({ feed: true });
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await page.waitForTimeout(400);

        const month = (await chips(page)).find((one) => one.label.includes('Month'));
        expect(month, 'the default wall has no month grid to measure').toBeDefined();
        await page.locator(`.le-overlay .le-widget[data-id="${month?.id ?? ''}"]`).hover();
        await page.waitForTimeout(60);

        const header = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
          const cells = [...(root?.querySelectorAll('.hz-head') ?? [])];
          if (cells.length === 0) return null;
          const rects = cells.map((cell) => cell.getBoundingClientRect());
          const top = Math.min(...rects.map((r) => r.top));
          const left = Math.min(...rects.map((r) => r.left));
          return {
            words: cells.map((cell) => (cell.textContent ?? '').trim()),
            x: left,
            y: top,
            w: Math.max(...rects.map((r) => r.right)) - left,
            h: Math.max(...rects.map((r) => r.bottom)) - top,
          };
        });
        expect(header, 'the preview drew no weekday header to be covered').not.toBeNull();
        expect(
          (header?.words ?? []).length,
          `the weekday row read ${(header?.words ?? []).join(' ')}`,
        ).toBe(7);

        const shown = (await chips(page)).find((one) => one.id === month?.id);
        expect(shown?.visible, 'the month grid shows no name when pointed at').toBe(true);
        expect(
          overlaps(
            shown?.chip ?? { x: 0, y: 0, w: 0, h: 0 },
            header ?? { x: 0, y: 0, w: 0, h: 0 },
          ),
          `the chip "${shown?.label ?? ''}" is drawn over the weekday header row ` +
            `(${(header?.words ?? []).join(' ')}), which is the row that says what the ` +
            'grid is.',
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * At rest the canvas is artwork, and a dense one carries no chips at all.
   *
   * This is the half that makes "outside the box" safe rather than merely
   * different: a chip hanging above its widget hangs over whatever is above it,
   * and on a canvas with no gaps that is always another widget. So none of them
   * paints until it is asked for. Pointing at one shows exactly one — the one
   * being pointed at — which is the only ink over a neighbour anywhere on the
   * canvas, and it is the widget the household is asking about.
   *
   * Dense on purpose: eight widgets tiled edge to edge with no gap for a chip
   * to sit in, which is the arrangement that would make an always-on chip
   * unsurvivable.
   */
  it(
    'paints no name over a neighbour on a canvas with no gaps',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        // Tile what is there into a grid with no gaps, through the editor's own
        // numeric fields so the canvas is one the editor could really hold.
        const placed = await boxes(page);
        const rows = Math.ceil(placed.length / 2);
        for (const [index, one] of placed.entries()) {
          await placeByField(page, one.id, {
            x: (index % 2) * 50,
            y: Math.floor(index / 2) * Math.floor(100 / rows),
            w: 50,
            h: Math.floor(100 / rows),
          });
        }
        // Nothing selected and nothing focused: both show a chip, correctly,
        // and neither is what this test is about.
        await restToIdle(page);

        const atRest = await chips(page);
        expect(atRest.length, 'the tiling lost the widgets').toBeGreaterThanOrEqual(4);
        expect(
          atRest.filter((one) => one.visible).map((one) => one.label),
          'a name chip is painting on a canvas nobody is pointing at. On a dense ' +
            'canvas every chip lies over a neighbour, so at rest there must be none.',
        ).toEqual([]);

        // And pointing at one shows that one alone.
        const target = atRest[3];
        await page.locator(`.le-overlay .le-widget[data-id="${target?.id ?? ''}"]`).hover();
        await page.waitForTimeout(60);
        const pointed = await chips(page);
        expect(
          pointed.filter((one) => one.visible).map((one) => one.id),
          'pointing at one widget lit up more than one name',
        ).toEqual([target?.id]);

        const shown = pointed.find((one) => one.id === target?.id);
        expect(
          overlaps(shown?.chip ?? { x: 0, y: 0, w: 0, h: 0 }, shown?.box ?? { x: 0, y: 0, w: 0, h: 0 }),
          'even tiled edge to edge the chip must clear its own widget',
        ).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A widget against the top of the canvas puts its name below itself.
   *
   * `.le-canvas` is `overflow:hidden`, so a chip placed above a box at y=0 is
   * not merely tight — it is cut off and gone, which is the same silent
   * disappearance the clip inside the box used to cause one level down. Driven
   * by dragging a widget to the top, then measured: the chip has to still clear
   * its own box, and it has to still be inside the canvas.
   */
  it(
    'flips the name below a widget that has nothing above it',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const first = (await boxes(page))[0];
        const selector = `.le-overlay .le-widget[data-id="${first?.id ?? ''}"]`;
        await placeByField(page, first?.id ?? '', { x: 0, y: 0, w: 40, h: 12 });
        await restToIdle(page);

        await page.locator(selector).hover();
        await page.waitForTimeout(60);
        const one = (await chips(page)).find((each) => each.id === first?.id);
        expect(one?.visible, 'a widget at the top of the canvas shows no name at all').toBe(true);
        expect(
          overlaps(one?.chip ?? { x: 0, y: 0, w: 0, h: 0 }, one?.box ?? { x: 0, y: 0, w: 0, h: 0 }),
          'the chip fell back onto the widget it names rather than below it',
        ).toBe(false);
        expect(
          (one?.chip.y ?? 0) > (one?.box.y ?? 0),
          `the chip is still above a widget at the top of the canvas (chip y ` +
            `${Math.round(one?.chip.y ?? 0)}, box y ${Math.round(one?.box.y ?? 0)}), ` +
            'where the canvas clip removes it entirely',
        ).toBe(true);

        const canvas = await page.locator('.le-canvas').boundingBox();
        expect(canvas, 'no canvas to measure against').not.toBeNull();
        expect(
          (one?.chip.y ?? 0) >= (canvas?.y ?? 0) &&
            (one?.chip.y ?? 0) + (one?.chip.h ?? 0) <= (canvas?.y ?? 0) + (canvas?.height ?? 0) + 0.5 &&
            (one?.chip.x ?? 0) + (one?.chip.w ?? 0) <= (canvas?.x ?? 0) + (canvas?.width ?? 0) + 0.5,
          'the chip hangs outside the canvas, which is overflow:hidden — so it is cut off',
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * The chip takes no presses, and its own box is what proves it.
   *
   * It hangs over the neighbouring widget now, so a chip that answered a press
   * would make the box above it unusable along its bottom edge. And because the
   * chip is a child of the box it names, a press it *did* take would bubble
   * straight into that box's own drag — so grabbing a name would move the
   * widget under the name, from outside it, which is a drag nobody aimed. Driven
   * rather than read off `pointer-events`: press in the middle of the chip,
   * drag, and the widget it belongs to must not have moved a pixel.
   */
  it(
    'is not in the way of a press',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        /*
         * One widget alone under its chip, with everything else tucked into a
         * corner. That arrangement is the whole test: on the default canvas a
         * chip lands under a neighbouring box with a higher z, so the browser
         * answers a press there with the neighbour whatever the chip is set to
         * — and the bug would sail through. Clear the band above the widget and
         * the chip is the topmost thing at that point, which is where a chip
         * that took presses would take one.
         */
        const all = await boxes(page);
        const id = all[0]?.id ?? '';
        for (const other of all.slice(1)) {
          await placeByField(page, other.id, { x: 0, y: 0, w: 5, h: 5 });
        }
        await placeByField(page, id, { x: 30, y: 50, w: 30, h: 20 });

        /*
         * Selected rather than hovered, and that is the case that can actually
         * go wrong: moving the pointer onto a chip shown by :hover takes the
         * pointer off the box and hides the chip on the way, so a hovered chip
         * cannot be pressed however permissive it is. A selected one stays put
         * under the pointer, which is where a press would land on it.
         */
        await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
        await page.waitForTimeout(80);
        const shown = (await chips(page)).find((each) => each.id === id);
        expect(shown?.visible, 'nothing to press through').toBe(true);

        const cx = (shown?.chip.x ?? 0) + (shown?.chip.w ?? 0) / 2;
        const cy = (shown?.chip.y ?? 0) + (shown?.chip.h ?? 0) / 2;
        const hit = await page.evaluate(
          ([x, y]) => (document.elementFromPoint(x as number, y as number)?.className ?? '').toString(),
          [cx, cy],
        );
        expect(
          hit,
          `a press in the middle of the name chip lands on the chip (${hit}), so the ` +
            'chip is in front of whatever it hangs over',
        ).not.toContain('le-widget-label');

        const before = (await boxes(page)).find((each) => each.id === id);
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 90, cy + 70, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(150);
        const after = (await boxes(page)).find((each) => each.id === id);

        expect(
          [after?.x, after?.y],
          'dragging a widget’s name moved the widget it names, from ' +
            'outside the widget. The chip has to be inert.',
        ).toEqual([before?.x, before?.y]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

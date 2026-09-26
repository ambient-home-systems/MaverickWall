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
import type { BrowserContext, Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';
import { applyTemplate } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';

process.env['TZ'] = 'UTC';

/** Long, because each of these opens a browser context and an editor. */
const SLOW = 60_000;

const installations: Installation[] = [];

/**
 * A server of this test's own, for the three tests that change the household.
 *
 * A panel following a wall, a calendar feed and a Home Assistant connection
 * are facts about the whole installation rather than about one wall, and a
 * test reading the editor should not have to know which other test set one
 * up before it — so a test that makes one gets a server nobody else reads.
 */
async function ownInstallation(options?: Parameters<typeof install>[0]): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

/**
 * A wall of this test's own, on the one server every other test shares.
 *
 * Everything these tests change is the canvas of the wall they open, and each
 * one pairs its own (`editorWall` keys on the object returned here), so
 * sharing the server shares nothing a test reads. What it saves is a server
 * booted, a database migrated and a wizard driven per test, which is CPU this
 * file's CI runner spends while two other suites want it.
 */
let shared: Promise<Installation> | undefined;
async function newWall(): Promise<Installation> {
  shared ??= ownInstallation();
  return { ...(await shared) };
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
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

/**
 * The wall each Installation edits, paired once and remembered.
 *
 * These tests used to open `/admin/displays/default` — the shared Default wall,
 * which was the only wall that existed without pairing one. It is retired, and
 * a suite about the editor should have been driving a real paired wall anyway:
 * that is the object a household opens, and it is the one whose canvas the
 * editor writes.
 */
const editorWalls = new WeakMap<Installation, string>();
let pairedWalls = 0;
async function editorWall(wall: Installation): Promise<string> {
  const known = editorWalls.get(wall);
  if (known !== undefined) return known;
  pairedWalls += 1;
  const id = await wall.pairWall(`Editor wall ${pairedWalls}`);
  editorWalls.set(wall, id);
  return id;
}

// ---------------------------------------------------------------------------
// Signed in once per server, and told when the editor has caught up
// ---------------------------------------------------------------------------

type SignedIn = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * One sign-in per server, driven through the form the way a household does,
 * and its cookie handed to every context that opens an editor there.
 *
 * Not a sign-in per test: that is a password hash per test, and the auth
 * library's rate limit is one in-memory bucket per server — the reason §5's
 * viewport test already signs in once rather than eight times.
 */
const sessions = new Map<string, Promise<SignedIn>>();
function session(wall: Installation): Promise<SignedIn> {
  let known = sessions.get(wall.base);
  if (known === undefined) {
    known = (async () => {
      const context = await (await browser()).newContext();
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        return await context.storageState();
      } finally {
        await context.close();
      }
    })();
    known.catch(() => sessions.delete(wall.base));
    sessions.set(wall.base, known);
  }
  return known;
}

/**
 * Counts what the editor has put off: a timer its own script set, and a fetch
 * or a body read still in flight.
 *
 * The editor does almost everything synchronously in the handler that received
 * the key or the pointer, so the DOM an assertion reads is already written by
 * the time Playwright's action returns. What it defers is the preview (a 140ms
 * debounce), the ink lane's frame and the e-paper backdrop (260 and 220ms, then
 * a POST), the first preview's fetch, and a save. The fixed waits this file
 * used to take were guesses at how long those take; this is the thing they were
 * guessing at.
 *
 * Only timers set from the bundle under `/assets/` count. The admin page's own
 * inline script sets an 800ms timer to clear the ripple on every button press,
 * and waiting on that would be waiting on an animation nobody asserts.
 */
function idleProbe(): void {
  const pending = new Set<number>();
  const setTimer = window.setTimeout.bind(window);
  const clearTimer = window.clearTimeout.bind(window);
  const fromBundle = (): boolean => /\/assets\//.test(new Error().stack ?? '');
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
    if (typeof handler !== 'function' || !fromBundle() || Number(delay ?? 0) > 2000) {
      return setTimer(handler, delay, ...args);
    }
    const id: number = setTimer(
      (...given: unknown[]) => {
        pending.delete(id);
        (handler as (...a: unknown[]) => void)(...given);
      },
      delay,
      ...args,
    );
    pending.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number): void => {
    if (id !== undefined) pending.delete(id);
    clearTimer(id);
  }) as typeof window.clearTimeout;

  // A fetch counts until it settles, and so does reading its body. The count
  // goes down in the same microtask checkpoint as the code awaiting it resumes,
  // so an `await fetch(...)` followed by `await response.json()` never shows a
  // frame with nothing in flight between the two.
  let inFlight = 0;
  const track = <T,>(promise: Promise<T>): Promise<T> => {
    inFlight += 1;
    const done = (): void => {
      inFlight -= 1;
    };
    promise.then(done, done);
    return promise;
  };
  const fetchIt = window.fetch.bind(window);
  window.fetch = ((...args: Parameters<typeof fetch>) => track(fetchIt(...args))) as typeof fetch;
  for (const read of ['json', 'text', 'blob', 'arrayBuffer'] as const) {
    const original = Response.prototype[read] as (this: Response) => Promise<unknown>;
    (Response.prototype as unknown as Record<string, unknown>)[read] = function (this: Response) {
      return track(original.call(this));
    };
  }
  (window as unknown as { __mwBusy: () => number }).__mwBusy = () => pending.size + inFlight;
}

/**
 * Wait until the editor has nothing pending for two frames running.
 *
 * Two, because a resize observer — which is how the stage re-sizes the canvas
 * and the canvas re-draws the preview — runs after the frame's animation
 * callbacks, so one calm frame can precede a preview the next frame schedules.
 * A page without the probe is a failure rather than a pass: a wait that
 * silently waits for nothing is how a fixed sleep's flakiness comes back.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const busy = (window as unknown as { __mwBusy?: () => number }).__mwBusy;
        if (busy === undefined) {
          reject(new Error('this page has no idle probe; open its context with editorContext()'));
          return;
        }
        const started = performance.now();
        let calm = 0;
        const frame = (): void => {
          const left = busy();
          calm = left === 0 ? calm + 1 : 0;
          if (calm >= 2) {
            resolve();
            return;
          }
          if (performance.now() - started > 15_000) {
            reject(new Error(`the editor still had ${left} thing(s) pending after 15s`));
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/** A browser context signed in to this wall's server, with the idle probe in it. */
async function editorContext(
  wall: Installation,
  viewport: { width: number; height: number } = { width: 1440, height: 1000 },
): Promise<BrowserContext> {
  const context = await (await browser()).newContext({ viewport, storageState: await session(wall) });
  await context.addInitScript(idleProbe);
  return context;
}

/**
 * The editor has drawn its boxes and its preview, and has nothing pending.
 *
 * The preview is fetched after the page loads, so a test reading it — or
 * asserting what it does *not* draw — has to know it has arrived.
 */
async function editorReady(page: Page): Promise<void> {
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.canvas') != null,
    undefined,
    { timeout: 20_000 },
  );
  await settle(page);
}

/** Open a wall's editor, in a context `editorContext` made. */
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
  const id = await editorWall(wall);
  applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(id)}`, { waitUntil: 'load' });
  if (new URL(page.url()).pathname.endsWith('/sign-in')) {
    throw new Error('the editor asked for a sign-in; open this context with editorContext()');
  }
  await editorReady(page);
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
  await settle(page);
}

// ===========================================================================
// 0 · The wait every other test stands on
// ===========================================================================

describe('0 · the idle probe', () => {
  /**
   * `settle` is only as good as what the probe counts, and a probe that counts
   * nothing turns every wait in this file into no wait at all — green on a
   * quiet machine and red on a loaded one, which is the fixed sleep's fault
   * back again. So it is asked directly, in one synchronous turn where nothing
   * can fire in between: a nudge puts off the preview, a save puts a request
   * in flight, and the probe has to have seen both.
   *
   * A synthetic key event rather than Playwright's, because Playwright's
   * returns after a round trip in which a loaded machine could run the 140ms
   * debounce, and then "the probe saw nothing" would be a fact about the
   * machine.
   */
  it(
    'counts the preview a nudge puts off and the save in flight, and settles to nothing',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const seen = await page.evaluate(async () => {
          const probe = window as unknown as {
            __mwBusy: () => number;
            mwEditor: { saveCurrent(): Promise<{ ok: boolean }> };
          };
          const before = probe.__mwBusy();
          const box = document.querySelector<HTMLElement>('.le-overlay .le-widget');
          box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          const nudged = probe.__mwBusy();
          const saving = probe.mwEditor.saveCurrent();
          const posting = probe.__mwBusy();
          const saved = await saving;
          return { before, nudged, posting, saved: saved.ok };
        });
        expect(seen.before, 'the editor had something pending after editorReady').toBe(0);
        expect(seen.nudged, 'a nudge put off the preview and the probe did not count it').toBe(1);
        expect(seen.posting, 'a save is in flight and the probe did not count it').toBe(2);
        expect(seen.saved).toBe(true);
        await settle(page);
        expect(await page.evaluate(() => (window as unknown as { __mwBusy: () => number }).__mwBusy())).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

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
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const step = async (name: string, mutate: () => Promise<void>): Promise<void> => {
          const before = await canvasState(page);
          await mutate();
          await settle(page);
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
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
        const before = await canvasState(page);
        const removed = (await boxes(page))[0]?.id;

        await page.click('.insp-remove');
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await dragBox(page, 0, 40, 60);
        await settle(page);
        const arranged = await canvasState(page);

        await page.click('[data-mode="settings"]');
        await settle(page);
        await page.keyboard.press('Control+z');
        await page.keyboard.press('Control+z');
        await settle(page);

        await page.click('[data-mode="layout"]');
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);

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
        await settle(page);
        expect(
          (await boxes(page)).find((one) => one.id === id)?.x,
          'a modifier + arrow moved the widget, so Back does not work here',
        ).toBe(moved?.x);

        await page.keyboard.press('Shift+ArrowRight');
        await settle(page);
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
      // Its own server: a panel following a wall is household state.
      const wall = await ownInstallation();
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
      /*
       * Following *this* wall, not the shared default — `follow:default` is
       * refused now that the Default wall is retired, and the lane only appears
       * on a wall some panel actually follows.
       */
      await wall.post(`/admin/epaper/${panel?.id ?? ''}/source`, {
        source: `follow:${await editorWall(wall)}`,
      });

      const context = await editorContext(wall);
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
        await settle(page);
        const calendar = (await boxes(page)).find((one) => one.label.startsWith('Calendar'));
        expect(calendar, 'the landscape canvas has no calendar to override').toBeDefined();
        await page.locator(`.le-overlay .le-widget[data-id="${calendar?.id ?? ''}"]`).click();
        await page.click('.insp-lane:has-text("On ink")');
        await settle(page);
        const mode = page.locator('.le-cfg-field[data-cfg-key="mode"] select');
        expect(await mode.count(), 'the ink lane offered no control to override').toBeGreaterThan(0);
        await mode.selectOption('list');
        await settle(page);

        const reset = page.locator('.insp-ink-reset');
        expect(await reset.count(), 'changing an option on the lane recorded no override').toBe(1);
        await reset.click();
        await settle(page);
        expect(await page.locator('.insp-ink-reset').count()).toBe(0);

        await page.keyboard.press('Control+z');
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const first = page.locator('.le-overlay .le-widget').first();
        const id = (await first.getAttribute('data-id')) ?? '';
        await first.click();
        await page.click('.insp-tab:has-text("Style")');

        const x = page.locator('.le-box-grid input[type=number]').first();
        await x.fill('37');
        await settle(page);
        expect((await boxes(page)).find((one) => one.id === id)?.x).toBe(37);

        // Out of range comes back as what the canvas could take, once the edit
        // is committed — a clamp nobody can see is a field that lies.
        await x.fill('140');
        await x.press('Enter');
        await settle(page);
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
        await settle(page);
        const own = page.locator(`.le-overlay .le-widget[data-id="${id}"]`);
        const rect = await own.boundingBox();
        if (rect === null) throw new Error('the selected widget has no box');
        await page.mouse.move(rect.x + 12, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + 12 + 60, rect.y + rect.height / 2, { steps: 6 });
        await page.mouse.up();
        await settle(page);

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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
        const portrait = await canvasState(page);

        await page.click('.le-orient-btn:has-text("Landscape")');
        await settle(page);
        expect(posted, 'the orientation toggle still writes to the server').toEqual([]);
        expect(
          await page.locator('[data-action="save"]').isEnabled(),
          'the unsaved portrait canvas was forgotten on the way to landscape',
        ).toBe(true);

        await dragBox(page, 0, -40, 60);
        await settle(page);
        const landscape = await canvasState(page);

        await Promise.all([
          page.waitForNavigation({ timeout: 20_000 }),
          page.click('[data-action="save"]'),
        ]);
        await editorReady(page);
        expect(
          posted.slice().sort(),
          'Save wrote one canvas, so the other orientation lost its arrangement',
        ).toEqual(['landscape', 'portrait']);

        // The editor reopens on the orientation it was left on (landscape), so
        // that is the one to read first.
        expect(await canvasState(page)).toBe(landscape);
        await page.click('.le-orient-btn:has-text("Portrait")');
        await settle(page);
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
      const wall = await newWall();
      for (const [width, height] of [
        [390, 844],
        [768, 1000],
        [1440, 1000],
      ] as const) {
        const context = await editorContext(wall, { width, height });
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
      const wall = await newWall();
      /*
       * One signed-in context, resized and reloaded, rather than eight — each
       * measurement is still a fresh load at that viewport, which is the
       * journey, and eight sign-ups against one in-memory rate-limit bucket is
       * not.
       */
      const context = await editorContext(wall, { width: 1280, height: 900 });
      try {
        const page = await context.newPage();
        applyTemplate(wall.db, await editorWall(wall), CLASSIC_TEMPLATE);

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
          await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(await editorWall(wall))}`, { waitUntil: 'load' });
          await editorReady(page);

          /*
           * Stated, not inherited. The editor reopens on the orientation it was
           * left on, so without this the first width measures the seed and
           * every later one measures whatever the previous width chose.
           */
          await page.click('.le-orient-btn:has-text("Portrait")');
          await settle(page);
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
            await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
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
            await settle(page);
            landscape.set(width, await read());
          }
        }

        /*
         * The phone floor, re-measured on a real paired wall.
         *
         * It was 455, taken on `/admin/walls/default` — the shared Default
         * wall, which no household edits and which had no pairing status above
         * its canvas. A real wall's page carries that status line, so the same
         * viewport gives the stage 444px. The number moved because the *subject*
         * moved, from a page nobody opens to the one they do, and recording it
         * without saying so is how a baseline stops meaning anything.
         *
         * The ratio assertion above is the one that actually guards this — the
         * canvas takes more than 85% of the room the viewport can show at once,
         * at every width — and it held throughout.
         */
        const phone = portrait.get(390)!;
        expect(
          phone.height,
          `the phone canvas is ${phone.height}px, below the 440px a real wall's page affords`,
        ).toBeGreaterThanOrEqual(440);

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
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(await editorWall(wall))}`, { waitUntil: 'load' });
        await editorReady(page);
        const settings = await page.evaluate(async () => {
          (document.querySelector('#mode-tab-settings') as HTMLElement | null)?.click();
          await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
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
    'opens the Layers, Layout and Background popovers under their own buttons',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        for (const [button, popover] of [
          ['.le-layers-btn', '.le-layers-pop'],
          ['.le-tool-btn:has-text("Layout")', '.le-canvas-pop:not(.le-background-pop)'],
          ['.le-background-btn', '.le-background-pop'],
        ] as const) {
          await page.click(button);
          await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
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
  await settle(page);
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
  await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const ids = (await chips(page)).map((one) => one.id);
        expect(ids.length, 'the default wall drew no widgets to label').toBeGreaterThanOrEqual(4);

        const faults: string[] = [];
        for (const id of ids) {
          const selector = `.le-overlay .le-widget[data-id="${id}"]`;
          await page.locator(selector).hover();
          await settle(page);
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
      const wall = await ownInstallation({ feed: true });
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await settle(page);

        const month = (await chips(page)).find((one) => one.label.includes('Month'));
        expect(month, 'the default wall has no month grid to measure').toBeDefined();
        await page.locator(`.le-overlay .le-widget[data-id="${month?.id ?? ''}"]`).hover();
        await settle(page);

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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);

        const first = (await boxes(page))[0];
        const selector = `.le-overlay .le-widget[data-id="${first?.id ?? ''}"]`;
        await placeByField(page, first?.id ?? '', { x: 0, y: 0, w: 40, h: 12 });
        await restToIdle(page);

        await page.locator(selector).hover();
        await settle(page);
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
      const wall = await newWall();
      const context = await editorContext(wall);
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
        await settle(page);
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
        await settle(page);
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

// ===========================================================================
// 8 · A box the wall leaves out
// ===========================================================================

/** Add a widget the way a household does: the toolbar button, then the modal. */
async function addWidget(page: Page, label: string): Promise<void> {
  await page.locator('.le-add-primary').click();
  await page.locator('.le-modal-item').filter({ hasText: new RegExp(`^${label}$`) }).click();
  await settle(page);
}

/** One overlay box, read for everything it says about itself. */
async function saysAbout(page: Page, type: string): Promise<{
  readonly id: string;
  readonly label: string;
  readonly aria: string;
  readonly flag: string | null;
  readonly flagged: boolean;
  readonly note: string | null;
  readonly inPreview: boolean;
}> {
  return page.evaluate((kind) => {
    const overlay = [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')];
    const wanted = overlay.find((el) =>
      (el.querySelector('.le-widget-label')?.textContent ?? '').trim().startsWith(kind),
    );
    const id = wanted?.dataset['id'] ?? '';
    const shadow = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
    return {
      id,
      label: (wanted?.querySelector('.le-widget-label')?.textContent ?? '').trim(),
      aria: wanted?.getAttribute('aria-label') ?? '',
      flag: wanted?.querySelector('.le-widget-flag')?.textContent ?? null,
      flagged: wanted?.classList.contains('is-not-drawn') ?? false,
      note: document.querySelector('.le-config .le-not-drawn')?.textContent ?? null,
      inPreview: shadow?.querySelector(`[data-widget-id="${id}"]`) != null,
    };
  }, type);
}

describe('8 · a box the wall leaves out', () => {
  /**
   * The three sentences and the preview, on one screen, agreeing.
   *
   * `omission.ts` decides all four — which boxes the preview draws, the flag on
   * the box, the note in the inspector and the box's accessible name — and the
   * unit tests hold them to each other. What they cannot see is whether any of
   * it reaches the glass: a rule that resolves correctly and is then dropped on
   * the way to an attribute is the class of bug this project keeps finding, and
   * a class being applied has never been proof that the pixels are right.
   *
   * A Chores widget on an install with no chore board is the case, because it
   * is the only flaggable type with more than one view — which the second test
   * needs. The wall's own clock keeps the never-empty guard from standing down.
   */
  it(
    'flags it, says why, and leaves it out of the preview — all four agreeing',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await addWidget(page, 'Chores');
        await settle(page);

        const chores = await saysAbout(page, 'Chores');
        const clock = await saysAbout(page, 'Clock');

        // The box says it, in the household's word for what this editor draws.
        expect(chores.flagged, 'a chores box on a wall with no chore board is not flagged').toBe(true);
        expect(chores.flag).toBe('Not on the wall');

        // The inspector says why — the answer to "I put a Chores box on and my
        // wall has not got one", which is the whole point of keeping the box.
        expect(chores.note ?? '', 'the inspector offered no reason').toMatch(/^Not on the wall yet\. \S/);

        // A screen reader hears both, in one name.
        expect(chores.aria).toBe(
          `${chores.label} widget — not on the wall. ${(chores.note ?? '').replace('Not on the wall yet. ', '')}`,
        );

        // And the preview agrees: this box draws no ink, and the one beside it
        // that the wall is happy with does. Read out of the shadow root the
        // live preview lives in, which is the wall's own renderer.
        expect(chores.inPreview, 'the preview drew a widget its own box says is not on the wall').toBe(false);
        expect(clock.flagged, 'the clock is flagged, so the guard has stood down').toBe(false);
        expect(clock.inPreview, 'the preview drew nothing at all, so it proves nothing').toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * Renaming a flagged box renames it for everybody.
   *
   * Changing a widget's view re-reads every name *in place* rather than
   * rebuilding the overlay — that is what keeps focus on a box being nudged.
   * The flagged sentence used to be composed only where a box is built, so
   * `refreshLabels` skipped flagged boxes entirely: the chip took the new name
   * and the accessible name kept the old one, for as long as the editor stayed
   * open. The visible half updating is exactly what hid it, and it is why this
   * is measured off the attribute rather than off the chip.
   */
  it(
    'renames a flagged box in its accessible name, not only on its chip',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await addWidget(page, 'Chores');
        await settle(page);

        const before = await saysAbout(page, 'Chores');
        expect(before.flagged, 'nothing is flagged, so there is no bug to catch').toBe(true);
        expect(before.label).toBe('Chores — Today');

        // The View picker, which is the control that renames the box.
        const view = page.locator('.le-cfg-field[data-cfg-key="mode"] select');
        await view.selectOption('people');
        await settle(page);

        const after = await saysAbout(page, 'Chores');
        expect(after.id, 'the box was rebuilt, so this proves nothing about renaming in place').toBe(
          before.id,
        );
        expect(after.label, 'the chip did not follow the view').toBe('Chores — By person');
        expect(
          after.aria,
          'the chip says one thing and the accessible name says another',
        ).toBe(`Chores — By person widget — not on the wall. ${(after.note ?? '').replace('Not on the wall yet. ', '')}`);
        expect(after.aria).toContain('By person');
        expect(after.aria).not.toContain('Today');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 9 · A box whose omission is a fact about its own settings (RFC 012 §6.2)
// ===========================================================================

describe('9 · a to-do box that names a list', () => {
  /**
   * The flag has to follow the household's own edit, without a reload.
   *
   * Every other flaggable widget is flagged by its *type* — a Weather box on a
   * household with no location — and nothing the inspector offers can change
   * that. A to-do box is flagged by the *list* it names, and the list is picked
   * in the inspector, so the flag is computed at page load and then has to be
   * re-derived on every config change or it lies for the rest of the session.
   * Driven three ways: pick a list (never flagged, the list is watched); un-watch
   * it in another tab and reload (flagged, with the reason naming Home
   * Assistant); pick the typed items instead (the flag clears live, no reload).
   * The accessible name is read off the attribute each time, because a chip
   * that updates and a name that does not is the fault §8 above recorded.
   */
  it(
    'is flagged only while the list it names is not one the household watches',
    async () => {
      // Its own server: a Home Assistant connection is household state.
      const wall = await ownInstallation();
      const ha = await fakeHomeAssistant();
      // Through the real forms: the connection, and the list with its first read.
      const connected = await wall.post('/admin/home-assistant/connect', {
        base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
      });
      expect(connected.status).toBe(302);
      const listed = await wall.post('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: 'Shopping' });
      expect(listed.headers.get('location')).toBe('/admin/home-assistant/lists?saved=todo-list-added');

      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await addWidget(page, 'To-do');
        await settle(page);

        // Typed items: never flagged, whatever the household has set up.
        const typed = await saysAbout(page, 'To-do');
        expect(typed.flagged, 'a typed checklist is flagged').toBe(false);
        expect(typed.aria).toBe(`${typed.label} widget`);

        // Pick the watched list. Still on the wall, and the preview draws it.
        const picker = page.locator('.le-cfg-field[data-cfg-key="list"] select');
        await picker.selectOption('todo.shopping');
        await settle(page);
        const picked = await saysAbout(page, 'To-do');
        expect(picked.flagged, 'a box naming a watched list is flagged').toBe(false);
        expect(picked.inPreview, 'the preview did not draw the list-backed box').toBe(true);
        const previewRows = await page.evaluate((id) => {
          const shadow = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
          return [...(shadow?.querySelectorAll(`[data-widget-id="${id}"] .td-text`) ?? [])].map(
            (el) => (el.textContent ?? '').trim(),
          );
        }, picked.id);
        // The list's open items, from the household's real manifest, not the
        // typed lines — through the handle the server hands the picker.
        expect(previewRows).toEqual(['Milk', 'Milk']);

        // Save, so the box survives a reload.
        const saved = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(saved.ok).toBe(true);

        // Another tab stops showing the list; this page reloads.
        const removed = await wall.post(`/admin/home-assistant/lists/${encodeURIComponent('todo.shopping')}/remove`, {});
        expect(removed.headers.get('location')).toBe('/admin/home-assistant/lists?saved=todo-list-removed');
        await page.reload({ waitUntil: 'load' });
        await editorReady(page);

        const flagged = await saysAbout(page, 'To-do');
        expect(flagged.id, 'the box did not survive the save').toBe(picked.id);
        expect(flagged.flagged, 'a box naming an un-watched list is not flagged').toBe(true);
        expect(flagged.flag).toBe('Not on the wall');
        // The reason names where the list is chosen, and the way out.
        await page.locator(`.le-overlay .le-widget[data-id="${flagged.id}"]`).click();
        await settle(page);
        const opened = await saysAbout(page, 'To-do');
        expect(opened.note ?? '').toMatch(/^Not on the wall yet\. .*Home Assistant/);
        // The accessible name agrees with the chip, read off the attribute.
        expect(opened.aria).toBe(
          `${opened.label} widget — not on the wall. ${(opened.note ?? '').replace('Not on the wall yet. ', '')}`,
        );
        expect(opened.inPreview, 'the preview drew a box the wall leaves out').toBe(false);

        // Going back to the typed items clears the flag live: the predicate
        // runs on the config change, and no reload is involved.
        await page.locator('.le-cfg-field[data-cfg-key="list"] select').selectOption('');
        await settle(page);
        const back = await saysAbout(page, 'To-do');
        expect(back.id).toBe(picked.id);
        expect(back.flagged, 'the flag stayed after the list was cleared').toBe(false);
        expect(back.aria).toBe(`${back.label} widget`);
        expect(back.inPreview).toBe(true);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 10 · What stands in for an empty box (RFC 014 §5.3)
// ===========================================================================

describe('10 · a fallback for a box the wall leaves out', () => {
  /**
   * Choosing what stands in changes what the box *is* on the wall, and the
   * place that must follow it in place is the one nobody can see go stale —
   * the accessible name, which is §8's fault exactly, one control along.
   *
   * A Chores box on an install with no chore board is the case again: it is
   * flagged, the Classic clock beside it keeps the never-empty guard stood
   * down, and nothing about it changes but what the inspector writes.
   */
  it(
    'says what stands in, follows a change of fallback in place, and saves it through the schema',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        await addWidget(page, 'Chores');
        await settle(page);

        const before = await saysAbout(page, 'Chores');
        expect(before.flagged, 'nothing is flagged, so there is nothing to stand in for').toBe(true);
        expect(before.inPreview).toBe(false);
        expect(before.aria).not.toContain('instead');

        // "When this has nothing to show" → "Show another widget".
        await page.locator('.le-fallback .le-seg button', { hasText: 'Show another widget' }).click();
        await settle(page);
        await page.locator('.le-fallback textarea').fill('Chores are on the fridge');
        await settle(page);

        const notes = await saysAbout(page, 'Chores');
        expect(notes.id).toBe(before.id);
        expect(notes.flag).toBe('Shows Notes instead');
        expect(notes.aria).toBe(
          `Chores — Today widget — not on the wall, shows Notes instead. ${(notes.note ?? '').replace(
            'Not on the wall yet, so this box shows Notes instead. ',
            '',
          )}`,
        );
        expect(notes.note ?? '').toMatch(/^Not on the wall yet, so this box shows Notes instead\. \S/);
        // The preview draws the note in that box — the wall's own renderer,
        // handed the substitution the server will make.
        const drawn = await page.evaluate((id) => {
          const shadow = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
          const box = shadow?.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
          return { classes: box?.className ?? '', text: box?.textContent ?? '' };
        }, notes.id);
        expect(drawn.classes).toContain('fw-notes');
        expect(drawn.text).toContain('Chores are on the fridge');

        // Switch the stand-in; the box is renamed where it stands, not rebuilt.
        await page.locator('.le-fallback-type').selectOption('countdown');
        await settle(page);
        const countdown = await saysAbout(page, 'Chores');
        expect(countdown.id, 'the box was rebuilt, so this proves nothing about renaming in place').toBe(
          before.id,
        );
        expect(countdown.flag).toBe('Shows Countdown instead');
        expect(countdown.aria, 'the flag moved and the accessible name did not').toContain(
          'shows Countdown instead',
        );
        expect(countdown.aria).not.toContain('Notes');

        // And it survives the server's own schema, one level deep.
        const saved = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(saved.ok).toBe(true);
        const row = wall.db
          .prepare(`SELECT config FROM layout_widgets WHERE id = ?`)
          .get(before.id) as { config: string } | undefined;
        expect(JSON.parse(row?.config ?? '{}')).toMatchObject({
          whenEmpty: { type: 'countdown', config: { text: 'Chores are on the fridge' } },
        });

        // "Leave the box empty" takes it back, and the name with it.
        await page.locator('.le-fallback .le-seg button', { hasText: 'Leave the box empty' }).click();
        await settle(page);
        const empty = await saysAbout(page, 'Chores');
        expect(empty.flag).toBe('Not on the wall');
        expect(empty.aria).not.toContain('instead');
        expect(empty.inPreview).toBe(false);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 11 · Groups in the editor (RFC 014 §5.1)
// ===========================================================================

/** One overlay box by id, as `boxes` reads it. */
async function boxById(page: Page, id: string): Promise<EditorBox> {
  const found = (await boxes(page)).find((one) => one.id === id);
  if (found === undefined) throw new Error(`no box ${id} on the layout`);
  return found;
}

/** The box named by the start of its chip: "Clock", "Shift", "Calendar — Month". */
async function boxNamed(page: Page, start: string): Promise<EditorBox> {
  const found = (await boxes(page)).find((one) => one.label.startsWith(start));
  if (found === undefined) throw new Error(`no box named ${start} on the layout`);
  return found;
}

/** Drag a box by id from its middle. */
async function dragById(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const rect = await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).boundingBox();
  if (rect === null) throw new Error('that widget has no box to drag');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

/** What the save bar says: the flag, and whether Save is live. */
async function saveBar(page: Page): Promise<{ flagged: boolean; saveEnabled: boolean }> {
  return page.evaluate(() => ({
    flagged: !(document.querySelector<HTMLElement>('[data-dirty-flag]')?.hidden ?? true),
    saveEnabled: !(document.querySelector<HTMLButtonElement>('[data-action="save"]')?.disabled ?? true),
  }));
}

/**
 * Select a group through its Layers row. Its own box is under its children's
 * — a child takes the pointer before the group behind it — so a tap on the
 * layout reaches a group only where no child covers it, and Layers is the
 * way a household reaches one that is covered.
 */
async function selectViaLayers(page: Page, id: string): Promise<void> {
  await page.click('.le-layers-btn');
  await page.locator(`.le-layer[data-id="${id}"]`).click();
  await settle(page);
  if (await page.locator('.le-layers-pop').isVisible()) await page.click('.le-layers-btn');
  await settle(page);
}

/** Choose two boxes: a click, then a Shift+click. */
async function chooseTwo(page: Page, first: string, second: string): Promise<void> {
  await page.locator(`.le-overlay .le-widget[data-id="${first}"]`).click();
  await page.locator(`.le-overlay .le-widget[data-id="${second}"]`).click({ modifiers: ['Shift'] });
  await settle(page);
}

/** The boxes as one comparable string of exactly what `positionBox` wrote. */
async function pixels(page: Page): Promise<string> {
  const placed = await boxes(page);
  return JSON.stringify(placed.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((one) => [one.id, one.x, one.y, one.w, one.h]));
}

describe('11 · groups', () => {
  /**
   * Group is one undo step, and Ungroup is the inverse of Group.
   *
   * Both are claims about the *whole* canvas, so both are measured as the
   * canvas: the rectangles `positionBox` wrote, the ranking `canvasState`
   * reads, and — the one that matters — the save bar, which compares what
   * would be posted against what was last posted (`canvas-state.ts`). A bar
   * reading clean after Group → Ctrl+Z is the assertion that the round trip
   * loses nothing, to the three places the layout is saved in; a bar that
   * read dirty would be a save that wrote a different canvas back.
   *
   * The body the grouped save would post is captured by refusing it at the
   * network, so the baseline the bar compares against stays the ungrouped
   * one: a save that landed would make "clean after undo" a claim about the
   * grouped canvas instead.
   */
  it(
    'groups two boxes chosen by Shift+click in one step, and comes back to the pixel by undo and by Ungroup',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const clock = await boxNamed(page, 'Clock');
        const shift = await boxNamed(page, 'Shift');

        // The baseline the bar compares against: what the server holds.
        const saved = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(saved.ok).toBe(true);
        expect(await saveBar(page)).toEqual({ flagged: false, saveEnabled: false });
        const before = await canvasState(page);
        const beforePixels = await pixels(page);

        // Shift+click chooses both, and both say so.
        await chooseTwo(page, clock.id, shift.id);
        const pressed = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')]
            .filter((el) => el.getAttribute('aria-pressed') === 'true')
            .map((el) => el.dataset['id']),
        );
        expect(pressed.sort()).toEqual([clock.id, shift.id].sort());
        // The inspector shows the shared Style controls and nothing else.
        expect(await page.locator('.insp-title').textContent()).toBe('2 widgets selected');
        expect(await page.locator('.insp-tabs').isHidden()).toBe(true);
        expect(await page.locator('.insp-remove').isHidden()).toBe(true);
        expect(await page.locator('.le-config .le-style').count()).toBe(1);
        expect(await page.locator('.le-config .le-box').count()).toBe(0);
        expect(await page.locator('.le-group-btn').isVisible()).toBe(true);

        // The grouped body, captured and refused.
        const bodies: string[] = [];
        await page.route('**/admin/layout', (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          bodies.push(route.request().postData() ?? '');
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, message: 'held back by the test' }),
          });
        });

        await page.click('.le-group-btn');
        await settle(page);
        const group = (await boxes(page)).find((one) => one.label.startsWith('Group'));
        if (group === undefined) throw new Error('no group box after Group');
        // Named from what it holds, in the group's own order, on the attribute.
        expect(
          await page.locator(`.le-overlay .le-widget[data-id="${group.id}"]`).getAttribute('aria-label'),
        ).toBe('Group of 2: clock, shift');
        // At the union of the two: Classic's clock and rota badge share the top band.
        expect([group.x, group.y, group.w, group.h]).toEqual([
          Math.min(clock.x, shift.x),
          Math.min(clock.y, shift.y),
          Math.max(clock.x + clock.w, shift.x + shift.w) - Math.min(clock.x, shift.x),
          Math.max(clock.y + clock.h, shift.y + shift.h) - Math.min(clock.y, shift.y),
        ]);
        // Its children are drawn as a row of two equal cells of the union —
        // Group visibly makes one thing of them, where `free` left every box
        // where it was and read as a control that did nothing. The clock keeps
        // the left cell because it sorted first.
        const inRow = { clock: await boxById(page, clock.id), shift: await boxById(page, shift.id) };
        expect(inRow.clock.x).toBeCloseTo(group.x, 1);
        expect(inRow.clock.w).toBeCloseTo(group.w / 2, 1);
        expect(inRow.shift.x).toBeCloseTo(group.x + group.w / 2, 1);
        expect(inRow.shift.w).toBeCloseTo(group.w / 2, 1);
        for (const child of [inRow.clock, inRow.shift]) {
          expect(child.y).toBeCloseTo(group.y, 1);
          expect(child.h).toBeCloseTo(group.h, 1);
        }
        expect([inRow.clock.w, inRow.shift.w], 'a row of equal cells cannot keep two unequal widths').not.toEqual([clock.w, shift.w]);
        expect(await saveBar(page)).toEqual({ flagged: true, saveEnabled: true });

        // The rows the save posts: the group first, its children after with the link.
        const refused = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(refused.ok).toBe(false);
        expect(bodies).toHaveLength(1);
        const rows = (JSON.parse(bodies[0] ?? '{}') as { widgets: { id: string; z: number; x: number; y: number; w: number; h: number; parentId?: string; config?: Record<string, unknown> }[] }).widgets;
        const parents = rows.filter((row) => row.parentId === undefined);
        const children = rows.filter((row) => row.parentId !== undefined);
        expect(rows.indexOf(parents[parents.length - 1]!)).toBeLessThan(rows.indexOf(children[0]!));
        // A row, from the shape of what was grouped: the two sat side by side.
        expect(rows[0]).toMatchObject({ id: group.id, z: 0, config: { layout: 'row' } });
        expect('parentId' in (rows[0] ?? {})).toBe(false);
        const union = { x: group.x / 100, y: group.y / 100, w: group.w / 100, h: group.h / 100 };
        const to3 = (n: number): number => Math.round(n * 1000) / 1000;
        expect(children.map((row) => [row.id, row.parentId, row.z, row.x, row.y, row.w, row.h])).toEqual([
          [clock.id, group.id, 0, to3((clock.x / 100 - union.x) / union.w), to3((clock.y / 100 - union.y) / union.h), to3(clock.w / 100 / union.w), to3(clock.h / 100 / union.h)],
          [shift.id, group.id, 1, to3((shift.x / 100 - union.x) / union.w), to3((shift.y / 100 - union.y) / union.h), to3(shift.w / 100 / union.w), to3(shift.h / 100 / union.h)],
        ]);

        // One Ctrl+Z, and everything is back: the rectangles, the ranking, and the bar.
        await pressUndo(page);
        expect(await pixels(page), 'undo did not put the two boxes back to the pixel').toBe(beforePixels);
        expect(await canvasState(page)).toBe(before);
        expect((await boxes(page)).some((one) => one.id === group.id)).toBe(false);
        expect(await saveBar(page), 'the bar reads dirty after Group and one undo — the round trip lost something').toEqual({
          flagged: false,
          saveEnabled: false,
        });

        // Group again, then Ungroup: the same three, and the children selected.
        await chooseTwo(page, clock.id, shift.id);
        await page.click('.le-group-btn');
        await settle(page);
        expect(await page.locator('.le-ungroup-btn').isVisible()).toBe(true);
        expect(await page.locator('.le-group-btn').isHidden()).toBe(true);
        await page.click('.le-ungroup-btn');
        await settle(page);
        expect(await pixels(page), 'Ungroup did not put the two boxes back to the pixel').toBe(beforePixels);
        expect(await canvasState(page)).toBe(before);
        expect(await saveBar(page)).toEqual({ flagged: false, saveEnabled: false });
        const chosen = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget[aria-pressed="true"]')].map((el) => el.dataset['id']),
        );
        expect(chosen.sort()).toEqual([clock.id, shift.id].sort());
        await page.unroute('**/admin/layout');
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A child moves inside its group and nowhere else.
   *
   * A child's fractions are of its group, so `placement.ts`'s unit clamp is
   * the group's box with no second rule; what has to be right is that the
   * drag's travel is read in the group's fractions and that the box is
   * *drawn* through the group. Reverting the second — drawing a child at its
   * own fractions read as fractions of the layout, which is what the editor
   * did before this session — puts the dragged clock at the far edge of the
   * wall, and this goes red on the first assertion.
   *
   * The group is made narrower than the wall first, by moving the rota badge
   * in under the clock before grouping: Classic's own strip spans the whole
   * width, and a group whose edge is the wall's edge cannot tell the two
   * clamps apart.
   */
  it(
    'stops a child at its group’s edge, by drag and by a hundred arrow presses alike',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const clock = await boxNamed(page, 'Clock');
        const shift = await boxNamed(page, 'Shift');
        const canvas = await page.locator('.le-canvas').boundingBox();
        if (canvas === null) throw new Error('no canvas');

        // The badge in from the right edge, so the union is narrower than the wall.
        await dragById(page, shift.id, -Math.round(canvas.width * 0.25), 0);
        await settle(page);
        await chooseTwo(page, clock.id, shift.id);
        await page.click('.le-group-btn');
        await settle(page);
        const group = (await boxes(page)).find((one) => one.label.startsWith('Group'));
        if (group === undefined) throw new Error('no group box after Group');
        expect(group.x + group.w, 'the group still reaches the wall’s edge, so the clamps cannot be told apart').toBeLessThan(90);
        // Group made it a row, where a child's drag reorders; set it free, so a
        // drag moves the child and the clamp is what stops it.
        await page.locator(`.le-group-grip[data-for="${group.id}"]`).click();
        await page.click('.insp-tab:has-text("Content")');
        await page.locator('.le-cfg-field[data-cfg-key="layout"] .seg button', { hasText: 'Free' }).click();
        await settle(page);
        expect(await boxById(page, clock.id), 'free put the clock somewhere other than its own stored box').toMatchObject({
          x: clock.x, y: clock.y, w: clock.w, h: clock.h,
        });

        // Drag the clock far past the wall's edge.
        await dragById(page, clock.id, Math.round(canvas.width * 2), 0);
        await settle(page);
        const groupRect = await page.locator(`.le-overlay .le-widget[data-id="${group.id}"]`).boundingBox();
        const clockRect = await page.locator(`.le-overlay .le-widget[data-id="${clock.id}"]`).boundingBox();
        if (groupRect === null || clockRect === null) throw new Error('no rectangles to compare');
        expect(
          Math.abs(clockRect.x + clockRect.width - (groupRect.x + groupRect.width)),
          'the child did not stop at its group’s edge',
        ).toBeLessThanOrEqual(1);
        expect(clockRect.x + clockRect.width).toBeLessThan(canvas.x + canvas.width - 20);
        const dragged = await boxById(page, clock.id);

        // Back, then the same distance by keyboard. Focus once; `locator.press`
        // re-focuses before every key and would hide a rebuild.
        await pressUndo(page);
        expect((await boxById(page, clock.id)).x, 'undo did not put the child back').not.toBe(dragged.x);
        await page.locator(`.le-overlay .le-widget[data-id="${clock.id}"]`).focus();
        for (let i = 0; i < 120; i += 1) await page.keyboard.press('ArrowRight');
        await settle(page);
        const nudged = await boxById(page, clock.id);
        expect([nudged.x, nudged.y, nudged.w, nudged.h], 'the arrow keys stopped somewhere the drag did not').toEqual([
          dragged.x, dragged.y, dragged.w, dragged.h,
        ]);
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['id'])).toBe(clock.id);
        // And the inspector's fields say where it is, within the group.
        await page.click('.insp-tab:has-text("Style")');
        expect(await page.locator('.le-box input[aria-label="X, per cent of the group"]').inputValue()).toBe(
          String(Math.round(dragged.x === undefined ? 0 : ((dragged.x - group.x) / group.w) * 100)),
        );
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A group's name is composed from its children, and stays composed.
   *
   * §8's fault, one composition up: the name is on the chip and on the
   * attribute, and the attribute is the half nobody can see go stale. A child
   * switched from a month to an agenda has to rename the group in place —
   * the group's own element, not a rebuilt one — and a child of a row has to
   * be told its place is the order rather than offered fields that move it.
   */
  it(
    'renames a group in place when a child changes view, and says when a child’s place is the order',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const clock = await boxNamed(page, 'Clock');
        const month = await boxNamed(page, 'Calendar — Month');
        await chooseTwo(page, clock.id, month.id);
        await page.click('.le-group-btn');
        await settle(page);
        const group = (await boxes(page)).find((one) => one.label.startsWith('Group'));
        if (group === undefined) throw new Error('no group box after Group');
        const selector = `.le-overlay .le-widget[data-id="${group.id}"]`;
        expect(await page.getAttribute(selector, 'aria-label')).toBe(`Group of 2: clock, ${month.label.toLowerCase()}`);
        // Mark the element, so a rebuild cannot pass as a rename in place.
        await page.evaluate((s) => {
          document.querySelector<HTMLElement>(s)!.dataset['marker'] = 'kept';
        }, selector);

        await page.locator(`.le-overlay .le-widget[data-id="${month.id}"]`).click();
        await page.click('.insp-tab:has-text("Content")');
        await page.locator('.le-cfg-field[data-cfg-key="mode"] select').selectOption('list');
        await settle(page);
        const renamed = await boxById(page, month.id);
        expect(renamed.label).not.toBe(month.label);
        expect(await page.getAttribute(selector, 'data-marker'), 'the group box was rebuilt').toBe('kept');
        expect(await page.getAttribute(selector, 'aria-label')).toBe(`Group of 2: clock, ${renamed.label.toLowerCase()}`);
        expect(await page.locator('.le-layers').isHidden()).toBe(true);
        await page.click('.le-layers-btn');
        const layerNames = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.le-layer')].map((row) => [row.classList.contains('le-layer-child'), row.textContent?.trim()]),
        );
        expect(layerNames.filter(([child]) => child === true).map(([, name]) => name)).toEqual(
          expect.arrayContaining([expect.stringContaining('Clock')]),
        );
        await page.click('.le-layers-btn');

        // A row: the child's place is the order, and the panel says so.
        await selectViaLayers(page, group.id);
        await page.click('.insp-tab:has-text("Content")');
        await page.locator('.le-cfg-field[data-cfg-key="layout"] .seg button', { hasText: 'Row' }).click();
        await settle(page);
        await page.locator(`.le-overlay .le-widget[data-id="${clock.id}"]`).click();
        await page.click('.insp-tab:has-text("Style")');
        expect(await page.locator('.le-config .le-ordered').textContent()).toContain('takes its place from the group’s order');
        expect(await page.locator('.le-config .le-box').count()).toBe(0);
        // An arrow reorders it: the clock moves to the second cell, the month to the first.
        const beforeOrder = await boxById(page, clock.id);
        await page.locator(`.le-overlay .le-widget[data-id="${clock.id}"]`).focus();
        await page.keyboard.press('ArrowRight');
        await settle(page);
        const afterOrder = await boxById(page, clock.id);
        expect(afterOrder.x).toBeGreaterThan(beforeOrder.x);
        expect((await boxById(page, month.id)).x).toBe(beforeOrder.x);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A group moves as one thing, from the layout, and says it is one.
   *
   * The household's report, in its own four sentences: grouped widgets did
   * not move together, there was no way to ungroup them, nothing said they
   * were still grouped, and the only effect was that each box would no longer
   * leave the union. Each is a measurement here rather than a class. The edge
   * is the group box's *computed* outline; the grip is what
   * `elementFromPoint` answers at its own centre, because a grab handle a
   * child covers is not one; the children's rectangles are read **during**
   * the drag, before the pointer is released, because the fault was that a
   * dragged group's children caught up only on the redraw a release does —
   * a test that read them after `mouse.up` passes over it; and Ungroup is
   * pressed with a *child* selected, since a child is what a tap on the
   * layout reaches.
   */
  it(
    'moves a group and its children together by its grip, draws its edge, and offers Ungroup from a child',
    async () => {
      const wall = await newWall();
      const context = await editorContext(wall);
      try {
        const page = await context.newPage();
        await openEditor(wall, page);
        const clock = await boxNamed(page, 'Clock');
        const shift = await boxNamed(page, 'Shift');
        const canvas = await page.locator('.le-canvas').boundingBox();
        if (canvas === null) throw new Error('no canvas');
        // A plain widget has no edge of its own beyond its hairline border.
        const outlineOf = (selector: string): Promise<{ style: string; width: number }> =>
          page.evaluate((s) => {
            const el = document.querySelector<HTMLElement>(s);
            if (el === null) throw new Error(`no ${s}`);
            const computed = getComputedStyle(el);
            return { style: computed.outlineStyle, width: parseFloat(computed.outlineWidth) };
          }, selector);
        expect((await outlineOf(`.le-overlay .le-widget[data-id="${clock.id}"]`)).style).toBe('none');

        // The badge in from the right, so the group has room to move to the right.
        await dragById(page, shift.id, -Math.round(canvas.width * 0.25), 0);
        await settle(page);
        await chooseTwo(page, clock.id, shift.id);
        await page.click('.le-group-btn');
        await settle(page);
        const group = (await boxes(page)).find((one) => one.label.startsWith('Group'));
        if (group === undefined) throw new Error('no group box after Group');
        const groupSelector = `.le-overlay .le-widget[data-id="${group.id}"]`;
        const childSelector = (id: string): string => `.le-overlay .le-widget[data-id="${id}"]`;

        // 1 — It says it is a group: a dashed edge, computed, on the box.
        const edge = await outlineOf(groupSelector);
        expect(edge.style, 'the group box draws no edge of its own').toBe('dashed');
        expect(edge.width).toBeGreaterThan(0);

        // 2 — The grip is reachable: at its centre the pointer meets the grip
        // and not a widget under or beside it, and pressing it selects the group.
        const grip = page.locator(`.le-group-grip[data-for="${group.id}"]`);
        expect(await grip.textContent()).toBe('Group of 2: clock, shift');
        // Where the grip's centre is *now*: the canvas is sized to the room the
        // inspector leaves it, so a selection can move every box on the page.
        const gripCentre = async (): Promise<{ x: number; y: number }> => {
          const rect = await grip.boundingBox();
          if (rect === null) throw new Error('the group has no grip');
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        };
        const widgetUnder = (point: { x: number; y: number }): Promise<string | undefined> =>
          page.evaluate(
            ([x, y]) =>
              (
                document
                  .elementsFromPoint(x as number, y as number)
                  .find((el) => el.classList.contains('le-widget') && !el.classList.contains('is-group') && !el.classList.contains('is-child')) as
                  | HTMLElement
                  | undefined
              )?.dataset['id'],
            [point.x, point.y],
          );
        // The grip hangs over a neighbour (Classic's strip is against the top
        // of the layout, so the chip goes below it). Bring that neighbour to
        // the front first — a drag raises a box on its first move — because a
        // grip that is only reachable while everything under it happens to be
        // at z 0 is the fault a fresh Classic wall cannot show: without its own
        // stacking the grip loses to any raised box.
        const neighbour = await widgetUnder(await gripCentre());
        if (neighbour === undefined) throw new Error('nothing under the grip to raise; the fixture cannot show a covered grip');
        await dragById(page, neighbour, 0, 3);
        await settle(page);
        expect(Number((await boxById(page, neighbour)).z), 'the neighbour was not raised').toBeGreaterThan(Number(group.z));
        const centre = await gripCentre();
        expect(await widgetUnder(centre), 'the raised neighbour is no longer under the grip').toBe(neighbour);
        const under = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x as number, y as number)?.className ?? '',
          [centre.x, centre.y],
        );
        expect(under, 'something covers the grip at its own centre').toContain('le-group-grip');
        await page.locator(childSelector(clock.id)).click();
        await settle(page);
        expect(await page.getAttribute(groupSelector, 'aria-pressed')).toBe('false');
        // A child selected: the group's edge takes the accent, so the household
        // can see what else the tapped widget is grouped with.
        expect(await page.evaluate((s) => document.querySelector(s)?.classList.contains('is-parent-selected'), groupSelector)).toBe(true);
        await grip.click();
        await settle(page);
        expect(await page.getAttribute(groupSelector, 'aria-pressed'), 'pressing the grip did not select the group').toBe('true');

        // 3 — Dragging the grip moves the children with the group, during the drag.
        const rects = async (): Promise<Record<string, { x: number; y: number }>> => {
          const out: Record<string, { x: number; y: number }> = {};
          for (const [key, selector] of [['group', groupSelector], ['clock', childSelector(clock.id)], ['shift', childSelector(shift.id)]] as const) {
            const rect = await page.locator(selector).boundingBox();
            if (rect === null) throw new Error(`no rectangle for ${key}`);
            out[key] = { x: rect.x, y: rect.y };
          }
          return out;
        };
        const before = await rects();
        const travel = { x: Math.round(canvas.width * 0.1), y: Math.round(canvas.height * 0.2) };
        const grab = await gripCentre();
        await page.mouse.move(grab.x, grab.y);
        await page.mouse.down();
        await page.mouse.move(grab.x + travel.x, grab.y + travel.y, { steps: 6 });
        // Before release: the box has moved, and every child by the same amount.
        const during = await rects();
        const moved = { x: during['group']!.x - before['group']!.x, y: during['group']!.y - before['group']!.y };
        expect(moved.y, 'the group did not move with the pointer').toBeGreaterThan(travel.y / 2);
        expect(moved.x).toBeGreaterThan(travel.x / 2);
        for (const key of ['clock', 'shift'] as const) {
          expect(Math.abs(during[key]!.x - before[key]!.x - moved.x), `${key} did not follow the group across, mid-drag`).toBeLessThanOrEqual(1);
          expect(Math.abs(during[key]!.y - before[key]!.y - moved.y), `${key} did not follow the group down, mid-drag`).toBeLessThanOrEqual(1);
        }
        await page.mouse.up();
        await settle(page);
        const after = await rects();
        for (const key of ['clock', 'shift'] as const) {
          expect(Math.abs(after[key]!.x - after['group']!.x - (before[key]!.x - before['group']!.x))).toBeLessThanOrEqual(1);
          expect(Math.abs(after[key]!.y - after['group']!.y - (before[key]!.y - before['group']!.y))).toBeLessThanOrEqual(1);
        }
        // And the children's own boxes say the same as the group's: the
        // overlay is `positionBox`'s writing, not the browser's arithmetic.
        const placed = await boxById(page, group.id);
        expect((await boxById(page, clock.id)).x).toBeCloseTo(placed.x, 1);
        expect((await boxById(page, shift.id)).y).toBeCloseTo(placed.y, 1);

        // 4 — Ungroup is offered with a child selected, and acts on its group.
        await page.locator(childSelector(clock.id)).click();
        await settle(page);
        expect(await page.locator('.le-ungroup-btn').isVisible(), 'a selected child offers no Ungroup').toBe(true);
        expect(await page.locator('.le-group-btn').isHidden()).toBe(true);
        await page.click('.le-ungroup-btn');
        await settle(page);
        expect((await boxes(page)).some((one) => one.id === group.id)).toBe(false);
        expect(await page.locator('.le-group-grip').count()).toBe(0);
        expect(await page.getAttribute(childSelector(clock.id), 'data-parent')).toBeNull();
        expect((await outlineOf(childSelector(clock.id))).style).toBe('none');
        const chosen = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.le-overlay .le-widget[aria-pressed="true"]')].map((el) => el.dataset['id']),
        );
        expect(chosen.sort()).toEqual([clock.id, shift.id].sort());
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

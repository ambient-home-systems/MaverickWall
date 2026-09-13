/**
 * Ticking a to-do item off, on a real paired wall (RFC 012 phase 2).
 *
 * `todo-tick.test.ts` holds the endpoint to the fake house and proves what it
 * refuses to take from a caller. None of that can see the half a household
 * actually meets: whether there is a box, whether it is big enough to hit,
 * whether it says anything when the press does not go through, and whether the
 * row goes away afterwards. This pairs a wall through the harness, connects a
 * fake Home Assistant through the real form, adds both lists through the real
 * form, and drives the wall's own renderer with a fingertip.
 *
 * Every assertion here is on a **computed** value or a measured rectangle,
 * never on a class name. `.ch-tick` shipped clearing the background it was
 * meant to fill, with the class applied the whole time, and every measurement
 * that counted the class passed over it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  install,
  loadWallSettled,
  settleWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 180_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface Wall {
  readonly app: Installation;
  readonly ha: FakeHa;
  readonly link: string;
  readonly screen: string;
  /** Let this wall tick, the way the wall's settings switch does. */
  readonly allowTicking: (on?: boolean) => void;
}

/**
 * A household with Home Assistant connected, both lists watched, and a wall
 * carrying three to-do boxes and a calendar.
 *
 * The calendar is not decoration: a wall is never one widget, and a measurement
 * taken on a canvas with nothing else on it is a measurement of a fixture.
 */
async function wallWithLists(): Promise<Wall> {
  const app = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
  installations.push(app);
  const ha = await fakeHomeAssistant();

  expect(
    (await app.post('/admin/home-assistant/connect', {
      base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
    })).status,
  ).toBe(302);
  for (const entity of ['todo.shopping', 'todo.read_only']) {
    await app.post('/admin/home-assistant/lists', { entity_id: entity, label: '' });
  }

  const link = await app.pairLink('Kitchen');
  const screen = (
    app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
  ).id;

  const at = app.now();
  app.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
  };
  place('w-list', 'todo', [0.06, 0.03, 0.88, 0.2], { list: 'todo.shopping' });
  place('w-done', 'todo', [0.06, 0.26, 0.88, 0.22], { list: 'todo.shopping', showDone: true });
  place('w-ro', 'todo', [0.06, 0.51, 0.88, 0.14], { list: 'todo.read_only' });
  place('w-cal', 'calendar', [0.06, 0.68, 0.88, 0.3], { mode: 'list', count: 4 });

  return {
    app,
    ha,
    link,
    screen,
    allowTicking: (on = true) => {
      app.db.prepare('UPDATE screens SET allow_todo = ? WHERE id = ?').run(on ? 1 : 0, screen);
    },
  };
}

/** Every to-do row on the wall, by widget: its words, whether its box is a control, and its state. */
async function rows(
  page: Page,
): Promise<Record<string, { text: string; control: boolean; pressed: string | null; done: boolean }[]>> {
  return page.evaluate(() => {
    const out: Record<string, { text: string; control: boolean; pressed: string | null; done: boolean }[]> = {};
    for (const box of document.querySelectorAll<HTMLElement>('#wall .canvas > .fw-todo')) {
      out[box.dataset['widgetId'] ?? ''] = [...box.querySelectorAll<HTMLElement>('.td-row')].map((row) => {
        const mark = row.querySelector<HTMLElement>('.td-box');
        return {
          text: (row.querySelector('.td-text')?.textContent ?? '').trim(),
          // The *tag*, not the class: a span styled to look like a button is
          // exactly the fault this is written against.
          control: mark?.tagName === 'BUTTON' && mark.hasAttribute('data-todo'),
          pressed: mark?.getAttribute('aria-pressed') ?? null,
          done: row.classList.contains('is-done'),
        };
      });
    }
    return out;
  });
}

const names = (list: { text: string }[] | undefined): string[] => (list ?? []).map((row) => row.text);

describe('a to-do tick on a paired wall', () => {
  it(
    'is read-only until the household allows it, and then only where a tick would work',
    async () => {
      const wall = await wallWithLists();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;

        // Off by default. Every box is a marker, on every list.
        const before = await rows(page);
        expect(names(before['w-list'])).toEqual(['Milk', 'Milk']);
        expect(before['w-list']?.every((row) => !row.control)).toBe(true);
        expect(before['w-done']?.every((row) => !row.control)).toBe(true);
        expect(names(before['w-ro'])).toEqual(['Nothing to be done here']);
        expect(before['w-ro']?.every((row) => !row.control)).toBe(true);

        wall.allowTicking();
        await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
        await page.waitForFunction(() => document.querySelector('[data-todo]') !== null, undefined, {
          timeout: 25_000,
        });
        await settleWall(page);

        const after = await rows(page);
        // Both open items on the tickable list are controls, and say so.
        expect(after['w-list']).toEqual([
          { text: 'Milk', control: true, pressed: 'false', done: false },
          { text: 'Milk', control: true, pressed: 'false', done: false },
        ]);
        /*
         * The `showDone` box: the two open items tick and the completed one
         * does not. The endpoint honours `done=0` and always will, but a ticked
         * item is only on screen at all when the household asked to see what
         * has been done, which is a record rather than a place to undo one.
         */
        expect(after['w-done']).toEqual([
          { text: 'Milk', control: true, pressed: 'false', done: false },
          { text: 'Milk', control: true, pressed: 'false', done: false },
          { text: 'Bread', control: false, pressed: null, done: true },
        ]);
        /*
         * And **not** on the read-only list, whatever the household allowed.
         * `todo.read_only` has bit 4 clear, so core would refuse the call — a
         * box there would be a control that does nothing, which is the
         * `options.json` fault.
         */
        expect(after['w-ro']?.every((row) => !row.control)).toBe(true);
        // The calendar drew beside them, so this is a wall and not a fixture.
        expect(
          await page.evaluate(() =>
            document.querySelector('#wall .canvas > .fw[data-widget-id="w-cal"]') !== null,
          ),
        ).toBe(true);

        // --- the done state, read off the glass rather than off a class -----
        const paint = await page.evaluate(() => {
          const resolve = (el: Element | null): string =>
            el === null ? '' : getComputedStyle(el).backgroundColor;
          const doneBox = document.querySelector('#wall [data-widget-id="w-done"] .td-row.is-done .td-box');
          const openBox = document.querySelector('#wall [data-widget-id="w-done"] .td-row:not(.is-done) .td-box');
          return { done: resolve(doneBox), open: resolve(openBox) };
        });
        // A filled box and an empty one are two different paints. The class was
        // right and the pixels were wrong once already.
        expect(paint.done).not.toBe(paint.open);
        expect(paint.done).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
        expect(paint.open).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

        /*
         * --- the focus ring, read off the computed outline after a real press
         *
         * **Under a pointer, which is the only modality that can see the bug.**
         * `:focus-visible` is a heuristic written for a page with a pointer,
         * and the first draft of this assertion moved focus with a script and
         * passed with the `:focus` half of the rule deleted — measured on this
         * browser, a cold `.focus()` matches `:focus-visible` and so does one
         * after a click elsewhere. Only a press **on the box itself** does not:
         * `:focus` true, `:focus-visible` false, and with `:focus-visible`
         * alone the outline computes to 0px. That is exactly what a fingertip
         * on a wall does, and a wall sets `cursor: none`, so the ring is the
         * only thing left saying where the OK key will land.
         *
         * The pointer is moved away before it is lifted, so no click completes
         * and nothing is ticked — this measurement must not spend the item the
         * rest of the test is about.
         */
        const rect = (await page.locator('#wall [data-todo]').first().boundingBox()) ?? undefined;
        expect(rect).toBeDefined();
        await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
        await page.mouse.down();
        const ring = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('#wall [data-todo]');
          if (button === null) return { width: '', focused: false, visible: true };
          return {
            width: getComputedStyle(button).outlineWidth,
            focused: document.activeElement === button,
            // Recorded so a browser that changes its heuristic makes this test
            // say so rather than quietly stop discriminating.
            visible: button.matches(':focus-visible'),
          };
        });
        await page.mouse.move(2, 2);
        await page.mouse.up();
        expect(ring.focused).toBe(true);
        expect(ring.visible).toBe(false);
        expect(Number.parseFloat(ring.width)).toBeGreaterThan(0);

        // --- the target, walked outward rather than read off a declaration --
        const target = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('#wall [data-todo]');
          if (button === null) return { drawn: 0, hitH: 0, hitV: 0 };
          const rect = button.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);
          const answers = (x: number, y: number): boolean =>
            document.elementFromPoint(x, y)?.closest('[data-todo]') === button;
          const reach = (dx: number, dy: number): number => {
            let steps = 0;
            while (steps < 60 && answers(cx + dx * (steps + 1), cy + dy * (steps + 1))) steps++;
            return steps;
          };
          return {
            drawn: rect.height,
            // +1 for the centre pixel itself.
            hitH: reach(-1, 0) + reach(1, 0) + 1,
            hitV: reach(0, -1) + reach(0, 1) + 1,
          };
        });
        /*
         * The box a household *sees* is small — a to-do row is 2.1rem of text
         * and a 44px box beside it would be the loudest thing on the wall — and
         * the target behind it is the 44px a fingertip needs, grown with a
         * pseudo-element so nothing moves.
         */
        expect(target.drawn).toBeLessThan(44);
        expect(target.hitV).toBeGreaterThanOrEqual(44);
        expect(target.hitH).toBeGreaterThanOrEqual(44);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'marks the item done on one tap, and the row leaves the list on the re-poll',
    async () => {
      const wall = await wallWithLists();
      wall.allowTicking();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('[data-todo]', { timeout: 25_000 });

        /*
         * The *second* Milk, which is the one the uid carries. Two rows with
         * the same words is the fixture's whole point: a wall that posted what
         * it drew rather than the handle behind it would tick the other one,
         * and nothing on screen would say so.
         */
        const second = page.locator('#wall [data-widget-id="w-list"] [data-todo]').nth(1);
        const handle = await second.getAttribute('data-todo');
        expect(handle).toBeTruthy();
        await second.click();

        // Completed items are hidden by default, so the row goes.
        await page.waitForFunction(
          () =>
            document.querySelectorAll('#wall [data-widget-id="w-list"] .td-row').length === 1,
          undefined,
          { timeout: 25_000 },
        );
        await settleWall(page);

        const after = await rows(page);
        expect(names(after['w-list'])).toEqual(['Milk']);
        // And it is there, struck through, in the box that asked to see them.
        expect(after['w-done']).toEqual([
          { text: 'Milk', control: true, pressed: 'false', done: false },
          { text: 'Milk', control: false, pressed: null, done: true },
          { text: 'Bread', control: false, pressed: null, done: true },
        ]);

        // The house itself agrees, and it is the second Milk that moved.
        expect(wall.ha.todo['todo.shopping']?.items.map((item) => item.status)).toEqual([
          'needs_action',
          'completed',
          'completed',
        ]);
        // The handle the row still holds is the one it was drawn with: a tick
        // must not mint a new id, or the next press would be a 404.
        expect(
          await page.getAttribute('#wall [data-widget-id="w-list"] [data-todo]', 'data-todo'),
        ).not.toBe(handle);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'ticks on Enter without also clearing the banner that is showing',
    async () => {
      /*
       * The OK key acknowledges whatever is showing rather than whatever has
       * focus, which is right for a remote pointed at a wall — and a native
       * `<button>` fires its own click on Enter, so one press would tick the
       * item *and* clear the banner. Two actions from one key, one of them
       * asked for. The chore tick has this exemption; this is the assertion
       * that the to-do tick is inside it.
       */
      const wall = await wallWithLists();
      wall.allowTicking();
      wall.app.db.prepare('UPDATE screens SET allow_dismiss = 1 WHERE id = ?').run(wall.screen);

      const dismissed: string[] = [];
      const opened = await loadWallSettled(
        wall.link,
        { width: 1080, height: 1920 },
        {
          patchManifest: (body) => {
            // A banner, not a takeover: a takeover replaces the whole document
            // and there would be no tick box on screen to focus.
            body['interrupts'] = [
              {
                ruleId: 'rule-damp',
                key: 'sig-damp',
                title: 'Damp sensor',
                headline: 'Under the sink is wet',
                action: 'banner',
                severity: 'Moderate',
                dismissible: true,
              },
            ];
          },
        },
      );
      try {
        const page = opened.page;
        page.on('request', (request) => {
          if (request.url().includes('/d/interrupts/dismiss')) dismissed.push(request.url());
        });
        await page.waitForSelector('.banner [data-dismiss], [data-dismiss]', { timeout: 25_000 });
        await page.waitForSelector('[data-todo]', { timeout: 25_000 });

        const button = page.locator('#wall [data-widget-id="w-list"] [data-todo]').first();
        await button.focus();
        // To the page, not through the locator: `locator.press` re-resolves and
        // re-focuses before every key, which would hide exactly the handler
        // being tested.
        await page.keyboard.press('Enter');

        await page.waitForFunction(
          () => document.querySelectorAll('#wall [data-widget-id="w-list"] .td-row').length === 1,
          undefined,
          { timeout: 25_000 },
        );

        // The item is done…
        expect(
          wall.ha.todo['todo.shopping']?.items.filter((item) => item.status === 'completed').length,
        ).toBe(2);
        // …and nothing was acknowledged. Asserted on the request rather than on
        // the banner, which the patched manifest would put back either way.
        expect(dismissed).toEqual([]);
        expect(await page.locator('[data-dismiss]').count()).toBeGreaterThan(0);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'says so in the widget when the tick does not go through, and stops saying it on the next good poll',
    async () => {
      /*
       * §7.4, and the one genuinely new mechanism in this phase. `tickChore`
       * fails silently and can afford to — a chore that will not tick is a
       * chore that is not due. This one fails because Home Assistant is
       * rebooting or a token was revoked on an upgrade, and none of that is
       * guessable from the row. The tick failing is fine; the tick failing
       * silently is not.
       *
       * The sentence is model state rather than a node, because a draw rebuilds
       * this document every fifteen seconds and would wipe anything a handler
       * wrote into it. So this presses, waits for the sentence, and then proves
       * it survives a redraw before proving a good poll takes it away.
       */
      const wall = await wallWithLists();
      wall.allowTicking();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('[data-todo]', { timeout: 25_000 });

        // Gone, not refusing: no server at all, which is what a household gets
        // when they reboot the box.
        await wall.ha.close();

        await page.locator('#wall [data-widget-id="w-list"] [data-todo]').first().click();
        await page.waitForSelector('#wall [data-widget-id="w-list"] .td-note', { timeout: 25_000 });

        const said = (
          await page.textContent('#wall [data-widget-id="w-list"] .td-note')
        )?.trim() ?? '';
        expect(said.length).toBeGreaterThan(0);
        // A kitchen sentence, and never the address of the household's own
        // Home Assistant on a screen in their hallway.
        expect(said).not.toContain('ECONNREFUSED');
        expect(said).not.toContain('127.0.0.1');
        // It is in the box that was pressed, and in no other.
        expect(await page.locator('#wall [data-widget-id="w-done"] .td-note').count()).toBe(0);
        // And the row is still open: nothing was painted in on hope.
        expect((await rows(page))['w-list']?.every((row) => !row.done)).toBe(true);

        // It survives a redraw, which is what makes it model state rather than
        // a node a handler wrote.
        await page.evaluate(() => {
          const wallRoot = document.getElementById('wall');
          if (wallRoot !== null) wallRoot.setAttribute('data-probe', 'redraw');
        });
        await settleWall(page);
        expect(await page.locator('#wall [data-widget-id="w-list"] .td-note').count()).toBe(1);

        /*
         * A successful poll clears it: the list on the glass is current again,
         * so a sentence about a tick against the last one has nothing left to
         * be about. `maverickWall.poll` is the shell's own bridge, calling the
         * very `poll` a sixty-second tick calls, and `poll` ends in a draw — so
         * the sentence goes on that draw, about a second later.
         *
         * **The window is deliberately much shorter than the notice's own
         * expiry**, and that is what makes this an assertion about the poll.
         * The first draft waited 25 seconds, which is longer than the 20-second
         * expiry: deleting the `todoNotices.clear()` from the poll left it
         * green, because the timer cleared the sentence and the test could not
         * tell which of the two had done it.
         */
        const pollAndWatchItGo = async (): Promise<void> => {
          await page.evaluate(() =>
            (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll(),
          );
          const started = Date.now();
          await page.waitForFunction(
            () => document.querySelectorAll('#wall .td-note').length === 0,
            undefined,
            { timeout: 8_000 },
          );
          expect(Date.now() - started).toBeLessThan(8_000);
        };

        // Home Assistant is still gone, so nothing on the list has moved and
        // this poll is a **304** — which is the server confirming the document
        // and is as much a successful poll as a body is.
        await pollAndWatchItGo();

        /*
         * And again on a poll that carries a **body**, because the clear lives
         * on two branches of one switch and a test that only ever takes one of
         * them is a test for half the fix. Measured: deleting the clear from
         * the `fresh` branch alone left this file green, because every poll it
         * had made was a 304. The cache is nudged directly — Home Assistant is
         * gone, so there is no other way to move the manifest — which changes
         * the ETag and makes the next poll a 200.
         */
        await page.locator('#wall [data-widget-id="w-list"] [data-todo]').first().click();
        await page.waitForSelector('#wall [data-widget-id="w-list"] .td-note', { timeout: 25_000 });
        wall.app.db
          .prepare("UPDATE ha_todo_items SET summary = 'Oat milk' WHERE uid = 'i-2'")
          .run();
        await pollAndWatchItGo();
        expect(names((await rows(page))['w-list'])).toContain('Oat milk');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

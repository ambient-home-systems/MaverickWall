/**
 * How far down a phone the first thing you can act on sits (RFC 014 §8).
 *
 * The measurement this project counts, and the one the RFC could not take:
 * Appendix B's figures are of a *reconstruction* — the admin's markup rebuilt
 * against the real tokens on a canvas, with a plausible household on it — and
 * this repository has been wrong that way before, when a month grid was
 * measured on a widget nobody ships and the shipped wall turned out tighter.
 * So this is the real app, a real session, a real fake house with readings,
 * a calendar, a list and a rule on it, at 390px.
 *
 * **The before is 355px**, taken on a clean worktree of `main` at `e819cca`
 * with this same fixture and this same definition of "actionable", at the same
 * viewport. The document was 5,314px tall. It is written here as a literal
 * because that tree no longer exists in this branch, which is the only honest
 * way to carry a before — re-deriving it from the current source would be
 * measuring the thing under test against itself.
 *
 * "Actionable" is deliberately scoped to `main .content` and not to the
 * document: the app bar's menu button is chrome on every admin screen and
 * counting it would make all six screens read 0 and say nothing. What is being
 * measured is how far past a screen's own preamble a household has to go to
 * reach the control the screen is for.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

/** Measured on a clean worktree of `main` at `e819cca`, same fixture, 390px. */
const BEFORE = { path: '/admin/home-assistant', firstControl: 355, documentHeight: 5314 };

const ACTIONABLE =
  'input:not([type="hidden"]), select, textarea, button, a.btn, a.mw-row-link, summary, a.link';

async function measure(page: Page): Promise<{ firstControl: number; documentHeight: number }> {
  return page.evaluate((selector) => {
    const root = document.querySelector('main .content');
    if (root === null) throw new Error('no .content on this page');
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const box = el.getBoundingClientRect();
      // A control with no box is not one somebody can reach.
      if (box.width === 0 && box.height === 0) continue;
      return {
        firstControl: Math.round(box.top + window.scrollY),
        documentHeight: document.documentElement.scrollHeight,
      };
    }
    throw new Error('no actionable control inside .content');
  }, ACTIONABLE);
}

const SCREENS = [
  '/admin/home-assistant',
  '/admin/home-assistant/connection',
  '/admin/home-assistant/readings',
  '/admin/home-assistant/calendars',
  '/admin/home-assistant/lists',
  '/admin/home-assistant/alerts',
  /*
   * The four add pages P2.1 moved each screen's form to. Measured on the same
   * claim as the six: a household pressing "Add …" meets the control the page
   * is for above where the one page they replace put its first control.
   */
  '/admin/home-assistant/readings/new',
  '/admin/home-assistant/calendars/new',
  '/admin/home-assistant/lists/new',
  '/admin/home-assistant/alerts/new',
] as const;

describe('the Home Assistant screens on a phone', () => {
  it(
    'puts the first thing you can act on above where the old page did, on every one of the ten',
    async () => {
      const home = await install();
      installations.push(home);
      const ha = await fakeHomeAssistant();

      // The same household the before was measured against: connected, with
      // one of each thing on it, through the real forms.
      expect(
        (await home.post('/admin/home-assistant/connect', {
          base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
        })).status,
      ).toBe(302);
      await home.post('/admin/home-assistant/entities', {
        entity_id: 'sensor.kitchen_temperature', label: '', display_mode: '',
      });
      await home.post('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: 'Shopping' });
      await home.post('/admin/home-assistant/rules', {
        name: 'Freezer door left open', entity_id: 'binary_sensor.freezer_door',
        condition: 'equals', value: 'on', for_minutes: '5', action: 'banner',
      });

      const context = await (await browser()).newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      await home.signIn(page);

      const after: Record<string, { firstControl: number; documentHeight: number }> = {};
      try {
        for (const path of SCREENS) {
          await page.goto(`${home.base}${path}`, { waitUntil: 'load' });
          after[path] = await measure(page);
        }
      } finally {
        await context.close();
      }

      // eslint-disable-next-line no-console
      console.log(
        `[ha-phone] before ${BEFORE.path} firstControl=${BEFORE.firstControl}px ` +
          `document=${BEFORE.documentHeight}px\n` +
          SCREENS.map(
            (path) =>
              `[ha-phone] after  ${path} firstControl=${after[path]?.firstControl}px ` +
              `document=${after[path]?.documentHeight}px`,
          ).join('\n'),
      );

      /*
       * The claim, stated as the thing the split was for rather than as a
       * number somebody tuned to: on every one of the six, the first control is
       * higher up than it was on the one page they replace. A screen that came
       * out *lower* would mean the split had moved the preamble rather than
       * removed it.
       */
      for (const path of SCREENS) {
        expect(
          after[path]?.firstControl,
          `${path} puts its first control at ${after[path]?.firstControl}px, ` +
            `against ${BEFORE.firstControl}px on the page it replaces`,
        ).toBeLessThan(BEFORE.firstControl);
      }

      /*
       * And the document is shorter everywhere, which is the other half of §1's
       * complaint — the old page was one document doing five unrelated jobs, so
       * a phone scrolled past readings, calendars and to-do lists to reach a
       * rule.
       */
      for (const path of SCREENS) {
        expect(
          after[path]?.documentHeight,
          `${path} is ${after[path]?.documentHeight}px tall against ${BEFORE.documentHeight}px`,
        ).toBeLessThan(BEFORE.documentHeight);
      }
    },
    SLOW,
  );
});

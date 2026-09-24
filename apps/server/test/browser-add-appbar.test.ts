/**
 * P2.1's app-bar "Add …", measured at 390px — the plan's own instruction: the
 * long verbs ("Add a shift type") are used unless a phone cannot fit them, and
 * whether it can is a measurement, not a guess.
 *
 * Every assertion is on the glass: the action's own rectangle against the
 * viewport, the number of lines its label actually broke onto (read off a
 * Range's client rects, since a button's box says nothing about whether the
 * words inside it wrapped), and whether the heading beside it overflowed its
 * own box. Shift types was the tightest case when this was written — a back
 * crumb *and* an action in the same bar — and the four Home Assistant list
 * screens are the same shape, with "Tell me when…" the longest heading of them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 90_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const LISTS: readonly (readonly [string, string])[] = [
  ['/admin/calendars', 'Add a calendar'],
  ['/admin/people', 'Add a person'],
  ['/admin/shifts', 'Add a rotation'],
  ['/admin/shifts/types', 'Add a shift type'],
  ['/admin/chores', 'Add a chore'],
  ['/admin/themes', 'Add a theme'],
  // P2.1's second half and P2.2. "Tell me when…" is the tightest of these:
  // a back crumb, the longest heading on any list, and an action beside it.
  ['/admin/walls', 'Add a wall'],
  ['/admin/home-assistant/readings', 'Add readings'],
  ['/admin/home-assistant/calendars', 'Add a calendar'],
  ['/admin/home-assistant/lists', 'Add a list'],
  ['/admin/home-assistant/alerts', 'Add a rule'],
];

describe('the app bar\'s "Add …" on a 390px phone', () => {
  it(
    'fits whole, on one line, beside a heading that does not overflow',
    async () => {
      const home = await install({});
      installations.push(home);
      const context = await (await browser()).newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await home.signIn(page);

      /*
       * The bar's height with no action in it, read off a page that has none.
       * A label that does not fit rarely wraps itself — it is `nowrap` — it
       * squeezes the heading beside it onto a second line instead, and the bar
       * grows; that is the fault this has to be able to see.
       */
      await page.goto(`${home.base}/admin/system`, { waitUntil: 'load' });
      const plainBar = await page.evaluate(
        () => (document.querySelector('header.topbar') as HTMLElement).getBoundingClientRect().height,
      );

      const measured: string[] = [];
      for (const [path, label] of LISTS) {
        await page.goto(`${home.base}${path}`, { waitUntil: 'load' });
        const read = await page.evaluate(() => {
          const bar = document.querySelector('header.topbar') as HTMLElement;
          const action = bar.querySelector('a.btn') as HTMLElement | null;
          const h1 = bar.querySelector('h1') as HTMLElement;
          if (action === null) return null;
          const range = document.createRange();
          range.selectNodeContents(action);
          const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
          const heading = document.createRange();
          heading.selectNodeContents(h1);
          const h1Lines = new Set([...heading.getClientRects()].map((r) => Math.round(r.top))).size;
          const box = action.getBoundingClientRect();
          const barBox = bar.getBoundingClientRect();
          return {
            label: (action.textContent ?? '').trim(),
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            lines,
            h1Lines,
            actionOverflow: action.scrollWidth - action.clientWidth,
            h1Overflow: h1.scrollWidth - h1.clientWidth,
            barHeight: barBox.height,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(read, `${path} has an app-bar action`).not.toBeNull();
        const r = read as NonNullable<typeof read>;
        measured.push(
          `${path}: "${r.label}" ${r.width.toFixed(1)}x${r.height.toFixed(1)} at ${r.left.toFixed(1)}–${r.right.toFixed(1)}, ` +
            `${r.lines} line(s), bar ${r.barHeight.toFixed(1)}px`,
        );
        expect(r.label, `${path} uses the long verb`).toBe(label);
        expect(r.lines, `${path}: "${r.label}" wrapped`).toBe(1);
        expect(r.actionOverflow, `${path}: the label overflows its button`).toBeLessThanOrEqual(0);
        expect(r.right, `${path}: the action runs off the glass`).toBeLessThanOrEqual(390);
        expect(r.left, `${path}: the action starts off the glass`).toBeGreaterThanOrEqual(0);
        expect(r.h1Overflow, `${path}: the heading overflows beside it`).toBeLessThanOrEqual(0);
        expect(r.h1Lines, `${path}: the heading was pushed onto a second line`).toBe(1);
        expect(r.barHeight, `${path}: the app bar grew to fit its action`).toBeCloseTo(plainBar, 0);
        expect(r.pageOverflow, `${path}: the page scrolls sideways`).toBeLessThanOrEqual(0);
        // The touch minimum, on the device this is read on.
        expect(r.height).toBeGreaterThanOrEqual(36);
      }
      // The numbers, for the record the plan asks this measurement to leave.
      console.log(measured.join('\n'));
      await context.close();
    },
    SLOW,
  );
});

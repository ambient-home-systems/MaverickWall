/**
 * The widget inspector, measured at the widths a household actually opens it at.
 *
 * Two faults were reported from real screens and neither is visible in the
 * markup or in the stylesheet's own text, which is why this file exists beside
 * `admin-seg-labels.test.ts` rather than inside it:
 *
 *  - **a segmented control breaking its labels mid-word** — "Na/mes",
 *    "Labelle/d pills" — while the control it was in had 60px of slack across
 *    it. Two correct-looking declarations produced it (`flex:1` from the global
 *    rule, `overflow-wrap:anywhere` from this scope), and a source-text
 *    assertion could see neither the widths nor the breaks;
 *  - **the inspector's sheet lying over the navigation** between 901 and
 *    1199px, where the drawer is a real in-flow column, while the save bar
 *    directly beneath it started 264px further right — and, in the same band,
 *    every settings row inside it stretched the width of the viewport, so a
 *    switch sat 943px from its own label.
 *
 * So everything here is a measurement of a real page in a real browser, and the
 * mid-word check in particular is done by reading which characters landed on
 * which line rather than by trusting a width: "the label fits" and "the label
 * was cut in the middle of a word" are different questions, and only the second
 * one is the bug.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, HOUSEHOLD_CALENDARS, type Installation } from './browser-harness.js';
import { applyTemplate } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * The widths this file measures.
 *
 * Chosen for the boundaries rather than for coverage: 1200 is where the
 * inspector stops being a column and becomes a sheet (and so is the narrowest
 * the *column* ever gets, which is where the label breaking was reported);
 * 1199 and 901 are the ends of the band where the sheet and the in-flow drawer
 * overlap; 899 is one pixel the other side of it, where the drawer goes
 * off-canvas and the sheet is meant to take the whole viewport; 390 is the
 * phone the editor was redesigned for.
 */
const WIDTHS = [1600, 1440, 1280, 1200, 1199, 1024, 901, 899, 768, 430, 390] as const;

/** One segment, and how its label was actually broken across lines. */
interface Segment {
  readonly control: string;
  readonly text: string;
  readonly width: number;
  readonly lines: readonly string[];
  /**
   * Unused horizontal space inside the segment: its content box less the
   * widest line the label actually drew.
   *
   * This is what says whether a wrap was *necessary*. A label on two lines with
   * 1px to spare had nowhere to go; the same label on two lines while the
   * segment next to it sits on 19px of nothing is the control giving its room
   * to the word that did not need it.
   */
  readonly slack: number;
}

/**
 * Read every segmented control in the inspector, line by line.
 *
 * A `Range` over each character says which line box it landed in, so the label
 * can be rebuilt as the browser actually broke it. Nothing here reads a class
 * or a declared width: the whole point is that the declarations looked right.
 */
async function segments(page: Page): Promise<readonly Segment[]> {
  return page.evaluate(() => {
    const out: {
      control: string;
      text: string;
      width: number;
      lines: string[];
      slack: number;
    }[] = [];
    for (const seg of Array.from(document.querySelectorAll<HTMLElement>('.le-cfg-field .seg'))) {
      const control =
        (seg.closest('.le-cfg-field')?.querySelector('span') as HTMLElement | null)?.textContent ?? '(unlabelled)';
      for (const button of Array.from(seg.querySelectorAll('button'))) {
        const node = Array.from(button.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
        const text = button.textContent ?? '';
        if (node === null || node === undefined) continue;
        const raw = node.textContent ?? '';
        // Group characters by the top of the line box each one landed on.
        const byTop = new Map<number, string>();
        const order: number[] = [];
        for (let i = 0; i < raw.length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (rect === undefined) continue;
          const top = Math.round(rect.top);
          if (!byTop.has(top)) {
            byTop.set(top, '');
            order.push(top);
          }
          byTop.set(top, (byTop.get(top) ?? '') + raw[i]);
        }
        order.sort((a, b) => a - b);
        const whole = document.createRange();
        whole.selectNodeContents(node);
        const drawn = Math.max(0, ...Array.from(whole.getClientRects()).map((r) => r.width));
        const style = getComputedStyle(button);
        const inner =
          button.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        out.push({
          control,
          text,
          width: Math.round(button.getBoundingClientRect().width),
          lines: order.map((top) => byTop.get(top) ?? ''),
          slack: Math.round(inner - drawn),
        });
      }
    }
    return out;
  });
}

/** Where the sheet, the save bar and the navigation drawer are. */
async function chrome(page: Page): Promise<{
  sheet: { left: number; right: number; width: number } | null;
  savebar: { left: number; right: number; width: number } | null;
  drawerRight: number | null;
  widestGutter: number;
}> {
  return page.evaluate(() => {
    const rect = (selector: string): { left: number; right: number; width: number } | null => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const box = el.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
    };
    // The furthest a switch's control ever sits from its own label — the
    // measurement that says whether a row is still a row.
    let widest = 0;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('.le-config .switch'))) {
      const kids = Array.from(row.children) as HTMLElement[];
      if (kids.length < 2) continue;
      const gap = kids[kids.length - 1]!.getBoundingClientRect().left - kids[0]!.getBoundingClientRect().right;
      widest = Math.max(widest, Math.round(gap));
    }
    const drawer = document.querySelector('body.shell > aside');
    return {
      sheet: rect('.lay-inspector'),
      savebar: rect('.savebar'),
      drawerRight: drawer === null ? null : Math.round(drawer.getBoundingClientRect().right),
      widestGutter: widest,
    };
  });
}

/**
 * Open a paired wall's editor with its month grid selected.
 *
 * The month grid because it carries the four-up "Events in a day" control,
 * which is the widest segmented control the inspector draws and the one the
 * fault was reported on — a two-up control has slack at any width and would
 * have gone on passing.
 */
async function openWithCalendar(app: Installation, page: Page): Promise<void> {
  // A real wall: the shared Default one is retired, and the inspector is a
  // thing a household opens on a wall they own.
  const id = await app.pairWall('Inspector wall');
  await page.goto(`${app.base}/admin/walls/${encodeURIComponent(id)}`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  // Every measurement here is a text width, so a paint that beat the admin's
  // self-hosted face would be measuring a different alphabet. The wall's own
  // font-race work is the same lesson one bundle along.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const boxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.le-overlay .le-widget')).map((el) => ({
      id: el.getAttribute('data-id'),
      label: el.getAttribute('aria-label'),
    })),
  );
  const month = boxes.find((box) => /month/i.test(box.label ?? ''));
  if (month?.id == null) throw new Error(`no month grid on this wall: ${JSON.stringify(boxes)}`);
  await page.locator(`.le-overlay .le-widget[data-id="${month.id}"]`).click();
  await page.waitForSelector('.le-cfg-field .seg', { timeout: 20_000 });
}

describe('the widget inspector, across screen sizes', () => {
  it(
    'never breaks a segment label in the middle of a word, at any width',
    async () => {
      const app = await install({ wizard: true, feed: true, calendars: HOUSEHOLD_CALENDARS.slice(0, 2) });
      installations.push(app);
      applyTemplate(app.db, null, CLASSIC_TEMPLATE);

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await app.signIn(page);

      const faults: string[] = [];
      const seen = new Set<string>();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await openWithCalendar(app, page);
        for (const segment of await segments(page)) {
          seen.add(segment.text);
          /*
           * A break is legitimate exactly when every line is a run of whole
           * words: rejoining the lines with single spaces has to give back the
           * label. "Labelled pills" over two lines is fine; "Labelle" + "d
           * pills" is the reported bug, and the two are the same *height* and
           * the same *width*, which is why neither could see it.
           */
          const rejoined = segment.lines.map((line) => line.trim()).filter((line) => line !== '').join(' ');
          if (rejoined !== segment.text.trim()) {
            faults.push(
              `${width}px · "${segment.control}" · ${segment.width}px · ` +
                `${JSON.stringify(segment.text)} broke as ${JSON.stringify(segment.lines)}`,
            );
          }
        }
      }
      // The control the household reported, by name, so this cannot quietly go
      // green by measuring a page that no longer draws it.
      expect(seen, 'the four-up "Events in a day" control was never measured').toContain('Labelled pills');
      expect(faults).toEqual([]);
      await context.close();
    },
    SLOW,
  );

  it(
    'never wraps one label while the segment beside it sits on empty space',
    async () => {
      /*
       * The other half of the same report, and the half a "did it break inside
       * a word" check cannot see.
       *
       * `flex:1` — the global rule every segmented control in this admin takes
       * — is `flex:1 1 0%`: each segment gets an equal share of the row
       * whatever is written on it, so "Dots" and "Labelled pills" are the same
       * width and the long one wraps while the short one keeps 19px of nothing.
       * That is a control that looks broken while every individual label is
       * intact, which is why it survived a file of source-text assertions.
       *
       * Two declarations fix it and each removes a measurable part. Swept
       * across every segmented control the inspector draws — six widget types,
       * both tabs, nine widths, 126 controls in all — the counts of "a label
       * wrapped while a single-line sibling had more room than it did" are:
       *
       *   flex:1 (equal shares)                17
       *   flex:1 1 auto, min-width:auto         4
       *   flex:1 1 auto, min-width:0            0
       *
       * So it is asserted at zero rather than at a threshold: it is a number
       * the shipped rule actually reaches, and both halves were confirmed by
       * reverting them in turn.
       *
       * The cost of the second is three labels drawn 2-5px wider than their own
       * content box, which is absorbed by the 8px padding either side and is
       * why `overflow:visible` matters here beyond the focus ring.
       */
      const app = await install({ wizard: true, feed: true, calendars: HOUSEHOLD_CALENDARS.slice(0, 2) });
      installations.push(app);
      applyTemplate(app.db, null, CLASSIC_TEMPLATE);

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await app.signIn(page);

      const starved: string[] = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await openWithCalendar(app, page);
        const all = await segments(page);
        // Group by the control each segment belongs to: the claim is about
        // siblings, so a segment is only ever compared with its own row.
        const byControl = new Map<string, Segment[]>();
        for (const segment of all) {
          const list = byControl.get(segment.control) ?? [];
          list.push(segment);
          byControl.set(segment.control, list);
        }
        for (const [control, group] of byControl) {
          for (const wrapped of group.filter((one) => one.lines.length > 1)) {
            for (const sibling of group) {
              if (sibling === wrapped || sibling.lines.length > 1) continue;
              if (sibling.slack > wrapped.slack) {
                starved.push(
                  `${width}px · "${control}" · ${JSON.stringify(wrapped.text)} wrapped with ` +
                    `${wrapped.slack}px spare while ${JSON.stringify(sibling.text)} sat on ${sibling.slack}px`,
                );
                break;
              }
            }
          }
        }
      }
      expect(starved).toEqual([]);
      await context.close();
    },
    SLOW,
  );

  it(
    'keeps the sheet in the save bar’s own column, and its rows a readable width',
    async () => {
      const app = await install({ wizard: true, feed: true, calendars: HOUSEHOLD_CALENDARS.slice(0, 2) });
      installations.push(app);
      applyTemplate(app.db, null, CLASSIC_TEMPLATE);

      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await app.signIn(page);

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 860 });
        await openWithCalendar(app, page);
        const at = await chrome(page);
        const where = `${width}px`;
        if (at.sheet === null || at.savebar === null) throw new Error(`no inspector or save bar at ${where}`);

        /*
         * The sheet and the save bar are one column.
         *
         * Measured before the fix at 1024px: a sheet at x=0 sitting on a save
         * bar at x=264, disagreeing by exactly the width of a navigation drawer
         * that was still on screen behind it. The two are written the same way
         * now — `left:264px`, reset to 0 in the same `max-width:900px` block
         * where the drawer goes off-canvas — so this holds at every width
         * rather than in a band somebody has to remember.
         */
        expect(at.sheet.left, `${where}: the sheet starts left of the save bar`).toBeGreaterThanOrEqual(
          at.savebar.left,
        );

        // And it never covers a drawer that is in flow. Below 900px the drawer
        // is off-canvas (a negative right edge) and there is nothing to cover.
        if (at.drawerRight !== null && at.drawerRight > 0) {
          expect(at.sheet.left, `${where}: the sheet covers the navigation`).toBeGreaterThanOrEqual(at.drawerRight);
        }

        /*
         * A settings row keeps a settings row's measure.
         *
         * 720px is `.wset-panels`' cap — this editor's own answer to the same
         * question one pane along — so the sheet is capped there and centred.
         * Measured before the fix, the widest label-to-switch gutter was 943px
         * at 1199 and 768px at 1024; the whole *sheet* is 720px now, so the
         * gutter cannot exceed that whatever is in the row.
         */
        expect(at.sheet.width, `${where}: the sheet has no measure`).toBeLessThanOrEqual(720);
        expect(at.widestGutter, `${where}: a switch is stranded from its label`).toBeLessThan(520);
      }
      await context.close();
    },
    SLOW,
  );
});

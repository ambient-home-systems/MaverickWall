/**
 * The two converted screens, measured in a real browser at both widths.
 *
 * `/admin/calendars` and `/admin/system` are the proof that the component
 * layer survives contact: one is a list of rows with per-row actions, the
 * other is settings plus downloads plus the dirty-form guard. If the
 * components hold on both, they hold on the other forty-seven.
 *
 * Everything here is measured rather than read off a class, which is this
 * codebase's own rule and was written down after a bug where the class was
 * right and the pixels were wrong: `.ch-tick` cleared the background it was
 * meant to fill, and the measurement that counted the class passed straight
 * over it. So a table's overflow is `scrollWidth` against `clientWidth`, a
 * row's target is `elementFromPoint` at the far end of the row, and "the
 * content starts here" is `getBoundingClientRect().top`.
 *
 * The tab-order assertions are the half a snapshot cannot answer at all. The
 * skip link is the first stop on every admin page and the drawer's checkbox is
 * the second below 900px — both of those are properties of `page()`'s child
 * order, which nothing in the stylesheet complains about — and a component
 * that introduced a phantom stop (an overlay that takes focus, a wrapper with
 * a `tabindex`) would move them silently.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

/** Long: each of these boots a server and a browser context. */
const SLOW = 90_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  const made = await install({ feed: true });
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const WIDTHS = [
  ['a desktop', { width: 1280, height: 800 }, false],
  ['a phone', { width: 390, height: 844 }, true],
] as const;

async function open(
  home: Installation,
  viewport: { width: number; height: number },
  mobile: boolean,
  path: string,
): Promise<Page> {
  const ctx = await (await browser()).newContext(
    mobile ? { viewport, hasTouch: true, isMobile: true } : { viewport },
  );
  const page = await ctx.newPage();
  await home.signIn(page);
  await page.goto(`${home.base}${path}`, { waitUntil: 'load' });
  return page;
}

/** The first tab stops from a freshly loaded document, as `tag.class` pairs. */
async function tabOrder(page: Page, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    out.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null) return 'NONE';
        const cls = (el.className || '').toString().split(/\s+/)[0] ?? '';
        return cls === '' ? el.tagName : `${el.tagName}.${cls}`;
      }),
    );
  }
  return out;
}

describe.each(WIDTHS)('the converted screens on %s', (_label, viewport, mobile) => {
  it(
    'starts its content immediately under the app bar, with nothing between',
    async () => {
      /*
       * The measurement the mobile-nav redesign was made on, applied to the
       * screens this phase touched. Before that redesign `.content` began 407px
       * down an 844px phone viewport — half the screen spent on navigation, on
       * every page, because each admin screen is a fresh document. The bar is
       * 64px and the content's own top padding follows it; what this refuses is
       * a component quietly inserting a band above the first thing on the page.
       */
      const home = await fresh();
      for (const path of ['/admin/calendars', '/admin/system']) {
        const page = await open(home, viewport, mobile, path);
        const geometry = await page.evaluate(() => {
          const bar = document.querySelector('.topbar') as HTMLElement;
          const content = document.querySelector('.content') as HTMLElement;
          const first = content.firstElementChild as HTMLElement;
          return {
            barBottom: bar.getBoundingClientRect().bottom,
            contentTop: content.getBoundingClientRect().top,
            firstTop: first.getBoundingClientRect().top,
            firstClass: first.className,
            hasSecondHeader: document.querySelectorAll('header').length,
            hamburgers: document.querySelectorAll('[for="mw-nav"]').length,
          };
        });

        // The content column starts where the bar ends: no band, no second
        // header, no page-level back affordance of its own.
        expect(geometry.contentTop, `${path}: content does not follow the app bar`).toBeCloseTo(
          geometry.barBottom,
          0,
        );
        expect(geometry.hasSecondHeader, `${path}: a second <header>`).toBe(1);
        // Two `for="mw-nav"` labels by design — the app bar's button and the
        // scrim that closes the drawer by being tapped. A third would be a
        // component growing its own menu control.
        expect(geometry.hamburgers, `${path}: an extra navigation control`).toBe(2);

        // And the first real thing on the page is within a screen of the top.
        expect(
          geometry.firstTop,
          `${path}: the first thing on the page (${geometry.firstClass}) is ` +
            `${Math.round(geometry.firstTop)}px down a ${viewport.height}px viewport`,
        ).toBeLessThan(viewport.height / 2);
        await page.context().close();
      }
    },
    SLOW,
  );

  it(
    'puts the skip link first and adds no tab stop in front of the content',
    async () => {
      /*
       * Sixteen stops stood between the top of a document and its first control
       * before the skip link, and every navigation paid all sixteen. The link
       * is `page()`'s first child and the drawer's checkbox its second — both
       * are properties of child order that nothing else in the product asserts.
       *
       * What this adds is the *component* half: a stretched row overlay, a
       * table wrapper or an empty state that took focus would land between the
       * drawer and `<main>` and nobody would notice until somebody tabbed.
       */
      const home = await fresh();
      for (const path of ['/admin/calendars', '/admin/system']) {
        const page = await open(home, viewport, mobile, path);
        const order = await tabOrder(page, 2);
        expect(order[0], `${path}: the first tab stop is not the skip link`).toBe('A.skip');
        // Below 900px the drawer's checkbox is a real, focusable control; at
        // desktop width the stylesheet takes it out entirely so it is not a
        // phantom first stop on a page whose drawer is always open.
        expect(order[1], `${path}: the second tab stop moved`).toBe(
          mobile ? 'INPUT.nav-toggle' : 'A.brand',
        );
        await page.context().close();
      }
    },
    SLOW,
  );

  it(
    'never scrolls the page body sideways, table and all',
    async () => {
      /*
       * The reason `dataTable` owns a wrapper. A table is the one element in
       * this admin whose intrinsic width is its content's, so on a 390px phone
       * a two-column table of machine readings pushes the *document* sideways —
       * and once the body scrolls horizontally the sticky app bar and the fixed
       * save bar slide off with it. Asserted as the page not being wider than
       * its viewport, and the wrapper being the thing that is.
       */
      const home = await fresh();
      const page = await open(home, viewport, mobile, '/admin/system');
      const measured = await page.evaluate(() => {
        const wrap = document.querySelector('.mw-table-wrap') as HTMLElement | null;
        return {
          bodyScroll: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          wrapOverflowX: wrap === null ? '' : getComputedStyle(wrap).overflowX,
          tableInside:
            wrap === null ? false : (wrap.querySelector('table.mw-table') as HTMLElement) !== null,
          // Tabular figures, read off the glass rather than off the rule.
          figures:
            wrap === null
              ? ''
              : getComputedStyle(wrap.querySelector('table') as HTMLElement).fontVariantNumeric,
        };
      });
      expect(measured.tableInside, 'System draws no data table at all').toBe(true);
      expect(measured.wrapOverflowX).toBe('auto');
      expect(measured.figures).toContain('tabular-nums');
      expect(
        measured.bodyScroll,
        `the page is ${measured.bodyScroll}px wide in a ${measured.viewport}px viewport`,
      ).toBeLessThanOrEqual(measured.viewport + 1);
      await page.context().close();
    },
    SLOW,
  );

  it(
    'draws every list row at the pointer minimum, with its trail still clickable',
    async () => {
      /*
       * Two claims, and only the second needs a browser.
       *
       * A row is at least 48px — the pointer minimum plus a rung — measured
       * rather than read off `min-height`, because a row whose content
       * overflows is taller and one whose box collapsed is not a row at all.
       *
       * And the control in the trail is still the thing under the finger. The
       * row's stretched `::after` covers the whole rectangle, so a naive
       * overlay eats the Download button beside it; `elementFromPoint` at the
       * button's own centre is the only way to ask which one wins.
       */
      const home = await fresh();
      const page = await open(home, viewport, mobile, '/admin/system');
      const rows = await page.evaluate(() => {
        /*
         * A row with nothing in it but a name, planted first, because it is the
         * only one on this page where the floor actually binds: every real row
         * here carries a title, a line of prose and a control, which come to
         * more than 48px on their own. Without it "at least 48px" is a claim
         * about the content and not about the rule, and deleting `min-height`
         * turns nothing red.
         */
        (document.querySelector('.content') as HTMLElement).insertAdjacentHTML(
          'afterbegin',
          '<div class="mw-row"><div class="mw-row-body"><b>Short</b></div></div>',
        );
        return [...document.querySelectorAll('.mw-row')].map((node) => {
          const row = node as HTMLElement;
          // `elementFromPoint` is viewport-relative, and System is a long page:
          // a row below the fold has negative-or-offscreen coordinates and the
          // answer is `null` whatever is drawn there. Scroll it under the eye
          // first, then measure — the rect has to be re-read after.
          row.scrollIntoView({ block: 'center' });
          const rect = row.getBoundingClientRect();
          const button = row.querySelector('.mw-row-trail button') as HTMLElement | null;
          let hits = '';
          if (button !== null) {
            const b = button.getBoundingClientRect();
            const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            hits = at === null ? 'NONE' : (at as HTMLElement).tagName;
          }
          return { height: rect.height, title: (row.querySelector('b')?.textContent ?? '').trim(), hits };
        });
      });
      // The planted short row, then Backup's two files and the diagnostics
      // export — in the order the page draws them.
      expect(rows.map((r) => r.title)).toEqual([
        'Short',
        'Database',
        'Encryption key',
        'Diagnostics export',
      ]);
      for (const row of rows) {
        expect(row.height, `"${row.title}" is ${Math.round(row.height)}px tall`).toBeGreaterThanOrEqual(48);
        // None of these rows navigates, so what this asks is only that nothing
        // *else* is over the control — the row's own padding, a trail wrapper
        // that swallowed it. Whether a control survives the stretched overlay
        // is asked next door, on a row that has both a link and a button, which
        // is the only shape that can tell the two apart.
        if (row.hits === '') continue;
        expect(row.hits, `"${row.title}"'s own button is not what a tap on it reaches`).toBe(
          'BUTTON',
        );
      }
      await page.context().close();
    },
    SLOW,
  );

  it(
    'makes the whole of a navigating row the target, not just its words',
    async () => {
      /*
       * `listRow`'s other half, and it needs a row that navigates. Home
       * Assistant's offer list is the one on these two screens, so this asks
       * the wall list instead — the same component, a real screen, and the
       * question is the same: does a tap at the far right of the row, well past
       * the end of the link's text, reach the link?
       *
       * Measured with `elementFromPoint` rather than by clicking, because a
       * click that navigates proves the *link* works and says nothing about
       * where its target begins and ends.
       */
      const home = await fresh();
      const page = await open(home, viewport, mobile, '/admin/calendars');
      const reach = await page.evaluate(() => {
        /*
         * A row built the way the component builds one, planted in the live
         * document so the cascade is the real one — the Home Assistant offer
         * list only draws when Home Assistant is connected, which a fresh
         * install is not.
         *
         * It carries a link *and* a trail control, which is the only shape that
         * can tell the two rules apart. A row with a link and no button proves
         * the overlay covers the row; a row with a button and no link proves
         * nothing about the overlay at all. Both of System's own list rows are
         * the second kind, which is why this one is built rather than found.
         */
        const host = document.querySelector('.content') as HTMLElement;
        host.insertAdjacentHTML(
          'afterbegin',
          '<div class="mw-row"><div class="mw-row-body">' +
            '<b><a class="mw-row-link" href="admin/walls">Kitchen</a></b>' +
            '<small>800x480</small></div>' +
            '<div class="mw-row-trail"><form method="get" action="admin/walls">' +
            '<button class="secondary" type="submit">Open</button></form></div></div>',
        );
        const row = host.querySelector('.mw-row') as HTMLElement;
        row.scrollIntoView({ block: 'center' });
        const body = row.querySelector('.mw-row-body') as HTMLElement;
        const link = row.querySelector('.mw-row-link') as HTMLElement;
        const button = row.querySelector('.mw-row-trail button') as HTMLElement;
        const l = link.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        /*
         * The dead space measured off the *body*, not off the row.
         *
         * Below 560px the row wraps and the trail takes a line of its own, so
         * "between the end of the words and the start of the button" is a
         * negative distance on a phone and reads as the two already meeting.
         * The body's own right edge past the end of the link is dead space at
         * either width, and it is where a household taps without aiming.
         */
        const far = document.elementFromPoint(bodyRect.right - 8, l.top + l.height / 2);
        const onButton = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return {
          linkRight: l.right,
          bodyRight: bodyRect.right,
          farIsLink: far !== null && (far === link || link.contains(far) || far === row),
          farTag: far === null ? 'NONE' : (far as HTMLElement).tagName,
          farClass: far === null ? '' : (far as HTMLElement).className,
          buttonTag: onButton === null ? 'NONE' : (onButton as HTMLElement).tagName,
          buttonClass: onButton === null ? '' : (onButton as HTMLElement).className,
        };
      });
      // The point being tested is genuinely past the words and short of the
      // button, or this proves nothing at all.
      expect(
        reach.bodyRight - reach.linkRight,
        'the link already fills its side of the row — there is no dead space to test',
      ).toBeGreaterThan(40);
      expect(
        reach.farIsLink,
        `a tap in the middle of the row reaches ${reach.farTag}.${reach.farClass}`,
      ).toBe(true);
      // And the trail still wins where it is drawn: the overlay covers the row,
      // so without the trail's own stacking a naive full-row link eats it.
      expect(
        reach.buttonTag,
        `a tap on the row's own button reaches ${reach.buttonTag}.${reach.buttonClass}`,
      ).toBe('BUTTON');
      await page.context().close();
    },
    SLOW,
  );

  it(
    'keeps the dirty-form guard, and asks about work rather than about buttons',
    async () => {
      /*
       * System is the screen the guard was hardest to get right on, so it is
       * the one worth re-measuring after its markup moved into components.
       *
       * Three properties, all of them invisible in the markup: Save is off
       * until there is a diff; every one of the three downloads is marked, so
       * `beforeunload` — which fires before a response header can say
       * `Content-Disposition` — does not read a download as a departure; and
       * the page ships the script, which `page()` decides by looking for a
       * `<form data-dirty>` and would silently stop doing if a component
       * swallowed the attribute.
       */
      const home = await fresh();
      const page = await open(home, viewport, mobile, '/admin/system');
      /*
       * `settings-form.js` is a module, so it runs after `load` — and its whole
       * observable effect on a clean page is Save going grey. Waiting for that
       * rather than for a fixed delay is the difference between an assertion
       * and a race; the bounded catch is what makes a *failure* of the fix land
       * on the assertion below, with its message, instead of as a timeout.
       */
      await page
        .waitForFunction(
          () => (document.querySelector('[data-dirty-save]') as HTMLButtonElement | null)?.disabled === true,
          undefined,
          { timeout: 5000 },
        )
        .catch(() => undefined);
      const before = await page.evaluate(() => {
        const forms = [...document.querySelectorAll('form')];
        return {
          dirtyForms: forms.filter((f) => f.hasAttribute('data-dirty')).length,
          downloads: forms.filter((f) => f.hasAttribute('data-download')).length,
          script: document.querySelector('script[src*="settings-form"]') !== null,
          saveDisabled: (document.querySelector('[data-dirty-save]') as HTMLButtonElement).disabled,
        };
      });
      expect(before.dirtyForms, 'the timezone and update-check forms').toBe(2);
      expect(before.downloads, 'database, key and diagnostics').toBe(3);
      expect(before.script, 'the dirty-state script was not shipped').toBe(true);
      expect(before.saveDisabled, 'Save is live on an untouched form').toBe(true);

      // One real edit, and the form it belongs to wakes up.
      await page.selectOption('select[name="timezone"]', { index: 1 });
      const after = await page.evaluate(() => {
        const saves = [...document.querySelectorAll('[data-dirty-save]')] as HTMLButtonElement[];
        return saves.map((s) => s.disabled);
      });
      expect(after[0], 'the edited form still has Save disabled').toBe(false);
      // And the *other* settings form on the page is untouched — the guard
      // tracks work, not the page.
      expect(after[1], 'an unedited form woke up too').toBe(true);
      await page.context().close();
    },
    SLOW,
  );
});

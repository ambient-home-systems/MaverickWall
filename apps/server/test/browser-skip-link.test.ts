/**
 * Bypass blocks, driven in a real browser (WCAG 2.4.1, Level A).
 *
 * Measured on `/admin/calendars` before this: sixteen tab stops — the brand
 * link, eleven nav links, sign-out and the three theme buttons — stood between
 * the top of the document and the first control on the page. Every admin
 * screen is a fresh document load, so a keyboard or switch user paid all
 * sixteen on *every* navigation rather than once per session.
 *
 * Three of the four things asserted here cannot be answered any other way:
 *
 *   - **Where focus actually goes.** A skip link that scrolls the viewport and
 *     leaves focus at the top of the navigation is the bug wearing the fix's
 *     markup, and the difference is one `tabindex="-1"` that no snapshot shows.
 *   - **Whether it navigates.** Every page emits `<base href="/">` for ingress,
 *     and a bare `href="#mw-main"` resolves against *that* — so the obvious
 *     spelling leaves the page and lands on the admin root. The anchor reads
 *     as correct; only its resolved URL says otherwise.
 *   - **Whether the drawer still works.** The compact-width drawer is a
 *     checkbox the CSS reads through `~`, and `page()` is the only place that
 *     order is enforced. Nothing in the stylesheet complains if it breaks.
 *
 * And one that is measurement rather than markup: "invisible until focused" is
 * a claim about geometry, so it is read off `getBoundingClientRect()` at both
 * widths rather than off a class.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

/** Long, because each of these boots a server and a browser context. */
const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(): Promise<Installation> {
  const made = await install();
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** What has focus right now, in the terms these assertions are written in. */
async function focused(page: Page): Promise<{
  tag: string;
  cls: string;
  id: string;
  text: string;
  inMain: boolean;
  inNav: boolean;
}> {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName ?? 'NONE',
      cls: el?.className ?? '',
      id: el?.id ?? '',
      text: (el?.textContent ?? '').trim().slice(0, 40),
      inMain: el !== null && document.querySelector('main')?.contains(el) === true,
      inNav: el !== null && document.querySelector('aside.side')?.contains(el) === true,
    };
  });
}

/** The skip link's box, and the viewport it has to be inside or outside of. */
async function skipBox(page: Page): Promise<{ top: number; bottom: number; left: number; right: number; height: number; vh: number; vw: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('.skip') as HTMLElement | null;
    if (el === null) throw new Error('no .skip element in the document at all');
    const r = el.getBoundingClientRect();
    return {
      top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
      vh: window.innerHeight, vw: window.innerWidth,
    };
  });
}

const WIDTHS = [
  ['a desktop', { width: 1280, height: 800 }, false],
  ['a phone', { width: 390, height: 844 }, true],
] as const;

describe.each(WIDTHS)('the skip link on %s', (_label, viewport, mobile) => {
  const context = async (home: Installation): Promise<Page> => {
    const ctx = await (await browser()).newContext(
      mobile ? { viewport, hasTouch: true, isMobile: true } : { viewport },
    );
    const page = await ctx.newPage();
    await home.signIn(page);
    return page;
  };

  it(
    'is the first tab stop, hidden until it has focus and drawn inside the viewport when it does',
    async () => {
      const home = await fresh();
      const page = await context(home);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      // At rest: rendered (so it can be focused at all) and wholly above the
      // top edge. `display:none` would pass a "not visible" check and fail the
      // one below it, which is the point of measuring both.
      const rest = await skipBox(page);
      expect(rest.height, 'the skip link is not rendered, so nothing can Tab to it')
        .toBeGreaterThan(0);
      expect(
        rest.bottom,
        `the skip link is on screen before it has focus: it runs ${Math.round(rest.top)}–` +
          `${Math.round(rest.bottom)}`,
      ).toBeLessThanOrEqual(0);

      // One Tab from a freshly loaded document.
      await page.keyboard.press('Tab');
      const first = await focused(page);
      expect(
        { tag: first.tag, cls: first.cls },
        `the first tab stop is “${first.text}” (${first.tag}.${first.cls}), not the skip link`,
      ).toEqual({ tag: 'A', cls: 'skip' });

      // And now it has to be seen. Wholly inside the viewport, not merely
      // "not translated away".
      const shown = await skipBox(page);
      expect(
        { top: shown.top >= 0, bottom: shown.bottom <= shown.vh, left: shown.left >= 0, right: shown.right <= shown.vw },
        `the focused skip link is not wholly inside the viewport: ${JSON.stringify(shown)}`,
      ).toEqual({ top: true, bottom: true, left: true, right: true });

      // And it must not land on top of the app bar's menu button. At compact
      // width that corner holds the hamburger and the invisible 48px checkbox
      // behind it, and a focused link drawn over them swallows the tap that
      // opens the navigation — which shows up as a control that does nothing,
      // never as something you can see.
      const clash = await page.evaluate(() => {
        const skip = document.querySelector('.skip') as HTMLElement;
        const button = document.querySelector('label.navbtn') as HTMLElement | null;
        if (button === null || getComputedStyle(button).display === 'none') return null;
        const a = skip.getBoundingClientRect();
        // The button's real target is its 48px ::after, centred on a 40px box.
        const b = button.getBoundingClientRect();
        const pad = (48 - b.width) / 2;
        return {
          overlaps:
            a.left < b.right + pad && a.right > b.left - pad &&
            a.top < b.bottom + pad && a.bottom > b.top - pad,
          skip: { left: Math.round(a.left), top: Math.round(a.top) },
          button: { right: Math.round(b.right + pad), bottom: Math.round(b.bottom + pad) },
        };
      });
      if (clash !== null) {
        expect(
          clash.overlaps,
          `the focused skip link covers the app bar's menu button: ${JSON.stringify(clash)}`,
        ).toBe(false);
      }

      // The admin's one focus treatment: a 3px accent ring, offset outward.
      // Read off the computed style, never off the class — this codebase has
      // shipped a control whose class was right and whose pixels were not.
      const ring = await page.evaluate(() => {
        const el = document.querySelector('.skip') as HTMLElement;
        const style = getComputedStyle(el);
        const probe = document.createElement('span');
        probe.style.color = 'var(--mw-accent)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          width: style.outlineWidth,
          style: style.outlineStyle,
          colour: style.outlineColor,
          accent,
        };
      });
      expect({ width: ring.width, style: ring.style, colour: ring.colour }).toEqual({
        width: '3px',
        style: 'solid',
        colour: ring.accent,
      });
    },
    SLOW,
  );

  it(
    'moves focus into <main> without leaving the page, and the next Tab stays there',
    async () => {
      const home = await fresh();
      const page = await context(home);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });
      const before = new URL(page.url()).pathname;

      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);

      // The `<base href="/">` trap: a bare `#mw-main` resolves against the base
      // and not against the document, so the obvious spelling loads the admin
      // root. The path has to be untouched.
      expect(
        new URL(page.url()).pathname,
        'activating the skip link navigated off the page — the href resolved ' +
          'against the <base>, not against this document',
      ).toBe(before);

      const landed = await focused(page);
      expect(
        { tag: landed.tag, id: landed.id },
        `the skip link left focus on “${landed.text}” (${landed.tag}), so the next ` +
          'Tab resumes from the top of the navigation',
      ).toEqual({ tag: 'MAIN', id: 'mw-main' });

      // And the stop after it is page content, not navigation. That is the
      // whole of what "bypass blocks" buys.
      await page.keyboard.press('Tab');
      const next = await focused(page);
      expect(
        { inMain: next.inMain, inNav: next.inNav },
        `the Tab after the skip link went to “${next.text}” (${next.tag}.${next.cls}), ` +
          'which is not inside <main>',
      ).toEqual({ inMain: true, inNav: false });
    },
    SLOW,
  );
});

/**
 * The drawer, which the skip link sits in front of.
 *
 * `page()` is the only place the body's child order is decided, and the
 * compact drawer is `#mw-nav:checked ~ .side`. A sibling combinator only looks
 * forward, so an element inserted *before* the checkbox is harmless and one
 * inserted after it silently breaks the only route to the navigation on a
 * phone. Nothing in the stylesheet says so, which is why this is driven rather
 * than read.
 */
describe('the drawer, with the skip link in front of it', () => {
  it(
    'still opens on a tap and on Space, and still closes on navigation, at 390px',
    async () => {
      const home = await fresh();
      const ctx = await (await browser()).newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await ctx.newPage();
      await home.signIn(page);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      const drawer = page.locator('aside.side');
      const offCanvas = async (): Promise<boolean> => {
        const box = await drawer.boundingBox();
        return box === null || box.x + box.width <= 1;
      };
      expect(await offCanvas(), 'the drawer is already open on load').toBe(true);

      // The tap, on the app bar's label — a real press, not a class check.
      await page.locator('label.navbtn').tap();
      await page.waitForTimeout(400);
      expect(
        { x: Math.round((await drawer.boundingBox())?.x ?? NaN), visible: await drawer.isVisible() },
        'the hamburger did not bring the drawer on screen',
      ).toEqual({ x: 0, visible: true });

      // Close it again the way a household does, and start from a clean load.
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });
      expect(await offCanvas(), 'the drawer survived a fresh load').toBe(true);

      // The keyboard route. The control a person sees is the app bar's label;
      // what carries the state — and the focus — is the checkbox it is for,
      // which is now the *second* tab stop rather than the first.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const onToggle = await focused(page);
      expect(
        { tag: onToggle.tag, id: onToggle.id },
        `the stop after the skip link is “${onToggle.text}” (${onToggle.tag}.${onToggle.cls}), ` +
          'not the drawer toggle — the keyboard route into the navigation is gone',
      ).toEqual({ tag: 'INPUT', id: 'mw-nav' });

      await page.keyboard.press('Space');
      await page.waitForTimeout(400);
      expect(
        { x: Math.round((await drawer.boundingBox())?.x ?? NaN), visible: await drawer.isVisible() },
        'Space on the drawer toggle did not open it',
      ).toEqual({ x: 0, visible: true });

      // And it closes on navigation with nothing to remember: every link is a
      // full document load, so the next page arrives with the box unchecked.
      await Promise.all([
        page.waitForNavigation({ timeout: 20_000 }),
        page.locator('aside.side a.nav-item').first().click(),
      ]);
      expect(
        await page.evaluate(() => (document.getElementById('mw-nav') as HTMLInputElement).checked),
        'the drawer toggle came back checked after a navigation',
      ).toBe(false);
      expect(await offCanvas(), 'the drawer is still open after navigating').toBe(true);
    },
    SLOW,
  );

  it(
    'leaves no phantom first tab stop at 1280px, where the drawer is always there',
    async () => {
      const home = await fresh();
      const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await home.signIn(page);
      await page.goto(`${home.base}/admin/calendars`, { waitUntil: 'load' });

      // The stylesheet takes the checkbox out entirely at this width. If it did
      // not, it would be a focusable, invisible 48px square in the corner — and
      // now the *second* stop rather than the first, which is a worse place to
      // hide one.
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.getElementById('mw-nav') as HTMLElement).display,
        ),
        'the drawer toggle is still rendered at desktop width',
      ).toBe('none');

      await page.keyboard.press('Tab');
      expect((await focused(page)).cls, 'the first stop is not the skip link').toBe('skip');
      await page.keyboard.press('Tab');
      const second = await focused(page);
      expect(
        { id: second.id, tag: second.tag },
        `the second tab stop is “${second.text}” (${second.tag}#${second.id})`,
      ).toEqual({ id: '', tag: 'A' });
    },
    SLOW,
  );
});

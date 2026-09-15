import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

/**
 * The Walls list's card, measured (RFC 016 §7).
 *
 * A card stopped being a bare `<a>` so that it could carry a control, and the
 * anatomy it took is `listRow`'s: the name's own link stretched over the card
 * by `::after`, and the control painting over that because `button,.btn` in
 * this sheet is `position:relative`. That is a coupling rather than a
 * declaration, and markup cannot see it break — a `pointer-events` or a
 * stacking change that let the overlay swallow **Pair it** would leave every
 * route test green. So this taps the centre of the control and reads back what
 * is under the finger, the way `browser-components.test.ts` does for a row,
 * and then presses it and reads the address bar.
 *
 * The warn edge is read off the **computed** border colour and never off the
 * class: this codebase has shipped a bug where the class was right and the
 * pixels were wrong. The expected value is `--mw-warn` as the page's own
 * cascade resolves it, read through a probe element rather than off the token
 * text, so the comparison is between two computed colours.
 */

const SLOW = 90_000;

const installations: Installation[] = [];
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

/** A wall not yet paired, a wall polled a moment ago, and their ids. */
async function household(): Promise<{ home: Installation; attic: string; kitchen: string }> {
  const home = await install();
  installations.push(home);
  const attic = await home.pairWall('Attic');
  const link = await home.pairLink('Kitchen');
  const token = new URL(link).searchParams.get('token') ?? '';
  const polled = await home.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } });
  expect(polled.status).toBe(200);
  const kitchen = (home.db.prepare(`SELECT id FROM screens WHERE name = 'Kitchen'`).get() as { id: string }).id;
  return { home, attic, kitchen };
}

describe.each(WIDTHS)('the Walls list on %s', (_label, viewport, mobile) => {
  it(
    'puts Pair it under the finger, colours only the not-yet-paired edge, and opens the wall',
    async () => {
      const { home, attic, kitchen } = await household();
      const page = await open(home, viewport, mobile, '/admin/walls');

      const measured = await page.evaluate(
        ({ atticId, kitchenId }) => {
          const colourOf = (token: string): string => {
            const probe = document.createElement('span');
            probe.style.color = `var(${token})`;
            document.body.appendChild(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          const cardWith = (href: string): HTMLElement => {
            const link = document.querySelector(`a.wall-link[href="${href}"]`) as HTMLElement | null;
            if (link === null) throw new Error(`no card links to ${href}`);
            return link.closest('.wall-card') as HTMLElement;
          };
          const atticCard = cardWith(`admin/walls/${atticId}`);
          const kitchenCard = cardWith(`admin/walls/${kitchenId}`);
          atticCard.scrollIntoView({ block: 'center' });

          const control = atticCard.querySelector('a.btn') as HTMLElement | null;
          if (control === null) throw new Error('the not-yet-paired card carries no control');
          const c = control.getBoundingClientRect();
          const under = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
          // The far corner of the card, well away from the name and the
          // control: the stretched link's own rectangle.
          const a = atticCard.getBoundingClientRect();
          const far = document.elementFromPoint(a.right - 6, a.bottom - 6);
          const link = atticCard.querySelector('a.wall-link') as HTMLElement;

          return {
            controlText: (control.textContent ?? '').trim(),
            controlHref: control.getAttribute('href'),
            underIsControl: under === control || control.contains(under),
            underTag: under === null ? 'NONE' : `${(under as HTMLElement).tagName}.${(under as HTMLElement).className}`,
            farIsLink: far === link,
            farTag: far === null ? 'NONE' : `${(far as HTMLElement).tagName}.${(far as HTMLElement).className}`,
            controlHeight: c.height,
            atticEdge: getComputedStyle(atticCard).borderTopColor,
            kitchenEdge: getComputedStyle(kitchenCard).borderTopColor,
            kitchenControls: kitchenCard.querySelectorAll('a.btn, button').length,
            warn: colourOf('--mw-warn'),
            line: colourOf('--mw-line'),
          };
        },
        { atticId: attic, kitchenId: kitchen },
      );

      expect(measured.controlText).toBe('Pair it');
      expect(measured.controlHref).toBe(`admin/walls/${attic}`);
      expect(measured.underIsControl, `a tap on Pair it reaches ${measured.underTag}`).toBe(true);
      expect(measured.farIsLink, `a tap on the card's corner reaches ${measured.farTag}`).toBe(true);
      // A 32px control with the 48px pointer target the sheet stretches under it.
      expect(measured.controlHeight).toBeGreaterThanOrEqual(32);
      // The warn hue is on the not-yet-paired edge and on nothing else.
      expect(measured.warn).not.toBe(measured.line);
      expect(measured.atticEdge).toBe(measured.warn);
      expect(measured.kitchenEdge).toBe(measured.line);
      expect(measured.kitchenControls).toBe(0);

      // Pressing it lands on the wall's own page.
      await Promise.all([
        page.waitForURL((url) => url.pathname === `/admin/walls/${attic}`, { timeout: 20_000 }),
        page.click(`a.btn[href="admin/walls/${attic}"]`),
      ]);
      expect(new URL(page.url()).pathname).toBe(`/admin/walls/${attic}`);
      await page.context().close();
    },
    SLOW,
  );
});

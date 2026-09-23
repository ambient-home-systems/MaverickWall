/**
 * A gallery card carrying a group draws the group (RFC 014 §5.1).
 *
 * The gallery's cards are drawn in the browser through the wall's own
 * `renderFreeform`, from the template's boxes — so the one template that
 * ships a group is the one place a household sees a group before pressing
 * anything, and a card that drew its three children orphaned at fractions of
 * a box the card never placed would be a picture of a wall the wall never
 * draws. The server resolves a template's `parent` keys to ids the way
 * `applyTemplate` does before the card's JSON leaves (`templatePreviewWidgets`),
 * and this reads the card's shadow root to see that the group arrived whole.
 *
 * Measured against the wall rather than described: the same installation
 * applies Classic Strip to a paired wall, and each child's rectangle — as a
 * share of the group's inner box — is compared between the card and the
 * glass. A card is a transformed picture and the wall is not, so shares are
 * the only form in which the two can be compared, which is
 * `browser-template-card-fidelity.test.ts`'s own argument one card along.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { replaceLayout } from '../src/api/queries.js';
import { applyTemplate, findTemplate } from '../src/api/templates.js';
import {
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

process.env['TZ'] = 'UTC';

const SLOW = 120_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Shares {
  readonly children: readonly { readonly type: string; readonly x: number; readonly w: number; readonly y: number; readonly h: number }[];
}

/**
 * The group's children as shares of the group's inner box, in left-to-right
 * order, read off layout geometry (`offsetLeft`/`offsetWidth`, which a
 * transform does not touch) so a scaled card and a full-size wall answer in
 * the same units.
 */
const SHARES = (host: string | null): string => `
(() => {
  const root = ${host === null ? 'document' : `document.querySelector('${host}').shadowRoot`};
  const inner = root.querySelector('.fw-group > .fw-group-inner, .fw-group > .fw-content > .fw-group-inner');
  if (!inner) return { children: [] };
  const children = [...inner.querySelectorAll(':scope > .fw')].map((el) => ({
    type: [...el.classList].find((c) => c.startsWith('fw-') && c !== 'fw-group' && c !== 'fw-fill').slice(3),
    x: el.offsetLeft / inner.clientWidth,
    w: el.offsetWidth / inner.clientWidth,
    y: el.offsetTop / inner.clientHeight,
    h: el.offsetHeight / inner.clientHeight,
  })).sort((a, b) => a.x - b.x);
  return { children };
})()`;

describe('the Classic Strip card', () => {
  it(
    'draws its group with the three children the wall draws, at the same shares',
    async () => {
      const wall = await install();
      installations.push(wall);
      equipHousehold(wall.db, wall.now());

      // The wall: paired, then given Classic Strip through the real apply.
      const link = await wall.pairLink('Kitchen');
      const id = (wall.db.prepare('SELECT id FROM screens ORDER BY created_at LIMIT 1').get() as { id: string }).id;
      const strip = findTemplate('classic-strip');
      if (strip === undefined) throw new Error('no classic-strip template');
      applyTemplate(wall.db, id, strip);
      const real = await loadWallSettled(link, { width: 1080, height: 1920 });
      const onWall = (await real.page.evaluate(SHARES(null))) as Shares;
      await real.close();

      // The card, on that wall's own gallery.
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      let onCard: Shares;
      try {
        const page: Page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/displays/${encodeURIComponent(id)}/gallery`, { waitUntil: 'load' });
        const thumb = '.tpl-thumb[data-tpl="classic-strip"]';
        await page.waitForSelector(thumb);
        await page.evaluate((selector: string) => document.querySelector(selector)?.scrollIntoView(), thumb);
        await page.waitForFunction(
          (selector: string) =>
            (document.querySelector(selector)?.shadowRoot?.querySelector('.fw-group-inner > .fw') ?? null) !== null,
          thumb,
          { timeout: 20_000 },
        );
        onCard = (await page.evaluate(SHARES(thumb))) as Shares;
      } finally {
        await context.close();
      }

      // The premise on both sides: a group of three, clock then forecast then rota.
      expect(onWall.children.map((c) => c.type)).toEqual(['clock', 'weather', 'shift']);
      expect(onCard.children.map((c) => c.type)).toEqual(['clock', 'weather', 'shift']);
      // Equal thirds of the group's inner box, edge to edge, on both.
      for (const side of [onWall, onCard]) {
        for (const child of side.children) {
          expect(child.w).toBeCloseTo(1 / 3, 2);
          expect(child.h).toBeCloseTo(1, 2);
          expect(child.y).toBeCloseTo(0, 2);
        }
        expect(side.children.map((c) => c.x)).toEqual(
          expect.arrayContaining([expect.closeTo(0, 2), expect.closeTo(1 / 3, 2), expect.closeTo(2 / 3, 2)]),
        );
      }
      // And the card agrees with the glass to the hundredth of a share.
      onCard.children.forEach((child, index) => {
        const drawn = onWall.children[index];
        expect(drawn, `no ${child.type} on the wall`).toBeDefined();
        expect(child.x).toBeCloseTo(drawn?.x ?? -1, 2);
        expect(child.w).toBeCloseTo(drawn?.w ?? -1, 2);
      });

      /*
       * The row places from order and ignores a child's stored fractions —
       * which Classic Strip alone cannot show, because its children are stored
       * as the very thirds the row would put them at. So the same wall is given
       * a hand-written canvas whose three children all claim one sliver at the
       * right-hand edge, and the glass still draws them as equal thirds. A
       * renderer that read `x`/`w` off the child would draw three boxes on top
       * of each other here, and this is the assertion that sees it.
       */
      replaceLayout(wall.db, id, 'portrait', {
        mode: 'freeform',
        aspect: 0.5625,
        background: null,
        widgets: [
          { id: 'g', type: 'group', x: 0, y: 0, w: 1, h: 0.2, z: 0, config: { layout: 'row' } },
          { id: 'a', type: 'clock', x: 0.9, y: 0, w: 0.05, h: 1, z: 0, parentId: 'g' },
          { id: 'b', type: 'weather', x: 0.9, y: 0, w: 0.05, h: 1, z: 1, parentId: 'g' },
          { id: 'c', type: 'shift', x: 0.9, y: 0, w: 0.05, h: 1, z: 2, parentId: 'g' },
          { id: 'cal', type: 'calendar', x: 0, y: 0.2, w: 1, h: 0.8, z: 1, config: { mode: 'month' } },
        ],
      });
      const again = await loadWallSettled(link, { width: 1080, height: 1920 });
      const fromOrder = (await again.page.evaluate(SHARES(null))) as Shares;
      await again.close();
      expect(fromOrder.children.map((c) => [c.type, Math.round(c.x * 100) / 100, Math.round(c.w * 100) / 100])).toEqual([
        ['clock', 0, 0.33],
        ['weather', 0.33, 0.33],
        ['shift', 0.67, 0.33],
      ]);
    },
    SLOW,
  );
});

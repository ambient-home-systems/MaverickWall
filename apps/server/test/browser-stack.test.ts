/**
 * A stacked group on a real paired wall and in a real editor (plan item M6.6).
 *
 * A stack shows one of its widgets at a time and swaps on a tap, with nothing
 * written anywhere. What only a browser can show is the part that is about the
 * wall rather than the arithmetic: the swap survives the fifteen-second
 * rebuild, the widget it shows sits in exactly the rectangle the one before
 * did, the button costs that widget nothing, the OK key on a focused button
 * swaps rather than doing anything else, and no request leaves the wall. The
 * editor half chooses Stack through the control a household uses and previews
 * the widget selected in Layers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 120_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function linkFor(wall: Installation, screenId: string): Promise<string> {
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  return found;
}

function place(
  wall: Installation,
  screenId: string,
  row: { id: string; type: string; x: number; y: number; w: number; h: number; z: number; config: Record<string, unknown>; parent?: string },
): void {
  wall.db
    .prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, parent_id, created_at, updated_at)
       VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, screenId, row.type, row.x, row.y, row.w, row.h, row.z, JSON.stringify(row.config), row.parent ?? null, Date.now(), Date.now());
}

/** Two notes in a stack, and a stack of one beside it. */
function seed(wall: Installation, screenId: string): void {
  place(wall, screenId, { id: 'stk', type: 'group', x: 0.05, y: 0.02, w: 0.6, h: 0.16, z: 100, config: { layout: 'stack' } });
  place(wall, screenId, { id: 'alpha', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 0, config: { text: 'Alpha note' }, parent: 'stk' });
  place(wall, screenId, { id: 'beta', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 1, config: { text: 'Beta note' }, parent: 'stk' });
  place(wall, screenId, { id: 'one', type: 'group', x: 0.7, y: 0.02, w: 0.25, h: 0.16, z: 101, config: { layout: 'stack' } });
  place(wall, screenId, { id: 'solo', type: 'notes', x: 0, y: 0, w: 1, h: 1, z: 0, config: { text: 'Only note' }, parent: 'one' });
}

const shownIn = (page: Page, groupId: string) =>
  page.evaluate((id) => {
    const group = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    if (group === null) return undefined;
    const inner = group.querySelector<HTMLElement>('.fw-group-inner') as HTMLElement;
    const children = [...inner.querySelectorAll<HTMLElement>(':scope > .fw')];
    const i = inner.getBoundingClientRect();
    const swap = group.querySelector<HTMLElement>('[data-stack-swap]');
    return {
      ids: children.map((child) => child.dataset['widgetId']),
      text: children.map((child) => (child.textContent ?? '').trim()),
      rects: children.map((child) => {
        const r = child.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100);
      }),
      inner: [i.x, i.y, i.width, i.height].map((n) => Math.round(n * 100) / 100),
      swap:
        swap === null
          ? undefined
          : {
              label: swap.getAttribute('aria-label'),
              dots: [...swap.querySelectorAll('.fw-stack-dot')].map((dot) => dot.classList.contains('on')),
              position: getComputedStyle(swap).position,
              focused: document.activeElement === swap,
              ring: getComputedStyle(swap).outlineStyle,
            },
    };
  }, groupId);

describe('a stacked group', () => {
  it('swaps on a tap and on the OK key, keeps the swap through the rebuild, in the same rectangle, and tells nobody', async () => {
    const wall = await install();
    installations.push(wall);
    const screenId = await wall.pairWall('Kitchen');
    seed(wall, screenId);
    const link = await linkFor(wall, screenId);

    const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 }, { clock: 'installed' });
    try {
      const writes: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
      });

      const front = await shownIn(page, 'stk');
      expect(front?.ids).toEqual(['alpha']);
      expect(front?.text[0]).toContain('Alpha note');
      expect(front?.swap).toMatchObject({ label: 'Show the next widget (1 of 2 showing)', dots: [true, false], position: 'absolute' });
      // The widget showing fills the stack's inner box: a cell, never a share.
      expect(front?.rects[0]).toEqual(front?.inner);

      // A stack of one has nothing to swap to, and draws no button.
      const one = await shownIn(page, 'one');
      expect(one?.ids).toEqual(['solo']);
      expect(one?.swap).toBeUndefined();

      // A tap shows the next one, in exactly the same rectangle, with the
      // button still focused so the OK key can go on from it.
      await page.locator('[data-stack-swap="stk"]').click();
      const swapped = await shownIn(page, 'stk');
      expect(swapped?.ids).toEqual(['beta']);
      expect(swapped?.text[0]).toContain('Beta note');
      expect(swapped?.rects[0]).toEqual(front?.rects[0]);
      expect(swapped?.swap).toMatchObject({ dots: [false, true], focused: true, ring: 'solid' });

      // The rebuild every fifteen seconds is told, rather than putting the front back.
      await page.clock.runFor(31_000);
      const rebuilt = await shownIn(page, 'stk');
      expect(rebuilt?.ids).toEqual(['beta']);
      expect(rebuilt?.rects[0]).toEqual(front?.rects[0]);

      // The OK key on the focused button swaps, round to the front.
      await page.locator('[data-stack-swap="stk"]').focus();
      await page.keyboard.press('Enter');
      expect((await shownIn(page, 'stk'))?.ids).toEqual(['alpha']);

      // Nothing was written anywhere: a swap is a look at the wall.
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  }, SLOW);

  it('is chosen in the editor as Stack, previews the widget selected in Layers, and saves', async () => {
    const wall = await install();
    installations.push(wall);
    const screenId = await wall.pairWall('Kitchen');
    seed(wall, screenId);
    wall.db.prepare(`UPDATE layout_widgets SET config = ? WHERE id = 'stk'`).run(JSON.stringify({ layout: 'row' }));

    const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      await wall.signIn(page);
      await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
      await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
      await page.waitForFunction(
        () => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.canvas') != null,
        undefined,
        { timeout: 20_000 },
      );
      const previewShows = (): Promise<string[]> =>
        page.evaluate(() => {
          const shadow = document.querySelector<HTMLElement>('.le-preview')?.shadowRoot;
          const group = shadow?.querySelector<HTMLElement>('.fw[data-widget-id="stk"]');
          return [...(group?.querySelectorAll<HTMLElement>('.fw-group-inner > .fw') ?? [])].map((child) => child.dataset['widgetId'] ?? '');
        });
      expect(await previewShows()).toEqual(['alpha', 'beta']);

      await page.locator('.le-group-grip[data-for="stk"]').click();
      await page.click('.insp-tab:has-text("Content")');
      await page.locator('.le-cfg-field[data-cfg-key="layout"] .seg button', { hasText: 'Stack' }).click();
      await expect.poll(() => page.locator('.insp-body, #le-inspector, body').first().textContent()).toContain('the wall shows one at a time');
      await expect.poll(previewShows).toEqual(['alpha']);

      // Choosing the second in Layers turns the preview to it.
      if (!(await page.locator('.le-layers-pop').isVisible()) && (await page.locator('.le-layers-btn').isVisible())) {
        await page.click('.le-layers-btn');
      } else if (await page.locator('.insp-close').isVisible()) {
        await page.click('.insp-close');
      }
      await page.locator('.le-layer[data-id="beta"]').click();
      await expect.poll(previewShows).toEqual(['beta']);
      await expect.poll(() => page.locator('body').textContent()).toContain('This widget fills its stack');

      await page.locator('[data-action="save"]').click();
      await expect
        .poll(() => {
          const row = wall.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'stk' AND orientation = 'portrait'`).get() as
            | { config: string }
            | undefined;
          return row === undefined ? undefined : (JSON.parse(row.config) as Record<string, unknown>)['layout'];
        }, { timeout: 10_000 })
        .toBe('stack');
    } finally {
      await context.close();
    }
  }, SLOW);
});

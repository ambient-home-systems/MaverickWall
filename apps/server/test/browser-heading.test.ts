/**
 * A Heading widget on a real paired wall and in the editor (plan item M5.4).
 *
 * Sizes are measured, never read off a class: each of the three sizes is held
 * to the computed size of the wall role it names, read off a probe planted in
 * the same canvas so every `var()` resolves through the live cascade, on an
 * unmeasured wall and on one whose household said how big it is and how far
 * away they stand. Then the form a box chooses — the second line goes before
 * a size does, and a heading that cannot fit is cut between lines — read as
 * whether anything spills, not as which class is on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

const SLOW = 180_000;

let app: Installation;
let link: string;
let screen: string;

function place(widgets: readonly { id: string; x: number; y: number; w: number; h: number; config: object }[]): void {
  const stamp = app.now();
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
  for (const one of widgets) {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', 'heading', ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(one.id, screen, one.x, one.y, one.w, one.h, JSON.stringify(one.config), stamp, stamp);
  }
}

beforeAll(async () => {
  app = await install();
  link = await app.pairLink('Kitchen');
  screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
}, SLOW);

afterAll(async () => {
  await app.dispose();
  await shutDownBrowser();
}, TEARDOWN);

const box = (id: string): string => `#wall .canvas .fw[data-widget-id="${id}"]`;

/** The computed font size of a role's own expression, in this canvas. */
async function roleSize(page: Page, expression: string): Promise<number> {
  return page.evaluate((value) => {
    const canvas = document.querySelector('#wall .canvas') as HTMLElement;
    const probe = document.createElement('div');
    probe.style.fontSize = value;
    canvas.appendChild(probe);
    const size = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return size;
  }, expression);
}

async function headSize(page: Page, id: string): Promise<number> {
  return page.$eval(`${box(id)} .hd-head`, (node) => parseFloat(getComputedStyle(node).fontSize));
}

/**
 * Whether any part of a box's heading lies outside its own room, at either
 * end. Read as rectangles: the block centres its parts, so an overflow is at
 * the top as well as the bottom and `scrollHeight` sees only half of it.
 */
async function spills(page: Page, id: string): Promise<boolean> {
  return page.$eval(`${box(id)} .hd`, (node) => {
    const room = node.getBoundingClientRect();
    return [...node.children].some((part) => {
      const rect = part.getBoundingClientRect();
      return rect.top < room.top - 0.5 || rect.bottom > room.bottom + 0.5;
    });
  });
}

const ROLES = {
  small: 'var(--t-wall-event, var(--t-base))',
  medium: 'var(--t-wall-lede, var(--t-event))',
  large: 'var(--t-wall-clock, calc(var(--t-event) * 1.8))',
} as const;

describe('a heading on the wall', () => {
  for (const measured of [false, true]) {
    it(
      `draws each size at its role’s own computed size, on ${measured ? 'a measured' : 'an unmeasured'} wall`,
      async () => {
        app.db
          .prepare('UPDATE screens SET panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?')
          .run(measured ? 398 : null, measured ? 708 : null, measured ? 1200 : null, screen);
        place([
          { id: 'h-small', x: 0.05, y: 0.02, w: 0.9, h: 0.2, config: { text: 'Small', textSize: 'small' } },
          { id: 'h-medium', x: 0.05, y: 0.25, w: 0.9, h: 0.2, config: { text: 'Medium' } },
          { id: 'h-large', x: 0.05, y: 0.5, w: 0.9, h: 0.25, config: { text: 'Large', textSize: 'large' } },
        ]);
        const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
        try {
          const page = opened.page;
          for (const size of ['small', 'medium', 'large'] as const) {
            expect(await headSize(page, `h-${size}`), size).toBeCloseTo(await roleSize(page, ROLES[size]), 1);
          }
          // Large is the clock's own capped size: nothing is larger than the clock may be.
          expect(await headSize(page, 'h-large')).toBeLessThanOrEqual((await headSize(page, 'h-medium')) * 1.8 + 0.01);
          expect(await headSize(page, 'h-small')).toBeLessThan(await headSize(page, 'h-medium'));
        } finally {
          await opened.close();
          app.db
            .prepare('UPDATE screens SET panel_width_mm = NULL, panel_height_mm = NULL, read_distance_mm = NULL WHERE id = ?')
            .run(screen);
        }
      },
      SLOW,
    );
  }

  it(
    'gives up the second line before a size, steps down a role before it spills, and cuts between lines at the last',
    async () => {
      const both = { text: 'This week', subtitle: 'Bins on Tuesday, swimming on Thursday', textSize: 'large' };
      place([
        { id: 'h-room', x: 0.05, y: 0.02, w: 0.9, h: 0.2, config: both },
        { id: 'h-tight', x: 0.05, y: 0.25, w: 0.9, h: 0.06, config: both },
        { id: 'h-narrow', x: 0.05, y: 0.32, w: 0.35, h: 0.045, config: both },
        {
          id: 'h-cut',
          x: 0.05,
          y: 0.4,
          w: 0.2,
          h: 0.06,
          config: { text: 'A heading far too long for so small a box to hold at any size at all', textSize: 'small' },
        },
        // Too short for one whole line of the smallest role.
        { id: 'h-none', x: 0.5, y: 0.4, w: 0.4, h: 0.02, config: { text: 'Hello', textSize: 'small' } },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const large = await roleSize(page, ROLES.large);
        // Room for both at the size asked for.
        expect(await headSize(page, 'h-room')).toBeCloseTo(large, 1);
        expect(await page.locator(`${box('h-room')} .hd-second`).count()).toBe(1);
        // A short box: the second line has gone and the heading keeps its size.
        expect(await page.locator(`${box('h-tight')} .hd-second`).count()).toBe(0);
        expect(await headSize(page, 'h-tight')).toBeCloseTo(large, 1);
        expect(await page.getAttribute(box('h-tight'), 'data-rungs')).toBe('text');
        // Shorter still: no room for the large heading even alone, so it steps down a role.
        expect(await headSize(page, 'h-narrow')).toBeLessThan(large);
        for (const id of ['h-room', 'h-tight', 'h-narrow', 'h-cut']) expect(await spills(page, id), id).toBe(false);
        // Too long at the smallest: whole lines, cut between two, never through one.
        const cut = await page.$eval(`${box('h-cut')} .hd-head`, (node) => {
          const style = getComputedStyle(node);
          return { height: node.getBoundingClientRect().height, line: parseFloat(style.lineHeight) };
        });
        expect(cut.height / cut.line).toBeCloseTo(Math.round(cut.height / cut.line), 1);
        expect(Math.round(cut.height / cut.line)).toBeGreaterThanOrEqual(2);
        // And a box with no room for one line draws none, rather than half of one.
        expect(await page.locator(`${box('h-none')} .hd-head`).count()).toBe(0);
        expect(await spills(page, 'h-none')).toBe(false);
        expect(cut.height).toBeLessThanOrEqual(
          await page.$eval(`${box('h-cut')} .hd`, (node) => node.clientHeight + 0.5),
        );
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'sits where it was asked, draws its glyph and rule, and capitalises only when asked',
    async () => {
      const base = { text: 'This week', subtitle: 'Bins on Tuesday' };
      place([
        { id: 'h-top', x: 0.05, y: 0.02, w: 0.9, h: 0.25, config: { ...base, valign: 'top' } },
        { id: 'h-bottom', x: 0.05, y: 0.3, w: 0.9, h: 0.25, config: { ...base, valign: 'bottom' } },
        {
          id: 'h-dressed',
          x: 0.05,
          y: 0.6,
          w: 0.9,
          h: 0.25,
          config: { ...base, glyph: 'person', divider: true, uppercase: true },
        },
      ]);
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        const gaps = await page.evaluate((ids) => {
          return ids.map((id) => {
            const body = document.querySelector(`#wall .canvas .fw[data-widget-id="${id}"] .hd`) as HTMLElement;
            const head = body.querySelector('.hd-head') as HTMLElement;
            const second = body.querySelector('.hd-second') as HTMLElement;
            const room = body.getBoundingClientRect();
            return {
              above: head.getBoundingClientRect().top - room.top,
              below: room.bottom - second.getBoundingClientRect().bottom,
            };
          });
        }, ['h-top', 'h-bottom']);
        expect(gaps[0]?.above).toBeLessThan(1);
        expect(gaps[0]?.below).toBeGreaterThan(20);
        expect(gaps[1]?.below).toBeLessThan(1);
        expect(gaps[1]?.above).toBeGreaterThan(20);

        const dressed = await page.evaluate((sel) => {
          const root = document.querySelector(sel) as HTMLElement;
          const glyph = root.querySelector('.hd-glyph') as SVGSVGElement;
          const head = root.querySelector('.hd-head') as HTMLElement;
          const rule = root.querySelector('.hd-rule') as HTMLElement;
          return {
            text: (root.querySelector('.hd-text') as HTMLElement).textContent,
            second: (root.querySelector('.hd-second') as HTMLElement).textContent,
            glyph: glyph.getBoundingClientRect().height / parseFloat(getComputedStyle(head).fontSize),
            rule: parseFloat(getComputedStyle(rule).borderTopWidth),
            ruleWidth: rule.getBoundingClientRect().width / root.getBoundingClientRect().width,
          };
        }, box('h-dressed'));
        expect(dressed.text).toBe('THIS WEEK');
        expect(dressed.second).toBe('BINS ON TUESDAY');
        expect(dressed.glyph).toBeCloseTo(0.9, 1);
        expect(dressed.rule).toBe(1);
        expect(dressed.ruleWidth).toBeGreaterThan(0.95);
        expect(await page.textContent(`${box('h-top')} .hd-text`)).toBe('This week');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('a heading in the editor', () => {
  it(
    'previews the words as they are typed, and saves what was chosen',
    async () => {
      place([{ id: 'h-edit', x: 0.05, y: 0.05, w: 0.9, h: 0.25, config: {} }]);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await app.signIn(editor);
        await editor.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        await editor.locator('.le-overlay .le-widget').first().click();
        await editor.click('.insp-tab:has-text("Content")');
        const preview = (sel: string): Promise<string | null> =>
          editor.evaluate(
            (s) => document.querySelector('.le-preview')?.shadowRoot?.querySelector(s)?.textContent ?? null,
            sel,
          );
        await editor.fill('.le-cfg-field:has-text("Heading") input', 'Kitchen jobs');
        await expect.poll(() => preview('.hd-text')).toBe('Kitchen jobs');
        await editor.click('.le-cfg-field[data-cfg-key="textSize"] .seg button:has-text("Large")');
        await editor.click('.le-cfg-field[data-cfg-key="valign"] .seg button:has-text("Top")');
        await editor.click('.le-glyph-grid button[aria-label="Person"]');
        await expect
          .poll(() =>
            editor.evaluate(() => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.hd-glyph') !== null),
          )
          .toBe(true);
        await editor.locator('.switch:has-text("Rule under the heading") input').check();

        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = app.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'h-edit'`).get() as { config: string };
        expect(JSON.parse(stored.config)).toEqual({
          text: 'Kitchen jobs',
          textSize: 'large',
          valign: 'top',
          glyph: 'person',
          divider: true,
        });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

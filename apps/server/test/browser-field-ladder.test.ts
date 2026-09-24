/**
 * The Weather widget's field ladder and its Corners control, driven in the
 * editor a household actually uses.
 *
 * Three faults, all reported together from one screenshot, and none of them
 * visible to anything that reads the markup:
 *
 *  - **The overnight low was struck through while it was on the wall.** The
 *    editor counted the rows in a forecast column and struck through every
 *    ladder entry past that count — but the high and the low share one row
 *    while they are adjacent, so a column drawing all four fields has three
 *    rows, and the fourth entry read as given up. Every weather widget with
 *    both temperatures on it showed it, which is every weather widget nobody
 *    had touched. Ticking the low again changed nothing, so it read as a field
 *    that could not be selected.
 *  - **Dragging a row sent it to the bottom.** The drag wrote the list on
 *    every pointer move, and every write rebuilt the panel — so after the
 *    first step it was measuring rows no longer in the document, every one of
 *    them zero pixels high, and the pointer was "below all of them". A row
 *    dragged to the top landed last.
 *  - **Corners did nothing on a widget with nothing behind it.** The box is
 *    padded, so a rounded corner on a box with no ground falls on empty space.
 *
 * Each assertion is on what is drawn or computed — the preview's own rows, the
 * name's computed text decoration, the box's computed radius — rather than on
 * a class, and each was checked by reverting its fix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { readLayoutWidgets } from '../src/api/queries.js';

process.env['TZ'] = 'UTC';

const SLOW = 90_000;

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let wall: Installation;
let screenId: string;
let weatherId: string;
/**
 * One signed-in context for the file. Signing in per test is four sign-ins
 * from one address in a minute, which is exactly what the app's own rate
 * limit exists to refuse.
 */
let context: BrowserContext;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  // Without a location and a forecast the Weather widget is left off the wall
  // and the preview has no strip to read back.
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const weather = readLayoutWidgets(wall.db, screenId, 'portrait').find((row) => row.type === 'weather');
  if (weather === undefined) throw new Error('Classic seeded no Weather widget on the portrait canvas');
  weatherId = weather.id;
  context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await wall.signIn(page);
  await page.close();
}, SLOW);

afterAll(async () => {
  await context?.close();
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Open this wall's editor and select its Weather box. */
async function openWeather(page: Page): Promise<void> {
  await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
  await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  await page.locator(`.le-overlay .le-widget[data-id="${weatherId}"]`).click();
  await page.waitForSelector('.le-ladder-row', { timeout: 10_000 });
  await drawnSettled(page);
}

/** Wait until the preview has a forecast column in the Weather box. */
async function drawnSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    (id) =>
      (document
        .querySelector<HTMLElement>('.le-preview')
        ?.shadowRoot?.querySelector(`[data-widget-id="${id}"] .wx-day`) ?? null) !== null,
    weatherId,
    { timeout: 20_000 },
  );
  // The preview redraws on a short debounce after an edit; the cut marker is
  // re-read when it does.
  await page.waitForTimeout(400);
}

interface LadderRow {
  readonly field: string;
  readonly on: boolean;
  /** Whether the name is *drawn* struck through — the computed decoration. */
  readonly struck: boolean;
}

/** The ladder as the household sees it, top to bottom. */
const ladder = (page: Page): Promise<LadderRow[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.le-config .le-ladder-row')].map((row) => {
      const name = row.querySelector('.le-ladder-name');
      const tick = row.querySelector<HTMLInputElement>('input[type=checkbox]');
      return {
        field: row.dataset['field'] ?? '',
        on: tick?.checked === true,
        struck:
          name !== null && getComputedStyle(name).textDecorationLine.split(' ').includes('line-through'),
      };
    }),
  );

/**
 * Which fields the preview's first forecast column actually draws, found by
 * the stylesheet's own classes rather than by anything the fix added.
 *
 * `.wx-temp` without `.lo` is the high — alone, or with the low riding beside
 * it in a `.lo` span; `.lo` anywhere is the low. Visible means a box with area
 * that nothing has hidden, which is what the belt's `display: none` removes.
 */
const drawn = (page: Page): Promise<string[]> =>
  page.evaluate((id) => {
    const column = document
      .querySelector<HTMLElement>('.le-preview')
      ?.shadowRoot?.querySelector(`[data-widget-id="${id}"] .wx-day`);
    if (!(column instanceof HTMLElement)) return [];
    const visible = (selector: string): boolean =>
      [...column.querySelectorAll(selector)].some((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const fields: string[] = [];
    if (visible('.wx-name')) fields.push('name');
    if (visible('.wx-ico')) fields.push('icon');
    if (visible('.wx-temp:not(.lo)')) fields.push('high');
    if (visible('.lo')) fields.push('low');
    return fields;
  }, weatherId);

/** The order the preview draws the first column's rows in, by class. */
const drawnOrder = (page: Page): Promise<string[]> =>
  page.evaluate((id) => {
    const column = document
      .querySelector<HTMLElement>('.le-preview')
      ?.shadowRoot?.querySelector(`[data-widget-id="${id}"] .wx-day`);
    if (!(column instanceof HTMLElement)) return [];
    return [...column.children].map((node) => {
      if (node.classList.contains('wx-name')) return 'name';
      if (node.classList.contains('wx-ico')) return 'icon';
      if (node.classList.contains('lo')) return 'low';
      if (node.classList.contains('wx-temp')) return node.querySelector('.lo') === null ? 'high' : 'high+low';
      return '?';
    });
  }, weatherId);

/**
 * A fresh page on the signed-in context, on a canvas put back to the seed.
 *
 * Each test saves nothing, but the one before it may have left the editor
 * dirty; a new page starts from what the server holds, which is the seed.
 */
async function newPage(): Promise<{ page: Page; close: () => Promise<void> }> {
  const page = await context.newPage();
  // Leaving a dirty editor asks first; nothing here wants to be asked.
  page.on('dialog', (dialog) => void dialog.accept());
  return { page, close: () => page.close({ runBeforeUnload: false }) };
}

describe('the Weather widget’s field ladder', () => {
  it(
    'strikes through exactly the fields the preview does not draw',
    async () => {
      const { page, close } = await newPage();
      try {
        await openWeather(page);
        const rows = await ladder(page);
        expect(rows.map((row) => row.field)).toEqual(['name', 'icon', 'high', 'low']);
        expect(rows.every((row) => row.on), 'a widget nobody has touched has every rung on').toBe(true);

        // The low rides beside the high on one row, so it is on the glass …
        expect(await drawn(page)).toEqual(['name', 'icon', 'high', 'low']);
        expect(await drawnOrder(page)).toEqual(['name', 'icon', 'high+low']);
        // … and the editor must not say otherwise.
        expect(
          rows.filter((row) => row.struck).map((row) => row.field),
          'a field the preview draws is struck through as given up — the high and ' +
            'the low share one row, so counting rows takes the low for cut',
        ).toEqual([]);

        /*
         * And a box too short for the temperatures still marks them, so the
         * read-back is not simply silent. Whatever the tier gives up, the
         * struck rows are exactly the on rows the preview did not draw.
         */
        await page.click('.insp-tab:has-text("Style")');
        const height = page.locator('.le-box input[aria-label^="Height"]');
        await height.fill('4');
        await page.click('.insp-tab:has-text("Content")');
        await drawnSettled(page);
        const small = await ladder(page);
        const shown = await drawn(page);
        const struck = small.filter((row) => row.struck).map((row) => row.field);
        expect(struck.length, 'a four per cent box gave nothing up — the case measures nothing').toBeGreaterThan(0);
        expect(struck).toEqual(small.filter((row) => row.on && !shown.includes(row.field)).map((row) => row.field));
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'drags a row to where it is dropped, as one step back',
    async () => {
      const { page, close } = await newPage();
      try {
        await openWeather(page);
        const grip = page.locator('.le-ladder-row[data-field="high"] .le-layer-grip');
        const target = page.locator('.le-ladder-row[data-field="name"]');
        const from = await grip.boundingBox();
        const to = await target.boundingBox();
        if (from === null || to === null) throw new Error('the ladder rows have no box');
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        // In steps, the way a hand moves: the fault only showed from the
        // second move on, after the first write had rebuilt the panel.
        await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 12 });
        await page.mouse.up();
        await drawnSettled(page);

        expect(
          (await ladder(page)).map((row) => row.field),
          'the high was dragged above the day and did not land there',
        ).toEqual(['high', 'name', 'icon', 'low']);
        // The wall draws it in that order, and the two temperatures are no
        // longer adjacent, so they no longer share a row.
        expect(await drawnOrder(page)).toEqual(['high', 'name', 'icon', 'low']);

        await page.keyboard.press('Control+z');
        await drawnSettled(page);
        expect(
          (await ladder(page)).map((row) => row.field),
          'one Ctrl+Z did not take back one drag',
        ).toEqual(['name', 'icon', 'high', 'low']);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'ticks a field when its name is pressed, not only its box',
    async () => {
      const { page, close } = await newPage();
      try {
        await openWeather(page);
        await page.locator('.le-ladder-row[data-field="low"] .le-ladder-name').click();
        await drawnSettled(page);
        const low = (await ladder(page)).find((row) => row.field === 'low');
        expect(low?.on, 'pressing "The overnight low" did not untick it').toBe(false);
        expect(await drawn(page)).not.toContain('low');

        await page.locator('.le-ladder-row[data-field="low"] .le-ladder-name').click();
        await drawnSettled(page);
        expect((await ladder(page)).every((row) => row.on)).toBe(true);
        expect(await drawn(page)).toEqual(['name', 'icon', 'high', 'low']);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('Corners', () => {
  it(
    'is offered once there is a ground to round, and then rounds the box',
    async () => {
      const { page, close } = await newPage();
      try {
        await openWeather(page);
        await page.click('.insp-tab:has-text("Style")');
        const corners = page.locator('.le-config [role=group][aria-label="Corners"]');
        expect(
          await corners.count(),
          'Corners is offered on a box with nothing painted behind it, where a ' +
            'rounded corner falls on padding and nothing on the wall moves',
        ).toBe(0);

        await page.locator('.le-config .switch', { hasText: 'Card background' }).locator('input').click();
        await expect.poll(() => corners.count()).toBe(1);
        await corners.locator('button', { hasText: 'Rounded' }).click();
        await drawnSettled(page);

        const box = await page.evaluate((id) => {
          const node = document
            .querySelector<HTMLElement>('.le-preview')
            ?.shadowRoot?.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
          if (node === null || node === undefined) return undefined;
          const style = getComputedStyle(node);
          return { radius: style.borderTopLeftRadius, background: style.backgroundColor };
        }, weatherId);
        expect(box?.background, 'the card background painted nothing').not.toBe('rgba(0, 0, 0, 0)');
        expect(parseFloat(box?.radius ?? '0'), 'Rounded left the painted box square').toBeGreaterThan(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  /**
   * A picture is the one widget whose content has corners of its own.
   *
   * The box is padded, so rounding the box alone curved empty space and left
   * the photograph square inside it. The picture takes the box's curve now,
   * and that is what makes Corners worth offering on a picture with nothing
   * behind it. Measured on the picture itself — the widget's wrapper carries
   * the same class, and its radius would pass whether or not the photograph
   * moved.
   */
  it(
    'is offered on a picture with nothing behind it, and rounds the picture',
    async () => {
      const hall = await wall.pairWall('Hall');
      const upload = new FormData();
      upload.append('image', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'wall.png');
      const stored = (await (await wall.call('/admin/media/upload', { method: 'POST', body: upload })).json()) as {
        ok: boolean;
        name?: string;
      };
      expect(stored.ok, 'the upload this test needs was refused').toBe(true);
      const saved = await wall.call('/admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: hall,
          mode: 'freeform',
          aspect: 1080 / 1920,
          widgets: [
            { id: 'picture', type: 'image', x: 0.05, y: 0.05, w: 0.9, h: 0.4, z: 0, config: { image: stored.name } },
          ],
        }),
      });
      expect(saved.status, 'the layout this test needs was refused').toBe(200);

      const { page, close } = await newPage();
      try {
        await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(hall)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget[data-id="picture"]', { timeout: 20_000 });
        const pictureRadius = (): Promise<number> =>
          page.evaluate(() => {
            const picture = document
              .querySelector<HTMLElement>('.le-preview')
              ?.shadowRoot?.querySelector<HTMLElement>('[data-widget-id="picture"] .fw-image');
            return picture === null || picture === undefined
              ? -1
              : parseFloat(getComputedStyle(picture).borderTopLeftRadius);
          });
        await expect.poll(pictureRadius, { timeout: 10_000 }).toBe(0);

        await page.locator('.le-overlay .le-widget[data-id="picture"]').click();
        await page.click('.insp-tab:has-text("Style")');
        const corners = page.locator('.le-config [role=group][aria-label="Corners"]');
        expect(await corners.count(), 'a picture was not offered Corners').toBe(1);
        await corners.locator('button', { hasText: 'Rounded' }).click();
        await expect
          .poll(pictureRadius, { timeout: 10_000, message: 'Rounded left the picture itself square' })
          .toBeGreaterThan(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

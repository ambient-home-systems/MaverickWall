/**
 * A reading's controls, on a real paired wall (RFC 018 phase 3).
 *
 * `ha-act.test.ts` holds the route to the fake house: which values it takes,
 * in what shape and range, and which row each word reaches. This is the half a
 * household meets — a dimmable light opens a panel rather than switching, the
 * panel moves no widget, a slider sends one value when it is let go of and not
 * a stream while it moves, the fifteen-second rebuild neither closes the panel
 * nor tears a slider out from under a finger, and closing it hands focus back.
 *
 * Measured, never read off a class: rectangles, the posts the fake house
 * received, the computed outline, the node a finger is on.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 180_000;
const LIGHT = 'light.living_room';
const BLIND = 'cover.kitchen_blind';
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface Wall {
  readonly app: Installation;
  readonly ha: FakeHa;
  readonly link: string;
}

/**
 * A light that dims, takes a colour and a white, and a blind that moves, both
 * marked controllable through the Readings screen's own form, on a wall that
 * allows control, in one acting tile box beside a calendar.
 */
async function wallWithControls(): Promise<Wall> {
  const app = await install({ feed: true, calendars: HOUSEHOLD_CALENDARS });
  installations.push(app);
  const ha = await fakeHomeAssistant();
  expect(
    (await app.post('/admin/home-assistant/connect', {
      base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1',
    })).status,
  ).toBe(302);

  const at = app.now();
  const seed = (entity: string, state: string, attributes: object, name: string, order: number): void => {
    app.db
      .prepare(
        `INSERT INTO ha_entity_cache
           (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
            fetched_at, watched, display_mode, label, sort_order)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 'label_value', NULL, ?)`,
      )
      .run(entity, state, JSON.stringify(attributes), name, at - 600_000, at, order);
  };
  seed(LIGHT, 'on', {
    brightness: 153, supported_color_modes: ['color_temp', 'rgb'],
    min_color_temp_kelvin: 2202, max_color_temp_kelvin: 6535,
  }, 'Living room', 0);
  seed(BLIND, 'open', { device_class: 'blind', current_position: 40, supported_features: 15 }, 'Kitchen blind', 1);
  for (const entity of [LIGHT, BLIND]) {
    expect(
      (await app.post('/admin/home-assistant/entities/control', { entity_id: entity, controllable: '1' })).status,
    ).toBe(302);
  }

  const link = await app.pairLink('Kitchen');
  const screen = (
    app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
  ).id;
  app.db.prepare('UPDATE screens SET allow_control = 1, layout_mode = ? WHERE id = ?').run('freeform', screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
  };
  place('w-act', 'homeassistant', [0.06, 0.03, 0.88, 0.22], { variant: 'tile', tapAction: 'act' });
  place('w-cal', 'calendar', [0.06, 0.28, 0.88, 0.7], { mode: 'list', count: 4 });
  return { app, ha, link };
}

/** The acting tile for one reading, found by the name it draws. */
async function openFor(page: Page, name: string): Promise<void> {
  const index = await page.evaluate((wanted) => {
    const tiles = [...document.querySelectorAll('#wall [data-widget-id="w-act"] .ht-tile')];
    return tiles.findIndex((one) => (one.querySelector('.ht-name')?.textContent ?? '').trim() === wanted);
  }, name);
  expect(index, name).toBeGreaterThanOrEqual(0);
  await page.locator('#wall [data-widget-id="w-act"] .ht-tile').nth(index).click();
  await page.waitForSelector('#wall .hc-panel', { timeout: 10_000 });
}

/** Every widget box's rectangle, to the hundredth. */
async function boxes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#wall .canvas .fw, #wall .canvas .ht-tile')].map((node) => {
      const r = node.getBoundingClientRect();
      return `${node.dataset['widgetId'] ?? node.className}:${r.x.toFixed(2)},${r.y.toFixed(2)},${r.width.toFixed(2)},${r.height.toFixed(2)}`;
    }),
  );
}

const services = (ha: FakeHa): { path: string; body: unknown }[] =>
  ha.posts
    .filter((post) => post.path.startsWith('/api/services/') && !post.path.includes('/todo/'))
    .map((post) => ({ path: post.path.slice('/api/services/'.length), body: JSON.parse(post.body) }));

const poll = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());

describe('a reading’s controls on a paired wall', () => {
  it(
    'opens over the wall for a light that dims, moves no widget, and names what it holds',
    async () => {
      const wall = await wallWithControls();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-action="panel"]', { timeout: 25_000 });
        const before = await boxes(page);
        await openFor(page, 'Living room');

        // A press opened the panel and switched nothing.
        expect(services(wall.ha)).toEqual([]);
        // Not one widget moved, to the hundredth of a pixel.
        expect(await boxes(page)).toEqual(before);

        const panel = await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>('#wall .hc-panel');
          const focused = document.activeElement as HTMLElement | null;
          return {
            label: node?.getAttribute('aria-label'),
            insideCanvas: node?.closest('.canvas') !== null,
            buttons: [...(node?.querySelectorAll<HTMLElement>('.hc-buttons .hc-button') ?? [])].map((b) =>
              (b.textContent ?? '').trim(),
            ),
            sliders: [...(node?.querySelectorAll<HTMLInputElement>('.hc-range') ?? [])].map(
              (r) => `${r.getAttribute('data-hc-action')}:${r.min}-${r.max}@${r.value}`,
            ),
            swatches: node?.querySelectorAll('.hc-swatch').length ?? 0,
            focusedAction: focused?.getAttribute('data-hc-action') ?? null,
            expanded: document
              .querySelector('#wall [data-ha-action="panel"][aria-expanded="true"]')
              ?.closest('.ht-tile')
              ?.querySelector('.ht-name')?.textContent,
            smallest: Math.min(
              ...[...(node?.querySelectorAll<HTMLElement>('.hc-button, .hc-range') ?? [])].map((c) =>
                c.getBoundingClientRect().height,
              ),
            ),
          };
        });
        expect(panel).toMatchObject({
          label: 'Living room',
          insideCanvas: false,
          buttons: ['Turn off'],
          // The light shows no white, so the slider starts mid-range on its own
          // 50 K grid, which begins at the light's minimum.
          sliders: ['brightness:1-100@60', 'colour_temp:2202-6535@4352'],
          swatches: 8,
          // Focus lands on the first control, so the OK key has somewhere to go.
          focusedAction: 'toggle',
          expanded: 'Living room',
        });
        expect(panel.smallest).toBeGreaterThanOrEqual(44);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'sends a slider’s value once, on release, and the panel reads it back after the re-poll',
    async () => {
      const wall = await wallWithControls();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-action="panel"]', { timeout: 25_000 });
        await openFor(page, 'Living room');
        const slider = page.locator('#wall .hc-range[data-hc-action="brightness"]');
        const box = (await slider.boundingBox())!;
        // A drag across most of the track: many `input` events, one `change`.
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
        await page.mouse.down();
        for (let step = 1; step <= 10; step++) {
          await page.mouse.move(box.x + box.width * (0.6 - step * 0.03), box.y + box.height / 2);
        }
        const readout = await page.locator('#wall .hc-slider .hc-readout').first().textContent();
        // Nothing has left yet, while the finger is down — and the readout moved.
        expect(services(wall.ha)).toEqual([]);
        expect(readout).not.toBe('60%');
        await page.mouse.up();
        await page.waitForFunction(
          () => (document.querySelector('#wall .hc-state')?.textContent ?? '') !== 'On · 60%',
          undefined,
          { timeout: 15_000 },
        );
        const sent = services(wall.ha);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.path).toBe('light/turn_on');
        const pct = (sent[0]?.body as { brightness_pct: number }).brightness_pct;
        expect(pct).toBeGreaterThan(0);
        expect(pct).toBeLessThan(60);
        // The panel is still open, and says what the house now says.
        expect(await page.locator('#wall .hc-state').textContent()).toBe(`On · ${pct}%`);
        expect(await page.locator('#wall .hc-range[data-hc-action="brightness"]').inputValue()).toBe(String(pct));
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'keeps the panel open across a rebuild, and does not rebuild under a finger on a slider',
    async () => {
      const wall = await wallWithControls();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-action="panel"]', { timeout: 25_000 });
        await openFor(page, 'Living room');
        // Focus on the white slider, then a poll that redraws the whole wall.
        await page.locator('#wall .hc-range[data-hc-action="colour_temp"]').focus();
        wall.app.db.prepare(`UPDATE ha_entity_cache SET state = 'on' WHERE entity_id = ?`).run(LIGHT);
        await poll(page);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.locator('#wall .hc-panel').count()).toBe(1);
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('data-hc-action') ?? null),
        ).toBe('colour_temp');

        // A finger down on the brightness slider: mark the node, redraw, and it
        // is the same node until the finger lifts.
        const slider = page.locator('#wall .hc-range[data-hc-action="brightness"]');
        await slider.evaluate((node) => ((node as unknown as { held: boolean }).held = true));
        const box = (await slider.boundingBox())!;
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
        await page.mouse.down();
        await poll(page);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(
          await page.evaluate(
            () =>
              (document.querySelector('#wall .hc-range[data-hc-action="brightness"]') as unknown as { held?: boolean })
                ?.held === true,
          ),
        ).toBe(true);
        await page.mouse.up();
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        // Released: the held redraw ran, and the panel is still there.
        expect(
          await page.evaluate(
            () =>
              (document.querySelector('#wall .hc-range[data-hc-action="brightness"]') as unknown as { held?: boolean })
                ?.held === true,
          ),
        ).toBe(false);
        expect(await page.locator('#wall .hc-panel').count()).toBe(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'sends a swatch’s colour, moves a blind, and says a refusal inside the panel',
    async () => {
      const wall = await wallWithControls();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-action="panel"]', { timeout: 25_000 });
        await openFor(page, 'Living room');
        await page.locator('#wall .hc-swatch[aria-label="Blue"]').click();
        await expect.poll(() => services(wall.ha).length, { timeout: 10_000 }).toBe(1);
        expect(services(wall.ha)[0]).toEqual({
          path: 'light/turn_on', body: { entity_id: LIGHT, rgb_color: [0, 70, 255] },
        });
        await page.locator('#wall .hc-done').click();
        await expect.poll(() => page.locator('#wall .hc-panel').count()).toBe(0);

        await openFor(page, 'Kitchen blind');
        const blind = await page.evaluate(() => ({
          buttons: [...document.querySelectorAll('#wall .hc-buttons .hc-button')].map((b) => (b.textContent ?? '').trim()),
          sliders: [...document.querySelectorAll<HTMLInputElement>('#wall .hc-range')].map(
            (r) => `${r.getAttribute('data-hc-action')}@${r.value}`,
          ),
        }));
        expect(blind).toEqual({ buttons: ['Open', 'Stop', 'Close'], sliders: ['position@40'] });
        await page.locator('#wall .hc-button[data-hc-action="close"]').click();
        await expect.poll(() => services(wall.ha).length, { timeout: 10_000 }).toBe(2);
        expect(services(wall.ha)[1]).toEqual({ path: 'cover/close_cover', body: { entity_id: BLIND } });

        wall.ha.refuseToggle = true;
        await page.locator('#wall .hc-button[data-hc-action="open"]').click();
        const note = page.locator('#wall .hc-panel [role="alert"]');
        await note.waitFor({ timeout: 10_000 });
        expect(((await note.textContent()) ?? '').trim().length).toBeGreaterThan(10);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'closes on Done or on the wall around it, and hands focus back to the reading',
    async () => {
      const wall = await wallWithControls();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-ha-action="panel"]', { timeout: 25_000 });
        const focusedName = (): Promise<string | null> =>
          page.evaluate(
            () =>
              (document.activeElement?.closest('.ht-tile')?.querySelector('.ht-name')?.textContent ?? null),
          );
        await openFor(page, 'Living room');
        await page.locator('#wall .hc-done').click();
        await expect.poll(() => page.locator('#wall .hc-panel').count()).toBe(0);
        expect(await focusedName()).toBe('Living room');

        await openFor(page, 'Kitchen blind');
        // A press on the scrim, well away from the panel.
        await page.mouse.click(10, 10);
        await expect.poll(() => page.locator('#wall .hc-panel').count()).toBe(0);
        expect(await focusedName()).toBe('Kitchen blind');
        expect(services(wall.ha)).toEqual([]);

        // And Enter, the OK key, opens it from the reading as a tap does.
        await page.keyboard.press('Enter');
        await page.waitForSelector('#wall .hc-panel', { timeout: 10_000 });
        expect(await page.locator('#wall .hc-panel').getAttribute('aria-label')).toBe('Kitchen blind');

        /*
         * And it closes itself once nobody has touched it for a while: a wall
         * has no pointer to dismiss anything. The device clock is what the
         * panel's idle is kept on, so it is the one moved — a minute on — and
         * the next draw is what notices.
         */
        await page.evaluate(() => {
          const real = Date.now.bind(Date);
          Date.now = () => real() + 60_000;
        });
        await poll(page);
        await expect.poll(() => page.locator('#wall .hc-panel').count(), { timeout: 10_000 }).toBe(0);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

/**
 * Switching a light from a real paired wall (RFC 018 phase 2).
 *
 * `ha-act.test.ts` holds the endpoint to the fake house and proves what it
 * refuses. None of that can see the half a household meets: whether a reading
 * becomes something to press only where all three switches say so, whether it
 * stays the same rectangle when it does, whether the ring says where the OK key
 * lands, whether the tile says "Off" after the press, and whether a press the
 * house refused says so in the box it was pressed in.
 *
 * Every assertion is on a computed value, a measured rectangle or the tag of
 * the element, never on a class — the rule `.ch-tick` taught this suite.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  install,
  loadWallSettled,
  settleWall,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 180_000;
const LIGHT = 'light.living_room';
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
  readonly allowControl: (on?: boolean) => void;
}

/**
 * A household with Home Assistant connected through the real form, three
 * readings watched, the living-room light marked controllable through the
 * Readings screen's own form, and a wall carrying two Home Assistant boxes —
 * one set to act and one that only shows — beside a calendar.
 *
 * The rows are seeded into the cache rather than polled, `browser-ha-tile`'s
 * reason: the poll is the module's subject. What is *not* seeded is the press
 * — that goes to the fake house over a socket, and the tile reads its answer.
 */
async function wallWithLight(): Promise<Wall> {
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
         VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 'label_value', NULL, ?)
         ON CONFLICT(entity_id) DO UPDATE SET state = excluded.state, attributes = excluded.attributes,
           friendly_name = excluded.friendly_name, fetched_at = excluded.fetched_at, watched = 1`,
      )
      .run(entity, state, JSON.stringify(attributes), name, at - 600_000, at, order);
  };
  seed(LIGHT, 'on', { brightness: 153, color_mode: 'rgb' }, 'Living room', 0);
  seed('switch.kettle', 'off', { device_class: 'outlet' }, 'Kettle', 1);
  seed('sensor.kitchen_temperature', '19.4', { device_class: 'temperature' }, 'Kitchen temperature', 2);
  expect(
    (await app.post('/admin/home-assistant/entities/control', { entity_id: LIGHT, controllable: '1' })).status,
  ).toBe(302);

  const link = await app.pairLink('Kitchen');
  const screen = (
    app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
  ).id;
  app.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
  };
  place('w-act', 'homeassistant', [0.06, 0.03, 0.88, 0.22], {
    variant: 'tile', tapAction: 'act', readings: [LIGHT, 'switch.kettle'],
  });
  place('w-list', 'homeassistant', [0.06, 0.28, 0.88, 0.12], { tapAction: 'act', readings: [LIGHT] });
  place('w-show', 'homeassistant', [0.06, 0.43, 0.88, 0.12], { variant: 'tile', readings: [LIGHT] });
  place('w-cal', 'calendar', [0.06, 0.58, 0.88, 0.4], { mode: 'list', count: 4 });

  return {
    app,
    ha,
    link,
    allowControl: (on = true) => {
      app.db.prepare('UPDATE screens SET allow_control = ? WHERE id = ?').run(on ? 1 : 0, screen);
    },
  };
}

interface Drawn {
  readonly name: string;
  readonly state: string;
  readonly tag: string;
  readonly act: boolean;
  readonly rect: { x: number; y: number; w: number; h: number };
}

/** Every reading on the wall, by widget: its words, its element, and its rectangle. */
async function drawn(page: Page): Promise<Record<string, Drawn[]>> {
  return page.evaluate(() => {
    const out: Record<string, Drawn[]> = {};
    for (const box of document.querySelectorAll<HTMLElement>('#wall .canvas > .fw-homeassistant')) {
      out[box.dataset['widgetId'] ?? ''] = [...box.querySelectorAll<HTMLElement>('.ht-tile, .hs-item')].map(
        (item) => {
          const rect = item.getBoundingClientRect();
          return {
            name: (item.querySelector('.ht-name, .hs-label')?.textContent ?? '').trim(),
            state: (item.querySelector('.ht-state, .hs-value')?.textContent ?? '').trim(),
            // The *tag*: a div styled to look pressable is the fault this is
            // written against.
            tag: item.tagName,
            act: item.hasAttribute('data-ha-act'),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          };
        },
      );
    }
    return out;
  }) as Promise<Record<string, Drawn[]>>;
}

const poll = (page: Page): Promise<void> =>
  page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());

const light = (list: Drawn[] | undefined): Drawn | undefined => list?.find((one) => one.name === 'Living room');

describe('operating a light from a paired wall', () => {
  it(
    'is a button only where all three switches say so, and the same rectangle either way',
    async () => {
      const wall = await wallWithLight();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;

        // The wall's own switch is off: nothing anywhere is a control.
        const before = await drawn(page);
        expect(light(before['w-act'])?.state).toBe('On · 60%');
        for (const list of Object.values(before)) expect(list.every((one) => !one.act)).toBe(true);

        wall.allowControl();
        await poll(page);
        await page.waitForSelector('#wall [data-ha-act]', { timeout: 25_000 });
        await settleWall(page);
        const after = await drawn(page);

        // The light, in both boxes set to act — as a tile and as a list line.
        expect(light(after['w-act'])).toMatchObject({ tag: 'BUTTON', act: true });
        expect(light(after['w-list'])).toMatchObject({ tag: 'BUTTON', act: true });
        // The kettle is on the acting tile too, and is not a button: nobody
        // marked it controllable.
        expect(after['w-act']?.find((one) => one.name === 'Kettle')).toMatchObject({ tag: 'DIV', act: false });
        // And the box that only shows draws a picture of the same light.
        expect(light(after['w-show'])).toMatchObject({ tag: 'DIV', act: false });

        // Same rectangle as the picture it was a moment ago, to the pixel: a
        // reading that can be pressed takes no room a reading that cannot has.
        for (const widget of ['w-act', 'w-list']) {
          const was = light(before[widget])?.rect;
          const now = light(after[widget])?.rect;
          expect(now, widget).toBeDefined();
          for (const side of ['x', 'y', 'w', 'h'] as const) {
            expect(Math.abs((now?.[side] ?? 0) - (was?.[side] ?? -99)), `${widget} ${side}`).toBeLessThan(0.5);
          }
        }

        // --- the ring, after a press on the button itself ---------------------
        // `browser-todo-tick`'s measurement: only a pointer press on the control
        // separates `:focus` from `:focus-visible`, and a wall has no cursor.
        const target = page.locator('#wall [data-widget-id="w-act"] [data-ha-act]').first();
        const box = await target.boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        const ring = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('#wall [data-widget-id="w-act"] [data-ha-act]');
          return {
            width: button === null ? '' : getComputedStyle(button).outlineWidth,
            style: button === null ? '' : getComputedStyle(button).outlineStyle,
            focused: document.activeElement === button,
            // Recorded so a browser that changes its heuristic makes this test
            // say so rather than quietly stop discriminating.
            visible: button?.matches(':focus-visible') ?? true,
          };
        });
        await page.mouse.move(2, 2);
        await page.mouse.up();
        expect(ring.focused).toBe(true);
        expect(ring.visible).toBe(false);
        /*
         * The style as well as the width. With no outline at all this browser
         * still reports `outline-width: 3px` — the initial `medium` — so a
         * width check alone passed with the `:focus` half of the rule deleted.
         * Measured: `style: "none"` there, `"solid"` with it.
         */
        expect(ring.style).toBe('solid');
        expect(Number.parseFloat(ring.width)).toBeGreaterThan(0);
        // Moved away before release, so nothing was pressed.
        expect(wall.ha.posts.filter((post) => post.path.endsWith('/toggle'))).toEqual([]);

        // --- the list line's target, walked outward ---------------------------
        const reach = await page.evaluate(() => {
          const button = document.querySelector<HTMLElement>('#wall [data-widget-id="w-list"] [data-ha-act]');
          if (button === null) return { drawn: 0, hit: 0 };
          const rect = button.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);
          const answers = (y: number): boolean =>
            document.elementFromPoint(cx, y)?.closest('[data-ha-act]') === button;
          let up = 0;
          let down = 0;
          while (up < 60 && answers(cy - up - 1)) up++;
          while (down < 60 && answers(cy + down + 1)) down++;
          return { drawn: rect.height, hit: up + down + 1 };
        });
        expect(reach.hit).toBeGreaterThanOrEqual(44);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'switches the light on one tap, and the tile reads Off on the re-poll',
    async () => {
      const wall = await wallWithLight();
      wall.allowControl();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-act"] [data-ha-act]', { timeout: 25_000 });
        await page.locator('#wall [data-widget-id="w-act"] [data-ha-act]').first().click();
        // The light's own tile, by its name: the kettle beside it already reads
        // "Off", and a wait for any "Off" in the box passed before the press
        // had been answered at all.
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('#wall [data-widget-id="w-act"] .ht-tile')].some(
              (tile) =>
                (tile.querySelector('.ht-name')?.textContent ?? '').trim() === 'Living room' &&
                (tile.querySelector('.ht-state')?.textContent ?? '').trim() === 'Off',
            ),
          undefined,
          { timeout: 25_000 },
        );
        expect(wall.ha.toggled[LIGHT]).toBe('off');
        expect(wall.ha.posts.filter((post) => post.path.endsWith('/toggle'))).toHaveLength(1);
        // Every box drawing the light says so — one reading, one state.
        expect(light((await drawn(page))['w-show'])?.state).toBe('Off');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'says so in the box, when Home Assistant refuses, and leaves the light as it was',
    async () => {
      const wall = await wallWithLight();
      wall.allowControl();
      wall.ha.refuseToggle = true;
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-act"] [data-ha-act]', { timeout: 25_000 });
        await page.locator('#wall [data-widget-id="w-act"] [data-ha-act]').first().click();
        const note = page.locator('#wall [data-widget-id="w-act"] [role="alert"]');
        await note.waitFor({ timeout: 10_000 });
        const said = ((await note.textContent()) ?? '').trim();
        expect(said.length).toBeGreaterThan(10);
        expect(said).not.toContain(wall.ha.base);
        // Only where it was pressed.
        expect(await page.locator('#wall [data-widget-id="w-list"] [role="alert"]').count()).toBe(0);
        expect(light((await drawn(page))['w-act'])?.state).toBe('On · 60%');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'switches on Enter, the OK key a remote sends',
    async () => {
      const wall = await wallWithLight();
      wall.allowControl();
      const opened = await loadWallSettled(wall.link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-list"] [data-ha-act]', { timeout: 25_000 });
        await page.evaluate(() =>
          document.querySelector<HTMLElement>('#wall [data-widget-id="w-list"] [data-ha-act]')?.focus(),
        );
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          () =>
            (document.querySelector('#wall [data-widget-id="w-list"] .hs-value')?.textContent ?? '').trim() ===
            'Off',
          undefined,
          { timeout: 25_000 },
        );
        // One press, one toggle: the OK key's own handler stood aside.
        expect(wall.ha.posts.filter((post) => post.path.endsWith('/toggle'))).toHaveLength(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'is one switch in the editor, which writes the widget’s own tapAction and nothing else',
    async () => {
      /*
       * The third switch is the only one on the layout screen, and the one a
       * household would look for there. Driven in the real editor, and read
       * back off the stored row — the boundary `/d/ha/act` reads it from.
       */
      const wall = await wallWithLight();
      const screen = (
        wall.app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }
      ).id;
      const stored = (id: string): Record<string, unknown> =>
        JSON.parse(
          (wall.app.db.prepare('SELECT config FROM layout_widgets WHERE id = ?').get(id) as { config: string }).config,
        ) as Record<string, unknown>;
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.on('dialog', (dialog) => void dialog.accept());
      try {
        await wall.app.signIn(page);
        await page.goto(`${wall.app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        const toggle = async (id: string, expected: boolean): Promise<void> => {
          await page.waitForSelector(`.le-overlay .le-widget[data-id="${id}"]`, { timeout: 20_000 });
          await page.locator(`.le-overlay .le-widget[data-id="${id}"]`).click();
          const control = page.locator('label.switch[data-cfg-key="tapAction"] input');
          await control.waitFor({ timeout: 10_000 });
          expect(await control.isChecked(), id).toBe(expected);
          await control.setChecked(!expected);
        };
        await toggle('w-act', true);
        await toggle('w-show', false);
        const saved = await page.evaluate(() =>
          (window as unknown as { mwEditor: { saveCurrent(): Promise<{ ok: boolean }> } }).mwEditor.saveCurrent(),
        );
        expect(saved.ok).toBe(true);
        // Off is an absence, so a widget switched back stores what it stored
        // before it ever acted; on is the one word the schema allows.
        expect('tapAction' in stored('w-act')).toBe(false);
        expect(stored('w-act')['variant']).toBe('tile');
        expect(stored('w-show')['tapAction']).toBe('act');
      } finally {
        await page.close({ runBeforeUnload: false });
        await context.close();
      }
    },
    SLOW,
  );
});

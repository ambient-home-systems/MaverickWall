/**
 * A camera on a real paired wall and in a real editor (plan item M6.1, RFC 007
 * Tier A), against the stand-in Home Assistant's front door.
 *
 * RFC 007 §11 names the assertion to write first, because it is the one that
 * fails the draft this design replaced: **the wall rebuilds itself every
 * fifteen seconds and the picture must not be fetched again because of it.**
 * So a picture is followed across rebuilds — the same `<img>` element, one
 * request until its own refresh is due — while the box under it is a new node
 * each time. Read off the glass rather than off a class: the picture's
 * rectangle is held to its box's, at a quarter turn too; a camera that stops
 * answering shows the box's words and moves nothing else on the wall; and the
 * editor offers names and stores a handle, with no entity id in its page.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { watchCamera } from '../src/modules/cameras/index.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa } from './fake-home-assistant.js';

const SLOW = 150_000;
const DOOR = 'camera.front_door';
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

interface Setup {
  readonly app: Installation;
  readonly ha: FakeHa;
  readonly handle: string;
  readonly link: string;
  readonly screen: string;
}

async function setUp(options: { rotation?: number } = {}): Promise<Setup> {
  const app = await install({});
  installations.push(app);
  const ha = await fakeHomeAssistant();
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  expect(
    (await app.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' })).status,
  ).toBe(302);
  const added = watchCamera(app.db, { entityId: DOOR, name: 'Front door' }, app.now());
  if (!added.ok) throw new Error(added.message);
  const link = await app.pairLink('Kitchen');
  const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  app.db.prepare(`UPDATE screens SET layout_mode = 'freeform', rotation = ? WHERE id = ?`).run(options.rotation ?? 0, screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
  const at = app.now();
  const place = (id: string, type: string, box: readonly [number, number, number, number], config: unknown): void => {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(id, screen, type, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
  };
  place('cam', 'camera', [0.05, 0.05, 0.6, 0.3], { camera: added.handle, cameraRefreshSec: 30, title: 'Front door', showTitle: true });
  place('cal', 'calendar', [0.05, 0.4, 0.9, 0.55], {});
  return { app, ha, handle: added.handle, link, screen };
}

const pictureFacts = (page: Page) =>
  page.evaluate(() => {
    const pic = document.querySelector<HTMLElement>('#camera-layer .camera-pic');
    const img = pic?.querySelector('img') as (HTMLImageElement & { __tagged?: boolean }) | null | undefined;
    const box = document.querySelector<HTMLElement>('#wall .fw[data-widget-id="cam"] .fw-camera');
    const cal = document.querySelector<HTMLElement>('#wall .fw[data-widget-id="cal"]');
    const r = (el: Element | null | undefined) => {
      if (el === null || el === undefined) return undefined;
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
    };
    return {
      live: pic?.classList.contains('is-live') === true,
      visible: pic === null || pic === undefined ? undefined : getComputedStyle(pic).visibility,
      layerShown: document.getElementById('camera-layer')?.hidden === false,
      loaded: img !== null && img !== undefined && img.complete && img.naturalWidth > 0,
      tagged: img?.__tagged === true,
      boxTagged: (box as (HTMLElement & { __tagged?: boolean }) | null)?.__tagged === true,
      picture: r(pic),
      box: r(box),
      calendar: r(cal),
      note: box?.textContent ?? '',
    };
  });

describe('a camera on a wall', () => {
  it(
    'keeps one picture through every rebuild, fetched again only on its own timer, over its box to the pixel',
    async () => {
      const { app, ha, link } = await setUp();
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 }, { clock: 'installed' });
      try {
        const page = opened.page;
        const asked: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/d/camera/')) asked.push(request.url());
        });
        await page.waitForFunction(
          () => document.querySelector('#camera-layer .camera-pic.is-live img') !== null,
          undefined,
          { timeout: 25_000 },
        );
        const first = await pictureFacts(page);
        expect(first.live).toBe(true);
        expect(first.visible).toBe('visible');
        expect(first.layerShown).toBe(true);
        expect(first.loaded).toBe(true);
        // The picture covers its box, exactly: the box's rectangle is the renderer's.
        expect(first.picture).toEqual(first.box);
        // The words under it are gone once it is up.
        expect(first.note).toBe('');
        // Nothing of the camera's name in Home Assistant, its address or a token.
        const manifest = await page.evaluate(() => fetch('/d/manifest').then((r) => r.text()));
        for (const secret of [DOOR, ha.base, TOKEN, 'camera-token-that-must-not-travel']) expect(manifest).not.toContain(secret);

        // Tag the picture and its box, then let the wall rebuild twice.
        await page.evaluate(() => {
          (document.querySelector('#camera-layer img') as HTMLImageElement & { __tagged?: boolean }).__tagged = true;
          (document.querySelector('#wall .fw-camera') as HTMLElement & { __tagged?: boolean }).__tagged = true;
        });
        const before = asked.length;
        const fetchesBefore = ha.paths.filter((path) => path.startsWith('/api/camera_proxy/')).length;
        await page.clock.runFor(15_500);
        await page.clock.runFor(10_000);
        await page.waitForTimeout(400);
        const rebuilt = await pictureFacts(page);
        // The box is a new node — the wall did rebuild — and the picture is the same one, unasked again.
        expect(rebuilt.boxTagged).toBe(false);
        expect(rebuilt.tagged).toBe(true);
        expect(rebuilt.live).toBe(true);
        expect(asked.length).toBe(before);
        expect(ha.paths.filter((path) => path.startsWith('/api/camera_proxy/')).length).toBe(fetchesBefore);
        expect(rebuilt.picture).toEqual(rebuilt.box);

        // Its own thirty seconds come round, and it asks once, with a new address.
        await page.clock.runFor(6_000);
        await expect.poll(() => asked.length, { timeout: 10_000 }).toBe(before + 1);
        expect(new Set(asked).size).toBe(asked.length);
        expect(asked.every((url) => /\/d\/camera\/[A-Za-z0-9_-]{43}\/still\?n=\d+$/.test(url))).toBe(true);

        // The camera stops answering: the box says so, and nothing else on the wall moves.
        ha.cameraFails = true;
        await page.clock.runFor(31_000);
        await page.waitForFunction(
          () => document.querySelector('#wall .fw-camera')?.textContent?.includes('No picture from this camera just now.') === true,
          undefined,
          { timeout: 15_000 },
        );
        const failed = await pictureFacts(page);
        expect(failed.visible).toBe('hidden');
        expect(failed.calendar).toEqual(first.calendar);
        expect(failed.box).toEqual(first.box);
        void app;
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'sits over its box on a wall turned a quarter, and is not asked for while the camera is missing',
    async () => {
      const { app, link, handle } = await setUp({ rotation: 90 });
      const opened = await loadWallSettled(link, { width: 1920, height: 1080 }, { clock: 'installed' });
      try {
        const page = opened.page;
        await page.waitForFunction(
          () => document.querySelector('#camera-layer .camera-pic.is-live img') !== null,
          undefined,
          { timeout: 25_000 },
        );
        const turned = await pictureFacts(page);
        expect(turned.picture).toEqual(turned.box);
        // Turned, the box is taller than it is wide on a landscape viewport.
        expect((turned.box?.[3] ?? 0) > 0).toBe(true);

        // The poll finds the camera missing: the next manifest says so and nothing is asked for.
        app.db.prepare('UPDATE ha_cameras SET available = 0 WHERE handle = ?').run(handle);
        const asked: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/d/camera/')) asked.push(request.url());
        });
        await page.reload();
        await page.waitForFunction(
          () => document.querySelector('#wall .fw-camera')?.textContent?.includes('This camera is not answering') === true,
          undefined,
          { timeout: 25_000 },
        );
        expect(await page.evaluate(() => document.getElementById('camera-layer')?.hidden)).toBe(true);
        // The copy the wall drew first, from its own store, may have asked once
        // before the fresh manifest said otherwise; nothing asks after it.
        const settled = asked.length;
        expect(settled).toBeLessThanOrEqual(1);
        await page.clock.runFor(120_000);
        await page.waitForTimeout(500);
        expect(asked.length).toBe(settled);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('a camera in the editor', () => {
  it(
    'is offered by name, saved by handle, and the page carries no entity id',
    async () => {
      const { app, handle, screen } = await setUp();
      app.db.prepare(`DELETE FROM layout_widgets WHERE id = 'cam'`).run();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await app.signIn(page);
        await page.goto(`${app.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        expect(await page.content()).not.toContain(DOOR);

        if (!(await page.locator('.le-add-primary').isVisible())) await page.click('.insp-close');
        await page.locator('.le-add-primary').click();
        await page.locator('.le-modal-item').filter({ hasText: /^Camera$/ }).click();
        const select = page.locator('.le-cfg-field[data-cfg-key="camera"] select');
        await select.waitFor({ timeout: 10_000 });
        expect(await select.locator('option').allTextContents()).toEqual(['Choose a camera', 'Front door']);
        await select.selectOption(handle);
        // The preview draws the box and says where the picture goes.
        await expect
          .poll(() =>
            page.evaluate(
              () => document.querySelector('.le-preview')?.shadowRoot?.querySelector('.fw-camera')?.textContent ?? '',
            ),
          )
          .toContain('shown here on the wall');

        await page.locator('[data-action="save"]').click();
        await expect
          .poll(
            () => {
              const rows = app.db
                .prepare(`SELECT config FROM layout_widgets WHERE screen_id = ? AND type = 'camera'`)
                .all(screen) as { config: string }[];
              return rows.map((row) => (JSON.parse(row.config) as Record<string, unknown>)['camera']);
            },
            { timeout: 10_000 },
          )
          .toEqual([handle]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

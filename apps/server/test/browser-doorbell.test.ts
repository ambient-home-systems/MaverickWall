/**
 * The doorbell pop-up on a real paired wall (plan item M6.3, RFC 007 phase 4).
 *
 * A ring covers the wall with the camera the rule named, live, above the
 * rule's words and its OK — the picture on the camera layer, over the
 * takeover's own box to the pixel, and never over the OK. One stream through
 * a rebuild. Then the minute is up and the calendar comes back **by the
 * wall's own clock, with the server unreachable**, at the moment the takeover
 * said and not at the next fifteen-second tick.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import { watchCamera } from '../src/modules/cameras/index.js';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 150_000;
const DOOR = 'camera.front_door';
const BELL = 'event.front_door_ring';
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

const facts = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element | null | undefined) => {
      if (el === null || el === undefined) return undefined;
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
    };
    const pic = document.querySelector('#camera-layer .camera-pic');
    return {
      takeover: document.querySelector('#wall .screen-alert.has-camera') !== null,
      canvas: document.querySelector('#wall .canvas') !== null,
      words: document.querySelector('#wall .alert-line')?.textContent ?? '',
      layerShown: document.getElementById('camera-layer')?.hidden === false,
      live: document.querySelector('#camera-layer .camera-pic.is-live canvas') !== null,
      picture: r(pic),
      box: r(document.querySelector('#wall .alert-camera')),
      ack: r(document.querySelector('#wall .alert-ack')),
      line: r(document.querySelector('#wall .alert-line')),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });

describe('a doorbell on a wall', () => {
  it(
    'covers the wall with the camera, live, for its minute, and gives the calendar back by the wall’s own clock',
    async () => {
      const app = await install({});
      installations.push(app);
      const ha = await fakeHomeAssistant();
      ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
      expect(
        (await app.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' }))
          .status,
      ).toBe(302);
      const added = watchCamera(app.db, { entityId: DOOR, name: 'Front door' }, app.now());
      if (!added.ok) throw new Error(added.message);
      expect(
        (
          await app.post('/admin/home-assistant/rules', {
            name: 'Somebody at the door',
            entity_id: BELL,
            condition: 'happened',
            value: '',
            action: 'takeover',
            hold_sec: '60',
            camera: added.handle,
          })
        ).status,
      ).toBe(302);
      const screen = await app.pairLink('Kitchen');
      // Allowed to acknowledge, so the takeover carries its OK.
      app.db.prepare(`UPDATE screens SET allow_dismiss = 1 WHERE kind IS NOT 'epaper'`).run();

      // The calendar first, with nothing ringing.
      /*
       * The wall's own clock offset, as it takes it: the server's time off
       * each manifest's header against the device clock the moment the answer
       * arrives (`clock.ts`). Recorded in the page rather than estimated by a
       * second request, which the harness holds for the fonts by a different
       * amount and so reads a different offset by up to seconds.
       */
      const opened = await loadWallSettled(
        screen,
        { width: 1080, height: 1920 },
        {
          clock: 'installed',
          beforeLoad: (context) =>
            context.addInitScript(() => {
              const original = window.fetch.bind(window);
              window.fetch = async (...args: Parameters<typeof fetch>) => {
                const response = await original(...args);
                const server = Number(response.headers.get('x-server-time'));
                if (String(args[0]).includes('/d/manifest') && Number.isFinite(server) && server > 0) {
                  (window as unknown as { __offset: number }).__offset = server - Date.now();
                }
                return response;
              };
            }),
        },
      );
      try {
        const page = opened.page;
        const asked: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/d/camera/')) asked.push(request.url());
        });
        expect((await facts(page)).canvas).toBe(true);

        // The ring, as the poll writes it: rang a second ago, heard now. The
        // wall hears of it on its own next poll.
        const at = app.now();
        app.db
          .prepare(
            `INSERT INTO ha_condition_states (entity_id, state, changed_at, read_at, friendly_name, noticed_at)
             VALUES (?, ?, ?, ?, 'Front door', ?)`,
          )
          .run(BELL, new Date(at - 1_000).toISOString(), at - 1_000, at, at);
        await page.clock.runFor(61_000);
        await page.waitForFunction(
          () => document.querySelector('#camera-layer .camera-pic.is-live canvas') !== null,
          undefined,
          { timeout: 25_000 },
        );
        /*
         * How long is left, on the wall's own clock, taken now — just after the
         * poll that brought it, when the wall's correction is the server's
         * time. From here on the wall's clock is the device clock, which only
         * this test moves, so what is left is counted in what it moves.
         */
        const left = await page.evaluate(async () => {
          const offset = (window as unknown as { __offset: number }).__offset;
          const wallNow = Date.now() + offset;
          const body = (await (await fetch('/d/manifest')).json()) as { interrupts: { until?: number }[] };
          return (body.interrupts[0]?.until ?? 0) - wallNow;
        });
        expect(left).toBeGreaterThan(40_000);
        const up = await facts(page);
        expect(up.takeover).toBe(true);
        expect(up.words).toBe('Somebody at the door');
        expect(up.layerShown).toBe(true);
        // The picture covers the takeover's own box, exactly, and stops above the OK.
        expect(up.picture).toEqual(up.box);
        const [, picY = 0, , picH = 0] = up.picture ?? [];
        expect(up.ack).toBeDefined();
        const [, ackY = 0] = up.ack ?? [];
        expect(picY + picH).toBeLessThanOrEqual(ackY);
        // Above the words and across the wall, never squeezed in beside them.
        const [, lineY = 0] = up.line ?? [];
        expect(picY + picH).toBeLessThanOrEqual(lineY);
        const [, , picW = 0] = up.picture ?? [];
        expect(picW).toBeGreaterThan(up.width * 0.85);
        // And most of the wall's height: the door is what the wall is for now.
        expect(picH).toBeGreaterThan(up.height * 0.5);

        // A rebuild keeps the one stream.
        const before = asked.length;
        await page.clock.runFor(15_500);
        await page.waitForTimeout(300);
        expect((await facts(page)).takeover).toBe(true);
        expect(asked.length).toBe(before);

        // The server goes, and the minute runs out: down at its own moment,
        // not at the next fifteen-second tick.
        await page.route('**/d/manifest**', (route) => route.abort());
        await page.clock.runFor(left - 15_500 - 2_000);
        await page.waitForTimeout(300);
        expect((await facts(page)).takeover).toBe(true);
        await page.clock.runFor(3_000);
        await page.waitForTimeout(300);
        const down = await facts(page);
        expect(down.takeover).toBe(false);
        expect(down.canvas).toBe(true);
        expect(down.layerShown).toBe(false);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

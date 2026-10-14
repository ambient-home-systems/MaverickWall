/**
 * OK on a Home Assistant takeover, on a real paired wall (rule 12).
 *
 * The wall is handed a handle for the alert, never the entity it is about,
 * and its OK posts that handle back. This is the round trip end to end: the
 * takeover drawn, OK pressed in a real Chromium, the acknowledgement stored
 * under the door on the server, the calendar back — and the entity id in no
 * manifest the wall received and nowhere in what it drew.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 90_000;
const DOOR = 'binary_sensor.back_door';
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

describe('OK on a Home Assistant takeover', () => {
  it(
    'clears it by its handle, and the wall never sees the entity',
    async () => {
      const app = await install({});
      installations.push(app);
      const ha = await fakeHomeAssistant();
      expect(
        (await app.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' }))
          .status,
      ).toBe(302);
      expect(
        (
          await app.post('/admin/home-assistant/rules', {
            name: 'The back door is open',
            entity_id: DOOR,
            condition: 'equals',
            value: 'on',
            action: 'takeover',
            hold_sec: '',
          })
        ).status,
      ).toBe(302);
      const screen = await app.pairLink('Kitchen');
      app.db.prepare(`UPDATE screens SET allow_dismiss = 1 WHERE kind IS NOT 'epaper'`).run();
      const bodies: string[] = [];
      const opened = await loadWallSettled(screen, { width: 1080, height: 1920 }, {
        beforeLoad: async (context) => {
          context.on('response', async (response) => {
            if (!response.url().includes('/d/manifest')) return;
            try {
              bodies.push(await response.text());
            } catch {
              // A 304, or a body the page has already let go of.
            }
          });
        },
      });
      try {
        const page = opened.page;
        // The door as the poll writes it: open, read just now.
        const at = app.now();
        app.db
          .prepare(
            `INSERT INTO ha_entity_cache (entity_id, state, friendly_name, last_changed_at, fetched_at, watched)
             VALUES (?, 'on', 'Back door', ?, ?, 1)
             ON CONFLICT(entity_id) DO UPDATE SET state = 'on', friendly_name = 'Back door',
                 last_changed_at = excluded.last_changed_at, fetched_at = excluded.fetched_at`,
          )
          .run(DOOR, at - 60_000, at);
        // The wall hears of it on its next poll; a reload is that poll, now.
        await page.reload();
        await page.waitForSelector('#wall .screen-alert .alert-ack', { timeout: 20_000 });
        expect(await page.textContent('#wall .alert-line')).toContain('The back door is open');

        const posted: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes('/d/interrupts/dismiss')) posted.push(request.postData() ?? '');
        });
        await page.click('#wall .alert-ack');
        await page.waitForFunction(() => document.querySelector('#wall .screen-alert') === null, undefined, {
          timeout: 20_000,
        });
        expect(await page.locator('#wall .canvas').count()).toBe(1);

        // What the wall sent back is the handle it was given.
        expect(posted).toHaveLength(1);
        const key = new URLSearchParams(posted[0]).get('key') ?? '';
        expect(key).toMatch(/:ha-[0-9a-f]{24}$/);
        // And the server stored it under the door, household-wide.
        const stored = app.db.prepare('SELECT key FROM interrupt_dismissals').all() as { key: string }[];
        expect(stored.map((row) => row.key)).toEqual([DOOR]);

        // Premise, then the claim: the wall had manifests with the takeover in
        // them, and not one of them named the door.
        expect(bodies.some((body) => body.includes('The back door is open'))).toBe(true);
        for (const body of bodies) expect(body).not.toContain(DOOR);
        expect(await page.content()).not.toContain(DOOR);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

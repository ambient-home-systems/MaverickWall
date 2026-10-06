/**
 * The push channel on a real paired wall (plan item M1.1).
 *
 * `push-socket.test.ts` holds the hub against a `ws` client. This is the wall a
 * household has: a real Chromium opening `/d/push` with the cookie it was
 * paired with, through the very wiring boot uses (`wirePush`), and a save in
 * the admin reaching the glass in a second or two — where without the socket it
 * waits for the minute's poll. Then the other half, which is what keeps the
 * channel from being a liability: a wall that is unpaired stops knocking.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const installations: Installation[] = [];

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function wallWithMessages(
  options: { readonly pushTickMs?: number } = {},
): Promise<{ app: Installation; link: string; screen: string }> {
  const app = await install({ push: true, ...options });
  installations.push(app);
  const link = await app.pairLink('Kitchen');
  const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
  const stamp = app.now();
  app.db.prepare('UPDATE screens SET layout_mode = ? WHERE id = ?').run('freeform', screen);
  app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ?`).run(screen);
  for (const [id, type, y] of [
    ['w-clock', 'clock', 0.05],
    ['w-messages', 'messages', 0.4],
  ] as const) {
    app.db
      .prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, ?, 'portrait', ?, 0.05, ?, 0.9, 0.3, 0, '{}', ?, ?)`,
      )
      .run(id, screen, type, y, stamp, stamp);
  }
  return { app, link, screen };
}

describe('a wall on the push channel', () => {
  it(
    'connects with its own cookie, and shows a message sent from the admin within seconds, not the minute',
    async () => {
      // The push timer at a minute, like the poll: only the write's own nudge
      // can bring the message in the seconds this allows.
      const { app, link } = await wallWithMessages({ pushTickMs: 60_000 });
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await expect.poll(() => app.pushConnections(), { timeout: 10_000 }).toBe(1);
        expect(await page.locator('#wall .ms-text').count()).toBe(0);

        const sentAt = Date.now();
        expect((await app.post('/admin/messages', { text: 'Back at 6', minutes: '60' })).status).toBe(302);
        await page.locator('#wall .ms-text', { hasText: 'Back at 6' }).waitFor({ timeout: 5_000 });
        // A poll would be up to sixty seconds, and so would the timer here; the
        // nudge is a quarter of a second's debounce, a tick, and one fetch.
        expect(Date.now() - sentAt).toBeLessThan(5_000);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );

  it(
    'stops knocking once it is unpaired',
    async () => {
      const { app, link, screen } = await wallWithMessages();
      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        let sockets = 0;
        page.on('websocket', () => {
          sockets += 1;
        });
        await expect.poll(() => app.pushConnections(), { timeout: 10_000 }).toBe(1);

        // Unpaired: the hub drops the socket on its next tick, and the wall's
        // next poll is a 401 that puts the pairing form up.
        expect((await app.post(`/admin/screens/${screen}/revoke`, {})).status).toBe(302);
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.locator('form').first().waitFor({ timeout: 15_000 });
        await expect.poll(() => app.pushConnections(), { timeout: 10_000 }).toBe(0);

        // From here, nothing: a refused wall that kept retrying would open
        // another socket every few seconds for ever.
        const settled = sockets;
        await page.waitForTimeout(6_000);
        expect(sockets).toBe(settled);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

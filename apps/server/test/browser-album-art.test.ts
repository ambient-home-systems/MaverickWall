/**
 * Album art while music plays (plan item M3.4), on a real paired wall in a
 * real Chromium, with the stand-in Home Assistant's kitchen speaker playing.
 *
 * Read off the glass: the widget naming the playing speaker draws its sleeve,
 * whole rather than cropped, from a picture that actually loaded behind the
 * wall's own token; one naming a player that is not playing says so in words.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { pictureKey } from '../src/modules/homeassistant/entities.js';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

const SLOW = 90_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await closeFakeHomeAssistants();
  await shutDownBrowser();
}, TEARDOWN);

const PLAYER = 'media_player.kitchen';
const PICTURE = '/api/media_player_proxy/media_player.kitchen?token=picture-token-that-must-not-travel';

describe('album art on a wall', () => {
  it(
    'draws the playing speaker’s sleeve whole, and says when nothing is playing',
    async () => {
      const app = await install({});
      installations.push(app);
      const ha = await fakeHomeAssistant();
      expect(
        (await app.post('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' })).status,
      ).toBe(302);
      const at = app.now();
      // The speaker as the half-minute poll leaves it: playing, its picture a key.
      app.db
        .prepare(
          `INSERT INTO ha_entity_cache
             (entity_id, state, attributes, friendly_name, unit_of_measurement, last_changed_at,
              fetched_at, watched, display_mode, label, sort_order)
           VALUES (?, 'playing', ?, 'Kitchen speaker', NULL, ?, ?, 1, 'label_value', NULL, 0)`,
        )
        .run(PLAYER, JSON.stringify({ supported_features: 1, picture_key: pictureKey(PICTURE) }), at - 60_000, at);
      const link = await app.pairLink('Kitchen');
      const screen = (app.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      app.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
      app.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      const place = (id: string, box: readonly [number, number, number, number], config: unknown): void => {
        app.db
          .prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, ?, 'portrait', 'image', ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(id, screen, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
      };
      place('w-art', [0.05, 0.05, 0.9, 0.4], { nowPlaying: PLAYER });
      place('w-quiet', [0.05, 0.55, 0.9, 0.2], { nowPlaying: 'media_player.bedroom' });

      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-art"] .fw-art', { timeout: 25_000 });
        const drawn = await page.evaluate(async () => {
          const box = document.querySelector<HTMLElement>('#wall [data-widget-id="w-art"] .fw-art');
          const style = box === null ? undefined : getComputedStyle(box);
          const url = /url\("?([^")]+)"?\)/.exec(box?.style.backgroundImage ?? '')?.[1] ?? '';
          const loaded = await new Promise<boolean>((resolve) => {
            const probe = new Image();
            probe.onload = () => resolve(probe.naturalWidth > 0);
            probe.onerror = () => resolve(false);
            probe.src = url;
          });
          return { url, size: style?.backgroundSize, loaded };
        });
        expect(drawn.url).toBe(`/d/media/${pictureKey(PICTURE)}.jpg`);
        expect(drawn.size).toBe('contain');
        expect(drawn.loaded).toBe(true);
        expect(await page.textContent('#wall [data-widget-id="w-quiet"]')).toContain('Nothing is playing.');
        // Nothing of the speaker, its picture or its token reached the wall.
        const manifest = await page.evaluate(() => fetch('/d/manifest').then((r) => r.text()));
        expect(manifest).not.toContain(PLAYER);
        expect(manifest).not.toContain('picture-token-that-must-not-travel');
        expect(manifest).not.toContain('media_player_proxy');
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

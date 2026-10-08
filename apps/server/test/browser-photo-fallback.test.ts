/**
 * A slideshow box never goes blank (plan item M3.8), on a real paired wall in
 * a real Chromium.
 *
 * Magic Frame's background goes black when its photo source is down at load.
 * Here a slideshow lives in an Image widget, and the same failure used to
 * leave the box the theme's ground — a black rectangle on a dark wall. What is
 * read off the glass:
 *
 *  - a photo the wall cannot fetch (a 404, as Immich down before this box kept
 *    a copy answers) turns its box into the bundled stand-in for the wall's
 *    tone — Dusk on Panels — whose file actually loads, with no words in it;
 *  - the rebuild fifteen seconds later draws the stand-in at once, from the
 *    wall's memory of the failure, rather than an empty box until it fails
 *    again;
 *  - an Immich source with nothing in it draws the stand-in, not "add photos";
 *  - an empty album of the household's own still asks for photos, in words.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 150_000;
const HOUR = 3_600_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

function picture(): Buffer {
  const fb = new Framebuffer(40, 30);
  for (let x = 0; x < 40; x += 3) fb.set(x, 0);
  return Buffer.from(encodePng1bit(fb));
}

describe('a slideshow box with nothing it can show', () => {
  it(
    'draws the bundled picture in place of a photo it cannot fetch and of an empty source, and still asks for photos in an empty album',
    async () => {
      const home = await install({});
      installations.push(home);
      const album = async (name: string): Promise<string> =>
        /\/admin\/photos\/([0-9a-f]{16})/.exec((await home.post('/admin/photos', { name })).headers.get('location') ?? '')?.[1] ?? '';
      const holidays = await album('Holidays');
      const garden = await album('Garden');
      const body = new FormData();
      body.append('photos', new File([new Uint8Array(picture())], 'kept.png'));
      await home.call(`/admin/photos/${holidays}/upload`, { method: 'POST', body });
      const kept = (home.db.prepare('SELECT media_name AS name FROM photo_album_items WHERE album_id = ?').get(holidays) as { name: string }).name;
      // A photo this box has no copy of, first in the album: what a wall asks
      // for when its source is down at load, and gets a 404 for.
      const missing = `${'c'.repeat(64)}.png`;
      home.db.prepare('UPDATE photo_album_items SET position = 1 WHERE album_id = ?').run(holidays);
      home.db
        .prepare('INSERT INTO photo_album_items (album_id, media_name, position, added_at) VALUES (?, ?, 0, ?)')
        .run(holidays, missing, home.now());
      // An Immich source with nothing in it.
      const at = home.now();
      home.db
        .prepare(`INSERT INTO immich_sources (id, kind, ref, name, created_at, updated_at) VALUES ('5e0a1b2c3d4e5f60', 'memories', NULL, 'Today’s memories', ?, ?)`)
        .run(at, at);

      const link = await home.pairLink('Hall');
      const screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      home.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
      home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      const place = (id: string, y: number, config: unknown): void => {
        home.db
          .prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, ?, 'portrait', 'image', 0.05, ?, 0.9, 0.28, 0, ?, ?, ?)`,
          )
          .run(id, screen, y, JSON.stringify(config), at, at);
      };
      place('w-show', 0.03, { album: holidays, slideSeconds: 3600 });
      place('w-source', 0.35, { album: '5e0a1b2c3d4e5f60' });
      place('w-garden', 0.67, { album: garden });
      // On the missing photo: the first of two, an hour each.
      if (Math.floor(home.now() / HOUR) % 2 !== 0) home.shiftClock(HOUR);

      const opened = await loadWallSettled(
        link,
        { width: 1080, height: 1920 },
        {
          /*
           * Whether the photo's own box turned into the stand-in where it stood,
           * the moment the image failed — which only the error handler does. A
           * rebuild draws the stand-in from memory as a fresh box, so seeing
           * that alone would pass with the handler doing nothing at all.
           */
          beforeLoad: (context) =>
            context.addInitScript(() => {
              const seen = window as unknown as { swappedInPlace?: boolean };
              seen.swappedInPlace = false;
              new MutationObserver((records) => {
                for (const record of records) {
                  const node = record.target as Element;
                  if (node.classList?.contains('fw-standin') === true && node.classList.contains('fw-fit-cover')) seen.swappedInPlace = true;
                }
              }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
            }),
        },
      );
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-show"] .fw-standin', { timeout: 25_000 });
        const read = (id: string): Promise<{ image: string; loaded: boolean; text: string; probes: number; standIns: number }> =>
          page.evaluate(async (which) => {
            const box = document.querySelector<HTMLElement>(`#wall [data-widget-id="${which}"]`);
            const stand = box?.querySelector<HTMLElement>('.fw-standin');
            const image = stand === null || stand === undefined ? '' : getComputedStyle(stand).backgroundImage;
            const url = /url\("?([^")]+)"?\)/.exec(image)?.[1] ?? '';
            const loaded =
              url !== '' &&
              (await new Promise<boolean>((resolve) => {
                const probe = new Image();
                probe.onload = () => resolve(probe.naturalWidth > 0);
                probe.onerror = () => resolve(false);
                probe.src = url;
              }));
            return {
              image,
              loaded,
              text: (box?.textContent ?? '').trim(),
              probes: box?.querySelectorAll('.fw-image-probe').length ?? 0,
              standIns: box?.querySelectorAll('.fw-standin').length ?? 0,
            };
          }, id);

        expect(await page.evaluate(() => (window as unknown as { swappedInPlace?: boolean }).swappedInPlace)).toBe(true);
        // The photo that would not come: the stand-in, Dusk for a dark theme, loaded, and no words.
        const shown = await read('w-show');
        expect(shown.image).toMatch(/\/assets\/wallpapers\/dusk-(1600|2880)\.[0-9a-f]+\.jpg/);
        expect(shown.loaded).toBe(true);
        expect(shown.text).toBe('');
        expect(shown.standIns).toBe(1);
        // The source with nothing in it: the same, not an instruction.
        const source = await read('w-source');
        expect(source.image).toMatch(/dusk-/);
        expect(source.loaded).toBe(true);
        expect(source.text).toBe('');
        // An album of their own with nothing in it: still asks.
        const garden = await read('w-garden');
        expect(garden.standIns).toBe(0);
        expect(garden.text).toContain('Add photos to Garden on the Photos screen.');

        // The rebuild draws the stand-in at once, from memory: no probe, and the
        // photo is not asked for again — which is what tells a remembered
        // failure from the same failure happening twice very quickly.
        const asked: string[] = [];
        page.on('request', (request) => {
          if (request.url().includes(missing)) asked.push(request.url());
        });
        await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image');
          if (node !== null) node.dataset['seen'] = '1';
        });
        await page.waitForFunction(
          () => {
            const node = document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image');
            return node !== null && node.dataset['seen'] === undefined;
          },
          undefined,
          { timeout: 25_000, polling: 50 },
        );
        const rebuilt = await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image');
          return { standIn: node?.classList.contains('fw-standin') ?? false, probes: node?.querySelectorAll('.fw-image-probe').length ?? -1 };
        });
        expect(rebuilt).toEqual({ standIn: true, probes: 0 });
        expect(asked).toEqual([]);

        // The photo this box does have still draws, over the hour, with its probe and no stand-in.
        home.shiftClock(HOUR);
        await page.waitForFunction(
          (want) =>
            document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image')?.style.backgroundImage === want,
          `url("/d/media/${kept}")`,
          { timeout: 90_000 },
        );
        const later = await read('w-show');
        expect(later.standIns).toBe(0);
        expect(later.probes).toBe(1);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

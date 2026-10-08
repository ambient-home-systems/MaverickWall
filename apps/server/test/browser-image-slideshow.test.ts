/**
 * An Image widget showing an album (plan item M5.12), on a real paired wall in
 * a real Chromium.
 *
 * Read off the glass: which photo the box draws, against what `slideshow.ts`
 * says the wall's own clock should be showing; that the next one has been
 * fetched before the swap; that the swap happens when the clock crosses the
 * interval, with no manifest in between; and that an empty album and a deleted
 * one say so in words. And off the wire: the manifest carries the album's
 * photos and never the album's id.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 150_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/**
 * The photo an in-order album shows at an instant, written out here rather
 * than imported: a server test cannot import the display bundle (see
 * CLAUDE.md on `tsconfig.test.json`), and an expectation computed by the code
 * under test would agree with it whatever it did.
 */
function inOrder(photos: readonly string[], now: number, seconds: number): { current: string; next: string } {
  const step = Math.floor(now / (seconds * 1000));
  return { current: photos[step % photos.length] ?? '', next: photos[(step + 1) % photos.length] ?? '' };
}

/** A real, decodable PNG, different for every seed. */
function picture(seed: number): Buffer {
  const fb = new Framebuffer(40 + seed, 30);
  for (let x = 0; x < fb.width; x += seed + 2) for (let y = 0; y < 30; y++) fb.set(x, y);
  return Buffer.from(encodePng1bit(fb));
}

async function albumWithPhotos(home: Installation, name: string, count: number): Promise<{ id: string; photos: string[] }> {
  const made = await home.post('/admin/photos', { name });
  const id = /\/admin\/photos\/([0-9a-f]{16})/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
  if (count > 0) {
    const body = new FormData();
    for (let i = 0; i < count; i++) body.append('photos', new File([new Uint8Array(picture(i + id.length))], `p${i}.png`));
    const sent = await home.call(`/admin/photos/${id}/upload`, { method: 'POST', body });
    expect(sent.headers.get('location')).toContain('saved=photos-added');
  }
  const photos = (home.db
    .prepare('SELECT media_name AS name FROM photo_album_items WHERE album_id = ? ORDER BY position')
    .all(id) as { name: string }[]).map((row) => row.name);
  return { id, photos };
}

describe('an Image widget showing an album', () => {
  it(
    'draws the photo the clock says, has the next one ready, and turns when the clock crosses the hour',
    async () => {
      const home = await install({});
      installations.push(home);
      const holidays = await albumWithPhotos(home, 'Holidays', 4);
      const empty = await albumWithPhotos(home, 'Garden', 0);
      const link = await home.pairLink('Hall');
      const screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      const stamp = home.now();
      home.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
      home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      const place = (id: string, box: readonly [number, number, number, number], config: unknown): void => {
        home.db
          .prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, ?, 'portrait', 'image', ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(id, screen, box[0], box[1], box[2], box[3], JSON.stringify(config), stamp, stamp);
      };
      // An hour a photo, so the measurement cannot straddle a turn by accident.
      place('w-show', [0.05, 0.05, 0.9, 0.5], { album: holidays.id, slideSeconds: 3600 });
      place('w-empty', [0.05, 0.6, 0.9, 0.15], { album: empty.id });
      place('w-gone', [0.05, 0.8, 0.9, 0.15], { album: 'abcdefabcdefabcd' });

      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-show"] .fw-image', { timeout: 25_000 });
        const read = (): Promise<{ shown: string; next: string | null; nextLoaded: boolean }> =>
          page.evaluate(() => {
            const box = document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image');
            const next = box?.querySelector<HTMLImageElement>('img.fw-image-next') ?? null;
            return {
              shown: box?.style.backgroundImage ?? '',
              next: next?.getAttribute('src') ?? null,
              nextLoaded: next !== null && next.complete && next.naturalWidth > 0,
            };
          });
        const expected = inOrder(holidays.photos, home.now(), 3600);
        const first = await read();
        expect(first.shown).toBe(`url("/d/media/${expected.current}")`);
        expect(first.next).toBe(`/d/media/${expected.next}`);
        await page.waitForFunction(
          () => {
            const next = document.querySelector<HTMLImageElement>('#wall [data-widget-id="w-show"] img.fw-image-next');
            return next !== null && next.complete && next.naturalWidth > 0;
          },
          undefined,
          { timeout: 10_000 },
        );
        // Nothing hidden takes room: the box is the picture's.
        expect(
          await page.evaluate(() => {
            const next = document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] img.fw-image-next');
            return next === null ? -1 : next.getBoundingClientRect().height;
          }),
        ).toBe(0);

        // The two others say what is wrong, in words.
        expect(await page.textContent('#wall [data-widget-id="w-empty"]')).toContain('Add photos to Garden on the Photos screen.');
        expect(await page.textContent('#wall [data-widget-id="w-gone"]')).toContain('That album is not here any more.');

        // The manifest names the photos and never an album.
        const manifest = await page.evaluate(() => fetch('/d/manifest').then((r) => r.text()));
        expect(manifest).toContain(holidays.photos[0]);
        expect(manifest).not.toContain(holidays.id);
        expect(manifest).not.toContain(empty.id);
        expect(manifest).not.toContain('"album"');

        // Over the hour. The wall learns the moved clock from its next poll's
        // `x-server-time`, and that poll's album is the same four photos, so
        // what turns the picture is the clock and not a new list.
        home.shiftClock(3_600_000);
        const later = inOrder(holidays.photos, home.now(), 3600);
        expect(later.current).toBe(expected.next);
        await page.waitForFunction(
          (want) =>
            document.querySelector<HTMLElement>('#wall [data-widget-id="w-show"] .fw-image')?.style.backgroundImage ===
            `url("/d/media/${want}")`,
          later.current,
          { timeout: 90_000 },
        );
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

describe('an album in the editor', () => {
  it(
    'is offered once an album exists, previews the album’s photo, and saves the album with its interval and order',
    async () => {
      const home = await install({});
      installations.push(home);
      const screen = await home.pairWall('Hall');
      const stamp = home.now();
      home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      home.db
        .prepare(
          `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
           VALUES ('w-pic', ?, 'portrait', 'image', 0.05, 0.05, 0.9, 0.5, 0, '{}', ?, ?)`,
        )
        .run(screen, stamp, stamp);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const editor = await context.newPage();
        await home.signIn(editor);
        const open = async (): Promise<void> => {
          await editor.goto(`${home.base}/admin/walls/${encodeURIComponent(screen)}`, { waitUntil: 'load' });
          await editor.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
          await editor.locator('.le-overlay .le-widget').first().click();
          await editor.click('.insp-tab:has-text("Content")');
        };
        // No album yet: no choice to make, and a sentence saying where to make one.
        await open();
        expect(await editor.locator('.seg button:has-text("An album")').count()).toBe(0);
        expect(await editor.textContent('.insp, body')).toContain('make an album on the Photos page');

        const holidays = await albumWithPhotos(home, 'Holidays', 3);
        await open();
        await editor.click('.seg button:has-text("An album")');
        await editor.click('.le-cfg-field:has-text("Each photo shows for") .seg button:has-text("15 minutes")');
        await editor.click('.le-cfg-field:has-text("Order") .seg button:has-text("Shuffled")');
        // Between photos (plan item M3.6), with the sentence saying when it moves.
        await editor.click('.le-cfg-field:has-text("Between photos") .seg button:has-text("Fade and zoom")');
        expect(await editor.textContent('.le-cfg-field:has-text("Between photos")')).toContain('Motion switch is on');
        // Portrait photos (plan item M3.7).
        await editor.click('.le-cfg-field:has-text("Portrait photos") .seg button:has-text("Two side by side")');
        // The preview draws one of the album's photos, from the media the admin
        // serves — the one on show, which with a crossfade is the lower layer.
        await expect
          .poll(() =>
            editor.evaluate(
              () =>
                (document.querySelector('.le-preview')?.shadowRoot?.querySelector<HTMLElement>('[data-widget-id="w-pic"] .fw-image[style*="background-image"]')?.style
                  .backgroundImage ?? ''),
            ),
          )
          .toMatch(/admin\/media\/[0-9a-f]{64}\.png/);
        const drawn = await editor.evaluate(
          () => document.querySelector('.le-preview')?.shadowRoot?.querySelector<HTMLElement>('[data-widget-id="w-pic"] .fw-image[style*="background-image"]')?.style.backgroundImage ?? '',
        );
        expect(holidays.photos.some((name) => drawn.includes(name))).toBe(true);
        await Promise.all([editor.waitForNavigation({ timeout: 20_000 }), editor.click('[data-action="save"]')]);
        const stored = home.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'w-pic'`).get() as { config: string };
        expect(JSON.parse(stored.config)).toEqual({ album: holidays.id, slideSeconds: 900, slideOrder: 'shuffle', slideMotion: 'zoom', pairPortraits: true });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

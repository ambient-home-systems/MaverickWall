/**
 * Portrait pairing (plan item M3.7), against a real Chromium.
 *
 * Two halves. **The header reader agrees with the browser that draws the
 * photo**: JPEG, WebP and PNG bytes written by Chromium's own encoders, and a
 * JPEG carrying an EXIF orientation that turns it a quarter, are measured by
 * `imageSize` and decoded by Chromium, and the two must say the same width and
 * height — the decoder is the authority, because it is what draws the photo.
 *
 * **A wall pairs, on the glass.** An album of two portraits and a landscape,
 * uploaded through the Photos screen, shows the two portraits side by side in
 * a wide box that asked for it, each in its own half; a tall box that asked
 * for it, and a wide one that did not, show one photo at a time; and over the
 * hour the wide box turns to the landscape on its own.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { imageSize } from '../src/api/image-size.js';
import { Framebuffer } from '../src/epaper/framebuffer.js';
import { encodePng1bit } from '../src/epaper/png.js';
import { TEARDOWN, browser, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 180_000;
const HOUR = 3_600_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** A picture of the given size, from Chromium's own encoder. */
async function encoded(page: Page, type: string, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ type, width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      context.fillStyle = '#c84';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#248';
      context.fillRect(0, 0, width / 3, height / 2);
      return canvas.toDataURL(type).split(',')[1] ?? '';
    },
    { type, width, height },
  );
  return Buffer.from(base64, 'base64');
}

/** The same JPEG with an EXIF block saying how to turn it, as a camera writes one. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, body, jpeg.subarray(2)]);
}

/** What Chromium decodes the bytes to, as the `<img>` a wall would draw. */
async function decoded(page: Page, bytes: Buffer, type: string): Promise<{ width: number; height: number }> {
  return page.evaluate(
    async ({ base64, type }) => {
      const image = new Image();
      image.src = `data:${type};base64,${base64}`;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    },
    { base64: bytes.toString('base64'), type },
  );
}

describe('the header reader', () => {
  it(
    'says what Chromium decodes, for a JPEG, a WebP and a PNG, and for a JPEG a camera tagged to turn',
    async () => {
      const context = await (await browser()).newContext();
      try {
        const page = await context.newPage();
        for (const [type, width, height] of [
          ['image/jpeg', 120, 300],
          ['image/webp', 301, 77],
          ['image/png', 64, 65],
        ] as const) {
          const bytes = await encoded(page, type, width, height);
          expect(await decoded(page, bytes, type)).toEqual({ width, height });
          expect(imageSize(bytes), type).toEqual({ width, height });
        }
        const jpeg = await encoded(page, 'image/jpeg', 300, 120);
        // A quarter turn (6, 8) swaps the sides; a half turn (3) and a mirror (2) do not.
        for (const orientation of [6, 8, 3, 2]) {
          const tagged = withOrientation(jpeg, orientation);
          const drawn = await decoded(page, tagged, 'image/jpeg');
          expect(drawn, `Chromium, orientation ${orientation}`).toEqual(
            orientation === 6 || orientation === 8 ? { width: 120, height: 300 } : { width: 300, height: 120 },
          );
          expect(imageSize(tagged), `orientation ${orientation}`).toEqual(drawn);
        }
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

function picture(width: number, height: number, seed: number): Buffer {
  const fb = new Framebuffer(width, height);
  for (let x = seed % 3; x < width; x += 3) fb.set(x, 0);
  return Buffer.from(encodePng1bit(fb));
}

describe('a wall pairing portraits', () => {
  it(
    'puts two portraits side by side in a wide box that asked, one at a time elsewhere, and turns to the landscape over the hour',
    async () => {
      const home = await install({});
      installations.push(home);
      const made = await home.post('/admin/photos', { name: 'Holidays' });
      const album = /\/admin\/photos\/([0-9a-f]{16})/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
      const body = new FormData();
      // In the album's order: a portrait, a landscape, a portrait.
      body.append('photos', new File([new Uint8Array(picture(30, 60, 1))], 'tall-1.png'));
      body.append('photos', new File([new Uint8Array(picture(60, 30, 2))], 'wide.png'));
      body.append('photos', new File([new Uint8Array(picture(32, 64, 3))], 'tall-2.png'));
      await home.call(`/admin/photos/${album}/upload`, { method: 'POST', body });
      const [first, landscape, second] = (home.db
        .prepare('SELECT media_name AS name FROM photo_album_items WHERE album_id = ? ORDER BY position')
        .all(album) as { name: string }[]).map((row) => row.name) as [string, string, string];
      // Measured on upload, from the bytes the household sent.
      expect(
        (home.db.prepare('SELECT handle FROM photo_shapes WHERE height > width AND measured = 1 ORDER BY handle').all() as { handle: string }[])
          .map((row) => row.handle),
      ).toEqual([first, second].sort());

      const link = await home.pairLink('Hall');
      const screen = (home.db.prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
      const at = home.now();
      home.db.prepare(`UPDATE screens SET layout_mode = 'freeform' WHERE id = ?`).run(screen);
      home.db.prepare(`DELETE FROM layout_widgets WHERE screen_id IS ? AND orientation = 'portrait'`).run(screen);
      const place = (id: string, box: readonly [number, number, number, number], config: unknown): void => {
        home.db
          .prepare(
            `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
             VALUES (?, ?, 'portrait', 'image', ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(id, screen, box[0], box[1], box[2], box[3], JSON.stringify(config), at, at);
      };
      const show = { album, slideSeconds: 3600 };
      // 972x576 on a 1080x1920 wall: wide. Crossfading, so the pair is drawn inside a layer too.
      place('w-wide', [0.05, 0.03, 0.9, 0.3], { ...show, pairPortraits: true, slideMotion: 'fade' });
      // 432x960: tall, so it shows one at a time though it asked.
      place('w-tall', [0.05, 0.36, 0.4, 0.5], { ...show, pairPortraits: true });
      // Wide, and did not ask.
      place('w-plain', [0.5, 0.36, 0.45, 0.2], show);

      // Frames, in order: the two portraits, then the landscape. Start on the pair.
      if (Math.floor(home.now() / HOUR) % 2 !== 0) home.shiftClock(HOUR);
      const step = Math.floor(home.now() / HOUR);

      const opened = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const page = opened.page;
        await page.waitForSelector('#wall [data-widget-id="w-wide"] .fw-pair', { timeout: 25_000 });
        const read = await page.evaluate(() => {
          const rect = (node: Element | null): { x: number; y: number; w: number; h: number } => {
            const r = node?.getBoundingClientRect();
            return { x: r?.x ?? 0, y: r?.y ?? 0, w: r?.width ?? 0, h: r?.height ?? 0 };
          };
          const urls = (root: Element | null): string[] =>
            [...(root?.querySelectorAll<HTMLElement>('.fw-image[style*="background-image"]') ?? [])].map((one) => one.style.backgroundImage);
          const wide = document.querySelector('#wall [data-widget-id="w-wide"]');
          const shown = wide?.querySelector('.fw-photo:not(.fw-photo-next) > .fw-pair') ?? null;
          const halves = [...(shown?.children ?? [])];
          return {
            shown: urls(shown),
            halves: halves.map(rect),
            pair: rect(shown),
            nextLayer: urls(wide?.querySelector('.fw-photo-next') ?? null),
            preload: [...(wide?.querySelectorAll<HTMLImageElement>('img.fw-image-next') ?? [])].map((one) => one.getAttribute('src')),
            tall: { pairs: document.querySelectorAll('#wall [data-widget-id="w-tall"] .fw-pair').length, shown: urls(document.querySelector('#wall [data-widget-id="w-tall"]')) },
            plain: { pairs: document.querySelectorAll('#wall [data-widget-id="w-plain"] .fw-pair').length, shown: urls(document.querySelector('#wall [data-widget-id="w-plain"]')) },
          };
        });
        const url = (name: string): string => `url("/d/media/${name}")`;
        expect(read.shown).toEqual([url(first), url(second)]);
        // Each in its own half: side by side, the box's full height, the same width.
        const [left, right] = read.halves as [{ x: number; y: number; w: number; h: number }, { x: number; y: number; w: number; h: number }];
        expect(read.halves).toHaveLength(2);
        expect(left.x).toBeCloseTo(read.pair.x, 0);
        expect(right.x + right.w).toBeCloseTo(read.pair.x + read.pair.w, 0);
        expect(right.x).toBeGreaterThan(left.x + left.w);
        expect(Math.abs(left.w - right.w)).toBeLessThan(1);
        expect(left.w).toBeGreaterThan(read.pair.w * 0.45);
        expect(left.h).toBeCloseTo(read.pair.h, 0);
        expect(right.h).toBeCloseTo(read.pair.h, 0);
        // The landscape waits on top, clear, and is fetched ahead.
        expect(read.nextLayer).toEqual([url(landscape)]);
        expect(read.preload).toEqual([`/d/media/${landscape}`]);
        // Elsewhere one at a time, the photo `slideAt` would show: three photos, so step mod 3.
        const single = [first, landscape, second][step % 3] ?? '';
        expect(read.tall).toEqual({ pairs: 0, shown: [url(single)] });
        expect(read.plain).toEqual({ pairs: 0, shown: [url(single)] });

        // Only a widget that pairs is sent the portraits.
        const manifest = await page.evaluate(() => fetch('/d/manifest').then((r) => r.json()));
        const widgets = (manifest as { layout: { portrait: { widgets: { id: string; config: Record<string, unknown> }[] } } }).layout.portrait.widgets;
        const portraitsOf = (id: string): unknown => widgets.find((one) => one.id === id)?.config['portraits'];
        expect(portraitsOf('w-wide')).toEqual([first, second]);
        expect(portraitsOf('w-tall')).toEqual([first, second]);
        expect(portraitsOf('w-plain')).toBeUndefined();

        // Over the hour, the wide box turns to the landscape, alone.
        home.shiftClock(HOUR);
        await page.waitForFunction(
          (want) => {
            const wide = document.querySelector('#wall [data-widget-id="w-wide"]');
            const shown = wide?.querySelector<HTMLElement>('.fw-photo:not(.fw-photo-next) > .fw-image');
            return shown !== null && shown !== undefined && !shown.classList.contains('fw-pair') && shown.style.backgroundImage === want;
          },
          url(landscape),
          { timeout: 90_000 },
        );
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

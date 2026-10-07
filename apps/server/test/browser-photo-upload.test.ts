/**
 * Photos made the right size in the browser before they are sent (plan item
 * M3.1, MQ2), in a real Chromium against the real app.
 *
 * Measured on what the server stored rather than on what the page said: the
 * stored JPEG's own frame header for its size, its bytes for whether the
 * phone's metadata block survived, and its hash against the file chosen for
 * whether a small picture was sent untouched. A HEIC photo, which Chromium
 * cannot draw, still reaches the server and is named there.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { createHash } from 'node:crypto';
import { TEARDOWN, browser, install, shutDownBrowser, type Installation } from './browser-harness.js';

const SLOW = 90_000;
const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** A JPEG's width and height, from its first start-of-frame marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] ?? 0;
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

/** A noisy 4000x3000 JPEG drawn by the browser, with an Exif block spliced in after SOI, as a phone's carries. */
async function phoneJpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4000;
    canvas.height = 3000;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.createImageData(4000, 3000);
    let seed = 7;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      image.data[i] = seed & 255;
      image.data[i + 1] = (seed >> 8) & 255;
      image.data[i + 2] = (seed >> 16) & 255;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  const jpeg = Buffer.from(base64, 'base64');
  // APP1 "Exif\0\0" with an empty little-endian TIFF directory and a marker
  // string standing in for the location a phone writes.
  const tiff = Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from('GPS-WHERE-THE-PHOTO-WAS-TAKEN', 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

async function albumPage(home: Installation, page: Page): Promise<string> {
  await home.signIn(page);
  const made = await home.post('/admin/photos', { name: 'Holidays' });
  const id = /\/admin\/photos\/([0-9a-f]{16})/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
  await page.goto(`${home.base}/admin/photos/${id}`, { waitUntil: 'load' });
  return id;
}

async function stored(home: Installation): Promise<{ name: string; bytes: Buffer }[]> {
  const rows = home.db.prepare('SELECT path FROM media_assets ORDER BY created_at').all() as { path: string }[];
  const out: { name: string; bytes: Buffer }[] = [];
  for (const row of rows) {
    out.push({ name: row.path, bytes: Buffer.from(await (await home.call(`/admin/media/${row.path}`)).arrayBuffer()) });
  }
  return out;
}

describe('a photo chosen in the browser', () => {
  it(
    'arrives no longer than 2560 on its long side, smaller, and without the phone’s metadata',
    async () => {
      const home = await install({});
      installations.push(home);
      const page = await (await browser()).newPage();
      await albumPage(home, page);
      // Said only where the script is running to make it true.
      expect(await page.isVisible('[data-photo-resize]')).toBe(true);

      const original = await phoneJpeg(page);
      expect(jpegSize(original)).toEqual({ width: 4000, height: 3000 });
      expect(original.includes(Buffer.from('GPS-WHERE'))).toBe(true);
      await page.setInputFiles('input[name="photos"]', { name: 'IMG_1234.JPG', mimeType: 'image/jpeg', buffer: original });
      await Promise.all([
        page.waitForURL((url) => url.search.includes('saved=photos-added'), { timeout: 30_000 }),
        page.click('form[data-photo-upload] button[type="submit"]'),
      ]);

      const [photo] = await stored(home);
      expect(photo).toBeDefined();
      expect(jpegSize(photo?.bytes ?? Buffer.alloc(0))).toEqual({ width: 2560, height: 1920 });
      expect(photo?.bytes.length).toBeLessThan(original.length);
      expect(photo?.bytes.includes(Buffer.from('GPS-WHERE'))).toBe(false);
      expect(photo?.bytes.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
      await page.close();
    },
    SLOW,
  );

  it(
    'is sent untouched when it is already small enough',
    async () => {
      const home = await install({});
      installations.push(home);
      const page = await (await browser()).newPage();
      await albumPage(home, page);
      const small = Buffer.from(
        await page.evaluate(async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          (canvas.getContext('2d') as CanvasRenderingContext2D).fillRect(10, 10, 100, 100);
          const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
          let text = '';
          for (const byte of new Uint8Array(await blob.arrayBuffer())) text += String.fromCharCode(byte);
          return btoa(text);
        }),
        'base64',
      );
      await page.setInputFiles('input[name="photos"]', { name: 'small.png', mimeType: 'image/png', buffer: small });
      await Promise.all([
        page.waitForURL((url) => url.search.includes('saved=photos-added'), { timeout: 30_000 }),
        page.click('form[data-photo-upload] button[type="submit"]'),
      ]);
      const [photo] = await stored(home);
      const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
      expect(hash(photo?.bytes ?? Buffer.alloc(0))).toBe(hash(small));
      expect(photo?.name.endsWith('.png')).toBe(true);
      await page.close();
    },
    SLOW,
  );

  it(
    'that Chromium cannot draw — a HEIC — still reaches the server, which names it',
    async () => {
      const home = await install({});
      installations.push(home);
      const page = await (await browser()).newPage();
      await albumPage(home, page);
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(256, 0)]);
      await page.setInputFiles('input[name="photos"]', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: heic });
      await Promise.all([page.waitForLoadState('load'), page.click('form[data-photo-upload] button[type="submit"]')]);
      await page.waitForSelector('text=IMG_0001.HEIC: That is a HEIC photo', { timeout: 30_000 });
      expect(await stored(home)).toEqual([]);
      await page.close();
    },
    SLOW,
  );
});

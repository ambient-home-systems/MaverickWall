/**
 * Contract 2's QR code, countdown, timeline and picture (plan item M7.5), on a
 * real paired wall.
 *
 * What only a browser shows, read off the glass rather than any class: the
 * module's code decoded from a screenshot; the countdown's words worked out
 * from the wall's own clock, going on with every manifest request refused, and
 * never larger than a clock may be; a timeline's passed items in the quiet ink
 * and its next in the event's, in columns that line up; and a picture that the
 * browser loaded from this server by its handle, with the module's address
 * nowhere on the page and no request to any other origin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import {
  TEARDOWN,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { createExternalModule } from '../src/api/external-modules.js';
import { panelDataSchema } from '../src/modules/external/panel-data.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import { decodePixels } from './qr-decode.js';

const SLOW = 240_000;
const PORTRAIT = { width: 1080, height: 1920 };
const PNG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'addon', 'maverick-wall', 'icon.png'));
const CODE = 'WIFI:T:WPA;S:Guest;P:correct-horse;;';

let wall: Installation;
let link: string;
let pictures: Server;
let pictureBase = '';
let countdownAt = 0;

const iso = (ms: number): string => new Date(ms).toISOString();

beforeAll(async () => {
  pictures = createServer((request, response) => {
    if ((request.url ?? '').startsWith('/radar.png')) {
      response.setHeader('content-type', 'image/png');
      response.end(PNG);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => pictures.listen(0, '127.0.0.1', resolve));
  const address = pictures.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  pictureBase = `http://127.0.0.1:${address.port}`;

  wall = await install({});
  const now = wall.now();
  equipHousehold(wall.db, now);
  // Ninety seconds out: "In 2 min" when the wall first draws it, and "Now"
  // within a minute after, by the wall's own clock alone.
  countdownAt = now + 90_000;
  const panels: Record<string, unknown> = {
    code: { kind: 'qr', title: 'Guest Wi-Fi', text: CODE, label: 'Guest' },
    launch: { kind: 'countdown', title: 'Launch', label: 'Falcon 9', at: iso(countdownAt) },
    day: {
      kind: 'timeline',
      title: 'Today',
      items: [
        { at: iso(now - 60 * 60_000), label: 'School run' },
        { at: iso(now + 60 * 60_000), label: 'Dentist', detail: 'Dr Smith', tone: 'alert' },
        { at: iso(now + 26 * 60 * 60_000), label: 'Bins' },
      ],
    },
    radar: { kind: 'image', title: 'Radar', url: `${pictureBase}/radar.png?t=1`, caption: 'Rain at 14:00' },
  };
  for (const [id, panel] of Object.entries(panels)) {
    panelDataSchema.parse(panel);
    createExternalModule(wall.db, { id, url: pictureBase, name: id });
    wall.db.prepare(`UPDATE external_modules SET panel = ?, last_polled_at = ? WHERE id = ?`).run(JSON.stringify(panel), now, id);
  }
  const screenId = await wall.pairWall('Kitchen');
  const classic = readLayoutWidgets(wall.db, screenId, 'portrait');
  const aspects = wall.db.prepare('SELECT layout_aspect AS p FROM screens WHERE id = ?').get(screenId) as { p: number };
  const widgets = [
    ...classic.map((row) => ({
      id: row.id,
      type: row.type,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      z: row.z,
      ...(row.config !== null && typeof row.config === 'object' && Object.keys(row.config).length > 0
        ? { config: row.config }
        : {}),
    })),
    { id: 'code-box', type: 'external', x: 0.05, y: 0.05, w: 0.4, h: 0.25, z: 100, config: { module: 'code' } },
    { id: 'launch-box', type: 'external', x: 0.5, y: 0.05, w: 0.45, h: 0.18, z: 101, config: { module: 'launch' } },
    { id: 'day-box', type: 'external', x: 0.05, y: 0.33, w: 0.6, h: 0.22, z: 102, config: { module: 'day' } },
    { id: 'radar-box', type: 'external', x: 0.5, y: 0.6, w: 0.45, h: 0.3, z: 103, config: { module: 'radar' } },
  ];
  const saved = await wall.call('/admin/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ screen: screenId, orientation: 'portrait', mode: 'freeform', aspect: aspects.p, widgets }),
  });
  expect(saved.status).toBe(200);
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  pictures?.close();
  await shutDownBrowser();
}, TEARDOWN);

const box = (id: string): string => `#wall .canvas .fw[data-widget-id="${id}"]`;

async function readCode(page: Page, selector: string): Promise<string | undefined> {
  const png = await page.locator(selector).screenshot();
  const pixels = await page.evaluate(async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(data.data), width: data.width, height: data.height };
  }, png.toString('base64'));
  return decodePixels(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
}

describe('contract 2 on the wall', () => {
  it(
    'draws a module’s code a phone reads, a countdown by the wall’s own clock, a schedule and a picture by its handle',
    async () => {
      const origins = new Set<string>();
      const opened = await loadWallSettled(link, PORTRAIT);
      const { page } = opened;
      page.on('request', (request) => origins.add(new URL(request.url()).origin));
      try {
        // The code: what a phone reads off the glass is the module's text.
        expect(await readCode(page, `${box('code-box')} .qr-code`)).toBe(CODE);
        expect(await page.locator(`${box('code-box')} .qr-words`).textContent()).toBe('Guest');

        // The countdown: its words, never larger than a clock may be.
        const count = await page.evaluate((selector) => {
          const root = document.querySelector<HTMLElement>(selector);
          const value = root?.querySelector<HTMLElement>('.gp-count-value');
          if (root === null || root === undefined || value === null || value === undefined) throw new Error('no countdown');
          const probe = document.createElement('span');
          probe.style.fontSize = 'var(--t-wall-event, var(--t-event))';
          root.appendChild(probe);
          const event = Number.parseFloat(getComputedStyle(probe).fontSize);
          probe.remove();
          const valueRect = value.getBoundingClientRect();
          const boxRect = root.getBoundingClientRect();
          return {
            words: value.textContent,
            label: root.querySelector('.gp-count-label')?.textContent,
            ratio: Number.parseFloat(getComputedStyle(value).fontSize) / event,
            inside: valueRect.left >= boxRect.left - 0.5 && valueRect.right <= boxRect.right + 0.5,
          };
        }, box('launch-box'));
        expect(count.words).toBe('In 2 min');
        expect(count.label).toBe('Falcon 9');
        expect(count.ratio).toBeLessThanOrEqual(1.8 + 1e-6);
        expect(count.ratio).toBeGreaterThan(1);
        expect(count.inside).toBe(true);

        // The timeline: passed in the quiet ink, the next in the event's and
        // bolder, the times in one column.
        const day = await page.evaluate((selector) => {
          const root = document.querySelector<HTMLElement>(selector);
          if (root === null) throw new Error('no timeline');
          const colourOf = (value: string): string => {
            const probe = document.createElement('span');
            probe.style.color = value;
            root.appendChild(probe);
            const out = getComputedStyle(probe).color;
            probe.remove();
            return out;
          };
          return {
            quiet: colourOf('var(--ink-quiet, var(--muted))'),
            event: colourOf('var(--ink-event, var(--ink))'),
            rows: Array.from(root.querySelectorAll<HTMLElement>('.gp-event')).map((row) => {
              const what = row.querySelector<HTMLElement>('.gp-what') as HTMLElement;
              const label = row.querySelector<HTMLElement>('.gp-event-label') as HTMLElement;
              return {
                when: row.querySelector('.gp-when')?.textContent ?? '',
                label: label.textContent,
                colour: getComputedStyle(what).color,
                weight: Number.parseInt(getComputedStyle(label).fontWeight, 10),
                whatLeft: Math.round(what.getBoundingClientRect().left),
                tone: row.getAttribute('data-tone'),
              };
            }),
          };
        }, box('day-box'));
        const [run, dentist, bins] = day.rows;
        expect(day.rows.map((row) => row.label)).toEqual(['School run', 'Dentist', 'Bins']);
        expect(run?.colour).toBe(day.quiet);
        expect(dentist?.colour).toBe(day.event);
        expect(bins?.colour).toBe(day.event);
        expect(day.quiet).not.toBe(day.event);
        expect(dentist?.weight).toBeGreaterThan(bins?.weight ?? 0);
        expect(dentist?.tone).toBe('alert');
        expect(run?.when).toMatch(/^\d\d:\d\d$/);
        expect(bins?.when).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
        // Toned or not, the words start in one column.
        expect(new Set(day.rows.filter((row) => row.tone === null).map((row) => row.whatLeft)).size).toBe(1);

        // The picture: loaded, from this server by its handle, and drawn whole.
        const picture = await page.evaluate(async (selector) => {
          const image = document.querySelector<HTMLImageElement>(`${selector} img.gp-img`);
          if (image === null) throw new Error('no picture');
          if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
          return {
            src: image.getAttribute('src'),
            loaded: image.naturalWidth > 0,
            fit: getComputedStyle(image).objectFit,
            caption: document.querySelector(`${selector} .gp-caption`)?.textContent,
          };
        }, box('radar-box'));
        expect(picture.src).toMatch(/^\/d\/media\/[a-f0-9]{64}\.jpg$/);
        expect(picture.loaded).toBe(true);
        expect(picture.fit).toBe('contain');
        expect(picture.caption).toBe('Rain at 14:00');
        const html = await page.content();
        expect(html).not.toContain(pictureBase);
        expect(html).not.toContain('radar.png');

        // With every manifest request refused, the countdown reaches "Now" by
        // the wall's own clock.
        await page.route('**/d/manifest**', (route) => route.abort());
        await page.waitForFunction(
          (selector) => document.querySelector(`${selector} .gp-count-value`)?.textContent === 'Now',
          box('launch-box'),
          { timeout: 90_000, polling: 1000 },
        );
        // No request to any origin but the wall's own.
        const own = new URL(link).origin;
        expect([...origins].filter((origin) => origin !== own && !origin.startsWith('data:'))).toEqual([]);
      } finally {
        await opened.close();
      }
    },
    SLOW,
  );
});

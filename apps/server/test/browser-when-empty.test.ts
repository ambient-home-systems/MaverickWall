import { inflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TEARDOWN,
  coveredFraction,
  install,
  loadWallSettled,
  measureCanvasInk,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { applyTemplate } from '../src/api/templates.js';
import { readLayoutWidgets } from '../src/api/queries.js';
import type { PlacedWidgetRow } from '../src/api/manifest.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';

/**
 * RFC 014 §5.3 — a fallback for an empty box, on a fresh wall, on the glass.
 *
 * `CLAUDE.md` calls the hole an unconfigured widget leaves in a fresh wall
 * "the bill" for retiring `auto`: `keepWidgetsWithSomethingToSay` drops a
 * Weather box with no location, and on a canvas that does not reflow the box
 * is simply empty at the size somebody dragged it to. Substitution is the
 * first half of paying it — the box draws another widget in its own
 * rectangle — and these are the measurements that say whether it does:
 *
 *  - **the wall draws the note in that box**, read off the drawn DOM rather
 *    than the manifest, since a substitution resolved correctly and then
 *    dropped on the way to the glass is the class of bug this project keeps
 *    finding;
 *  - **a panel following that wall draws ink in the same box**, decoded from
 *    the frame the device fetches, because the two renderers share the
 *    resolution and this is the assertion that they share the *answer*;
 *  - **`wall-density`'s `contentSharePercent` does not fall** against the
 *    same wall without the fallback — measured with the very helpers that file
 *    uses, so the number is the ratchet's number and not a lookalike.
 *
 * Both walls are made through the add page (`/admin/screens`), which is the
 * door `default-wall-retired.test.ts` walks first and the one that seeds a
 * canvas. The seed on a household with nothing set up carries no Weather box
 * at all — that is `classic.ts`'s whole reason to exist — so each is then given
 * the full Classic canvas, which is precisely the canvas a household has after
 * applying Classic from the gallery before setting a location: a Weather strip
 * and a Shift badge with nothing behind either.
 */

const SIZE = { width: 1080, height: 1920 } as const;
const NOTE = 'Bins out Tuesday night';

let wall: Installation;
const made: { plain?: Wall; fallback?: Wall } = {};

interface Wall {
  readonly id: string;
  readonly link: string;
  readonly portraitWeather: PlacedWidgetRow;
  readonly landscapeWeather: PlacedWidgetRow;
}

/** A wall through the add page, on the full Classic canvas, optionally with fallbacks. */
async function freshWall(name: string, fallback: boolean): Promise<Wall> {
  const link = await wall.pairLink(name);
  const { id } = wall.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string };
  applyTemplate(wall.db, id, CLASSIC_TEMPLATE);
  if (fallback) {
    // Through the editor's own save route, so the stored config is one the
    // schema accepted — not a row written behind its back.
    for (const orientation of ['portrait', 'landscape'] as const) {
      const widgets = readLayoutWidgets(wall.db, id, orientation).map((row) => {
        const own = (row.config ?? {}) as Record<string, unknown>;
        const config =
          row.type === 'weather'
            ? { ...own, whenEmpty: { type: 'notes', config: { text: NOTE } } }
            : row.type === 'shift'
              ? { ...own, whenEmpty: { type: 'clock' } }
              : row.config;
        return {
          id: row.id,
          type: row.type,
          x: row.x,
          y: row.y,
          w: row.w,
          h: row.h,
          z: row.z,
          ...(config === undefined || config === null ? {} : { config }),
        };
      });
      const saved = await wall.call('/admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: id,
          orientation,
          mode: 'freeform',
          aspect: orientation === 'portrait' ? CLASSIC_TEMPLATE.portrait.aspect : CLASSIC_TEMPLATE.landscape.aspect,
          widgets,
          background: null,
        }),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);
    }
  }
  const weatherOf = (orientation: 'portrait' | 'landscape'): PlacedWidgetRow => {
    const found = readLayoutWidgets(wall.db, id, orientation).find((row) => row.type === 'weather');
    if (found === undefined) throw new Error(`the ${orientation} Classic canvas has no Weather box`);
    return found;
  };
  return { id, link, portraitWeather: weatherOf('portrait'), landscapeWeather: weatherOf('landscape') };
}

beforeAll(async () => {
  // A wizard and one feed, and deliberately nothing else: no location, no rota.
  wall = await install({ feed: true });
  await wall.sync();
  made.plain = await freshWall('Plain kitchen', false);
  made.fallback = await freshWall('Kitchen with a note', true);
}, 120_000);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** What the wall drew in one box, and how much of its canvas carries anything. */
async function drawnWall(target: Wall): Promise<{
  readonly box: { classes: string; text: string } | undefined;
  readonly contentSharePercent: number;
}> {
  const { page, close } = await loadWallSettled(target.link, SIZE);
  try {
    const box = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`#wall .canvas [data-widget-id="${id}"]`);
      return el === null ? undefined : { classes: el.className, text: el.textContent ?? '' };
    }, target.portraitWeather.id);
    const ink = await measureCanvasInk(page);
    return { box, contentSharePercent: ink === undefined ? 0 : coveredFraction(ink) * 100 };
  } finally {
    await close();
  }
}

describe('a fallback for an empty box, on a fresh wall', () => {
  it(
    'draws the note in the Weather box, and the canvas carries no less than it did without one',
    async () => {
      const plain = await drawnWall(made.plain!);
      const withNote = await drawnWall(made.fallback!);

      // The premise: without a fallback, the box is the hole.
      expect(plain.box, 'the Weather box drew on a household with no location, so there is no hole').toBeUndefined();

      // The note, in that box — the same id, drawn by the wall as a note.
      expect(withNote.box, 'the Weather box drew nothing at all').toBeDefined();
      expect(withNote.box!.classes).toContain('fw-notes');
      expect(withNote.box!.text).toContain(NOTE);

      // The ratchet's own number, and it may not fall. It should rise, and
      // saying so is what stops this comparison passing by being equal for a
      // reason that has nothing to do with the fallback.
      expect(withNote.contentSharePercent).toBeGreaterThanOrEqual(plain.contentSharePercent);
      expect(
        withNote.contentSharePercent,
        `the hole was not filled: ${plain.contentSharePercent.toFixed(1)}% before, ${withNote.contentSharePercent.toFixed(1)}% after`,
      ).toBeGreaterThan(plain.contentSharePercent);
    },
    120_000,
  );

  it(
    'draws ink in the same box on a panel following the wall, decoded from the frame the device fetches',
    async () => {
      const frameOf = async (target: Wall, name: string): Promise<boolean[][]> => {
        const madePanel = await wall.post('/admin/epaper', { name, preset: 'seeed-7in5', rotation: '0' });
        expect(madePanel.status).toBe(303);
        const html = await (await wall.call(madePanel.headers.get('location') ?? '')).text();
        const url = /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+\.png)/.exec(html)?.[1];
        if (url === undefined) throw new Error('no frame URL on the panel page');
        const { id: panelId } = wall.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string };
        const followed = await wall.post(`/admin/epaper/${panelId}/source`, { source: `follow:${target.id}` });
        expect(followed.status).toBe(302);
        const response = await wall.call(new URL(url).pathname);
        expect(response.status).toBe(200);
        return decode(new Uint8Array(await response.arrayBuffer()));
      };

      const plain = await frameOf(made.plain!, 'Porch');
      const withNote = await frameOf(made.fallback!, 'Landing');
      const width = withNote[0]!.length;
      const height = withNote.length;
      // The Seeed 7.5" is landscape, so it draws the wall's landscape canvas.
      expect(width).toBeGreaterThan(height);

      const weather = made.fallback!.landscapeWeather;
      const inkIn = (frame: boolean[][]): number => {
        // Two pixels in from every edge, so a neighbour's frame rule on a
        // shared edge is not counted as this box's ink.
        const left = Math.round(weather.x * width) + 2;
        const top = Math.round(weather.y * height) + 2;
        const right = Math.round((weather.x + weather.w) * width) - 2;
        const bottom = Math.round((weather.y + weather.h) * height) - 2;
        let lit = 0;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (frame[y]![x]) lit++;
        return lit;
      };

      expect(inkIn(plain), 'the panel drew something in a Weather box the wall leaves out').toBe(0);
      expect(inkIn(withNote), 'the panel left the box empty where the wall draws its note').toBeGreaterThan(0);
    },
    120_000,
  );
});

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Unpack a 1-bit PNG into rows of "is this pixel black" — `epaper-month-spans`' decoder. */
function decode(png: Uint8Array): boolean[][] {
  for (let i = 0; i < SIGNATURE.length; i++) expect(png[i]).toBe(SIGNATURE[i]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
    } else if (type === 'IDAT') {
      parts.push(data.slice());
    }
    offset += 12 + length;
  }
  const merged = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    merged.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;
  const rows: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const row: boolean[] = [];
    for (let x = 0; x < width; x++) {
      const byte = raw[start + 1 + (x >> 3)]!;
      row.push(((byte >> (7 - (x & 7))) & 1) === 0);
    }
    rows.push(row);
  }
  return rows;
}

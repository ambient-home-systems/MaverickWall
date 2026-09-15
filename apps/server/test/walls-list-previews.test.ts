import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * The Walls list's previews, at the route (RFC 016 phase 2, §4, §7).
 *
 * Two mechanisms, one per kind, and both are checked here without a browser:
 *
 *  - **A browser wall's card is drawn by the gallery script from the page's
 *    own JSON**, and the JSON is held to the manifest the wall polls: the same
 *    widgets, to the byte, for the canvas the wall is hung in. That is what
 *    makes "no second renderer" a fact rather than an intention — `placeCanvas`
 *    is the manifest's own placement, exported for this one caller, so the
 *    omission and the clamps cannot drift between the picture and the glass.
 *  - **A panel's card is one `<img>`** on the frame its own page draws, and a
 *    frame is *decoded*, never eyeballed: the ink is held to the box the
 *    household posted, and a following panel's card is held byte for byte to
 *    the frame the device fetches — the case the RFC's own draft would have
 *    drawn empty, because a following panel has no rows of its own.
 *
 * The browser half — the shadow root, the fidelity against a paired wall, the
 * script blocked, the endpoint refused — is `browser-walls-previews.test.ts`
 * and `browser-template-card-fidelity.test.ts`.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const B = 'http://localhost:8080';

/**
 * Where the ink is in a 1-bit PNG, as a fraction of the frame — the same
 * decoder `epaper-admin.test.ts` reads the Arrange preview with.
 */
function inkBounds(png: Uint8Array): { x: number; y: number; w: number; h: number; pixels: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
    } else if (type === 'IDAT') idat.push(data.slice());
    offset += 12 + length;
  }
  const merged = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of idat) {
    merged.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(merged);
  const stride = (width + 7) >> 3;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < width; x++) {
      if (((raw[row + (x >> 3)]! >> (7 - (x & 7))) & 1) !== 0) continue;
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, pixels: 0 };
  return { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height, pixels };
}

interface Widget {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
  readonly config?: Record<string, unknown>;
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wallprev-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'w'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.19.0.${++nextAddress}`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(url, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (url: string, fields: Record<string, string>) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `wallprev${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  const idNamed = (name: string): string =>
    (db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;
  const bytes = async (url: string): Promise<Buffer> => {
    const response = await call(url);
    expect(response.status, url).toBe(200);
    return Buffer.from(await response.arrayBuffer());
  };
  const list = async (): Promise<string> => (await call(`${B}/admin/walls`)).text();

  /** Save one orientation's canvas for a screen, through the editor's own POST. */
  const arrange = async (
    id: string,
    orientation: 'portrait' | 'landscape',
    widgets: readonly Widget[],
    aspect = orientation === 'portrait' ? 0.5625 : 1.667,
  ): Promise<void> => {
    const saved = await call(`${B}/admin/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen: id, orientation, mode: 'freeform', aspect, widgets, background: null }),
    });
    expect(saved.status, await saved.text()).toBe(200);
  };

  /** A browser wall, its id and its pairing token. */
  const wall = async (name: string): Promise<{ id: string; token: string }> => {
    const made = await post(`${B}/admin/screens`, { name, theme: 'panels' });
    expect(made.status).toBe(303);
    const shown = await (await call(`${B}${made.headers.get('location') ?? ''}`)).text();
    const token = /\/pair\?token=([^<\s"&]+)/.exec(shown)?.[1];
    if (token === undefined) throw new Error('the pairing page printed no token');
    return { id: idNamed(name), token: decodeURIComponent(token) };
  };

  /** An e-paper panel, its id and its device frame URL. */
  const panel = async (name: string): Promise<{ id: string; frame: string }> => {
    const made = await post(`${B}/admin/epaper`, { name, preset: 'seeed-7in5', rotation: '0' });
    expect(made.status).toBe(303);
    const html = await (await call(`${B}${made.headers.get('location') ?? ''}`)).text();
    const frame = /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];
    if (frame === undefined) throw new Error('no frame URL on the panel page');
    return { id: idNamed(name), frame };
  };

  /** The `#wall-previews` JSON, parsed. */
  const previews = (html: string): { id: string; hung: string; canvas: string; aspect: number; widgets: Widget[] }[] => {
    const match = /<div id="wall-previews" data-json="([^"]*)"><\/div>/.exec(html);
    if (match === null) return [];
    const json = (match[1] as string)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return (JSON.parse(json) as { walls: { id: string; hung: string; canvas: string; aspect: number; widgets: Widget[] }[] }).walls;
  };

  /** The card for a named wall, as the list draws it. */
  const cardNamed = (html: string, name: string): string => {
    const cards = html.split('<article class="card').slice(1).map((c) => '<article class="card' + c);
    const found = cards.find((c) => c.includes(`>${name}</a>`));
    if (found === undefined) throw new Error(`no card for ${name}`);
    return found.slice(0, found.indexOf('</article>'));
  };

  const manifestOf = async (id: string): Promise<{ layout: Record<string, { aspect: number; widgets: Widget[] }> }> => {
    const response = await call(`${B}/admin/layout/preview.json?screen=${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as { layout: Record<string, { aspect: number; widgets: Widget[] }> };
  };

  return { db, call, post, idNamed, bytes, list, arrange, wall, panel, previews, cardNamed, manifestOf };
}

const clock = (id: string, x: number): Widget => ({ id, type: 'clock', x, y: 0.1, w: 0.4, h: 0.3, z: 0, config: {} });

describe('a browser wall’s card', () => {
  it('is a well the script draws into, with the wall’s own aspect, and the page carries the script', async () => {
    const h = await harness();
    const { id } = await h.wall('Kitchen');
    const html = await h.list();
    const card = h.cardNamed(html, 'Kitchen');
    // The well is the first thing in the card, at the canvas's aspect, and
    // carries nothing else: no label, no image, no second copy of the name.
    expect(card).toContain(
      `<div class="wall-preview-well"><div class="wall-preview" data-wall="${id}" style="--wall-ar:0.5625"></div></div>`,
    );
    expect(card).not.toContain('<img');
    expect(card.indexOf('wall-preview-well')).toBeLessThan(card.indexOf('wall-head'));
    // The script, once, and the mount with exactly this wall in it.
    expect(html.match(/assets\/template-gallery\.js/g)?.length).toBe(1);
    expect(html).toContain('<div id="wall-previews"');
    expect(html).not.toContain('id="template-gallery"');
    expect(h.previews(html).map((entry) => entry.id)).toEqual([id]);
    // Three across.
    expect(html).toContain('<div class="grid g3">');
    expect(html).not.toContain('<div class="grid g2">');
  });

  it('describes exactly the widgets the manifest carries — the omission applied', async () => {
    const h = await harness();
    const { id } = await h.wall('Kitchen');
    // A clock, a weather box the household has no location for — which the
    // manifest omits, and which a card built from the raw rows would draw as
    // a permanent apology where the wall shows nothing — and a note.
    await h.arrange(id, 'portrait', [
      clock('c', 0.1),
      { id: 'w', type: 'weather', x: 0.1, y: 0.5, w: 0.4, h: 0.2, z: 1, config: {} },
      { id: 'n', type: 'notes', x: 0.5, y: 0.5, w: 0.5, h: 0.5, z: 2, config: { text: 'Hello' } },
    ]);
    const [entry] = h.previews(await h.list());
    if (entry === undefined) throw new Error('no preview entry');
    const manifest = await h.manifestOf(id);
    expect(entry.canvas).toBe('portrait');
    expect(entry.widgets).toEqual(manifest.layout['portrait']?.widgets);
    expect(entry.aspect).toBe(manifest.layout['portrait']?.aspect);
    // And that comparison is not vacuous: the manifest did omit the weather.
    expect(entry.widgets.map((w) => w.type)).toEqual(['clock', 'notes']);
  });

  it('draws the canvas the wall is hung in, picked the way the wall picks it', async () => {
    const h = await harness();
    // Four walls, four ways of knowing which way up.
    const pinned = await h.wall('Pinned');
    const reported = await h.wall('Reported');
    const turned = await h.wall('Turned');
    const plain = await h.wall('Plain');
    for (const { id } of [pinned, reported, turned, plain]) {
      await h.arrange(id, 'portrait', [clock(`${id}-p`, 0.05)]);
      await h.arrange(id, 'landscape', [clock(`${id}-l`, 0.55)], 1.667);
    }
    // Pinned landscape on the wall's own settings form.
    const pin = await h.post(`${B}/admin/screens/${pinned.id}`, {
      name: 'Pinned', orientation: 'landscape', rotation: '0', theme: 'panels',
    });
    expect([302, 303]).toContain(pin.status);
    // A wall that has polled from a landscape viewport, through the real route.
    const polled = await h.call(`${B}/d/manifest?w=1920&h=1080`, {
      headers: { authorization: `Bearer ${reported.token}` },
    });
    expect(polled.status).toBe(200);
    // A wall rotated a quarter turn that has never reported a size.
    const turn = await h.post(`${B}/admin/screens/${turned.id}`, {
      name: 'Turned', orientation: 'auto', rotation: '90', theme: 'panels',
    });
    expect([302, 303]).toContain(turn.status);

    const html = await h.list();
    const byId = new Map(h.previews(html).map((entry) => [entry.id, entry]));
    const expectCanvas = (id: string, canvas: 'portrait' | 'landscape'): void => {
      const entry = byId.get(id);
      if (entry === undefined) throw new Error(`no entry for ${id}`);
      expect(entry.hung, id).toBe(canvas);
      expect(entry.canvas, id).toBe(canvas);
      expect(entry.aspect, id).toBe(canvas === 'landscape' ? 1.667 : 0.5625);
      expect(entry.widgets.map((w) => w.id), id).toEqual([`${id}-${canvas === 'landscape' ? 'l' : 'p'}`]);
      // And the well is that shape, so the card is the shape of the wall.
      expect(html).toContain(
        `<div class="wall-preview" data-wall="${id}" style="--wall-ar:${canvas === 'landscape' ? 1.667 : 0.5625}">`,
      );
    };
    expectCanvas(pinned.id, 'landscape');
    expectCanvas(reported.id, 'landscape');
    expectCanvas(turned.id, 'landscape');
    expectCanvas(plain.id, 'portrait');
  });

  it('draws the other canvas letterboxed when the hung one is empty, as the wall does', async () => {
    const h = await harness();
    const { id } = await h.wall('Sideways');
    await h.arrange(id, 'landscape', [], 1.667);
    await h.arrange(id, 'portrait', [clock('p', 0.05)]);
    const pin = await h.post(`${B}/admin/screens/${id}`, {
      name: 'Sideways', orientation: 'landscape', rotation: '0', theme: 'panels',
    });
    expect([302, 303]).toContain(pin.status);
    const [entry] = h.previews(await h.list());
    expect(entry).toMatchObject({ hung: 'landscape', canvas: 'portrait', aspect: 0.5625 });
    expect(entry?.widgets.map((w) => w.id)).toEqual(['p']);
  });
});

describe('a panel’s card', () => {
  it('is one lazy image on the frame its own page draws, and needs no script', async () => {
    const h = await harness();
    const p = await h.panel('Porch');
    const html = await h.list();
    expect(h.cardNamed(html, 'Porch')).toContain(
      `<div class="wall-preview-well"><div class="wall-preview is-ink" style="--wall-ar:800/480">` +
        `<img class="wall-ink" src="admin/epaper/${p.id}/preview.png" alt="" loading="lazy"></div></div>`,
    );
    // A household of panels alone carries no mount and no script at all.
    expect(html).not.toContain('template-gallery.js');
    expect(html).not.toContain('id="wall-previews"');
  });

  it('is decoded, not eyeballed: the ink is where the household put the box', async () => {
    const h = await harness();
    const p = await h.panel('Porch');
    const html = await h.list();
    const src = /<img class="wall-ink" src="([^"]+)"/.exec(h.cardNamed(html, 'Porch'))?.[1];
    if (src === undefined) throw new Error('the card carries no image');
    // The built-in view first: ink across the frame, header band included.
    const builtIn = inkBounds(await h.bytes(`${B}/${src}`));
    expect(builtIn.pixels).toBeGreaterThan(1000);
    expect(builtIn.y).toBeLessThan(0.05);
    // Then one box, right of centre, and the card's frame follows it.
    await h.arrange(p.id, 'landscape', [{ id: 'c', type: 'clock', x: 0.55, y: 0.1, w: 0.4, h: 0.3, z: 0, config: {} }], 800 / 480);
    const ink = inkBounds(await h.bytes(`${B}/${src}`));
    expect(ink.pixels).toBeGreaterThan(50);
    expect(ink.x).toBeGreaterThanOrEqual(0.55 - 0.01);
    expect(ink.x + ink.w).toBeLessThanOrEqual(0.95 + 0.01);
    expect(ink.y).toBeGreaterThanOrEqual(0.1 - 0.01);
    expect(ink.y + ink.h).toBeLessThanOrEqual(0.4 + 0.01);
  });

  it('following a wall, matches the frame the device fetches byte for byte, with the wall’s canvas on it', async () => {
    const h = await harness();
    const { id: wallId } = await h.wall('Kitchen');
    // The wall's landscape canvas — the one a landscape panel follows — is a
    // box on the left; its portrait one is on the right, so the two are
    // tellable apart in the ink.
    await h.arrange(wallId, 'landscape', [{ id: 'l', type: 'clock', x: 0.05, y: 0.1, w: 0.4, h: 0.3, z: 0, config: {} }], 1.667);
    await h.arrange(wallId, 'portrait', [{ id: 'p', type: 'clock', x: 0.55, y: 0.1, w: 0.4, h: 0.3, z: 0, config: {} }]);
    const p = await h.panel('Porch');
    const src = `admin/epaper/${p.id}/preview.png`;
    const builtIn = await h.bytes(`${B}/${src}`);

    const set = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });
    expect(set.status).toBe(302);
    // The card's own markup is unchanged: the picture is the same URL, and
    // what changed is what that URL answers.
    expect(h.cardNamed(await h.list(), 'Porch')).toContain(`src="${src}"`);
    const card = await h.bytes(`${B}/${src}`);
    expect(card.equals(builtIn), 'following changed nothing').toBe(false);
    expect(card.equals(await h.bytes(p.frame)), 'the card and the glass disagree').toBe(true);
    // And the ink is the wall's landscape box, not its portrait one.
    const ink = inkBounds(card);
    expect(ink.pixels).toBeGreaterThan(50);
    expect(ink.x + ink.w).toBeLessThanOrEqual(0.45 + 0.01);
  });
});

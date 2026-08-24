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
 * The eInk Displays admin page, driven through the real app.
 *
 * The point worth proving end to end: the URL the page hands the household is
 * not decoration — the token in it renders a real frame over `/d/epaper`. So
 * this creates a screen the way the sidebar does, pulls the URL out of the
 * config page, and fetches it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Where the ink is in a 1-bit PNG, as a fraction of the frame.
 *
 * "The frame changed when I moved the box" only proves the endpoint read the
 * body; it would pass just as happily if every widget drew in the top-left.
 * This project's rule for the QR encoder applies here too — verify by decoding,
 * never by looking — so the box the household dragged is checked against the
 * pixels the panel would actually turn black.
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
    const row = y * (stride + 1) + 1; // +1 skips the per-row filter byte
    for (let x = 0; x < width; x++) {
      if (((raw[row + (x >> 3)]! >> (7 - (x & 7))) & 1) !== 0) continue; // 0 is black
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 0, h: 0, pixels: 0 };
  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX + 1) / width,
    h: (maxY - minY + 1) / height,
    pixels,
  };
}
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-epadmin-'));
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
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.7.0.${++nextAddress}`,
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
    email: `epadmin${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

const B = 'http://localhost:8080';
const frameUrl = (html: string): string | undefined => /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytesOf = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer());

describe('the eInk Displays page', () => {
  it('shows the add form', async () => {
    const h = await harness();
    const html = await (await h.call(`${B}/admin/epaper`)).text();
    expect(html).toContain('Add an eInk screen');
    expect(html).toContain('Seeed 7.5'); // the preset option (the quote is HTML-escaped)
  });

  it('creates a Seeed 7.5" screen and hands over a working URL and both recipes', async () => {
    const h = await harness();
    const res = await h.post(`${B}/admin/epaper`, { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The recipes are both present, pre-filled.
    expect(html).toContain('online_image'); // ESPHome
    expect(html).toContain('opendisplay.upload_image'); // Home Assistant

    // The row is a real epaper screen with the preset's geometry.
    const row = h.db.prepare(`SELECT kind, panel_width AS w, panel_height AS h FROM screens LIMIT 1`).get() as {
      kind: string;
      w: number;
      h: number;
    };
    expect(row).toEqual({ kind: 'epaper', w: 800, h: 480 });

    // The URL it printed actually renders a frame — the whole point.
    const url = frameUrl(html);
    expect(url).toBeDefined();
    const frame = await h.call(url!);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/png');
  });

  it('accepts a custom size and rejects a silly one', async () => {
    const h = await harness();
    const ok = await h.post(`${B}/admin/epaper`, {
      name: 'Tiny',
      preset: 'custom',
      width: '296',
      height: '128',
      rotation: '90',
    });
    expect(ok.status).toBe(200);
    const row = h.db.prepare(`SELECT panel_width AS w, panel_height AS h, rotation FROM screens LIMIT 1`).get() as {
      w: number;
      h: number;
      rotation: number;
    };
    expect(row).toEqual({ w: 296, h: 128, rotation: 90 });

    const bad = await h.post(`${B}/admin/epaper`, {
      name: 'Silly',
      preset: 'custom',
      width: '5',
      height: '999999',
      rotation: '0',
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('between 64 and 2000');
  });

  it('offers a layout editor and a real 1-bit preview', async () => {
    const h = await harness();
    await h.post(`${B}/admin/epaper`, { name: 'Studio', preset: 'seeed-7in5', rotation: '0' });
    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;

    // The list card links to the designer.
    expect(await (await h.call(`${B}/admin/epaper`)).text()).toContain(`admin/epaper/${id}/design`);

    // The design page hosts the same drag-and-drop editor and the preview —
    // and the editor actually loads. The mount div alone shipped for two
    // releases while the module scripts were missing (the two-pane redesign
    // moved script emission into the display page and this page lost it), and
    // this test passed over it by matching only 'layout-editor'. The scripts
    // and the save bar the chrome binds are asserted now, not assumed.
    const design = await (await h.call(`${B}/admin/epaper/${id}/design`)).text();
    expect(design).toContain('id="layout-editor"'); // the editor mount
    expect(design).toContain('<script type="module" src="assets/display-editor.js">');
    expect(design).toContain('<script type="module" src="assets/layout-editor.js">');
    expect(design).toContain('id="savebar"');
    expect(design).toContain('data-action="save"');
    expect(design).toContain(`admin/epaper/${id}/preview.png`); // the preview img

    // The canvas the editor opens is the panel's, not the wall's. A 800x480
    // panel at rotation 0 shows landscape, and its ratio is 5:3 — the editor
    // used to open every panel on the wall's portrait 9:16 default, so boxes
    // were dragged on a shape the device cannot draw and landed elsewhere on
    // the frame. Both facts travel in the mount JSON.
    expect(design).toContain('&quot;orientation&quot;:&quot;landscape&quot;');
    expect(design).toContain('&quot;panel&quot;:{&quot;width&quot;:800,&quot;height&quot;:480}');
    expect(design).toContain(`&quot;aspect&quot;:${800 / 480}`);

    // And a stored aspect does not win. On a wall the household may set one —
    // nobody measured that television. A panel is 800x480, and a canvas saved
    // at 16:9 (as one arranged before this fix would be) must not be honoured,
    // or the boxes go back onto a shape the device cannot draw. This is the
    // assertion that bites: without the fix the page echoes the 1.7778 below.
    h.db.prepare(`UPDATE screens SET layout_landscape_aspect = 1.7778 WHERE id = ?`).run(id);
    const withStored = await (await h.call(`${B}/admin/epaper/${id}/design`)).text();
    expect(withStored).toContain(`&quot;aspect&quot;:${800 / 480}`);
    expect(withStored).not.toContain('&quot;aspect&quot;:1.7778');
    h.db.prepare(`UPDATE screens SET layout_landscape_aspect = NULL WHERE id = ?`).run(id);
    // A tag pointing at a 404 would be the same dead editor with extra steps.
    expect((await h.call(`${B}/assets/display-editor.js`)).status).toBe(200);
    expect((await h.call(`${B}/assets/layout-editor.js`)).status).toBe(200);

    // The preview renders a real PNG — the fixed layout before a canvas exists.
    const auto = await h.call(`${B}/admin/epaper/${id}/preview.png`);
    expect(auto.status).toBe(200);
    expect(auto.headers.get('content-type')).toBe('image/png');
    expect([...(await bytesOf(auto)).slice(0, 8)]).toEqual(PNG_SIGNATURE);

    // Save a canvas through the same request the editor's save bar makes —
    // the panel's own id, not the shared default.
    const saved = await h.call(`${B}/admin/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: id,
        orientation: 'landscape',
        mode: 'freeform',
        aspect: 1.667,
        widgets: [
          { id: 'cw', type: 'calendar', x: 0.05, y: 0.05, w: 0.9, h: 0.9, z: 0, config: { mode: 'month' } },
        ],
        background: null,
      }),
    });
    expect(saved.status).toBe(200);
    const row = h.db
      .prepare(`SELECT screen_id FROM layout_widgets WHERE id = 'cw'`)
      .get() as { screen_id: string } | undefined;
    expect(row?.screen_id).toBe(id);

    // And the preview now renders that canvas.
    const freeform = await h.call(`${B}/admin/epaper/${id}/preview.png`);
    expect(freeform.status).toBe(200);
    expect([...(await bytesOf(freeform)).slice(0, 8)]).toEqual(PNG_SIGNATURE);
  });

  it('reset on a panel clears its canvas and returns to the design page', async () => {
    const h = await harness();
    await h.post(`${B}/admin/epaper`, { name: 'Porch', preset: 'seeed-7in5', rotation: '0' });
    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;

    // Arrange something first, through the editor's own save request.
    await h.call(`${B}/admin/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: id, orientation: 'landscape', mode: 'freeform', aspect: 1.667,
        widgets: [{ id: 'k1', type: 'clock', x: 0.1, y: 0.1, w: 0.4, h: 0.3, z: 0 }],
        background: null,
      }),
    });
    expect(h.db.prepare(`SELECT COUNT(*) n FROM layout_widgets WHERE screen_id = ?`).get(id)).toEqual({ n: 1 });

    // Reset used to apply the wall's Classic template to the panel and dump
    // the household on the wall Displays page — where nothing about the panel
    // is visible, so it read as "did nothing". It now clears the canvas back
    // to the built-in fixed layout and returns to the panel's own designer.
    const reset = await h.call(`${B}/admin/displays/${id}/reset-layout`, { method: 'POST' });
    expect(reset.status).toBe(302);
    expect(reset.headers.get('location')).toBe(`/admin/epaper/${id}/design`);
    expect(h.db.prepare(`SELECT COUNT(*) n FROM layout_widgets WHERE screen_id = ?`).get(id)).toEqual({ n: 0 });
    const row = h.db.prepare(`SELECT layout_mode FROM screens WHERE id = ?`).get(id) as {
      layout_mode: string | null;
    };
    expect(row.layout_mode).toBeNull();

    // The fixed layout draws again.
    const fixed = await h.call(`${B}/admin/epaper/${id}/preview.png`);
    expect(fixed.status).toBe(200);
    expect([...(await bytesOf(fixed)).slice(0, 8)]).toEqual(PNG_SIGNATURE);

    // And the wall-detail URL for a panel — where the old redirect landed —
    // now forwards to the design page instead of rendering wall settings.
    const detail = await h.call(`${B}/admin/displays/${id}`, { redirect: 'manual' });
    expect(detail.status).toBe(302);
    expect(detail.headers.get('location')).toBe(`/admin/epaper/${encodeURIComponent(id)}/design`);
  });

  it('previews an unsaved canvas from what the editor posts, not what is stored', async () => {
    const h = await harness();
    await h.post(`${B}/admin/epaper`, { name: 'Study', preset: 'seeed-7in5', rotation: '0' });
    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;

    const png = async (response: Response): Promise<Uint8Array> => bytesOf(response);
    const preview = (widgets: unknown): Promise<Response> =>
      h.call(`${B}/admin/epaper/${id}/preview.png`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ widgets }),
      });

    // The arrange area draws through this: the boxes it has on screen now,
    // rendered by the panel's own renderer rather than by the wall's.
    const one = await preview([
      { id: 'w1', type: 'clock', x: 0.05, y: 0.05, w: 0.4, h: 0.3, z: 0 },
    ]);
    expect(one.status).toBe(200);
    expect(one.headers.get('content-type')).toBe('image/png');
    // Read each body once — a Response body is a stream, not a buffer.
    const oneBytes = await png(one);
    expect([...oneBytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);

    // Moving the box changes the frame — the whole point of a live preview.
    const moved = await preview([
      { id: 'w1', type: 'clock', x: 0.5, y: 0.5, w: 0.4, h: 0.3, z: 0 },
    ]);
    const movedBytes = await png(moved);
    expect([...movedBytes]).not.toEqual([...oneBytes]);

    // …and it changes in the direction it was dragged. A frame that merely
    // differs would satisfy the line above while drawing the widget anywhere;
    // this decodes the ink and holds it to the box the household posted.
    const first = inkBounds(oneBytes);
    const second = inkBounds(movedBytes);
    for (const [box, ink] of [
      [{ x: 0.05, y: 0.05, w: 0.4, h: 0.3 }, first],
      [{ x: 0.5, y: 0.5, w: 0.4, h: 0.3 }, second],
    ] as const) {
      expect(ink.pixels).toBeGreaterThan(0);
      // Inside the box, allowing a pixel of rounding at each edge.
      expect(ink.x).toBeGreaterThanOrEqual(box.x - 0.01);
      expect(ink.y).toBeGreaterThanOrEqual(box.y - 0.01);
      expect(ink.x + ink.w).toBeLessThanOrEqual(box.x + box.w + 0.01);
      expect(ink.y + ink.h).toBeLessThanOrEqual(box.y + box.h + 0.01);
    }
    // Nothing else is on the canvas, so the second frame's ink is strictly
    // lower and further right — the drag, measured rather than assumed.
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBeGreaterThan(first.y);

    // And none of it is stored: the panel's saved canvas is still empty, so
    // the saved preview is the built-in layout rather than either of those.
    expect(h.db.prepare(`SELECT COUNT(*) n FROM layout_widgets WHERE screen_id = ?`).get(id)).toEqual({ n: 0 });

    // Rule five: the same widget schema the save path uses, so a preview can
    // express nothing a save could not.
    const bad = await preview([{ id: 'w1', type: 'not-a-widget', x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 0 }]);
    expect(bad.status).toBe(400);
    const offCanvas = await preview([{ id: 'w1', type: 'clock', x: 9, y: 0.1, w: 0.5, h: 0.5, z: 0 }]);
    expect(offCanvas.status).toBe(400);

    // An id that is not a panel leaks nothing.
    const nowhere = await h.call(`${B}/admin/epaper/nope/preview.png`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ widgets: [] }),
    });
    expect(nowhere.status).toBe(404);
  });

  it('keeps e-paper panels out of the browser Displays list', async () => {
    const h = await harness();
    await h.post(`${B}/admin/epaper`, { name: 'OnlyInk', preset: 'seeed-7in5', rotation: '0' });
    expect(await (await h.call(`${B}/admin/displays`)).text()).not.toContain('OnlyInk');
    // …but it is on the eInk Displays list.
    expect(await (await h.call(`${B}/admin/epaper`)).text()).toContain('OnlyInk');
  });

  it('removing a screen drops it from the list and kills its URL', async () => {
    const h = await harness();
    const html = await (await h.post(`${B}/admin/epaper`, { name: 'Gone', preset: 'seeed-7in5', rotation: '0' })).text();
    const url = frameUrl(html)!;
    expect((await h.call(url)).status).toBe(200);

    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;
    await h.post(`${B}/admin/epaper/${id}/revoke`, {});

    expect((await h.call(url)).status).toBe(404); // token no longer resolves
    expect(await (await h.call(`${B}/admin/epaper`)).text()).not.toContain('Gone');
  });

  /*
   * A read must not perform a write (RFC 009, 1.8).
   *
   * "Show URL & recipes" used to POST straight to `/regenerate`, so looking at
   * a panel's recipes minted a fresh token and invalidated the one already
   * flashed into the household's ESP32. The fix is a GET the list links to
   * instead — this proves that GET exists, is idempotent, and does not
   * disturb the token a device is already using.
   */
  it('looking at a screen never rotates its token', async () => {
    const h = await harness();
    const created = await (
      await h.post(`${B}/admin/epaper`, { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' })
    ).text();
    const url = frameUrl(created)!;
    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;

    // The list no longer offers a form that POSTs straight to /regenerate —
    // it is a plain link to the read-only page.
    const list = await (await h.call(`${B}/admin/epaper`)).text();
    expect(list).not.toContain(`action="admin/epaper/${id}/regenerate"`);
    expect(list).toContain(`href="admin/epaper/${id}"`);

    // Visiting it — twice, since a GET has to be safe to repeat — leaves the
    // original URL working and shows no token of its own.
    for (let i = 0; i < 2; i++) {
      const view = await h.call(`${B}/admin/epaper/${id}`);
      expect(view.status).toBe(200);
      const html = await view.text();
      expect(frameUrl(html)).toBeUndefined();
      expect(html).toContain('shown only once');
    }

    const stillWorks = await h.call(url);
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.headers.get('content-type')).toBe('image/png');
  });

  it('still offers regeneration from the read-only page, behind its own confirmation', async () => {
    const h = await harness();
    const created = await (
      await h.post(`${B}/admin/epaper`, { name: 'Hallway', preset: 'seeed-7in5', rotation: '0' })
    ).text();
    const originalUrl = frameUrl(created)!;
    const id = (h.db.prepare(`SELECT id FROM screens LIMIT 1`).get() as { id: string }).id;

    const view = await (await h.call(`${B}/admin/epaper/${id}`)).text();
    expect(view).toContain(`action="admin/epaper/${id}/regenerate"`);
    expect(view).toContain('onsubmit=');
    expect(view).toContain('confirm(');
    expect(view).toContain('re-flashing');

    const regenerated = await (await h.post(`${B}/admin/epaper/${id}/regenerate`, {})).text();
    const newUrl = frameUrl(regenerated)!;
    expect(newUrl).not.toBe(originalUrl);
    expect((await h.call(originalUrl)).status).toBe(404);
    expect((await h.call(newUrl)).status).toBe(200);
  });
});

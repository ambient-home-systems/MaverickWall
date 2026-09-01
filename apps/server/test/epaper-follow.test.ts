import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { panelCanvasOwner } from '../src/api/queries.js';

/**
 * A panel that follows a wall (RFC 005, direction B), driven through the real app.
 *
 * Following is the state the ink lane needed to exist. Copying a wall's canvas
 * onto a panel was always possible and gives *two* canvases that drift apart
 * the first time somebody moves a box; following gives one canvas on two media,
 * and each widget's `ink` override is how that one canvas says something
 * different in black and white.
 *
 * The assertions worth having are the ones a reading of the source cannot
 * settle: that the frame on the glass actually changes when the *wall* is
 * rearranged, that the design page stops offering an editor that would silently
 * un-follow it, and that a wall's editor grows the lane exactly when a panel is
 * looking at it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-epfollow-'));
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
    auth: { secret: 'f'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.9.0.${++nextAddress}`,
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
    email: `epfollow${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

const B = 'http://localhost:8080';
const frameUrl = (html: string): string | undefined =>
  /(https?:\/\/[^"<\s]*\/d\/epaper\/[^"<\s]+)/.exec(html)?.[1];

/** Save one canvas the way the editor does — for a wall, or the Default. */
async function saveCanvas(
  h: { call: (url: string, init?: RequestInit) => Promise<Response> },
  screen: string | null,
  widgets: readonly Record<string, unknown>[],
): Promise<void> {
  const response = await h.call(`${B}/admin/layout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      screen,
      orientation: 'landscape',
      mode: 'freeform',
      aspect: 1.667,
      widgets,
      background: null,
    }),
  });
  expect(response.status).toBe(200);
}

const clock = (id: string, x: number, config?: Record<string, unknown>): Record<string, unknown> => ({
  id,
  type: 'clock',
  x,
  y: 0.1,
  w: 0.4,
  h: 0.3,
  z: 0,
  ...(config === undefined ? {} : { config }),
});

/** Create an e-paper panel and answer with its id and its frame URL. */
async function panel(h: Awaited<ReturnType<typeof harness>>, name: string) {
  const html = await (
    await h.post(`${B}/admin/epaper`, { name, preset: 'seeed-7in5', rotation: '0' })
  ).text();
  const id = (
    h.db.prepare(`SELECT id FROM screens WHERE name = ? LIMIT 1`).get(name) as { id: string }
  ).id;
  const url = frameUrl(html);
  expect(url).toBeDefined();
  return { id, url: url as string };
}

const etagOf = async (h: Awaited<ReturnType<typeof harness>>, url: string): Promise<string> => {
  const response = await h.call(url);
  expect(response.status).toBe(200);
  return response.headers.get('etag') ?? '';
};

describe('choosing what a panel draws', () => {
  it('resolves the three states, and nothing else', () => {
    // The resolver in isolation: `undefined` is the built-in layout, and is
    // deliberately different from `null`, which is the Default display's canvas.
    expect(panelCanvasOwner({ id: 'p', layoutMode: null, layoutFollows: null })).toBeUndefined();
    expect(panelCanvasOwner({ id: 'p', layoutMode: 'auto', layoutFollows: null })).toBeUndefined();
    expect(panelCanvasOwner({ id: 'p', layoutMode: 'freeform', layoutFollows: null })).toBe('p');
    expect(panelCanvasOwner({ id: 'p', layoutMode: 'follow', layoutFollows: null })).toBeNull();
    expect(panelCanvasOwner({ id: 'p', layoutMode: 'follow', layoutFollows: 'wall1' })).toBe('wall1');
    // A stale `layout_follows` under a mode that is not `follow` is ignored
    // rather than half-honoured.
    expect(panelCanvasOwner({ id: 'p', layoutMode: 'freeform', layoutFollows: 'wall1' })).toBe('p');
  });

  it('draws the wall’s canvas, and follows it as the wall changes', async () => {
    const h = await harness();
    const wall = await (await h.post(`${B}/admin/screens`, { name: 'Kitchen' })).text();
    expect(wall).toContain('Kitchen');
    const wallId = (
      h.db.prepare(`SELECT id FROM screens WHERE name = 'Kitchen'`).get() as { id: string }
    ).id;
    await saveCanvas(h, wallId, [clock('k1', 0.05)]);

    const p = await panel(h, 'Porch');
    const builtIn = await etagOf(h, p.url);

    // Follow it: the frame must change, because the panel is now drawing the
    // wall's one clock rather than the built-in agenda-and-month layout.
    const set = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });
    expect(set.status).toBe(302);
    const followed = await etagOf(h, p.url);
    expect(followed).not.toBe(builtIn);

    /*
     * The claim that makes following worth having: move a box on the wall and
     * the panel moves with it. A copy would answer with the same frame here.
     */
    await saveCanvas(h, wallId, [clock('k1', 0.55)]);
    expect(await etagOf(h, p.url)).not.toBe(followed);
  });

  it('draws the Default display’s canvas when told to follow it', async () => {
    const h = await harness();
    await saveCanvas(h, null, [clock('d1', 0.05)]);
    const p = await panel(h, 'Landing');
    const builtIn = await etagOf(h, p.url);
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'follow:default' });
    expect(await etagOf(h, p.url)).not.toBe(builtIn);

    const row = h.db
      .prepare(`SELECT layout_mode AS mode, layout_follows AS follows FROM screens WHERE id = ?`)
      .get(p.id) as { mode: string | null; follows: string | null };
    expect(row).toEqual({ mode: 'follow', follows: null });
  });

  it('refuses to follow a display that is not there, and changes nothing', async () => {
    const h = await harness();
    const p = await panel(h, 'Shed');
    const before = await etagOf(h, p.url);
    const bad = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'follow:nosuchwall' });
    expect(bad.status).toBe(400);
    expect(await etagOf(h, p.url)).toBe(before);
    const row = h.db.prepare(`SELECT layout_mode AS mode FROM screens WHERE id = ?`).get(p.id) as {
      mode: string | null;
    };
    expect(row.mode).toBeNull();
  });

  it('cannot be told to follow itself, and says that rather than blaming a wall', async () => {
    const h = await harness();
    const p = await panel(h, 'Ouroboros');
    const bad = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${p.id}` });
    expect(bad.status).toBe(400);

    const html = await bad.text();
    expect(html).toContain('A panel cannot follow itself');
    /*
     * The assertion that matters. Both refusals used to share one `find`, so
     * this case answered "That wall is no longer there." — false about the one
     * screen the household is looking at, and it would send them hunting for a
     * wall that is perfectly fine. A status code cannot tell the two apart.
     */
    expect(html).not.toContain('That wall is no longer there.');
    expect(html).toContain('Ouroboros — layout');

    // Still a refusal, not a write.
    const row = h.db.prepare(`SELECT layout_mode AS mode FROM screens WHERE id = ?`).get(p.id) as {
      mode: string | null;
    };
    expect(row.mode).toBeNull();
  });

  /*
   * What a refused "Use this" actually puts on the screen.
   *
   * Both of these shipped, and both are the same failure the confirmation
   * strip exists to end, running the other way: a household presses a button
   * and the page that comes back is indistinguishable from the one a *working*
   * press produces. The status code was right in one case and never reached a
   * reader; the other answered the wrong page entirely. So these assert what
   * is drawn, not what was returned — the select's stored value is the thing
   * that made a silent refusal look like a save.
   */
  const DESIGN_ONLY = 'Layout'; // the source form's own field label
  const ADD_PANEL_ONLY = 'Add an e-paper wall'; // the page that used to answer

  it('says why it refused a source it cannot read, on the page that asked', async () => {
    const h = await harness();
    const p = await panel(h, 'Pantry');
    const bad = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'not-a-source' });

    // A bare 302 was the bug: the design page then re-drew the stored value
    // with nothing on it, which is what a save that worked looks like.
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toContain('Choose what this panel draws.');
    expect(html).toContain(DESIGN_ONLY);
    expect(html).not.toContain(ADD_PANEL_ONLY);

    // And it is a refusal, not a write.
    const row = h.db.prepare(`SELECT layout_mode AS mode FROM screens WHERE id = ?`).get(p.id) as {
      mode: string | null;
    };
    expect(row.mode).toBeNull();
  });

  it('refuses a wall that is gone on the panel page, not on the add-a-panel form', async () => {
    const h = await harness();
    const p = await panel(h, 'Larder');
    const bad = await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'follow:nosuchwall' });

    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toContain('That wall is no longer there.');
    // The screen the household was standing on. Answering with the
    // add-an-e-paper-wall form threw away where they were and offered them a
    // second panel for an error about the first.
    expect(html).toContain('Larder — layout');
    expect(html).toContain(DESIGN_ONLY);
    expect(html).not.toContain(ADD_PANEL_ONLY);
  });

  it('goes back to its own canvas, and to the built-in one', async () => {
    const h = await harness();
    const p = await panel(h, 'Hall');
    await saveCanvas(h, p.id, [clock('h1', 0.05)]);
    const own = await etagOf(h, p.url);

    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'builtin' });
    const builtIn = await etagOf(h, p.url);
    expect(builtIn).not.toBe(own);

    /*
     * And the panel's own arrangement is still there. Starting to follow must
     * not cost a household the canvas they built — an experiment that deletes
     * your work is one nobody runs twice.
     */
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'own' });
    expect(await etagOf(h, p.url)).toBe(own);
  });

  it('stops following when the panel is reset', async () => {
    // Reset means "back to the built-in layout". A reset that left the follow
    // in place would answer with the wall's canvas and read as having done
    // nothing.
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Study' });
    const wallId = (
      h.db.prepare(`SELECT id FROM screens WHERE name = 'Study'`).get() as { id: string }
    ).id;
    await saveCanvas(h, wallId, [clock('s1', 0.05)]);
    const p = await panel(h, 'Nook');
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });

    await h.call(`${B}/admin/displays/${p.id}/reset-layout`, { method: 'POST' });
    const row = h.db
      .prepare(`SELECT layout_mode AS mode, layout_follows AS follows FROM screens WHERE id = ?`)
      .get(p.id) as { mode: string | null; follows: string | null };
    expect(row).toEqual({ mode: null, follows: null });
  });
});

describe('the panel’s design page while it follows', () => {
  it('says where to arrange it, and does not offer a second place to', async () => {
    const h = await harness();
    const wallId = (
      (await h.post(`${B}/admin/screens`, { name: 'Kitchen' }),
      h.db.prepare(`SELECT id FROM screens WHERE name = 'Kitchen'`).get() as { id: string })
    ).id;
    const p = await panel(h, 'Porch');

    const own = await (await h.call(`${B}/admin/epaper/${p.id}/design`)).text();
    expect(own).toContain('layout-editor');

    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });
    const following = await (await h.call(`${B}/admin/epaper/${p.id}/design`)).text();
    expect(following).toContain('This panel follows');
    expect(following).toContain('Kitchen');
    /*
     * The editor saves under the screen it was opened for and flips that screen
     * to `freeform`, so arranging here would silently stop the panel following
     * the wall it was told to follow. It is not mounted at all.
     */
    expect(following).not.toContain('layout-editor');
    // The preview still is: what it draws is the whole question on this page.
    expect(following).toContain('preview.png');
  });

  it('offers the choice with the current one selected', async () => {
    const h = await harness();
    const p = await panel(h, 'Porch');
    const html = await (await h.call(`${B}/admin/epaper/${p.id}/design`)).text();
    expect(html).toContain('What this panel draws');
    expect(html).toContain('value="builtin" selected');
    expect(html).toContain('value="follow:default"');
  });
});

describe('the ink lane in a wall’s editor', () => {
  it('appears exactly when a panel is looking at that canvas', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Kitchen' });
    const wallId = (
      h.db.prepare(`SELECT id FROM screens WHERE name = 'Kitchen'`).get() as { id: string }
    ).id;

    // No panel following: no lane, and not one control that would do nothing.
    expect(await (await h.call(`${B}/admin/walls/${wallId}`)).text()).not.toContain('&quot;ink&quot;');

    const p = await panel(h, 'Porch');
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });

    const withPanel = await (await h.call(`${B}/admin/walls/${wallId}`)).text();
    expect(withPanel).toContain('&quot;ink&quot;');
    // The tables travel with it: what the lane offers, and what a panel cannot
    // draw at all.
    expect(withPanel).toContain('Porch');
    expect(withPanel).toContain('clockFormat');
    expect(withPanel).toContain('Drop shadow');

    // And it is on the canvas the panel actually follows, not on every wall.
    expect(await (await h.call(`${B}/admin/walls/default`)).text()).not.toContain('&quot;ink&quot;');
  });

  it('follows the Default display’s editor when that is what is followed', async () => {
    const h = await harness();
    const p = await panel(h, 'Porch');
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: 'follow:default' });
    expect(await (await h.call(`${B}/admin/walls/default`)).text()).toContain('&quot;ink&quot;');
  });
});

describe('an ink override, from the editor to the glass', () => {
  it('changes the panel and leaves the wall alone', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Kitchen' });
    const wallId = (
      h.db.prepare(`SELECT id FROM screens WHERE name = 'Kitchen'`).get() as { id: string }
    ).id;
    const p = await panel(h, 'Porch');
    await h.post(`${B}/admin/epaper/${p.id}/source`, { source: `follow:${wallId}` });

    await saveCanvas(h, wallId, [clock('k1', 0.05, { clockFormat: '24', showDate: true })]);
    const before = await etagOf(h, p.url);

    // The same canvas, with one thing said differently in black and white.
    await saveCanvas(h, wallId, [
      clock('k1', 0.05, { clockFormat: '24', showDate: true, ink: { showDate: false } }),
    ]);
    expect(await etagOf(h, p.url)).not.toBe(before);

    /*
     * And the wall's own settings are untouched — the override is stored beside
     * them, not instead of them. A household who tunes a panel and finds their
     * kitchen wall has changed has lost trust in both screens.
     */
    const stored = JSON.parse(
      (h.db.prepare(`SELECT config FROM layout_widgets WHERE id = 'k1'`).get() as { config: string })
        .config,
    ) as Record<string, unknown>;
    expect(stored['clockFormat']).toBe('24');
    expect(stored['showDate']).toBe(true);
    expect(stored['ink']).toEqual({ showDate: false });
  });

  it('is refused at the boundary when it says something the lane cannot', async () => {
    // Rule five, one level down: a 400, never a silently dropped key.
    const h = await harness();
    const bad = await h.call(`${B}/admin/layout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: null,
        orientation: 'landscape',
        mode: 'freeform',
        aspect: 1.667,
        widgets: [clock('b1', 0.05, { ink: { background: '#ff0000' } })],
        background: null,
      }),
    });
    expect(bad.status).toBe(400);
  });
});

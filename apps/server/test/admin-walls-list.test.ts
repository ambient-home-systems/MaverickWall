import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * The Walls list is one list, and the sidebar is grouped by subject.
 *
 * Both were reviewed on a real screen and found otherwise. The Walls list drew
 * three card shapes — the Default wall as a link, a browser wall as a link with
 * a status dot, an e-paper panel as a static `<article>` with a ⋮ and an
 * "Arrange layout" button — because a panel had no page to open, so its card
 * had to be the page. And the sidebar put the Store, and every installed
 * module, under "Walls"; Overview under "Content"; and "System" as a group of
 * one item called System, with the group's label repeated over every page as
 * a kicker that read as a breadcrumb ("Walls / Walls").
 *
 * These walk the markup a household receives rather than the builders, the way
 * `admin-button-anatomy.test.ts` does, because the fault both times was in what
 * the page composed, not in any one piece.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A fresh client address per harness: the auth rate limiter's counters are
// module-global and outlive an app, so a shared address 429s a later harness.
let clientNumber = 0;
const nextClientAddress = (): string => `10.23.23.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wallslist-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = nextClientAddress();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  const text = async (path: string): Promise<string> => (await call(path)).text();
  const screenId = (kind: string): string =>
    (db.prepare(`SELECT id FROM screens WHERE kind = ? AND revoked_at IS NULL`).get(kind) as { id: string }).id;
  return { db, call, form, text, screenId };
}

/** Every `<div class="nav-group">…</div>` as its heading and its item labels. */
function navGroups(html: string): { label: string | null; items: string[] }[] {
  const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));
  return [...nav.matchAll(/<div class="nav-group">([\s\S]*?)<\/div>/g)].map((m) => {
    const body = m[1] ?? '';
    const heading = body.match(/^<span>([^<]*)<\/span>/);
    return {
      label: heading === null ? null : heading[1]!,
      items: [...body.matchAll(/<span class="nav-name">([^<]*)<\/span>/g)].map((i) => i[1]!),
    };
  });
}

describe('the Walls list is one card shape for every kind of wall', () => {
  it('draws the Default wall, a browser wall and an e-paper panel as the same link card', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet' });
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const html = await h.text('/admin/walls');
    const start = html.indexOf('<div class="grid g2">');
    const grid = html.slice(start, html.indexOf('<section class="mw-sect"', start));

    // Three walls, three link cards, and nothing else in the grid: no static
    // <article>, no ⋮ menu, no button — the panel's actions live on its page.
    expect(grid.match(/<a class="card wall-card"/g)?.length).toBe(3);
    expect(grid).not.toContain('<article');
    expect(grid).not.toContain('class="ovf');
    expect(grid).not.toContain('<button');
    expect(grid).not.toContain('Arrange layout');
    // Every card opens its wall's own page — a panel's is its layout page.
    expect(grid).toContain(`href="admin/walls/default"`);
    expect(grid).toContain(`href="admin/walls/${h.screenId('browser')}"`);
    expect(grid).toContain(`href="admin/epaper/${h.screenId('epaper')}/design"`);
    // And every card says "Open" the same way.
    expect(grid.match(/class="card-go">Open/g)?.length).toBe(3);
    // Both paired kinds carry a kind tag and a "Last seen" line; the Default
    // wall, which is not a device, carries neither.
    expect(grid).toContain('<span class="tag">Browser</span>');
    expect(grid).toContain('<span class="tag">E-paper</span>');
    expect(grid.match(/Last seen never/g)?.length).toBe(2);
    expect(grid).toContain('800×480');
  });

  it("gives an e-paper panel a page of its own, which carries what the card used to", async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    // The canonical wall route still lands a panel on the same page.
    const opened = await h.call(`/admin/walls/${id}`);
    expect(opened.status).toBe(302);
    expect(opened.headers.get('location')).toBe(`/admin/epaper/${id}/design`);

    const page = await h.text(`/admin/epaper/${id}/design`);
    // The way back, in the app bar, as the browser wall's page has it.
    expect(page).toContain('class="crumb crumb-back" href="admin/walls"');
    // The ⋮ the list card used to carry: the recipes, and a confirmed Remove.
    expect(page).toContain(`href="admin/epaper/${id}"`);
    expect(page).toContain(`action="admin/epaper/${id}/delete"`);
    expect(page).toContain('Never connected');
    // And the recipes page is nested under the panel, not floating.
    const recipes = await h.text(`/admin/epaper/${id}`);
    expect(recipes).toContain(`class="crumb crumb-back" href="admin/walls/${id}"`);
  });

  it("shapes a panel's page like a browser wall's: two tabs, one frame, the inspector beside the canvas", async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    const page = await h.text(`/admin/epaper/${id}/design`);
    // Headed by the panel, as a wall's page is headed by the wall.
    expect(page).toContain('<h1>Hall panel</h1>');
    // The same mode bar: Layout and the panel's own settings, wired by the
    // same chrome the browser wall's page loads.
    expect(page).toContain('data-mode="layout"');
    expect(page).toContain('data-mode="settings"');
    expect(page).toContain('Panel settings');
    expect(page).toContain('data-mode-panel="settings"');
    // One frame: the editor's backdrop. No second copy in a Preview section.
    expect(page).toContain('id="layout-editor"');
    expect(page).not.toContain('id="ep-preview"');
    expect(page).not.toContain('<h2>Preview</h2>');
    // The inspector is the same host the wall gives the editor, beside the
    // canvas, not a card under it.
    expect(page).toContain('<aside class="lay-inspector" id="wall-inspector"');
    // The panel's settings are on the page: what it draws, its network
    // switch (which used to live on the recipes page), and the way to those.
    expect(page).toContain('name="source"');
    expect(page).toContain('name="lan_only"');
    expect(page).toContain(`href="admin/epaper/${id}"`);
    // The recipes page no longer carries the switch: one control per setting.
    expect(await h.text(`/admin/epaper/${id}`)).not.toContain('name="lan_only"');
  });

  it('gives a following panel the preview and the settings, and no editor to fork the wall with', async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    await h.form(`/admin/epaper/${id}/source`, { source: 'follow:default' });
    const page = await h.text(`/admin/epaper/${id}/design`);
    expect(page).toContain('id="ep-preview"');
    expect(page).not.toContain('id="layout-editor"');
    expect(page).not.toContain('id="savebar"');
    // No tabs without the chrome to drive them: both parts are on the page.
    expect(page).not.toContain('data-mode="settings"');
    expect(page).toContain('name="source"');
    expect(page).toContain('name="lan_only"');
  });
});

describe('the sidebar is grouped by subject', () => {
  it('puts Overview and System alone, and the Store with the integrations', async () => {
    const h = await harness();
    // An installed module has to land beside Weather and Home Assistant, not
    // under Walls, which is where it used to appear.
    await h.form('/admin/modules/install/outside-temperature', { name: 'Outside temperature' });
    const groups = navGroups(await h.text('/admin/calendars'));
    expect(groups).toEqual([
      { label: null, items: ['Overview'] },
      { label: 'Household', items: ['Calendars', 'People', 'Work Schedule', 'Chores'] },
      { label: 'Integrations', items: ['Weather', 'Home Assistant', 'Outside temperature', 'Store'] },
      { label: 'Walls', items: ['Walls', 'Themes'] },
      { label: null, items: ['System'] },
    ]);
  });

  it('never labels a group with the name of its only item', async () => {
    const h = await harness();
    for (const group of navGroups(await h.text('/admin'))) {
      if (group.items.length === 1) expect(group.label).toBeNull();
    }
  });

  it('draws no kicker over a top-level page, and keeps the back link on a nested one', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet' });
    for (const path of ['/admin', '/admin/walls', '/admin/modules', '/admin/system']) {
      const html = await h.text(path);
      // The bar used to print the nav group's label here — "Walls" over the
      // Walls page, "Content" over the Overview — which read as a breadcrumb.
      expect(html, path).not.toContain('<div class="crumb">');
      expect(html, path).not.toContain('crumb-back');
    }
    const wall = await h.text(`/admin/walls/${h.screenId('browser')}`);
    expect(wall).toContain('class="crumb crumb-back" href="admin/walls"');
  });
});

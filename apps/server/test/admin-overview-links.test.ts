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
 * P1.4: "Edit what shows" and "Arrange layout" on the Overview's "Today on
 * the wall" card used to point at `admin/walls/default` — the shared
 * household row RFC 015 phase 2 retired. That path is now only a redirect
 * to System, so both buttons landed a household on a settings page with
 * nothing to do with what draws on their wall.
 *
 * With no wall paired, or more than one, there is no single wall either
 * button can mean, so both go to the walls list instead. With exactly one —
 * a browser wall or an e-paper panel — there is an unambiguous "the wall",
 * and both jump straight to it: its own page, and its layout (the Layout tab
 * for a browser wall, the design page for a panel, the same split
 * `layoutUrl` already makes for the Walls section's own redirects).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.24.24.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-overview-links-'));
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
    auth: { secret: 'q'.repeat(32), baseUrl: 'http://localhost' },
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

  const overview = async (): Promise<string> => (await call('/admin')).text();
  const screenId = (kind: string): string =>
    (db.prepare(`SELECT id FROM screens WHERE kind = ? AND revoked_at IS NULL`).get(kind) as {
      id: string;
    }).id;
  return { call, form, overview, screenId };
}

/** The two "Today on the wall" card-foot buttons, by their label. */
function cardFootHrefs(html: string): { editWhatShows: string; arrangeLayout: string } {
  const edit = html.match(/<a class="btn btn-ghost btn-sm" href="([^"]*)">Edit what shows<\/a>/);
  const arrange = html.match(/<a class="btn btn-ghost btn-sm" href="([^"]*)">Arrange layout<\/a>/);
  expect(edit, 'no "Edit what shows" button found').not.toBeNull();
  expect(arrange, 'no "Arrange layout" button found').not.toBeNull();
  return { editWhatShows: edit![1] as string, arrangeLayout: arrange![1] as string };
}

/** Follow a relative href the way a browser resolves it against `<base href="/">`. */
const resolve = (href: string): string => `/${href.split('#')[0]}`;

describe('the Overview’s "Today on the wall" buttons', () => {
  it('point at the walls list with no wall paired', async () => {
    const h = await harness();
    const { editWhatShows, arrangeLayout } = cardFootHrefs(await h.overview());
    expect(editWhatShows).toBe('admin/walls');
    expect(arrangeLayout).toBe('admin/walls');
    expect((await h.call(resolve(editWhatShows))).status).toBe(200);
  });

  it('point at the walls list with two walls paired', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    await h.form('/admin/screens', { name: 'Hall tablet', theme: 'panels' });
    const { editWhatShows, arrangeLayout } = cardFootHrefs(await h.overview());
    expect(editWhatShows).toBe('admin/walls');
    expect(arrangeLayout).toBe('admin/walls');
  });

  it('jump straight to the one browser wall and its Layout tab', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    const id = h.screenId('browser');
    const { editWhatShows, arrangeLayout } = cardFootHrefs(await h.overview());
    expect(editWhatShows).toBe(`admin/walls/${id}`);
    expect(arrangeLayout).toBe(`admin/walls/${id}#layout`);
    expect((await h.call(resolve(editWhatShows))).status).toBe(200);
    expect((await h.call(resolve(arrangeLayout))).status).toBe(200);
  });

  it('jump straight to the one e-paper panel and its design page', async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    const { editWhatShows, arrangeLayout } = cardFootHrefs(await h.overview());
    expect(editWhatShows).toBe(`admin/epaper/${id}`);
    expect(arrangeLayout).toBe(`admin/epaper/${id}/design`);
    expect((await h.call(resolve(editWhatShows))).status).toBe(200);
    expect((await h.call(resolve(arrangeLayout))).status).toBe(200);
  });

  it('never resolves to admin/walls/default, which is only a redirect', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    const html = await h.overview();
    expect(html).not.toContain('href="admin/walls/default"');
    // The retired path itself is still a redirect (System now owns what it
    // held), which is the fault this item exists to route around rather than
    // to remove — asserted so the premise of the whole item stays true.
    expect((await h.call('/admin/walls/default')).status).toBe(302);
  });

  it('no link on the Overview page resolves to a redirect', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    const html = await h.overview();
    const hrefs = new Set(
      [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)]
        .map((m) => m[1] as string)
        .filter((href) => !href.startsWith('http') && !href.startsWith('mailto:') && href !== ''),
    );
    expect(hrefs.size, 'no relative links found on the Overview at all').toBeGreaterThan(5);
    for (const href of hrefs) {
      const response = await h.call(resolve(href));
      expect([300, 301, 302, 303, 307, 308]).not.toContain(response.status);
    }
  });
});

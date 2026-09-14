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
import { issueDisplayToken } from '../src/auth/tokens.js';
import { readThemes } from '../src/api/themes.js';
import { THEMES } from '../src/http/theme-cards.js';

/**
 * Themes, driven through the real admin routes: the gallery, and the builder —
 * create, list, edit, delete, a custom theme chosen for a wall and refused
 * when it does not exist, and a theme in use deleted out from under its walls.
 */

/** A wall wearing a theme, straight into the table, and the token to poll as it. */
function wearing(db: ReturnType<typeof openDatabase>['db'], id: string, name: string, theme: string) {
  const issued = issueDisplayToken();
  const at = Date.now();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, issued.tokenHash, theme, at, at, at);
  return issued.token;
}

/** The text of one `.themecard`, tags and all, as a household reads it. */
function themeCardTexts(html: string): readonly string[] {
  return html
    .split('<div class="themecard">')
    .slice(1)
    .map((chunk) =>
      chunk
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
}

/** The card whose name it is — matched on the rendered words, not a class. */
function cardNamed(html: string, name: string): string {
  const found = themeCardTexts(html).find((text) => text.startsWith(name));
  if (found === undefined) throw new Error(`no theme card reads “${name}”`);
  return found;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const TOKENS: Record<string, string> = {
  '--bg': '#101418',
  '--panel': '#1b2028',
  '--rule': '#2a333f',
  '--ink': '#e9eef4',
  '--muted': '#9ba7b4',
  '--faint': '#68727e',
  '--accent': '#e0a33e',
  '--s-day': '#e0a33e',
  '--s-night': '#4c7fd1',
  '--s-break': '#35916a',
  '--s-straight': '#6b7684',
};

function themeFields(name: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { name, ...TOKENS, radius: '0.4rem', ...overrides };
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-themes-adm-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(at, at);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'z'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.30.${++n}.1`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const form = (path: string, fields: Record<string, string>): Promise<Response> =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  // Signed in through the wizard, so the admin routes are reachable.
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household',
    email: `t${++n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  return { db, call, form };
}

describe('the theme builder', () => {
  it('creates a theme and lists it', async () => {
    const h = await harness();
    const res = await h.form('/admin/themes', themeFields('Sunset'));
    expect(res.status).toBe(302);
    expect(readThemes(h.db)).toHaveLength(1);
    const list = await (await h.call('/admin/themes')).text();
    expect(list).toContain('Sunset');
  });

  it('rejects an invalid colour', async () => {
    const h = await harness();
    const res = await h.form('/admin/themes', themeFields('Bad', { '--accent': 'not-a-hex' }));
    expect(res.status).toBe(400);
    expect(readThemes(h.db)).toHaveLength(0);
  });

  it('offers the theme where a wall is made and on the wall’s own page, and a wall can wear it', async () => {
    /*
     * The household default is retired (RFC 015 phase 2), so a custom theme is
     * offered on the two pages that decide what a *wall* wears — and nowhere
     * on System, which has no colour left to offer.
     */
    const h = await harness();
    await h.form('/admin/themes', themeFields('Sunset'));
    const id = readThemes(h.db)[0]?.id ?? '';

    const add = await (await h.call('/admin/walls/new')).text();
    expect(add).toContain(`custom:${id}`);
    expect(add).toContain('Sunset');
    expect(await (await h.call('/admin/system')).text()).not.toContain(`custom:${id}`);

    const made = await h.form('/admin/screens', { name: 'Kitchen', theme: `custom:${id}` });
    expect(made.status).toBe(303);
    const wall = /\/admin\/walls\/([^/]+)\/pair/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
    const row = h.db.prepare('SELECT theme FROM screens WHERE id = ?').get(wall) as { theme: string };
    expect(row.theme).toBe(`custom:${id}`);
    const page = await (await h.call(`/admin/walls/${wall}`)).text();
    expect(page).toContain(`<option value="custom:${id}" selected>`);
  });

  it('refuses a theme reference that does not exist, on both doors', async () => {
    const h = await harness();
    const made = await h.form('/admin/screens', { name: 'Kitchen', theme: 'custom:deadbeef' });
    expect(made.status).toBe(400);
    expect(h.db.prepare('SELECT count(*) AS n FROM screens').get()).toEqual({ n: 0 });

    wearing(h.db, 'w1', 'Kitchen', 'panels');
    const saved = await h.form('/admin/screens/w1', {
      name: 'Kitchen', orientation: 'auto', rotation: '0', theme: 'custom:deadbeef',
    });
    expect(saved.status).toBe(400);
    expect(h.db.prepare(`SELECT theme FROM screens WHERE id = 'w1'`).get()).toEqual({ theme: 'panels' });
  });

  /*
   * The names are read out of `THEMES` rather than typed here, which is the
   * whole point of the assertion. A literal-string test would have gone green
   * on the wrong four names for as long as nobody edited it, and that is
   * exactly how "Board, Kitchen Slate, Paper Almanac, Glance" survived on this
   * page for releases after three of the four stopped existing (RFC 015 §2.1).
   */
  it('lists every built-in theme the display ships, named from THEMES', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/themes')).text();
    const cards = themeCardTexts(html);
    for (const theme of THEMES) {
      const name = theme.label.split(' — ')[0] ?? theme.key;
      expect(
        cards.some((text) => text.startsWith(name)),
        `no card on /admin/themes reads “${name}”`,
      ).toBe(true);
    }
  });

  /*
   * The built-ins used to be named only inside an empty state, so making one
   * theme of your own removed the other five from the product entirely
   * (RFC 015 §2.2). A gallery that lists them when there is nothing else to
   * list proves nothing about that; a gallery with a custom theme on it does.
   */
  it('still lists all five built-ins once a household has a theme of its own', async () => {
    const h = await harness();
    await h.form('/admin/themes', themeFields('Sunset'));
    const html = await (await h.call('/admin/themes')).text();
    const cards = themeCardTexts(html);
    expect(cards.some((text) => text.startsWith('Sunset'))).toBe(true);
    for (const theme of THEMES) {
      const name = theme.label.split(' — ')[0] ?? theme.key;
      expect(cards.some((text) => text.startsWith(name)), name).toBe(true);
    }
  });

  /*
   * §2.3: `themeUsage` already answered the one question an inventory needs —
   * *which wall is wearing this* — and the only caller was the delete
   * confirmation. Here it is on the list.
   *
   * Read out of the card's own rendered words, never off a class. A class was
   * right while the pixels were wrong twice in this codebase, and a tag is a
   * word a household reads.
   */
  it('tags each theme with the walls wearing it, by name', async () => {
    const h = await harness();
    const made = await h.form('/admin/screens', { name: 'Kitchen', theme: 'panels' });
    const id = /\/admin\/walls\/([^/]+)\/pair/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
    expect(id, 'the wall must exist for its name to be a tag').not.toBe('');
    const saved = await h.form(`/admin/screens/${id}`, {
      name: 'Kitchen',
      orientation: 'auto',
      rotation: '0',
      theme: 'blueprint',
    });
    expect(saved.status).toBe(302);

    const html = await (await h.call('/admin/themes')).text();
    expect(cardNamed(html, 'Blueprint')).toContain('Kitchen');
    // And nowhere else: a tag on every card says nothing.
    expect(cardNamed(html, 'Swiss')).not.toContain('Kitchen');
  });

  /*
   * There is no household row to account for any more (RFC 015 phase 2): every
   * wall names its own theme, so the tags across the page add up to exactly
   * the walls in the house. A wall still carrying the retired `board` — the
   * raw value the migration copied — is claimed by Panels, where
   * `LEGACY_THEME_ALIASES` folds it, rather than by no card at all.
   */
  it('tags every wall on exactly one card, with no household row among them', async () => {
    const h = await harness();
    wearing(h.db, 'w-board', 'Hall', 'board');
    wearing(h.db, 'w-alm', 'Kitchen', 'almanac');
    const html = await (await h.call('/admin/themes')).text();
    expect(html).not.toContain('Household default');
    expect(cardNamed(html, 'Panels')).toContain('Hall');
    expect(cardNamed(html, 'Paper Almanac')).toContain('Kitchen');
    expect(cardNamed(html, 'Paper Almanac')).not.toContain('Hall');
  });

  it('re-dresses every wall wearing a theme when it is deleted, in Panels, and says so first', async () => {
    /*
     * RFC 015 §3.4. A bare DELETE left a wall pointing at a row that was gone,
     * rescued at read time — which under "every wall names its own theme" is a
     * wall wearing a value nobody chose. Two walls wear it, one as its theme
     * and one as its daylight theme too; the confirmation names both and what
     * they will wear, and after the delete both rows and both manifests say
     * Panels.
     */
    const h = await harness();
    await h.form('/admin/themes', themeFields('Sunset'));
    const id = readThemes(h.db)[0]?.id ?? '';
    const ref = `custom:${id}`;
    const kitchen = wearing(h.db, 'w-k', 'Kitchen', ref);
    const hall = wearing(h.db, 'w-h', 'Hall', ref);
    h.db.prepare(`UPDATE screens SET daytime_theme = ?, daytime_starts_at = '07:00', daytime_ends_at = '21:00' WHERE id = 'w-h'`).run(ref);

    const confirm = await (await h.call(`/admin/themes/${id}/delete`)).text();
    expect(confirm).toContain('Kitchen');
    expect(confirm).toContain('Hall');
    expect(confirm).toContain('they switch to Panels.');

    const removed = await h.form(`/admin/themes/${id}/delete`, {});
    expect(removed.status).toBe(302);
    expect(readThemes(h.db)).toHaveLength(0);
    expect(
      h.db.prepare(`SELECT id, theme, daytime_theme AS daytime FROM screens ORDER BY id`).all(),
    ).toEqual([
      { id: 'w-h', theme: 'panels', daytime: null },
      { id: 'w-k', theme: 'panels', daytime: null },
    ]);
    for (const token of [kitchen, hall]) {
      const manifest = (await (
        await h.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } })
      ).json()) as { theme: { active: string; activeShape: string; daytime?: string } };
      expect(manifest.theme.active).toBe('panels');
      expect(manifest.theme.activeShape).toBe('panels');
      expect(manifest.theme.daytime).toBeUndefined();
    }
  });

  it('edits and deletes a theme', async () => {
    const h = await harness();
    await h.form('/admin/themes', themeFields('Sunset'));
    const id = readThemes(h.db)[0]?.id ?? '';

    const edited = await h.form(`/admin/themes/${id}`, themeFields('Dawn'));
    expect(edited.status).toBe(302);
    expect(readThemes(h.db)[0]?.name).toBe('Dawn');

    const removed = await h.form(`/admin/themes/${id}/delete`, {});
    expect(removed.status).toBe(302);
    expect(readThemes(h.db)).toHaveLength(0);
  });
});

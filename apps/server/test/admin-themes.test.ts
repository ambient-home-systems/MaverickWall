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
import { readThemes } from '../src/api/themes.js';
import { THEMES } from '../src/http/theme-cards.js';

/**
 * Themes, driven through the real admin routes: the gallery, and the builder —
 * create, list, edit, delete, and a custom theme chosen as the household
 * default and refused when it does not exist.
 */

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

  it('offers the theme in the wall defaults and accepts it as the default', async () => {
    const h = await harness();
    await h.form('/admin/themes', themeFields('Sunset'));
    const id = readThemes(h.db)[0]?.id ?? '';

    // On System: the wall defaults moved there with the Default wall's retirement.
    const appearance = await (await h.call('/admin/system')).text();
    expect(appearance).toContain(`custom:${id}`);
    expect(appearance).toContain('Sunset');

    const saved = await h.form('/admin/display', {
      theme: `custom:${id}`,
      daytime_theme: 'none',
      daytime_starts_at: '07:00',
      daytime_ends_at: '21:00',
      today_events: '8',
      next_days: '6',
      horizon_weeks: '5',
      week_start: 'sunday',
      block_1: 'now',
      block_2: 'next',
      block_3: 'horizon',
    });
    expect(saved.status).toBe(302);
    const row = h.db.prepare(`SELECT theme FROM household_settings WHERE id = 'singleton'`).get() as {
      theme: string;
    };
    expect(row.theme).toBe(`custom:${id}`);
  });

  it('refuses a theme reference that does not exist', async () => {
    const h = await harness();
    const res = await h.form('/admin/display', {
      theme: 'custom:deadbeef',
      daytime_theme: 'none',
      daytime_starts_at: '07:00',
      daytime_ends_at: '21:00',
      today_events: '8',
      next_days: '6',
      horizon_weeks: '5',
      week_start: 'sunday',
      block_1: 'now',
      block_2: 'next',
      block_3: 'horizon',
    });
    expect(res.status).toBe(400);
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
    const made = await h.form('/admin/screens', { name: 'Kitchen' });
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
   * The household row still exists in this phase, and a wall that has set no
   * theme of its own is drawing it — so the page has to account for it or the
   * tags add up to fewer walls than the house has. It lands on **Panels**
   * rather than nowhere, because the column's default is still the retired
   * `board` and `LEGACY_THEME_ALIASES` folds it there.
   */
  it('shows the household row as a tag, folded onto the theme it resolves to', async () => {
    const h = await harness();
    const html = await (await h.call('/admin/themes')).text();
    expect(cardNamed(html, 'Panels')).toContain('Household default');
    expect(cardNamed(html, 'Paper Almanac')).not.toContain('Household default');
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

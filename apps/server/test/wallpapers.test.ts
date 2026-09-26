import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
import { backgroundSchema } from '../src/api/widget-schema.js';
import { parseBackground } from '../src/api/manifest.js';
import { templateSchema } from '../src/api/templates.js';
import { CLASSIC_TEMPLATE } from '../src/templates/index.js';
import { BUILTIN_THEME_TOKENS } from '../src/api/builtin-themes.js';
import { WALLPAPERS, WALLPAPER_FILE, isWidgetGround, themeTone, wallpaperById } from '../src/wallpapers.js';

/**
 * The fourth kind of canvas background (plan item P6.1): the catalogue, the
 * files behind it, the route that serves them, and the two boundaries a stored
 * id crosses — the schema a save is held to and `parseBackground` on the way
 * to a wall.
 *
 * `browser-wallpaper.test.ts` is where a real wall draws one; this file is
 * everything that can be settled without a browser, and the part of it worth
 * reading twice is the pair at the foot of the catalogue block: every name is
 * held to the bytes it names, because the route caches for a year.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'assets', 'wallpapers');
const MIGRATIONS = join(HERE, '..', 'migrations');

describe('the wallpaper catalogue', () => {
  it('names each wallpaper once, by an id that is not a file name', () => {
    const ids = WALLPAPERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of WALLPAPERS) {
      expect(w.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(['light', 'dark']).toContain(w.tone);
      expect(w.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(wallpaperById(w.id)).toBe(w);
    }
    // The placeholders cover both tones, so the picker's filter has something
    // to filter in each direction.
    expect(new Set(WALLPAPERS.map((w) => w.tone))).toEqual(new Set(['light', 'dark']));
  });

  it('holds every file name to the bytes it names — the route caches for a year', () => {
    for (const w of WALLPAPERS) {
      for (const [size, file] of [['thumb', w.thumb], ['small', w.small], ['large', w.large]] as const) {
        expect(file, `${w.id} ${size}`).toMatch(WALLPAPER_FILE);
        const body = readFileSync(join(DIR, file));
        // A JPEG, by its magic bytes rather than its extension.
        expect([...body.subarray(0, 3)], `${file} is a JPEG`).toEqual([0xff, 0xd8, 0xff]);
        const hash = /\.([0-9a-f]+)\.jpe?g$/.exec(file)?.[1] ?? '';
        expect(
          createHash('sha256').update(body).digest('hex').startsWith(hash),
          `${file} was regenerated without renaming it, so a wall that cached it keeps the old picture for a year`,
        ).toBe(true);
      }
    }
  });

  it('ships nothing the catalogue does not name', () => {
    const named = new Set(WALLPAPERS.flatMap((w) => [w.thumb, w.small, w.large]));
    const onDisk = readdirSync(DIR).filter((name) => name !== 'LICENSES.md');
    expect(onDisk.sort()).toEqual([...named].sort());
  });

  /*
   * The size budget (P6.2 sets the real one: about 10–15 MB for the set). The
   * three placeholders are about 1.4 MB between them; a pin that growth has to
   * move deliberately, rather than drift past, so the next wallpaper is a
   * decision about a 437 MB image and not a surprise in it.
   */
  it('stays inside its size budget', () => {
    const total = readdirSync(DIR).reduce((sum, name) => sum + statSync(join(DIR, name)).size, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('a wallpaper background at the save boundary and on the way to a wall', () => {
  it('accepts a catalogue id and nothing else in its place (rule five)', () => {
    expect(backgroundSchema.safeParse({ type: 'wallpaper', id: 'dusk' }).success).toBe(true);
    for (const bad of [
      { type: 'wallpaper', id: 'nope' },
      { type: 'wallpaper', id: WALLPAPERS[0]?.small },
      { type: 'wallpaper', id: '../dusk' },
      { type: 'wallpaper' },
      // Never the file names: those are the server's to resolve.
      { type: 'wallpaper', id: 'dusk', small: 'dusk-1600.82505dfb45.jpg' },
    ]) {
      expect(backgroundSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('resolves a known id into its files and drops an unknown one to no background (rule nine)', () => {
    const dusk = wallpaperById('dusk');
    expect(parseBackground(JSON.stringify({ type: 'wallpaper', id: 'dusk' }))).toEqual({
      type: 'wallpaper',
      id: 'dusk',
      small: dusk?.small,
      large: dusk?.large,
    });
    expect(parseBackground(JSON.stringify({ type: 'wallpaper', id: 'retired-in-s23' }))).toBeUndefined();
    expect(parseBackground(JSON.stringify({ type: 'wallpaper', id: 7 }))).toBeUndefined();
    expect(parseBackground('{"type":"wallpaper"}')).toBeUndefined();
  });

  it('may be named by a template, whose schema is the save schema', () => {
    const named = { ...CLASSIC_TEMPLATE, portrait: { ...CLASSIC_TEMPLATE.portrait, background: { type: 'wallpaper', id: 'hills' } } };
    expect(templateSchema.safeParse(named).success).toBe(true);
    const unknown = { ...CLASSIC_TEMPLATE, portrait: { ...CLASSIC_TEMPLATE.portrait, background: { type: 'wallpaper', id: 'nope' } } };
    expect(templateSchema.safeParse(unknown).success).toBe(false);
  });
});

describe('the tone a theme asks for', () => {
  it('puts the five built-ins where the plan names them', () => {
    expect(themeTone(BUILTIN_THEME_TOKENS.panels['--bg'])).toBe('dark');
    expect(themeTone(BUILTIN_THEME_TOKENS.swiss['--bg'])).toBe('dark');
    expect(themeTone(BUILTIN_THEME_TOKENS.household['--bg'])).toBe('light');
    expect(themeTone(BUILTIN_THEME_TOKENS.almanac['--bg'])).toBe('light');
    expect(themeTone(BUILTIN_THEME_TOKENS.blueprint['--bg'])).toBe('light');
  });

  it('knows the three grounds and nothing else', () => {
    for (const ok of ['none', 'soft', 'solid']) expect(isWidgetGround(ok)).toBe(true);
    for (const bad of ['', 'Soft', 'opaque', null, 1]) expect(isWidgetGround(bad)).toBe(false);
  });
});

describe('the display transcription', () => {
  it('holds the same file-name shape the server does', () => {
    const source = readFileSync(join(HERE, '..', '..', 'display', 'src', 'wallpaper.ts'), 'utf8');
    const transcribed = /export const WALLPAPER_FILE = (\/.*\/);/.exec(source)?.[1];
    expect(transcribed, 'the display bundle declares WALLPAPER_FILE').toBeDefined();
    expect(transcribed).toBe(String(WALLPAPER_FILE));
  });
});

// --- The route and the manifest, against a real app ------------------------

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wallpapers-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'w'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.9.3.1',
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
  });
  const token = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('s1', 'Kitchen', ?, 'panels', ?, ?, ?)`,
  ).run(token.tokenHash, stamp, stamp, stamp);
  const manifest = async (): Promise<{ layout: { portrait: { background?: unknown } }; screen: Record<string, unknown> }> => {
    const res = await app.fetch(
      new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${token.token}` } }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { layout: { portrait: { background?: unknown } }; screen: Record<string, unknown> };
  };
  return { app, db, manifest };
}

describe('/assets/wallpapers/', () => {
  it('serves every catalogue file as a JPEG, immutable for a year', async () => {
    const { app } = harness();
    for (const w of WALLPAPERS) {
      for (const file of [w.thumb, w.small, w.large]) {
        const res = await app.fetch(new Request(`http://localhost/assets/wallpapers/${file}`));
        expect(res.status, file).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(DIR, file)))).toBe(true);
      }
    }
  });

  it('serves nothing that is not a wallpaper file', async () => {
    const { app } = harness();
    for (const name of ['LICENSES.md', 'dusk.jpg', '..%2Fwallpapers.ts', 'dusk-1600.0000000000.jpg', 'x.png']) {
      const res = await app.fetch(new Request(`http://localhost/assets/wallpapers/${name}`));
      expect(res.status, name).toBe(404);
    }
  });
});

describe('the manifest', () => {
  it('carries a stored wallpaper resolved, and nothing for an id the catalogue does not name', async () => {
    const h = harness();
    h.db.prepare(`UPDATE screens SET layout_background = ? WHERE id = 's1'`).run('{"type":"wallpaper","id":"paper"}');
    const paper = wallpaperById('paper');
    expect((await h.manifest()).layout.portrait.background).toEqual({
      type: 'wallpaper', id: 'paper', small: paper?.small, large: paper?.large,
    });
    h.db.prepare(`UPDATE screens SET layout_background = ? WHERE id = 's1'`).run('{"type":"wallpaper","id":"nope"}');
    expect((await h.manifest()).layout.portrait).not.toHaveProperty('background');
  });

  it('says the widget ground only once it is chosen, and only as one of the three', async () => {
    const h = harness();
    const before = await h.manifest();
    expect(before.screen).not.toHaveProperty('widgetGround');
    h.db.prepare(`UPDATE screens SET widget_ground = 'solid' WHERE id = 's1'`).run();
    expect((await h.manifest()).screen['widgetGround']).toBe('solid');
    h.db.prepare(`UPDATE screens SET widget_ground = 'opaque' WHERE id = 's1'`).run();
    expect((await h.manifest()).screen).not.toHaveProperty('widgetGround');
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import {
  createTheme,
  FONTS,
  mix,
  readThemes,
  resolveTheme,
  themeTokensSchema,
  withTints,
  type ThemeTokens,
} from '../src/api/themes.js';

/**
 * Custom themes: the token maths that has to match the display, the schema that
 * keeps a stranger's value out of the wall's CSS, and resolution to what the
 * manifest carries. The `mix` test is the parity guard against the copy in the
 * display bundle (`apps/display/src/theme.ts`), which the two share by test
 * rather than by import.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function db(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-themes-'));
  roots.push(dataDir);
  const { db: database } = openDatabase({ dataDir });
  runMigrations(database, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return database;
}

// A dark theme and a light one, both valid.
const DARK: ThemeTokens = {
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
  '--radius': '0.4rem',
};
const LIGHT: ThemeTokens = { ...DARK, '--bg': '#f6f3ec', '--panel': '#ffffff', '--ink': '#1a1815' };

describe('mix (parity with the display bundle)', () => {
  it('blends foreground over background by amount', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mix('#ff0000', '#000000', 0.2)).toBe('#330000');
    expect(mix('#ffffff', '#000000', 0)).toBe('#000000');
    expect(mix('#123456', '#123456', 1)).toBe('#123456');
  });
});

describe('withTints', () => {
  it('derives a cell tint and badge tint for each shift hue', () => {
    const t = withTints(DARK);
    for (const s of ['--s-day', '--s-night', '--s-break', '--s-straight']) {
      expect(t[`${s}-tint`]).toMatch(/^#[0-9a-f]{6}$/);
      expect(t[`${s}-badge`]).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The base tokens survive untouched.
    expect(t['--accent']).toBe(DARK['--accent']);
  });

  it('washes a light background more lightly than a dark one', () => {
    // Same hue, different background: paper (0.13) sits closer to its bg than
    // slate (0.2) does, so the tint is nearer the background on light.
    const dark = withTints({ ...DARK, '--s-day': '#ff0000' })['--s-day-tint'];
    const light = withTints({ ...LIGHT, '--s-day': '#ff0000' })['--s-day-tint'];
    expect(dark).not.toBe(light);
  });
});

/**
 * The four emphasis roles a custom theme needs (RFC — wall type hierarchy),
 * derived here for a household's own theme the same way the display bundle's
 * `customTokens` derives them for the live editor preview — a custom theme
 * with no `--ink-scaffold` resolves `var()` to nothing on every date numeral
 * in that household's wall.
 */
const luminance601 = (hex: string): number => {
  const value = parseInt(hex.slice(1), 16);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
};
const contrastOf = (a: string, b: string): number => {
  const [la, lb] = [luminance601(a), luminance601(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

describe('withTints, the four emphasis roles', () => {
  it('derives --ink-event, --ink-quiet and --rule-week as straight copies', () => {
    const t = withTints(DARK);
    expect(t['--ink-event']).toBe(DARK['--ink']);
    expect(t['--ink-quiet']).toBe(DARK['--muted']);
    expect(t['--rule-week']).toBe(DARK['--rule']);
  });

  it('measures --ink-scaffold to clear 4.5:1 on the background, dark and light alike', () => {
    expect(contrastOf(withTints(DARK)['--ink-scaffold'] as string, DARK['--bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(withTints(LIGHT)['--ink-scaffold'] as string, LIGHT['--bg'])).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('falls back toward pure ink rather than looping forever on an unreadable pair', () => {
    // Ink and background almost identical: 4.5:1 may be out of reach, but the
    // loop must still terminate and hand back a colour.
    const impossible = { ...DARK, '--bg': '#202020', '--ink': '#212121' };
    expect(withTints(impossible)['--ink-scaffold']).toMatch(/^#[0-9a-f]{6}$/);
  });
});

/**
 * The two copies of the emphasis-role derivation must not drift.
 *
 * `withTints` here and `customTokens` in the display bundle's `theme.ts` are
 * deliberate mirrors (see both files' header comments) — the display bundle
 * has no dependencies and no bundler, so a test here cannot import *from* it
 * without falling outside `tsconfig.test.json`'s root and failing the
 * typecheck `pnpm test` exists to run (the same reason
 * `calendar-view-parity.test.ts` and `epaper-ladder-parity.test.ts` read their
 * display-side twin as text instead). So this reads `scaffoldInk`,
 * `contrastRatio` and `relativeLuminance` out of both files and holds them to
 * being character-identical — the same guard `calendar-view-parity.test.ts`
 * puts on `calendarView`, and the sharpest one available: any drift in the
 * starting ratio, the 4.5 bar, or the step size turns this red.
 */
describe('scaffoldInk, on both bundles (parity with the display bundle)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const DISPLAY_THEME_PATH = join(HERE, '..', '..', 'display', 'src', 'theme.ts');
  const display = readFileSync(DISPLAY_THEME_PATH, 'utf8');
  const server = readFileSync(join(HERE, '..', 'src', 'api', 'themes.ts'), 'utf8');

  /** `function NAME(...) { ... }`, verbatim, from either file's text. */
  function bodyOf(source: string, name: string, where: string): string {
    const from = source.indexOf(`function ${name}(`);
    if (from < 0) throw new Error(`no ${name} in ${where}`);
    const to = source.indexOf('\n}\n', from);
    if (to < 0) throw new Error(`${name} in ${where} never closes`);
    return source.slice(from, to + 3);
  }

  for (const name of ['relativeLuminance', 'contrastRatio', 'scaffoldInk']) {
    it(`draws ${name} character-identical on both sides`, () => {
      expect(bodyOf(server, name, 'themes.ts')).toBe(bodyOf(display, name, 'theme.ts'));
    });
  }

  it('reads the display file it claims to, so a rename fails loudly', () => {
    // A regex over a file that moved would quietly match nothing and pass
    // every assertion above by comparing two empty strings.
    expect(display).toContain('scaffoldInk');
    expect(bodyOf(display, 'scaffoldInk', 'theme.ts').length).toBeGreaterThan(0);
  });
});

describe('themeTokensSchema', () => {
  it('accepts a full valid token set', () => {
    expect(themeTokensSchema.safeParse(DARK).success).toBe(true);
  });
  it('refuses a non-hex colour', () => {
    expect(themeTokensSchema.safeParse({ ...DARK, '--accent': 'red' }).success).toBe(false);
  });
  it('refuses an unknown key (rule five)', () => {
    expect(themeTokensSchema.safeParse({ ...DARK, '--evil': '#000000' }).success).toBe(false);
  });
  it('refuses an out-of-range radius', () => {
    expect(themeTokensSchema.safeParse({ ...DARK, '--radius': '9999px' }).success).toBe(false);
    expect(themeTokensSchema.safeParse({ ...DARK, '--radius': 'calc(1px)' }).success).toBe(false);
  });
});

describe('font tokens', () => {
  const heading = FONTS[0]?.stack ?? '';
  const mono = FONTS[FONTS.length - 1]?.stack ?? '';

  it('accepts a bundled font stack, and none is fine (fonts are optional)', () => {
    expect(themeTokensSchema.safeParse(DARK).success).toBe(true);
    expect(themeTokensSchema.safeParse({ ...DARK, '--disp': heading }).success).toBe(true);
  });

  it('refuses an arbitrary font-family string (closed allowlist)', () => {
    expect(themeTokensSchema.safeParse({ ...DARK, '--disp': 'Comic Sans, cursive' }).success).toBe(false);
  });

  it('carries a chosen font through resolution', () => {
    const d = db();
    const created = createTheme(d, { name: 'Typed', tokens: { ...DARK, '--f-mono': mono } });
    expect(resolveTheme(d, `custom:${created.id}`).tokens?.['--f-mono']).toBe(mono);
  });
});

describe('resolveTheme', () => {
  it('carries only the shape for a built-in — the bundle owns its tokens', () => {
    const resolved = resolveTheme(db(), 'board');
    expect(resolved).toEqual({ shape: 'board' });
    expect(resolved.tokens).toBeUndefined();
  });

  it('carries the full resolved token set for a custom theme, with board shape', () => {
    const d = db();
    const created = createTheme(d, { name: 'Sunset', tokens: DARK });
    const resolved = resolveTheme(d, `custom:${created.id}`);
    expect(resolved.shape).toBe('board');
    expect(resolved.tokens?.['--bg']).toBe(DARK['--bg']);
    expect(resolved.tokens?.['--s-day-tint']).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('falls back to board for a missing custom id rather than blanking a wall', () => {
    expect(resolveTheme(db(), 'custom:does-not-exist')).toEqual({ shape: 'board' });
  });
});

describe('storage round-trip', () => {
  it('creates a theme and reads it back', () => {
    const d = db();
    const created = createTheme(d, { name: 'Sunset', tokens: DARK });
    const all = readThemes(d);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(created.id);
    expect(all[0]?.name).toBe('Sunset');
    expect(all[0]?.tokens['--accent']).toBe(DARK['--accent']);
  });
});

describe('a custom theme reaches a paired wall via /d/manifest', () => {
  it('carries the resolved tokens in the manifest a screen polls', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mw-themes-app-'));
    roots.push(dataDir);
    const { db: database } = openDatabase({ dataDir });
    runMigrations(database, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

    const at = Date.now();
    database
      .prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`)
      .run(at, at);

    // A household that has finished setup and chosen a custom theme.
    const theme = createTheme(database, { name: 'Sunset', tokens: DARK });
    database
      .prepare(`UPDATE household_settings SET theme = ?, setup_completed_at = ? WHERE id = 'singleton'`)
      .run(`custom:${theme.id}`, at);

    // A paired screen, so /d/manifest answers with a real token.
    const issued = issueDisplayToken();
    database
      .prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES ('scr1', 'Kitchen', ?, ?, ?, ?)`,
      )
      .run(issued.tokenHash, at, at, at);

    const app = createApp({
      db: database,
      appVersion: '0.1.0-test',
      bootNotices: [],
      auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
      keyring: createKeyring(randomBytes(32)),
      fetcher: createFetcher(),
      clientAddress: () => '10.20.0.1',
      setupToken: createSetupTokenHolder(() => {}),
      dataDir,
    });

    const res = await app.fetch(
      new Request('http://localhost/d/manifest', {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as { theme: { active: string; activeShape?: string; activeTokens?: Record<string, string> } };
    expect(manifest.theme.active).toBe(`custom:${theme.id}`);
    expect(manifest.theme.activeShape).toBe('board');
    expect(manifest.theme.activeTokens?.['--bg']).toBe(DARK['--bg']);
    expect(manifest.theme.activeTokens?.['--s-day-tint']).toMatch(/^#[0-9a-f]{6}$/);
  });
});

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
import { generateThemeTokens } from '../src/api/theme-generator.js';
import { themeTokensSchema } from '../src/api/themes.js';

/**
 * "Generate from a colour": one seed in, a whole legible wall theme out.
 *
 * The unit half proves the promise from the produced hexes with WCAG's own
 * arithmetic (the same pattern as test/m3-tokens.test.ts), against ugly seeds
 * included — black, white and a neon are exactly what somebody will paste
 * first. The route half drives the real thing: generate through the form
 * route, select the result through the display-settings route, and read
 * /d/manifest the way a wall does, asserting the tokens arrive resolved.
 */

// ---- WCAG arithmetic, from the definition, not from the generating library --

function luminance(hex: string): number {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  expect(match, `${hex} is not a #RRGGBB colour`).not.toBeNull();
  const value = parseInt((match as RegExpExecArray)[1] as string, 16);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Ugly on purpose: the extremes and a neon beside the reasonable picks. */
const SEEDS = ['#000000', '#FFFFFF', '#39FF14', '#E8A33D', '#4C7FD1', '#FF0066', '#123456'];
const MODES = ['dark', 'light'] as const;

describe('generateThemeTokens', () => {
  for (const seed of SEEDS) {
    for (const mode of MODES) {
      it(`keeps every pairing legible for ${seed} (${mode})`, () => {
        const tokens = generateThemeTokens(seed, mode);
        // The result must be an ordinary custom theme by the same schema the
        // create path enforces.
        expect(themeTokensSchema.safeParse(tokens).success).toBe(true);

        const bg = tokens['--bg'];
        expect(contrast(tokens['--ink'], bg), 'ink over bg').toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--muted'], bg), 'muted over bg').toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--faint'], bg), 'faint over bg').toBeGreaterThanOrEqual(3);
        expect(contrast(tokens['--accent'], bg), 'accent over bg').toBeGreaterThanOrEqual(3);
        for (const shift of ['--s-day', '--s-night', '--s-break', '--s-straight'] as const) {
          expect(contrast(tokens[shift], bg), `${shift} over bg`).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});

// ---- The route chain, end to end --------------------------------------------

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-themegen-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => '10.6.6.1',
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

  return { db, call, form };
}

describe('the generate route, through to the wall', () => {
  it('generates, selects, and delivers resolved tokens in the manifest', async () => {
    const h = await harness();

    // Generate through the real form route; the redirect names the new theme.
    const generated = await h.form('/admin/themes/generate', {
      name: 'Sea glass',
      seed: '#39FF14',
      mode: 'dark',
    });
    expect(generated.status).toBe(302);
    const location = generated.headers.get('location') ?? '';
    // A confirmation token rides the redirect (RFC 009 Phase 3.1/3.2), so the
    // theme id is no longer the last thing in the path.
    const id = /\/admin\/themes\/([0-9a-f]+)(?:\?|$)/.exec(location)?.[1];
    expect(id, `redirect ${location} should open the new theme`).toBeDefined();
    expect(location).toBe(`/admin/themes/${id}?saved=theme-generated`);

    // Select it as the household default through the display-settings route.
    const selected = await h.form('/admin/display', {
      theme: `custom:${id}`,
      daytime_theme: '',
      daytime_starts_at: '07:00',
      daytime_ends_at: '21:00',
      today_events: '8',
      next_days: '5',
      horizon_weeks: '5',
      week_start: 'sunday',
    });
    expect(selected.status).toBe(302);

    // Read the manifest the way a paired wall does.
    const issued = issueDisplayToken();
    const at = Date.now();
    h.db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES ('wall1', 'Kitchen', ?, ?, ?, ?)`,
    ).run(issued.tokenHash, at, at, at);
    const manifest = (await (
      await h.call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } })
    ).json()) as {
      theme: { active: string; activeShape?: string; activeTokens?: Record<string, string> };
    };

    // The wall receives resolved values — the board shape to draw with, and a
    // token map of nothing but hexes (tints pre-baked), never a name it would
    // have to look up.
    const expected = generateThemeTokens('#39FF14', 'dark');
    expect(manifest.theme.activeShape).toBe('board');
    expect(manifest.theme.activeTokens).toBeDefined();
    const tokens = manifest.theme.activeTokens as Record<string, string>;
    expect(tokens['--bg']).toBe(expected['--bg']);
    expect(tokens['--accent']).toBe(expected['--accent']);
    expect(tokens['--s-day-tint']).toMatch(/^#[0-9a-fA-F]{6}$/);
    for (const [token, value] of Object.entries(tokens)) {
      if (token === '--radius') continue;
      expect(value, `${token} should arrive as a resolved hex`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

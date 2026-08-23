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
 * The design system, pinned — including its absences.
 *
 * The admin was Material Design 3 and is not any more: hand-picked tokens, a
 * flat surface model with no elevation ladder, and square-ish shapes. Half of
 * that is things no longer being there, and an absence is exactly what somebody
 * reinstates while tidying — so it is asserted, the same way
 * `admin-mobile-nav.test.ts` asserts the rules its redesign deleted.
 *
 * Two of these tests are for bug classes hit while building it, both of which
 * a typecheck and every other test in this directory sailed straight over:
 *
 *  - A `var(--mw-...)` that nothing declares. Sweeping the M3 tokens across
 *    left three references to `--surface-elevation-*` after the token was
 *    removed. The affected cards fell back to no background at all, and CSS
 *    says nothing about it — a stat card just quietly stopped being a card.
 *  - A rule painting one token on itself. `.tag-ok` came out
 *    `background: var(--mw-ok); color: var(--mw-ok)` because two M3 roles
 *    (`success-container` and `on-success-container`) collapsed onto one new
 *    role. It rendered as an invisible word on a green chip.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The admin stylesheet, as a page actually serves it. */
async function stylesheet(): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-design-'));
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
    auth: { secret: 'b'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.11.0.${++n}`,
    setupToken: createSetupTokenHolder(() => {}),
    dataDir,
  });
  const html = await (await app.fetch(new Request('http://localhost/admin/sign-in'))).text();
  const opened = html.indexOf('<style>');
  const closed = html.indexOf('</style>', opened);
  expect(opened, 'the admin page must carry an inline stylesheet').toBeGreaterThan(-1);
  return html.slice(opened + '<style>'.length, closed);
}

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

function rulesOf(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = pattern.exec(withoutComments); m !== null; m = pattern.exec(withoutComments)) {
    const selectors = (m[1] ?? '')
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part !== '');
    out.push({ selectors, body: m[2] ?? '' });
  }
  return out;
}

describe('the admin stylesheet', () => {
  it('declares every custom property it reads', async () => {
    const css = (await stylesheet()).replace(/\/\*[\s\S]*?\*\//g, '');
    const used = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1] as string));
    const declared = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1] as string));
    // `--swatch` and `--pc` are written onto elements by the page as inline
    // styles (a theme swatch, a person's colour), so the stylesheet reads them
    // without declaring them. Everything else must be declared here.
    const INLINE = new Set(['--swatch', '--pc', '--ev', '--sc', '--fo-w']);
    const dangling = [...used].filter((v) => !declared.has(v) && !INLINE.has(v)).sort();
    expect(dangling, `these resolve to nothing: ${dangling.join(', ')}`).toEqual([]);
    // Passing over an empty set would be no guarantee at all.
    expect(used.size).toBeGreaterThan(40);
  });

  it('never paints a colour token on itself', async () => {
    const offenders: string[] = [];
    for (const rule of rulesOf(await stylesheet())) {
      const bg = /background(?:-color)?:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      const fg = /(?:^|;)\s*color:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      if (bg && fg && bg[1] === fg[1]) offenders.push(`${rule.selectors.join(',')} -> ${bg[1]}`);
    }
    expect(offenders, `invisible text: ${offenders.join(' ; ')}`).toEqual([]);
  });

  it('carries no Material Design 3 token', async () => {
    // The whole M3 system — colour roles, the fifteen type roles, the shape
    // scale, the elevation ladder, state-layer opacities — is gone. A stray
    // one would resolve to nothing and is also a sign of a half-reverted edit.
    const css = await stylesheet();
    expect(css).not.toMatch(/--md-sys-/);
    expect(css).not.toMatch(/--md-custom-/);
    expect(css).not.toMatch(/--md-ref-/);
  });

  it('keeps rectangles square-ish, and rounds only what is a circle', async () => {
    // A fully rounded rectangle was Material's loudest tell and the thing the
    // brief named first. `--mw-r-full` survives for genuinely round
    // affordances: the switch track, and the 18px close dot on an input chip.
    const ROUND_BY_DESIGN = ['.switch input[type=checkbox]', '.hep-pill-x'];
    const offenders: string[] = [];
    for (const rule of rulesOf(await stylesheet())) {
      if (!/border-radius:[^;]*--mw-r-full/.test(rule.body)) continue;
      if (rule.selectors.some((s) => ROUND_BY_DESIGN.some((ok) => s.includes(ok)))) continue;
      if (rule.selectors.some((s) => s.trim() === ':root')) continue;
      offenders.push(rule.selectors.join(','));
    }
    expect(offenders, `these are pills again: ${offenders.join(' ; ')}`).toEqual([]);
  });

  it('has no elevation ladder, and no stacked shadow', async () => {
    const css = await stylesheet();
    // Material conveys depth with five levels of double-layer shadow. This
    // system separates by ground and hairline, and keeps exactly two shadows
    // for things that genuinely float. More than one shadow layer in a single
    // value is the stacked look the brief rules out.
    const shadowTokens = [...css.matchAll(/--mw-shadow-\d+\s*:([^;]*)/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(shadowTokens.length, 'expected exactly three shadow tokens').toBe(3);
    for (const value of shadowTokens) {
      if (value === 'none') continue;
      const layers = value.split(/,(?![^(]*\))/).length;
      expect(layers, `${value} stacks ${layers} shadows`).toBe(1);
    }
    expect(css).not.toMatch(/--mw-shadow-[3-9]/);
  });

  it('sets no colour outside the token system', async () => {
    // Every colour must come from a token, so a theme swap is a token swap.
    // The exceptions are the two shadow definitions and the scrim, which are
    // black at an alpha rather than a palette colour, and #fff on the QR plate
    // and the e-paper preview, which are a physically white medium drawn
    // honestly in both schemes.
    const css = (await stylesheet()).replace(/\/\*[\s\S]*?\*\//g, '');
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    const ALLOWED = new Set(['#fff', '#ffffff', '#000', '#000000']);
    const stray = [...new Set(hexes.filter((h) => !ALLOWED.has(h)))].sort();
    // The scheme blocks themselves are where the palette is declared, so they
    // are excluded by looking only outside `--mw-<role>:` declarations.
    const declared = new Set(
      [...css.matchAll(/--mw-[a-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) =>
        (m[1] as string).toLowerCase(),
      ),
    );
    const outside = stray.filter((h) => !declared.has(h));
    expect(outside, `hard-coded colours outside the palette: ${outside.join(', ')}`).toEqual([]);
  });
});

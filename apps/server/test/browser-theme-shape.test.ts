/**
 * A custom theme choosing a shape, measured on a real wall (RFC 014 §4.3).
 *
 * `display.css` carries per-theme *shape* rules keyed on `data-theme` —
 * Almanac's 400-weight date numeral, Panels' card treatment on a reused
 * section — and until this phase a custom theme could never reach them: its
 * `data-theme` was pinned to the neutral `board` sentinel unconditionally, so
 * a household who built their own palette could not also borrow one of the
 * built-ins' shapes. `resolveTheme` now returns the chosen shape's own key,
 * which `apps/display`'s `applyTheme` already understands with no change on
 * that side — it has always set `data-theme` to whatever the manifest sends.
 *
 * Verified by measurement rather than by class name, the way this project
 * always checks a shape claim: `getComputedStyle` on a real element on a real
 * paired wall, for the two properties `display.css` actually declares for
 * that shape, never by asserting `data-theme="almanac"` is present (a class
 * or attribute can be right while the pixels are wrong — the chore-tick
 * lesson, and the segmented-control ring's).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TEARDOWN, install, loadWallSettled, shutDownBrowser, type Installation } from './browser-harness.js';
import { createTheme, type ThemeTokens } from '../src/api/themes.js';

process.env['TZ'] = 'UTC';

/** Long: each case boots a server, a browser context and settles the font race. */
const SLOW = 90_000;

const installations: Installation[] = [];
afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

async function fresh(): Promise<Installation> {
  const made = await install();
  installations.push(made);
  return made;
}

/**
 * A custom theme's full token set — a deliberately un-Almanac-like dark
 * palette, so a measured colour proves the *tokens* still travel unchanged
 * while the *shape* is borrowed. If Almanac's own palette leaked in here
 * instead of this theme's, `--bg` below would read `#FBF8F1` rather than
 * this theme's `#101418`.
 */
const TOKENS: ThemeTokens = {
  '--bg': '#101418',
  '--panel': '#1B2028',
  '--rule': '#2A333F',
  '--ink': '#E9EEF4',
  '--muted': '#9BA7B4',
  '--faint': '#68727E',
  '--accent': '#E0A33E',
  '--s-day': '#E0A33E',
  '--s-night': '#4C7FD1',
  '--s-break': '#35916A',
  '--s-straight': '#6B7684',
  '--radius': '0.4rem',
};

/** Set a wall's theme through the real admin route — the row a household's
 *  own edit would write, not a bare UPDATE. */
async function dressWall(home: Installation, wallId: string, ref: string): Promise<void> {
  const dressed = await home.post(`/admin/screens/${wallId}`, {
    name: 'Kitchen',
    orientation: 'auto',
    rotation: '0',
    theme: ref,
  });
  expect(dressed.status).toBe(302);
}

/** The pairing link for an already-created wall. */
async function pairingLinkFor(home: Installation, wallId: string): Promise<string> {
  const html = await (await home.call(`/admin/walls/${wallId}/pair`)).text();
  const link = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (link === undefined) throw new Error('the pairing page printed no link');
  return link;
}

/**
 * The date numeral's computed style, in the agenda a Classic wall always
 * draws — Almanac's own shape rule is `font-weight: 400` here, against the
 * unshaped default of `700`.
 */
async function drNumStyle(
  link: string,
): Promise<{ fontWeight: string; fontStyle: string; bg: string }> {
  const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
  try {
    await page.waitForSelector('.dr-num', { timeout: 20_000 });
    return await page.evaluate(() => {
      const num = document.querySelector('.dr-num') as HTMLElement;
      const horizon = document.querySelector('.horizon') as HTMLElement;
      const numStyle = window.getComputedStyle(num);
      const horizonStyle = horizon === null ? undefined : window.getComputedStyle(horizon);
      return {
        fontWeight: numStyle.fontWeight,
        fontStyle: numStyle.fontStyle,
        bg: horizonStyle?.backgroundColor ?? '',
      };
    });
  } finally {
    await close();
  }
}

/** The reused calendar section's card treatment — Panels' own shape rule is a
 *  background fill plus a corner radius; the unshaped default is neither. */
async function horizonCardStyle(
  link: string,
): Promise<{ background: string; borderRadius: string }> {
  const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
  try {
    await page.waitForSelector('.horizon', { timeout: 20_000 });
    return await page.evaluate(() => {
      const horizon = document.querySelector('.horizon') as HTMLElement;
      const style = window.getComputedStyle(horizon);
      return { background: style.backgroundColor, borderRadius: style.borderRadius };
    });
  } finally {
    await close();
  }
}

describe('a custom theme with a chosen shape, on a real wall', () => {
  it(
    "borrows Almanac's date-numeral weight while keeping its own colours",
    async () => {
      const home = await fresh();
      const theme = createTheme(home.db, { name: 'Ledger', tokens: TOKENS, shape: 'almanac' });
      const wallId = await home.pairWall('Kitchen');
      await dressWall(home, wallId, `custom:${theme.id}`);
      const link = await pairingLinkFor(home, wallId);

      const measured = await drNumStyle(link);
      // Almanac's own rule: `:root[data-theme="almanac"] .dr-num { font-weight: 400; }`
      expect(measured.fontWeight).toBe('400');
      // display.css declares no font-style on .dr-num for any theme — measured
      // rather than assumed, so a later change that *does* add one is read
      // here rather than silently passing an assertion nobody wrote.
      expect(measured.fontStyle).toBe('normal');
    },
    SLOW,
  );

  it(
    "borrows Panels' card treatment on the reused calendar section",
    async () => {
      const home = await fresh();
      const theme = createTheme(home.db, { name: 'Boxed', tokens: TOKENS, shape: 'panels' });
      const wallId = await home.pairWall('Kitchen');
      await dressWall(home, wallId, `custom:${theme.id}`);
      const link = await pairingLinkFor(home, wallId);

      const measured = await horizonCardStyle(link);
      // Panels' own rule: background: var(--panel); border-radius: var(--radius) —
      // both zero/none on every other shape.
      expect(measured.background).toBe('rgb(27, 32, 40)'); // TOKENS['--panel'] = #1B2028
      expect(measured.borderRadius).not.toBe('0px');
    },
    SLOW,
  );

  it(
    'measures identically to a theme that never chose one — an explicit "neutral" and a pre-phase null column alike',
    async () => {
      const home = await fresh();
      const untouched = createTheme(home.db, { name: 'Untouched', tokens: TOKENS, shape: 'neutral' });
      // A theme saved before this column existed: `shape` is a genuine NULL,
      // not the string 'neutral' — `createTheme` itself can no longer write
      // that state, so it is made directly, the way `migration-upgrade.test.ts`
      // simulates a pre-phase row.
      const preExisting = createTheme(home.db, { name: 'Pre-existing', tokens: TOKENS, shape: 'neutral' });
      home.db.prepare(`UPDATE themes SET shape = NULL WHERE id = ?`).run(preExisting.id);

      const wallA = await home.pairWall('Kitchen');
      await dressWall(home, wallA, `custom:${untouched.id}`);
      const linkA = await pairingLinkFor(home, wallA);
      const wallB = await home.pairWall('Lounge');
      await dressWall(home, wallB, `custom:${preExisting.id}`);
      const linkB = await pairingLinkFor(home, wallB);

      const [a, b] = await Promise.all([drNumStyle(linkA), drNumStyle(linkB)]);
      expect(a).toEqual(b);
      // And neither borrows a built-in's shape: the numeral is the unshaped
      // default weight, and the calendar section carries no card.
      expect(a.fontWeight).toBe('700');
      expect(a.bg).toBe('rgba(0, 0, 0, 0)');
    },
    SLOW,
  );
});

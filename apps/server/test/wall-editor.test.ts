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

/**
 * The wall editor, which is three contexts and not one page.
 *
 * It used to be a single column at one visual weight: status and pairing
 * buttons, the canvas, whichever widget was selected, then Look/Content/Device,
 * then Save. On a phone nobody could tell whether they were editing the wall,
 * a widget, or the screen it hangs on — and "Unpair" sat beside "Add widget" as
 * an equal. It is **Layout** (canvas plus a contextual widget inspector) and
 * **Wall settings** (categories) now, with one save bar over both.
 *
 * Three properties here are load-bearing and none is obvious from the markup:
 *
 *  - **The Advanced actions are outside the settings form.** Each is its own
 *    POST, and HTML has no nested forms — put them inside and the browser
 *    silently drops them, so Unpair becomes a button that does nothing.
 *  - **Every field kept its name.** The whole redesign is presentation: an
 *    empty override still means "follow the household", and
 *    `POST /admin/screens/:id` never learned that its form changed clothes.
 *  - **A density override is absent, not blank, when it is inherited.** The
 *    "use the household default" switch disables the number input, so the
 *    browser sends nothing at all — which is what the handler reads as null.
 *    A test that only ever posts a value would pass over a broken switch.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function ready() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-walledit-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = `10.11.1.${++n}`;
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 't'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => address,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') headers.set('cookie', cookie);
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }));
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return res;
  };
  const postForm = (path: string, fields: Record<string, string>) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`/setup?token=${setupToken.current().token}`);
  await postForm('/setup/account', {
    name: 'H', email: `t${n}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await postForm('/setup/household', { timezone: 'Europe/London' });

  /** Pair a screen so the editor has a real wall to render. */
  const pairScreen = (id: string, name: string): void => {
    const at = Date.now();
    const issued = issueDisplayToken();
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(id, name, issued.tokenHash, at, at, at);
  };

  const screenRow = (id: string): Record<string, unknown> =>
    db.prepare('SELECT * FROM screens WHERE id = ?').get(id) as Record<string, unknown>;

  return { db, call, postForm, pairScreen, screenRow };
}

/** The wall-settings form's markup only — never the Advanced actions after it. */
function settingsFormOf(html: string): string {
  const from = html.indexOf('data-settings');
  return html.slice(from, html.indexOf('</form>', from));
}

describe('the wall editor is two modes, not one page', () => {
  it('draws Layout and Wall settings as separate panels under one mode control', async () => {
    const h = await ready();
    h.pairScreen('s1', 'Kitchen');
    const res = await h.call('/admin/displays/s1');
    expect(res.status).toBe(200);
    const html = await res.text();

    // One accessible control, two panels, and Layout is the one you land on.
    expect(html).toContain('role="tablist" aria-label="What you are editing"');
    expect(html).toContain('data-mode="layout"');
    expect(html).toContain('data-mode="settings"');
    expect(html).toContain('id="mode-layout" role="tabpanel" aria-labelledby="mode-tab-layout"');
    expect(html).toContain('data-mode-panel="settings"');
    // The settings panel starts hidden; the layout one does not.
    expect(html).toContain('data-mode-panel="settings" hidden');
    expect(html).not.toContain('data-mode-panel="layout" hidden');

    // The canvas, its inspector host and the editor scripts.
    expect(html).toContain('id="layout-editor"');
    expect(html).toContain('id="wall-inspector"');
    expect(html).toContain('assets/layout-editor.js');
    expect(html).toContain('assets/display-editor.js');
    expect(html).toContain('id="layout"');

    // The preview says its size and its cadence once, above the canvas — it
    // used to be repeated under every widget panel.
    expect(html).toContain('Live preview');
    expect(html).toContain('data-preview-dims');
    expect((html.match(/updates within a minute/g) ?? []).length).toBe(1);
  });

  it('gives the wall one header: a back link in the app bar, no second hamburger', async () => {
    const h = await ready();
    h.pairScreen('s2', 'Hall');
    const html = await (await h.call('/admin/displays/s2')).text();

    // The crumb is the way back to the list.
    expect(html).toContain('class="crumb crumb-back" href="admin/displays"');
    expect(html).toContain('>Walls</a>');
    // Exactly one menu glyph on the page: the app shell's navigation drawer.
    // A wall-list button drawn as a second one is the ambiguity this replaces.
    expect((html.match(/class="navbtn"/g) ?? []).length).toBe(1);
    // The wall's name is said once, by the app bar — the page adds no second
    // header repeating it.
    expect(html).not.toContain('class="wall-name"');

    // Status in words, not a colour alone.
    expect(html).toContain('class="wall-status"');
    expect(html).toContain('Never connected');
  });

  it('says "Online" for a screen that checked in just now', async () => {
    const h = await ready();
    h.pairScreen('s3', 'Landing');
    h.db.prepare('UPDATE screens SET last_seen_at = ?, app_version = ? WHERE id = ?')
      .run(Date.now(), 'web 9.9.9', 's3');
    const html = await (await h.call('/admin/displays/s3')).text();
    expect(html).toContain('<b>Online</b>');
    expect(html).toContain('web 9.9.9');
  });

  it('keeps pairing, unpair and reset out of the everyday tools', async () => {
    const h = await ready();
    h.pairScreen('s4', 'Snug');
    const html = await (await h.call('/admin/displays/s4')).text();

    // They live in the header overflow and in the Advanced category…
    expect(html).toContain('aria-label="More actions for this display"');
    expect(html).toContain('admin/screens/s4/regenerate');
    expect(html).toContain('admin/screens/s4/revoke');
    // …each with a confirmation that names what it takes.
    expect(html).toContain('data-confirm="Unpair Snug?');
    expect(html).toContain('Reset both the portrait and landscape layouts');

    // And never as a permanently disabled button beside Add widget. Checked
    // past the inline stylesheet, whose comment says why that control moved.
    expect(html.slice(html.indexOf('</style>'))).not.toContain('Remove selected');
  });
});

describe('wall settings are categories, and every field kept its name', () => {
  it('offers five categories, each a tab over its own panel', async () => {
    const h = await ready();
    h.pairScreen('s5', 'Kitchen');
    const html = await (await h.call('/admin/displays/s5')).text();

    for (const key of ['appearance', 'content', 'device', 'alerts', 'advanced']) {
      expect(html, key).toContain(`data-wset="${key}"`);
      expect(html, key).toContain(`data-wset-panel="${key}"`);
    }
    expect(html).toContain('aria-orientation="vertical"');
    // A phone drills into one category and needs the way back out.
    expect(html).toContain('data-wset-back');

    // Every control the old three tabs carried is still here, under its old name.
    const form = settingsFormOf(html);
    for (const name of [
      'name="theme"', 'name="daytime_theme"', 'name="daytime_starts_at"', 'name="daytime_ends_at"',
      'name="today_events"', 'name="next_days"', 'name="horizon_weeks"',
      'name="name"', 'name="orientation"', 'name="rotation"', 'name="timezone"',
      'name="clock_24"', 'name="allow_dismiss"',
    ]) {
      expect(form, name).toContain(name);
    }
    // The alert control says what it does and who it does it for.
    expect(form).toContain('Allow alert dismissal');
    expect(form).toContain('Lets this display clear alerts for the household.');
    // The two orientation-ish controls are still told apart, in the copy.
    expect(form).toContain('Layout orientation');
    expect(form).toContain('Display mounting');
    expect(html).toContain('chooses which layout this wall shows');
    expect(html).toContain('not the Portrait/Landscape buttons in the layout editor');
  });

  it('keeps the Advanced actions outside the settings form — HTML has no nested forms', async () => {
    const h = await ready();
    h.pairScreen('s6', 'Kitchen');
    const html = await (await h.call('/admin/displays/s6')).text();
    const form = settingsFormOf(html);

    // The one save bar is still the only submit for the settings themselves.
    expect(form).not.toContain('type="submit"');
    // Each Advanced action is its own POST, so none of them may be in there.
    expect(form).not.toContain('admin/screens/s6/revoke');
    expect(form).not.toContain('reset-layout');
    // They are on the page all the same, in the Advanced panel after the form.
    const advanced = html.slice(html.indexOf('data-wset-panel="advanced"'));
    expect(advanced).toContain('admin/screens/s6/revoke');
    expect(advanced).toContain('reset-layout');
    expect(advanced).toContain('admin/displays/s6/gallery');
  });

  it('names the source and the effective value wherever something is inherited', async () => {
    const h = await ready();
    h.pairScreen('s7', 'Kitchen');
    // Something to inherit that is not the shipped default.
    await h.postForm('/admin/display', {
      theme: 'almanac', daytime_theme: 'none', today_events: '9', next_days: '4',
      horizon_weeks: '6', week_start: 'monday',
    });
    const html = await (await h.call('/admin/displays/s7')).text();

    // Not "Follow the default", and not a bare "9".
    expect(html).not.toContain('Follow the default');
    expect(html).toContain('Household default — Paper Almanac');
    expect(html).toContain('Household default — Europe/London');
    expect(html).toContain('Household default — 9 events');
    expect(html).toContain('Household default — 4 days');
    expect(html).toContain('Household default — 6 weeks');
    // A daylight schedule the household has not set is said as what it is.
    expect(html).toContain('Household default — the same theme all day');
  });

  it('hides what cannot apply until it can', async () => {
    const h = await ready();
    h.pairScreen('s8', 'Kitchen');
    const html = await (await h.call('/admin/displays/s8')).text();

    // The daylight window is ignored outright while this wall follows the
    // household's schedule, so it is not drawn.
    expect(html).toContain('data-reveal-if="daytime_theme"');
    expect(html).toMatch(/data-reveal-if="daytime_theme" hidden/);
    // Each density starts inherited, so its number field is not drawn either.
    for (const key of ['today_events', 'next_days', 'horizon_weeks']) {
      expect(html, key).toContain(`data-inherit-toggle="${key}"`);
      expect(html, key).toMatch(new RegExp(`data-inherit-field="${key}" [^>]*hidden`));
    }
    // Disabled, so the browser sends nothing at all for an inherited number —
    // which is the blank the handler reads as "follow the household".
    expect((html.match(/inputmode="numeric" min="\d+" max="\d+" disabled/g) ?? []).length).toBe(3);
    // And each carries the value to seed the field with when inheritance is
    // turned off: an empty override is not an override.
    expect(html).toContain('data-inherit-default="8"');
  });

  it("reveals this wall's own numbers once it has them", async () => {
    const h = await ready();
    h.pairScreen('s9', 'Kitchen');
    await h.postForm('/admin/screens/s9', {
      name: 'Kitchen', orientation: 'auto', rotation: '0',
      theme: '', daytime_theme: '', timezone: '', clock_24: '',
      today_events: '5', next_days: '', horizon_weeks: '',
    });
    const html = await (await h.call('/admin/displays/s9')).text();
    // The one it set is open and filled; the two it did not are still inherited.
    expect(html).not.toMatch(/data-inherit-field="today_events" [^>]*hidden/);
    expect(html).toMatch(/data-inherit-field="next_days" [^>]*hidden/);
    expect(html).toContain('value="5"');
  });
});

describe('saving a wall', () => {
  it('persists every category from one submission, and an absent number inherits', async () => {
    const h = await ready();
    h.pairScreen('sa', 'Kitchen');

    // Exactly what the page posts with Appearance, Device and Alerts touched
    // and the three densities left on the household default — the inheritance
    // switch disables those inputs, so they are absent rather than empty.
    const res = await h.postForm('/admin/screens/sa', {
      theme: 'almanac',
      daytime_theme: 'panels',
      daytime_starts_at: '06:30',
      daytime_ends_at: '20:15',
      name: 'Kitchen wall',
      orientation: 'portrait',
      rotation: '90',
      timezone: 'Europe/Paris',
      clock_24: '0',
      allow_dismiss: '1',
    });
    expect(res.status).toBe(302);

    const row = h.screenRow('sa');
    expect(row['name']).toBe('Kitchen wall');
    expect(row['orientation']).toBe('portrait');
    expect(row['rotation']).toBe(90);
    expect(row['theme']).toBe('almanac');
    expect(row['daytime_theme']).toBe('panels');
    expect(row['daytime_starts_at']).toBe('06:30');
    expect(row['timezone']).toBe('Europe/Paris');
    expect(row['clock_24']).toBe(0);
    expect(row['allow_dismiss']).toBe(1);
    // The absent densities are the household's, not zero and not an error.
    expect(row['display_today_events']).toBe(null);
    expect(row['display_next_days']).toBe(null);
    expect(row['display_horizon_weeks']).toBe(null);
  });

  it('answers a bad value with the editor open on Wall settings', async () => {
    const h = await ready();
    h.pairScreen('sb', 'Kitchen');
    const res = await h.postForm('/admin/screens/sb', {
      name: 'Kitchen', orientation: 'auto', rotation: '0',
      theme: '', daytime_theme: '', timezone: 'Mars/Olympus', clock_24: '',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Choose a timezone from the list.');
    // The thing to fix is in the settings, so that is the panel on screen.
    expect(html).toContain('data-mode-panel="layout" hidden');
    expect(html).not.toContain('data-mode-panel="settings" hidden');
  });

  it('starts clean: Save is disabled, Discard is not drawn, and both say what they do', async () => {
    const h = await ready();
    h.pairScreen('sc', 'Kitchen');
    const html = await (await h.call('/admin/displays/sc')).text();
    expect(html).toContain('>Save wall</button>');
    expect(html).toContain('data-action="save" disabled');
    expect(html).toContain('data-action="discard" hidden');
    expect(html).toContain('data-dirty-flag');
    expect(html).toContain('Unsaved changes');
  });
});

describe('the Default display is the same editor without the hardware', () => {
  it('renders both modes and the categories that apply to it', async () => {
    const h = await ready();
    const html = await (await h.call('/admin/displays/default')).text();
    expect(html).toContain('id="layout-editor"');
    expect(html).toContain('data-mode-panel="settings" hidden');
    expect(html).toContain('data-wset="appearance"');
    expect(html).toContain('data-wset="content"');
    expect(html).toContain('data-wset="advanced"');
    // No screen, so nothing to pair, unpair or hang.
    expect(html).not.toContain('/revoke');
    expect(html).not.toContain('name="rotation"');
    expect(html).toContain('Shared default');
  });
});

describe('the stylesheet the editor is drawn with', () => {
  it('takes the closed widget sheet away from the keyboard, not merely off screen', async () => {
    const h = await ready();
    // The admin stylesheet is inline in every page.
    const style = await (await h.call('/admin/displays/default')).text();

    // Translated away *and* invisible: a sheet that is only translated still
    // hands every control in it to the keyboard.
    expect(style).toContain('transform:translateY(101%);visibility:hidden');
    expect(style).toContain('.lay-inspector.is-open{transform:none;visibility:visible}');
    // The sheet sits on the save bar rather than over it.
    expect(style).toContain('bottom:calc(var(--savebar-h) + env(safe-area-inset-bottom))');
    // `hidden` must actually hide something a display rule would otherwise show.
    expect(style).toContain('.insp-tabs[hidden]{display:none}');
    // The save bar clears the phone's home indicator.
    expect(style).toContain('padding-bottom:calc(12px + env(safe-area-inset-bottom))');
    // A settings row is a touch target, and its value is 16px so focusing it
    // does not make iOS zoom the page.
    expect(style).toContain('.srow{display:flex;align-items:center;gap:12px;min-height:56px');
    expect(style).toMatch(/\.srow-select\{[^}]*font-size:16px/);
  });
});

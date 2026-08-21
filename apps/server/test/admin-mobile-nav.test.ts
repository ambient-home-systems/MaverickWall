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
 * The compact-width navigation, pinned.
 *
 * Below 900px the admin drawer is a *modal* one: the same panel, off-canvas,
 * over a scrim, opened from the top app bar's leading icon. It used to be
 * recast in place as a wrapping field of pills — group headings hidden, pills
 * cut to 40px, the foot with sign-out and the theme toggle removed outright —
 * which cost the first screenful of every page on a phone.
 *
 * Three properties here are load-bearing and none of them is visible to a
 * person reading the markup:
 *
 *  - **DOM order.** The drawer and the scrim are selected as *siblings* of the
 *    checkbox (`~`), so a refactor that moved the input below the aside would
 *    render a page whose menu button does nothing at all. Nothing else in the
 *    stylesheet depends on the order of the body's children, so nothing else
 *    would complain.
 *  - **No script.** The drawer is a checkbox the CSS reads. A person who cannot
 *    reach the navigation cannot reach anything else either, which is the same
 *    argument that keeps the wizard script-free.
 *  - **What the compact block no longer says.** The old rules are the bug, so
 *    their absence is the fix; a restyle that reinstated `display:none` on the
 *    group headings or the foot would look tidy and undo the whole change.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/*
 * A fresh client address per harness. The auth rate limiter's counters live in
 * module-global memory, so they outlive an app and even its database — with one
 * address shared across the file, the fourth harness here cannot sign up, and
 * every page it then asks for is a redirect with no body. That reads as "the
 * page carries no stylesheet", which is a long way from the cause.
 */
let clientNumber = 0;
const nextClientAddress = (): string => `10.11.11.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-mobilenav-'));
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
    auth: { secret: 'm'.repeat(32), baseUrl: 'http://localhost' },
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

  /** Signed in, through the real wizard — the session every admin page needs. */
  const signedIn = async () => {
    await call(`/setup?token=${setupToken.current().token}`);
    await form('/setup/account', {
      name: 'Household', email: 'family@home.local',
      password: 'correct-horse-battery', confirm: 'correct-horse-battery',
    });
    await form('/setup/household', { timezone: 'Europe/London' });
    // Fail here, where the cause is legible, rather than in whichever
    // assertion first trips over an empty redirect body.
    const check = await call('/admin');
    expect(check.status, 'the harness must reach a signed-in /admin').toBe(200);
  };

  return { call, form, setupToken, jar, signedIn };
}

/** The one inline stylesheet every page carries. */
function styleOf(html: string): string {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html);
  expect(match, 'the page must carry an inline stylesheet').not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

/** The body of the `@media(max-width:900px)` block that lays out the shell. */
function compactShellBlock(css: string): string {
  const start = css.indexOf('@media(max-width:900px){');
  expect(start, 'the compact-width block must exist').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in the compact-width block');
}

const PAGES = ['/admin', '/admin/calendars', '/admin/displays', '/admin/system'];

describe('the admin navigation at compact width', () => {
  it('carries the drawer toggle, its scrim and the app bar button, in that order', async () => {
    const h = await harness();
    await h.signedIn();

    for (const path of PAGES) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();

      const toggle = html.indexOf('<input type="checkbox" id="mw-nav" class="nav-toggle"');
      const drawer = html.indexOf('<aside class="side">');
      const scrim = html.indexOf('<label class="nav-scrim" for="mw-nav"');
      const button = html.indexOf('<label class="navbtn" for="mw-nav"');

      expect(toggle, `${path} must carry the drawer toggle`).toBeGreaterThan(-1);
      expect(scrim, `${path} must carry the scrim`).toBeGreaterThan(-1);
      expect(button, `${path} must carry the app bar's menu button`).toBeGreaterThan(-1);

      // The whole mechanism is `#mw-nav:checked ~ .side` and `~ .nav-scrim`.
      // A sibling combinator only looks forward, so the input must precede
      // both or the button silently stops working.
      expect(toggle, `${path}: the toggle must precede the drawer`).toBeLessThan(drawer);
      expect(toggle, `${path}: the toggle must precede the scrim`).toBeLessThan(scrim);
      expect(drawer, `${path}: the scrim must follow the drawer`).toBeLessThan(scrim);

      // And the button lives in the sticky app bar, not at the top of the
      // document — that is what makes it reachable at any scroll depth.
      const topbar = html.indexOf('<header class="topbar">');
      const content = html.indexOf('<div class="content">');
      expect(button, `${path}: the menu button must sit in the top app bar`)
        .toBeGreaterThan(topbar);
      expect(button, `${path}: the menu button must sit above the content`).toBeLessThan(content);

      // The control is named for a screen reader: the labels that operate it
      // carry an icon and a scrim between them, so the input holds the name.
      expect(html.slice(toggle, toggle + 200)).toContain('aria-label="Navigation menu"');
    }
  });

  it('needs no script to open, on a page that ships only the theme and ripple', async () => {
    const h = await harness();
    await h.signedIn();
    const html = await (await h.call('/admin')).text();

    // Neither shell script may be what opens the drawer: the markup names no
    // handler, and the two scripts that do ship are the shared pair.
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    expect(scripts.length, 'the shell ships the theme and ripple scripts only').toBe(2);
    for (const script of scripts) {
      expect(/\bsrc\s*=/i.test(script), 'no shell script may be loaded by src').toBe(false);
      expect(script, 'no script may drive the drawer').not.toContain('mw-nav');
    }
    expect(html, 'the drawer must not be opened by an inline handler').not.toMatch(/onclick=/i);
  });

  it('makes the drawer a hidden, off-canvas panel that the checkbox reveals', async () => {
    const h = await harness();
    await h.signedIn();
    const compact = compactShellBlock(styleOf(await (await h.call('/admin')).text()));

    // Off-canvas and out of the tab order when closed. visibility is the half
    // that matters and the half that is easy to drop: a panel that is merely
    // translated away is still focusable, so a keyboard walks into a drawer
    // nobody can see.
    expect(compact).toContain('transform:translateX(-100%)');
    expect(compact, 'the closed drawer must leave the tab order').toContain('visibility:hidden');
    expect(compact).toContain('.nav-toggle:checked~.side{transform:none;visibility:visible}');
    expect(compact).toMatch(/\.nav-toggle:checked~\.nav-scrim\{[^}]*visibility:visible/);

    // The panel is fixed above the savebar (20) and the layers popover (30),
    // and below the layout editor's modal dialog (50).
    expect(compact).toMatch(/\.side\{[^}]*position:fixed/);
    expect(compact).toMatch(/\.side\{[^}]*z-index:41/);
    expect(compact).toMatch(/\.nav-scrim\{[^}]*z-index:40/);

    // The toggle stays focusable at this width — invisible, never display:none,
    // which would take it out of the tab order and leave the button keyboard-dead.
    expect(compact).toMatch(/\.nav-toggle\{[^}]*display:block/);
    expect(compact).toMatch(/\.nav-toggle\{[^}]*opacity:0/);
    // Its ring is drawn on the label instead, since the input itself is invisible.
    expect(compact).toContain('.nav-toggle:focus-visible~.main .navbtn');
  });

  it('stops flattening the drawer, so the headings, pills and foot survive', async () => {
    const h = await harness();
    await h.signedIn();
    const compact = compactShellBlock(styleOf(await (await h.call('/admin')).text()));

    // Each of these is a rule the old compact block carried, and each one is a
    // thing a household lost on a phone. They are asserted as absences because
    // the absence *is* the fix — reinstating any of them would read as tidying.
    expect(compact, 'the group headings must not be hidden').not.toContain('.nav-group>span{display:none}');
    expect(compact, 'the foot — sign-out and the theme toggle — must not be hidden')
      .not.toContain('.side-foot{display:none}');
    expect(compact, 'the drawer must not wrap into a field of pills').not.toContain('flex-wrap:wrap');
    expect(compact, 'the pills must keep their 56px height').not.toContain('.nav-item{height:40px');
    expect(compact, 'the drawer must not return to the flow as a header')
      .not.toMatch(/\.side\{[^}]*position:static/);
  });

  it('gives the menu button a 48px pointer target', async () => {
    const h = await harness();
    await h.signedIn();
    const compact = compactShellBlock(styleOf(await (await h.call('/admin')).text()));

    // 40px visual, 48px target from the ::after extension every control under
    // 48px uses — and position:relative, because a <label> gets none of the
    // `button,.btn` anatomy that would otherwise supply it.
    expect(compact).toMatch(/\.navbtn\{[^}]*position:relative/);
    expect(compact).toMatch(/\.navbtn::after\{[^}]*width:48px;height:48px/);
  });

  it('resets the margin the generic label rule would give the scrim and button', async () => {
    const h = await harness();
    await h.signedIn();
    const compact = compactShellBlock(styleOf(await (await h.call('/admin')).text()));

    // Both controls are <label>, so they inherit `label{margin:1rem 0 .35rem}`
    // from the form styles. On the scrim that is not cosmetic: a fixed inset:0
    // sheet with a top margin sits 16px clear of the top of the viewport, and
    // that strip lies across the app bar — a tap there goes to the page behind
    // an open drawer instead of closing it. Measured in a browser, not read.
    expect(compact).toMatch(/\.nav-scrim\{[^}]*margin:0/);
    expect(compact).toMatch(/\.navbtn\{[^}]*margin:0/);
  });

  it('draws none of it on the wizard or sign-in, which have no shell', async () => {
    const h = await harness();

    await h.call(`/setup?token=${h.setupToken.current().token}`);
    const wizard = await (await h.call('/setup')).text();
    expect(wizard).not.toContain('mw-nav');
    expect(wizard).not.toContain('class="navbtn"');

    const signIn = await (await h.call('/admin/sign-in')).text();
    expect(signIn).not.toContain('mw-nav');
    expect(signIn).not.toContain('class="navbtn"');
  });
});

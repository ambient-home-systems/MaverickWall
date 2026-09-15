import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { install, type Installation } from './browser-harness.js';

/**
 * The card grid, and nothing after it: the revoked disclosure under the grid
 * carries `destructive()`'s GET forms, which are exactly the `<form>` and
 * `<button>` the grid must not.
 */
function gridOf(html: string): string {
  const start = html.indexOf('<div class="grid g2">');
  expect(start, 'no card grid on the page').toBeGreaterThan(-1);
  const ends = ['<details class="disclose wall-revoked">', '</main>']
    .map((marker) => html.indexOf(marker, start))
    .filter((at) => at > -1);
  return html.slice(start, Math.min(...ends));
}

/** Every card's trailing control — the anchors wearing `.btn` inside the head. */
function controlsOf(grid: string): string[] {
  return [...grid.matchAll(/<a class="btn[^"]*" href="[^"]*">[^<]*<\/a>/g)].map((m) => m[0]);
}

/**
 * The Walls list is one list, and the sidebar is grouped by subject.
 *
 * Both were reviewed on a real screen and found otherwise. The Walls list drew
 * three card shapes — the Default wall as a link, a browser wall as a link with
 * a status dot, an e-paper panel as a static `<article>` with a ⋮ and an
 * "Arrange layout" button — because a panel had no page to open, so its card
 * had to be the page. And the sidebar put the Store, and every installed
 * module, under "Walls"; Overview under "Content"; and "System" as a group of
 * one item called System, with the group's label repeated over every page as
 * a kicker that read as a breadcrumb ("Walls / Walls").
 *
 * These walk the markup a household receives rather than the builders, the way
 * `admin-button-anatomy.test.ts` does, because the fault both times was in what
 * the page composed, not in any one piece.
 *
 * **One assertion here changed its letter and not its intent (RFC 016 §5.1).**
 * It used to pin the card as a bare `<a class="card wall-card">` with no
 * `<article>` and no `<button>` in the grid — the shape that replaced the
 * panel's static card and its ⋮ — and read "Last seen never" on both cards. A
 * card carries a control now, for a wall nothing has ever used, and a control
 * inside an `<a>` is invalid HTML and an element the keyboard cannot reach; so
 * the card is `card()`'s `<article>` with the name's own link stretched over
 * it, which is `listRow`'s anatomy one component along. What the assertion
 * *meant* — a card is not a control panel, and a panel's actions live on its
 * page — is held more precisely than before: still no ⋮, no `<form>`, no
 * "Arrange layout", and **at most one trailing control on a card, only on a
 * not-yet-paired one, from a fixed set of two**, each a link to the page where
 * the act lives. "Last seen never" went with phase 0, which retired the string.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A fresh client address per harness: the auth rate limiter's counters are
// module-global and outlive an app, so a shared address 429s a later harness.
let clientNumber = 0;
const nextClientAddress = (): string => `10.23.23.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wallslist-'));
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
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
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

  const text = async (path: string): Promise<string> => (await call(path)).text();
  const screenId = (kind: string): string =>
    (db.prepare(`SELECT id FROM screens WHERE kind = ? AND revoked_at IS NULL`).get(kind) as { id: string }).id;
  return { db, call, form, text, screenId };
}

/** Every `<div class="nav-group">…</div>` as its heading and its item labels. */
function navGroups(html: string): { label: string | null; items: string[] }[] {
  const nav = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));
  return [...nav.matchAll(/<div class="nav-group">([\s\S]*?)<\/div>/g)].map((m) => {
    const body = m[1] ?? '';
    const heading = body.match(/^<span>([^<]*)<\/span>/);
    return {
      label: heading === null ? null : heading[1]!,
      items: [...body.matchAll(/<span class="nav-name">([^<]*)<\/span>/g)].map((i) => i[1]!),
    };
  });
}

describe('the Walls list is one card shape for every kind of wall', () => {
  it('draws the Default wall, a browser wall and an e-paper panel as the same link card', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const html = await h.text('/admin/walls');
    const grid = gridOf(html);

    /*
     * Two walls, two cards of one shape, and nothing else in the grid: no ⋮
     * menu, no form, no button — the panel's actions live on its page.
     *
     * It was three, and the third was the Default wall — a card for the shared
     * household row, which is not a device: nothing is paired to it and nothing
     * draws it, so a household counting their walls counted one that does not
     * exist. It is retired; what it held is on System (the settings every wall
     * inherits) and on the walls themselves (the canvas they fell back to).
     */
    expect(grid.match(/<article class="card[^"]*wall-card"/g)?.length).toBe(2);
    expect(grid).not.toContain('class="ovf');
    expect(grid).not.toContain('<button');
    expect(grid).not.toContain('<form');
    expect(grid).not.toContain('Arrange layout');
    // Every card opens its wall's own page — a panel's is its layout page —
    // through the name's own link, stretched over the card.
    expect(grid, 'the Default wall is back on the list').not.toContain(`href="admin/walls/default"`);
    expect(grid).toContain(`<a class="wall-link" href="admin/walls/${h.screenId('browser')}">`);
    expect(grid).toContain(`<a class="wall-link" href="admin/epaper/${h.screenId('epaper')}/design">`);
    /*
     * At most one trailing control per card, only on a not-yet-paired card,
     * and from a fixed set — a link to the page where the act lives (RFC 016
     * §3.3, §5.1). Both of these walls are not yet paired, so both carry one
     * and neither says "Open"; the fresh and stale cards are driven below.
     */
    expect(controlsOf(grid)).toEqual([
      `<a class="btn btn-ghost btn-sm" href="admin/epaper/${h.screenId('epaper')}">Set up the device</a>`,
      `<a class="btn btn-ghost btn-sm" href="admin/walls/${h.screenId('browser')}">Pair it</a>`,
    ]);
    expect(grid).not.toContain('class="card-go">Open');
    // Both kinds carry a kind tag, and every card on the list is now a real
    // device that can have one.
    expect(grid).toContain('<span class="tag">Browser</span>');
    expect(grid).toContain('<span class="tag">E-paper</span>');
    // The literal moved and the two cards did not (RFC 016 phase 0): the line
    // is `presence`'s words now, one per kind, where "Last seen never" was one
    // sentence for a link nobody opened and a wall that drew once and stopped.
    // Named in list order (Hall before Kitchen) rather than counted, because a
    // count of an alternation stays at two if both kinds say the same thing.
    expect(grid.match(/Not paired yet|Waiting for its device/g)).toEqual(['Waiting for its device', 'Not paired yet']);
    expect(grid).toContain('800×480');
  });

  it('offers the two doors and the rare third as buttons, and not as prose', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    const html = await h.text('/admin/walls');
    /*
     * Both doors used to be `<a class="link">` inside a `<p class="hint">`,
     * set in the body role in the middle of the prose explaining them and
     * below every card on the page (RFC 016 §2.1); the approve form was a
     * whole section at the foot (§2.4). Three buttons in one row now, at the
     * three emphases the sheet declares, each wearing `.btn` beside its
     * variant — `admin-button-anatomy` is what holds every anchor to that.
     */
    const row = html.slice(html.indexOf('<div class="wall-actions">'), html.indexOf('</div>', html.indexOf('<div class="wall-actions">')));
    expect(row).toContain('<a class="btn" href="admin/walls/new">Pair a browser wall</a>');
    expect(row).toContain('<a class="btn btn-tonal" href="admin/epaper#add">Add an e-paper panel</a>');
    expect(row).toContain('<a class="btn btn-ghost" href="admin/screens/approve">Approve a pairing code</a>');
    // The row sits above the grid, not under it.
    expect(html.indexOf('<div class="wall-actions">')).toBeLessThan(html.indexOf('<div class="grid g2">'));
    // And the prose, the section and its field are gone.
    expect(html).not.toContain('Pair a new wall');
    expect(html).not.toContain('Add an e-paper wall');
    expect(html).not.toContain('<h2>Approve a pairing code</h2>');
    expect(html).not.toContain('name="code"');
    expect(html).not.toContain('<h2>Add a wall</h2>');
    // The link it demotes to still draws the form.
    expect(await h.text('/admin/screens/approve')).toContain('name="code"');
  });

  it('draws an empty state whose action is the first door, with no walls', async () => {
    const h = await harness();
    const html = await h.text('/admin/walls');
    expect(html).toContain('<div class="mw-empty">');
    expect(html).toContain('<a class="btn" href="admin/walls/new">Pair a browser wall</a>');
    expect(html).not.toContain('<div class="grid g2">');
    expect(html).not.toContain('class="wall-summary"');
    expect(html).not.toContain('No walls paired yet. Add one below');
  });

  it('folds the revoked walls into a closed disclosure, and draws none when there are none', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    await h.form('/admin/screens', { name: 'Old hall', theme: 'panels' });
    const before = await h.text('/admin/walls');
    expect(before).not.toContain('wall-revoked');
    expect(before).not.toContain('kept for the record');

    const old = (h.db.prepare(`SELECT id FROM screens WHERE name = 'Old hall'`).get() as { id: string }).id;
    await h.form(`/admin/screens/${old}/revoke`, {});
    const html = await h.text('/admin/walls');
    // Closed by default — the page is unchanged for a household not looking.
    expect(html).toContain('<details class="disclose wall-revoked"><summary>1 unpaired wall kept for the record</summary>');
    expect(html).not.toContain('<details class="disclose wall-revoked" open');
    // Under the grid, not in it.
    expect(html.indexOf('<div class="grid g2">')).toBeLessThan(html.indexOf('<details class="disclose wall-revoked">'));
    expect(gridOf(html)).not.toContain('Old hall');
    // Each revoked wall is a row with its name, when it was unpaired, and a
    // Forget that leads to a confirmation rather than acting.
    const open = html.indexOf('<details class="disclose wall-revoked">');
    const details = html.slice(open, html.indexOf('</details>', open));
    expect(details).toContain('<b>Old hall</b>');
    expect(details).toContain('Browser · unpaired just now');
    expect(details).toContain(`<form method="get" action="admin/screens/${old}/forget">`);
    expect(details).toContain('aria-label="Forget Old hall">Forget…</button>');
    // One revoked wall is not a "Forget all".
    expect(details).not.toContain('admin/screens/forget-revoked');
    // Two are.
    await h.form('/admin/screens', { name: 'Older hall', theme: 'panels' });
    const older = (h.db.prepare(`SELECT id FROM screens WHERE name = 'Older hall'`).get() as { id: string }).id;
    await h.form(`/admin/screens/${older}/revoke`, {});
    const two = await h.text('/admin/walls');
    expect(two).toContain('<summary>2 unpaired walls kept for the record</summary>');
    expect(two).toContain('<form method="get" action="admin/screens/forget-revoked">');
    expect(two).toContain('aria-label="Forget all unpaired walls">Forget all…</button>');
  });

  it("gives an e-paper panel a page of its own, which carries what the card used to", async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    // The canonical wall route still lands a panel on the same page.
    const opened = await h.call(`/admin/walls/${id}`);
    expect(opened.status).toBe(302);
    expect(opened.headers.get('location')).toBe(`/admin/epaper/${id}/design`);

    const page = await h.text(`/admin/epaper/${id}/design`);
    // The way back, in the app bar, as the browser wall's page has it.
    expect(page).toContain('class="crumb crumb-back" href="admin/walls"');
    // The ⋮ the list card used to carry: the recipes, and a confirmed Remove.
    expect(page).toContain(`href="admin/epaper/${id}"`);
    expect(page).toContain(`action="admin/epaper/${id}/delete"`);
    expect(page).toContain('Never connected');
    // And the recipes page is nested under the panel, not floating.
    const recipes = await h.text(`/admin/epaper/${id}`);
    expect(recipes).toContain(`class="crumb crumb-back" href="admin/walls/${id}"`);
  });

  it("shapes a panel's page like a browser wall's: two tabs, one frame, the inspector beside the canvas", async () => {
    const h = await harness();
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    const page = await h.text(`/admin/epaper/${id}/design`);
    // Headed by the panel, as a wall's page is headed by the wall.
    expect(page).toContain('<h1>Hall panel</h1>');
    // The same mode bar: Layout and the panel's own settings, wired by the
    // same chrome the browser wall's page loads.
    expect(page).toContain('data-mode="layout"');
    expect(page).toContain('data-mode="settings"');
    expect(page).toContain('Panel settings');
    expect(page).toContain('data-mode-panel="settings"');
    // One frame: the editor's backdrop. No second copy in a Preview section.
    expect(page).toContain('id="layout-editor"');
    expect(page).not.toContain('id="ep-preview"');
    expect(page).not.toContain('<h2>Preview</h2>');
    // The inspector is the same host the wall gives the editor, beside the
    // canvas, not a card under it.
    expect(page).toContain('<aside class="lay-inspector" id="wall-inspector"');
    // The panel's settings are on the page: what it draws, its network
    // switch (which used to live on the recipes page), and the way to those.
    expect(page).toContain('name="source"');
    expect(page).toContain('name="lan_only"');
    expect(page).toContain(`href="admin/epaper/${id}"`);
    // The recipes page no longer carries the switch: one control per setting.
    expect(await h.text(`/admin/epaper/${id}`)).not.toContain('name="lan_only"');
  });

  it('gives a following panel the preview and the settings, and no editor to fork the wall with', async () => {
    const h = await harness();
    // A real wall to follow: `follow:default` pointed at the shared Default
    // wall, which is retired — a panel follows a wall a household actually has.
    await h.form('/admin/screens', { name: 'Kitchen', theme: 'panels' });
    const wall = h.screenId('browser');
    await h.form('/admin/epaper', { name: 'Hall panel', preset: 'seeed-7in5', rotation: '0' });
    const id = h.screenId('epaper');
    await h.form(`/admin/epaper/${id}/source`, { source: `follow:${wall}` });
    const page = await h.text(`/admin/epaper/${id}/design`);
    expect(page).toContain('id="ep-preview"');
    expect(page).not.toContain('id="layout-editor"');
    expect(page).not.toContain('id="savebar"');
    // No tabs without the chrome to drive them: both parts are on the page.
    expect(page).not.toContain('data-mode="settings"');
    expect(page).toContain('name="source"');
    expect(page).toContain('name="lan_only"');
  });
});

describe('the sidebar is grouped by subject', () => {
  it('puts Overview and System alone, and the Store with the integrations', async () => {
    const h = await harness();
    // An installed module has to land beside Weather and Home Assistant, not
    // under Walls, which is where it used to appear.
    await h.form('/admin/modules/install/outside-temperature', { name: 'Outside temperature' });
    const groups = navGroups(await h.text('/admin/calendars'));
    expect(groups).toEqual([
      { label: null, items: ['Overview'] },
      { label: 'Household', items: ['Calendars', 'People', 'Work Schedule', 'Chores'] },
      { label: 'Integrations', items: ['Weather', 'Home Assistant', 'Outside temperature', 'Store'] },
      { label: 'Walls', items: ['Walls', 'Themes'] },
      { label: null, items: ['System'] },
    ]);
  });

  it('never labels a group with the name of its only item', async () => {
    const h = await harness();
    for (const group of navGroups(await h.text('/admin'))) {
      if (group.items.length === 1) expect(group.label).toBeNull();
    }
  });

  it('draws no kicker over a top-level page, and keeps the back link on a nested one', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet', theme: 'panels' });
    for (const path of ['/admin', '/admin/walls', '/admin/modules', '/admin/system']) {
      const html = await h.text(path);
      // The bar used to print the nav group's label here — "Walls" over the
      // Walls page, "Content" over the Overview — which read as a breadcrumb.
      expect(html, path).not.toContain('<div class="crumb">');
      expect(html, path).not.toContain('crumb-back');
    }
    const wall = await h.text(`/admin/walls/${h.screenId('browser')}`);
    expect(wall).toContain('class="crumb crumb-back" href="admin/walls"');
  });
});

/*
 * The three states, driven through the real app under the pinned clock
 * (RFC 016 §7). `install()` from `browser-harness` pins the app's `now` to
 * `HARNESS_HOUR`, which is what makes the middle case reachable: a wall
 * touched by a real `/d/manifest` poll is stamped on that clock (phase 0), and
 * a page comparing it against the same clock reads "Drawing now". Each state
 * is checked against a wall *in* that state, because an assertion written
 * against null alone passes a page that draws one state for all three.
 */
describe('a card reads presence() for its state, and the summary line is that function counted', () => {
  let home: Installation;
  const DAY = 24 * 60 * 60_000;

  beforeAll(async () => {
    home = await install();
  }, 120_000);
  afterAll(async () => {
    await home?.dispose();
  });

  const idNamed = (name: string): string =>
    (home.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;
  const cardNamed = (grid: string, name: string): string => {
    const cards = grid.split('<article class="card').slice(1).map((c) => '<article class="card' + c);
    const found = cards.find((c) => c.includes(`>${name}</a>`));
    expect(found, `no card for ${name}`).toBeDefined();
    return found as string;
  };

  it('draws the not-yet-paired, the fresh and the stale wall each as itself', async () => {
    // Not yet paired: a link nobody has opened.
    await home.pairWall('Attic');
    // Fresh: paired and polled a moment ago, through the real manifest route.
    const link = await home.pairLink('Kitchen');
    const token = new URL(link).searchParams.get('token') ?? '';
    const polled = await home.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } });
    expect(polled.status).toBe(200);
    // Stale: drew once, a month ago, on the app's own clock.
    await home.pairWall('Hall');
    home.db.prepare('UPDATE screens SET last_seen_at = ?, last_seen_ip = ? WHERE id = ?')
      .run(home.now() - 30 * DAY, '10.0.0.4', idNamed('Hall'));
    // And a panel nothing has fetched.
    const made = await home.post('/admin/epaper', { name: 'Porch', preset: 'seeed-7in5', rotation: '0' });
    expect(made.status).toBe(303);

    const html = await (await home.call('/admin/walls')).text();
    const grid = gridOf(html);

    const attic = cardNamed(grid, 'Attic');
    expect(attic).toContain('<article class="card is-warn wall-card">');
    expect(attic).toContain('<span class="dot dot-idle"></span>Not paired yet');
    expect(attic).toContain(`<a class="btn btn-ghost btn-sm" href="admin/walls/${idNamed('Attic')}">Pair it</a>`);
    expect(attic).not.toContain('class="card-go">Open');

    const kitchen = cardNamed(grid, 'Kitchen');
    expect(kitchen).toContain('<article class="card wall-card">');
    expect(kitchen).toContain('<span class="dot dot-ok pulse"></span>Drawing now');
    expect(kitchen).toContain('class="card-go">Open');
    expect(kitchen).not.toContain('class="btn');

    const hall = cardNamed(grid, 'Hall');
    expect(hall).toContain('<article class="card wall-card">');
    expect(hall).toContain('<span class="dot dot-idle"></span>Not seen recently · last seen 30 days ago from 10.0.0.4');
    expect(hall).toContain('class="card-go">Open');
    expect(hall).not.toContain('class="btn');

    const porch = cardNamed(grid, 'Porch');
    expect(porch).toContain('<article class="card is-warn wall-card">');
    expect(porch).toContain('Waiting for its device');
    expect(porch).toContain(`<a class="btn btn-ghost btn-sm" href="admin/epaper/${idNamed('Porch')}">Set up the device</a>`);

    // The whole grid: exactly two controls, both on not-yet-paired cards.
    expect(controlsOf(grid)).toHaveLength(2);
    expect(grid.match(/class="card-go">Open/g)?.length).toBe(2);

    // And the summary is those four readings counted, in that order.
    expect(html).toContain(
      '<p class="wall-summary">' +
        '<span><span class="dot dot-ok"></span>1 wall drawing now</span><span aria-hidden="true">·</span>' +
        '<span><span class="dot dot-idle"></span>1 not paired yet</span><span aria-hidden="true">·</span>' +
        '<span><span class="dot dot-idle"></span>1 panel waiting for its device</span><span aria-hidden="true">·</span>' +
        '<span><span class="dot dot-idle"></span>1 not seen for 30 days</span>' +
        '</p>',
    );
    expect(html.indexOf('class="wall-summary"')).toBeLessThan(html.indexOf('<div class="grid g2">'));
  });

  it('draws no summary line over one wall, and one over two', async () => {
    const alone = await install();
    try {
      await alone.pairWall('Only');
      expect(await (await alone.call('/admin/walls')).text()).not.toContain('wall-summary');
      await alone.pairWall('Second');
      const two = await (await alone.call('/admin/walls')).text();
      expect(two).toContain('<p class="wall-summary"><span><span class="dot dot-idle"></span>2 not paired yet</span></p>');
    } finally {
      await alone.dispose();
    }
  }, 120_000);
});

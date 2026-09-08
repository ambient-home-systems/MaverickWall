import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { PANEL_TEMPLATES } from '../src/templates/index.js';

/**
 * The template gallery, for a panel and for a wall — driven through the real app.
 *
 * Reported by a household: "eInk displays don't have templates, when you click
 * templates it shows the browser wall templates instead". It did. `Templates`
 * on a panel's toolbar is the *only* route to the gallery there (a panel's page
 * has no overflow menu), and what it opened was thirteen colour wall
 * arrangements previewed on a portrait 9:16 canvas, over an offer to copy a
 * wall's layout onto an 800x480 black-and-white device.
 *
 * So the gallery is two galleries, and the assertions here are the split's four
 * halves: which cards a panel is shown, which it may *apply* (the page is a
 * convenience and the POST is the boundary — rule five), what shape the applied
 * canvas is written at, and which displays it may copy from. The wall's own
 * gallery is asserted unchanged beside each, because a split that quietly
 * narrowed the wall would be the same bug facing the other way.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const B = 'http://localhost:8080';
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness(): Promise<{
  db: ReturnType<typeof openDatabase>['db'];
  call: (url: string, init?: RequestInit) => Promise<Response>;
  post: (url: string, fields: Record<string, string>) => Promise<Response>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-epgallery-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.9.0.${++nextAddress}`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(url, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (url: string, fields: Record<string, string>): Promise<Response> =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `epgal${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

/** Add an e-paper panel the way the sidebar's own form does, and return its id. */
async function addPanel(
  h: Awaited<ReturnType<typeof harness>>,
  name: string,
  preset = 'seeed-7in5',
): Promise<string> {
  await h.post(`${B}/admin/epaper`, { name, preset, rotation: '0' });
  const rows = h.db
    .prepare(`SELECT id FROM screens WHERE kind = 'epaper' AND name = ? LIMIT 1`)
    .all(name) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no panel row for ${name}`);
  return id;
}

/** Add a browser wall, which is what `add-screen` and the Walls form both make. */
async function addWall(h: Awaited<ReturnType<typeof harness>>, name: string): Promise<string> {
  await h.post(`${B}/admin/screens`, { name });
  const rows = h.db
    .prepare(`SELECT id FROM screens WHERE kind = 'browser' AND name = ? LIMIT 1`)
    .all(name) as { id: string }[];
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no wall row for ${name}`);
  return id;
}

const gallery = async (h: Awaited<ReturnType<typeof harness>>, owner: string): Promise<string> =>
  (await h.call(`${B}/admin/displays/${owner}/gallery`)).text();

describe('a panel’s template gallery', () => {
  it('offers the panel catalogue and none of the wall one', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const html = await gallery(h, panel);

    for (const template of PANEL_TEMPLATES) {
      expect(html, `${template.id} is missing`).toContain(`value="${template.id}"`);
    }
    // The wall's own cards, by the ids their apply forms carry. Named
    // individually rather than swept, so this stays a claim about *these*
    // cards being wrong here and does not go quiet if the wall list is renamed.
    for (const wallOnly of ['classic', 'sky-week', 'family-hub', 'ops-dashboard', 'reception']) {
      expect(html, `${wallOnly} is offered to a panel`).not.toContain(`value="${wallOnly}"`);
    }
  });

  it('names no theme, because a panel has none', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const html = await gallery(h, panel);
    // The exact sentence the wall gallery draws from a card's `theme`.
    expect(html).not.toContain('Looks best in');

    // And a *wall's* gallery still draws it — otherwise this passes by having
    // removed the line everywhere, which is a different change. A real wall,
    // since the shared Default one is retired.
    expect(await gallery(h, await addWall(h, 'Living room wall'))).toContain('Looks best in');
  });

  it('goes back to the panel’s design page, not to a wall page', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const html = await gallery(h, panel);
    // Relative, like every link here, so the single <base> carries it under
    // ingress — an absolute one would land a sidebar household in Home
    // Assistant's own UI.
    expect(html).toContain(`href="admin/epaper/${panel}/design"`);
    expect(html).not.toContain(`href="admin/walls/${panel}#layout"`);
  });

  it('previews each card as a real frame from the panel’s own renderer', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const html = await gallery(h, panel);
    /*
     * The endpoint, not a second renderer.
     *
     * The designer's Arrange backdrop already had to be fixed this way — it
     * drew a panel's canvas through the *wall* renderer, so a box dragged in it
     * landed somewhere else on the frame — and the cure was stated then: two
     * renderers disagreeing is the whole problem, so ask the one that draws the
     * device. A card gets the same treatment or it is the same bug on a
     * smaller picture.
     */
    expect(html).toContain(`admin/epaper/${panel}/preview.png`);
    // And the card is shaped like the panel rather than like a phone: 800x480,
    // carried as a custom property so the stylesheet keeps the rule.
    expect(html).toContain('--tpl-ar:800/480');
  });
});

describe('applying a template', () => {
  it('writes a panel’s canvas at the panel’s own aspect, not the card’s', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const applied = await h.post(`${B}/admin/displays/${panel}/apply-template`, {
      templateId: 'panel-built-in',
    });
    expect(applied.status).toBe(302);
    expect(applied.headers.get('location')).toBe(`/admin/epaper/${panel}/design?saved=layout-template-applied`);

    const row = h.db
      .prepare(`SELECT layout_aspect AS portrait, layout_landscape_aspect AS landscape FROM screens WHERE id = ?`)
      .get(panel) as { portrait: number; landscape: number };
    /*
     * 800/480 and 480/800 — the panel's own.
     *
     * **This pair cannot tell the override from its absence, and saying so is
     * the point.** The card is authored at the commonest panel's shape, so its
     * nominal 1.6667 and this panel's 1.66667 agree to five decimal places:
     * removing the override leaves these two lines green. They are here as the
     * ordinary "the canvas was written" check, and the panel below — a 4.2"
     * screen at 400x300, where the two genuinely differ — is the one that goes
     * red for it. Confirmed by reverting the override and watching exactly one
     * of the two tests fail.
     */
    expect(row.landscape).toBeCloseTo(800 / 480, 4);
    expect(row.portrait).toBeCloseTo(480 / 800, 4);

    const widgets = h.db
      .prepare(`SELECT COUNT(*) AS n FROM layout_widgets WHERE screen_id = ? AND orientation = 'landscape'`)
      .get(panel) as { n: number };
    // By id rather than by position: this applied `panel-built-in`, and reading
    // the count off whatever happens to lead the list made it a test about
    // gallery order. It broke the day Blank took the front of it.
    const builtIn = PANEL_TEMPLATES.find((one) => one.id === 'panel-built-in');
    expect(builtIn).toBeDefined();
    expect(widgets.n).toBe(builtIn!.landscape.widgets.length);
  });

  it('takes the aspect from a panel whose shape is not the card’s', async () => {
    const h = await harness();
    // A 4.2" panel is 400x300 — 1.3333, nothing like the card's nominal 1.6667.
    const panel = await addPanel(h, 'Odd panel', 'waveshare-4in2');
    await h.post(`${B}/admin/displays/${panel}/apply-template`, { templateId: 'panel-month' });
    const row = h.db
      .prepare(`SELECT layout_aspect AS portrait, layout_landscape_aspect AS landscape FROM screens WHERE id = ?`)
      .get(panel) as { portrait: number; landscape: number };
    expect(row.landscape).toBeCloseTo(400 / 300, 4);
    expect(row.portrait).toBeCloseTo(300 / 400, 4);
  });

  it('refuses a wall template posted at a panel, and a panel template posted at a wall', async () => {
    /*
     * The page offers the right list; this is the boundary underneath it.
     *
     * Without the two lookups being separate, the split would be cosmetic — a
     * hand-posted `sky-week` would put a colour wall arrangement on one bit,
     * which is the thing the whole split exists to stop. Both directions,
     * because a rule enforced one way round is half a rule.
     */
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');

    const wallOnPanel = await h.post(`${B}/admin/displays/${panel}/apply-template`, { templateId: 'sky-week' });
    expect(wallOnPanel.status).toBe(400);
    expect(
      h.db.prepare(`SELECT COUNT(*) AS n FROM layout_widgets WHERE screen_id = ?`).get(panel),
    ).toEqual({ n: 0 });

    // At a real wall: `default` is no longer an owner at all, so posting there
    // would be refused for the wrong reason and prove nothing about the split.
    const wall = await addWall(h, 'Living room wall');
    const panelOnWall = await h.post(`${B}/admin/displays/${wall}/apply-template`, {
      templateId: 'panel-built-in',
    });
    expect(panelOnWall.status).toBe(400);

    // And each still applies where it belongs, or the refusals above are being
    // produced by something other than the catalogue split.
    expect((await h.post(`${B}/admin/displays/${panel}/apply-template`, { templateId: 'panel-month' })).status).toBe(302);
    expect((await h.post(`${B}/admin/displays/${wall}/apply-template`, { templateId: 'sky-week' })).status).toBe(302);
  });
});

describe('copying another display’s layout', () => {
  it('offers a panel only other panels', async () => {
    const h = await harness();
    const kitchen = await addPanel(h, 'Kitchen panel');
    const hall = await addPanel(h, 'Hall panel');
    const wall = await addWall(h, 'Living room wall');

    const html = await gallery(h, kitchen);
    expect(html).toContain(`value="${hall}"`);
    expect(html, 'a wall is offered as a copy source for a panel').not.toContain(`value="${wall}"`);
    expect(html, 'the retired default wall is offered as a copy source').not.toContain('value="default"');
    // The heading says which, so the list is not silently shorter than it reads.
    expect(html).toContain("Or copy another panel's layout");
  });

  it('refuses a cross-kind copy at the POST, not only in the form', async () => {
    const h = await harness();
    const panel = await addPanel(h, 'Kitchen panel');
    const wall = await addWall(h, 'Living room wall');
    // Seed the wall with something, so a successful copy would be visible.
    await h.post(`${B}/admin/displays/${wall}/apply-template`, { templateId: 'sky-week' });

    const copied = await h.post(`${B}/admin/displays/${panel}/copy-from`, { sourceOwner: wall });
    expect(copied.status).toBe(400);
    expect(await copied.text()).toContain('follow');
    expect(
      h.db.prepare(`SELECT COUNT(*) AS n FROM layout_widgets WHERE screen_id = ?`).get(panel),
    ).toEqual({ n: 0 });

    // A panel-to-panel copy is the case this must not have broken.
    const hall = await addPanel(h, 'Hall panel');
    await h.post(`${B}/admin/displays/${hall}/apply-template`, { templateId: 'panel-month' });
    expect((await h.post(`${B}/admin/displays/${panel}/copy-from`, { sourceOwner: hall })).status).toBe(302);
    expect(
      (h.db.prepare(`SELECT COUNT(*) AS n FROM layout_widgets WHERE screen_id = ?`).get(panel) as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it('still offers a wall every other wall', async () => {
    const h = await harness();
    const other = await addWall(h, 'Living room wall');
    const another = await addWall(h, 'Kitchen wall');
    const html = await gallery(h, other);
    // Real walls only. This used to assert `value="default"` — the shared
    // Default wall, which led the list as something to copy from and is now
    // retired.
    expect(html).toContain(`value="${another}"`);
    expect(html, 'the retired default wall is still a copy source').not.toContain('value="default"');
    expect(html).toContain("Or copy another wall's layout");
  });
});

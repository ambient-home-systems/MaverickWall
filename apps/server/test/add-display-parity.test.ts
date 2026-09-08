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
import { readLayoutWidgets } from '../src/api/queries.js';
import { TEMPLATES, PANEL_TEMPLATES } from '../src/templates/index.js';
import { WALL_SIZE_CUSTOM, WALL_SIZE_PRESETS, wallSizePreset } from '../src/wall-sizes.js';

/**
 * Adding a wall and adding a panel are one act with two doors, and this holds
 * the two doors to the same shape.
 *
 * They were not the same shape. A browser wall was a name field in a section of
 * the Walls list, straight to a QR; an e-paper panel was a page of its own
 * asking for a size and a rotation. So the commoner journey asked for the least
 * at the one moment the household is standing in front of the hardware with its
 * size in their hand, and neither offered the thing the whole layout system is
 * about — where the arrangement starts from.
 *
 * Everything here is driven through the real app with a real session, because
 * both faults this change fixes live in the seam between a form and a handler
 * rather than in either: what a browser actually posts (an absent field is not
 * an empty one), and what order the writes happen in (a canvas seeded before
 * the size is written reads three nulls and letterboxes).
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const B = 'http://localhost:8080';

const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface ScreenRow {
  readonly id: string;
  readonly rotation: number;
  readonly layoutMode: string | null;
  readonly layoutAspect: number | null;
  readonly layoutLandscapeAspect: number | null;
  readonly panelWidthMm: number | null;
  readonly panelHeightMm: number | null;
  readonly readDistanceMm: number | null;
}

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-addparity-'));
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
  const html = async (path: string): Promise<string> => (await call(`${B}${path}`)).text();

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `addparity${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });

  /** Every screen row this suite cares about, newest last. */
  const screens = (): ScreenRow[] =>
    db
      .prepare(
        `SELECT id, rotation,
                layout_mode AS layoutMode,
                layout_aspect AS layoutAspect,
                layout_landscape_aspect AS layoutLandscapeAspect,
                panel_width_mm AS panelWidthMm,
                panel_height_mm AS panelHeightMm,
                read_distance_mm AS readDistanceMm
           FROM screens ORDER BY created_at, rowid`,
      )
      .all() as ScreenRow[];
  const newest = (): ScreenRow => {
    const all = screens();
    const last = all[all.length - 1];
    expect(last, 'no screen was created').toBeDefined();
    return last as ScreenRow;
  };
  const widgetTypes = (id: string): string[] =>
    readLayoutWidgets(db, id, 'portrait').map((widget) => widget.type);

  return { db, call, post, html, screens, newest, widgetTypes };
}

/** The `value="…"` of every option inside one named select, in document order. */
function optionsOf(html: string, name: string): string[] {
  const open = html.indexOf(`name="${name}"`);
  if (open === -1) return [];
  const start = html.lastIndexOf('<select', open);
  const end = html.indexOf('</select>', open);
  if (start === -1 || end === -1) return [];
  return [...html.slice(start, end).matchAll(/<option value="([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** Whether a form control by that name is on the page at all. */
const asks = (html: string, name: string): boolean => html.includes(`name="${name}"`);

describe('adding a wall and adding a panel are one shape', () => {
  /*
   * The parity claim itself, and it is deliberately about the *questions*
   * rather than about the markup: the two pages are different forms with
   * different vocabularies (a panel has a resolution, a wall has a physical
   * size), so holding them to identical HTML would be holding them to being one
   * page. What has to match is that each asks for a name, for what the hardware
   * is, for how it is mounted, and for where its layout starts — and that each
   * ends on its own pairing step rather than dropping the household back on a
   * list to go and find the thing they just made.
   */
  it('asks the same four questions on both add pages', async () => {
    const h = await harness();
    const wall = await h.html('/admin/walls/new');
    const panel = await h.html('/admin/epaper');

    for (const [kind, page] of [['wall', wall], ['panel', panel]] as const) {
      expect(asks(page, 'name'), `${kind}: no name field`).toBe(true);
      expect(asks(page, 'rotation'), `${kind}: no rotation`).toBe(true);
    }
    // What the hardware is, in each medium's own terms.
    expect(asks(wall, 'panel_size'), 'wall: no size').toBe(true);
    expect(asks(panel, 'preset'), 'panel: no panel picker').toBe(true);
    // Where the layout starts, which neither page asked before this.
    expect(asks(wall, 'template'), 'wall: no starting layout').toBe(true);
    expect(asks(panel, 'layout'), 'panel: no starting layout').toBe(true);
    // Both say the same thing about what the control is for.
    expect(wall).toContain('Starting layout');
    expect(panel).toContain('Starting layout');
  });

  it('reaches both add pages from the Walls list, and neither form is on it', async () => {
    const h = await harness();
    const list = await h.html('/admin/walls');
    expect(list).toContain('admin/walls/new');
    expect(list).toContain('admin/epaper#add');
    /*
     * The list must not still carry a name field of its own. Two ways to add a
     * wall — one of which asks for less — is the disjointedness this change is
     * about, and leaving the old form behind is exactly how it would come back.
     */
    expect(asks(list, 'name'), 'the old inline add form is still on the Walls list').toBe(false);
  });

  /*
   * Progressive disclosure on both pages degrades to the form that was there
   * before it — the rule `admin-chores.ts` states and the wall settings page
   * repeats: no group is rendered `hidden` server-side, so a household who
   * blocks script sees every field rather than a form with boxes they cannot
   * reach, and nothing inside one is `required`, because a required control a
   * script has hidden is a form a browser refuses and cannot explain.
   */
  it('reveals conditional fields with script and shows them all without it', async () => {
    const h = await harness();
    for (const [kind, page] of [
      ['wall', await h.html('/admin/walls/new')],
      ['panel', await h.html('/admin/epaper')],
    ] as const) {
      expect(page, `${kind}: no conditional group`).toContain('data-cond-show=');
      expect(page, `${kind}: the reveal script is not shipped`).toContain('conditional-fields.js');
      const groups = [...page.matchAll(/<(?:div|fieldset)[^>]*\bdata-cond-show=[^>]*>/g)].map(
        (match) => match[0],
      );
      expect(groups.length, `${kind}: no conditional group`).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group, `${kind}: a group ships hidden`).not.toMatch(/\bhidden\b/);
      }
    }
  });

  it('offers every template it ships, from the right catalogue, on each page', async () => {
    const h = await harness();
    expect(optionsOf(await h.html('/admin/walls/new'), 'template')).toEqual(
      TEMPLATES.map((one) => one.id),
    );
    /*
     * `builtin` leads the panel's list and is not a template id: a panel with
     * no canvas draws `renderEpaper`, whose measurements are arithmetic on the
     * panel, where `panel-built-in` is stored fractions approximating it. The
     * default has to be the real one.
     */
    expect(optionsOf(await h.html('/admin/epaper'), 'layout')).toEqual([
      'builtin',
      ...PANEL_TEMPLATES.map((one) => one.id),
    ]);
  });

  it('offers the wall size list the wall’s own settings page offers', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Kitchen' });
    const settings = await h.html(`/admin/walls/${h.newest().id}`);
    /*
     * A drift guard rather than a behaviour: both forms read
     * `WALL_SIZE_PRESETS`, so this fails only if one of them starts building
     * its own list — which is how the same question comes to have two answers
     * depending on which screen a household happened to be on.
     */
    const expected = ['', ...WALL_SIZE_PRESETS.map((one) => one.key), WALL_SIZE_CUSTOM];
    expect(optionsOf(await h.html('/admin/walls/new'), 'panel_size')).toEqual(expected);
    expect(optionsOf(settings, 'panel_size')).toEqual(expected);
  });
});

describe('adding a browser wall', () => {
  /*
   * The back-compatibility claim, and it is what makes every new field safe: a
   * body carrying nothing but a name has to create exactly the wall it created
   * before this page existed. Half the suite posts that body.
   */
  it('creates the same wall as before from a name alone', async () => {
    const h = await harness();
    const made = await h.post(`${B}/admin/screens`, { name: 'Kitchen' });
    expect(made.status).toBe(303);
    expect(made.headers.get('location')).toMatch(/\/admin\/walls\/[0-9a-f]+\/pair$/);

    const screen = h.newest();
    expect(screen.rotation).toBe(0);
    expect(screen.panelWidthMm).toBeNull();
    expect(screen.panelHeightMm).toBeNull();
    expect(screen.readDistanceMm).toBeNull();
    // Seeded with Classic, as it always was — never a blank editor.
    expect(h.widgetTypes(screen.id).length).toBeGreaterThan(0);
    expect(screen.layoutMode).toBe('freeform');
  });

  it('stores the size and the mounting the household gave it', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Hall', panel_size: 'tv-32', rotation: '90' });
    const screen = h.newest();
    const preset = wallSizePreset('tv-32');
    expect(preset).toBeDefined();
    /*
     * Swapped, because the columns hold the wall's way up and a preset's
     * numbers are the panel's own — a 32" television hung on its end is 398mm
     * across. `resolveWallSize` is the one place that decides, and this is it
     * decided through the add form rather than through the settings page.
     */
    expect(screen.rotation).toBe(90);
    expect(screen.panelWidthMm).toBe(preset?.heightMm);
    expect(screen.panelHeightMm).toBe(preset?.widthMm);
    // A preset brings its own reading distance when none was typed.
    expect(screen.readDistanceMm).toBe(preset?.readAtMm);
  });

  it('keeps a typed reading distance over the preset’s own', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Hall', panel_size: 'tv-32', read_distance_mm: '2500' });
    expect(h.newest().readDistanceMm).toBe(2500);
  });

  it('takes an entered size', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, {
      name: 'Odd one',
      panel_size: WALL_SIZE_CUSTOM,
      panel_width_mm: '321',
      panel_height_mm: '210',
      read_distance_mm: '900',
    });
    const screen = h.newest();
    expect([screen.panelWidthMm, screen.panelHeightMm, screen.readDistanceMm]).toEqual([321, 210, 900]);
  });

  it('starts from the template the household picked', async () => {
    const h = await harness();
    await h.post(`${B}/admin/screens`, { name: 'Study', template: 'minimal-clock' });
    const types = h.widgetTypes(h.newest().id);
    const wanted = TEMPLATES.find((one) => one.id === 'minimal-clock');
    expect(wanted).toBeDefined();
    expect(types).toEqual(wanted?.portrait.widgets.map((widget) => widget.type));
    // And it is not what a wall gets by default, or this proves nothing.
    const classic = TEMPLATES.find((one) => one.id === 'classic');
    expect(types).not.toEqual(classic?.portrait.widgets.map((widget) => widget.type));
  });

  /*
   * The ordering claim, and it is the one thing here that a reader of the
   * handler could get wrong without any test noticing: the hardware facts are
   * written before the canvas is seeded, because `seedAspects` reads the
   * millimetre columns off the row it is seeding. Written the other way round
   * this is the card's nominal 9:16 and the household has a letterbox on a wall
   * they just told us the shape of.
   */
  it('seeds the canvas at the wall’s own shape, not the card’s', async () => {
    const h = await harness();
    const preset = wallSizePreset('eink-13.3');
    expect(preset).toBeDefined();
    const long = Math.max(preset?.widthMm ?? 0, preset?.heightMm ?? 0);
    const short = Math.min(preset?.widthMm ?? 0, preset?.heightMm ?? 0);

    for (const template of ['classic', 'sky-week']) {
      await h.post(`${B}/admin/screens`, { name: `W ${template}`, panel_size: 'eink-13.3', template });
      const screen = h.newest();
      expect(screen.layoutAspect ?? 0, `${template} portrait`).toBeCloseTo(short / long, 4);
      expect(screen.layoutLandscapeAspect ?? 0, `${template} landscape`).toBeCloseTo(long / short, 4);
      // The card's own nominal aspect is the thing this must *not* be.
      const card = TEMPLATES.find((one) => one.id === template);
      expect(screen.layoutAspect, `${template} took the card's aspect`).not.toBe(card?.portrait.aspect);
    }
  });

  it('refuses a panel’s template at a wall, and makes no wall doing it', async () => {
    const h = await harness();
    const before = h.screens().length;
    const refused = await h.post(`${B}/admin/screens`, { name: 'Sneaky', template: 'panel-built-in' });
    expect(refused.status).toBe(400);
    expect(h.screens().length).toBe(before);
  });

  /*
   * Both refusal branches, because there are two and they are reached by
   * different bodies — and the first draft of this reached only one of them.
   * `panel_width_mm` was `'three hundred'`, thirteen characters against an
   * `optionalText(6)`, so it was refused by the *schema* and never touched
   * `resolveWallSize` at all: dropping the echo from the size branch left this
   * file green. A width of `'abc'` fits the shape and fails the meaning, which
   * is the only way to reach the second one.
   */
  it.each([
    ['refused by the shape', { panel_width_mm: 'far too long to be millimetres' }],
    ['refused by the meaning', { panel_width_mm: 'abc' }],
  ])('hands the typed body back when it is %s', async (_label, bad) => {
    const h = await harness();
    const refused = await h.post(`${B}/admin/screens`, {
      name: 'Nearly',
      panel_size: WALL_SIZE_CUSTOM,
      panel_height_mm: '210',
      read_distance_mm: '900',
      template: 'sky-week',
      ...bad,
    });
    expect(refused.status).toBe(400);
    const body = await refused.text();
    /*
     * Everything typed survives the sentence about the one thing that did not.
     * A form re-rendered from nothing is the fault the Weather screen already
     * paid for, and it costs more here: five fields rather than one.
     */
    expect(body, 'the name was thrown away').toContain('value="Nearly"');
    expect(body, 'the height was thrown away').toContain('value="210"');
    expect(body, 'the distance was thrown away').toContain('value="900"');
    expect(body, 'the size choice was thrown away').toMatch(
      new RegExp(`<option value="${WALL_SIZE_CUSTOM}" selected`),
    );
    expect(body, 'the template choice was thrown away').toMatch(/<option value="sky-week" selected/);
  });
});

describe('adding an e-paper panel', () => {
  /*
   * The default writes nothing, and that is the whole of it: a panel with no
   * canvas draws the built-in renderer, which is what Reset returns a panel to.
   * "Leave it as it is" at creation and "put it back" later are one state
   * rather than two that look alike.
   */
  it('leaves a Built-in panel with no canvas at all', async () => {
    const h = await harness();
    for (const fields of [
      { name: 'Tag A', preset: 'seeed-7in5', rotation: '0' },
      { name: 'Tag B', preset: 'seeed-7in5', rotation: '0', layout: 'builtin' },
    ]) {
      const made = await h.post(`${B}/admin/epaper`, fields);
      expect(made.status).toBe(303);
      const screen = h.newest();
      expect(screen.layoutMode, `${fields.name}: a canvas was written`).toBeNull();
      expect(h.widgetTypes(screen.id), `${fields.name}: widgets were written`).toEqual([]);
    }
  });

  it('starts from the panel template the household picked', async () => {
    const h = await harness();
    await h.post(`${B}/admin/epaper`, {
      name: 'Hallway',
      preset: 'seeed-7in5',
      rotation: '0',
      layout: 'panel-month',
    });
    const screen = h.newest();
    expect(screen.layoutMode).toBe('freeform');
    const wanted = PANEL_TEMPLATES.find((one) => one.id === 'panel-month');
    expect(wanted).toBeDefined();
    expect(h.widgetTypes(screen.id)).toEqual(wanted?.portrait.widgets.map((widget) => widget.type));
  });

  it('writes the canvas at the panel’s own resolution, not the card’s', async () => {
    const h = await harness();
    // 296x128, which is nothing like the 800x480 every panel card is authored at.
    await h.post(`${B}/admin/epaper`, {
      name: 'Shelf tag',
      preset: 'waveshare-2in9',
      rotation: '0',
      layout: 'panel-agenda',
    });
    const screen = h.newest();
    expect(screen.layoutAspect ?? 0).toBeCloseTo(128 / 296, 4);
    expect(screen.layoutLandscapeAspect ?? 0).toBeCloseTo(296 / 128, 4);
    const card = PANEL_TEMPLATES.find((one) => one.id === 'panel-agenda');
    expect(screen.layoutAspect, 'took the card’s nominal aspect').not.toBe(card?.portrait.aspect);
  });

  it('refuses a wall’s template at a panel, and makes no panel doing it', async () => {
    const h = await harness();
    const before = h.screens().length;
    const refused = await h.post(`${B}/admin/epaper`, {
      name: 'Sneaky',
      preset: 'seeed-7in5',
      rotation: '0',
      layout: 'sky-week',
    });
    expect(refused.status).toBe(400);
    expect(h.screens().length).toBe(before);
  });

  it('hands the typed body back when it refuses one field', async () => {
    const h = await harness();
    const refused = await h.post(`${B}/admin/epaper`, {
      name: 'Nearly',
      preset: 'custom',
      width: 'wide',
      height: '480',
      rotation: '180',
      layout: 'panel-week',
    });
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body, 'the name was thrown away').toContain('value="Nearly"');
    expect(body, 'the height was thrown away').toContain('value="480"');
    expect(body, 'the panel choice was thrown away').toMatch(/<option value="custom" selected/);
    expect(body, 'the rotation was thrown away').toMatch(/<option value="180" selected/);
    expect(body, 'the layout choice was thrown away').toMatch(/<option value="panel-week" selected/);
  });
});

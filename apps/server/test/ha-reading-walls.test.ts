import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { seedDefaultRules } from '../src/api/rules.js';
import { replaceLayout, revokeScreen, setPanelSource } from '../src/api/queries.js';
import { haReadingHandle } from '../src/api/manifest.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

/**
 * "Add to the wall" added nothing to a wall (P1.3), and the screens that add
 * readings and modules now say where each one actually is.
 *
 * Adding a Home Assistant reading watches an entity. What draws it is a Home
 * Assistant *widget* on a wall's layout, and Classic — which every wall starts
 * on — has none; so a household pressed "Add to the wall", read "Reading
 * added", saw the card appear under "On the wall", and found nothing on any
 * wall. The Store's recipe install said the same about a module only a Module
 * widget draws. Every one of those sentences was a claim about a wall that no
 * code had checked.
 *
 * So this file checks it against real walls, made through the doors a
 * household uses: `/admin/screens` seeds Classic exactly as it does for them,
 * which is the case the whole item is about, and the rows are read out of the
 * served page rather than out of the function that computes them. Then walls
 * are given layouts that exercise every place a reading can be drawn from —
 * the other orientation, a named layout the schedule swaps in, a panel's own
 * layout with its ink override, a panel following a wall — and two that must
 * not count: a revoked wall, and a panel following a wall whose widget is only
 * on a named layout, which a panel never draws.
 *
 * Against the real app with a real session and a real fake house, for the
 * reason `homeassistant.test.ts` gives.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly text: (path: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const address = `10.11.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ha-reach-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);
  seedDefaultRules(db);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
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
    name: 'Household',
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  return { db, call, form, text: async (path) => (await call(path)).text() };
}

async function connected(): Promise<Harness> {
  const h = await harness();
  const ha = await fakeHomeAssistant();
  const response = await h.form('/admin/home-assistant/connect', {
    base_url: ha.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
  expect(response.status).toBe(302);
  return h;
}

/** A wall made the way a household makes one, so it starts on Classic. */
async function addWall(h: Harness, name: string): Promise<string> {
  const response = await h.form('/admin/screens', { name, theme: 'panels' });
  // A 303 to the new wall's pairing page, which is the door's own answer.
  expect([302, 303]).toContain(response.status);
  return (h.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;
}

async function addPanel(h: Harness, name: string): Promise<string> {
  const response = await h.form('/admin/epaper', { name, preset: 'seeed-7in5', rotation: '0' });
  expect([302, 303]).toContain(response.status);
  return (h.db.prepare('SELECT id FROM screens WHERE name = ?').get(name) as { id: string }).id;
}

async function addReading(h: Harness, entityId: string, label: string): Promise<Response> {
  return h.form('/admin/home-assistant/entities', { entity_id: entityId, label, display_mode: 'label_value' });
}

/** One Home Assistant widget filling a canvas. */
function houseWidget(
  db: SqliteDatabase,
  screenId: string,
  orientation: 'portrait' | 'landscape',
  config: Record<string, unknown>,
  slot: string | null = null,
): void {
  replaceLayout(
    db,
    screenId,
    orientation,
    {
      mode: 'freeform',
      aspect: orientation === 'landscape' ? 1.7778 : 0.5625,
      widgets: [
        { id: `${screenId}-${orientation}-${slot ?? 'default'}`, type: 'homeassistant', x: 0, y: 0, w: 1, h: 1, z: 0, config },
      ],
      background: null,
    },
    slot,
  );
}

/** The tag each reading's card carries, keyed by the name the card is headed with. */
function shownOn(page: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const card of page.split('<article class="card').slice(1)) {
    const name = /<h2>([^<]*)<\/h2>/.exec(card)?.[1];
    const tagText = /class="tag[^"]*">([^<]*)</.exec(card)?.[1];
    if (name !== undefined && tagText !== undefined) out[name] = tagText;
  }
  return out;
}

describe('adding a reading', () => {
  it('says it is on no wall when every wall is on Classic, and says why once', async () => {
    const h = await connected();
    const kitchen = await addWall(h, 'Kitchen');
    const hall = await addWall(h, 'Hall');

    // The saved strip is the branch's own sentence, not "added to the wall".
    const added = await addReading(h, 'binary_sensor.freezer_door', 'Freezer');
    expect(added.headers.get('location')).toBe('/admin/home-assistant/readings?saved=ha-entity-added');

    const page = await h.text('/admin/home-assistant/readings?saved=ha-entity-added');
    expect(page).toContain('Reading added. No wall shows it yet');
    expect(shownOn(page)['Freezer']).toBe('Not on any wall yet');
    // One card explaining it, with a way to each wall's layout.
    expect(page).toContain('No wall shows readings yet');
    expect(page).toContain(`href="admin/walls/${kitchen}#layout"`);
    expect(page).toContain(`href="admin/walls/${hall}#layout"`);
    // And none of the copy that said otherwise.
    expect(page).toContain('<h2>Your readings</h2>');
    // The form that adds one is a page along since P2.1, under the same verb.
    expect(await h.text('/admin/home-assistant/readings/new')).toContain(
      '<button type="submit">Add reading</button>',
    );
    expect(page).not.toContain('On the wall');
    expect(page).not.toContain('Add to the wall');
  });

  it('points at adding a wall when there is no wall to add the widget to', async () => {
    const h = await connected();
    await addReading(h, 'binary_sensor.freezer_door', 'Freezer');
    const page = await h.text('/admin/home-assistant/readings');
    expect(page).toContain('No wall shows readings yet');
    // "Add", not "Pair" (P2.2): pairing is one step of adding a browser wall,
    // and an e-paper wall is never paired at all.
    expect(page).toContain('href="admin/walls/new">Add a wall</a>');
  });

  it('does not call a wall with the widget empty-handed before its first reading', async () => {
    /*
     * A Home Assistant widget is left off the wall while nothing is watched,
     * so asked of the house as it stands the card would tell a household with
     * the widget already placed that no wall has one — on the very screen
     * where they are about to add the reading it will draw. Beside a clock,
     * because a canvas whose every widget is left out keeps them all (rule
     * nine), which would hide exactly this.
     */
    const h = await connected();
    const kitchen = await addWall(h, 'Kitchen');
    replaceLayout(h.db, kitchen, 'portrait', {
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [
        { id: 'clock', type: 'clock', x: 0, y: 0, w: 1, h: 0.5, z: 0 },
        { id: 'house', type: 'homeassistant', x: 0, y: 0.5, w: 1, h: 0.5, z: 1, config: {} },
      ],
      background: null,
    });
    const page = await h.text('/admin/home-assistant/readings');
    expect(page).toContain('No readings yet.');
    expect(page).not.toContain('No wall shows readings yet');
  });

  it('says it is on the wall only when a wall already draws every reading', async () => {
    const h = await connected();
    const kitchen = await addWall(h, 'Kitchen');
    houseWidget(h.db, kitchen, 'portrait', {});
    const added = await addReading(h, 'binary_sensor.freezer_door', 'Freezer');
    expect(added.headers.get('location')).toBe('/admin/home-assistant/readings?saved=ha-entity-added-shown');
    const page = await h.text('/admin/home-assistant/readings?saved=ha-entity-added-shown');
    expect(page).toContain('Reading added — it is on the wall on its next refresh.');
    expect(shownOn(page)['Freezer']).toBe('On: Kitchen');
    // The card is for a house where no wall draws readings, and this one does.
    expect(page).not.toContain('No wall shows readings yet');
  });
});

describe('which walls a reading is on', () => {
  it('reads every canvas a wall draws, and nothing a wall does not', async () => {
    const h = await connected();
    // Created out of order, so the sentence's order is the list's rather than
    // the order they happened to be made in.
    const porch = await addWall(h, 'Porch');
    const kitchen = await addWall(h, 'Kitchen');
    const hall = await addWall(h, 'Hall');
    const attic = await addWall(h, 'Attic');
    const landing = await addPanel(h, 'Landing');
    const stairs = await addPanel(h, 'Stairs');
    await addReading(h, 'binary_sensor.freezer_door', 'Freezer');
    await addReading(h, 'sensor.kitchen_temperature', 'Kitchen temp');

    // Every reading, on the landscape canvas only: the other orientation counts.
    houseWidget(h.db, kitchen, 'landscape', {});
    // Only on the evening layout the schedule swaps in: a named layout counts.
    // On both orientations, so the panel following Hall below — which draws
    // landscape — would find it if a panel ever read a named layout.
    houseWidget(h.db, hall, 'portrait', { readings: ['binary_sensor.freezer_door'] }, 'evening');
    houseWidget(h.db, hall, 'landscape', { readings: ['binary_sensor.freezer_door'] }, 'evening');
    // Picked by label, as every widget saved before P1.3 picked it.
    houseWidget(h.db, porch, 'portrait', { readings: ['Kitchen temp'] });
    // A revoked wall is on nobody's wall, whatever its layout says.
    houseWidget(h.db, attic, 'portrait', {});
    revokeScreen(h.db, attic);
    // A panel's own layout, where its ink override is the list it draws.
    setPanelSource(h.db, landing, 'own', null);
    houseWidget(h.db, landing, 'landscape', {
      readings: ['binary_sensor.freezer_door'],
      ink: { readings: ['sensor.kitchen_temperature'] },
    });
    // A panel following Hall draws Hall's default layout — never a named one.
    setPanelSource(h.db, stairs, 'follow', hall);

    const rows = shownOn(await h.text('/admin/home-assistant/readings'));
    expect(rows['Freezer']).toBe('On: Hall, Kitchen');
    expect(rows['Kitchen temp']).toBe('On: Kitchen, Landing, Porch');
  });

  it('keeps a reading on its walls through a rename, and follows a label no further', async () => {
    const h = await connected();
    const kitchen = await addWall(h, 'Kitchen');
    const hall = await addWall(h, 'Hall');
    await addReading(h, 'sensor.kitchen_temperature', 'Kitchen temp');
    houseWidget(h.db, kitchen, 'portrait', { readings: ['sensor.kitchen_temperature'] });
    houseWidget(h.db, hall, 'portrait', { readings: ['Kitchen temp'] });
    expect(shownOn(await h.text('/admin/home-assistant/readings'))['Kitchen temp']).toBe('On: Hall, Kitchen');

    // Renamed: the id Kitchen stored still names it; the label Hall stored
    // named the old name, which is the fault an id is the cure for — and why
    // the editor writes ids the moment Hall's widget is next saved.
    await addReading(h, 'sensor.kitchen_temperature', 'Cooking');
    expect(shownOn(await h.text('/admin/home-assistant/readings'))['Cooking']).toBe('On: Kitchen');
  });
});

describe('the wall editor', () => {
  it('offers readings by entity id, and opens a widget that picked by label on the ids', async () => {
    /*
     * The picker's half of P1.3. It used to offer each reading's *label* and
     * write what it offered; it offers the entity id now, named the way the
     * wall names it, with the handle the preview needs beside it. And a widget
     * saved when it wrote labels opens with its boxes ticked — its entries read
     * as the readings they name, so the next save writes ids, which is the whole
     * migration — while an entry that names nothing is kept as it was rather
     * than quietly deleted by a page somebody only opened.
     */
    const h = await connected();
    const kitchen = await addWall(h, 'Kitchen');
    await addReading(h, 'sensor.kitchen_temperature', 'Kitchen temp');
    await addReading(h, 'binary_sensor.freezer_door', 'Freezer');
    houseWidget(h.db, kitchen, 'portrait', {
      readings: ['Kitchen temp', 'Gone for good'],
      ink: { readings: ['Freezer'] },
    });

    const html = await h.text(`/admin/walls/${kitchen}`);
    const json = /<div id="layout-editor" data-json="([^"]*)"/.exec(html)?.[1] ?? '';
    const initial = JSON.parse(
      json.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    ) as {
      readings?: { id: string; name: string; key: string }[];
      portrait?: { widgets?: { type: string; config?: Record<string, unknown> }[] };
    };
    expect(initial.readings).toEqual([
      { id: 'sensor.kitchen_temperature', name: 'Kitchen temp', key: haReadingHandle('sensor.kitchen_temperature') },
      { id: 'binary_sensor.freezer_door', name: 'Freezer', key: haReadingHandle('binary_sensor.freezer_door') },
    ]);
    const house = initial.portrait?.widgets?.find((widget) => widget.type === 'homeassistant');
    expect(house?.config?.['readings']).toEqual(['sensor.kitchen_temperature', 'Gone for good']);
    expect((house?.config?.['ink'] as { readings?: unknown })?.readings).toEqual(['binary_sensor.freezer_door']);
    // Read for the editor, not written: the stored row still says what it said.
    const stored = h.db
      .prepare(`SELECT config FROM layout_widgets WHERE screen_id = ? AND type = 'homeassistant'`)
      .get(kitchen) as { config: string };
    expect(JSON.parse(stored.config).readings).toEqual(['Kitchen temp', 'Gone for good']);
  });
});

describe('the Store', () => {
  it('installs a recipe with a button that says so, and says where its panel is', async () => {
    const h = await harness();
    const install = await h.text('/admin/modules/install/outside-temperature');
    expect(install).toContain('>Install</button>');
    expect(install).not.toContain('Add to the wall');

    const installed = await h.form('/admin/modules/install/outside-temperature', {
      name: 'Garden',
      cfg_lat: '51.5',
      cfg_lon: '-0.12',
    });
    expect(installed.status).toBe(302);
    const moduleId = (h.db.prepare('SELECT id FROM external_modules LIMIT 1').get() as { id: string }).id;

    const kitchen = await addWall(h, 'Kitchen');
    let store = await h.text('/admin/modules');
    expect(store).toContain('Not on any wall yet');
    expect(store).toContain('A wall shows it once a Module widget on its layout is set to Garden.');

    replaceLayout(h.db, kitchen, 'portrait', {
      mode: 'freeform',
      aspect: 0.5625,
      widgets: [{ id: 'garden', type: 'external', x: 0, y: 0, w: 1, h: 1, z: 0, config: { module: moduleId } }],
      background: null,
    });
    store = await h.text('/admin/modules');
    expect(store).toContain('On: Kitchen');
    expect(store).not.toContain('Not on any wall yet');
  });
});

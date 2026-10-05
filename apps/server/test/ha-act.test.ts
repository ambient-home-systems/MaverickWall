import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { issueDisplayToken } from '../src/auth/tokens.js';
import { haReadingHandle, type Manifest } from '../src/api/manifest.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import {
  HISTORY_MS,
  PRESSES_PER_MINUTE,
  recordWallAction,
  resetOperateLimits,
} from '../src/modules/homeassistant/control.js';
import { HA_SERVICES, sceneReachesNever } from '../src/modules/homeassistant/services.js';
import {
  closeFakeHomeAssistants,
  fakeHomeAssistant,
  TOKEN,
  type FakeHa,
} from './fake-home-assistant.js';

/**
 * A wall operating something in the house (RFC 018 phase 2).
 *
 * `todo-tick.test.ts` one write along, against the real app, a real database
 * and a fake Home Assistant over a socket. Most of what is asserted is what the
 * endpoint refuses, in RFC 018 §8.2's order, because the display token is on
 * a wall anybody in the house can reach: the wall's own switch, the reading
 * the press names, the household's "Can be controlled from walls", the widget
 * the press came from, the word, and the rate. And the half that has no
 * counterpart next door: the house's answer is re-read before anything is
 * written, a refused press is recorded as well as a done one, and nothing in
 * the manifest — before or after — names an entity.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

// Every harness pairs a wall called `wall`, so the rate's in-process memory
// would otherwise carry presses from one case into the next.
beforeEach(() => resetOperateLimits());

const LIGHT = 'light.living_room';
const LIGHT_KEY = haReadingHandle(LIGHT);
const FAN = 'fan.bedroom';
const BLIND = 'cover.kitchen_blind';
const SCENE = 'scene.movie_night';
const PLAYER = 'media_player.kitchen';
const SCRIPT = 'script.goodnight';

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly get: (path: string) => Promise<Response>;
  /** POST /d/ha/act as the wall does, with the display token. */
  readonly act: (fields: Record<string, string>, bearer?: string) => Promise<Response>;
  readonly manifest: () => Promise<{ body: Manifest; text: string; etag: string }>;
  readonly poll: () => Promise<void>;
  /** The wall's own switch. */
  readonly allowControl: (on?: boolean) => void;
  /** Put a Home Assistant widget on the wall with this config, returning its id. */
  readonly widget: (config: Record<string, unknown>) => string;
  readonly presses: () => { entity_id: string; action: string; ok: number; message: string | null }[];
  readonly toggles: () => { path: string; body: string }[];
}

async function harness(): Promise<Harness> {
  const address = `10.18.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-haact-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'e'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
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
    email: `act${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Kitchen wall', ?, 'panels', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  const ha = await fakeHomeAssistant();
  expect(
    (await form('/admin/home-assistant/connect', {
      base_url: ha.base,
      token: TOKEN,
      allow_lan: '1',
      accept_http: '1',
    })).status,
  ).toBe(302);
  // Through the real form, in the order a household would: a light, a switch,
  // a lock and a temperature.
  for (const entity of [
    LIGHT, 'switch.kettle', 'lock.front_door', 'sensor.kitchen_temperature', FAN, BLIND, SCENE, SCRIPT, PLAYER,
  ]) {
    expect((await form('/admin/home-assistant/entities', { entity_id: entity, label: '' })).status).toBe(302);
  }
  const poll = (): Promise<void> =>
    (haModule.job as { run: (c: unknown) => Promise<void> }).run({
      db, fetcher, keyring, now: Date.now(), timezone: 'Europe/London',
    });
  await poll();

  let widgets = 0;
  return {
    db,
    ha,
    form,
    get: (path) => call(path),
    act: (fields, bearer = issued.token) =>
      call('/d/ha/act', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields).toString(),
      }),
    manifest: async () => {
      const response = await call('/d/manifest', {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const text = await response.text();
      return { body: JSON.parse(text) as Manifest, text, etag: response.headers.get('etag') ?? '' };
    },
    poll,
    allowControl: (on = true) => {
      db.prepare('UPDATE screens SET allow_control = ? WHERE id = ?').run(on ? 1 : 0, 'wall');
    },
    widget: (config) => {
      const id = `ha-${++widgets}`;
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, 'wall', 'portrait', 'homeassistant', 0, 0, 1, 0.2, ?, ?, ?, ?)`,
      ).run(id, widgets, JSON.stringify(config), stamp, stamp);
      return id;
    },
    presses: () =>
      db
        .prepare('SELECT entity_id, action, ok, message FROM ha_wall_actions ORDER BY id')
        .all() as { entity_id: string; action: string; ok: number; message: string | null }[],
    toggles: () => ha.posts.filter((post) => post.path.endsWith('/toggle')),
  };
}

/** Mark a reading controllable through the Readings screen's own form. */
async function markControllable(h: Harness, entityId: string, on = true): Promise<Response> {
  return h.form('/admin/home-assistant/entities/control', {
    entity_id: entityId,
    ...(on ? { controllable: '1' } : {}),
  });
}

/** Everything switched on: the wall, the light, and a widget that acts on it. */
async function ready(h: Harness): Promise<string> {
  h.allowControl();
  expect((await markControllable(h, LIGHT)).status).toBe(302);
  return h.widget({ tapAction: 'act', readings: [LIGHT] });
}

type Reading = { key: string; value: string; actions?: string[] };
const readingsOf = (manifest: Manifest): Reading[] =>
  (manifest.panels['home'] as { readings: Reading[] }).readings;

// ---------------------------------------------------------------------------
// Nothing changes for a household that uses none of it
// ---------------------------------------------------------------------------

describe('a household that turns nothing on', () => {
  it('sends no new key in the manifest, so no stored ETag moves', async () => {
    /*
     * `allowTodo`'s rule, held for both fields: spread when on, never emitted as
     * `false` or `[]`. The flag and the list are off on every wall in the world
     * until a household opens a setting, and `manifestEtag` hashes the
     * serialisation — every e-paper frame's ETag with it.
     */
    const h = await harness();
    h.widget({ readings: [LIGHT] });
    const { body, text } = await h.manifest();
    expect('allowControl' in (body.screen as Record<string, unknown>)).toBe(false);
    expect(text).not.toContain('"actions"');
    expect(text).not.toContain('allowControl');
  });

  it('refuses a press with the wall’s own sentence, and asks Home Assistant nothing', async () => {
    const h = await harness();
    const widget = h.widget({ tapAction: 'act', readings: [LIGHT] });
    await markControllable(h, LIGHT);
    const before = h.ha.paths.length;
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'not-allowed',
      message: 'This wall cannot operate things in the house.',
    });
    // Not a toggle and not even a read: a wall that may operate nothing does
    // not get to make the server ask the house anything on its behalf.
    expect(h.ha.paths.length).toBe(before);
    expect(h.presses()).toEqual([]);
  });

  it('needs a paired wall at all', async () => {
    const h = await harness();
    h.allowControl();
    const response = await h.act({ reading: LIGHT_KEY, widget: 'x', action: 'toggle' }, 'not-a-token');
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The checks, in RFC 018 §8.2's order
// ---------------------------------------------------------------------------

describe('what a press is refused for', () => {
  it('a handle this server never minted', async () => {
    const h = await harness();
    const widget = await ready(h);
    const response = await h.act({ reading: 'ffffffffffffffff', widget, action: 'toggle' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe(
      'That is not on this wall any more.',
    );
  });

  it('an entity id in place of a handle, which the wall is never given', async () => {
    const h = await harness();
    const widget = await ready(h);
    expect((await h.act({ reading: LIGHT, widget, action: 'toggle' })).status).toBe(400);
    expect(h.toggles()).toEqual([]);
  });

  it('a reading the household has not marked controllable', async () => {
    const h = await harness();
    h.allowControl();
    const widget = h.widget({ tapAction: 'act', readings: [LIGHT] });
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe(
      "That can't be operated from a wall.",
    );
    expect(h.toggles()).toEqual([]);
  });

  it('a widget that only shows, a widget on another wall, and one that does not show this reading', async () => {
    /*
     * The third switch, read from the stored row and never from the wall. A
     * reading shown in two places can be a button by the door and a picture in
     * the kitchen, so the widget the press came from is what decides.
     */
    const h = await harness();
    await ready(h);
    const showsOnly = h.widget({ readings: [LIGHT] });
    const elsewhere = h.widget({ tapAction: 'act', readings: ['sensor.kitchen_temperature'] });
    for (const widget of [showsOnly, elsewhere, 'no-such-widget']) {
      const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
      expect(response.status, widget).toBe(403);
    }
    // A widget on a different wall, under this wall's token.
    h.db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
       VALUES ('hall', 'Hall', 'x', 'panels', 0, 0, 0)`,
    ).run();
    h.db.prepare(
      `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
       VALUES ('hall-ha', 'hall', 'portrait', 'homeassistant', 0, 0, 1, 1, 0, ?, 0, 0)`,
    ).run(JSON.stringify({ tapAction: 'act' }));
    expect((await h.act({ reading: LIGHT_KEY, widget: 'hall-ha', action: 'toggle' })).status).toBe(403);
    expect(h.toggles()).toEqual([]);
  });

  it('a widget with no reading list acts on every reading it shows', async () => {
    // Absent is "all of them" — the wall's own reading of it — so a press can
    // only come from a reading the widget actually draws.
    const h = await harness();
    h.allowControl();
    await markControllable(h, LIGHT);
    const all = h.widget({ tapAction: 'act' });
    expect((await h.act({ reading: LIGHT_KEY, widget: all, action: 'toggle' })).status).toBe(200);
  });

  it('a word this endpoint has no table for', async () => {
    const h = await harness();
    const widget = await ready(h);
    for (const action of ['unlock', 'turn_on', '']) {
      expect((await h.act({ reading: LIGHT_KEY, widget, action })).status, action).toBe(400);
    }
    expect(h.toggles()).toEqual([]);
  });

  it(`more than ${PRESSES_PER_MINUTE} presses a minute from one wall`, async () => {
    const h = await harness();
    const widget = await ready(h);
    for (let i = 0; i < PRESSES_PER_MINUTE; i++) {
      expect((await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' })).status).toBe(200);
    }
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { message: string }).message).toBe(
      'Too many presses. Try again in a moment.',
    );
    expect(h.toggles()).toHaveLength(PRESSES_PER_MINUTE);
  });

  it('a second press on one entity while the first is still with Home Assistant', async () => {
    const h = await harness();
    const widget = await ready(h);
    const [first, second] = await Promise.all([
      h.act({ reading: LIGHT_KEY, widget, action: 'toggle' }),
      h.act({ reading: LIGHT_KEY, widget, action: 'toggle' }),
    ]);
    expect([first?.status, second?.status].sort()).toEqual([200, 429]);
    expect(h.toggles()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A press that goes through
// ---------------------------------------------------------------------------

describe('a press that goes through', () => {
  it('toggles the light through the one table row, and the next manifest says so', async () => {
    const h = await harness();
    const widget = await ready(h);
    expect(readingsOf((await h.manifest()).body).find((r) => r.key === LIGHT_KEY)?.value).toBe('On · 60%');

    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    // Exactly the row the table names, with the entity and nothing else.
    expect(h.toggles()).toEqual([
      { path: `/api/services/${HA_SERVICES['light.toggle'].service}`, query: '', body: JSON.stringify({ entity_id: LIGHT }) },
    ]);
    // Written through, so the re-poll draws it without waiting for the job.
    expect(readingsOf((await h.manifest()).body).find((r) => r.key === LIGHT_KEY)?.value).toBe('Off');
    expect(h.presses()).toEqual([{ entity_id: LIGHT, action: 'toggle', ok: 1, message: null }]);
  });

  it('carries the action and the wall’s switch in the manifest, and no entity id', async () => {
    const h = await harness();
    await ready(h);
    const { body, text } = await h.manifest();
    expect((body.screen as Record<string, unknown>)['allowControl']).toBe(true);
    const readings = readingsOf(body);
    // Everything the door would accept for this light, and nothing it would not:
    // it dims, takes a colour and a white (RFC 018 phase 3), and switches.
    expect(readings.find((r) => r.key === LIGHT_KEY)?.actions).toEqual([
      'toggle',
      'brightness',
      'colour',
      'colour_temp',
    ]);
    // Only on the reading marked controllable; a sensor has nothing to press.
    expect(readings.filter((r) => r.actions !== undefined)).toHaveLength(1);
    // Rule 12's surviving clause: a handle, never the id.
    for (const id of [LIGHT, 'switch.kettle', 'lock.front_door']) expect(text).not.toContain(id);
  });

  it('says what Home Assistant said when it refuses, and records the refusal', async () => {
    const h = await harness();
    const widget = await ready(h);
    h.ha.refuseToggle = true;
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('upstream');
    expect(body.message.length).toBeGreaterThan(10);
    expect(body.message).not.toContain(h.ha.base);
    // The light did not change, so the reading must not either.
    expect(readingsOf((await h.manifest()).body).find((r) => r.key === LIGHT_KEY)?.value).toBe('On · 60%');
    expect(h.presses()).toEqual([{ entity_id: LIGHT, action: 'toggle', ok: 0, message: body.message }]);
  });

  it('refuses an entity Home Assistant no longer has, in words, and toggles nothing', async () => {
    const h = await harness();
    const widget = await ready(h);
    h.ha.gone.add(LIGHT);
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).toBe(
      'That is not in Home Assistant any more.',
    );
    expect(h.toggles()).toEqual([]);
  });

  it('keeps a fortnight of presses and no more', async () => {
    const h = await harness();
    const now = Date.now();
    recordWallAction(h.db, { screenId: 'wall', entityId: LIGHT, action: 'toggle', ok: true, message: null }, now - HISTORY_MS - 1);
    recordWallAction(h.db, { screenId: 'wall', entityId: LIGHT, action: 'toggle', ok: true, message: null }, now);
    expect(h.presses()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The household's switch, on the Readings screen
// ---------------------------------------------------------------------------

describe('Can be controlled from walls', () => {
  it('is offered for a light and a switch, and not for a lock or a sensor', async () => {
    const h = await harness();
    const html = await (await h.get('/admin/home-assistant/readings')).text();
    const controls = [...html.matchAll(/action="admin\/home-assistant\/entities\/control">\s*<input type="hidden" name="entity_id" value="([^"]+)"/g)]
      .map((match) => match[1]);
    // A blind since phase 3: it shades a room and reports what can be moved.
    // And a scene and a script since phase 4.
    expect(controls.sort()).toEqual([BLIND, FAN, LIGHT, PLAYER, SCENE, SCRIPT, 'switch.kettle'].sort());
    // The lock is told why, beside it, rather than left without a switch.
    expect(html).toContain('Walls can never operate this.');
    // And a switch carries its caution: it can be anything.
    expect(html).toContain('A switch can be wired to anything. Check what this one powers.');
  });

  it('refuses a lock posted by hand, which no page offers', async () => {
    const h = await harness();
    const response = await markControllable(h, 'lock.front_door');
    expect(response.status).toBe(400);
    const row = h.db
      .prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?')
      .get('lock.front_door') as { controllable: number };
    expect(row.controllable).toBe(0);
  });

  it('is said when saved, and switches back off', async () => {
    const h = await harness();
    const on = await markControllable(h, LIGHT);
    expect(on.headers.get('location')).toContain('saved=ha-entity-control-on');
    const off = await markControllable(h, LIGHT, false);
    expect(off.headers.get('location')).toContain('saved=ha-entity-control-off');
    const row = h.db
      .prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?')
      .get(LIGHT) as { controllable: number };
    expect(row.controllable).toBe(0);
  });

  it('starts off again when a reading is removed and added back', async () => {
    /*
     * Removing a reading deletes its row — unless a "Tell me when…" rule still
     * names it, and then the row is kept unwatched so the rule keeps working
     * (`unwatchEntity`). That kept row is the only one that can carry an old
     * `controllable` into a re-add, so it is the state this test makes: the
     * light watched no more, still marked, and then added back.
     */
    const h = await harness();
    await markControllable(h, LIGHT);
    h.db.prepare('UPDATE ha_entity_cache SET watched = 0 WHERE entity_id = ?').run(LIGHT);
    expect(
      (h.db.prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?').get(LIGHT) as {
        controllable: number;
      }).controllable,
    ).toBe(1);
    await h.form('/admin/home-assistant/entities', { entity_id: LIGHT, label: '' });
    const row = h.db
      .prepare('SELECT controllable, watched FROM ha_entity_cache WHERE entity_id = ?')
      .get(LIGHT) as { controllable: number; watched: number };
    expect(row).toEqual({ controllable: 0, watched: 1 });
  });

  it('lists recent presses by the wall’s and the reading’s own names', async () => {
    const h = await harness();
    const widget = await ready(h);
    await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' });
    const html = await (await h.get('/admin/home-assistant/readings')).text();
    expect(html).toContain('Recent presses from walls');
    expect(html).toContain('Kitchen wall');
    expect(html).toContain('Living room');
    expect(html).toContain('Done');
  });

  it('draws no presses heading for a household that never turned this on', async () => {
    const h = await harness();
    const html = await (await h.get('/admin/home-assistant/readings')).text();
    expect(html).not.toContain('Recent presses from walls');
  });

  it('is the wall’s own switch on its page, and saving the page sets it', async () => {
    /*
     * The first of the three, under the wall's Touch controls. A column the
     * page forgets to read back is a switch that springs off at the next save,
     * which is `readScreens`' fault one column along — so this saves the page
     * twice, once with the box ticked and once without.
     */
    const h = await harness();
    const page = await (await h.get('/admin/walls/wall')).text();
    expect(page).toContain('name="allow_control"');
    expect(page).toContain('Allow operating things in the house');
    const save = (on: boolean): Promise<Response> =>
      h.form('/admin/screens/wall', {
        name: 'Kitchen wall',
        theme: 'panels',
        orientation: 'auto',
        rotation: '0',
        ...(on ? { allow_control: '1' } : {}),
      });
    const column = (): number =>
      (h.db.prepare('SELECT allow_control AS n FROM screens WHERE id = ?').get('wall') as { n: number }).n;
    expect((await save(true)).status).toBe(302);
    expect(column()).toBe(1);
    expect(await (await h.get('/admin/walls/wall')).text()).toMatch(/name="allow_control"[^>]*checked/);
    expect((await save(false)).status).toBe(302);
    expect(column()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: a value — brightness, colour, white, speed, position
// ---------------------------------------------------------------------------

describe('a press that carries a value (RFC 018 phase 3)', () => {
  /** Everything on for one entity, with a widget that shows every reading. */
  async function readyFor(h: Harness, entityId: string): Promise<string> {
    h.allowControl();
    expect((await markControllable(h, entityId)).status).toBe(302);
    return h.widget({ tapAction: 'act' });
  }
  const posted = (h: Harness): { path: string; body: unknown }[] =>
    h.ha.posts
      .filter((post) => post.path.startsWith('/api/services/') && !post.path.includes('/todo/'))
      .map((post) => ({ path: post.path.slice('/api/services/'.length), body: JSON.parse(post.body) }));
  const readingFor = async (h: Harness, entityId: string): Promise<Reading & Record<string, unknown>> =>
    readingsOf((await h.manifest()).body).find((r) => r.key === haReadingHandle(entityId)) as Reading &
      Record<string, unknown>;

  it('dims the light to the percentage the wall sent, and the next manifest says so', async () => {
    const h = await harness();
    const widget = await readyFor(h, LIGHT);
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'brightness', value: '40' });
    expect(response.status).toBe(200);
    expect(posted(h)).toEqual([
      { path: HA_SERVICES['light.brightness'].service, body: { entity_id: LIGHT, brightness_pct: 40 } },
    ]);
    expect((await readingFor(h, LIGHT)).value).toBe('On · 40%');
  });

  it('sends a colour as the three numbers it is, and a white in kelvin inside the light’s own range', async () => {
    const h = await harness();
    const widget = await readyFor(h, LIGHT);
    expect((await h.act({ reading: LIGHT_KEY, widget, action: 'colour', value: '255,120,0' })).status).toBe(200);
    expect((await h.act({ reading: LIGHT_KEY, widget, action: 'colour_temp', value: '3000' })).status).toBe(200);
    expect(posted(h)).toEqual([
      { path: 'light/turn_on', body: { entity_id: LIGHT, rgb_color: [255, 120, 0] } },
      { path: 'light/turn_on', body: { entity_id: LIGHT, color_temp_kelvin: 3000 } },
    ]);
  });

  it('carries the white range and the fan’s step beside the words that use them, and nothing else', async () => {
    const h = await harness();
    h.allowControl();
    for (const entity of [LIGHT, FAN, BLIND]) await markControllable(h, entity);
    const light = await readingFor(h, LIGHT);
    // The light is not showing a white, so the range comes without a value.
    expect(light['kelvin']).toEqual({ min: 2202, max: 6535 });
    expect('step' in light).toBe(false);
    const fan = await readingFor(h, FAN);
    expect(fan.actions).toEqual(['toggle', 'speed']);
    expect(fan['step']).toBe(20);
    expect('kelvin' in fan).toBe(false);
    const blind = await readingFor(h, BLIND);
    expect(blind.actions).toEqual(['open', 'close', 'stop', 'position']);
    expect('kelvin' in blind || 'step' in blind).toBe(false);
    // And after a white is set, the slider starts where the light is.
    const widget = h.widget({ tapAction: 'act' });
    await h.act({ reading: LIGHT_KEY, widget, action: 'colour_temp', value: '4000' });
    expect((await readingFor(h, LIGHT))['kelvin']).toEqual({ min: 2202, max: 6535, value: 4000 });
  });

  it('sends a fan’s step only where its speed can be set', async () => {
    // A fan that reports a step and no SET_SPEED: it switches, and the step it
    // reports would be a number for a slider the wall will never draw.
    const h = await harness();
    h.ha.set[FAN] = { supported_features: 0 };
    await h.poll();
    h.allowControl();
    await markControllable(h, FAN);
    const fan = await readingFor(h, FAN);
    expect(fan.actions).toEqual(['toggle']);
    expect('step' in fan).toBe(false);
  });

  it('refuses a value of the wrong shape, out of range, or where the word takes none — and sends nothing', async () => {
    const h = await harness();
    const widget = await readyFor(h, LIGHT);
    const cases: Record<string, string>[] = [
      { action: 'brightness' },
      { action: 'brightness', value: '0' },
      { action: 'brightness', value: '101' },
      { action: 'brightness', value: '-5' },
      { action: 'brightness', value: '40.5' },
      { action: 'colour', value: '40' },
      { action: 'colour', value: '255,0,256' },
      { action: 'colour_temp', value: '1500' },
      { action: 'colour_temp', value: '9000' },
      { action: 'toggle', value: '1' },
      { action: 'speed', value: '50' },
    ];
    for (const fields of cases) {
      const response = await h.act({ reading: LIGHT_KEY, widget, ...fields });
      expect(response.status, JSON.stringify(fields)).toBe(400);
    }
    expect(posted(h)).toEqual([]);
  });

  it('sets a fan’s speed', async () => {
    const h = await harness();
    const widget = await readyFor(h, FAN);
    const key = haReadingHandle(FAN);
    expect((await h.act({ reading: key, widget, action: 'speed', value: '60' })).status).toBe(200);
    expect(posted(h)).toEqual([{ path: 'fan/set_percentage', body: { entity_id: FAN, percentage: 60 } }]);
    expect((await readingFor(h, FAN)).value).toBe('On · 60%');
  });

  it('opens, stops, closes and positions a blind, each through its own row', async () => {
    const h = await harness();
    const widget = await readyFor(h, BLIND);
    const key = haReadingHandle(BLIND);
    for (const fields of [
      { action: 'open' },
      { action: 'stop' },
      { action: 'close' },
      { action: 'position', value: '70' },
    ]) {
      expect((await h.act({ reading: key, widget, ...fields })).status, fields.action).toBe(200);
    }
    expect(posted(h).map((post) => post.path)).toEqual([
      'cover/open_cover',
      'cover/stop_cover',
      'cover/close_cover',
      'cover/set_cover_position',
    ]);
    expect(posted(h)[3]?.body).toEqual({ entity_id: BLIND, position: 70 });
    expect((await readingFor(h, BLIND)).value).toBe('Open · 70%');
    // A blind has no toggle: the word with no row is a 400.
    expect((await h.act({ reading: key, widget, action: 'toggle' })).status).toBe(400);
  });

  it('refuses a light that stopped dimming since it was marked, and still lets it switch', async () => {
    /*
     * Step 6, which phase 2 could not reach: a toggle's eligibility is its
     * domain alone. An integration that narrows a light to on/off between
     * marking and pressing gets a 409 for the dimmer — and the flag stays,
     * because the light still switches and the household still asked for that.
     */
    const h = await harness();
    const widget = await readyFor(h, LIGHT);
    h.ha.set[LIGHT] = { supported_color_modes: ['onoff'] };
    const response = await h.act({ reading: LIGHT_KEY, widget, action: 'brightness', value: '40' });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toBe(
      "That can't be operated from a wall any more.",
    );
    expect(posted(h)).toEqual([]);
    expect((await h.act({ reading: LIGHT_KEY, widget, action: 'toggle' })).status).toBe(200);
  });

  it('refuses a blind that became a garage door, and takes the switch away', async () => {
    const h = await harness();
    const widget = await readyFor(h, BLIND);
    h.ha.set[BLIND] = { device_class: 'garage' };
    const key = haReadingHandle(BLIND);
    expect((await h.act({ reading: key, widget, action: 'open' })).status).toBe(409);
    expect(posted(h)).toEqual([]);
    const row = h.db
      .prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?')
      .get(BLIND) as { controllable: number };
    expect(row.controllable).toBe(0);
    expect((await h.act({ reading: key, widget, action: 'open' })).status).toBe(403);
  });

  it('names what a wall could do beside the switch, from the actions the door would accept', async () => {
    const h = await harness();
    const html = await (await h.get('/admin/home-assistant/readings')).text();
    expect(html).toContain(
      'Living room can be switched on or off, dimmed, given a colour or made a warmer or cooler white',
    );
    expect(html).toContain('Kettle can be switched on or off from a wall');
    expect(html).toContain('Kitchen blind can be opened, closed or moved');
  });
});

// ---------------------------------------------------------------------------
// Phase 4: running a scene or a script
// ---------------------------------------------------------------------------

describe('running a scene or a script (RFC 018 phase 4)', () => {
  const sent = (h: Harness): { path: string; body: unknown }[] =>
    h.ha.posts
      .filter((post) => post.path.startsWith('/api/services/') && !post.path.includes('/todo/'))
      .map((post) => ({ path: post.path.slice('/api/services/'.length), body: JSON.parse(post.body) }));

  it('reads a scene as one word and a script as whether it runs, so neither moves with the clock', async () => {
    const h = await harness();
    const readings = readingsOf((await h.manifest()).body);
    expect(readings.find((r) => r.key === haReadingHandle(SCENE))?.value).toBe('Scene');
    expect(readings.find((r) => r.key === haReadingHandle(SCRIPT))?.value).toBe('Ready');
  });

  it('runs each through its own row, with the entity and nothing else', async () => {
    const h = await harness();
    h.allowControl();
    for (const entity of [SCENE, SCRIPT]) expect((await markControllable(h, entity)).status).toBe(302);
    const widget = h.widget({ tapAction: 'act' });
    const readings = readingsOf((await h.manifest()).body);
    for (const entity of [SCENE, SCRIPT]) {
      expect(readings.find((r) => r.key === haReadingHandle(entity))?.actions, entity).toEqual(['run']);
    }
    expect((await h.act({ reading: haReadingHandle(SCENE), widget, action: 'run' })).status).toBe(200);
    expect((await h.act({ reading: haReadingHandle(SCRIPT), widget, action: 'run' })).status).toBe(200);
    expect(sent(h)).toEqual([
      { path: HA_SERVICES['scene.run'].service, body: { entity_id: SCENE } },
      { path: HA_SERVICES['script.run'].service, body: { entity_id: SCRIPT } },
    ]);
    // Ran a scene, and the wall still reads one word rather than the instant.
    expect(readingsOf((await h.manifest()).body).find((r) => r.key === haReadingHandle(SCENE))?.value).toBe('Scene');
  });

  it('refuses a value, any other word, and a scene nobody marked', async () => {
    const h = await harness();
    h.allowControl();
    await markControllable(h, SCRIPT);
    const widget = h.widget({ tapAction: 'act' });
    const script = haReadingHandle(SCRIPT);
    // No variables, ever (RFC 018 §5): a value on `run` is a 400.
    expect((await h.act({ reading: script, widget, action: 'run', value: '1' })).status).toBe(400);
    expect((await h.act({ reading: script, widget, action: 'toggle' })).status).toBe(400);
    expect((await h.act({ reading: haReadingHandle(SCENE), widget, action: 'run' })).status).toBe(403);
    expect(sent(h)).toEqual([]);
  });

  it('says what each choice costs beside its switch, in the RFC’s own words', async () => {
    const h = await harness();
    const html = await (await h.get('/admin/home-assistant/readings')).text();
    expect(html).toContain(
      'A script can do anything Home Assistant can do. Allow only scripts you would let a guest in your kitchen run.',
    );
    expect(html).toContain('A scene sets every entity in it, including any lock or cover it names.');
    expect(html).toContain('Movie night can be run, by pressing and holding it from a wall');
  });

  it('refuses to let a wall run a scene that sets a lock, and says which member', async () => {
    /*
     * The never-list, seen through a scene (decided 2026-10-05): a scene is
     * everything it sets, so one that locks the front door is refused at the
     * Readings screen, naming the member, whatever is ticked.
     */
    const h = await harness();
    await h.form('/admin/home-assistant/entities', { entity_id: 'scene.leaving', label: '' });
    const response = await markControllable(h, 'scene.leaving');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('This scene sets Front door lock');
    const row = h.db
      .prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?')
      .get('scene.leaving') as { controllable: number };
    expect(row.controllable).toBe(0);
  });

  it('refuses a scene at the press once it has been changed to reach a garage door, and takes its switch away', async () => {
    const h = await harness();
    h.allowControl();
    expect((await markControllable(h, SCENE)).status).toBe(302);
    const widget = h.widget({ tapAction: 'act' });
    // Movie night sets the kitchen blind — fine while it is a blind.
    h.ha.set[BLIND] = { device_class: 'garage' };
    const response = await h.act({ reading: haReadingHandle(SCENE), widget, action: 'run' });
    expect(response.status).toBe(409);
    expect(sent(h)).toEqual([]);
    const row = h.db
      .prepare('SELECT controllable FROM ha_entity_cache WHERE entity_id = ?')
      .get(SCENE) as { controllable: number };
    expect(row.controllable).toBe(0);
  });

  it('refuses a scene that does not say what it sets', async () => {
    const h = await harness();
    h.allowControl();
    expect((await markControllable(h, SCENE)).status).toBe(302);
    const widget = h.widget({ tapAction: 'act' });
    h.ha.set[SCENE] = { entity_id: 'light.living_room' };
    expect((await h.act({ reading: haReadingHandle(SCENE), widget, action: 'run' })).status).toBe(409);
    expect(sent(h)).toEqual([]);
  });
});

describe('which scenes reach the never-list', () => {
  const classes: Record<string, string | null> = {
    'cover.lounge': 'blind',
    'cover.drive': 'garage',
    'cover.shed': null,
  };
  const reaches = (members: unknown): string | undefined | null =>
    sceneReachesNever({ entity_id: members }, (id) => classes[id]);

  it.each([
    [['light.a', 'switch.b', 'fan.c', 'cover.lounge', 'media_player.d'], undefined],
    [['light.a', 'lock.front'], 'lock.front'],
    [['alarm_control_panel.home'], 'alarm_control_panel.home'],
    [['climate.hall'], 'climate.hall'],
    [['input_boolean.guests'], 'input_boolean.guests'],
    [['cover.drive'], 'cover.drive'],
    // An unset cover class fails closed, as a direct press does.
    [['cover.shed'], 'cover.shed'],
    [['cover.unknown_to_the_house'], 'cover.unknown_to_the_house'],
  ])('%j → %s', (members, expected) => {
    expect(reaches(members)).toBe(expected);
  });

  it('refuses a scene that does not list what it sets, as though it set a lock', () => {
    expect(sceneReachesNever({}, () => null)).toBeNull();
    expect(reaches('light.a')).toBeNull();
    expect(reaches(['light.a', 7])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 6: a media player's transport and volume
// ---------------------------------------------------------------------------

describe('playing, pausing, skipping and the volume (RFC 018 phase 6)', () => {
  const sent = (h: Harness): { path: string; body: unknown }[] =>
    h.ha.posts
      .filter((post) => post.path.startsWith('/api/services/') && !post.path.includes('/todo/'))
      .map((post) => ({ path: post.path.slice('/api/services/'.length), body: JSON.parse(post.body) }));
  const KEY = haReadingHandle(PLAYER);

  async function readyPlayer(h: Harness): Promise<string> {
    h.allowControl();
    expect((await markControllable(h, PLAYER)).status).toBe(302);
    return h.widget({ tapAction: 'act' });
  }

  it('reads what the player is doing, carries its volume beside the slider, and never the track', async () => {
    const h = await harness();
    await readyPlayer(h);
    const { body, text } = await h.manifest();
    const reading = readingsOf(body).find((r) => r.key === KEY) as Reading & Record<string, unknown>;
    expect(reading.value).toBe('Playing');
    expect(reading.actions).toEqual(['play_pause', 'next', 'previous', 'volume']);
    expect(reading['volume']).toBe(40);
    for (const leak of ['A track title that must not travel', 'An artist', 'picture-token-that-must-not-travel']) {
      expect(text).not.toContain(leak);
    }
  });

  it('sends each word through its own row, and the volume as Home Assistant’s 0.0–1.0', async () => {
    const h = await harness();
    const widget = await readyPlayer(h);
    for (const fields of [
      { action: 'play_pause' },
      { action: 'next' },
      { action: 'previous' },
      { action: 'volume', value: '75' },
      { action: 'volume', value: '0' },
    ]) {
      expect((await h.act({ reading: KEY, widget, ...fields })).status, JSON.stringify(fields)).toBe(200);
    }
    // And out of range on a player that does take a volume: refused, sent nowhere.
    expect((await h.act({ reading: KEY, widget, action: 'volume', value: '101' })).status).toBe(400);
    expect(sent(h)).toEqual([
      { path: 'media_player/media_play_pause', body: { entity_id: PLAYER } },
      { path: 'media_player/media_next_track', body: { entity_id: PLAYER } },
      { path: 'media_player/media_previous_track', body: { entity_id: PLAYER } },
      { path: 'media_player/volume_set', body: { entity_id: PLAYER, volume_level: 0.75 } },
      { path: 'media_player/volume_set', body: { entity_id: PLAYER, volume_level: 0 } },
    ]);
    // Written through: the slider starts where the player now is.
    const reading = readingsOf((await h.manifest()).body).find((r) => r.key === KEY) as Record<string, unknown>;
    expect(reading['volume']).toBe(0);
  });

  it('refuses a volume out of range and a word the player does not support', async () => {
    const h = await harness();
    h.ha.set[PLAYER] = { supported_features: 1 | 16384 };
    await h.poll();
    const widget = await readyPlayer(h);
    const narrowed = readingsOf((await h.manifest()).body).find((r) => r.key === KEY) as Reading &
      Record<string, unknown>;
    expect(narrowed.actions).toEqual(['play_pause']);
    // Its volume is cached and not sent: no slider, so nothing for it to start.
    expect('volume' in narrowed).toBe(false);
    // A word it does not support is refused at the house's own features, before
    // any value is looked at.
    expect((await h.act({ reading: KEY, widget, action: 'next' })).status).toBe(409);
    expect((await h.act({ reading: KEY, widget, action: 'volume', value: '50' })).status).toBe(409);
    expect((await h.act({ reading: KEY, widget, action: 'play_pause' })).status).toBe(200);
    expect(sent(h).map((post) => post.path)).toEqual(['media_player/media_play_pause']);
  });
});


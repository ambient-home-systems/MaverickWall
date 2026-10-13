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
import { issueDisplayToken } from '../src/auth/tokens.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { CAMERA_HANDLE, MAX_CAMERAS, readCameras, watchCamera } from '../src/modules/cameras/index.js';
import { startLayoutOverride } from '../src/api/wall-commands.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { ARTWORK, TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * Cameras on the wall (plan item M6.1, RFC 007 Tier A), against the real app,
 * a real database and the stand-in Home Assistant, which lists a doorbell
 * whose state carries an access token that must never travel.
 *
 * What never happens: the entity id, Home Assistant's address, its token or
 * the camera's own token reach a wall; a wall gets the picture of a camera
 * not placed on a canvas it can draw; a camera the poll found missing is
 * asked for a picture anyway; three walls refreshing one camera cost the
 * house three fetches. And what does: a placed camera's picture, sniffed,
 * `no-store`, on whichever canvas the wall can draw it from.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const DOOR = 'camera.front_door';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly admin: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  /** A request from a paired wall, by its id. */
  readonly wall: (screen: string, path: string) => Promise<Response>;
  readonly pair: (id: string) => void;
  readonly poll: () => Promise<void>;
  readonly place: (row: {
    id: string;
    screen: string;
    config: Record<string, unknown>;
    type?: string;
    orientation?: 'portrait' | 'landscape';
    slot?: string;
    parent?: string;
  }) => void;
  readonly cameraRequests: () => number;
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-cam-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.61.${n}.1`,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
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
    admin(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await admin(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `cam${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });

  const tokens = new Map<string, string>();
  const pair = (id: string): void => {
    const display = issueDisplayToken();
    tokens.set(id, display.token);
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'panels', ?, 'freeform', ?, ?)`,
    ).run(id, `Wall ${id}`, display.tokenHash, stamp, stamp, stamp);
  };
  pair('kitchen');
  pair('hall');
  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return Date.now(); } };
  return {
    db,
    ha,
    admin,
    form,
    wall: async (screen, path) =>
      app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${tokens.get(screen) ?? ''}` } })),
    pair,
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    place: (row) => {
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, slot, type, x, y, w, h, z, config, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0.5, 0.5, 0, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.screen,
        row.orientation ?? 'portrait',
        row.slot ?? null,
        row.type ?? 'camera',
        JSON.stringify(row.config),
        row.parent ?? null,
        stamp,
        stamp,
      );
    },
    cameraRequests: () => ha.paths.filter((path) => path.startsWith('/api/camera_proxy/')).length,
  };
}

/** Add the doorbell through the admin, and hand back the handle it was given. */
async function addDoor(h: Harness): Promise<string> {
  const added = await h.form('/admin/home-assistant/cameras', { entity_id: DOOR });
  expect(added.status).toBe(302);
  expect(added.headers.get('location')).toContain('saved=ha-camera-added');
  const handle = readCameras(h.db).find((camera) => camera.entityId === DOOR)?.handle ?? '';
  expect(handle).toMatch(CAMERA_HANDLE);
  return handle;
}

describe('the Cameras screen', () => {
  it('offers the house’s cameras, adds one with a handle of its own, and says no wall shows it yet', async () => {
    const h = await harness();
    const offered = await (await h.admin('/admin/home-assistant/cameras/new')).text();
    expect(offered).toContain('Front door');
    expect(offered).toContain(`value="${DOOR}"`);

    const handle = await addDoor(h);
    const listed = await (await h.admin('/admin/home-assistant/cameras')).text();
    expect(listed).toContain('Front door');
    expect(listed).toContain('Not on any wall yet');
    // The hub counts it.
    expect(await (await h.admin('/admin/home-assistant')).text()).toContain('1 camera');

    // Placed on a wall, the row says where.
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });
    expect(await (await h.admin('/admin/home-assistant/cameras')).text()).toContain('On: Wall kitchen');

    // Adding it again keeps the one handle.
    await h.form('/admin/home-assistant/cameras', { entity_id: DOOR });
    expect(readCameras(h.db).map((camera) => camera.handle)).toEqual([handle]);
  });

  it('refuses a camera Home Assistant does not have, and an entity that is no camera, with a sentence', async () => {
    const h = await harness();
    const unknown = await h.form('/admin/home-assistant/cameras', { entity_id: 'camera.back_garden' });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('Home Assistant has no camera by that name.');
    const reading = await h.form('/admin/home-assistant/cameras', { entity_id: 'sensor.living_room_temperature' });
    expect(reading.status).toBe(400);
    expect(readCameras(h.db)).toEqual([]);
  });

  it('holds a house to a small number of cameras', async () => {
    const h = await harness();
    for (let i = 0; i < MAX_CAMERAS; i++) {
      expect(watchCamera(h.db, { entityId: `camera.c${i}`, name: `C${i}` }, Date.now()).ok).toBe(true);
    }
    const refused = watchCamera(h.db, { entityId: 'camera.one_more', name: 'One more' }, Date.now());
    expect(refused.ok).toBe(false);
  });
});

describe('what a wall is given', () => {
  it('a handle and whether the camera is there — never the entity id, the address or a token', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle, cameraRefreshSec: 5 } });
    await h.poll();
    const text = await (await h.wall('kitchen', '/d/manifest')).text();
    const manifest = JSON.parse(text) as {
      panels: Record<string, unknown>;
      layout: { portrait: { widgets: { id: string; config: Record<string, unknown> }[] } };
    };
    expect(manifest.panels['cameras']).toEqual({ cameras: [{ handle, available: true }] });
    expect(manifest.layout.portrait.widgets.find((widget) => widget.id === 'cam-1')?.config).toMatchObject({ camera: handle });
    for (const secret of [DOOR, 'front_door', 'Front door', h.ha.base, TOKEN, 'camera-token-that-must-not-travel']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('is unchanged for a household with no cameras', async () => {
    const h = await harness();
    const manifest = (await (await h.wall('kitchen', '/d/manifest')).json()) as { panels: Record<string, unknown> };
    expect(manifest.panels['cameras']).toBeUndefined();
  });

  it('leaves out a widget whose camera was removed, and keeps one with none chosen yet', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    // A second camera stays, so the module is still ready and only the removed
    // handle can be what leaves the box out.
    const kept = watchCamera(h.db, { entityId: 'camera.garden', name: 'Garden' }, Date.now());
    if (!kept.ok) throw new Error(kept.message);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });
    h.place({ id: 'cam-kept', screen: 'kitchen', config: { camera: kept.handle } });
    h.place({ id: 'cam-none', screen: 'kitchen', config: {} });
    h.place({ id: 'note', screen: 'kitchen', type: 'notes', config: { text: 'Hello' } });
    const ids = async (): Promise<string[]> =>
      ((await (await h.wall('kitchen', '/d/manifest')).json()) as { layout: { portrait: { widgets: { id: string }[] } } }).layout.portrait.widgets.map(
        (widget) => widget.id,
      );
    expect(await ids()).toEqual(expect.arrayContaining(['cam-1', 'cam-kept', 'cam-none', 'note']));
    const removed = await h.form(`/admin/home-assistant/cameras/${handle}/remove`, {});
    expect(removed.headers.get('location')).toContain('saved=ha-camera-removed');
    const after = await ids();
    expect(after).not.toContain('cam-1');
    expect(after).toEqual(expect.arrayContaining(['cam-kept', 'cam-none', 'note']));
  });
});

describe('the picture', () => {
  it('is served to a wall it is placed on, sniffed and never cached, and refused to everyone else', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });

    const shot = await h.wall('kitchen', `/d/camera/${handle}/still?n=1`);
    expect(shot.status).toBe(200);
    // The fake labels it a JPEG and sends a PNG: the type is the bytes'.
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect(shot.headers.get('cache-control')).toBe('no-store');
    expect(shot.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await shot.arrayBuffer()).equals(ARTWORK)).toBe(true);
    expect(h.ha.paths).toContain(`/api/camera_proxy/${DOOR}`);

    // The hall has it on no canvas: a 404 that says nothing about whether it exists.
    const elsewhere = await h.wall('hall', `/d/camera/${handle}/still`);
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers.get('cache-control')).toBe('no-store');
    // A handle nobody minted, and no token at all.
    expect((await h.wall('kitchen', `/d/camera/${'Z'.repeat(43)}/still`)).status).toBe(404);
    expect((await h.wall('nobody', `/d/camera/${handle}/still`)).status).toBe(401);
  });

  it('is reached from every canvas the wall can draw: the other orientation, a group, a timed layout, a loan', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    const reach = async (): Promise<number> => (await h.wall('hall', `/d/camera/${handle}/still`)).status;

    h.place({ id: 'cam-l', screen: 'hall', orientation: 'landscape', config: { camera: handle } });
    expect(await reach()).toBe(200);
    h.db.prepare(`DELETE FROM layout_widgets`).run();
    expect(await reach()).toBe(404);

    h.place({ id: 'g', screen: 'hall', type: 'group', config: { layout: 'row' } });
    h.place({ id: 'cam-g', screen: 'hall', parent: 'g', config: { camera: handle } });
    expect(await reach()).toBe(200);
    h.db.prepare(`DELETE FROM layout_widgets`).run();

    h.place({ id: 'cam-s', screen: 'hall', slot: 'Evening', config: { camera: handle } });
    expect(await reach()).toBe(200);
    h.db.prepare(`DELETE FROM layout_widgets`).run();

    // The kitchen lends its layout to every wall for a while (M1.3).
    h.place({ id: 'cam-k', screen: 'kitchen', config: { camera: handle } });
    expect(await reach()).toBe(404);
    expect(startLayoutOverride(h.db, 'kitchen', 10, Date.now()).ok).toBe(true);
    expect(await reach()).toBe(200);
  });

  it('costs Home Assistant one fetch however many walls ask at once, and another once the moment has passed', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });
    h.place({ id: 'cam-2', screen: 'hall', config: { camera: handle } });
    const answers = await Promise.all([
      h.wall('kitchen', `/d/camera/${handle}/still?n=1`),
      h.wall('hall', `/d/camera/${handle}/still?n=1`),
      h.wall('kitchen', `/d/camera/${handle}/still?n=2`),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(h.cameraRequests()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await h.wall('hall', `/d/camera/${handle}/still?n=3`)).status).toBe(200);
    expect(h.cameraRequests()).toBe(2);
  });

  it('is not asked for while the poll finds the camera missing, and says so without naming it', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });
    h.ha.cameras[DOOR] = { state: 'unavailable', name: 'Front door' };
    await h.poll();
    expect(readCameras(h.db)[0]?.available).toBe(false);
    const manifest = (await (await h.wall('kitchen', '/d/manifest')).json()) as { panels: Record<string, unknown> };
    expect(manifest.panels['cameras']).toEqual({ cameras: [{ handle, available: false }] });

    const refused = await h.wall('kitchen', `/d/camera/${handle}/still`);
    expect(refused.status).toBe(503);
    const body = await refused.text();
    expect(body).toContain('not answering');
    expect(body).not.toContain(DOOR);
    expect(h.cameraRequests()).toBe(0);

    // Gone from Home Assistant altogether reads the same way, and back again it is asked for.
    delete h.ha.cameras[DOOR];
    await h.poll();
    expect(readCameras(h.db)[0]?.available).toBe(false);
    h.ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
    await h.poll();
    expect((await h.wall('kitchen', `/d/camera/${handle}/still`)).status).toBe(200);
  });

  it('a picture that did not come is a sentence, not the entity id', async () => {
    const h = await harness();
    const handle = await addDoor(h);
    h.place({ id: 'cam-1', screen: 'kitchen', config: { camera: handle } });
    h.ha.cameraFails = true;
    const failed = await h.wall('kitchen', `/d/camera/${handle}/still`);
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(body).toContain('did not send a picture');
    expect(body).not.toContain(DOOR);
  });

  it('is read by the poll even when the house watches nothing else', async () => {
    const h = await harness();
    await addDoor(h);
    h.ha.cameras[DOOR] = { state: 'unavailable', name: 'Front door' };
    const before = h.ha.paths.length;
    await h.poll();
    expect(h.ha.paths.slice(before)).toContain('/api/states');
    expect(readCameras(h.db)[0]?.available).toBe(false);
  });

  it('goes with the connection: disconnecting Home Assistant forgets every camera', async () => {
    const h = await harness();
    await addDoor(h);
    await h.form('/admin/home-assistant/disconnect', {});
    expect(readCameras(h.db)).toEqual([]);
  });
});

describe('the widget’s settings', () => {
  it('take a handle and never an entity id, a refresh from one second to a minute, and nothing else', () => {
    expect(widgetConfigBody.safeParse({ camera: 'A'.repeat(43), cameraRefreshSec: 10, fit: 'contain' }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ camera: DOOR }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ cameraRefreshSec: 0 }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ cameraRefreshSec: 61 }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ cameraRefreshSec: 2.5 }).success).toBe(false);
  });
});

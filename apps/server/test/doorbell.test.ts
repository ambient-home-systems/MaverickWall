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
import { RING_HEARD_LATE_MS } from '../src/modules/homeassistant/conditions.js';
import { createFrameParser } from '../src/modules/cameras/frames.js';
import { unwatchCamera, watchCamera } from '../src/modules/cameras/index.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * The doorbell pop-up (plan item M6.3, RFC 007 phase 4): a "Tell me when…"
 * rule about a doorbell's `event` entity covers every wall with the camera it
 * names, live, for the time it holds, then hands the wall back.
 *
 * Against the real app, the real fetcher, a real poll of a stand-in Home
 * Assistant and a clock the test moves. What is proven: the form takes a
 * doorbell rule and refuses the six ways one can be half-written; a ring
 * reaches the manifest as a takeover carrying the camera's handle and the
 * moment it comes down, timed from when we heard if that was later; a ring
 * heard long after is history; the camera may be fetched by a wall only while
 * the takeover shows, and a stream open on it ends with the takeover; a camera
 * removed since is no camera and the ring still covers the wall; and an OK is
 * about one ring, not the doorbell.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const BELL = 'event.front_door_ring';
const DOOR = 'camera.front_door';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

const until = async (what: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Interrupt {
  readonly ruleId: string;
  readonly key: string;
  readonly action: string;
  readonly title: string;
  readonly camera?: string;
  readonly until?: number;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly handle: string;
  /** The test's clock: the app, the poll and the evaluation all read it. */
  at: number;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly admin: (path: string) => Promise<Response>;
  readonly wall: (path: string, init?: RequestInit) => Promise<Response>;
  readonly panel: (path: string) => Promise<Response>;
  readonly interrupts: () => Promise<Interrupt[]>;
  readonly poll: () => Promise<void>;
  /** The doorbell rings at this instant, as Home Assistant's `event` entity says. */
  readonly ring: (at: number) => void;
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  ha.cameras[DOOR] = { state: 'idle', name: 'Front door' };
  ha.streamEveryMs = 100;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-doorbell-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const h = { at: stamp } as Harness;
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.63.${n}.1`,
    setupToken,
    dataDir,
    now: () => h.at,
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
  await form('/setup/account', {
    name: 'Household',
    email: `door${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  const added = watchCamera(db, { entityId: DOOR, name: 'Front door' }, stamp);
  if (!added.ok) throw new Error(added.message);

  // A wall with no camera widget on it at all: the camera reaches it only
  // through the takeover. And an e-paper panel, which never draws a picture.
  const wall = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(wall.tokenHash, stamp, stamp, stamp);
  const panel = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, kind, panel_width, panel_height, panel_colour, rotation,
                          layout_mode, token_issued_at, created_at, updated_at)
     VALUES ('hall', 'Hall', ?, 'epaper', 800, 480, 'bw', 0, 'freeform', ?, ?, ?)`,
  ).run(panel.tokenHash, stamp, stamp, stamp);

  const context = {
    db,
    fetcher,
    keyring,
    timezone: 'Europe/London',
    get now(): number {
      return h.at;
    },
  };
  return Object.assign(h, {
    db,
    ha,
    handle: added.handle,
    form,
    admin: (path: string) => admin(path),
    wall: (path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${wall.token}` },
        }),
      ),
    panel: (path: string) =>
      app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${panel.token}` } })),
    interrupts: async () => {
      const response = await app.fetch(
        new Request('http://localhost/d/manifest', { headers: { authorization: `Bearer ${wall.token}` } }),
      );
      return ((await response.json()) as { interrupts: Interrupt[] }).interrupts;
    },
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    ring: (at: number) => {
      ha.others[BELL] = { state: new Date(at).toISOString(), name: 'Front door ring' };
    },
  });
}

/** The doorbell rule, as the form posts it. */
const DOORBELL = (camera: string): Record<string, string> => ({
  name: 'Somebody at the door',
  entity_id: BELL,
  condition: 'happened',
  value: '',
  action: 'takeover',
  hold_sec: '60',
  camera,
});

function frames(response: Response): { readonly got: Uint8Array[]; readonly done: Promise<void> } {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const parser = createFrameParser(4 * 1024 * 1024);
  const got: Uint8Array[] = [];
  const done = (async (): Promise<void> => {
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) return;
      got.push(...parser.push(value));
    }
  })();
  return { got, done };
}

describe('the doorbell rule on the form', () => {
  it('is offered as a template, and lists the doorbell and the camera', async () => {
    const h = await harness();
    h.ring(h.at - 3_600_000);
    const page = await (await h.admin('/admin/home-assistant/alerts/new?template=doorbell')).text();
    expect(page).toContain('Somebody at the door');
    expect(page).toMatch(/<option value="happened" selected>rings, or is pressed<\/option>/);
    expect(page).toMatch(/<option value="60" selected>after 1 minute<\/option>/);
    expect(page).toContain(`<option value="${BELL}">Front door ring — event</option>`);
    expect(page).toContain(`<option value="${h.handle}">Front door</option>`);
  });

  it('stores a hold and a camera, and makes no reading of the doorbell', async () => {
    const h = await harness();
    const saved = await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    expect(saved.status).toBe(302);
    const row = h.db.prepare('SELECT hold_sec AS holdSec, camera, action FROM interrupt_rules WHERE name = ?').get(
      'Somebody at the door',
    ) as { holdSec: number; camera: string; action: string };
    expect(row).toEqual({ holdSec: 60, camera: h.handle, action: 'takeover' });
    expect(h.db.prepare('SELECT count(*) AS n FROM ha_entity_cache WHERE entity_id = ?').get(BELL)).toEqual({ n: 0 });
    // The rules screen says what it does.
    const list = await (await h.admin('/admin/home-assistant/alerts')).text();
    expect(list).toContain('rings, or is pressed');
    expect(list).toContain('down after 1 minute · with a camera');
  });

  it('saves an ordinary rule exactly as before when the hold is left on “when it stops”', async () => {
    // The browser posts the select's blank option as `''`; that is no hold.
    const h = await harness();
    const saved = await h.form('/admin/home-assistant/rules', {
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer',
      condition: 'equals',
      value: 'on',
      action: 'banner',
      hold_sec: '',
      camera: '',
    });
    expect(saved.status).toBe(302);
    expect(
      h.db.prepare(`SELECT hold_sec AS holdSec, camera FROM interrupt_rules WHERE name = 'Freezer door open'`).get(),
    ).toEqual({ holdSec: null, camera: null });
  });

  it('refuses each half-written doorbell, with a sentence, and stores nothing', async () => {
    const h = await harness();
    const refused: [Record<string, string>, string][] = [
      [{ ...DOORBELL(h.handle), entity_id: 'binary_sensor.porch' }, 'Only a doorbell or a button rings'],
      [{ ...DOORBELL(h.handle), condition: 'equals', value: 'on' }, 'never in a state to compare'],
      [{ ...DOORBELL(h.handle), hold_sec: '' }, 'Choose how long the wall shows it for'],
      [{ ...DOORBELL(h.handle), for_minutes: '5' }, 'Leave the wait empty'],
      [{ ...DOORBELL(h.handle), action: 'banner' }, 'goes with “The whole wall”'],
      [{ ...DOORBELL('x'.repeat(43)) }, 'not one you added'],
      [{ ...DOORBELL(h.handle), hold_sec: '45' }, 'Choose how long it stays from the list'],
    ];
    for (const [fields, sentence] of refused) {
      const response = await h.form('/admin/home-assistant/rules', fields);
      expect(response.status, sentence).toBe(400);
      expect((await response.text()).replace(/&#39;|&#x27;/g, "'")).toContain(sentence);
    }
    expect(h.db.prepare('SELECT count(*) AS n FROM interrupt_rules WHERE trigger = ?').get('homeassistant')).toEqual({ n: 0 });
  });
});

describe('a ring', () => {
  it('covers the wall with the camera for the time it holds, then hands it back', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    h.ring(h.at - 3_600_000);
    await h.poll();
    // An hour-old ring is nothing to show.
    expect(await h.interrupts()).toEqual([]);

    const rang = h.at - 2_000;
    h.ring(rang);
    await h.poll();
    const [shown] = await h.interrupts();
    expect(shown).toMatchObject({
      action: 'takeover',
      // The rule's own sentence, with the doorbell's name under it.
      title: 'Somebody at the door',
      headline: 'Front door ring',
      camera: h.handle,
      until: h.at + 60_000,
    });
    // Rule twelve: the camera travels as its handle, never the camera's entity.
    expect(JSON.stringify(await h.interrupts())).not.toContain(DOOR);

    h.at += 59_000;
    expect(await h.interrupts()).toHaveLength(1);
    h.at += 1_001;
    expect(await h.interrupts()).toEqual([]);
  });

  it('is held from when we heard, when the poll was late, and is history when it was very late', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    // Rang forty seconds before the poll heard of it: a whole minute from the poll.
    h.ring(h.at - 40_000);
    await h.poll();
    expect((await h.interrupts())[0]?.until).toBe(h.at + 60_000);
    // Heard again on the next poll, with nothing new: still the same minute.
    h.at += 30_000;
    await h.poll();
    expect((await h.interrupts())[0]?.until).toBe(h.at - 30_000 + 60_000);

    // Rang longer ago than any poll is late by: what it says, it said long ago.
    const late = await harness();
    await late.form('/admin/home-assistant/rules', DOORBELL(late.handle));
    late.ring(late.at - RING_HEARD_LATE_MS - 1_000);
    await late.poll();
    expect(await late.interrupts()).toEqual([]);
  });

  it('lets a wall fetch the camera only while the takeover shows it, and ends a stream with it', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    const still = `/d/camera/${h.handle}/still`;
    // No camera widget on this wall, and no ring: the camera does not exist to it.
    expect((await h.wall(still)).status).toBe(404);

    h.ring(h.at - 1_000);
    await h.poll();
    expect((await h.wall(still)).status).toBe(200);
    // A panel draws no picture, takeover or not.
    expect((await h.panel(still)).status).toBe(404);

    const stream = await h.wall(`/d/camera/${h.handle}/stream`);
    expect(stream.status).toBe(200);
    const live = frames(stream);
    await until(() => live.got.length >= 2);

    // The minute is up: the stream ends within its one-second check.
    h.at += 61_000;
    const ended = Date.now();
    await live.done;
    expect(Date.now() - ended).toBeLessThan(2_500);
    expect((await h.wall(still)).status).toBe(404);
  });

  it('still covers the wall when its camera has been removed, with no camera', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    unwatchCamera(h.db, h.handle);
    h.ring(h.at - 1_000);
    await h.poll();
    const [shown] = await h.interrupts();
    expect(shown?.action).toBe('takeover');
    expect(shown).not.toHaveProperty('camera');
    expect((await h.wall(`/d/camera/${h.handle}/still`)).status).toBe(404);
  });

  it('takes an OK as being about one ring, so the next ring shows again', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', DOORBELL(h.handle));
    h.ring(h.at - 1_000);
    await h.poll();
    const [shown] = await h.interrupts();
    const ok = await h.wall('/d/interrupts/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: `${shown?.ruleId}:${shown?.key}` }).toString(),
    });
    expect(ok.status).toBe(200);
    expect(await h.interrupts()).toEqual([]);

    h.at += 120_000;
    h.ring(h.at - 1_000);
    await h.poll();
    expect(await h.interrupts()).toHaveLength(1);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { MEDIA_START_GRAIN_MS, mediaFor, type HaState } from '../src/modules/homeassistant/entities.js';
import {
  HA_NOTIFICATIONS_COMMAND,
  MAX_HA_NOTIFICATIONS,
  parseNotifications,
  plainText,
  websocketUrl,
} from '../src/modules/homeassistant/notifications.js';
import { SUPERVISOR_BASE, type Connection } from '../src/modules/homeassistant/client.js';
import { haReadingHandle, manifestEtag, type Manifest } from '../src/api/manifest.js';
import { mediaElapsed, mediaFollowed } from '../src/api/status-card.js';
import { bannersOf, tileFor, tileHandle, tilesOf } from '../src/api/notifications.js';
import { panelInput } from '../src/epaper/widgets.js';
import type { Interrupt, InterruptRule } from '@maverick-wall/core';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * The now-playing card (plan item M6.9) and the Notifications widget (plan
 * item M6.11), against the real app, a real database and the stand-in Home
 * Assistant — which now has a WebSocket API as Core's is.
 *
 * What never happens: a track reaches the cache or a wall for a household
 * with no now-playing card; the manifest moves while a song plays; a tile
 * rule draws over the wall or carries an entity id; the house is asked for
 * its notifications without a widget that shows them, or asked anything but
 * that one read. And what does: a card's player carries its title and the
 * instant its track started; a tile rule's sentence reaches the widget with a
 * handle a wall can acknowledge it by; Home Assistant's own notifications,
 * read over a pinned socket, replace each other whole.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const PLAYER = 'media_player.kitchen';
const FREEZER = 'binary_sensor.freezer_door';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

function playerState(attributes: HaState['attributes'], state = 'playing'): HaState {
  return {
    entityId: PLAYER,
    domain: 'media_player',
    state,
    friendlyName: 'Kitchen speaker',
    unit: null,
    deviceClass: null,
    lastChangedAt: null,
    attributes,
  };
}

describe('what a player plays, as a card reads it (M6.9)', () => {
  const at = Date.UTC(2026, 9, 12, 12, 0, 0);

  it('sends the instant a playing track started, to five seconds, and the same instant for a re-report', () => {
    const now = mediaFor(
      playerState({ media_title: 'Song', media_duration: 240, media_position: 90, media_position_updated_at: new Date(at).toISOString() }),
    );
    expect(now.startedAt).toBe(at - 90_000);
    expect((now.startedAt ?? 0) % MEDIA_START_GRAIN_MS).toBe(0);
    // Said again thirty seconds and a little later, with the position moved
    // on by as much: the same start, so the manifest does not move.
    const again = mediaFor(
      playerState({ media_title: 'Song', media_duration: 240, media_position: 121.4, media_position_updated_at: new Date(at + 31_000).toISOString() }),
    );
    expect(again.startedAt).toBe(now.startedAt);
    expect(now).not.toHaveProperty('position');
  });

  it('sends where a paused track stopped, and nothing for a position past the track’s end', () => {
    const paused = mediaFor(playerState({ media_duration: 240, media_position: 90.6 }, 'paused'));
    expect(paused).toEqual({ duration: 240, position: 91 });
    expect(mediaFor(playerState({ media_duration: 240, media_position: 300, media_position_updated_at: new Date(at).toISOString() }))).toEqual({ duration: 240 });
  });

  it('cleans a stranger’s words and leaves out the empty ones', () => {
    const now = mediaFor(playerState({ media_title: 'A‮b\u0007c', media_artist: ' ', media_album_name: 'Album' }));
    expect(now.title).toBe('Abc');
    expect(now).not.toHaveProperty('artist');
    expect(now.album).toBe('Album');
  });

  it('follows the player that is playing, else the one with a track, else the first; counts the bar from the start', () => {
    const idle = { key: 'a', value: 'Idle', tone: null, media: {} };
    const paused = { key: 'b', value: 'Paused', tone: null, media: { title: 'Paused song' } };
    const playing = { key: 'c', value: 'Playing', tone: 'active', media: { title: 'Now' } };
    const notAPlayer = { key: 'd', value: '19 °C', tone: 'active' };
    expect(mediaFollowed([idle, paused, playing, notAPlayer])?.key).toBe('c');
    expect(mediaFollowed([idle, paused, notAPlayer])?.key).toBe('b');
    expect(mediaFollowed([idle, notAPlayer])?.key).toBe('a');
    expect(mediaFollowed([notAPlayer])).toBeUndefined();
    expect(mediaElapsed({ duration: 240, startedAt: at - 60_000 }, at)).toBe(60);
    expect(mediaElapsed({ duration: 240, startedAt: at - 600_000 }, at)).toBe(240);
    expect(mediaElapsed({ duration: 240, position: 30 }, at)).toBe(30);
    expect(mediaElapsed({ title: 'x' }, at)).toBeUndefined();
  });
});

describe('notification tiles and Home Assistant’s notifications, as decisions (M6.11)', () => {
  const interrupt = (over: Partial<Interrupt>): Interrupt => ({
    ruleId: 'r1',
    key: FREEZER,
    source: 'homeassistant',
    action: 'tile',
    title: 'Freezer door',
    headline: 'Open',
    severity: 'Unknown',
    urgency: 'Unknown',
    dismissible: true,
    wakeScreen: false,
    piercesNightMode: false,
    priority: 20,
    ...over,
  });
  const rules = [{ id: 'r1', name: 'Freezer left open' } as InterruptRule];

  it('takes the tiles out of the banners, in order, with the rule’s own words and no entity id', () => {
    const banner = interrupt({ ruleId: 'r2', action: 'banner', key: 'sensor.x' });
    const tile = interrupt({});
    expect(bannersOf([banner, tile])).toEqual([banner]);
    const tiles = tilesOf([banner, tile], rules);
    expect(tiles).toEqual([
      { key: tileHandle('r1', FREEZER), title: 'Freezer left open', detail: 'Freezer door · Open', dismissible: true },
    ]);
    expect(JSON.stringify(tiles)).not.toContain(FREEZER);
    expect(tilesOf([interrupt({ severity: 'Severe' })], rules)[0]?.tone).toBe('alert');
    expect(tileFor(tileHandle('r1', FREEZER), [tile])).toEqual({ ruleId: 'r1', signalKey: FREEZER });
    expect(tileFor(tileHandle('r1', 'other'), [tile])).toBeUndefined();
  });

  it('reads a notification as plain words, newest first, skipping one that will not read', () => {
    expect(plainText('**Backup** failed: see [the log](http://ha.local/x) ![img](y)', 200)).toBe('Backup failed: see the log');
    const many = Array.from({ length: MAX_HA_NOTIFICATIONS + 5 }, (_, i) => ({
      notification_id: `n${i}`,
      title: null,
      message: `Message ${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    const parsed = parseNotifications([...many, { notification_id: 7, message: 'bad' }, { notification_id: 'x', message: '' }]);
    expect(parsed).toHaveLength(MAX_HA_NOTIFICATIONS);
    expect(parsed[0]?.message).toBe(`Message ${MAX_HA_NOTIFICATIONS + 4}`);
    expect(parseNotifications('not a list')).toEqual([]);
  });

  it('asks the supervisor at its own path and a pasted address under its API', () => {
    const base = { token: 't', policy: {}, host: 'h' };
    expect(websocketUrl({ ...base, mode: 'supervisor', baseUrl: SUPERVISOR_BASE } as Connection)).toBe('http://supervisor/core/websocket');
    expect(websocketUrl({ ...base, mode: 'manual', baseUrl: 'http://ha.local:8123/api' } as Connection)).toBe('http://ha.local:8123/api/websocket');
  });
});

describe('the guarded socket', () => {
  it('refuses a loopback address it was not allowed, before anything is sent', async () => {
    let connected = false;
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', () => {
      connected = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const fetcher = createFetcher();
    const refused = await fetcher.socket?.({
      url: `http://127.0.0.1:${port}/`,
      policy: { allowHttp: true },
      maxBytes: 1000,
      converse: () => ({ done: 'x' }),
    });
    expect(refused?.status).toBe('rejected');
    expect(connected).toBe(false);
    // Allowed, it converses, and a message over the ceiling ends it.
    sockets.on('connection', (ws) => ws.send('x'.repeat(5000)));
    const tooBig = await fetcher.socket?.({
      url: `http://127.0.0.1:${port}/`,
      policy: { allowHttp: true, allowLoopback: true, allowPrivateNetwork: true },
      maxBytes: 1000,
      timeoutMs: 3000,
      converse: () => ({ done: 'never' }),
    });
    expect(tooBig?.status).toBe('failed');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sockets.close();
  });
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly wall: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly place: (id: string, type: string, config: Record<string, unknown>) => void;
  readonly at: { now: number };
}

async function harness(watch: readonly string[]): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-np-'));
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
    clientAddress: () => `10.53.${n}.1`,
    setupToken,
    dataDir,
  });
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
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
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `np${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  if (watch.length > 0) {
    const watched = await call('/admin/home-assistant/entities/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: watch.map((entity_id) => ({ entity_id })), display_mode: 'label_value' }),
    });
    expect(watched.status).toBe(200);
  }
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, allow_dismiss, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', 1, ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  const at = { now: Date.now() };
  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return at.now; } };
  return {
    db,
    ha,
    at,
    form,
    wall: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${display.token}`);
      return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
    },
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    place: (id, type, config) => {
      db.prepare(`DELETE FROM layout_widgets WHERE id = ?`).run(id);
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES (?, 'wall', 'portrait', ?, 0, 0, 1, 1, 0, ?, ?, ?)`,
      ).run(id, type, JSON.stringify(config), stamp, stamp);
    },
  };
}

const manifestOf = async (h: Harness): Promise<{ text: string; manifest: Manifest }> => {
  const text = await (await h.wall('/d/manifest')).text();
  return { text, manifest: JSON.parse(text) as Manifest };
};

interface PlayerReading {
  readonly key: string;
  readonly media?: Record<string, unknown>;
  readonly picture?: string;
}

const playerOf = (manifest: Manifest): PlayerReading | undefined =>
  ((manifest.panels['home'] as { readings?: PlayerReading[] } | undefined)?.readings ?? []).find(
    (reading) => reading.key === haReadingHandle(PLAYER),
  );

describe('a now-playing card on a wall (M6.9)', () => {
  it('keeps and sends no track for a household with no card', async () => {
    const h = await harness([PLAYER]);
    h.place('w-ha', 'homeassistant', { readings: [PLAYER] });
    await h.poll();
    const { text, manifest } = await manifestOf(h);
    expect(playerOf(manifest)).toBeDefined();
    expect(playerOf(manifest)?.media).toBeUndefined();
    expect(text).not.toContain('A track title');
    // Nor in the cache, which is what a backup carries.
    expect(JSON.stringify(h.db.prepare('SELECT attributes FROM ha_entity_cache').all())).not.toContain('A track title');
  });

  it('sends a followed player’s track, its sleeve and when it started — and no entity id', async () => {
    const h = await harness([PLAYER]);
    h.place('w-ha', 'homeassistant', { variant: 'media', readings: [PLAYER] });
    await h.poll();
    const { text, manifest } = await manifestOf(h);
    const media = playerOf(manifest)?.media;
    expect(media).toMatchObject({ title: 'A track title that must not travel', artist: 'An artist', album: 'An album', duration: 240 });
    expect(typeof media?.['startedAt']).toBe('number');
    expect(playerOf(manifest)?.picture).toMatch(/^[a-f0-9]{64}\.jpg$/);
    expect(text).not.toContain(PLAYER);
    expect(text).not.toContain('media_player_proxy');
    expect(text).not.toContain(TOKEN);
  });

  it('does not move the manifest while a song plays, and does when the song changes', async () => {
    const h = await harness([PLAYER]);
    h.place('w-ha', 'homeassistant', { variant: 'media', readings: [PLAYER] });
    // Both reports are stated from one instant a second into a five-second
    // grain, so the starts they imply (200 ms apart, as a real re-report's are)
    // round to the same grain. Taken from two clocks (the fake's stand-up and
    // this line), the two starts could fall either side of a grain's edge.
    const base = Math.floor(Date.now() / 5000) * 5000 + 1000;
    h.ha.set[PLAYER] = { media_position: 90, media_position_updated_at: new Date(base).toISOString() };
    await h.poll();
    const first = manifestEtag((await manifestOf(h)).manifest);
    // Home Assistant re-reports the position thirty seconds on.
    const said = base + 30_200;
    h.ha.set[PLAYER] = { media_position: 120.2, media_position_updated_at: new Date(said).toISOString() };
    await h.poll();
    expect(manifestEtag((await manifestOf(h)).manifest)).toBe(first);
    h.ha.set[PLAYER] = { media_title: 'The next song', media_position: 0, media_position_updated_at: new Date(said).toISOString() };
    await h.poll();
    const next = await manifestOf(h);
    expect(manifestEtag(next.manifest)).not.toBe(first);
    expect(playerOf(next.manifest)?.media?.['title']).toBe('The next song');
  });

  it('hands a panel the words alone, only for a card, never where the track has got to', async () => {
    const h = await harness([PLAYER]);
    h.place('w-ha', 'homeassistant', { variant: 'media', readings: [PLAYER] });
    await h.poll();
    const { manifest } = await manifestOf(h);
    const card = JSON.stringify(panelInput('homeassistant', manifest, { variant: 'media' }));
    expect(card).toContain('A track title');
    expect(card).not.toContain('startedAt');
    expect(card).not.toContain('duration');
    const list = JSON.stringify(panelInput('homeassistant', manifest, {}));
    expect(list).not.toContain('A track title');
  });

  it('lets the card’s transport through the one door, behind the three switches', async () => {
    const h = await harness([PLAYER]);
    h.db.prepare(`UPDATE ha_entity_cache SET controllable = 1 WHERE entity_id = ?`).run(PLAYER);
    h.db.prepare(`UPDATE screens SET allow_control = 1 WHERE id = 'wall'`).run();
    h.place('w-ha', 'homeassistant', { variant: 'media', readings: [PLAYER], tapAction: 'act' });
    await h.poll();
    const press = await h.wall('/d/ha/act', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reading: haReadingHandle(PLAYER), widget: 'w-ha', action: 'next' }).toString(),
    });
    expect(press.status).toBe(200);
    expect(h.ha.posts.some((post) => post.path.includes('media_next_track'))).toBe(true);
  });
});

describe('the Notifications widget (M6.11)', () => {
  const tileRule = (h: Harness, action = 'tile'): Promise<Response> =>
    h.form('/admin/home-assistant/rules', {
      name: 'Freezer left open',
      entity_id: FREEZER,
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action,
    });

  it('says a tile rule in the widget, never over the wall, with a handle and no entity id', async () => {
    const h = await harness([]);
    expect((await tileRule(h)).status).toBe(302);
    h.place('w-nf', 'notifications', {});
    // A second box, so the never-empty guard cannot be what keeps this one.
    h.place('w-clock', 'clock', {});
    await h.poll();
    const { text, manifest } = await manifestOf(h);
    expect(manifest.interrupts).toEqual([]);
    const tiles = (manifest.panels['notifications'] as { tiles?: { key: string; title: string; detail?: string }[] }).tiles;
    expect(tiles).toHaveLength(1);
    expect(tiles?.[0]?.title).toBe('Freezer left open');
    expect(tiles?.[0]?.detail).toBe('Freezer door · Open');
    expect(tiles?.[0]?.key).toMatch(/^tile:[0-9a-f]{24}$/);
    expect(text).not.toContain(FREEZER);
    // The widget is drawn, not left out, while something is firing.
    const widgets = (manifest as unknown as { layout: { portrait: { widgets: { id: string }[] } } }).layout.portrait.widgets;
    expect(widgets.map((widget) => widget.id)).toContain('w-nf');
  });

  it('leaves the widget out with nothing to say, and draws its fallback instead', async () => {
    const h = await harness([]);
    h.place('w-nf', 'notifications', { whenEmpty: { type: 'notes', config: { text: 'All quiet' } } });
    await h.poll();
    const { manifest } = await manifestOf(h);
    const widget = (manifest as unknown as { layout: { portrait: { widgets: { id: string; type: string }[] } } }).layout.portrait.widgets
      .find((one) => one.id === 'w-nf');
    expect(widget?.type).toBe('notes');
  });

  it('is acknowledged by its handle, household-wide, and comes back off the widget', async () => {
    const h = await harness([]);
    await tileRule(h);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const key = ((await manifestOf(h)).manifest.panels['notifications'] as { tiles: { key: string }[] }).tiles[0]?.key ?? '';
    const ok = await h.wall('/d/interrupts/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key }).toString(),
    });
    expect(ok.status).toBe(200);
    const after = (await manifestOf(h)).manifest;
    expect((after.panels['notifications'] as { tiles?: unknown[] } | undefined)?.tiles ?? []).toEqual([]);
    // A handle naming nothing firing is not found.
    const stale = await h.wall('/d/interrupts/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: tileHandle('nope', FREEZER) }).toString(),
    });
    expect(stale.status).toBe(404);
  });

  it('lets a banner rule on the same thing win, and a banner is still a banner', async () => {
    const h = await harness([]);
    await tileRule(h);
    await h.form('/admin/home-assistant/rules', {
      name: 'Freezer open — banner',
      entity_id: FREEZER,
      condition: 'equals',
      value: 'on',
      action: 'banner',
    });
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const { manifest } = await manifestOf(h);
    expect(manifest.interrupts).toHaveLength(1);
    expect(manifest.interrupts[0]?.action).toBe('banner');
    expect((manifest.panels['notifications'] as { tiles?: unknown[] } | undefined)?.tiles ?? []).toEqual([]);
  });

  it('reads Home Assistant’s notifications over the socket only while a widget shows them, and replaces them whole', async () => {
    const h = await harness([]);
    h.ha.notifications.push({
      notification_id: 'config_entry_discovery',
      title: 'New devices discovered',
      message: 'We found **2** new devices.',
      created_at: new Date().toISOString(),
    });
    await h.poll();
    // No widget: never asked.
    expect(h.ha.wsReceived).toEqual([]);

    h.place('w-nf', 'notifications', {});
    await h.poll();
    // The token, then the one read, and nothing else.
    expect(h.ha.wsReceived.map((text) => (JSON.parse(text) as { type: string }).type)).toEqual(['auth', HA_NOTIFICATIONS_COMMAND]);
    let { text, manifest } = await manifestOf(h);
    const ha = (manifest.panels['notifications'] as { ha?: { key: string; title?: string; message: string }[] }).ha;
    expect(ha).toEqual([expect.objectContaining({ title: 'New devices discovered', message: 'We found 2 new devices.' })]);
    expect(ha?.[0]?.key).toMatch(/^han:[0-9a-f]{24}$/);
    expect(text).not.toContain('config_entry_discovery');
    expect(text).not.toContain(TOKEN);

    // Dismissed in Home Assistant: gone from every wall on the next read.
    h.ha.notifications.splice(0);
    await h.poll();
    ({ text, manifest } = await manifestOf(h));
    expect(manifest.panels['notifications']).toBeUndefined();

    // Down: the last good copy is kept.
    h.ha.notifications.push({ notification_id: 'n2', title: null, message: 'Kept', created_at: new Date().toISOString() });
    await h.poll();
    h.ha.down = true;
    await h.poll();
    h.ha.down = false;
    expect(JSON.stringify((await manifestOf(h)).manifest.panels['notifications'])).toContain('Kept');

    // The widget turns them off: they are forgotten, and not asked for again.
    const asked = h.ha.wsReceived.length;
    h.place('w-nf', 'notifications', { haNotifications: false });
    await h.poll();
    expect(h.ha.wsReceived.length).toBe(asked);
    expect(h.db.prepare('SELECT count(*) AS n FROM ha_notifications').get()).toEqual({ n: 0 });
  });
});

describe('dismissing a Home Assistant notification from a wall (rule 12, amended 2026-10-14)', () => {
  const seed = (h: Harness): void => {
    const at = new Date().toISOString();
    h.ha.notifications.push(
      { notification_id: 'config_entry_discovery', title: 'New devices discovered', message: 'We found 2.', created_at: at },
      { notification_id: 'backup_failed', title: null, message: 'The backup failed.', created_at: at },
    );
  };
  const handles = async (h: Harness): Promise<string[]> =>
    ((await manifestOf(h)).manifest.panels['notifications'] as { ha?: { key: string }[] } | undefined)?.ha?.map((one) => one.key) ?? [];
  const dismiss = (h: Harness, key: string): Promise<Response> =>
    h.wall('/d/notifications/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key }).toString(),
    });

  it('dismisses the one it names, in Home Assistant, and the wall’s list loses it at once', async () => {
    const h = await harness([]);
    seed(h);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const [first, second] = await handles(h);
    expect(first).toBeDefined();
    const target = ((await manifestOf(h)).manifest.panels['notifications'] as { ha: { key: string; message: string }[] }).ha.find(
      (one) => one.message === 'We found 2.',
    )!.key;

    const response = await dismiss(h, target);
    expect(response.status).toBe(200);
    // One call, through the table, naming one notification and nothing else.
    expect(h.ha.posts.map((post) => [post.path, JSON.parse(post.body)])).toEqual([
      ['/api/services/persistent_notification/dismiss', { notification_id: 'config_entry_discovery' }],
    ]);
    expect(h.ha.notifications.map((one) => one.notification_id)).toEqual(['backup_failed']);
    // Gone from the wall before the next read of Home Assistant.
    const after = await handles(h);
    expect(after).toHaveLength(1);
    expect(after).not.toContain(target);
    expect([first, second]).toContain(after[0]);
  });

  it('is refused by a wall not allowed to clear alerts, before anything is asked', async () => {
    const h = await harness([]);
    seed(h);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const [key] = await handles(h);
    h.db.prepare(`UPDATE screens SET allow_dismiss = 0 WHERE id = 'wall'`).run();
    const response = await dismiss(h, key!);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toBe('This wall cannot clear alerts.');
    expect(h.ha.posts).toEqual([]);
    expect(h.ha.notifications).toHaveLength(2);
  });

  it('dismisses nothing a wall was not shown: no widget, a widget that hides them, an unknown handle, or Home Assistant’s own id', async () => {
    const h = await harness([]);
    seed(h);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const [key] = await handles(h);

    // The id itself is never a handle.
    expect((await dismiss(h, 'config_entry_discovery')).status).toBe(400);
    // A handle shaped right that names nothing read.
    expect((await dismiss(h, `han:${'0'.repeat(24)}`)).status).toBe(404);
    // The widget stops showing Home Assistant's — on this wall nothing shows it now.
    h.db.prepare(`UPDATE layout_widgets SET config = ? WHERE id = 'w-nf'`).run(JSON.stringify({ haNotifications: false }));
    expect((await dismiss(h, key!)).status).toBe(404);
    // And no widget at all.
    h.db.prepare(`DELETE FROM layout_widgets WHERE id = 'w-nf'`).run();
    expect((await dismiss(h, key!)).status).toBe(404);
    expect(h.ha.posts).toEqual([]);
  });

  it('keeps the notification when Home Assistant cannot be reached, and says so', async () => {
    const h = await harness([]);
    seed(h);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    const [key] = await handles(h);
    h.ha.down = true;
    const response = await dismiss(h, key!);
    h.ha.down = false;
    expect(response.status).toBe(502);
    expect(((await response.json()) as { message: string }).message).not.toBe('');
    expect(await handles(h)).toContain(key);
  });
});

describe('a house that watches readings', () => {
  it('is not asked for its notifications either, until a widget shows them', async () => {
    const h = await harness([PLAYER]);
    h.ha.notifications.push({ notification_id: 'n1', title: null, message: 'Hello', created_at: new Date().toISOString() });
    h.place('w-ha', 'homeassistant', {});
    await h.poll();
    expect(h.ha.wsReceived).toEqual([]);
    h.place('w-nf', 'notifications', {});
    await h.poll();
    expect(h.ha.wsReceived).toHaveLength(2);
  });
});

describe('the one socket door (rule 12)', () => {
  it('sends only the token and the notifications read, from one file', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules', 'homeassistant', 'notifications.ts'),
      'utf8',
    );
    const sent = [...source.matchAll(/JSON\.stringify\(\{\s*(?:id: \d+, )?type: ([^,}]+)/g)].map((match) => match[1]?.trim());
    expect(sent).toEqual(["'auth'", 'HA_NOTIFICATIONS_COMMAND']);
    expect(HA_NOTIFICATIONS_COMMAND).toBe('persistent_notification/get');
  });

  it('is opened by that file alone', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') && /\.socket\??\.?\(/.test(readFileSync(path, 'utf8'))) {
          callers.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(callers).toEqual(['modules/homeassistant/notifications.ts']);
  });
});

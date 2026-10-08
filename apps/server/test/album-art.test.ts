import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { pictureKey } from '../src/modules/homeassistant/entities.js';
import { nowPlayingArt } from '../src/modules/homeassistant/artwork.js';
import { displayConfig } from '../src/api/manifest.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import { ARTWORK, TOKEN, UNLISTED_ATTRIBUTE_MARKERS, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * Album art while music plays (plan item M3.4), against the real app, a real
 * database and the stand-in Home Assistant, whose kitchen speaker is playing
 * with a picture whose address carries a token that must never travel.
 *
 * What never happens: the picture's address, its token, the player's entity id
 * or the track reach a wall or the cache; a wall gets a picture for a player
 * that is not playing, or a picture that is not the one playing now. And what
 * does: the widget shows the record's sleeve while it plays.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const PLAYER = 'media_player.kitchen';
const PICTURE = '/api/media_player_proxy/media_player.kitchen?token=picture-token-that-must-not-travel';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly dataDir: string;
  readonly ha: FakeHa;
  readonly wall: (path: string) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly place: (config: Record<string, unknown>) => void;
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-art-'));
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
    clientAddress: () => `10.51.${n}.1`,
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
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', { name: 'Household', email: `art${n}@home.local`, password: 'correct-horse-battery', confirm: 'correct-horse-battery' });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });
  const watched = await call('/admin/home-assistant/entities/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities: [{ entity_id: PLAYER }], display_mode: 'label_value' }),
  });
  expect(watched.status).toBe(200);
  const display = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', ?, 'freeform', ?, ?)`,
  ).run(display.tokenHash, stamp, stamp, stamp);
  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return Date.now(); } };
  return {
    db,
    dataDir,
    ha,
    wall: async (path) => app.fetch(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${display.token}` } })),
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    place: (config) => {
      db.prepare(`DELETE FROM layout_widgets WHERE id = 'w-art'`).run();
      db.prepare(
        `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
         VALUES ('w-art', 'wall', 'portrait', 'image', 0, 0, 1, 1, 0, ?, ?, ?)`,
      ).run(JSON.stringify(config), stamp, stamp);
    },
  };
}

const handleOf = (picture: string): string => `${pictureKey(picture)}.jpg`;
const widgetConfigIn = async (h: Harness): Promise<Record<string, unknown>> => {
  const manifest = (await (await h.wall('/d/manifest')).json()) as {
    layout: { portrait: { widgets: { id: string; config: Record<string, unknown> }[] } };
  };
  return manifest.layout.portrait.widgets.find((widget) => widget.id === 'w-art')?.config ?? {};
};

describe('the cache', () => {
  it('keeps a hash of the picture’s address and never the address, its token or the track', async () => {
    const h = await harness();
    await h.poll();
    const row = JSON.stringify(h.db.prepare('SELECT * FROM ha_entity_cache WHERE entity_id = ?').get(PLAYER));
    expect(row).toContain(pictureKey(PICTURE));
    for (const marker of UNLISTED_ATTRIBUTE_MARKERS) expect(row).not.toContain(marker);
  });
});

describe('the manifest', () => {
  it('hands a widget naming a playing player the picture’s handle and never the player or the picture', async () => {
    const h = await harness();
    await h.poll();
    h.place({ nowPlaying: PLAYER });
    expect(await widgetConfigIn(h)).toEqual({ nowPlaying: true, art: handleOf(PICTURE) });
    const document = await (await h.wall('/d/manifest')).text();
    expect(document).not.toContain(PLAYER);
    for (const marker of UNLISTED_ATTRIBUTE_MARKERS) expect(document).not.toContain(marker);
  });

  it('hands over no picture while the player is paused, and a new one when the song changes', async () => {
    const h = await harness();
    h.place({ nowPlaying: PLAYER, image: `${'a'.repeat(64)}.png` });
    h.ha.toggled[PLAYER] = 'paused';
    await h.poll();
    expect(await widgetConfigIn(h)).toEqual({ nowPlaying: true, image: `${'a'.repeat(64)}.png` });
    h.ha.toggled[PLAYER] = 'playing';
    const next = '/api/media_player_proxy/media_player.kitchen?token=another-token&cache=next-song';
    h.ha.set[PLAYER] = { entity_picture: next };
    await h.poll();
    expect((await widgetConfigIn(h))['art']).toBe(handleOf(next));
  });

  it('rewrites only the image widget, and keeps an unplaying one exactly as stored', () => {
    expect(displayConfig('image', { nowPlaying: PLAYER }, [], [], {})).toEqual({ nowPlaying: true });
    const other = { nowPlaying: PLAYER };
    expect(displayConfig('notes', other, [], [], { [PLAYER]: 'x' })).toBe(other);
  });

  it('takes only a media player, by the schema', () => {
    const ok = (config: unknown): boolean => widgetConfigBody.safeParse(config).success;
    expect(ok({ nowPlaying: PLAYER })).toBe(true);
    expect(ok({ nowPlaying: 'lock.front_door' })).toBe(false);
    expect(ok({ nowPlaying: 'media_player.Kitchen' })).toBe(false);
  });
});

describe('the picture', () => {
  it('is served behind the display token, sniffed, fetched with the house’s token, and kept while it plays', async () => {
    const h = await harness();
    await h.poll();
    const handle = handleOf(PICTURE);
    const served = await h.wall(`/d/media/${handle}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(ARTWORK)).toBe(true);
    expect(h.ha.paths.some((path) => path.startsWith('/api/media_player_proxy/media_player.kitchen'))).toBe(true);
    expect(existsSync(join(h.dataDir, 'art-cache', handle))).toBe(true);
  });

  it('is nothing for a guessed handle, for a song that has finished, or for a player that is not playing', async () => {
    const h = await harness();
    await h.poll();
    expect((await h.wall(`/d/media/${'f'.repeat(64)}.jpg`)).status).toBe(404);
    const old = handleOf(PICTURE);
    h.ha.set[PLAYER] = { entity_picture: '/api/media_player_proxy/media_player.kitchen?token=t2&cache=next' };
    await h.poll();
    expect((await h.wall(`/d/media/${old}`)).status).toBe(404);
    h.ha.toggled[PLAYER] = 'paused';
    await h.poll();
    expect(nowPlayingArt(h.db)).toEqual({});
    expect((await h.wall(`/d/media/${handleOf('/api/media_player_proxy/media_player.kitchen?token=t2&cache=next')}`)).status).toBe(404);
  });

  it('is never fetched when the live picture has moved on from the one the wall was told about', async () => {
    const h = await harness();
    await h.poll();
    const told = handleOf(PICTURE);
    // Home Assistant has moved to the next song; the cache has not been polled since.
    h.ha.set[PLAYER] = { entity_picture: '/api/media_player_proxy/media_player.kitchen?token=t3&cache=moved' };
    const before = h.ha.paths.filter((path) => path.startsWith('/api/media_player_proxy/')).length;
    expect((await h.wall(`/d/media/${told}`)).status).toBe(404);
    expect(h.ha.paths.filter((path) => path.startsWith('/api/media_player_proxy/')).length).toBe(before);
  });

  it('is never fetched from a plain-http address a music service handed over, and the token never goes there', async () => {
    const h = await harness();
    const elsewhere = 'http://127.0.0.1:1/cover.jpg';
    h.ha.set[PLAYER] = { entity_picture: elsewhere };
    await h.poll();
    expect((await h.wall(`/d/media/${handleOf(elsewhere)}`)).status).toBe(404);
  });

  it('never takes the house’s token to a path outside Home Assistant’s own API', async () => {
    const h = await harness();
    const outside = '/auth/authorize?client_id=x';
    h.ha.set[PLAYER] = { entity_picture: outside };
    await h.poll();
    expect((await h.wall(`/d/media/${handleOf(outside)}`)).status).toBe(404);
    expect(h.ha.paths.some((path) => path.startsWith('/auth/'))).toBe(false);
  });

  it('serves nothing that is not a picture a wall draws, whatever Home Assistant says it is', async () => {
    const h = await harness();
    await h.poll();
    h.ha.artwork = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await h.wall(`/d/media/${handleOf(PICTURE)}`)).status).toBe(404);
    expect(existsSync(join(h.dataDir, 'art-cache', handleOf(PICTURE)))).toBe(false);
  });

  it('keeps only the picture playing now', async () => {
    const h = await harness();
    await h.poll();
    await h.wall(`/d/media/${handleOf(PICTURE)}`);
    const next = '/api/media_player_proxy/media_player.kitchen?token=t4&cache=song-two';
    h.ha.set[PLAYER] = { entity_picture: next };
    await h.poll();
    await h.wall(`/d/media/${handleOf(next)}`);
    expect(readdirSync(join(h.dataDir, 'art-cache'))).toEqual([handleOf(next)]);
  });
});

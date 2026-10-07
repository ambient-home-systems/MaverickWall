import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetcher } from '@maverick-wall/core';

import { createFetcher } from '../src/net/fetcher.js';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { weatherModule, type WeatherPanel } from '../src/modules/weather/index.js';
import { saveWeatherKey } from '../src/modules/weather/keys.js';
import type { KeyedProvider, Provider } from '../src/modules/weather/providers.js';
import type { ModuleContext } from '../src/modules/registry.js';

/**
 * The weather job against the four HTTP providers plan item M5.8 adds, with
 * the real fetcher and a local server standing in for every host.
 *
 * The server checks each key the way its provider does — Pirate Weather's in
 * the `apikey` header, OpenWeatherMap's in `appid`, Weather Underground's in
 * `apiKey` — and refuses a wrong one with that provider's status. Every path
 * it is asked is recorded, so a test can say both what was asked and that the
 * key never travelled anywhere it should not.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const FIXTURES = join(HERE, 'fixtures', 'weather-providers');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');
const MINUTE = 60_000;
const KEY = 'test-key-2b7e151628aed2a6abf71588';

interface Fake {
  base: string;
  requests: { path: string; apikey: string | undefined }[];
  close: () => Promise<void>;
}

const servers: Fake[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function fake(): Promise<Fake> {
  const state: Fake = { base: '', requests: [], close: async () => undefined };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    const header = request.headers['apikey'];
    state.requests.push({ path, apikey: typeof header === 'string' ? header : undefined });
    const url = new URL(path, 'http://localhost');
    const send = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(body);
    };
    if (url.pathname.startsWith('/v1/dwd-icon')) return send(200, read('real/dwd-berlin-metric.json'));
    if (url.pathname.startsWith('/forecast/')) {
      if (header !== KEY) return send(401, '{"message":"Invalid API key"}');
      return send(200, read('pirate-weather-ca.json'));
    }
    if (url.pathname.startsWith('/data/2.5/')) {
      if (url.searchParams.get('appid') !== KEY) {
        return send(401, '{"cod":401, "message": "Invalid API key. Please see https://openweathermap.org/faq#error401 for more info."}');
      }
      return send(
        200,
        read(url.pathname.endsWith('/weather') ? 'openweathermap-weather-metric.json' : 'openweathermap-forecast-metric.json'),
      );
    }
    if (url.pathname.startsWith('/v3/') || url.pathname.startsWith('/v2/pws/')) {
      if (url.searchParams.get('apiKey') !== KEY) {
        return send(401, '{"metadata":{"transaction_id":"#"},"success":false,"errors":[{"error":{"code":"CDN-0001","message":"Invalid apiKey."}}]}');
      }
      return send(200, read(url.pathname.startsWith('/v3/') ? 'wunderground-5day-metric.json' : 'wunderground-pws-metric.json'));
    }
    send(404, '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  servers.push(state);
  return state;
}

function fetcherFor(server: Fake): Fetcher {
  return {
    fetch: (request) =>
      createFetcher().fetch({
        ...request,
        url: request.url
          .replace('https://api.open-meteo.com', server.base)
          .replace('https://api.pirateweather.net', server.base)
          .replace('https://api.openweathermap.org', server.base)
          .replace('https://api.weather.com', server.base),
        policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
      }),
    postJson: () => {
      throw new Error('weather reads; nothing here posts');
    },
  };
}

interface Place {
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
}
const BERLIN: Place = { latitude: 52.52, longitude: 13.405, timezone: 'Europe/Berlin' };
const TORONTO: Place = { latitude: 45.42, longitude: -74.3, timezone: 'America/Toronto' };
const ZOCCA: Place = { latitude: 44.34, longitude: 10.99, timezone: 'Europe/Rome' };
const SEATTLE: Place = { latitude: 47.668, longitude: -122.384, timezone: 'America/Los_Angeles' };

function database(provider: Provider, place: Place, station: string | null = null): { db: SqliteDatabase; keyring: Keyring } {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wx-providers-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  db.prepare(
    `INSERT INTO household_settings (id, latitude, longitude, weather_enabled, weather_provider, weather_units,
                                     weather_station, timezone, created_at, updated_at)
     VALUES ('singleton', ?, ?, 1, ?, 'metric', ?, ?, 0, 0)`,
  ).run(place.latitude, place.longitude, provider, station, place.timezone);
  return { db, keyring: createKeyring(randomBytes(32)) };
}

function context(db: SqliteDatabase, keyring: Keyring, server: Fake, now: number, zone: string): ModuleContext {
  return { db, fetcher: fetcherFor(server), keyring, now, timezone: zone };
}

async function run(db: SqliteDatabase, keyring: Keyring, server: Fake, now: number, zone: string): Promise<string[]> {
  const before = server.requests.length;
  await weatherModule.job?.run(context(db, keyring, server, now, zone));
  return server.requests.slice(before).map((request) => new URL(request.path, 'http://x').pathname);
}

const panel = (db: SqliteDatabase, keyring: Keyring, server: Fake, now: number, zone: string): WeatherPanel | null =>
  weatherModule.contribute(context(db, keyring, server, now, zone)) as WeatherPanel | null;

const status = (db: SqliteDatabase, provider: Provider): string | undefined => {
  const row = db.prepare('SELECT payload FROM weather_cache WHERE cache_key = ?').get(`${provider}:status`) as
    | { payload: string }
    | undefined;
  return row === undefined ? undefined : (JSON.parse(row.payload) as { message: string }).message;
};

/** Every byte this household's database holds about weather, as text. */
function everythingStored(db: SqliteDatabase): string {
  const cache = db.prepare('SELECT * FROM weather_cache').all();
  const keys = db.prepare('SELECT * FROM weather_keys').all();
  const settings = db.prepare('SELECT * FROM household_settings').all();
  return JSON.stringify([cache, keys, settings]);
}

describe('DWD ICON', () => {
  it('asks the dwd-icon endpoint and draws its answer as a panel', async () => {
    const { db, keyring } = database('dwd', BERLIN);
    const server = await fake();
    const now = Date.parse('2026-10-07T01:35:00Z');
    expect(await run(db, keyring, server, now, BERLIN.timezone)).toEqual(['/v1/dwd-icon']);
    const shown = panel(db, keyring, server, now, BERLIN.timezone);
    expect(shown).toMatchObject({ provider: 'dwd', units: { temp: 'C', wind: 'km/h', precip: 'mm' } });
    expect(shown?.days).toHaveLength(5);
    expect(shown?.current).toMatchObject({ source: 'modelled', glyph: 'fog' });
    expect(shown?.hourly?.length).toBeGreaterThan(20);
    db.close();
  });
});

describe('the keyed providers', () => {
  const cases: {
    provider: KeyedProvider;
    place: Place;
    now: number;
    first: string[];
    station?: string;
  }[] = [
    {
      provider: 'pirateweather',
      place: TORONTO,
      now: 1762718100_000,
      first: ['/forecast/key-in-header/45.4200,-74.3000'],
    },
    {
      provider: 'openweathermap',
      place: ZOCCA,
      now: 1661870592_000,
      first: ['/data/2.5/weather', '/data/2.5/forecast'],
    },
    {
      provider: 'wunderground',
      place: SEATTLE,
      now: Date.parse('2026-10-06T02:55:00Z'),
      first: ['/v3/wx/forecast/daily/5day', '/v2/pws/observations/current'],
      station: 'KWASEATT2743',
    },
  ];

  for (const one of cases) {
    describe(one.provider, () => {
      it('asks only once it has a key, and says so on the Weather screen until then', async () => {
        const { db, keyring } = database(one.provider, one.place, one.station ?? null);
        const server = await fake();
        expect(await run(db, keyring, server, one.now, one.place.timezone)).toEqual([]);
        expect(status(db, one.provider)).toMatch(/needs a key\. Paste one on the Weather screen\./);
        expect(panel(db, keyring, server, one.now, one.place.timezone)).toBeNull();
        db.close();
      });

      it('draws the answer, and the key is nowhere but sealed', async () => {
        const { db, keyring } = database(one.provider, one.place, one.station ?? null);
        const server = await fake();
        saveWeatherKey(db, keyring, one.provider, KEY, one.now);
        expect(await run(db, keyring, server, one.now, one.place.timezone)).toEqual(one.first);
        expect(status(db, one.provider)).toBeUndefined();

        const shown = panel(db, keyring, server, one.now + MINUTE, one.place.timezone);
        expect(shown?.provider).toBe(one.provider);
        expect(shown?.days.length).toBeGreaterThan(0);
        expect(shown?.current?.temp).toEqual(expect.any(Number));

        // Sealed at rest, and on no wall.
        expect(everythingStored(db)).not.toContain(KEY);
        expect(JSON.stringify(shown)).not.toContain(KEY);
        // Pirate Weather's key went in the header, and so never in any address.
        if (one.provider === 'pirateweather') {
          expect(server.requests.every((request) => !request.path.includes(KEY))).toBe(true);
          expect(server.requests.every((request) => request.apikey === KEY)).toBe(true);
        }
        db.close();
      });

      it('keeps what it had when the key is refused, and says why without the key in it', async () => {
        const { db, keyring } = database(one.provider, one.place, one.station ?? null);
        const server = await fake();
        saveWeatherKey(db, keyring, one.provider, KEY, one.now);
        await run(db, keyring, server, one.now, one.place.timezone);
        const before = panel(db, keyring, server, one.now + MINUTE, one.place.timezone);

        // The household's key is revoked; the next run is refused.
        saveWeatherKey(db, keyring, one.provider, 'revoked-key-00000000', one.now);
        db.prepare('DELETE FROM weather_cache WHERE cache_key LIKE ?').run(`${one.provider}:current`);
        await run(db, keyring, server, one.now + 20 * MINUTE, one.place.timezone);
        const message = status(db, one.provider) ?? '';
        expect(message).toMatch(/did not accept the key/);
        expect(message).not.toContain('revoked-key');
        expect(panel(db, keyring, server, one.now + 21 * MINUTE, one.place.timezone)?.days).toEqual(before?.days);

        // A good key again: the next answer clears the sentence.
        saveWeatherKey(db, keyring, one.provider, KEY, one.now);
        await run(db, keyring, server, one.now + 40 * MINUTE, one.place.timezone);
        expect(status(db, one.provider)).toBeUndefined();
        db.close();
      });
    });
  }

  it('OpenWeatherMap asks for now every quarter hour and the forecast hourly', async () => {
    const { db, keyring } = database('openweathermap', ZOCCA);
    const server = await fake();
    const now = 1661870592_000;
    saveWeatherKey(db, keyring, 'openweathermap', KEY, now);
    await run(db, keyring, server, now, ZOCCA.timezone);
    expect(await run(db, keyring, server, now + 5 * MINUTE, ZOCCA.timezone)).toEqual([]);
    expect(await run(db, keyring, server, now + 15 * MINUTE, ZOCCA.timezone)).toEqual(['/data/2.5/weather']);
    expect(await run(db, keyring, server, now + 60 * MINUTE, ZOCCA.timezone)).toEqual([
      '/data/2.5/weather',
      '/data/2.5/forecast',
    ]);
    db.close();
  });

  it('Weather Underground with no station asks for the forecast hourly and nothing in between', async () => {
    const { db, keyring } = database('wunderground', SEATTLE);
    const server = await fake();
    const now = Date.parse('2026-10-06T02:55:00Z');
    saveWeatherKey(db, keyring, 'wunderground', KEY, now);
    expect(await run(db, keyring, server, now, SEATTLE.timezone)).toEqual(['/v3/wx/forecast/daily/5day']);
    // "Now" and the hours are never written, so both stay due: that must not be a request.
    expect(await run(db, keyring, server, now + 15 * MINUTE, SEATTLE.timezone)).toEqual([]);
    expect(await run(db, keyring, server, now + 30 * MINUTE, SEATTLE.timezone)).toEqual([]);
    // And not a complaint either: nothing was asked, so nothing failed.
    expect(status(db, 'wunderground')).toBeUndefined();
    expect(await run(db, keyring, server, now + 60 * MINUTE, SEATTLE.timezone)).toEqual(['/v3/wx/forecast/daily/5day']);
    const shown = panel(db, keyring, server, now + 61 * MINUTE, SEATTLE.timezone);
    expect(shown).not.toHaveProperty('current');
    expect(shown).not.toHaveProperty('hourly');
    db.close();
  });

  it('Weather Underground with a station says "now" was measured', async () => {
    const { db, keyring } = database('wunderground', SEATTLE, 'KWASEATT2743');
    const server = await fake();
    const now = Date.parse('2026-10-06T02:55:00Z');
    saveWeatherKey(db, keyring, 'wunderground', KEY, now);
    await run(db, keyring, server, now, SEATTLE.timezone);
    expect(panel(db, keyring, server, now + MINUTE, SEATTLE.timezone)?.current).toMatchObject({
      source: 'observed',
      temp: 11.6,
      condition: 'Showers',
    });
    db.close();
  });
});

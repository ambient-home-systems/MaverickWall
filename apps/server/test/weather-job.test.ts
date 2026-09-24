import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetcher } from '@maverick-wall/core';
import { createFetcher } from '../src/net/fetcher.js';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { weatherModule, type WeatherPanel } from '../src/modules/weather/index.js';
import { readWeatherSettings, writeWeatherSettings } from '../src/api/queries.js';
import type { ModuleContext } from '../src/modules/registry.js';

/**
 * The weather job, against a real server that answers with real bytes (plan
 * items P3.2 and P3.4).
 *
 * One local HTTP server stands in for all three hosts — api.weather.gov,
 * api.open-meteo.com and air-quality-api.open-meteo.com — and answers each
 * path with the document that was captured from it. The fetcher is the real
 * one, with only the origin rewritten, the way `alerts.test.ts` points the
 * alert job at its fake: the URLs, the redirects the points document names,
 * the agent string and the content-type checks are all the production code.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');
const NWS = join(HERE, 'fixtures', 'nws', 'real');
const OPEN_METEO = join(HERE, 'fixtures', 'open-meteo', 'real');
const bytes = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8');

/** The first run: 12:10 UTC on the morning the documents were captured. */
const T0 = Date.parse('2026-09-24T12:10:00Z');
const MINUTE = 60_000;

interface Fake {
  base: string;
  paths: string[];
  /** Paths answered with a 503 instead of their document. */
  failing: Set<string>;
  /** Replacement bodies by path prefix. */
  bodies: Map<string, string>;
  close: () => Promise<void>;
}

const servers: Fake[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const server of servers) await server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function route(path: string): { type: string; body: string } | undefined {
  if (path.startsWith('/points/')) return { type: 'application/geo+json', body: bytes(NWS, 'points.json') };
  if (path === '/gridpoints/LWX/97,71/forecast') return { type: 'application/geo+json', body: bytes(NWS, 'forecast.json') };
  if (path === '/gridpoints/LWX/97,71/forecast/hourly') {
    return { type: 'application/geo+json', body: bytes(NWS, 'forecast-hourly.json') };
  }
  if (path === '/gridpoints/LWX/97,71/stations?limit=5') {
    return { type: 'application/geo+json', body: bytes(NWS, 'stations.json') };
  }
  if (path === '/stations/KDCA/observations/latest') {
    return { type: 'application/geo+json', body: bytes(NWS, 'observation-latest.json') };
  }
  if (path.startsWith('/v1/forecast?')) return { type: 'application/json', body: bytes(OPEN_METEO, 'forecast-dc-imperial.json') };
  if (path.startsWith('/v1/air-quality?')) return { type: 'application/json', body: bytes(OPEN_METEO, 'air-quality-dc.json') };
  return undefined;
}

async function fake(): Promise<Fake> {
  const state: Fake = {
    base: '',
    paths: [],
    failing: new Set(),
    bodies: new Map(),
    close: async () => undefined,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '';
    state.paths.push(path);
    // NWS refuses a request with no contact in its agent, and so does this.
    if (!(request.headers['user-agent'] ?? '').includes('MaverickWall')) {
      response.writeHead(403).end();
      return;
    }
    const found = route(path);
    if (found === undefined || [...state.failing].some((prefix) => path.startsWith(prefix))) {
      response.writeHead(found === undefined ? 404 : 503, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const replaced = [...state.bodies].find(([prefix]) => path.startsWith(prefix))?.[1];
    response.writeHead(200, { 'content-type': found.type }).end(replaced ?? found.body);
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
          .replace('https://api.weather.gov', server.base)
          .replace('https://api.open-meteo.com', server.base)
          .replace('https://air-quality-api.open-meteo.com', server.base),
        policy: { allowHttp: true, allowPrivateNetwork: true, allowLoopback: true },
      }),
    postJson: () => {
      throw new Error('weather reads; nothing here posts');
    },
  };
}

function database(provider: 'nws' | 'openmeteo'): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wx-job-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  db.prepare(
    `INSERT INTO household_settings (id, latitude, longitude, weather_enabled, weather_provider, timezone,
                                     created_at, updated_at)
     VALUES ('singleton', 38.8894, -77.0352, 1, ?, 'America/New_York', ?, ?)`,
  ).run(provider, T0, T0);
  return db;
}

function context(db: SqliteDatabase, server: Fake, now: number): ModuleContext {
  return { db, fetcher: fetcherFor(server), keyring: {} as never, now, timezone: 'America/New_York' };
}

async function run(db: SqliteDatabase, server: Fake, now: number): Promise<string[]> {
  const before = server.paths.length;
  await weatherModule.job?.run(context(db, server, now));
  return server.paths.slice(before);
}

const panel = (db: SqliteDatabase, server: Fake, now: number): WeatherPanel | null =>
  weatherModule.contribute(context(db, server, now)) as WeatherPanel | null;

const fetchedAt = (db: SqliteDatabase, key: string): number | undefined =>
  (db.prepare('SELECT fetched_at AS at FROM weather_cache WHERE cache_key = ?').get(key) as { at: number } | undefined)?.at;

describe('NWS, part by part', () => {
  it('resolves the gridpoint and the stations once, then reads every part', async () => {
    const db = database('nws');
    const server = await fake();
    const asked = await run(db, server, T0);
    expect(asked).toEqual([
      '/points/38.8894,-77.0352',
      '/gridpoints/LWX/97,71/forecast',
      '/gridpoints/LWX/97,71/forecast/hourly',
      '/gridpoints/LWX/97,71/stations?limit=5',
      '/stations/KDCA/observations/latest',
    ]);

    const shown = panel(db, server, T0 + 5 * MINUTE);
    expect(shown?.current).toMatchObject({ source: 'observed', temp: 53.6, condition: 'Mostly Clear' });
    expect(shown?.hourly).toHaveLength(24);
    expect(shown?.units).toEqual({ temp: 'F', wind: 'mph', precip: 'in' });
    // The NOAA sun in the household's zone, within a minute of NWS's own
    // astronomicalData for today (06:57:51 and 19:02:17).
    expect(shown?.days[0]).toMatchObject({
      name: 'Today',
      sunrise: '2026-09-24T06:58',
      sunset: '2026-09-24T19:02',
      precipChance: 0,
      windMax: 13,
    });
    // Off unless the household turned it on (Q5), so never asked for.
    expect(shown).not.toHaveProperty('air');
    expect(server.paths.some((path) => path.startsWith('/v1/'))).toBe(false);
    db.close();
  });

  it('asks nothing while nothing is due, the observation every fifteen minutes, and the forecasts hourly', async () => {
    const db = database('nws');
    const server = await fake();
    await run(db, server, T0);

    expect(await run(db, server, T0 + 5 * MINUTE)).toEqual([]);
    // The scheduler's jitter can bring a run in at twelve minutes.
    expect(await run(db, server, T0 + 12 * MINUTE)).toEqual(['/stations/KDCA/observations/latest']);
    expect(await run(db, server, T0 + 30 * MINUTE)).toEqual(['/stations/KDCA/observations/latest']);
    // The gridpoint and the station list are never asked for again.
    expect(await run(db, server, T0 + 60 * MINUTE)).toEqual([
      '/gridpoints/LWX/97,71/forecast',
      '/gridpoints/LWX/97,71/forecast/hourly',
      '/stations/KDCA/observations/latest',
    ]);
    db.close();
  });

  it('keeps the last good copy of a part whose refresh failed, and only that part', async () => {
    const db = database('nws');
    const server = await fake();
    await run(db, server, T0);
    const observedAt = fetchedAt(db, 'nws:current');

    server.failing.add('/stations/');
    await run(db, server, T0 + 60 * MINUTE);
    // The forecasts refreshed; the observation kept its copy and stays due.
    expect(fetchedAt(db, 'nws:forecast')).toBe(T0 + 60 * MINUTE);
    expect(fetchedAt(db, 'nws:current')).toBe(observedAt);
    expect(panel(db, server, T0 + 61 * MINUTE)?.current?.source).toBe('observed');

    server.failing.clear();
    expect(await run(db, server, T0 + 62 * MINUTE)).toEqual(['/stations/KDCA/observations/latest']);
    db.close();
  });

  it('asks about a location it could not resolve hourly, not every fifteen minutes', async () => {
    const db = database('nws');
    const server = await fake();
    // What a household outside the United States gets, however often it asks.
    server.failing.add('/points/');
    expect(await run(db, server, T0)).toEqual(['/points/38.8894,-77.0352']);
    expect(await run(db, server, T0 + 15 * MINUTE)).toEqual([]);
    expect(await run(db, server, T0 + 30 * MINUTE)).toEqual([]);
    expect(await run(db, server, T0 + 60 * MINUTE)).toEqual(['/points/38.8894,-77.0352']);
    db.close();
  });

  it('asks once, at once, for what a gridpoint cached by an earlier release did not keep', async () => {
    const db = database('nws');
    const server = await fake();
    // The row the previous release wrote: the forecast URL alone.
    db.prepare(
      `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
       VALUES ('nwspoint', 'nws', 'nws:point', ?, ?, NULL)`,
    ).run(
      JSON.stringify({ key: '38.8894,-77.0352', url: 'https://api.weather.gov/gridpoints/LWX/97,71/forecast' }),
      T0 - 24 * 60 * MINUTE,
    );
    db.prepare(
      `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
       VALUES ('nwsforecast', 'nws', 'nws:forecast', ?, ?, NULL)`,
    ).run(JSON.stringify({ days: [{ name: 'Today' }], fetchedAt: T0 - 10 * MINUTE }), T0 - 10 * MINUTE);
    const asked = await run(db, server, T0);
    // The forecast is not due, so it is not fetched; the gridpoint is asked
    // for its other two URLs, and the parts that needed them are filled in.
    expect(asked).toEqual([
      '/points/38.8894,-77.0352',
      '/gridpoints/LWX/97,71/forecast/hourly',
      '/gridpoints/LWX/97,71/stations?limit=5',
      '/stations/KDCA/observations/latest',
    ]);
    expect(await run(db, server, T0 + 15 * MINUTE)).not.toContain('/points/38.8894,-77.0352');
    db.close();
  });

  it('falls back to the hourly forecast when the station sends no temperature', async () => {
    const db = database('nws');
    const server = await fake();
    const observation = JSON.parse(bytes(NWS, 'observation-latest.json')) as {
      properties: { temperature: { value: number | null } };
    };
    observation.properties.temperature.value = null;
    server.bodies.set('/stations/', JSON.stringify(observation));
    await run(db, server, T0);

    const current = panel(db, server, T0 + 20 * MINUTE)?.current;
    // The 08:00 hour in New York, as the hourly forecast has it.
    expect(current).toMatchObject({
      source: 'modelled',
      observedAt: Date.parse('2026-09-24T12:00:00Z'),
      temp: 54,
      condition: 'Partly Sunny',
    });
    db.close();
  });

  it('stops presenting a reading as now once it is ninety minutes old', async () => {
    const db = database('nws');
    const server = await fake();
    await run(db, server, T0);
    // The observation was taken at 12:00; nothing has refreshed since.
    expect(panel(db, server, Date.parse('2026-09-24T13:30:00Z'))?.current?.source).toBe('observed');
    expect(panel(db, server, Date.parse('2026-09-24T13:31:00Z'))?.current?.source).toBe('modelled');
    db.close();
  });
});

describe('Open-Meteo, one request for three parts', () => {
  it('reads every part from one answer', async () => {
    const db = database('openmeteo');
    const server = await fake();
    const asked = await run(db, server, T0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^\/v1\/forecast\?/);

    const shown = panel(db, server, T0 + 30 * MINUTE);
    expect(shown?.current).toMatchObject({ source: 'modelled', temp: 54, uv: 0.95 });
    expect(shown?.hourly?.[0]?.at).toBe(Date.parse('2026-09-24T12:00:00Z'));
    expect(shown?.days[0]).toMatchObject({ uvMax: 4.45, sunrise: '2026-09-24T06:57' });
    expect(shown?.units).toEqual({ temp: 'F', wind: 'mph', precip: 'in' });
    db.close();
  });

  it('writes the days hourly even though they arrive every fifteen minutes', async () => {
    const db = database('openmeteo');
    const server = await fake();
    await run(db, server, T0);
    expect(await run(db, server, T0 + 15 * MINUTE)).toHaveLength(1);
    // The temperature is re-stamped; the days and the hours are not.
    expect(fetchedAt(db, 'openmeteo:current')).toBe(T0 + 15 * MINUTE);
    expect(fetchedAt(db, 'openmeteo:forecast')).toBe(T0);
    expect(fetchedAt(db, 'openmeteo:hourly')).toBe(T0);
    db.close();
  });

  it('presents no current conditions ninety minutes after a model it cannot refresh', async () => {
    const db = database('openmeteo');
    const server = await fake();
    await run(db, server, T0);
    // Modelled for 08:30 New York, 12:30 UTC.
    expect(panel(db, server, Date.parse('2026-09-24T14:00:00Z'))?.current).toBeDefined();
    const late = panel(db, server, Date.parse('2026-09-24T14:01:00Z'));
    expect(late).not.toHaveProperty('current');
    // The rest of the panel is still there, which is the point of per part.
    expect(late?.days).toHaveLength(5);
    db.close();
  });
});

describe('air quality, which is consent', () => {
  it('asks the second host only once it is switched on, and forgets the reading when switched off', async () => {
    const db = database('nws');
    const server = await fake();
    await run(db, server, T0);
    expect(server.paths.some((path) => path.startsWith('/v1/air-quality'))).toBe(false);

    db.prepare(
      `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
       VALUES ('weather-sync', 'weather-sync', 9999999999, 0, ?, ?)`,
    ).run(T0, T0);
    const nextRun = (): number =>
      (db.prepare(`SELECT next_run_at AS at FROM job_state WHERE kind = 'weather-sync'`).get() as { at: number }).at;

    writeWeatherSettings(db, { ...readWeatherSettings(db), airQuality: true });
    // Switching it on brings the job forward rather than waiting for the hour.
    expect(nextRun()).toBe(0);
    const asked = await run(db, server, T0 + MINUTE);
    expect(asked).toEqual([expect.stringMatching(/^\/v1\/air-quality\?/)]);
    expect(panel(db, server, T0 + 2 * MINUTE)?.air).toEqual({
      aqi: 43,
      scale: 'us',
      label: 'Good',
      observedAt: Date.parse('2026-09-24T12:00:00Z'),
    });

    db.prepare(`UPDATE job_state SET next_run_at = 9999999999 WHERE kind = 'weather-sync'`).run();
    writeWeatherSettings(db, { ...readWeatherSettings(db), airQuality: false });
    expect(fetchedAt(db, 'openmeteo:air')).toBeUndefined();
    // Switching it off has nothing new to fetch, so the job keeps its schedule.
    expect(nextRun()).toBe(9999999999);
    // …and the rest of the cache is untouched: off forgets the air, not the weather.
    expect(fetchedAt(db, 'nws:forecast')).toBe(T0);
    expect(panel(db, server, T0 + 3 * MINUTE)).not.toHaveProperty('air');
    // And no further requests to it.
    expect(await run(db, server, T0 + 90 * MINUTE)).not.toContainEqual(expect.stringMatching(/air-quality/));
    db.close();
  });

  it('leaves the switch as it is when a writer has no opinion about it', () => {
    const db = database('nws');
    writeWeatherSettings(db, { ...readWeatherSettings(db), airQuality: true });
    const { airQuality: _ignored, ...withoutIt } = readWeatherSettings(db);
    writeWeatherSettings(db, { ...withoutIt, units: 'metric' });
    expect(readWeatherSettings(db).airQuality).toBe(true);
    db.close();
  });
});

/*
 * The promise every new field is spread to keep: a household whose cache holds
 * nothing new gets the panel it always got, key for key and byte for byte —
 * and so the manifest, and so the ETag, which hashes the serialisation.
 */
describe('a panel with nothing new in it', () => {
  it('serialises exactly as it did before any of this existed', () => {
    const db = database('nws');
    const server = { base: '', paths: [], failing: new Set<string>(), bodies: new Map(), close: async () => undefined };
    // A forecast row as the previous release wrote it: no extras on any day,
    // and no other part cached.
    const days = [
      { name: 'Today', date: '2026-09-24', high: 66, low: 51, unit: 'F', summary: 'Mostly Cloudy', glyph: 'cloudy' },
      { name: 'Friday', date: '2026-09-25', high: 72, low: 57, unit: 'F', summary: 'Sunny', glyph: 'clear' },
    ];
    db.prepare(
      `INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at)
       VALUES ('nwsforecast', 'nws', 'nws:forecast', ?, ?, NULL)`,
    ).run(JSON.stringify({ days, fetchedAt: T0 }), T0);

    expect(JSON.stringify(panel(db, server, T0 + MINUTE))).toBe(
      '{"provider":"nws","days":[' +
        '{"name":"Today","date":"2026-09-24","high":66,"low":51,"unit":"F","summary":"Mostly Cloudy","glyph":"cloudy"},' +
        '{"name":"Friday","date":"2026-09-25","high":72,"low":57,"unit":"F","summary":"Sunny","glyph":"clear"}],' +
        `"fetchedAt":${T0},"note":null}`,
    );
    db.close();
  });
});

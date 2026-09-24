import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetcher } from '@maverick-wall/core';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { readWeatherSettings } from '../src/api/queries.js';
import { GEOCODING_HOST, parsePlaceMatches, placeSearchUrl } from '../src/modules/weather/geocoding.js';

/**
 * Finding a weather location by typing a town (P2.3).
 *
 * The parser is checked against a real Open-Meteo response, committed as a
 * fixture — the same discipline `weather.test.ts` and `alerts.test.ts` hold
 * every other provider to, and for the reason CLAUDE.md gives at the top of
 * this file's list: an invented fixture agrees with whatever the parser
 * happens to do.
 *
 * The route is driven through the real app with an injected fetcher — the
 * `alerts.test.ts` job pattern of rewriting only the origin, so the guard, the
 * headers and the conditional handling are all the real code and the only
 * thing standing in for the internet is which host answers.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LONDON = readFileSync(join(FIXTURES, 'open-meteo-geocoding.json'), 'utf8');
const NO_RESULTS = readFileSync(join(FIXTURES, 'open-meteo-geocoding-empty.json'), 'utf8');

const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// ---------------------------------------------------------------------------
// The parser, against real bytes
// ---------------------------------------------------------------------------

describe('parsing a real geocoding response', () => {
  it('builds the URL Open-Meteo actually answers', () => {
    expect(placeSearchUrl('Springfield, Illinois')).toBe(
      `https://${GEOCODING_HOST}/v1/search?name=Springfield%2C+Illinois&count=5&format=json`,
    );
  });

  it('reads every match, named town, region, country', () => {
    const matches = parsePlaceMatches(LONDON);
    expect(matches).toHaveLength(5);
    expect(matches[0]).toEqual({
      latitude: 51.50853,
      longitude: -0.12574,
      label: 'London, England, United Kingdom',
    });
    // The same name in three different countries — proof the label carries
    // enough to tell them apart, which "London" alone never could.
    expect(matches.map((match) => match.label)).toEqual([
      'London, England, United Kingdom',
      'London, Ontario, Canada',
      'London, Ohio, United States',
      'London, Kentucky, United States',
      'London, Arkansas, United States',
    ]);
  });

  it('answers an empty list rather than failing on a genuine no-match', () => {
    expect(parsePlaceMatches(NO_RESULTS)).toEqual([]);
  });

  it('skips one bad entry and keeps the other four', () => {
    // The real document, with one result's coordinate corrupted — captured
    // bytes, mutated rather than invented, so the four survivors are read
    // exactly as they would be from a genuine partial fault.
    const document = JSON.parse(LONDON) as { results: Record<string, unknown>[] };
    delete document.results[2]?.['latitude'];
    const matches = parsePlaceMatches(JSON.stringify(document));
    expect(matches).toHaveLength(4);
    expect(matches.map((match) => match.label)).not.toContain('London, Ohio, United States');
  });

  it('returns nothing rather than throwing on a document that is not one', () => {
    for (const body of ['not json', 'null', '{}', '[]', '{"results":"not an array"}']) {
      expect(parsePlaceMatches(body)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The route, through the real app
// ---------------------------------------------------------------------------

async function fakeGeocoder(body: string, status = 200): Promise<{ base: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}` };
}

/** Point the guard at a fake by rewriting only the origin — `alerts.test.ts`'s own pattern. */
function fetcherFor(base: string): Fetcher {
  return {
    fetch: (request) =>
      createFetcher().fetch({
        ...request,
        url: request.url.replace(`https://${GEOCODING_HOST}`, base),
        policy: { allowHttp: true, allowLoopback: true },
      }),
    postJson: () => {
      throw new Error('a place lookup never posts');
    },
  };
}

/** A fetcher that can never reach anything — nothing is listening on this port. */
const DEAD_FETCHER: Fetcher = {
  fetch: (request) =>
    createFetcher().fetch({
      ...request,
      url: request.url.replace(`https://${GEOCODING_HOST}`, 'http://127.0.0.1:1'),
      policy: { allowHttp: true, allowLoopback: true },
      timeoutMs: 2000,
    }),
  postJson: () => {
    throw new Error('a place lookup never posts');
  },
};

async function harness(fetcher: Fetcher = createFetcher()) {
  const address = `10.6.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-geocode-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
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
  const html = async (path: string): Promise<string> => (await call(path)).text();

  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  return { db, call, form, html };
}

/** Every field the screen's form always carries, so a lookup never looks like a stale page. */
const BASE_FIELDS = {
  weather_form: '1',
  weather_enabled: '1',
  alerts_enabled: '1',
  weather_provider: 'nws',
  weather_units: 'imperial',
};

describe('looking up a place', () => {
  it('offers up to five real matches as choices, and names the host', async () => {
    const geocoder = await fakeGeocoder(LONDON);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather/find-place', {
      ...BASE_FIELDS,
      place: 'London',
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Which one is it?');
    expect(body.match(/name="place_choice"/g)).toHaveLength(5);
    expect(body).toContain('London, England, United Kingdom');
    expect(body).toContain('London, Ontario, Canada');
    // The typed town is echoed back, not cleared by the lookup.
    expect(body).toContain('value="London"');
    // Naming the host the typed text was sent to.
    expect(body).toContain(GEOCODING_HOST);

    // Nothing was written — a lookup is not a save.
    expect(readWeatherSettings(h.db).latitude).toBeNull();
  });

  it('chooses a place and saves the rest of the form with it', async () => {
    const geocoder = await fakeGeocoder(LONDON);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather/use-place', {
      ...BASE_FIELDS,
      weather_provider: 'openmeteo',
      weather_units: 'metric',
      place_choice: '51.50853,-0.12574',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('saved=weather-location-place');

    const stored = readWeatherSettings(h.db);
    expect(stored.latitude).toBeCloseTo(51.50853);
    expect(stored.longitude).toBeCloseTo(-0.12574);
    expect(stored.provider, 'and the rest of the form, in the same breath').toBe('openmeteo');
    expect(stored.units).toBe('metric');
  });

  it('refuses "Use this place" with nothing chosen, and writes nothing', async () => {
    const geocoder = await fakeGeocoder(LONDON);
    const h = await harness(fetcherFor(geocoder.base));

    // A browser never sends a radio group with nothing checked: this is the
    // hand-built equivalent, and it must read the same as one.
    const response = await h.form('/admin/weather/use-place', { ...BASE_FIELDS });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Choose one of the places above.');
    expect(readWeatherSettings(h.db).latitude).toBeNull();
  });

  it('says plainly when there is no place by that name', async () => {
    const geocoder = await fakeGeocoder(NO_RESULTS);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather/find-place', {
      ...BASE_FIELDS,
      place: 'Zzznotaplaceatallxyz',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('No place by that name.');
  });

  it('says plainly when the lookup service is not answering', async () => {
    const h = await harness(DEAD_FETCHER);
    const response = await h.form('/admin/weather/find-place', { ...BASE_FIELDS, place: 'London' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('The lookup service is not answering right now.');
  }, 15_000);

  it('asks for a town rather than looking up nothing', async () => {
    const h = await harness();
    const response = await h.form('/admin/weather/find-place', { ...BASE_FIELDS, place: '' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Type a town first');
  });

  it('keeps the rest of the form when a lookup fails', async () => {
    const geocoder = await fakeGeocoder(NO_RESULTS);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather/find-place', {
      weather_form: '1',
      weather_enabled: '1',
      // alerts_enabled deliberately not sent: the household just turned it off.
      weather_provider: 'openmeteo',
      weather_units: 'metric',
      place: 'Nowhere',
    });
    const body = await response.text();
    const alertsInput = /<input type="checkbox" name="alerts_enabled"[^>]*>/.exec(body)?.[0] ?? '';
    expect(alertsInput, 'the alerts switch, echoed off rather than reverted').not.toContain('checked');
    expect(body).toContain('selected>Open-Meteo');
  });
});

// ---------------------------------------------------------------------------
// The Enter-key trap: Save posts here too, and must not discard a typed place
// ---------------------------------------------------------------------------

describe('the Enter-key trap', () => {
  /**
   * `defaultSubmit()` carries no `formaction`, so Enter in the place field —
   * and pressing the visible Save with nothing but a town typed — both post to
   * `/admin/weather`. Reading "no coordinates" as "clear the location" here
   * would be this screen's own data-loss bug in a new shape: a typed place
   * silently thrown away, the way implicit submission used to overwrite a
   * typed coordinate.
   */
  it('treats Save with a typed place and no coordinates as a lookup', async () => {
    const geocoder = await fakeGeocoder(LONDON);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather', { ...BASE_FIELDS, place: 'London' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('Which one is it?');
    expect(body).toContain('London, England, United Kingdom');

    // Nothing was saved — the place was looked up, not discarded.
    expect(readWeatherSettings(h.db).latitude).toBeNull();
  });

  it('still saves normally when both a place and coordinates are typed', async () => {
    const geocoder = await fakeGeocoder(LONDON);
    const h = await harness(fetcherFor(geocoder.base));

    const response = await h.form('/admin/weather', {
      ...BASE_FIELDS,
      place: 'London',
      latitude: '51.5074',
      longitude: '-0.1278',
    });
    expect(response.status).toBe(302);
    const stored = readWeatherSettings(h.db);
    expect(stored.latitude).toBe(51.5074);
    expect(stored.longitude).toBe(-0.1278);
  });

  it('still clears with an entirely blank form, on a fresh household', async () => {
    const h = await harness();
    const response = await h.form('/admin/weather', { ...BASE_FIELDS, place: '' });
    expect(response.status).toBe(302);
    expect(readWeatherSettings(h.db).latitude).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rest of the screen
// ---------------------------------------------------------------------------

describe('the rest of the Weather screen', () => {
  it('offers the device-location button hidden, and ships the script for it', async () => {
    const h = await harness();
    const body = await h.html('/admin/alerts');
    expect(body).toMatch(/<button[^>]*data-geolocate[^>]*hidden[^>]*>|<button[^>]*hidden[^>]*data-geolocate[^>]*>/);
    expect(body).toContain('assets/geolocate-button.js');
  });

  it('points at Home Assistant when it is not connected', async () => {
    const h = await harness();
    const body = await h.html('/admin/alerts');
    expect(body).not.toContain('Use my Home Assistant home location');
    expect(body).toContain('admin/home-assistant');
    expect(body).toContain('one-click way to fill this in from its home zone');
  });

  it('says why the number fields are still there', async () => {
    const h = await harness();
    const body = await h.html('/admin/alerts');
    expect(body.toLowerCase()).toContain('county');
  });
});

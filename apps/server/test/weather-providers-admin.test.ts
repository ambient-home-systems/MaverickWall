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
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import type { Manifest } from '../src/api/manifest.js';
import { weatherModule, type WeatherPanel } from '../src/modules/weather/index.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN, type FakeHa, type FakeWeather } from './fake-home-assistant.js';

/**
 * The Weather screen's provider half (plan item M5.8), through the real app,
 * and a Home Assistant weather entity read end to end from the fake house.
 *
 * The house answers `weather.get_forecasts` as core does — only when asked for
 * a response, and refusing a forecast type the entity does not have — and
 * records every POST, so the test says which calls left and with what body.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;
const KEY = 'owm-key-9f86d081884c7d659a2feaa0';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifest: () => Promise<Manifest>;
  readonly poll: (now?: number) => Promise<void>;
}

async function harness(): Promise<Harness> {
  const address = `10.13.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-wx-admin-'));
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

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Wall', ?, 'panels', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  return {
    db,
    keyring,
    call,
    form,
    manifest: async () =>
      (await (await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } })).json()) as Manifest,
    poll: (now = Date.now()) =>
      weatherModule.job?.run({ db, fetcher, keyring, now, timezone: 'Europe/London' }) ?? Promise.resolve(),
  };
}

async function connect(h: Harness, ha: FakeHa): Promise<void> {
  const response = await h.form('/admin/home-assistant/connect', {
    base_url: ha.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
  expect(response.status).toBe(302);
}

/** A weather entity as Met.no makes one: metric, daily and hourly. */
function metNo(now = Date.now()): FakeWeather {
  const day = (offset: number): string => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  return {
    state: 'rainy',
    last_updated: new Date(now - 10 * 60_000).toISOString(),
    attributes: {
      temperature: 14.2,
      apparent_temperature: 12.9,
      humidity: 91,
      wind_speed: 18.4,
      wind_bearing: 230.1,
      temperature_unit: '°C',
      wind_speed_unit: 'km/h',
      precipitation_unit: 'mm',
      pressure_unit: 'hPa',
      visibility_unit: 'km',
      attribution: 'Weather forecast from met.no',
      friendly_name: 'Forecast Home',
      supported_features: 3,
    },
    forecasts: {
      daily: [0, 1, 2, 3, 4].map((offset) => ({
        datetime: `${day(offset)}T11:00:00+00:00`,
        condition: offset === 0 ? 'rainy' : 'partlycloudy',
        temperature: 15 + offset,
        templow: 9 + offset,
        precipitation: offset === 0 ? 4.1 : 0,
        wind_bearing: 230,
        wind_speed: 20,
        humidity: 80,
      })),
      hourly: Array.from({ length: 30 }, (_, hour) => ({
        datetime: new Date(Math.floor(now / 3_600_000) * 3_600_000 + hour * 3_600_000).toISOString(),
        condition: 'cloudy',
        temperature: 13 + (hour % 5),
        precipitation_probability: 20,
      })),
    },
  };
}

const base = (fields: Record<string, string>): Record<string, string> => ({
  weather_form: '1',
  weather_enabled: '1',
  weather_units: 'metric',
  latitude: '51.5074',
  longitude: '-0.1278',
  ...fields,
});

describe('the Weather screen offers every provider', () => {
  it('lists seven, each with its own hint, the provider-only fields shown for their provider alone', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/alerts')).text();
    for (const value of ['nws', 'openmeteo', 'dwd', 'homeassistant', 'openweathermap', 'pirateweather', 'wunderground']) {
      expect(page).toContain(`<option value="${value}"`);
      expect(page).toContain(`data-cond-show="${value}"`);
    }
    expect(page).toContain('name="weather_provider" data-cond');
    expect(page).toContain('data-cond-show="openweathermap pirateweather wunderground"');
    // Without a connection, the entity field says where to make one.
    expect(page).toContain('Home Assistant is not connected. Connect it on the');
    expect(page).not.toContain('name="weather_entity"');
  });

  it('picks a Home Assistant weather entity by its name, and lists nothing that is not one', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    ha.weather['weather.forecast_home'] = metNo();
    await connect(h, ha);
    const page = await (await h.call('/admin/alerts')).text();
    expect(page).toContain('<option value="weather.forecast_home">Forecast Home</option>');
    expect(page.match(/name="weather_entity"[\s\S]*?<\/select>/)?.[0]).not.toContain('sensor.');
  });
});

describe('a Home Assistant weather entity, end to end', () => {
  it('refuses the provider with no entity chosen, and says how', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    ha.weather['weather.forecast_home'] = metNo();
    await connect(h, ha);
    const refused = await h.form('/admin/weather', base({ weather_provider: 'homeassistant' }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Choose which Home Assistant weather entity the forecast comes from.');
  });

  it('reads the state and the forecasts through get_forecasts, and the wall gets values and no id', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    ha.weather['weather.forecast_home'] = metNo();
    await connect(h, ha);
    const saved = await h.form(
      '/admin/weather',
      base({ weather_provider: 'homeassistant', weather_entity: 'weather.forecast_home' }),
    );
    expect(saved.status).toBe(302);
    expect(h.db.prepare(`SELECT weather_entity AS e FROM household_settings`).get()).toEqual({ e: 'weather.forecast_home' });

    const before = ha.posts.length;
    await h.poll();
    expect(ha.paths).toContain('/api/states/weather.forecast_home');
    expect(ha.posts.slice(before).map((post) => [post.path, post.query, JSON.parse(post.body)])).toEqual([
      ['/api/services/weather/get_forecasts', 'return_response', { entity_id: 'weather.forecast_home', type: 'daily' }],
      ['/api/services/weather/get_forecasts', 'return_response', { entity_id: 'weather.forecast_home', type: 'hourly' }],
    ]);

    const manifest = await h.manifest();
    const weather = (manifest as unknown as { panels: Record<string, WeatherPanel> }).panels['weather'];
    expect(weather?.provider).toBe('homeassistant');
    expect(weather?.days).toHaveLength(5);
    expect(weather?.days[0]).toMatchObject({ name: 'Today', high: 15, low: 9, glyph: 'rain', precipAmount: 4.1 });
    expect(weather?.current).toMatchObject({ temp: 14.2, condition: 'Rain', windDir: 'SW', source: 'modelled' });
    expect(weather?.hourly?.length).toBeGreaterThan(20);
    // The Weather screen shows what the wall has, by name and in words.
    const page = await (await h.call('/admin/alerts')).text();
    expect(page).toContain('<h3>On the wall now</h3>');
    expect(page).toContain('Home Assistant · updated');
    expect(page).toContain('<span class="when">Today</span><span>Rain 15° / 9°</span>');
    // Rule 12: the wall never receives an entity id or the token.
    const text = JSON.stringify(manifest);
    expect(text).not.toContain('weather.forecast_home');
    expect(text).not.toContain(TOKEN);
  });

  it('needs no location: the entity is its own somewhere', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    ha.weather['weather.forecast_home'] = metNo();
    await connect(h, ha);
    const saved = await h.form(
      '/admin/weather',
      base({ weather_provider: 'homeassistant', weather_entity: 'weather.forecast_home', latitude: '', longitude: '' }),
    );
    expect(saved.status).toBe(302);
    await h.poll();
    const weather = ((await h.manifest()) as unknown as { panels: Record<string, WeatherPanel> }).panels['weather'];
    expect(weather?.days).toHaveLength(5);
  });

  it('asks for the twice-daily forecast when that is all an entity has, and never hourly', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    const entity = metNo();
    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    ha.weather['weather.nws_home'] = {
      ...entity,
      attributes: { ...entity.attributes, supported_features: 4, temperature_unit: '°F', temperature: 58 },
      forecasts: {
        twice_daily: [
          { datetime: `${date}T12:00:00+00:00`, condition: 'sunny', temperature: 64, is_daytime: true },
          // A night starts in the evening of its day, as NWS's twice-daily periods do.
          { datetime: `${date}T18:00:00+00:00`, condition: 'clear-night', temperature: 48, is_daytime: false },
        ],
      },
    };
    await connect(h, ha);
    await h.form('/admin/weather', base({ weather_provider: 'homeassistant', weather_entity: 'weather.nws_home' }));
    const before = ha.posts.length;
    await h.poll();
    expect(ha.posts.slice(before).map((post) => (JSON.parse(post.body) as { type: string }).type)).toEqual(['twice_daily']);
    const weather = ((await h.manifest()) as unknown as { panels: Record<string, WeatherPanel> }).panels['weather'];
    // Fahrenheit in the entity, Celsius on this household's wall.
    expect(weather?.days[0]).toMatchObject({ high: 17.8, low: 8.9, unit: 'C' });
    expect(weather?.current?.temp).toBe(14.4);
  });

  it('says on the Weather screen when the entity has gone, and the wall keeps what it had', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    ha.weather['weather.forecast_home'] = metNo();
    await connect(h, ha);
    await h.form('/admin/weather', base({ weather_provider: 'homeassistant', weather_entity: 'weather.forecast_home' }));
    await h.poll();
    delete ha.weather['weather.forecast_home'];
    await h.poll(Date.now() + 61 * 60_000);
    const page = await (await h.call('/admin/alerts')).text();
    expect(page).toContain('Not read from Home Assistant last time.');
    expect(page).toContain('That weather entity is not in Home Assistant any more.');
    // Still offered, marked, rather than silently swapped for another.
    expect(page).toContain('weather.forecast_home (not found)');
    const weather = ((await h.manifest()) as unknown as { panels: Record<string, WeatherPanel> }).panels['weather'];
    expect(weather?.days).toHaveLength(5);
  });
});

describe('a key, on the Weather screen', () => {
  it('is required by a keyed provider, checked for shape, and refused for one that needs none', async () => {
    const h = await harness();
    const none = await h.form('/admin/weather', base({ weather_provider: 'openweathermap' }));
    expect(none.status).toBe(400);
    expect(await none.text()).toContain('OpenWeatherMap needs a key. Paste the one from api.openweathermap.org.');

    const bad = await h.form('/admin/weather', base({ weather_provider: 'pirateweather', weather_key: 'has spaces in it' }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('That does not look like a Pirate Weather key.');

    const misplaced = await h.form('/admin/weather', base({ weather_provider: 'openmeteo', weather_key: KEY }));
    expect(misplaced.status).toBe(400);
    expect(await misplaced.text()).toContain('Open-Meteo needs no key.');
    expect(h.db.prepare('SELECT count(*) AS n FROM weather_keys').get()).toEqual({ n: 0 });
  });

  it('is saved sealed, never written back into a page, and can be forgotten', async () => {
    const h = await harness();
    // A refused save hands the form back without the key it was given.
    const refused = await h.form('/admin/weather', base({ weather_provider: 'openweathermap', weather_key: KEY, latitude: '999' }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(KEY);

    const saved = await h.form('/admin/weather', base({ weather_provider: 'openweathermap', weather_key: KEY }));
    expect(saved.status).toBe(302);
    const row = h.db.prepare('SELECT key_encrypted AS sealed FROM weather_keys WHERE provider = ?').get('openweathermap') as {
      sealed: string;
    };
    expect(row.sealed).not.toContain(KEY);

    const page = await (await h.call('/admin/alerts')).text();
    expect(page).not.toContain(KEY);
    expect(page).toContain('A key for OpenWeatherMap is saved. Leave this empty to keep it.');
    // Saving again with the field empty keeps it.
    expect((await h.form('/admin/weather', base({ weather_provider: 'openweathermap' }))).status).toBe(302);
    expect(h.db.prepare('SELECT count(*) AS n FROM weather_keys').get()).toEqual({ n: 1 });

    expect(page).toContain('href="admin/weather/keys/openweathermap/forget"');
    const confirm = await h.call('/admin/weather/keys/openweathermap/forget');
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Forget the OpenWeatherMap key?');
    const forgot = await h.form('/admin/weather/keys/openweathermap/forget', {});
    expect(forgot.headers.get('location')).toBe('/admin/alerts?saved=weather-key-forgotten');
    expect(h.db.prepare('SELECT count(*) AS n FROM weather_keys').get()).toEqual({ n: 0 });
    // A key already gone changes nothing, and says nothing.
    const again = await h.form('/admin/weather/keys/openweathermap/forget', {});
    expect(again.headers.get('location')).toBe('/admin/alerts');
  });

  it('checks a Weather Underground station id and keeps the entity and provider on a refusal', async () => {
    const h = await harness();
    const refused = await h.form(
      '/admin/weather',
      base({ weather_provider: 'wunderground', weather_key: KEY, weather_station: 'not a station!' }),
    );
    expect(refused.status).toBe(400);
    const text = await refused.text();
    expect(text).toContain('A station id is letters and digits');
    expect(text).toContain('<option value="wunderground" selected>');
    expect(text).toContain('value="not a station!"');

    const saved = await h.form(
      '/admin/weather',
      base({ weather_provider: 'wunderground', weather_key: KEY, weather_station: 'KWASEATT2743' }),
    );
    expect(saved.status).toBe(302);
    expect(h.db.prepare('SELECT weather_station AS s FROM household_settings').get()).toEqual({ s: 'KWASEATT2743' });
  });
});

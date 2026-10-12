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
import { haModule, readDaylightStates } from '../src/modules/homeassistant/index.js';
import { DAYLIGHT_FRESH_MS, daylightFromState, resolveDaylight } from '../src/api/daylight.js';
import { applyWallState, readWallState } from '../src/api/wall-state.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

/**
 * The daytime theme switched by the sun or by a Home Assistant entity (plan
 * item M8.7).
 *
 * The resolver is pure and is asked directly, at instants chosen so each
 * answer is a fact a person can check: London's midsummer sunrise, a Tromsø
 * midsummer and midwinter. Then the whole path — the form, the poll against a
 * fake house answering the way Home Assistant answers, and the manifest a wall
 * reads — because the half of this that matters to rule 12 is what the wall
 * is *not* sent, and only a manifest can show that.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  await closeFakeHomeAssistants();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Midday UTC on a date, so London is on that date in either offset. */
const noon = (date: string): number => Date.parse(`${date}T12:00:00Z`);

describe('resolveDaylight', () => {
  const base = { state: null, readAt: null, timezone: 'Europe/London' };

  it('is today’s sunrise and sunset where the house is, printed in the wall’s zone', () => {
    const june = resolveDaylight({ ...base, source: 'sun', latitude: 51.5074, longitude: -0.1278, now: noon('2026-06-21') });
    // 04:43 BST and 21:21 BST, as the almanac has it, to the minute either way.
    expect(june).toMatchObject({ startsAt: expect.stringMatching(/^04:4[2-4]$/), endsAt: expect.stringMatching(/^21:2[0-2]$/) });
    const december = resolveDaylight({ ...base, source: 'sun', latitude: 51.5074, longitude: -0.1278, now: noon('2026-12-21') });
    // 08:04 and 15:53 GMT: the clock change is in the printing, not the sun.
    expect(december).toMatchObject({ startsAt: expect.stringMatching(/^08:0[3-5]$/), endsAt: expect.stringMatching(/^15:5[2-4]$/) });
    const sydney = resolveDaylight({
      ...base,
      timezone: 'Australia/Sydney',
      source: 'sun',
      latitude: -33.87,
      longitude: 151.21,
      now: Date.parse('2026-06-21T02:00:00Z'),
    });
    // The winter solstice there: 07:00 and 16:54, in Sydney's own clock.
    expect(sydney).toMatchObject({ startsAt: expect.stringMatching(/^0(6:59|7:0[01])$/), endsAt: expect.stringMatching(/^16:5[3-5]$/) });
  });

  it('is day all day in a polar summer and never in a polar winter', () => {
    const at = { ...base, timezone: 'Europe/Oslo', source: 'sun', latitude: 69.65, longitude: 18.96 };
    expect(resolveDaylight({ ...at, now: noon('2026-06-21') })).toEqual({ startsAt: '00:00', endsAt: '24:00' });
    expect(resolveDaylight({ ...at, now: noon('2026-12-21') })).toEqual({ startsAt: '00:00', endsAt: '00:00' });
  });

  it('leaves the hours alone with no location, for the clock, and for an unknown source', () => {
    expect(resolveDaylight({ ...base, source: 'sun', latitude: null, longitude: null, now: noon('2026-06-21') })).toBeUndefined();
    expect(resolveDaylight({ ...base, source: null, latitude: 51.5, longitude: 0, now: noon('2026-06-21') })).toBeUndefined();
    expect(resolveDaylight({ ...base, source: 'moon', latitude: 51.5, longitude: 0, now: noon('2026-06-21') })).toBeUndefined();
  });

  it('believes an entity only while its reading is fresh', () => {
    const now = noon('2026-06-21');
    const entity = { ...base, source: 'entity', latitude: null, longitude: null, now };
    expect(resolveDaylight({ ...entity, state: 1, readAt: now - 60_000 })).toEqual({ now: true });
    expect(resolveDaylight({ ...entity, state: 0, readAt: now - DAYLIGHT_FRESH_MS })).toEqual({ now: false });
    expect(resolveDaylight({ ...entity, state: 1, readAt: now - DAYLIGHT_FRESH_MS - 1 })).toBeUndefined();
    expect(resolveDaylight({ ...entity, state: null, readAt: now })).toBeUndefined();
    expect(resolveDaylight({ ...entity, state: 1, readAt: null })).toBeUndefined();
  });

  it('reads sun.sun by its own words and anything else as a switch', () => {
    expect(daylightFromState('sun.sun', 'above_horizon')).toBe(1);
    expect(daylightFromState('sun.sun', 'below_horizon')).toBe(0);
    expect(daylightFromState('sun.sun', 'on')).toBeNull();
    expect(daylightFromState('binary_sensor.dark_outside', 'on')).toBe(1);
    expect(daylightFromState('input_boolean.daylight', 'off')).toBe(0);
    expect(daylightFromState('binary_sensor.dark_outside', 'unavailable')).toBeNull();
    const states = readDaylightStates(
      JSON.stringify([
        { entity_id: 'sun.sun', state: 'above_horizon', attributes: {} },
        { entity_id: 'sensor.other', state: 'on' },
        { entity_id: 7 },
      ]),
      new Set(['sun.sun', 'binary_sensor.gone']),
    );
    expect([...states]).toEqual([['sun.sun', 1]]);
    expect(readDaylightStates('not json', new Set(['sun.sun'])).size).toBe(0);
  });
});

interface Wall {
  readonly db: SqliteDatabase;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly page: (path: string) => Promise<string>;
  readonly theme: () => Promise<Record<string, unknown>>;
  readonly poll: () => Promise<void>;
}

async function harness(): Promise<Wall> {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-daylight-'));
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
  await form('/setup/account', {
    name: 'Household',
    email: 'family@home.local',
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const issued = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, daytime_theme, daytime_starts_at, daytime_ends_at,
                          token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', 'almanac', '07:00', '21:00', ?, ?, ?)`,
  ).run(issued.tokenHash, stamp, stamp, stamp);

  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return Date.now(); } };
  return {
    db,
    form,
    page: async (path) => (await call(path)).text(),
    theme: async () => {
      const response = await call('/d/manifest', { headers: { authorization: `Bearer ${issued.token}` } });
      const text = await response.text();
      // Rule 12: whatever the source, the wall is handed day or night and
      // never the entity that said so.
      expect(text).not.toContain('sun.sun');
      expect(text).not.toContain('binary_sensor.');
      return (JSON.parse(text) as { theme: Record<string, unknown> }).theme;
    },
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
  };
}

/** The wall's settings form, as the page would post it, with what changes laid over. */
const settings = (fields: Record<string, string>): Record<string, string> => ({
  name: 'Kitchen',
  theme: 'panels',
  orientation: 'auto',
  rotation: '0',
  daytime_theme: 'almanac',
  daytime_starts_at: '07:00',
  daytime_ends_at: '21:00',
  ...fields,
});

describe('a wall switching by the sun or by Home Assistant', () => {
  it('sends today’s sunrise and sunset in place of the hours, and the hours without a location', async () => {
    const h = await harness();
    const before = await h.theme();
    expect(before).toMatchObject({ daytimeStartsAt: '07:00', daytimeEndsAt: '21:00' });
    expect(before).not.toHaveProperty('daylightNow');

    const saved = await h.form('/admin/screens/wall', settings({ daylight_by: 'sun' }));
    expect(saved.status).toBeLessThan(400);
    // No location yet: the wall keeps the hours rather than switching never.
    expect(await h.theme()).toMatchObject({ daytimeStartsAt: '07:00', daytimeEndsAt: '21:00' });
    expect(await h.page('/admin/walls/wall')).toContain('Sunrise and sunset need a location');

    h.db.prepare(`UPDATE household_settings SET latitude = 51.5074, longitude = -0.1278`).run();
    const theme = await h.theme();
    const expected = resolveDaylight({
      source: 'sun', state: null, readAt: null, latitude: 51.5074, longitude: -0.1278,
      timezone: 'Europe/London', now: Date.now(),
    }) as { startsAt: string; endsAt: string };
    expect(theme['daytimeStartsAt']).toBe(expected.startsAt);
    expect(theme['daytimeEndsAt']).toBe(expected.endsAt);
    expect(theme['daytimeStartsAt']).not.toBe('07:00');

    // A wall with no daytime theme has nothing to switch, and sends no window.
    await h.form('/admin/screens/wall', settings({ daytime_theme: '', daylight_by: 'sun' }));
    const plain = await h.theme();
    expect(plain).not.toHaveProperty('daytimeStartsAt');
    expect(plain).not.toHaveProperty('daylightNow');
  });

  it('follows sun.sun through the poll, and falls back to the hours when the reading goes stale', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await h.form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });

    const page = await h.page('/admin/walls/wall');
    expect(page).toContain('<option value="entity:sun.sun">Home Assistant: Sun</option>');
    expect((await h.form('/admin/screens/wall', settings({ daylight_by: 'entity:sun.sun' }))).status).toBeLessThan(400);
    expect(await h.page('/admin/walls/wall')).toContain('<option value="entity:sun.sun" selected>');

    // Read by nothing yet: the hours stand.
    expect(await h.theme()).not.toHaveProperty('daylightNow');

    ha.sun = 'below_horizon';
    await h.poll();
    expect(await h.theme()).toMatchObject({ daylightNow: false, daytimeStartsAt: '07:00', daytimeEndsAt: '21:00' });
    ha.sun = 'above_horizon';
    await h.poll();
    expect(await h.theme()).toMatchObject({ daylightNow: true });

    // A house that stops answering stops being the sky's word.
    h.db.prepare(`UPDATE screens SET daylight_read_at = ?`).run(Date.now() - DAYLIGHT_FRESH_MS - 60_000);
    expect(await h.theme()).not.toHaveProperty('daylightNow');

    // A sun that is neither up nor down is no reading.
    ha.sun = 'unavailable';
    await h.poll();
    expect(await h.theme()).not.toHaveProperty('daylightNow');

    // Choosing another entity forgets the old one's reading at once.
    ha.sun = 'above_horizon';
    await h.poll();
    expect(await h.theme()).toMatchObject({ daylightNow: true });
    await h.form('/admin/screens/wall', settings({ daylight_by: 'entity:binary_sensor.freezer_door' }));
    expect(await h.theme()).not.toHaveProperty('daylightNow');
  });

  it('refuses a choice the list never offers, and leaves the choice alone when a page did not post one', async () => {
    const h = await harness();
    await h.form('/admin/screens/wall', settings({ daylight_by: 'sun' }));
    const refused = await h.form('/admin/screens/wall', settings({ daylight_by: 'entity:lock.front_door' }));
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Choose what switches the daytime theme from the list.');
    // A page rendered before the control existed posts no `daylight_by`.
    expect((await h.form('/admin/screens/wall', settings({}))).status).toBeLessThan(400);
    const row = h.db.prepare(`SELECT daylight_source AS source FROM screens WHERE id = 'wall'`).get() as { source: string };
    expect(row.source).toBe('sun');
  });

  it('travels with a version, a file and a copy of the wall', async () => {
    const h = await harness();
    await h.form('/admin/screens/wall', settings({ daylight_by: 'entity:sun.sun' }));
    const state = readWallState(h.db, 'wall');
    expect(state?.daylightBy).toBe('entity:sun.sun');

    await h.form('/admin/screens/wall', settings({ daylight_by: 'clock' }));
    expect(readWallState(h.db, 'wall')?.daylightBy).toBe('clock');
    applyWallState(h.db, 'wall', state!, { freshIds: false });
    expect(readWallState(h.db, 'wall')?.daylightBy).toBe('entity:sun.sun');

    // A state from before the field existed leaves the wall's choice as it is.
    const { daylightBy: _dropped, ...older } = state!;
    await h.form('/admin/screens/wall', settings({ daylight_by: 'sun' }));
    applyWallState(h.db, 'wall', older, { freshIds: false });
    expect(readWallState(h.db, 'wall')?.daylightBy).toBe('sun');
  });
});

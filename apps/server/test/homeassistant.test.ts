import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { todoModule } from '../src/modules/todo/index.js';
import { createHaCalendarSyncHandler } from '../src/jobs/ha-calendar-sync.js';
import { resolveConnection, SUPERVISOR_BASE } from '../src/modules/homeassistant/client.js';
import { buildDiagnostics } from '../src/api/diagnostics.js';
import { seedDefaultRules } from '../src/api/rules.js';
import type { SqliteDatabase } from '../src/db/open.js';
import type { JobRecord } from '@maverick-wall/core';
import {
  closeFakeHomeAssistants,
  fakeHomeAssistant,
  inDays,
  TOKEN,
  type FakeHa,
} from './fake-home-assistant.js';

/**
 * Home Assistant, driven against a real HTTP server.
 *
 * Every request in this file goes over a socket to a process answering with
 * the shapes Home Assistant actually answers with. A stub of the client would
 * prove that the client calls itself correctly, which is not the thing that
 * has ever been wrong here — the SSRF guard, the token header, the exclusive
 * end date and the cache write are, and none of them are exercised by a mock.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  /** The paired screen's token, for the routes behind `/d/`. */
  readonly displayToken: string;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifest: () => Promise<ManifestShape>;
  readonly pollHa: () => Promise<void>;
  readonly syncCalendars: () => Promise<void>;
}

interface ManifestShape {
  readonly display: { readonly blocks: string[] };
  readonly screen: { readonly allowDismiss: boolean };
  readonly panels: Record<string, unknown>;
  readonly interrupts: {
    ruleId: string;
    key: string;
    title: string;
    headline?: string;
    action: string;
    source: string;
    dismissible: boolean;
  }[];
  readonly days: { date: string; events: { title: string }[] }[];
  readonly sources: { name: string; eventCount: number; lastError: string | null }[];
}

async function harness(): Promise<Harness> {
  const address = `10.7.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ha-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);
  // The same seed boot runs, so the harness has the rules a real installation
  // has rather than an emptier world than any household ever sees.
  seedDefaultRules(db);

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

  const manifest = async (): Promise<ManifestShape> => {
    const response = await call('/d/manifest', {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    return (await response.json()) as ManifestShape;
  };

  const context = {
    db,
    fetcher,
    keyring,
    timezone: 'Europe/London',
    get now(): number {
      return Date.now();
    },
  };

  return {
    db,
    keyring,
    displayToken: issued.token,
    call,
    form,
    manifest,
    pollHa: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    syncCalendars: async () => {
      const handler = createHaCalendarSyncHandler({
        db,
        fetcher,
        keyring,
        timezone: () => 'Europe/London',
      });
      const rows = db
        .prepare(`SELECT id FROM calendar_sources WHERE kind = 'homeassistant'`)
        .all() as { id: string }[];
      for (const row of rows) {
        await handler({
          key: `ha-calendar-sync:${row.id}`,
          kind: 'ha-calendar-sync',
          nextRunAt: 0,
          consecutiveFailures: 0,
        } as JobRecord);
      }
    },
  };
}

/** Connect through the form, the way a household with a mouse would. */
async function connect(h: Harness, ha: FakeHa): Promise<Response> {
  return h.form('/admin/home-assistant/connect', {
    base_url: ha.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
}

describe('finding the connection', () => {
  it('prefers the supervisor when its token is in the environment', async () => {
    const h = await harness();
    const resolved = resolveConnection(h.db, h.keyring, { SUPERVISOR_TOKEN: 'supervisor-secret' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.connection.mode).toBe('supervisor');
    expect(resolved.connection.baseUrl).toBe(SUPERVISOR_BASE);
    // Plain http to a bare hostname, both of which are refused by default.
    // This URL is a constant rather than anything a household typed.
    expect(resolved.connection.policy.allowHttp).toBe(true);
    expect(resolved.connection.policy.allowPrivateNetwork).toBe(true);
  });

  it('is simply not configured when neither path is set up', async () => {
    const h = await harness();
    const resolved = resolveConnection(h.db, h.keyring, {});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('not-configured');
  });

  it('says so plainly when the key is gone but the token is not', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // What a restore without /data/.secret looks like: the envelope is there
    // and nothing can open it.
    const stranger = createKeyring(randomBytes(32));
    const resolved = resolveConnection(h.db, stranger, {});
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.code).toBe('key-lost');
    expect(resolved.suggestion).toContain('new long-lived access token');
  });
});

describe('connecting, through the form', () => {
  it('stores the token encrypted and proves the connection works', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();

    const response = await connect(h, ha);
    expect(response.status).toBe(302);

    const row = h.db
      .prepare(`SELECT token_encrypted AS token, enabled FROM ha_settings WHERE id = 'singleton'`)
      .get() as { token: string; enabled: number };
    expect(row.enabled).toBe(1);
    expect(row.token).not.toContain(TOKEN);
    expect(row.token.startsWith('mw1.')).toBe(true);
    expect(h.keyring.decrypt(row.token, 'ha-token')).toEqual({ ok: true, value: TOKEN });

    // Proved rather than assumed: the fake refuses anything without the bearer.
    expect(ha.seen).toContain(`Bearer ${TOKEN}`);
    expect(ha.paths).toContain('/api/');
  });

  it('refuses plain http until somebody says they mean it', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();

    const response = await h.form('/admin/home-assistant/connect', {
      base_url: ha.base,
      token: TOKEN,
      allow_lan: '1',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('not encrypted');
    expect(html).toContain('controls your whole house');
    // Nothing stored, and nothing sent.
    expect(ha.paths).toHaveLength(0);
  });

  it('keeps the address when the token is wrong, and says what to do', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();

    const response = await h.form('/admin/home-assistant/connect', {
      base_url: ha.base,
      token: 'not-the-right-token',
      allow_lan: '1',
      accept_http: '1',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('refused the token');
    // Recoverable: the address survives so a household is not typing it again.
    const row = h.db
      .prepare(`SELECT base_url AS baseUrl FROM ha_settings WHERE id = 'singleton'`)
      .get() as { baseUrl: string };
    expect(row.baseUrl).toBe(ha.base);
  });

  it('never puts the token in the page', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // The hub, deliberately: the boundary card stays there rather than
    // following the token to Connection (RFC 014 §5.4). A household who has not
    // connected yet lands on the hub, and putting the thing that decides
    // whether pasting a token is reasonable one click further in means the
    // first screen they see no longer says what it costs.
    const html = await (await h.call('/admin/home-assistant')).text();
    expect(html).not.toContain(TOKEN);
    /*
     * The boundary is stated where somebody deciding to paste one can read it.
     *
     * This used to assert "It cannot control anything", which was true while
     * the permitted set was empty and became the most prominent stale claim in
     * the product the moment rule 12 was amended. It names the one permitted
     * write now — `ha-claims.test.ts` is what holds the other nine places, and
     * this one stays here because it is the assertion that would have gone red
     * if the card had been left alone.
     */
    expect(html).toContain('can tick one kind of box');
    expect(html).toContain('todo.update_item');
    expect(html).not.toContain('It cannot control anything');
  });

  it('fills the picker from the live house, and leaves the rest of it out', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // Readings: the two sections that were "On the wall" and "Add readings"
    // are one screen now (RFC 014 §4.2), and the picker went with them.
    const html = await (await h.call('/admin/home-assistant/readings')).text();
    // A datalist rather than a search box with a script behind it: the browser
    // does the type-ahead and the page adds nothing that can fail to load.
    expect(html).toContain('<datalist id="ha-entities">');
    expect(html).toContain('sensor.kitchen_temperature');
    expect(html).toContain('Kitchen temperature');
    // Not a reading, so never offered.
    expect(html).not.toContain('automation.morning_routine');
    // The calendar entity is offered as a source rather than as a reading, and
    // that offer is a screen along now.
    expect(html).not.toContain('calendar.family');
    expect(await (await h.call('/admin/home-assistant/calendars')).text()).toContain('calendar.family');
  });

  it('still renders every stored setting when Home Assistant is unreachable', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    ha.down = true;
    // Connection carries the address and the token, so it is the screen this
    // claim belongs to after the split (RFC 014 §4.1) — and it is where the
    // dashboard's own "the last read failed" row now points.
    const response = await h.call('/admin/home-assistant/connection');
    expect(response.status).toBe(200);
    const html = await response.text();
    // The address survives so somebody can fix a typo, and the page says what
    // is wrong rather than looking like a Home Assistant with nothing in it.
    expect(html).toContain(ha.base);
    expect(html).toContain('error');
  });

  it('never puts the token in the diagnostics export', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.pollHa();

    const report = JSON.stringify(
      buildDiagnostics({
        db: h.db,
        appVersion: '0.1.0-test',
        startedAt: Date.now() - 1000,
        now: Date.now(),
        log: [],
        databaseSizeBytes: 0,
      }),
    );
    expect(report).not.toContain(TOKEN);
  });
});

describe('readings on the wall', () => {
  it('polls, caches, and puts the block on a wall that never had one', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // The order was saved before this block existed, which is the case that
    // silently produced nothing when weather shipped.
    h.db
      .prepare(`UPDATE household_settings SET display_blocks = 'now,next,horizon'`)
      .run();

    await h.form('/admin/home-assistant/entities', {
      entity_id: 'sensor.kitchen_temperature',
      label: 'Kitchen',
      display_mode: 'label_value',
    });
    await h.pollHa();

    const manifest = await h.manifest();
    expect(manifest.display.blocks).toContain('home');

    const panel = manifest.panels['home'] as {
      readings: { label: string; value: string; unit: string | null }[];
    };
    expect(panel.readings).toHaveLength(1);
    expect(panel.readings[0]).toMatchObject({ label: 'Kitchen', value: '19.4', unit: '°C' });
  });

  it('adds several readings at once from the searchable picker', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    h.db.prepare(`UPDATE household_settings SET display_blocks = 'now,next,horizon'`).run();

    const response = await h.call('/admin/home-assistant/entities/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entities: [
          { entity_id: 'sensor.kitchen_temperature' },
          { entity_id: 'binary_sensor.freezer_door' },
        ],
        display_mode: 'label_value',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, added: 2 });
    await h.pollHa();

    const panel = (await h.manifest()).panels['home'] as {
      readings: { label: string }[];
    };
    expect(panel.readings).toHaveLength(2);
  });

  it('fills the weather location from the Home Assistant home zone', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // The button is offered on the Weather page once Home Assistant is connected.
    const display = await (await h.call('/admin/alerts')).text();
    expect(display).toContain('admin/weather/use-ha-location');

    // Deliberately bodyless — a POST that is *not* the screen's own form. It
    // must still fill the location in and must change nothing else: every
    // switch on that form is a checkbox, so an empty body reads as "everything
    // off" unless the handler can tell the two apart.
    h.db
      .prepare(`UPDATE household_settings SET alerts_enabled = 1 WHERE id = 'singleton'`)
      .run();
    const response = await h.call('/admin/weather/use-ha-location', { method: 'POST' });
    expect(response.status).toBe(302);

    const saved = h.db
      .prepare(
        `SELECT latitude, longitude, alerts_enabled AS alerts
           FROM household_settings WHERE id = 'singleton'`,
      )
      .get() as { latitude: number; longitude: number; alerts: number };
    expect(saved.latitude).toBeCloseTo(38.8894);
    expect(saved.longitude).toBeCloseTo(-77.0352);
    expect(saved.alerts, 'filling in a location must not turn the alerts off').toBe(1);
  });

  /**
   * The button carries the rest of the form with it, and a coordinate it cannot
   * parse must not be able to stop that.
   *
   * "Use my Home Assistant home location" is a second submit inside the one
   * settings form, so its body is whatever is on screen — including a switch
   * the household just flipped. It reads a *narrower* shape than Save does,
   * with the coordinates left out, because it is about to replace them: a
   * pasted "51.5074, -0.1278 London" in the latitude box is longer than the
   * field allows and would otherwise fail the parse, at which point falling
   * back to the stored row would discard the edits the button was pressed to
   * keep — and then redirect saying it had saved them.
   */
  it('keeps the rest of the form when the coordinate box holds something unparseable', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const response = await h.form('/admin/weather/use-ha-location', {
      weather_form: '1',
      weather_enabled: '1',
      // Not sent: alerts_enabled — the household turned the switch off.
      latitude: '51.5074, -0.1278 London, United Kingdom',
      longitude: '',
      weather_provider: 'openmeteo',
      weather_units: 'metric',
    });
    expect(response.status).toBe(302);

    const saved = h.db
      .prepare(
        `SELECT latitude, longitude, alerts_enabled AS alerts, weather_provider AS provider,
                weather_units AS units
           FROM household_settings WHERE id = 'singleton'`,
      )
      .get() as {
        latitude: number; longitude: number; alerts: number; provider: string; units: string;
      };
    expect(saved.latitude, 'the location it was pressed for').toBeCloseTo(38.8894);
    expect(saved.longitude).toBeCloseTo(-77.0352);
    expect(saved.provider, 'and the provider they changed in the same breath').toBe('openmeteo');
    expect(saved.units).toBe('metric');
    expect(saved.alerts, 'and the switch they turned off').toBe(0);
  });

  it('refuses an empty batch from the picker', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    const response = await h.call('/admin/home-assistant/entities/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities: [], display_mode: 'label_value' }),
    });
    expect(response.status).toBe(400);
  });

  it('sends the wall a value and never a way to ask for another', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/entities', {
      entity_id: 'binary_sensor.freezer_door',
      label: '',
      display_mode: 'icon_state',
    });
    await h.pollHa();
    // And a watched to-do list beside the reading (RFC 012), whose first read
    // runs inline — so the panel below carries items when the document is
    // checked, not an empty list that would prove nothing about them.
    const listed = await h.form('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: '' });
    expect(listed.status).toBe(302);

    const manifest = await h.manifest();
    const document = JSON.stringify(manifest);

    // The whole blast-radius argument in one assertion. A compromised screen
    // has a reading and nothing to query with.
    expect(document).not.toContain('binary_sensor.freezer_door');
    expect(document).not.toContain(TOKEN);
    expect(document).not.toContain(ha.base);
    // Nor a list's entity id, an item's uid, or the feature bitmask — the
    // panel carries handles this server minted and resolved values.
    expect(document).not.toContain('todo.shopping');
    expect(document).not.toContain('i-1');
    expect(document).not.toContain('supported_features');
    expect((manifest.panels['todo'] as { lists: unknown[] }).lists).toHaveLength(1);

    const panel = manifest.panels['home'] as { readings: { value: string; glyph: string }[] };
    // `on` means open, and only the device class knows that.
    expect(panel.readings[0]?.value).toBe('Open');
    // A glyph *key* both renderers draw themselves, never a character: an emoji
    // here is a third-party asset resolved on whatever tablet is looking.
    expect(panel.readings[0]?.glyph).toBe('door');
  });

  it('never puts the address on the wall, even when the connection is refused', async () => {
    /*
     * The failure mode that broke this once. The fetcher's own message for a
     * refused connection is the Node errno — "connect ECONNREFUSED
     * 127.0.0.1:8123" — and that string is stored as the connection's last
     * error, which the panel carries to the display as a note. So the raw
     * message put the household's Home Assistant address on a screen in their
     * hallway, which is the one thing this integration promises it does not do.
     */
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/entities', {
      entity_id: 'sensor.kitchen_temperature',
      label: 'Kitchen',
      display_mode: 'label_value',
    });
    await h.pollHa();

    // Not "down" — gone. A 502 comes from a server; this is no server at all.
    await ha.close();
    await h.pollHa();

    const document = JSON.stringify(await h.manifest());
    expect(document).not.toContain(ha.base);
    expect(document).not.toContain('ECONNREFUSED');
    expect(document).not.toContain('127.0.0.1');
    // And it still says something a person can act on.
    const panel = (await h.manifest()).panels['home'] as { note: string | null };
    expect(panel.note).toContain('Could not reach Home Assistant');
  });

  it('keeps showing the last reading when Home Assistant goes away', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/entities', {
      entity_id: 'sensor.kitchen_temperature',
      label: 'Kitchen',
      display_mode: 'label_value',
    });
    await h.pollHa();

    ha.down = true;
    await h.pollHa();

    const manifest = await h.manifest();
    const panel = manifest.panels['home'] as {
      readings: { value: string }[];
      note: string | null;
    };
    // Rule nine. A reading that is a few minutes old beats a hole in the wall.
    expect(panel.readings[0]?.value).toBe('19.4');
    expect(panel.note).not.toBeNull();
  });

  it('ignores a domain a wall has no use for', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const response = await h.form('/admin/home-assistant/entities', {
      entity_id: 'automation.morning_routine',
      label: '',
      display_mode: 'value',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not a reading a wall can show');
  });
});

describe('calendar entities as sources', () => {
  it('adds one with no address at all, and syncs it into the same cache', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const response = await h.form('/admin/home-assistant/calendars', {
      entity_id: 'calendar.family',
      name: 'Family',
    });
    expect(response.status).toBe(302);

    const source = h.db
      .prepare(
        `SELECT kind, ha_entity_id AS entityId, url_encrypted AS url
           FROM calendar_sources`,
      )
      .get() as { kind: string; entityId: string; url: string | null };
    expect(source).toMatchObject({
      kind: 'homeassistant',
      entityId: 'calendar.family',
      url: null,
    });

    await h.syncCalendars();

    const manifest = await h.manifest();
    expect(manifest.sources[0]).toMatchObject({ name: 'Family', lastError: null, eventCount: 2 });

    /*
     * The exclusive end date, checked on the wall rather than in a parser.
     *
     * Home Assistant answers with `end.date` the day *after* the last day the
     * event occupies, exactly as ICS does. Getting it wrong puts every all-day
     * event on one day too many, which is the single most common bug in
     * calendar code and the reason this assertion is about two days rather
     * than one.
     */
    const binDay = manifest.days.find((day) => day.date === inDays(3));
    const dayAfter = manifest.days.find((day) => day.date === inDays(4));
    expect(binDay?.events.map((event) => event.title)).toContain('Bin day');
    expect(dayAfter?.events.map((event) => event.title) ?? []).not.toContain('Bin day');
  });

  it('leaves the calendar on the wall when Home Assistant stops answering', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/calendars', { entity_id: 'calendar.family', name: 'Family' });
    await h.syncCalendars();

    ha.down = true;
    await h.syncCalendars();

    const manifest = await h.manifest();
    // Rule nine again, and the reason every failure path records rather than
    // deletes: the events survive, and the source says what went wrong.
    const binDay = manifest.days.find((day) => day.date === inDays(3));
    expect(binDay?.events.map((event) => event.title)).toContain('Bin day');
    expect(manifest.sources[0]?.lastError).not.toBeNull();
  });
});

describe('interrupts', () => {
  async function withRule(fields: Record<string, string>): Promise<ManifestShape> {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    const response = await h.form('/admin/home-assistant/rules', fields);
    expect(response.status).toBe(302);
    await h.pollHa();
    return h.manifest();
  }

  it('fires once the state has been held long enough', async () => {
    // The fake's freezer door has been open nine minutes.
    const manifest = await withRule({
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'banner',
    });

    expect(manifest.interrupts).toHaveLength(1);
    expect(manifest.interrupts[0]?.action).toBe('banner');
    expect(manifest.interrupts[0]?.source).toBe('homeassistant');
    // The entity's own name, and the state said the way a person would say it
    // rather than the way Home Assistant reports it.
    expect(manifest.interrupts[0]?.title).toBe('Freezer door');
    expect(manifest.interrupts[0]?.headline).toBe('Open');
  });

  it('does not fire before the wait is up', async () => {
    const manifest = await withRule({
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '30',
      action: 'banner',
    });
    expect(manifest.interrupts).toHaveLength(0);
  });

  it('does not fire when the state is simply not the one named', async () => {
    const manifest = await withRule({
      name: 'Water under the sink',
      entity_id: 'binary_sensor.under_sink',
      condition: 'equals',
      value: 'on',
      for_minutes: '',
      action: 'takeover_and_wake',
    });
    expect(manifest.interrupts).toHaveLength(0);
  });

  it('carries the takeover through to the wall', async () => {
    const manifest = await withRule({
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'takeover',
    });
    expect(manifest.interrupts[0]?.action).toBe('takeover');
  });

  it('watches an entity for a rule without putting it on the wall', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/rules', {
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'banner',
    });
    await h.pollHa();

    const manifest = await h.manifest();
    // Being told about the freezer is not the same as staring at it.
    expect(manifest.interrupts).toHaveLength(1);
    expect(manifest.panels['home']).toBeUndefined();
    expect(manifest.display.blocks).not.toContain('home');
  });
});

describe('the shipped templates, through the form', () => {
  it('fills the rule form in from a link, with no script involved', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    /*
     * Both halves move with the builder (RFC 014 §3.2). The rows link to the
     * screen the form is on now, and the old hub address answers a 302 that
     * carries the query through — a link already in the world is a contract,
     * and this one is the entire interface the feature has.
     */
    const listing = await (await h.call('/admin/home-assistant/alerts')).text();
    // Relative, so the `<base>` decides where it points — which is what lets
    // the same markup work under a Home Assistant ingress prefix.
    expect(listing).toContain('href="admin/home-assistant/alerts?template=garage"');

    const bookmarked = await h.call('/admin/home-assistant?template=garage');
    expect(bookmarked.status).toBe(302);
    expect(bookmarked.headers.get('location')).toBe('/admin/home-assistant/alerts?template=garage');

    const html = await (await h.call('/admin/home-assistant/alerts?template=garage')).text();
    expect(html).toContain('value="Garage door open late"');
    // The window the brief names, prefilled rather than described.
    expect(html).toContain('type="time" name="from_time" value="23:00"');
    expect(html).toContain('type="time" name="to_time" value="06:00"');
    expect(html).toContain('value="10"');
    expect(html).toContain('<option value="takeover" selected>');
  });

  it('stores the window, and does not fire in the afternoon', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const response = await h.form('/admin/home-assistant/rules', {
      name: 'Garage door open late',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      from_time: '23:00',
      to_time: '06:00',
      action: 'takeover',
    });
    expect(response.status).toBe(302);
    await h.pollHa();

    const stored = h.db
      .prepare(`SELECT conditions FROM interrupt_rules WHERE trigger = 'homeassistant'`)
      .get() as { conditions: string };
    expect(JSON.parse(stored.conditions)).toMatchObject({
      entityId: 'binary_sensor.freezer_door',
      condition: { kind: 'equals', value: 'on', between: { from: '23:00', to: '06:00' } },
    });

    /*
     * The household is Europe/London and this test runs whenever it runs, so
     * the assertion is about agreement rather than about a fixed answer: the
     * rule fires exactly when the wall clock is inside the window it stored.
     */
    const manifest = await h.manifest();
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    const overnight = hhmm >= '23:00' || hhmm < '06:00';
    expect(manifest.interrupts.length).toBe(overnight ? 1 : 0);
  });

  it('refuses half a window rather than quietly ignoring it', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const response = await h.form('/admin/home-assistant/rules', {
      name: 'Garage door open late',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '',
      from_time: '23:00',
      to_time: '',
      action: 'banner',
    });
    // Ignoring it would give somebody a rule that fires at noon and looks
    // exactly like the one they meant to write.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('both times, or neither');
  });
});

describe('acknowledging from the wall', () => {
  async function firing(): Promise<{ h: Harness; token: string }> {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/rules', {
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'banner',
    });
    await h.pollHa();
    return { h, token: h.displayToken };
  }

  it('clears an interrupt, and every screen goes quiet together', async () => {
    const { h, token } = await firing();
    const before = await h.manifest();
    expect(before.interrupts).toHaveLength(1);

    const key = `${before.interrupts[0]?.ruleId}:${before.interrupts[0]?.key}`;
    const response = await h.call('/d/interrupts/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${token}` },
      body: new URLSearchParams({ key }).toString(),
    });
    expect(response.status).toBe(200);

    /*
     * Household-wide, deliberately. The hall television acknowledges on behalf
     * of everybody — a kitchen tablet and a hall television disagreeing about
     * whether the freezer is still worth mentioning is worse than either
     * answer.
     */
    expect((await h.manifest()).interrupts).toHaveLength(0);
  });

  it('refuses to clear something the rule said may not be cleared', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    /*
     * The wall draws no button for these, but the button is not the control.
     * A display token is on a screen in a hallway, and an Extreme warning must
     * not be clearable by anything that can reach the endpoint.
     */
    const response = await h.call('/d/interrupts/dismiss', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${h.displayToken}`,
      },
      body: new URLSearchParams({ key: 'nws-default-extreme:urn:oid:whatever' }).toString(),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a key that is not one', async () => {
    const h = await harness();
    for (const key of ['', 'no-colon-here', 'x'.repeat(500)]) {
      const response = await h.call('/d/interrupts/dismiss', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Bearer ${h.displayToken}`,
        },
        body: new URLSearchParams({ key }).toString(),
      });
      expect(response.status).toBe(400);
    }
  });

  it('offers the control only on a screen that was told it has input', async () => {
    const { h } = await firing();
    // Default is off: most screens are a panel on a wall with nothing to press.
    expect((await h.manifest()).screen.allowDismiss).toBe(false);

    h.db.prepare(`UPDATE screens SET allow_dismiss = 1`).run();
    expect((await h.manifest()).screen.allowDismiss).toBe(true);
  });
});

describe('disconnecting', () => {
  it('forgets the token, the readings and the rules', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/entities', {
      entity_id: 'sensor.kitchen_temperature',
      label: 'Kitchen',
      display_mode: 'label_value',
    });
    await h.form('/admin/home-assistant/rules', {
      name: 'Freezer door open',
      entity_id: 'binary_sensor.freezer_door',
      condition: 'equals',
      value: 'on',
      for_minutes: '5',
      action: 'banner',
    });
    // And a to-do list with its cached items (RFC 012).
    expect((await h.form('/admin/home-assistant/lists', { entity_id: 'todo.shopping', label: '' })).status).toBe(302);
    expect(h.db.prepare('SELECT count(*) AS n FROM ha_todo_items').get()).toEqual({ n: 3 });

    const response = await h.call('/admin/home-assistant/disconnect', { method: 'POST' });
    expect(response.status).toBe(302);

    const settings = h.db
      .prepare(`SELECT enabled, token_encrypted AS token FROM ha_settings WHERE id = 'singleton'`)
      .get() as { enabled: number; token: string | null };
    expect(settings).toEqual({ enabled: 0, token: null });

    const counts = h.db
      .prepare(
        `SELECT (SELECT count(*) FROM ha_entity_cache) AS entities,
                (SELECT count(*) FROM interrupt_rules
                  WHERE trigger IN ('homeassistant', 'ha_entity')) AS rules,
                (SELECT count(*) FROM interrupt_rules WHERE trigger = 'nws') AS weather`,
      )
      .get() as { entities: number; rules: number; weather: number };
    expect(counts.entities).toBe(0);
    expect(counts.rules).toBe(0);
    // The shipped weather rules have nothing to do with Home Assistant and
    // must survive disconnecting it.
    expect(counts.weather).toBeGreaterThan(0);
    /*
     * The to-do tables go too, and the count is the point: `todoModule.ready`
     * is "at least one watched list", so a row left behind would keep a To-do
     * widget on the wall drawing a list that never refreshes again, over a
     * connection that is gone.
     */
    expect(
      h.db
        .prepare(
          `SELECT (SELECT count(*) FROM ha_todo_lists) AS lists,
                  (SELECT count(*) FROM ha_todo_items) AS items`,
        )
        .get(),
    ).toEqual({ lists: 0, items: 0 });
    expect(todoModule.ready(h.db)).toBe(false);
  });
});

/**
 * The Calendars screen and Home Assistant, which is one seam and used to be two
 * unconnected halves.
 *
 * A household reported adding "a calendar" on the Home Assistant screen and
 * getting a chip that said **On**. They had used the readings picker, which
 * offered calendar entities — and a calendar entity's state is `on`/`off`,
 * meaning "an event is happening right now". The calendar path existed the
 * whole time, one section further down the same page, and nothing on the
 * Calendars screen ever mentioned it.
 *
 * So: calendars are not offered as readings at all, and the Calendars screen
 * offers the ones Home Assistant has.
 */
describe('Home Assistant calendars, from the Calendars screen', () => {
  it('offers what Home Assistant has, and adds it as an ordinary calendar', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    // On the add page's chooser, since P2.1 took every way of adding a
    // calendar off the Calendars list: the page it is read from moved, and
    // what it offers did not.
    const page = await (await h.call('/admin/calendars/new')).text();
    expect(page).toContain('From Home Assistant');
    expect(page).toContain('calendar.family');
    expect(page).toContain('Family');

    // The same endpoint the Home Assistant screen posts to — one validation,
    // one writer — and what lands is a calendar source like any other.
    const added = await h.form('/admin/home-assistant/calendars', {
      entity_id: 'calendar.family',
    });
    expect(added.status).toBe(302);
    // A confirmation token rides the redirect (RFC 009 Phase 3.1/3.2).
    expect(added.headers.get('location')).toBe('/admin/calendars?saved=ha-calendar-added');

    const row = h.db
      .prepare(`SELECT name, kind, ha_entity_id AS entityId, url_host AS host
                  FROM calendar_sources WHERE ha_entity_id = 'calendar.family'`)
      .get() as { name: string; kind: string; entityId: string; host: string | null };
    expect(row.kind).toBe('homeassistant');
    expect(row.name).toBe('Family');
    expect(row.host).toBe(null);
  });

  it('stops offering one that has already been added', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/calendars', { entity_id: 'calendar.family' });

    // The chooser, where the offer lives since P2.1 — on the list page this
    // would pass whatever the offer did, because the list draws none.
    const page = await (await h.call('/admin/calendars/new')).text();
    expect(page, 'the chooser is the page under test').toContain('href="admin/calendars/new/address"');
    // The only calendar the fake has, so the whole section goes rather than
    // standing there empty explaining itself.
    expect(page).not.toContain('From Home Assistant');
  });

  it('says what an added Home Assistant calendar is, and drops the control that cannot apply', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    await h.form('/admin/home-assistant/calendars', { entity_id: 'calendar.family' });

    const page = await (await h.call('/admin/calendars')).text();
    // It has no URL, so it must not read "unknown host".
    expect(page).toContain('Home Assistant · calendar.family');
    expect(page).not.toContain('unknown host');
    // Its events arrive through the Home Assistant connection, never the
    // guarded fetcher, so there is no outbound rule to relax. Scoped to this
    // calendar's own row: the add form at the foot of the page carries the
    // same network-access disclosure for an ordinary feed, and it should.
    const row = page.slice(page.indexOf('Home Assistant · calendar.family'), page.indexOf('Add a calendar'));
    expect(row).not.toContain('Network access');
  });

  it('draws no Home Assistant section when there is no Home Assistant', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/calendars')).text();
    expect(page).not.toContain('From Home Assistant');
    // And the page is still the page — a missing connection is not an error here.
    expect(page).toContain('Add a calendar');
  });

  it('does not wait on a Home Assistant that is down', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);
    ha.down = true;

    const response = await h.call('/admin/calendars');
    expect(response.status).toBe(200);
    const page = await response.text();
    // Nothing to offer, and nothing alarming: the Home Assistant screen is
    // where a broken connection is diagnosed (rule nine).
    expect(page).not.toContain('From Home Assistant');
    expect(page).toContain('Add a calendar');
  });

  it('refuses a calendar entity as a reading, and says where it went instead', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await connect(h, ha);

    const refused = await h.form('/admin/home-assistant/entities', {
      entity_id: 'calendar.family',
    });
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain('Choose an entity from the list.');
    expect(body).not.toContain('and calendars');
    // Nothing was watched, so nothing draws "Family · On" on the wall.
    const watched = h.db
      .prepare("SELECT count(*) AS n FROM ha_entity_cache WHERE watched = 1 AND entity_id LIKE 'calendar.%'")
      .get() as { n: number };
    expect(watched.n).toBe(0);

    // And the picker's own section says where calendars go, so their absence
    // reads as deliberate rather than as something missing.
    const readings = await (await h.call('/admin/home-assistant/readings')).text();
    expect(readings).toContain('Calendar entities are not readings');
  });
});

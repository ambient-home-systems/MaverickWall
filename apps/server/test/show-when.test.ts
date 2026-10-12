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
import { conditionChoices, readConditionStates } from '../src/modules/homeassistant/conditions.js';
import {
  CONDITION_FRESH_MS,
  shownNow,
  showWhenOf,
  type ConditionReading,
  type Conditions,
} from '../src/api/show-when.js';
import {
  displayConfig,
  keepWidgetsWithSomethingToSay,
  type HouseholdSetUp,
  type PlacedWidgetRow,
} from '../src/api/manifest.js';
import {
  SHOW_WHEN_NEEDS_PULSE,
  SHOW_WHEN_NEEDS_STATE,
  SHOW_WHEN_NOT_PULSE,
  widgetConfigBody,
} from '../src/api/widget-schema.js';
import { closeFakeHomeAssistants, fakeHomeAssistant, TOKEN } from './fake-home-assistant.js';

/**
 * A widget shown only while something in the house says so (plan items M6.4,
 * M6.5 and M6.7).
 *
 * The rule is pure and is asked directly at chosen instants; then the omission
 * that applies it on both renderers; then the whole path — the poll against a
 * fake house answering as Home Assistant answers, the manifest a wall reads
 * and the frame a panel puts on glass — because the half that matters to rule
 * 12 is what the wall is *not* sent, and only a manifest can show that.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  await closeFakeHomeAssistants();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse('2026-10-12T12:00:00Z');
const reading = (state: string, changedAgoS = 600, readAgoS = 10): ConditionReading => ({
  state,
  changedAt: NOW - changedAgoS * 1000,
  readAt: NOW - readAgoS * 1000,
});
const house = (readings: Record<string, ConditionReading>, panel = false): Conditions => ({
  readings,
  now: NOW,
  ...(panel ? { panel: true } : {}),
});

describe('shownNow', () => {
  it('shows a box while the entity is in the state, and not while it is not, or not known', () => {
    const rule = { entity: 'binary_sensor.porch', state: 'on' };
    expect(shownNow(rule, house({ 'binary_sensor.porch': reading('on') }))).toEqual({ shown: true });
    expect(shownNow(rule, house({ 'binary_sensor.porch': reading('off') }))).toEqual({ shown: false });
    expect(shownNow(rule, house({}))).toEqual({ shown: false });
    // A house that has not answered for five minutes is not the house's word.
    const stale = reading('on', 600, CONDITION_FRESH_MS / 1000 + 1);
    expect(shownNow(rule, house({ 'binary_sensor.porch': stale }))).toEqual({ shown: false });
  });

  it('hides a box while the entity is in the state, and shows it when the house is not known', () => {
    const rule = { entity: 'media_player.lounge', state: 'playing', not: true as const };
    expect(shownNow(rule, house({ 'media_player.lounge': reading('playing') }))).toEqual({ shown: false });
    expect(shownNow(rule, house({ 'media_player.lounge': reading('paused') }))).toEqual({ shown: true });
    expect(shownNow(rule, house({}))).toEqual({ shown: true });
  });

  it('shows a box for a while after the entity changes to the state, and then not, even if it stays', () => {
    const rule = { entity: 'binary_sensor.porch', state: 'on', pulse: 60 };
    expect(shownNow(rule, house({ 'binary_sensor.porch': reading('on', 20) }))).toEqual({
      shown: true,
      until: NOW - 20_000 + 60_000,
    });
    expect(shownNow(rule, house({ 'binary_sensor.porch': reading('on', 61) }))).toEqual({ shown: false });
    expect(shownNow(rule, house({ 'binary_sensor.porch': reading('off', 5) }))).toEqual({ shown: false });
  });

  it('times a momentary entity from the instant it reports, a stale poll included', () => {
    const rule = { entity: 'event.doorbell', pulse: 30 };
    const pressed = new Date(NOW - 10_000).toISOString();
    const stale = { state: pressed, changedAt: 0, readAt: NOW - 3_600_000 };
    expect(shownNow(rule, house({ 'event.doorbell': stale }))).toEqual({ shown: true, until: NOW + 20_000 });
    const long = { ...stale, state: new Date(NOW - 31_000).toISOString() };
    expect(shownNow(rule, house({ 'event.doorbell': long }))).toEqual({ shown: false });
    expect(shownNow(rule, house({ 'event.doorbell': { ...stale, state: 'unknown' } }))).toEqual({ shown: false });
  });

  it('never shows a pulse on a panel, whose one picture stays up for an hour', () => {
    const pressed = new Date(NOW - 5_000).toISOString();
    const doorbell = { 'event.doorbell': { state: pressed, changedAt: NOW, readAt: NOW } };
    expect(shownNow({ entity: 'event.doorbell', pulse: 30 }, house(doorbell, true))).toEqual({ shown: false });
    // A plain condition it honours as the wall does.
    const porch = { 'binary_sensor.porch': reading('on') };
    expect(shownNow({ entity: 'binary_sensor.porch', state: 'on' }, house(porch, true))).toEqual({ shown: true });
  });
});

describe('showWhenOf and the schema', () => {
  it('reads only a rule the server takes, and calls anything else no rule', () => {
    expect(showWhenOf({ showWhen: { entity: 'binary_sensor.porch', state: 'on' } })).toEqual({
      entity: 'binary_sensor.porch',
      state: 'on',
    });
    expect(showWhenOf({ showWhen: { entity: 'event.doorbell' } })).toBeUndefined();
    expect(showWhenOf({ showWhen: { entity: 'binary_sensor.porch' } })).toBeUndefined();
    expect(showWhenOf({ showWhen: { entity: 'binary_sensor.porch', state: 'on', not: true, pulse: 30 } })).toBeUndefined();
    expect(showWhenOf({ showWhen: { entity: 'Porch Light', state: 'on' } })).toBeUndefined();
    expect(showWhenOf({ showWhen: 'binary_sensor.porch' })).toBeUndefined();
  });

  it('refuses a rule that cannot work with a sentence, at the boundary', () => {
    const refused = (showWhen: unknown): string[] => {
      const parsed = widgetConfigBody.safeParse({ showWhen });
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(refused({ entity: 'binary_sensor.porch', state: 'on' })).toEqual([]);
    expect(refused({ entity: 'event.doorbell', pulse: 30 })).toEqual([]);
    expect(refused({ entity: 'binary_sensor.porch' })).toContain(SHOW_WHEN_NEEDS_STATE);
    expect(refused({ entity: 'event.doorbell' })).toContain(SHOW_WHEN_NEEDS_PULSE);
    expect(refused({ entity: 'binary_sensor.porch', state: 'on', not: true, pulse: 30 })).toContain(SHOW_WHEN_NOT_PULSE);
    expect(refused({ entity: 'binary_sensor.porch', state: 'on', pulse: 2 }).length).toBeGreaterThan(0);
    expect(refused({ entity: 'binary_sensor.porch', state: 'on', colour: 'red' }).length).toBeGreaterThan(0);
    // A fallback is what a hidden box draws, so it cannot be hidden itself;
    // and a panel's lane cannot change when a wall's box is there.
    const rule = { entity: 'binary_sensor.porch', state: 'on' };
    expect(widgetConfigBody.safeParse({ whenEmpty: { type: 'notes', config: { showWhen: rule } } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ ink: { showWhen: rule } }).success).toBe(false);
  });

  it('never sends the rule to the wall: it carries an entity id', () => {
    const out = displayConfig('notes', { text: 'Hi', showWhen: { entity: 'binary_sensor.porch', state: 'on' } });
    expect(out).toEqual({ text: 'Hi' });
  });
});

describe('the omission, with the house', () => {
  const setUp = (readings: Record<string, ConditionReading>, panel = false): HouseholdSetUp => ({
    modules: [],
    shift: false,
    todoLists: [],
    conditions: house(readings, panel),
  });
  const box = (id: string, config: Record<string, unknown>, extra: Partial<PlacedWidgetRow> = {}): PlacedWidgetRow => ({
    id,
    type: 'notes',
    x: 0,
    y: 0,
    w: 0.5,
    h: 0.5,
    z: 0,
    config,
    ...extra,
  });
  const porch = { entity: 'binary_sensor.porch', state: 'on' };
  const clock = box('clock', {}, { type: 'clock', x: 0.5 });

  it('draws a hidden box’s fallback in its rectangle, or nothing, and shows it when the house says so', () => {
    const camera = box('cam', { text: 'Somebody is at the door', showWhen: porch, whenEmpty: { type: 'clock' } });
    const off = keepWidgetsWithSomethingToSay([camera, clock], setUp({ 'binary_sensor.porch': reading('off') }));
    expect(off.find((one) => one.id === 'cam')).toMatchObject({ type: 'clock', substituted: true, x: 0, y: 0 });
    const on = keepWidgetsWithSomethingToSay([camera, clock], setUp({ 'binary_sensor.porch': reading('on') }));
    expect(on.find((one) => one.id === 'cam')).toMatchObject({ type: 'notes' });
    expect(on.find((one) => one.id === 'cam')).not.toHaveProperty('substituted');

    const bare = box('cam', { text: 'x', showWhen: porch });
    expect(keepWidgetsWithSomethingToSay([bare, clock], setUp({})).map((one) => one.id)).toEqual(['clock']);
  });

  it('shows every such box when the caller says nothing of the house', () => {
    const bare = box('cam', { text: 'x', showWhen: porch });
    const drawn = keepWidgetsWithSomethingToSay([bare, clock], { modules: [], shift: false, todoLists: [] });
    expect(drawn.map((one) => one.id)).toEqual(['cam', 'clock']);
  });

  it('draws nothing rather than a box the house hides, even when it is the only box', () => {
    const bare = box('cam', { text: 'x', showWhen: porch });
    expect(keepWidgetsWithSomethingToSay([bare], setUp({}))).toEqual([]);
  });

  it('hands a pulse its end and what the box draws then', () => {
    const pressed = new Date(NOW - 10_000).toISOString();
    const camera = box('cam', {
      text: 'Door',
      showWhen: { entity: 'event.doorbell', pulse: 30 },
      whenEmpty: { type: 'clock' },
    });
    const [drawn] = keepWidgetsWithSomethingToSay(
      [camera],
      setUp({ 'event.doorbell': { state: pressed, changedAt: NOW, readAt: NOW } }),
    );
    expect(drawn).toMatchObject({ id: 'cam', type: 'notes', showUntil: NOW + 20_000, then: { type: 'clock', substituted: true } });
  });

  it('shows or hides a whole group, and takes a pulsed group’s children down with it', () => {
    const group = box('g', { layout: 'row', showWhen: { entity: 'input_button.show_family', pulse: 60 } }, { type: 'group' });
    const a = box('a', { text: 'One' }, { parentId: 'g' });
    const b = box('b', { text: 'Two', showWhen: { entity: 'event.doorbell', pulse: 30 } }, { parentId: 'g' });
    const pressedAt = (s: number): string => new Date(NOW - s * 1000).toISOString();

    expect(keepWidgetsWithSomethingToSay([group, a, b, clock], setUp({})).map((one) => one.id)).toEqual(['clock']);

    const both = keepWidgetsWithSomethingToSay(
      [group, a, b, clock],
      setUp({
        'input_button.show_family': { state: pressedAt(10), changedAt: NOW, readAt: NOW },
        'event.doorbell': { state: pressedAt(20), changedAt: NOW, readAt: NOW },
      }),
    );
    const by = (id: string) => both.find((one) => one.id === id);
    expect(by('g')).toMatchObject({ showUntil: NOW + 50_000 });
    expect(by('a')).toMatchObject({ showUntil: NOW + 50_000 });
    // The earlier of its own and its group's.
    expect(by('b')).toMatchObject({ showUntil: NOW + 10_000 });
  });
});

describe('reading the house', () => {
  it('reads the named entities out of the states body, with Home Assistant’s own change time', () => {
    const body = JSON.stringify([
      { entity_id: 'binary_sensor.porch', state: 'on', last_changed: '2026-10-12T11:59:00+00:00' },
      { entity_id: 'event.doorbell', state: '2026-10-12T11:58:00.000+00:00' },
      { entity_id: 'sensor.other', state: '3' },
      { entity_id: 7 },
    ]);
    const found = readConditionStates(body, new Set(['binary_sensor.porch', 'event.doorbell']), NOW);
    expect(found.get('binary_sensor.porch')).toEqual({ state: 'on', changedAt: Date.parse('2026-10-12T11:59:00Z'), readAt: NOW });
    expect(found.get('event.doorbell')?.state).toBe('2026-10-12T11:58:00.000+00:00');
    expect(found.has('sensor.other')).toBe(false);
  });

  it('offers the house’s entities by name, with their usual states, and an event as a moment', () => {
    const choices = conditionChoices(
      JSON.stringify([
        { entity_id: 'binary_sensor.porch', state: 'off', attributes: { friendly_name: 'Porch' } },
        { entity_id: 'event.doorbell', state: '2026-10-12T11:58:00Z', attributes: { friendly_name: 'Doorbell' } },
        { entity_id: 'weather.home', state: 'sunny' },
        { entity_id: 'light.kitchen', state: 'unavailable' },
      ]),
    );
    expect(choices).toEqual([
      { id: 'event.doorbell', name: 'Doorbell', states: [], moment: true },
      { id: 'light.kitchen', name: 'light.kitchen', states: ['on', 'off'], moment: false },
      { id: 'binary_sensor.porch', name: 'Porch', states: ['off', 'on'], moment: false },
    ]);
  });
});

interface Wall {
  readonly db: SqliteDatabase;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly manifest: () => Promise<{ text: string; widgets: Record<string, unknown>[] }>;
  readonly frame: () => Promise<Response>;
  readonly poll: () => Promise<void>;
}

async function harness(): Promise<Wall> {
  const address = `10.9.1.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-show-when-'));
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

  const wall = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, layout_mode, token_issued_at, created_at, updated_at)
     VALUES ('wall', 'Kitchen', ?, 'panels', 'freeform', ?, ?, ?)`,
  ).run(wall.tokenHash, stamp, stamp, stamp);
  const panel = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, kind, panel_width, panel_height, panel_colour, rotation,
                          layout_mode, token_issued_at, created_at, updated_at)
     VALUES ('panel', 'Hall', ?, 'epaper', 800, 480, 'bw', 0, 'freeform', ?, ?, ?)`,
  ).run(panel.tokenHash, stamp, stamp, stamp);

  const context = { db, fetcher, keyring, timezone: 'Europe/London', get now(): number { return Date.now(); } };
  return {
    db,
    call,
    manifest: async () => {
      const response = await call('/d/manifest', { headers: { authorization: `Bearer ${wall.token}` } });
      const text = await response.text();
      const parsed = JSON.parse(text) as { layout: { portrait: { widgets: Record<string, unknown>[] } } };
      return { text, widgets: parsed.layout.portrait.widgets };
    },
    frame: () => call(`/d/epaper/${panel.token}.png`),
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
  };
}

function place(
  db: SqliteDatabase,
  screen: string,
  orientation: string,
  id: string,
  type: string,
  config: Record<string, unknown>,
  x: number,
): void {
  db.prepare(
    `INSERT INTO layout_widgets (id, screen_id, orientation, type, x, y, w, h, z, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0.5, 1, 0, ?, ?, ?)`,
  ).run(id, screen, orientation, type, x, JSON.stringify(config), Date.now(), Date.now());
}

describe('a wall and a panel following the house', () => {
  it('shows, hides and pulses boxes from the poll, and never tells the wall which entity decided', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await h.call('/admin/home-assistant/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' }).toString(),
    });
    place(h.db, 'wall', 'portrait', 'porch', 'notes', {
      text: 'Somebody is on the porch',
      showWhen: { entity: 'binary_sensor.porch', state: 'on' },
      whenEmpty: { type: 'notes', config: { text: 'All quiet' } },
    }, 0);
    place(h.db, 'wall', 'portrait', 'bell', 'notes', {
      text: 'Doorbell',
      showWhen: { entity: 'event.doorbell', pulse: 120 },
    }, 0.5);
    place(h.db, 'wall', 'portrait', 'clock', 'clock', {}, 0.5);

    ha.others['binary_sensor.porch'] = { state: 'off', name: 'Porch', lastChanged: new Date().toISOString() };
    ha.others['event.doorbell'] = { state: 'unknown', name: 'Doorbell' };
    await h.poll();
    const held = h.db.prepare('SELECT entity_id AS id FROM ha_condition_states ORDER BY entity_id').all();
    expect(held).toEqual([{ id: 'binary_sensor.porch' }, { id: 'event.doorbell' }]);

    let m = await h.manifest();
    expect(m.text).not.toContain('binary_sensor.porch');
    expect(m.text).not.toContain('event.doorbell');
    expect(m.text).not.toContain('showWhen');
    expect(m.widgets.find((w) => w['id'] === 'porch')).toMatchObject({ type: 'notes', substituted: true, config: { text: 'All quiet' } });
    expect(m.widgets.find((w) => w['id'] === 'bell')).toBeUndefined();

    const pressed = Date.now() - 5_000;
    ha.others['binary_sensor.porch'] = { state: 'on', name: 'Porch', lastChanged: new Date().toISOString() };
    ha.others['event.doorbell'] = { state: new Date(pressed).toISOString(), name: 'Doorbell' };
    await h.poll();
    m = await h.manifest();
    expect(m.text).not.toContain('binary_sensor.porch');
    expect(m.widgets.find((w) => w['id'] === 'porch')).toMatchObject({ config: { text: 'Somebody is on the porch' } });
    expect(m.widgets.find((w) => w['id'] === 'porch')).not.toHaveProperty('substituted');
    const bell = m.widgets.find((w) => w['id'] === 'bell');
    expect(bell).toMatchObject({ type: 'notes', showUntil: pressed + 120_000 });
    expect(bell).not.toHaveProperty('then');

    // A widget removed takes its entity's row with it on the next poll.
    h.db.prepare(`DELETE FROM layout_widgets WHERE id = 'bell'`).run();
    await h.poll();
    expect(h.db.prepare('SELECT entity_id AS id FROM ha_condition_states').all()).toEqual([{ id: 'binary_sensor.porch' }]);

    // The editor's list: the house's entities, by name.
    const listed = (await (await h.call('/admin/home-assistant/conditions.json')).json()) as {
      connected: boolean;
      entities: { id: string; moment: boolean }[];
    };
    expect(listed.connected).toBe(true);
    expect(listed.entities).toContainEqual(expect.objectContaining({ id: 'event.doorbell', moment: true }));
    expect(listed.entities).toContainEqual(expect.objectContaining({ id: 'binary_sensor.porch', moment: false }));
  });

  it('draws a panel’s box while the house says so, and never a pulse', async () => {
    const h = await harness();
    const ha = await fakeHomeAssistant();
    await h.call('/admin/home-assistant/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' }).toString(),
    });
    place(h.db, 'panel', 'landscape', 'clock', 'clock', {}, 0);
    place(h.db, 'panel', 'landscape', 'porch', 'notes', {
      text: 'Porch light is on',
      showWhen: { entity: 'binary_sensor.porch', state: 'on' },
    }, 0.5);
    ha.others['binary_sensor.porch'] = { state: 'off', lastChanged: new Date().toISOString() };
    await h.poll();
    const hidden = await h.frame();
    expect(hidden.status).toBe(200);
    const hiddenBytes = Buffer.from(await hidden.arrayBuffer());

    ha.others['binary_sensor.porch'] = { state: 'on', lastChanged: new Date().toISOString() };
    await h.poll();
    const shown = await h.frame();
    expect(shown.headers.get('etag')).not.toBe(hidden.headers.get('etag'));
    expect(Buffer.from(await shown.arrayBuffer()).equals(hiddenBytes)).toBe(false);

    // The same box as a pulse that has just fired: never on a panel.
    h.db
      .prepare(`UPDATE layout_widgets SET config = ? WHERE id = 'porch'`)
      .run(JSON.stringify({ text: 'Porch light is on', showWhen: { entity: 'binary_sensor.porch', state: 'on', pulse: 3600 } }));
    const pulsed = await h.frame();
    expect(Buffer.from(await pulsed.arrayBuffer()).equals(hiddenBytes)).toBe(true);
  });
});

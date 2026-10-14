import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Interrupt as CoreInterrupt } from '@maverick-wall/core';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';
import { alertFor, alertHandle, withAlertHandles } from '../src/api/notifications.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * A Home Assistant banner or takeover reaches a wall as a handle, never as the
 * entity it is about (rule 12).
 *
 * An interrupt's key is its signal's, and a Home Assistant signal is keyed by
 * its entity, so until this every firing Home Assistant rule put
 * `binary_sensor.back_door` in every wall's manifest — and in the push
 * message, which is built from the manifest's own list. A wall now gets a
 * handle, presses OK with it, and the server finds the signal it names among
 * what is firing.
 *
 * Against the real app, the real fetcher and a real poll of a stand-in Home
 * Assistant.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const DOOR = 'binary_sensor.back_door';
const GARAGE = 'cover.garage_door';
const HANDLE = /^ha-[0-9a-f]{24}$/;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface WallInterrupt {
  readonly ruleId: string;
  readonly key: string;
  readonly action: string;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly manifestText: () => Promise<string>;
  readonly interrupts: () => Promise<WallInterrupt[]>;
  readonly ok: (key: string) => Promise<Response>;
  readonly poll: () => Promise<void>;
  readonly acknowledged: () => string[];
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-alert-handle-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const at = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(at, at);
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
    clientAddress: () => `10.65.${n}.1`,
    setupToken,
    dataDir,
    now: () => at,
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
    email: `handle${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });

  const wall = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, allow_dismiss, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', 1, ?, ?)`,
  ).run(wall.tokenHash, at, at, at);
  ha.others[DOOR] = { state: 'on', lastChanged: new Date(at).toISOString(), name: 'Back door' };
  ha.others[GARAGE] = { state: 'open', lastChanged: new Date(at).toISOString(), name: 'Garage' };

  const asWall = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${wall.token}` },
      }),
    );
  const manifestText = async (): Promise<string> => (await asWall('/d/manifest')).text();
  return {
    db,
    ha,
    form,
    manifestText,
    interrupts: async () => (JSON.parse(await manifestText()) as { interrupts: WallInterrupt[] }).interrupts,
    ok: (key: string) =>
      asWall('/d/interrupts/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key }).toString(),
      }),
    poll: () =>
      (haModule.job as { run: (c: unknown) => Promise<void> }).run({
        db,
        fetcher,
        keyring,
        timezone: 'Europe/London',
        now: at,
      }),
    acknowledged: () =>
      (db.prepare('SELECT key FROM interrupt_dismissals ORDER BY key').all() as { key: string }[]).map((row) => row.key),
  };
}

const rule = (fields: Record<string, string>): Record<string, string> => ({
  name: 'The back door is open',
  entity_id: DOOR,
  condition: 'equals',
  value: 'on',
  action: 'banner',
  hold_sec: '',
  ...fields,
});

describe('a Home Assistant alert on a wall', () => {
  it('carries a handle and no entity id, for a banner and a takeover alike', async () => {
    const h = await harness();
    expect((await h.form('/admin/home-assistant/rules', rule({}))).status).toBe(302);
    expect(
      (await h.form('/admin/home-assistant/rules', rule({ name: 'Close it', entity_id: GARAGE, value: 'open', action: 'takeover' })))
        .status,
    ).toBe(302);
    await h.poll();

    const firing = await h.interrupts();
    // Premise: both rules fire, so the manifest is the one under test.
    expect(firing.map((one) => one.action).sort()).toEqual(['banner', 'takeover']);
    for (const one of firing) expect(one.key).toMatch(HANDLE);
    expect(new Set(firing.map((one) => one.key)).size).toBe(2);
    // Nowhere in the document: not in a key, a title, a headline or anything else.
    const text = await h.manifestText();
    expect(text).not.toContain(DOOR);
    expect(text).not.toContain(GARAGE);
    expect(text).not.toContain('binary_sensor');
    expect(text).not.toContain('cover.');
  });

  it('is acknowledged by its handle, under the door, and goes from the wall', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', rule({}));
    await h.poll();
    const [up] = await h.interrupts();
    if (up === undefined) throw new Error('nothing fired');

    expect((await h.ok(`${up.ruleId}:${up.key}`)).status).toBe(200);
    expect(h.acknowledged()).toEqual([DOOR]);
    expect(await h.interrupts()).toEqual([]);
  });

  it('refuses the entity id itself, and a handle that names nothing firing', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', rule({}));
    await h.poll();
    const [up] = await h.interrupts();
    if (up === undefined) throw new Error('nothing fired');

    // What an old bundle, or anything that is not a wall drawing its manifest, would send.
    expect((await h.ok(`${up.ruleId}:${DOOR}`)).status).toBe(404);
    // A well-formed handle for a signal this rule has not got.
    expect((await h.ok(`${up.ruleId}:${alertHandle(up.ruleId, 'binary_sensor.front_door')}`)).status).toBe(404);
    expect(h.acknowledged()).toEqual([]);
    expect(await h.interrupts()).toHaveLength(1);
  });

  it('acknowledges the thing: two rules on one door are one banner, and one OK keeps both away', async () => {
    const h = await harness();
    await h.form('/admin/home-assistant/rules', rule({}));
    await h.form('/admin/home-assistant/rules', rule({ name: 'Back door', action: 'banner' }));
    await h.poll();
    const firing = await h.interrupts();
    expect(firing).toHaveLength(1);
    const [up] = firing;
    if (up === undefined) throw new Error('nothing fired');

    expect((await h.ok(`${up.ruleId}:${up.key}`)).status).toBe(200);
    expect(h.acknowledged()).toEqual([DOOR]);
    // The other rule is not promoted into the gap the OK left.
    expect(await h.interrupts()).toEqual([]);
  });
});

describe('alert handles', () => {
  const base = {
    action: 'banner',
    title: 't',
    severity: 'Moderate',
    urgency: 'Unknown',
    dismissible: true,
    wakeScreen: false,
    piercesNightMode: false,
    priority: 0,
  } as const;
  const ha = { ...base, ruleId: 'r1', key: DOOR, source: 'homeassistant' } as CoreInterrupt;
  const nws = { ...base, ruleId: 'r2', key: 'urn:oid:2.49.0.1.840.0.abc', source: 'nws' } as CoreInterrupt;

  it("swaps only Home Assistant's keys, and resolves a handle only for its own rule", () => {
    const [handled, weather] = withAlertHandles([ha, nws]);
    expect(handled?.key).toBe(alertHandle('r1', DOOR));
    expect(handled?.key).toMatch(HANDLE);
    // A weather warning's id names nothing in the house, and is left as it was.
    expect(weather).toBe(nws);

    expect(alertFor('r1', alertHandle('r1', DOOR), [ha, nws])).toBe(DOOR);
    expect(alertFor('r2', alertHandle('r1', DOOR), [ha, nws])).toBeUndefined();
    expect(alertFor('r2', alertHandle('r2', nws.key), [ha, nws])).toBeUndefined();
  });
});

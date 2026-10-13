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
import { deleteRule, readRules } from '../src/api/rules.js';
import { haModule } from '../src/modules/homeassistant/index.js';
import { TOKEN, closeFakeHomeAssistants, fakeHomeAssistant, type FakeHa } from './fake-home-assistant.js';

/**
 * An OK on a Home Assistant alert is about this time, not about the thing for
 * ever.
 *
 * Before this, an acknowledgement of a Home Assistant rule was never forgotten:
 * only the weather job pruned the record, and a door's signal is the same key
 * for as long as the door exists. So one OK on "the back door is open" meant
 * the wall never said so again — the door closed, was left open the next
 * evening, and the wall said nothing. The poll forgets an OK once no rule
 * matches what it acknowledged, and only after a read that worked.
 *
 * Against the real app, the real fetcher, a real poll of a stand-in Home
 * Assistant and a clock the test moves.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let n = 0;
const DOOR = 'binary_sensor.back_door';
const FREEZER = 'sensor.freezer_temperature';

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

interface Interrupt {
  readonly ruleId: string;
  readonly key: string;
  readonly title: string;
}

interface Harness {
  readonly db: SqliteDatabase;
  readonly ha: FakeHa;
  at: number;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly interrupts: () => Promise<Interrupt[]>;
  readonly ok: (interrupt: Interrupt) => Promise<Response>;
  readonly poll: () => Promise<void>;
  /** What Home Assistant says of an entity from now on, changed at the test's clock. */
  readonly set: (entityId: string, state: string) => void;
  readonly acknowledged: () => string[];
}

async function harness(): Promise<Harness> {
  n++;
  const ha = await fakeHomeAssistant();
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ha-ack-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(stamp, stamp);
  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const h = { at: stamp } as Harness;
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
    clientAddress: () => `10.64.${n}.1`,
    setupToken,
    dataDir,
    now: () => h.at,
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
    email: `ack${n}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  await form('/admin/home-assistant/connect', { base_url: ha.base, token: TOKEN, allow_lan: '1', accept_http: '1' });

  // A wall allowed to acknowledge, which is the only kind that may.
  const wall = issueDisplayToken();
  db.prepare(
    `INSERT INTO screens (id, name, token_hash, theme, token_issued_at, layout_mode, allow_dismiss, created_at, updated_at)
     VALUES ('kitchen', 'Kitchen', ?, 'panels', ?, 'freeform', 1, ?, ?)`,
  ).run(wall.tokenHash, stamp, stamp, stamp);

  const context = {
    db,
    fetcher,
    keyring,
    timezone: 'Europe/London',
    get now(): number {
      return h.at;
    },
  };
  const asWall = async (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${wall.token}` },
      }),
    );
  return Object.assign(h, {
    db,
    ha,
    form,
    interrupts: async () =>
      ((await (await asWall('/d/manifest')).json()) as { interrupts: Interrupt[] }).interrupts,
    ok: (interrupt: Interrupt) =>
      asWall('/d/interrupts/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ key: `${interrupt.ruleId}:${interrupt.key}` }).toString(),
      }),
    poll: () => (haModule.job as { run: (c: unknown) => Promise<void> }).run(context),
    set: (entityId: string, state: string) => {
      ha.others[entityId] = { state, lastChanged: new Date(h.at).toISOString(), name: entityId };
    },
    acknowledged: () =>
      (db.prepare('SELECT key FROM interrupt_dismissals ORDER BY key').all() as { key: string }[]).map((row) => row.key),
  });
}

const rule = (fields: Record<string, string>): Record<string, string> => ({
  name: 'Tell me',
  value: '',
  action: 'banner',
  hold_sec: '',
  ...fields,
});

/** A door rule, the door open, the banner up and acknowledged. */
async function acknowledgedDoor(extra: Record<string, string> = {}): Promise<Harness> {
  const h = await harness();
  h.set(DOOR, 'on');
  expect(
    (await h.form('/admin/home-assistant/rules', rule({ entity_id: DOOR, condition: 'equals', value: 'on', ...extra })))
      .status,
  ).toBe(302);
  await h.poll();
  const [up] = await h.interrupts();
  expect(up?.key).toBe(DOOR);
  if (up === undefined) throw new Error('nothing fired');
  expect((await h.ok(up)).status).toBe(200);
  expect(await h.interrupts()).toEqual([]);
  expect(h.acknowledged()).toEqual([DOOR]);
  return h;
}

describe('an OK on a Home Assistant alert', () => {
  it('lasts while the door stays open, and the next opening covers the wall again', async () => {
    const h = await acknowledgedDoor();

    // Still open, an hour on: still acknowledged.
    h.at += 3_600_000;
    await h.poll();
    expect(await h.interrupts()).toEqual([]);
    expect(h.acknowledged()).toEqual([DOOR]);

    // Closed: the OK has nothing left to be about.
    h.at += 60_000;
    h.set(DOOR, 'off');
    await h.poll();
    expect(h.acknowledged()).toEqual([]);
    expect(await h.interrupts()).toEqual([]);

    // Left open again the next evening: the wall says so.
    h.at += 20 * 3_600_000;
    h.set(DOOR, 'on');
    await h.poll();
    const again = await h.interrupts();
    expect(again).toHaveLength(1);
    expect(again[0]?.key).toBe(DOOR);
  });

  it('is kept when Home Assistant cannot be read, whatever the door has done', async () => {
    const h = await acknowledgedDoor();
    h.set(DOOR, 'off');
    h.ha.down = true;
    h.at += 60_000;
    await h.poll();
    // A house that cannot be read has not closed its door.
    expect(h.acknowledged()).toEqual([DOOR]);
  });

  it('is kept while the door is unavailable, so a Home Assistant restart does not bring it back', async () => {
    const h = await acknowledgedDoor();
    h.at += 60_000;
    h.set(DOOR, 'unavailable');
    await h.poll();
    expect(h.acknowledged()).toEqual([DOOR]);
    h.at += 60_000;
    h.set(DOOR, 'on');
    await h.poll();
    expect(await h.interrupts()).toEqual([]);
  });

  it('is about the door rather than the rule’s hours', async () => {
    // Acknowledged at 23:30 under a 23:00–06:00 rule, and left open into the
    // day: the same open door when the rule's hours come round again.
    const h = await harness();
    const night = Date.UTC(2026, 0, 15, 23, 30);
    h.at = night;
    h.set(DOOR, 'on');
    expect(
      (
        await h.form(
          '/admin/home-assistant/rules',
          rule({ entity_id: DOOR, condition: 'equals', value: 'on', from_time: '23:00', to_time: '06:00' }),
        )
      ).status,
    ).toBe(302);
    await h.poll();
    const [up] = await h.interrupts();
    if (up === undefined) throw new Error('nothing fired');
    await h.ok(up);
    h.at = night + 12 * 3_600_000;
    await h.poll();
    expect(h.acknowledged()).toEqual([DOOR]);
    h.at = night + 24 * 3_600_000;
    await h.poll();
    expect(await h.interrupts()).toEqual([]);
  });

  it('on a reading over a line, lasts while it stays over and is forgotten when it comes back under', async () => {
    const h = await harness();
    h.set(FREEZER, '-8');
    expect(
      (await h.form('/admin/home-assistant/rules', rule({ entity_id: FREEZER, condition: 'above', value: '-10' }))).status,
    ).toBe(302);
    await h.poll();
    const [up] = await h.interrupts();
    if (up === undefined) throw new Error('nothing fired');
    await h.ok(up);

    // Warmer still is the same thing, not a new one — a reading that changes
    // every poll must not bring its banner back every poll.
    h.at += 60_000;
    h.set(FREEZER, '-6');
    await h.poll();
    expect(await h.interrupts()).toEqual([]);
    expect(h.acknowledged()).toEqual([FREEZER]);

    h.at += 60_000;
    h.set(FREEZER, '-18');
    await h.poll();
    expect(h.acknowledged()).toEqual([]);

    h.at += 3_600_000;
    h.set(FREEZER, '-7');
    await h.poll();
    expect(await h.interrupts()).toHaveLength(1);
  });

  it('is forgotten when its rule is deleted, and leaves a weather OK alone', async () => {
    const h = await acknowledgedDoor();
    h.db
      .prepare(`INSERT INTO interrupt_dismissals (key, source, dismissed_at) VALUES ('urn:oid:storm', 'nws', ?)`)
      .run(h.at);
    for (const one of readRules(h.db)) if (one.source === 'homeassistant') deleteRule(h.db, one.id);
    h.at += 60_000;
    await h.poll();
    expect(h.acknowledged()).toEqual(['urn:oid:storm']);
  });
});

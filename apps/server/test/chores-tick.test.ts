import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addDays } from '@maverick-wall/core';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { completionDates, createChore, localToday, setChoreDone } from '../src/api/chores.js';

/**
 * Ticking a chore off from a wall (RFC 008 phase 3).
 *
 * The first time anything on a wall writes household data other than an
 * acknowledgement, so most of this is about what the endpoint refuses to take
 * from the caller. The display token lives on the wall where anybody in the
 * house — or on the network — can reach it, which is the whole reason the
 * server decides the day, the due-ness, and the permission rather than
 * believing the button.
 *
 * `TZ=Pacific/Chatham` (UTC+12:45) against a household in Europe/London, again
 * deliberately: every date here is the household's and would be a day out if
 * anything reached for the process clock.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;
const HOUSEHOLD_TZ = 'Europe/London';

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-tick-'));
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
    auth: { secret: 'd'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.11.0.${++nextAddress}`,
    setupToken,
    dataDir,
  });

  const jar = new Map<string, string>();
  const call = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = new Headers(init.headers);
    if (cookie !== '') headers.set('cookie', cookie);
    const response = await app.fetch(new Request(url, { ...init, headers }));
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, ...rest] = (pair ?? '').split('=');
      if (name !== undefined && name !== '') jar.set(name, rest.join('='));
    }
    return response;
  };
  const post = (url: string, fields: Record<string, string>) =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `tick${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: HOUSEHOLD_TZ });

  const html = await (await post('http://localhost:8080/admin/screens', { name: 'Kitchen' })).text();
  const token = /\/pair\?token=([^<\s"]+)/.exec(html)?.[1];
  if (token === undefined) throw new Error('no pairing token in the admin page');
  const screenId = (db.prepare('SELECT id FROM screens LIMIT 1').get() as { id: string }).id;

  /** Let this screen tick, the way the Displays settings switch does. */
  const allowTicking = (on = true): void => {
    db.prepare('UPDATE screens SET allow_chores = ? WHERE id = ?').run(on ? 1 : 0, screenId);
  };

  const tick = (fields: Record<string, string>, bearer = token): Promise<Response> =>
    call('http://localhost:8080/d/chores/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  const manifest = async (): Promise<{ screen: { allowChores?: boolean } }> =>
    (await (
      await call('http://localhost:8080/d/manifest', { headers: { authorization: `Bearer ${token}` } })
    ).json()) as never;

  return { db, call, post, token, screenId, allowTicking, tick, manifest };
}

const daily = { personId: null, schedule: { kind: 'daily' } as const, dueTime: null };

describe('the per-screen gate', () => {
  it('is off by default, so a new screen ticks nothing', async () => {
    /*
     * Off by default because it is a fact about the hardware: a panel behind
     * glass has nothing to press it with, and a screen a coat sleeve brushes
     * would mark the bins done on the way past. A household turns it on for the
     * tablet they meant to reach.
     */
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    const response = await h.tick({ id });
    expect(response.status).toBe(403);
    expect([...completionDates(h.db, id, '2000-01-01', '2100-01-01')]).toEqual([]);
  });

  it('records the completion once the household turns it on', async () => {
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();
    const response = await h.tick({ id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, date: localToday(HOUSEHOLD_TZ), done: true });
    expect([...completionDates(h.db, id, '2000-01-01', '2100-01-01')]).toEqual([
      localToday(HOUSEHOLD_TZ),
    ]);
  });

  it('needs a paired screen at all, not merely the flag', async () => {
    // `/d/*` is behind the display token; this only proves the chore endpoint
    // did not somehow land outside that gate.
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();
    const response = await h.tick({ id }, 'not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('travels in the manifest, so the wall knows whether to draw a box', async () => {
    const h = await harness();
    createChore(h.db, { ...daily, name: 'Bins' });
    expect((await h.manifest()).screen.allowChores).toBe(false);
    h.allowTicking();
    expect((await h.manifest()).screen.allowChores).toBe(true);
  });
});

describe('what the endpoint refuses to take from the wall', () => {
  it('decides the day itself, and ignores one the client sends', async () => {
    /*
     * The sharpest of the three. A wall tablet's clock drifts and plenty never
     * get NTP at all, so a screen that decided the date would tick yesterday's
     * bins on a device an hour behind — and the whole chore model hangs on the
     * day being the household's civil date. The client is not asked, and a
     * client that answers anyway is not listened to.
     */
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();

    const yesterday = addDays(localToday(HOUSEHOLD_TZ), -1);
    const response = await h.tick({ id, date: yesterday });
    expect(response.status).toBe(200);

    const recorded = [...completionDates(h.db, id, '2000-01-01', '2100-01-01')];
    expect(recorded).toEqual([localToday(HOUSEHOLD_TZ)]);
    expect(recorded).not.toContain(yesterday);
  });

  it('refuses a chore that is not due today rather than storing a row nothing shows', async () => {
    const h = await harness();
    // Anchored well past the seven-day board, so it is due on no day the wall
    // could be drawing.
    const id = createChore(h.db, {
      name: 'Smoke alarms',
      personId: null,
      schedule: { kind: 'once', date: '2099-01-04' },
      dueTime: null,
    });
    h.allowTicking();
    const response = await h.tick({ id });
    expect(response.status).toBe(409);
    expect([...completionDates(h.db, id, '2000-01-01', '2100-01-01')]).toEqual([]);
  });

  it('refuses a chore that does not exist, and one with no id at all', async () => {
    const h = await harness();
    h.allowTicking();
    expect((await h.tick({ id: 'deadbeefdeadbeef' })).status).toBe(404);
    expect((await h.tick({ id: '' })).status).toBe(400);
    expect((await h.tick({ id: 'x'.repeat(200) })).status).toBe(400);
  });
});

describe('the tick itself', () => {
  it('is idempotent, so a flaky network and two screens cost one row', async () => {
    /*
     * The property the unique index exists for, proven here through the real
     * endpoint rather than at the query layer: it is what lets the wall post and
     * forget, with no queue and no client-side reconciliation.
     */
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();
    await Promise.all([h.tick({ id }), h.tick({ id }), h.tick({ id })]);
    const count = h.db
      .prepare('SELECT COUNT(*) AS n FROM chore_completions WHERE chore_id = ?')
      .get(id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('un-ticks, because somebody presses the wrong row', async () => {
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();
    await h.tick({ id });
    const response = await h.tick({ id, done: '0' });
    expect(response.status).toBe(200);
    expect([...completionDates(h.db, id, '2000-01-01', '2100-01-01')]).toEqual([]);
  });

  it('shows up in the very next manifest, and moves its ETag', async () => {
    // What makes the press feel like a button: the wall re-polls at once, and
    // the document it gets back has to differ or it is handed a 304.
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();

    const etagOf = async (): Promise<string> =>
      (
        await h.call('http://localhost:8080/d/manifest', {
          headers: { authorization: `Bearer ${h.token}` },
        })
      ).headers.get('etag') ?? '';
    const before = await etagOf();

    await h.tick({ id });

    const after = (await (
      await h.call('http://localhost:8080/d/manifest', {
        headers: { authorization: `Bearer ${h.token}` },
      })
    ).json()) as { panels: { chores: { days: { items: { done: boolean }[] }[] } } };
    expect(after.panels.chores.days[0]?.items[0]?.done).toBe(true);
    expect(await etagOf()).not.toBe(before);
  });

  it('is household-wide: one screen ticks and every screen goes quiet', async () => {
    /*
     * The same call `/d/interrupts/dismiss` made, for the same reason. A kitchen
     * tablet and a hall television must never disagree about whether the bins
     * went out — so the record is keyed on the chore and the day, and not on
     * the screen that pressed it.
     */
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    h.allowTicking();

    const second = await (await h.post('http://localhost:8080/admin/screens', { name: 'Hall' })).text();
    const other = /\/pair\?token=([^<\s"]+)/.exec(second)?.[1];
    expect(other).toBeDefined();

    await h.tick({ id });

    const seen = (await (
      await h.call('http://localhost:8080/d/manifest', {
        headers: { authorization: `Bearer ${other}` },
      })
    ).json()) as { panels: { chores: { days: { items: { done: boolean }[] }[] } } };
    expect(seen.panels.chores.days[0]?.items[0]?.done).toBe(true);
  });

  it('leaves yesterday alone when a chore is ticked today', async () => {
    const h = await harness();
    const id = createChore(h.db, { ...daily, name: 'Bins' });
    const yesterday = addDays(localToday(HOUSEHOLD_TZ), -1);
    setChoreDone(h.db, id, yesterday, true);
    h.allowTicking();
    await h.tick({ id, done: '0' });

    // The un-tick cleared today, which was never set, and did not reach back.
    expect([...completionDates(h.db, id, '2000-01-01', '2100-01-01')]).toEqual([yesterday]);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addDays } from '@maverick-wall/core';

import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import {
  completionDates,
  createChore,
  deleteChore,
  localToday,
  moveChore,
  readChores,
  setChoreDone,
  updateChore,
} from '../src/api/chores.js';

/**
 * Chores, RFC 008 phase 1 — the model in storage and the screen that defines it.
 *
 * Two halves, and the interesting assertions are in the first. A chore is a
 * definition plus a set of civil dates it was done on, and almost everything
 * that can go wrong is about those two being confused: a completion stored as a
 * timestamp, a schedule column that will not parse turning into "every day", a
 * double press recording twice.
 *
 * A temp SQLite file and the real app throughout, never a stub — the migration
 * is part of what is under test, and the unique index it creates is the whole
 * reason the tick needs no client-side care.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function database(): SqliteDatabase {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-chores-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  return db;
}

const BINS = {
  name: 'Put the bins out',
  personId: null,
  schedule: { kind: 'weekdays', days: [2] } as const,
  dueTime: null,
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('a chore in storage', () => {
  it('round-trips its schedule through the JSON column', () => {
    const db = database();
    createChore(db, { ...BINS, dueTime: '19:00' });
    const chore = readChores(db)[0]!;
    expect(chore.name).toBe('Put the bins out');
    expect(chore.schedule).toEqual({ kind: 'weekdays', days: [2] });
    expect(chore.dueTime).toBe('19:00');
    expect(chore.personId).toBeNull();
  });

  it('carries the person’s own colour, which is what the wall already draws', () => {
    const db = database();
    const at = Date.now();
    db.prepare(
      `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
       VALUES ('p1', 'Ella', '#4C7FD1', 0, 0, ?, ?)`,
    ).run(at, at);
    createChore(db, { ...BINS, personId: 'p1' });
    const chore = readChores(db)[0]!;
    expect(chore.personName).toBe('Ella');
    expect(chore.personColor).toBe('#4C7FD1');
  });

  it('un-assigns a chore when its person is removed, rather than deleting it', () => {
    // `set null`, not cascade. Removing somebody from the household must not
    // silently take the bins with them — an unassigned chore is a state both
    // the admin and the wall already have to draw.
    const db = database();
    const at = Date.now();
    db.prepare(
      `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
       VALUES ('p1', 'Ella', '#4C7FD1', 0, 0, ?, ?)`,
    ).run(at, at);
    createChore(db, { ...BINS, personId: 'p1' });
    db.prepare('PRAGMA foreign_keys = ON').run();
    db.prepare('DELETE FROM people WHERE id = ?').run('p1');

    const chore = readChores(db)[0];
    expect(chore).toBeDefined();
    expect(chore?.personId).toBeNull();
    expect(chore?.personName).toBeNull();
  });

  it('reads an unreadable schedule as never-due, not as daily', () => {
    /*
     * The one defensive read that matters. A schedule column written by a
     * newer image and read by a rolled-back one is a genuine boundary, and the
     * wrong fallback is the loud one: a chore whose schedule cannot be read
     * must not start appearing on the wall every single day. Never-due is the
     * quiet failure, and the admin draws it as "No schedule" where somebody
     * can see it.
     */
    const db = database();
    const id = createChore(db, BINS);
    db.prepare('UPDATE chores SET schedule = ? WHERE id = ?').run('{"kind":"lunar"}', id);
    expect(readChores(db)[0]!.schedule).toEqual({ kind: 'weekdays', days: [] });

    db.prepare('UPDATE chores SET schedule = ? WHERE id = ?').run('not json at all', id);
    expect(readChores(db)[0]!.schedule).toEqual({ kind: 'weekdays', days: [] });
  });

  it('updates the schedule kind in place', () => {
    const db = database();
    const id = createChore(db, BINS);
    updateChore(db, id, {
      name: 'Hoover',
      personId: null,
      schedule: { kind: 'everyNDays', n: 3, from: '2026-08-25' },
      dueTime: null,
    });
    const chore = readChores(db)[0]!;
    expect(chore.name).toBe('Hoover');
    expect(chore.schedule).toEqual({ kind: 'everyNDays', n: 3, from: '2026-08-25' });
  });

  it('reorders, including when two rows share a sort order', () => {
    const db = database();
    createChore(db, { ...BINS, name: 'Alpha' });
    createChore(db, { ...BINS, name: 'Beta' });
    // Rows that tie on sort_order — the shape a list created before it had an
    // order arrives in. Swapping equal values is a no-op, which reads on the
    // screen as a button that does nothing.
    db.prepare('UPDATE chores SET sort_order = 0').run();
    const beta = readChores(db).find((chore) => chore.name === 'Beta')!;
    moveChore(db, beta.id, 'up');
    expect(readChores(db).map((chore) => chore.name)).toEqual(['Beta', 'Alpha']);
  });
});

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

describe('recording a chore as done', () => {
  it('is idempotent, so nothing pressing the button has to be careful', () => {
    /*
     * The property the unique index exists for. Two screens pressed at once, or
     * one wall retrying on a flaky network, record one completion between them
     * — which is what lets RFC 008 phase 3 post a tick with no queue and no
     * reconciliation on the client.
     */
    const db = database();
    const id = createChore(db, BINS);
    setChoreDone(db, id, '2026-08-25', true);
    setChoreDone(db, id, '2026-08-25', true);
    setChoreDone(db, id, '2026-08-25', true);

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM chore_completions WHERE chore_id = ?')
      .get(id) as { n: number };
    expect(count.n).toBe(1);
    expect([...completionDates(db, id, '2026-08-01', '2026-08-31')]).toEqual(['2026-08-25']);
  });

  it('keeps the first press’s time when a later one repeats it', () => {
    // `ON CONFLICT DO NOTHING`, so the record says when it was actually done
    // rather than when somebody last brushed the screen.
    const db = database();
    const id = createChore(db, BINS);
    setChoreDone(db, id, '2026-08-25', true, 1_000);
    setChoreDone(db, id, '2026-08-25', true, 9_000);
    const row = db
      .prepare('SELECT completed_at AS at FROM chore_completions WHERE chore_id = ?')
      .get(id) as { at: number };
    expect(row.at).toBe(1_000);
  });

  it('clears one day without touching the others', () => {
    const db = database();
    const id = createChore(db, BINS);
    setChoreDone(db, id, '2026-08-25', true);
    setChoreDone(db, id, '2026-09-01', true);
    setChoreDone(db, id, '2026-08-25', false);
    expect([...completionDates(db, id, '2026-08-01', '2026-09-30')]).toEqual(['2026-09-01']);
  });

  it('stores the day it counts for, not the moment it was pressed', () => {
    /*
     * The `DTEND`-exclusive bug wearing a different hat, and the reason
     * `chore_completions` is keyed on a civil date.
     *
     * 23:50 on 25 August in Europe/London is 22:50 UTC — the same day. Ten
     * minutes later it is 26 August in London and *still* 25 August in UTC. A
     * completion derived from the instant would put the second tick on the
     * wrong day for a whole hour every night, and it would present as a chore
     * that un-ticks itself in the evening.
     */
    const db = database();
    const id = createChore(db, BINS);

    const lateOn25th = Date.parse('2026-08-25T22:50:00Z');
    const justAfterMidnight = Date.parse('2026-08-25T23:10:00Z');

    expect(localToday('Europe/London', lateOn25th)).toBe('2026-08-25');
    // The half that a UTC-derived day gets wrong.
    expect(localToday('Europe/London', justAfterMidnight)).toBe('2026-08-26');
    expect(localToday('UTC', justAfterMidnight)).toBe('2026-08-25');

    setChoreDone(db, id, localToday('Europe/London', lateOn25th), true, lateOn25th);
    setChoreDone(db, id, localToday('Europe/London', justAfterMidnight), true, justAfterMidnight);
    expect([...completionDates(db, id, '2026-08-01', '2026-08-31')].sort()).toEqual([
      '2026-08-25',
      '2026-08-26',
    ]);
  });

  it('falls back to UTC for a zone Intl does not know, rather than throwing', () => {
    // `timezone` is a column somebody typed into the wizard. `Intl` throws on a
    // zone it does not recognise, which would take out the page rather than the
    // setting.
    expect(localToday('Mars/Olympus_Mons', Date.parse('2026-08-25T12:00:00Z'))).toBe('2026-08-25');
  });

  it('takes its history with it when the chore is removed', () => {
    const db = database();
    const id = createChore(db, BINS);
    setChoreDone(db, id, '2026-08-25', true);
    deleteChore(db, id);
    expect(readChores(db)).toHaveLength(0);
    const left = db.prepare('SELECT COUNT(*) AS n FROM chore_completions').get() as { n: number };
    expect(left.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

async function harness() {
  const address = `10.7.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-chores-admin-'));
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
    fetcher: createFetcher(),
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

  return { db, call, form, jar };
}

describe('the chores screen', () => {
  it('is behind the session gate', async () => {
    const h = await harness();
    h.jar.clear();
    const response = await h.call('/admin/chores');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in');
  });

  it('says so plainly when there are none', async () => {
    const h = await harness();
    expect(await (await h.call('/admin/chores')).text()).toContain('No chores yet');
  });

  it('is in the sidebar, next to the Work Schedule', async () => {
    const h = await harness();
    const body = await (await h.call('/admin')).text();
    expect(body).toContain('href="admin/chores"');
    // An icon key with no path renders as an empty <svg>, silently. The nav
    // entry would still work and would look broken, which is the kind of thing
    // nothing else here would catch.
    const nav = body.slice(body.indexOf('href="admin/chores"'));
    expect(nav.slice(0, 400)).toContain('<path d="M138 -684');
  });

  it('adds a chore and shows it with the schedule spelled out', async () => {
    const h = await harness();
    const response = await h.form('/admin/chores', {
      name: 'Put the bins out',
      person_id: '',
      kind: 'weekdays',
      day_2: '1',
      due_time: '19:00',
    });
    expect(response.status).toBe(302);

    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Put the bins out');
    expect(body).toContain('Every Tuesday');
    expect(body).toContain('by 19:00');
    expect(body).toContain('Anyone in the house');
  });

  it('shows the next few days it falls due', async () => {
    /*
     * The readout this screen exists for. "Every 3 days" is easy to read and
     * agree with; "every 3 days *starting the 14th of next month*" reads
     * identically and puts nothing on a wall for a fortnight. Real dates is
     * where that shows — so this asserts the dates, not that the word "Next"
     * appears.
     */
    const h = await harness();
    await h.form('/admin/chores', {
      name: 'Hoover',
      person_id: '',
      kind: 'everyNDays',
      every_n: '3',
      // Inside the preview window and not today, so the dates are the assertion
      // rather than the word "today" three times.
      every_from: addDays(localToday('Europe/London'), 10),
    });
    const start = addDays(localToday('Europe/London'), 10);
    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Every 3 days');
    expect(body).toContain(start);
    expect(body).toContain(addDays(start, 3));
    expect(body).toContain(addDays(start, 6));
  });

  it('says how far it looked, rather than claiming a chore is never due again', async () => {
    /*
     * Found by a test that happened to use a date beyond the preview window:
     * the card read "Not due again" for a chore starting in 2099, which is the
     * one sentence on this screen a household would act on. An empty window is
     * a fact about the window; only a one-off already past is genuinely over.
     */
    const h = await harness();
    await h.form('/admin/chores', {
      name: 'Replace the smoke alarms',
      person_id: '',
      kind: 'everyNDays',
      every_n: '3',
      every_from: '2099-01-04',
    });
    await h.form('/admin/chores', {
      name: 'Cancel the gym',
      person_id: '',
      kind: 'once',
      once_date: '2020-01-01',
    });
    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Nothing due in the next 400 days');
    expect(body).toContain('Not due again');
  });

  it('assigns a chore to a person and shows their name', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Ella', color: '#4C7FD1' });
    const person = (
      h.db.prepare('SELECT id FROM people WHERE name = ?').get('Ella') as { id: string }
    ).id;
    await h.form('/admin/chores', {
      name: 'Feed the cat',
      person_id: person,
      kind: 'daily',
    });
    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Feed the cat');
    expect(body).toContain('Every day');
    expect(body).toContain('Ella');
    expect(body).toContain('#4C7FD1');
  });

  it('refuses a weekly chore with no day ticked', async () => {
    // A chore that is never due is something somebody can save by accident and
    // can never see the effect of. The form refuses it rather than storing a
    // chore that silently does nothing.
    const h = await harness();
    const response = await h.form('/admin/chores', {
      name: 'Nothing ever',
      person_id: '',
      kind: 'weekdays',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Tick at least one day of the week');
    expect(readChores(h.db)).toHaveLength(0);
  });

  it('refuses every-N-days with no day to count from', async () => {
    const h = await harness();
    const response = await h.form('/admin/chores', {
      name: 'Hoover',
      person_id: '',
      kind: 'everyNDays',
      every_n: '3',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Choose the day it starts');
    expect(readChores(h.db)).toHaveLength(0);
  });

  it('refuses a day of the month past the 28th rather than clamping it', async () => {
    /*
     * Clamping 31 to "the last day" would make one chore behave differently in
     * February from every other month, with nothing on the form to say which
     * the household asked for. A control meaning "the last day" is a separate
     * choice, not a special value in this one.
     */
    const h = await harness();
    const response = await h.form('/admin/chores', {
      name: 'Rent',
      person_id: '',
      kind: 'monthlyDate',
      month_day: '31',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Pick a day from 1 to 28');
    expect(readChores(h.db)).toHaveLength(0);
  });

  it('edits a chore’s schedule, and the sentence follows', async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'weekdays', day_2: '1' });
    const id = readChores(h.db)[0]!.id;
    await h.form(`/admin/chores/${id}`, {
      name: 'Bins',
      person_id: '',
      kind: 'weekdays',
      day_2: '1',
      day_5: '1',
    });
    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Every Tuesday and Friday');
    expect(readChores(h.db)).toHaveLength(1);
  });

  it('removes a chore', async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;
    const response = await h.form(`/admin/chores/${id}/delete`, {});
    expect(response.status).toBe(302);
    expect(readChores(h.db)).toHaveLength(0);
  });

  it('offers no way to tick a chore off, which is the point', async () => {
    /*
     * The design assertion, and it is worth pinning because it would be
     * "helpfully" added by anyone reading this screen as an ordinary CRUD page.
     * Completing a chore happens several times a day, by whoever is standing in
     * the kitchen; putting it behind the household login and a sidebar would
     * make the wall's one recurring interaction harder than the wall itself.
     * That half is RFC 008 phases 2 and 3, on the wall, behind the display token.
     */
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const body = await (await h.call('/admin/chores')).text();
    expect(body).not.toContain('/done');
    expect(body).not.toMatch(/name="done"/);
  });
});

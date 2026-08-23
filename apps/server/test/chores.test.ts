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
  activeOn,
  completionDates,
  createChore,
  deleteChore,
  localToday,
  moveChore,
  readChores,
  recentRecord,
  setChoreDone,
  setChorePaused,
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

  it('pauses a chore from the card, and says so instead of listing dates', async () => {
    /*
     * A paused chore has no "next": it will not appear on a wall whatever its
     * schedule says, and listing dates it will be absent on is the "Not due
     * again" fault in the other direction — a true-sounding sentence about
     * something that is not going to happen.
     */
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;

    const paused = await h.form(`/admin/chores/${id}/pause`, {});
    expect(paused.status).toBe(302);
    expect(readChores(h.db)[0]?.paused).toBe(true);

    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Paused');
    expect(body).toContain('not shown on any wall');
    expect(body).not.toContain('Next:');
    expect(body).toContain('Resume');
  });

  it('says nothing about how a paused chore is going', async () => {
    /*
     * Its occurrences while paused are days it was on no wall and nobody could
     * have done it, so a record would read "Done 0 of the last 7" — the
     * new-chore fault again, an accusation for something the household chose.
     */
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;
    h.db.prepare('UPDATE chores SET created_at = ?').run(Date.parse('2020-01-01T00:00:00Z'));
    expect(await (await h.call('/admin/chores')).text()).toContain('Done 0 of the last 7 times');

    await h.form(`/admin/chores/${id}/pause`, {});
    const body = await (await h.call('/admin/chores')).text();
    expect(body).toContain('Paused');
    expect(body).not.toContain('Done 0 of the last');
  });

  it('resumes it again from the same button', async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;
    await h.form(`/admin/chores/${id}/pause`, {});
    await h.form(`/admin/chores/${id}/pause`, { resume: '1' });
    expect(readChores(h.db)[0]?.paused).toBe(false);
    expect(await (await h.call('/admin/chores')).text()).toContain('Next:');
  });

  it('shows how a chore has been going, once it has come round', async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;
    const today = localToday('Europe/London');

    // A chore created a minute ago has no record and says so by saying nothing.
    expect(await (await h.call('/admin/chores')).text()).not.toContain('Done 0 of the last');

    // Once it has been around a while, the line is real.
    h.db.prepare('UPDATE chores SET created_at = ?').run(Date.parse('2020-01-01T00:00:00Z'));
    for (let back = 1; back <= 3; back++) setChoreDone(h.db, id, addDays(today, -back), true);
    expect(await (await h.call('/admin/chores')).text()).toContain('Done 3 of the last 7 times');
  });

  it('asks before removing a chore, and names what goes with it', async () => {
    /*
     * It did not ask in the earlier phases, and that was defensible then —
     * nothing could record a completion, so there was no history to destroy.
     * There is now, and there is a Pause beside it that keeps it, so a one-click
     * Remove would be the household silently choosing the destructive one of two
     * options they may not know are different.
     */
    const h = await harness();
    await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    const id = readChores(h.db)[0]!.id;
    h.db.prepare('UPDATE chores SET created_at = ?').run(Date.parse('2020-01-01T00:00:00Z'));
    setChoreDone(h.db, id, addDays(localToday('Europe/London'), -1), true);

    const ask = await h.call(`/admin/chores/${id}/delete`);
    expect(ask.status).toBe(200);
    const body = await ask.text();
    expect(body).toContain('cannot be undone');
    expect(body).toContain('pause it instead');
    expect(body).toContain('It was done 1 of the last 7 times');
    // Asking changed nothing.
    expect(readChores(h.db)).toHaveLength(1);

    expect((await h.form(`/admin/chores/${id}/delete`, {})).status).toBe(302);
    expect(readChores(h.db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pausing, and the record
// ---------------------------------------------------------------------------

describe('pausing a chore', () => {
  it('keeps every completion, which is the whole difference from removing it', () => {
    const db = database();
    const id = createChore(db, BINS);
    setChoreDone(db, id, '2026-08-25', true);
    setChorePaused(db, id, true);

    expect(readChores(db)[0]?.paused).toBe(true);
    expect([...completionDates(db, id, '2026-08-01', '2026-08-31')]).toEqual(['2026-08-25']);

    setChorePaused(db, id, false);
    expect(readChores(db)[0]?.paused).toBe(false);
    expect([...completionDates(db, id, '2026-08-01', '2026-08-31')]).toEqual(['2026-08-25']);
  });

  it('takes it off every wall without touching its schedule', () => {
    // One rule, `activeOn`, shared by the board the wall draws and the endpoint
    // that records a tick — so a paused chore cannot be drawn *or* ticked, and
    // the two can never disagree about which.
    const db = database();
    const id = createChore(db, BINS);
    const chore = () => readChores(db)[0]!;
    expect(activeOn(chore(), '2026-08-25')).toBe(true); // a Tuesday

    setChorePaused(db, id, true);
    expect(activeOn(chore(), '2026-08-25')).toBe(false);
    // The schedule is untouched: it still says Tuesdays, and resuming proves it.
    expect(chore().schedule).toEqual({ kind: 'weekdays', days: [2] });
    setChorePaused(db, id, false);
    expect(activeOn(chore(), '2026-08-25')).toBe(true);
  });
});

/**
 * The chore, as if it had been in the household a while.
 *
 * A record must not count days before the chore existed, so every fixture below
 * — whose occurrences are historical dates — needs a chore that is older than
 * they are. Back-dating the row is what a real household's would be; the test
 * that a *new* chore reports nothing is separate, and deliberate.
 */
function aged(db: SqliteDatabase) {
  db.prepare('UPDATE chores SET created_at = ?').run(Date.parse('2020-01-01T00:00:00Z'));
  return readChores(db)[0]!;
}

describe('how a chore has been going', () => {
  /*
   * Counted over *occurrences*, not days: a weekly chore's denominator should
   * be weeks. "Done 6 of the last 7 Tuesdays" is the sentence a household says;
   * "6 of 8 in the last four weeks" is a different and worse one.
   */
  /** The seven Tuesdays before Tuesday 2026-08-25, newest last. */
  const tuesdays = [
    '2026-07-07', '2026-07-14', '2026-07-21', '2026-07-28',
    '2026-08-04', '2026-08-11', '2026-08-18',
  ] as const;
  const TODAY = '2026-08-25';

  it('counts the last few times it fell due, and names the weekday', () => {
    const db = database();
    const id = createChore(db, BINS); // Tuesdays
    // Six of the seven — one Tuesday missed, in the middle, so a bug that
    // counted a contiguous run would not pass.
    for (const date of tuesdays.filter((d) => d !== '2026-07-28')) {
      setChoreDone(db, id, date, true);
    }

    const record = recentRecord(db, aged(db), TODAY, 'Europe/London');
    expect(record).toEqual({ of: 7, done: 6, weekday: 'Tuesdays' });
  });

  it('excludes today, whether or not today has been done', () => {
    /*
     * The half that decides whether a household believes the line. Counting
     * today would have every chore reading one worse than it is from midnight
     * until somebody got to it — and ticking it would then bump a number that
     * is supposed to be about the past. Neither happens: the window ends
     * yesterday, so today moves nothing at all.
     */
    const db = database();
    const id = createChore(db, BINS);
    for (const date of tuesdays) setChoreDone(db, id, date, true);

    const before = recentRecord(db, aged(db), TODAY, 'Europe/London');
    expect(before).toEqual({ of: 7, done: 7, weekday: 'Tuesdays' });

    setChoreDone(db, id, TODAY, true);
    expect(recentRecord(db, aged(db), TODAY, 'Europe/London')).toEqual(before);
  });

  it('says "times" when no single weekday would be true', () => {
    const db = database();
    createChore(db, {
      ...BINS,
      schedule: { kind: 'weekdays', days: [1, 4] },
    });
    // "The last 7 Mondays and Thursdays" is not a thing anybody says.
    expect(recentRecord(db, aged(db), '2026-08-25', 'Europe/London')?.weekday).toBeUndefined();
  });

  it('caps at seven occurrences however far back they go', () => {
    const db = database();
    createChore(db, { ...BINS, schedule: { kind: 'daily' } });
    expect(recentRecord(db, aged(db), '2026-08-25', 'Europe/London')?.of).toBe(7);
  });

  it('says nothing about a chore created a minute ago', () => {
    /*
     * Without the clamp this read "Done 0 of the last 7 times" — seven failures
     * a household could not have committed, on the screen they had just used to
     * create it. The record is about a chore's own life, not about the calendar.
     */
    const db = database();
    createChore(db, { ...BINS, schedule: { kind: 'daily' } });
    const chore = readChores(db)[0]!;
    expect(recentRecord(db, chore, localToday('Europe/London'), 'Europe/London')).toBeUndefined();
  });

  it('has nothing to say about a chore that has never come round', () => {
    // "0 of 0" is not a record, it is a sentence with no content in it.
    const db = database();
    createChore(db, {
      ...BINS,
      schedule: { kind: 'once', date: '2099-01-04' },
    });
    expect(recentRecord(db, aged(db), '2026-08-25', 'Europe/London')).toBeUndefined();
  });
});

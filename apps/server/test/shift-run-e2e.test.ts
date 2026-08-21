import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';

/**
 * How far through a run of shifts today is, driven through the real app.
 *
 * This exists because the unit tests beside it were not enough. 0.40.0 moved
 * the calculation to the server and tested it with a *pattern* rota, which
 * resolves mathematically and needs no events. The household that reported the
 * bug has a *calendar-derived* rota, which matches on event titles — and the
 * manifest path read events for the display window only, one day of history.
 * So the fix shipped and the wall still read "Day 2 of 3".
 *
 * A test that hands `buildManifest` a fortnight of events cannot catch that:
 * the fault was in what the app *read*, not in what the builder did with it.
 * This one seeds a real database and asks the real endpoint.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const dayOffset = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-run-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const at = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`)
    .run(at, at);

  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db, appVersion: '0.1.0-test', bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.8.0.${++nextAddress}`,
    setupToken, dataDir,
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
    name: 'Household', email: `run${nextAddress}@home.local`,
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

describe('a calendar-derived run, through the real endpoint', () => {
  it('follows the run back past the display window', async () => {
    const h = await harness();
    const at = Date.now();

    // A work feed, and a fortnight of STRAIGHTS ending tomorrow — so today is
    // day 13 of 14, exactly the case that was reported.
    h.db.prepare(
      `INSERT INTO calendar_sources (id, name, url_encrypted, color, created_at, updated_at)
       VALUES ('work', 'Work', 'x', '#888', ?, ?)`,
    ).run(at, at);

    for (let n = -12; n <= 1; n++) {
      const date = dayOffset(n);
      h.db.prepare(
        `INSERT INTO calendar_events_cache
           (id, source_id, uid, title, starts_at, ends_at, all_day,
            start_local_date, end_local_date, source_tzid, synced_at)
         VALUES (?, 'work', ?, 'STRAIGHTS', ?, ?, 0, ?, ?, 'Europe/London', ?)`,
      ).run(`s${n}`, `s${n}`, Date.parse(`${date}T06:00:00Z`), Date.parse(`${date}T18:00:00Z`),
            date, date, at);
    }

    h.db.prepare(
      `INSERT INTO shift_types (id, key, label, short_code, color_token, is_working, sort_order, created_at, updated_at)
       VALUES ('t1', 'straights', 'Straights', 'S', '--s-straight', 1, 0, ?, ?)`,
    ).run(at, at);

    h.db.prepare(
      `INSERT INTO shift_plans
         (id, name, kind, effective_from, priority, calendar_source_id, matchers, consumes_events, created_at, updated_at)
       VALUES ('p1', 'work feed', 'calendar', '2000-01-01', 0, 'work', ?, 1, ?, ?)`,
    ).run(JSON.stringify([{ shiftTypeKey: 'straights', pattern: 'STRAIGHTS', mode: 'contains' }]), at, at);

    // A person to own the rota: the resolver loops over people, so with none
    // there is no rota at all however many plans exist.
    h.db.prepare(
      `INSERT INTO people (id, name, color, sort_order, has_shift_rotation, created_at, updated_at)
       VALUES ('p1', 'Daddy', '#E8A33D', 0, 1, ?, ?)`,
    ).run(at, at);

    h.db.prepare(`UPDATE household_settings SET shift_enabled = 1 WHERE id = 'singleton'`).run();

    const html = await (await h.post('http://192.168.1.10:8080/admin/screens', { name: 'Wall' })).text();
    const token = /\/pair\?token=([^<\s"&]+)/.exec(html)?.[1];
    expect(token).toBeDefined();

    const response = await h.call('http://192.168.1.10:8080/d/manifest', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as {
      days: { date: string; shifts: { run?: { position: number; total: number } }[] }[];
    };

    const today = dayOffset(0);
    const run = manifest.days.find((day) => day.date === today)?.shifts[0]?.run;
    // Before the fix this was { position: 2, total: 3 }: the resolver could see
    // one day of history, so it called yesterday the start of the run.
    expect(run).toEqual({ position: 13, total: 14 });
  });
});

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
import { ago } from '../src/http/admin.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { issueDisplayToken } from '../src/auth/tokens.js';

/**
 * The Calendars screen, driven through the real app with a real feed.
 *
 * The screen generates HTML from values a person typed and from a URL that is
 * a bearer credential, so two of these tests are about what must *not* appear
 * in the output. The rest walk add, sync and remove the way somebody with a
 * mouse would.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
const servers: Server[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * Dated relative to now, not pinned.
 *
 * `testFeed` previews *upcoming* events, so a fixture with a fixed date stops
 * previewing anything the moment that date passes — the test would then be
 * asserting against an empty panel and quietly proving nothing.
 */
function icsBody(): string {
  const stamp = (offsetDays: number): string => {
    const at = new Date(Date.now() + offsetDays * 86_400_000);
    return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Maverick Wall//test//EN',
    'BEGIN:VEVENT', 'UID:admin-1@example.com', 'DTSTAMP:20260101T000000Z',
    `DTSTART:${stamp(3)}`, `DTEND:${stamp(3)}`, 'SUMMARY:Dentist',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

const ICS = icsBody();

async function icsServer(body: string = ICS, contentType = 'text/calendar'): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  // A path that would be the credential on a real feed, so a test can assert
  // it never reaches the page.
  return `http://127.0.0.1:${port}/secret-token-abcdef/private-calendar.ics`;
}

async function harness() {
  const address = `10.5.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-admin-'));
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

  // Through the wizard, so the household arrives signed in exactly as it would.
  await call(`/setup?token=${setupToken.current().token}`);
  await form('/setup/account', {
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });

  const addFeed = async (name = 'Family', personId?: string): Promise<string> => {
    const url = await icsServer();
    const response = await form('/admin/calendars', {
      name, url, allow_loopback: '1', allow_http: '1',
      ...(personId !== undefined ? { person_id: personId } : {}),
    });
    expect(response.status).toBe(302);
    return url;
  };

  /** The document a paired screen actually polls, so settings are proven end to end. */
  const manifestFor = async (
    instance: { db: typeof db },
  ): Promise<{
    theme: { active: string; daytime?: string; daytimeStartsAt?: string };
    display?: { todayEvents: number; nextDays: number; horizonWeeks: number; blocks: string[] };
  }> => {
    const issued = issueDisplayToken();
    const stamp2 = Date.now();
    instance.db
      .prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
         VALUES (?, 'Wall', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(`screen-${stamp2}`, issued.tokenHash, stamp2, stamp2, stamp2);
    const response = await call('/d/manifest', {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    return (await response.json()) as never;
  };

  return { db, call, form, jar, addFeed, manifestFor };
}

describe('the calendars screen', () => {
  it('is behind the session gate', async () => {
    const h = await harness();
    h.jar.clear();
    const response = await h.call('/admin/calendars');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in');
  });

  it('says so plainly when there are no calendars', async () => {
    const h = await harness();
    const body = await (await h.call('/admin/calendars')).text();
    expect(body).toContain('No calendars yet');
  });

  it('tests a feed, stores it encrypted, and lists it', async () => {
    const h = await harness();
    await h.addFeed('Family');

    const body = await (await h.call('/admin/calendars')).text();
    expect(body).toContain('Family');
    expect(body).toContain('127.0.0.1');

    const source = h.db
      .prepare('SELECT url_encrypted FROM calendar_sources')
      .get() as { url_encrypted: string };
    expect(source.url_encrypted.startsWith('mw1.')).toBe(true);
  });

  it('never puts the feed path on the page', async () => {
    // The path is the credential. Only the host may be shown, and this screen
    // is the most likely place for that rule to be broken by accident.
    const h = await harness();
    const url = await h.addFeed();

    const body = await (await h.call('/admin/calendars')).text();
    expect(url).toContain('secret-token-abcdef');
    expect(body).not.toContain('secret-token-abcdef');
    // Not `basic.ics`: the form's own placeholder says that, and asserting on
    // it makes this fail for a reason that has nothing to do with a leak.
    expect(body).not.toContain('private-calendar.ics');
  });

  it('escapes a name that looks like markup', async () => {
    // Everything on this page was typed by somebody. The only person who can
    // reach it is the household, but a stored script tag firing on their own
    // admin screen is still a defect.
    const h = await harness();
    const url = await icsServer();
    await h.form('/admin/calendars', {
      name: '<script>alert(1)</script>',
      url, allow_loopback: '1', allow_http: '1',
    });

    const body = await (await h.call('/admin/calendars')).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('refuses a feed that is not a calendar and stores nothing', async () => {
    const h = await harness();
    const url = await icsServer('<!doctype html><h1>Not a calendar</h1>', 'text/html');

    const response = await h.form('/admin/calendars', {
      name: 'Wrong', url, allow_loopback: '1', allow_http: '1',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('.ics');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
  });

  it('keeps what was typed when the address is refused', async () => {
    const h = await harness();
    const url = await icsServer();
    // Loopback not ticked, so it is refused with a suggestion.
    const response = await h.form('/admin/calendars', { name: 'Family', url, allow_http: '1' });
    expect(response.status).toBe(400);

    const body = await response.text();
    expect(body).toContain('allow loopback');
    expect(body).toContain('value="Family"');
  });

  it('shows a failing feed with its error rather than hiding it', async () => {
    const h = await harness();
    await h.addFeed('Family');
    h.db.prepare(
      `UPDATE calendar_sources SET last_error = ?, consecutive_failures = 4`,
    ).run('connect ECONNREFUSED 127.0.0.1:9');

    const body = await (await h.call('/admin/calendars')).text();
    expect(body).toContain('ECONNREFUSED');
    expect(body).toContain('4 failures in a row');
  });
});

describe('sync now', () => {
  it('brings the next run forward', async () => {
    const h = await harness();
    await h.addFeed();
    const id = (h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string }).id;

    // Push it into the backoff a repeatedly-failing feed ends up in.
    h.db.prepare(
      `UPDATE job_state SET next_run_at = ?, consecutive_failures = 6 WHERE key = ?`,
    ).run(Date.now() + 900_000, `ics-sync:${id}`);

    const response = await h.form(`/admin/calendars/${id}/sync`, {});
    expect(response.status).toBe(302);

    const job = h.db
      .prepare('SELECT next_run_at, consecutive_failures FROM job_state WHERE key = ?')
      .get(`ics-sync:${id}`) as { next_run_at: number; consecutive_failures: number };
    expect(job.next_run_at).toBe(0);
    expect(job.consecutive_failures).toBe(0);
  });
});

describe('removing a calendar', () => {
  it('asks first', async () => {
    const h = await harness();
    await h.addFeed('Family');
    const id = (h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string }).id;

    const confirm = await h.call(`/admin/calendars/${id}/delete`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Remove');
    // Nothing gone yet.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 1 });
  });

  it('removes the source, its events and its scheduler row', async () => {
    const h = await harness();
    await h.addFeed('Family');
    const id = (h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string }).id;

    const stamp = Date.now();
    h.db.prepare(
      `INSERT INTO calendar_events_cache
         (id, source_id, uid, title, starts_at, ends_at, start_local_date,
          end_local_date, source_tzid, synced_at)
       VALUES ('e1', ?, 'uid-1', 'Dentist', ?, ?, '2026-07-15', '2026-07-15', 'UTC', ?)`,
    ).run(id, stamp, stamp + 3_600_000, stamp);

    const response = await h.form(`/admin/calendars/${id}/delete`, {});
    expect(response.status).toBe(302);

    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
    // Cascaded, which only works because foreign keys are on.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_events_cache').get()).toEqual({ n: 0 });
    // Not cascaded — the scheduler key is a string, not a reference. Left
    // behind it would fetch a source that no longer exists, forever.
    expect(
      h.db.prepare(`SELECT COUNT(*) AS n FROM job_state WHERE key = ?`).get(`ics-sync:${id}`),
    ).toEqual({ n: 0 });
  });

  it('shrugs at an id that is not there', async () => {
    const h = await harness();
    expect((await h.call('/admin/calendars/nope/delete')).status).toBe(302);
    expect((await h.form('/admin/calendars/nope/delete', {})).status).toBe(302);
  });
});

describe('signing out', () => {
  it('ends the session and the cookie stops working', async () => {
    const h = await harness();
    expect((await h.call('/admin')).status).toBe(200);

    const response = await h.form('/admin/sign-out', {});
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/sign-in');

    expect((await h.call('/admin')).status).toBe(302);
  });
});

describe('ago', () => {
  const at = 1_700_000_000_000;
  it('reads the way somebody asking "is this stale?" would want', () => {
    expect(ago(null, at)).toBe('never');
    expect(ago(at - 5_000, at)).toBe('just now');
    expect(ago(at - 60_000, at)).toBe('1 minute ago');
    expect(ago(at - 14 * 60_000, at)).toBe('14 minutes ago');
    expect(ago(at - 3 * 3_600_000, at)).toBe('3 hours ago');
    expect(ago(at - 5 * 86_400_000, at)).toBe('5 days ago');
  });

  it('does not read the future as a huge past', () => {
    // Clock skew between a container and a NAS is ordinary, and "-3 minutes
    // ago" would look like a bug in the sync rather than in the clock.
    expect(ago(at + 30_000, at)).toBe('just now');
  });
});

/**
 * The Display screen.
 *
 * These settings exist so somebody standing in the room can change what the
 * wall shows, which is the only place the right answer is knowable. The tests
 * that matter are the ones proving a value typed into a form actually reaches
 * the manifest a screen polls.
 */
describe('display settings', () => {
  it('is behind the session gate', async () => {
    const h = await harness();
    h.jar.clear();
    expect((await h.call('/admin/display')).status).toBe(302);
  });

  it('offers every theme this build can draw', async () => {
    // A theme in the dropdown that the wall then falls back on would be a
    // puzzle nobody could solve from the kitchen.
    const h = await harness();
    // The default appearance form lives on the Default display now, not the
    // retired global Display page.
    const body = await (await h.call('/admin/displays/default')).text();
    for (const theme of ['board', 'slate', 'almanac', 'glance']) {
      expect(body).toContain(`value="${theme}"`);
    }
  });

  it('saves a theme and a daylight schedule, and the manifest carries them', async () => {
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'glance',
      daytime_theme: 'almanac',
      daytime_starts_at: '06:30',
      daytime_ends_at: '20:15',
      today_events: '5',
      next_days: '4',
      horizon_weeks: '6',
    });
    expect(response.status).toBe(302);

    const manifest = await h.manifestFor(h);
    expect(manifest.theme.active).toBe('glance');
    expect(manifest.theme.daytime).toBe('almanac');
    expect(manifest.theme.daytimeStartsAt).toBe('06:30');
    expect(manifest.display).toEqual({
      todayEvents: 5, nextDays: 4, horizonWeeks: 6, blocks: ['now', 'next', 'horizon'],
    });
  });

  it('stores "the same theme all day" as no schedule at all', async () => {
    // A household with one theme should not have to reason about a time window
    // that does nothing.
    const h = await harness();
    await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
    });

    const manifest = await h.manifestFor(h);
    expect(manifest.theme.active).toBe('board');
    expect(manifest.theme.daytime).toBeUndefined();
  });

  it('refuses a theme it cannot draw', async () => {
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'kitchen-disco',
      daytime_theme: 'none', daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
    });
    expect(response.status).toBe(400);
    expect((await h.manifestFor(h)).theme.active).toBe('board');
  });

  it('refuses a daylight window of no length, and says why', async () => {
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'almanac',
      daytime_starts_at: '07:00', daytime_ends_at: '07:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('never switch');
  });

  it('refuses amounts the layout cannot hold', async () => {
    const h = await harness();
    for (const bad of [
      { today_events: '0' },
      { today_events: '500' },
      { horizon_weeks: '0' },
      { next_days: '99' },
      { next_days: 'lots' },
    ]) {
      const response = await h.form('/admin/display', {
        theme: 'board', daytime_theme: 'none',
        daytime_starts_at: '07:00', daytime_ends_at: '21:00',
        today_events: '8', next_days: '6', horizon_weeks: '5',
        ...bad,
      });
      expect(response.status).toBe(400);
    }
    // Nothing was written by any of them.
    expect((await h.manifestFor(h)).display).toEqual({
      todayEvents: 8, nextDays: 6, horizonWeeks: 5, blocks: ['now', 'next', 'horizon'],
    });
  });

  it('accepts zero days ahead, which hides that block entirely', async () => {
    // Distinct from an invalid amount: a household that does not want the week
    // ahead is making a choice, not a mistake.
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '0', horizon_weeks: '5',
    });
    expect(response.status).toBe(302);
    expect((await h.manifestFor(h)).display?.nextDays).toBe(0);
  });
});

/**
 * The Screens page.
 *
 * Orientation and rotation are per screen rather than per household, because a
 * tablet in the kitchen and a television in the hall are mounted differently
 * and one of them is probably on its side.
 */
describe('screens', () => {
  const pair = (db: ReturnType<typeof openDatabase>['db'], name: string) => {
    const issued = issueDisplayToken();
    const stamp = Date.now();
    const id = `screen-${name}-${stamp}`;
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, issued.tokenHash, stamp, stamp, stamp);
    return { id, token: issued.token };
  };

  it('lists paired screens behind the session gate', async () => {
    const h = await harness();
    pair(h.db, 'Kitchen');
    expect(await (await h.call('/admin/displays')).text()).toContain('Kitchen');

    h.jar.clear();
    expect((await h.call('/admin/displays')).status).toBe(302);
  });

  it('carries orientation and rotation to that screen and no other', async () => {
    // The whole point of putting these on the screen rather than the
    // household: two walls, mounted differently.
    const h = await harness();
    const kitchen = pair(h.db, 'Kitchen');
    const hall = pair(h.db, 'Hall');

    const saved = await h.form(`/admin/screens/${kitchen.id}`, {
      name: 'Kitchen', orientation: 'portrait', rotation: '90',
    });
    expect(saved.status).toBe(302);

    const manifestFor = async (token: string) =>
      (await (
        await h.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        screen: { orientation: string; rotation: number; allowDismiss: boolean };
      };

    expect(await manifestFor(kitchen.token)).toHaveProperty('screen', {
      orientation: 'portrait', rotation: 90, allowDismiss: false,
    });
    expect(await manifestFor(hall.token)).toHaveProperty('screen', {
      orientation: 'auto', rotation: 0, allowDismiss: false,
    });
  });

  it('renames a screen from the same form', async () => {
    const h = await harness();
    const screen = pair(h.db, 'Telly');
    await h.form(`/admin/screens/${screen.id}`, {
      name: 'Living room', orientation: 'auto', rotation: '0',
    });
    expect(await (await h.call('/admin/displays')).text()).toContain('Living room');
  });

  it('refuses a rotation that is not a quarter turn', async () => {
    const h = await harness();
    const screen = pair(h.db, 'Kitchen');
    const response = await h.form(`/admin/screens/${screen.id}`, {
      name: 'Kitchen', orientation: 'auto', rotation: '45',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('quarter turn');
  });

  it('refuses an orientation it cannot draw', async () => {
    const h = await harness();
    const screen = pair(h.db, 'Kitchen');
    const response = await h.form(`/admin/screens/${screen.id}`, {
      name: 'Kitchen', orientation: 'diagonal', rotation: '0',
    });
    expect(response.status).toBe(400);
  });

  it('unpairs a screen so its token stops working, and keeps the record', async () => {
    const h = await harness();
    const screen = pair(h.db, 'Old tablet');

    const before = await h.call('/d/manifest', {
      headers: { authorization: `Bearer ${screen.token}` },
    });
    expect(before.status).toBe(200);

    expect((await h.form(`/admin/screens/${screen.id}/revoke`, {})).status).toBe(302);

    const after = await h.call('/d/manifest', {
      headers: { authorization: `Bearer ${screen.token}` },
    });
    expect(after.status).toBe(401);
    // Revoked, not deleted: the row is what makes the token stop working, and
    // somebody working out what is still on their wall wants the history.
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM screens WHERE revoked_at IS NOT NULL').get(),
    ).toEqual({ n: 1 });
  });
});

describe('the order the wall draws in', () => {
  it('saves an order and carries it to the manifest', async () => {
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
      block_1: 'horizon', block_2: 'now', block_3: 'next',
    });
    expect(response.status).toBe(302);
    expect((await h.manifestFor(h)).display?.blocks).toEqual(['horizon', 'now', 'next']);
  });

  it('leaves a block out when a row is set to nothing', async () => {
    const h = await harness();
    await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
      block_1: 'now', block_2: 'horizon', block_3: 'none',
    });
    expect((await h.manifestFor(h)).display?.blocks).toEqual(['now', 'horizon']);
  });

  it('names a block chosen twice rather than silently losing one', async () => {
    // Somebody who did this meant to move a block, not to drop one.
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
      block_1: 'now', block_2: 'now', block_3: 'horizon',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('twice');
  });

  it('refuses an order with nothing in it', async () => {
    const h = await harness();
    const response = await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
      block_1: 'none', block_2: 'none', block_3: 'none',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('at least one');
  });

  it('reads a stored order back into the form', async () => {
    const h = await harness();
    await h.form('/admin/display', {
      theme: 'board', daytime_theme: 'none',
      daytime_starts_at: '07:00', daytime_ends_at: '21:00',
      today_events: '8', next_days: '6', horizon_weeks: '5',
      block_1: 'horizon', block_2: 'next', block_3: 'none',
    });
    const body = await (await h.call('/admin/displays/default')).text();
    expect(body).toMatch(/id="block_1"[\s\S]*?<option value="horizon" selected/);
    expect(body).toMatch(/id="block_3"[\s\S]*?<option value="none" selected/);
  });
});

/**
 * TEST FEED.
 *
 * The button the spec calls out as preventing most support requests. Somebody
 * pasting a URL has no way to know whether they copied the right one — Google
 * offers a public HTML link and a secret iCal link side by side — and seeing
 * real events answers that before they commit to it.
 */
describe('testing a feed before saving it', () => {
  it('shows what came back and stores nothing', async () => {
    const h = await harness();
    const url = await icsServer();

    const response = await h.form('/admin/calendars', {
      name: 'Family', url, allow_loopback: '1', allow_http: '1', action: 'test',
    });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('Dentist');
    expect(body).toContain('Nothing has been saved yet');
    // The whole point: it did not save.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 0 });
  });

  it('keeps the credential out of the preview panel', async () => {
    // The address field itself legitimately holds what was just pasted —
    // somebody correcting a typo needs to see it. What must never carry the
    // path is anything derived from the feed, which is what the panel is.
    const h = await harness();
    const url = await icsServer();
    const body = await (
      await h.form('/admin/calendars', {
        name: 'Family', url, allow_loopback: '1', allow_http: '1', action: 'test',
      })
    ).text();

    // Up to the form that follows it: the panel is everything the server
    // derived from the feed, and the form after it is what the person typed.
    const start = body.indexOf('<div class="preview">');
    const panel = body.slice(start, body.indexOf('<form', start));
    expect(panel).toContain('127.0.0.1');
    expect(panel).not.toContain('secret-token-abcdef');
  });

  it('tests without a name, because a name is not what is being checked', async () => {
    const h = await harness();
    const url = await icsServer();
    const response = await h.form('/admin/calendars', {
      url, allow_loopback: '1', allow_http: '1', action: 'test',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Dentist');
  });

  it('explains a wrong address at test time rather than at save time', async () => {
    const h = await harness();
    const url = await icsServer('<!doctype html><h1>Not a calendar</h1>', 'text/html');
    const response = await h.form('/admin/calendars', {
      name: 'Wrong', url, allow_loopback: '1', allow_http: '1', action: 'test',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('.ics');
  });

  it('still saves when the save button is the one pressed', async () => {
    const h = await harness();
    const url = await icsServer();
    const response = await h.form('/admin/calendars', {
      name: 'Family', url, allow_loopback: '1', allow_http: '1', action: 'save',
    });
    expect(response.status).toBe(302);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get()).toEqual({ n: 1 });
  });
});

describe('people', () => {
  const add = (h: Awaited<ReturnType<typeof harness>>, name: string, color = '#4C7FD1') =>
    h.form('/admin/people', { name, color });

  it('adds someone and lists them', async () => {
    const h = await harness();
    expect((await add(h, 'Sam')).status).toBe(302);
    expect(await (await h.call('/admin/people')).text()).toContain('Sam');
  });

  it('refuses a colour that is not one', async () => {
    const h = await harness();
    const response = await h.form('/admin/people', { name: 'Sam', color: 'chartreuse' });
    expect(response.status).toBe(400);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 0 });
  });

  it('escapes a name that looks like markup', async () => {
    const h = await harness();
    await add(h, '<script>alert(1)</script>');
    const body = await (await h.call('/admin/people')).text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });

  it('assigns a calendar to a person and back to everyone', async () => {
    const h = await harness();
    await add(h, 'Sam');
    await h.addFeed('Sam calendar');
    const person = h.db.prepare('SELECT id FROM people').get() as { id: string };
    const source = h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string };

    await h.form(`/admin/calendars/${source.id}/settings`, {
      name: 'Sam calendar', color: '#AA3311', person_id: person.id, enabled: '1',
    });
    expect(
      h.db.prepare('SELECT person_id AS p, color FROM calendar_sources').get(),
    ).toEqual({ p: person.id, color: '#AA3311' });

    await h.form(`/admin/calendars/${source.id}/settings`, {
      name: 'Sam calendar', color: '#AA3311', person_id: '', enabled: '1',
    });
    expect(h.db.prepare('SELECT person_id AS p FROM calendar_sources').get()).toEqual({ p: null });
  });

  it('assigns the owner at add time, so it is not a second trip through settings', async () => {
    const h = await harness();
    await add(h, 'Sam');
    const person = h.db.prepare('SELECT id FROM people').get() as { id: string };
    await h.addFeed('Sam calendar', person.id);
    expect(h.db.prepare('SELECT person_id AS p FROM calendar_sources').get()).toEqual({
      p: person.id,
    });
  });

  it('treats an owner who has since gone as Everyone rather than refusing the feed', async () => {
    const h = await harness();
    await h.addFeed('Orphan calendar', 'nobody-here');
    expect(h.db.prepare('SELECT COUNT(*) AS n, person_id AS p FROM calendar_sources').get()).toEqual(
      { n: 1, p: null },
    );
  });

  it('turning a calendar off stops it reaching the wall', async () => {
    const h = await harness();
    await h.addFeed('Family');
    const source = h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string };

    await h.form(`/admin/calendars/${source.id}/settings`, {
      name: 'Family', color: '#4C7FD1', person_id: '',
    });
    expect(h.db.prepare('SELECT enabled FROM calendar_sources').get()).toEqual({ enabled: 0 });
  });

  it('keeps the calendars when the person is removed', async () => {
    // Deleting somebody must not silently unsubscribe the household from the
    // school calendar.
    const h = await harness();
    await add(h, 'Sam');
    await h.addFeed('Sam calendar');
    const person = h.db.prepare('SELECT id FROM people').get() as { id: string };
    const source = h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string };
    await h.form(`/admin/calendars/${source.id}/settings`, {
      name: 'Sam calendar', color: '#4C7FD1', person_id: person.id, enabled: '1',
    });

    expect((await h.form(`/admin/people/${person.id}/delete`, {})).status).toBe(302);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 0 });
    expect(
      h.db.prepare('SELECT COUNT(*) AS n, person_id AS p FROM calendar_sources').get(),
    ).toEqual({ n: 1, p: null });
  });

  it('warns before removing, and says what will happen to their calendars', async () => {
    const h = await harness();
    await add(h, 'Sam');
    await h.addFeed('Sam calendar');
    const person = h.db.prepare('SELECT id FROM people').get() as { id: string };
    const source = h.db.prepare('SELECT id FROM calendar_sources').get() as { id: string };
    await h.form(`/admin/calendars/${source.id}/settings`, {
      name: 'Sam calendar', color: '#4C7FD1', person_id: person.id, enabled: '1',
    });

    const confirm = await h.call(`/admin/people/${person.id}/delete`);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('stop being attributed');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
  });
});

describe('per-screen overrides', () => {
  const pairOne = (db: ReturnType<typeof openDatabase>['db'], name: string) => {
    const issued = issueDisplayToken();
    const stamp = Date.now();
    const id = `scr-${name}-${stamp}`;
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, token_issued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, issued.tokenHash, stamp, stamp, stamp);
    return { id, token: issued.token };
  };

  const manifestFor = async (
    h: Awaited<ReturnType<typeof harness>>,
    token: string,
  ): Promise<{ theme: Record<string, string>; timezone: string }> =>
    (await (
      await h.call('/d/manifest', { headers: { authorization: `Bearer ${token}` } })
    ).json()) as never;

  const settings = (over: Record<string, string> = {}) => ({
    name: 'Kitchen', orientation: 'auto', rotation: '0',
    theme: '', daytime_theme: '', daytime_starts_at: '07:00', daytime_ends_at: '21:00',
    timezone: '', ...over,
  });

  it('follows the household when nothing is overridden', async () => {
    const h = await harness();
    const screen = pairOne(h.db, 'Kitchen');
    await h.form(`/admin/screens/${screen.id}`, settings());

    const manifest = await manifestFor(h, screen.token);
    expect(manifest.theme.active).toBe('board');
    expect(manifest.timezone).toBe('Europe/London');
  });

  it('lets one screen take its own theme, night schedule and zone', async () => {
    // A screen in a bedroom wants the dark theme long after the kitchen has
    // gone light, and a holiday home wants its own clock.
    const h = await harness();
    const bedroom = pairOne(h.db, 'Bedroom');
    const kitchen = pairOne(h.db, 'Kitchen');

    await h.form(`/admin/screens/${bedroom.id}`, settings({
      name: 'Bedroom', theme: 'glance', daytime_theme: 'almanac',
      daytime_starts_at: '09:00', daytime_ends_at: '18:00', timezone: 'America/New_York',
    }));

    const dark = await manifestFor(h, bedroom.token);
    expect(dark.theme.active).toBe('glance');
    expect(dark.theme.daytime).toBe('almanac');
    expect(dark.theme.daytimeStartsAt).toBe('09:00');
    expect(dark.timezone).toBe('America/New_York');

    // The other screen is untouched, which is the point of it being per screen.
    const other = await manifestFor(h, kitchen.token);
    expect(other.theme.active).toBe('board');
    expect(other.timezone).toBe('Europe/London');
  });

  it('refuses a theme or zone it cannot honour', async () => {
    const h = await harness();
    const screen = pairOne(h.db, 'Kitchen');
    expect((await h.form(`/admin/screens/${screen.id}`, settings({ theme: 'disco' }))).status).toBe(400);
    expect(
      (await h.form(`/admin/screens/${screen.id}`, settings({ timezone: 'Mars/Olympus' }))).status,
    ).toBe(400);
  });

  it('regenerating shows a pairing link and stops the old token working', async () => {
    const h = await harness();
    const screen = pairOne(h.db, 'Kitchen');

    const before = await h.call('/d/manifest', {
      headers: { authorization: `Bearer ${screen.token}` },
    });
    expect(before.status).toBe(200);

    const response = await h.form(`/admin/screens/${screen.id}/regenerate`, {});
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('/pair?token=');
    expect(body).toContain('<svg');

    const after = await h.call('/d/manifest', {
      headers: { authorization: `Bearer ${screen.token}` },
    });
    expect(after.status).toBe(401);
  });

  it('the link it shows actually pairs the screen', async () => {
    const h = await harness();
    const screen = pairOne(h.db, 'Kitchen');
    const body = await (await h.form(`/admin/screens/${screen.id}/regenerate`, {})).text();
    const token = /\/pair\?token=([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? '';

    expect(token).not.toBe('');
    const paired = await h.call('/d/manifest', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(paired.status).toBe(200);
  });
});

describe('avatars', () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);

  const upload = (h: Awaited<ReturnType<typeof harness>>, id: string, file: File) => {
    const form = new FormData();
    form.set('avatar', file);
    return h.call(`/admin/people/${id}/avatar`, { method: 'POST', body: form });
  };

  const addPerson = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.form('/admin/people', { name: 'Sam', color: '#4C7FD1' });
    return (h.db.prepare('SELECT id FROM people').get() as { id: string }).id;
  };

  it('uploads a picture and shows it on the person', async () => {
    const h = await harness();
    const id = await addPerson(h);

    const response = await upload(h, id, new File([PNG], 'sam.png', { type: 'image/png' }));
    expect(response.status).toBe(302);

    const stored = h.db.prepare('SELECT avatar_path AS p FROM people').get() as { p: string };
    expect(stored.p).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(await (await h.call('/admin/people')).text()).toContain(`/admin/media/${stored.p}`);
  });

  it('serves the bytes with the sniffed type and refuses sniffing', async () => {
    const h = await harness();
    const id = await addPerson(h);
    await upload(h, id, new File([PNG], 'sam.png', { type: 'image/png' }));
    const stored = h.db.prepare('SELECT avatar_path AS p FROM people').get() as { p: string };

    const image = await h.call(`/admin/media/${stored.p}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('refuses an SVG even when it is called a png', async () => {
    // The Content-Type and the extension are both claims by the uploader.
    const h = await harness();
    const id = await addPerson(h);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const response = await upload(h, id, new File([svg], 'sam.png', { type: 'image/png' }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('SVG');
    expect(h.db.prepare('SELECT avatar_path AS p FROM people').get()).toEqual({ p: null });
  });

  it('removes the picture when the box is left empty', async () => {
    const h = await harness();
    const id = await addPerson(h);
    await upload(h, id, new File([PNG], 'sam.png', { type: 'image/png' }));

    const form = new FormData();
    form.set('avatar', new File([], '', { type: 'application/octet-stream' }));
    await h.call(`/admin/people/${id}/avatar`, { method: 'POST', body: form });
    expect(h.db.prepare('SELECT avatar_path AS p FROM people').get()).toEqual({ p: null });
  });

  it('is not readable without a session or a screen token', async () => {
    // A family's photographs must not be readable by anything on the network
    // that happens to know a filename.
    const h = await harness();
    const id = await addPerson(h);
    await upload(h, id, new File([PNG], 'sam.png', { type: 'image/png' }));
    const stored = h.db.prepare('SELECT avatar_path AS p FROM people').get() as { p: string };

    h.jar.clear();
    expect((await h.call(`/admin/media/${stored.p}`)).status).toBe(302);
    expect((await h.call(`/d/media/${stored.p}`)).status).toBe(401);
  });

  it('reaches the wall through the manifest, on this server', async () => {
    const h = await harness();
    const id = await addPerson(h);
    await upload(h, id, new File([PNG], 'sam.png', { type: 'image/png' }));

    const manifest = (await h.manifestFor(h)) as unknown as {
      people: { name: string; avatarUrl: string | null }[];
    };
    const sam = manifest.people.find((person) => person.name === 'Sam');
    // Rule three: a path on this server, never somewhere else.
    expect(sam?.avatarUrl).toMatch(/^\/d\/media\/[a-f0-9]{64}\.png$/);
  });
});

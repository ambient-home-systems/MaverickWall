import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { applyTemplate, retireDefaultWall } from '../src/api/templates.js';
import { createScreen, readLayoutWidgets } from '../src/api/queries.js';
import { householdSetUp } from '../src/modules/index.js';
import { TEMPLATES } from '../src/templates/index.js';

/**
 * Retiring the shared "Default wall", without taking a calendar off anybody's
 * wall on the way.
 *
 * That row was two jobs at once: the settings every wall inherits, and a canvas
 * a wall drew until it had one of its own. Only the first was ever a *setting*;
 * the second made the household row look like a display, with a card on the
 * Walls list, a page, a gallery and a Reset, for a thing nothing is paired to
 * and nothing draws.
 *
 * The dangerous half is the canvas, and it is why this file exists rather than
 * a line in a route test. A wall that never arranged one is *drawing* the
 * household's, so simply dropping the fallback takes a working kitchen calendar
 * off the wall on the next restart — rule nine, in the shape that shows up in
 * somebody's kitchen rather than in a log. `retireDefaultWall` copies what each
 * such wall was already drawing onto it, once.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const B = 'http://localhost:8080';

const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDb() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-retire-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(`INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`).run(
    stamp,
    stamp,
  );
  return { db, dataDir };
}

async function harness() {
  const { db, dataDir } = freshDb();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'p'.repeat(32), baseUrl: 'http://localhost' },
    keyring: createKeyring(randomBytes(32)),
    fetcher: createFetcher(),
    clientAddress: () => `10.12.0.${++nextAddress}`,
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
  const post = (url: string, fields: Record<string, string>): Promise<Response> =>
    call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  await call(`http://localhost/setup?token=${setupToken.current().token}`);
  await post('http://localhost/setup/account', {
    name: 'Household',
    email: `retire${nextAddress}@home.local`,
    password: 'correct-horse-battery',
    confirm: 'correct-horse-battery',
  });
  await post('http://localhost/setup/household', { timezone: 'Europe/London' });
  return { db, call, post };
}

/** The template a household had on the shared canvas, before the retirement. */
const SHARED = TEMPLATES.find((one) => one.id === 'minimal-clock')!;

describe('retiring the shared Default wall', () => {
  it('copies what an inheriting wall was drawing onto it, so nothing goes blank', () => {
    const { db } = freshDb();
    // The state an upgrading install is in: a household canvas, and a wall with
    // none of its own that has been drawing it.
    applyTemplate(db, null, SHARED);
    createScreen(db, 'inheriting', 'Kitchen', {
      tokenHash: 'h',
      pairingCodeHash: 'p',
      pairingCodeExpiresAt: Date.now() + 60_000,
    });
    expect(readLayoutWidgets(db, 'inheriting', 'portrait')).toEqual([]);

    retireDefaultWall(db, householdSetUp(db));

    const drawn = readLayoutWidgets(db, 'inheriting', 'portrait').map((w) => w.type);
    expect(drawn, 'the wall was left with nothing to draw').toEqual(
      SHARED.portrait.widgets.map((w) => w.type),
    );
    // Both canvases, or a wall turned sideways is blank instead.
    expect(readLayoutWidgets(db, 'inheriting', 'landscape').map((w) => w.type)).toEqual(
      SHARED.landscape.widgets.map((w) => w.type),
    );
  });

  it('leaves a wall that arranged its own canvas completely alone', () => {
    const { db } = freshDb();
    applyTemplate(db, null, SHARED);
    createScreen(db, 'own', 'Hallway', {
      tokenHash: 'h',
      pairingCodeHash: 'p',
      pairingCodeExpiresAt: Date.now() + 60_000,
    });
    const mine = TEMPLATES.find((one) => one.id === 'sky-week')!;
    applyTemplate(db, 'own', mine);

    retireDefaultWall(db, householdSetUp(db));

    expect(readLayoutWidgets(db, 'own', 'portrait').map((w) => w.type)).toEqual(
      mine.portrait.widgets.map((w) => w.type),
    );
  });

  it('does not copy a colour wall onto an e-paper panel', () => {
    /*
     * A panel with no canvas is not inheriting anything — it draws its built-in
     * view, which is a fact about the renderer rather than a fallback to this
     * row. Copying here would *change* what it draws rather than preserve it,
     * and would do it in an arrangement authored for colour.
     */
    const { db } = freshDb();
    applyTemplate(db, null, SHARED);
    db.prepare(
      `INSERT INTO screens (id, name, token_hash, kind, panel_width, panel_height, panel_colour,
                            rotation, token_issued_at, created_at, updated_at)
       VALUES ('panel', 'Hall tag', 'h', 'epaper', 800, 480, 'bw', 0, ?, ?, ?)`,
    ).run(Date.now(), Date.now(), Date.now());

    retireDefaultWall(db, householdSetUp(db));

    expect(readLayoutWidgets(db, 'panel', 'portrait')).toEqual([]);
    expect(readLayoutWidgets(db, 'panel', 'landscape')).toEqual([]);
  });

  it('runs once, so a wall the household later empties is not re-seeded', () => {
    const { db } = freshDb();
    applyTemplate(db, null, SHARED);
    createScreen(db, 'w', 'Kitchen', {
      tokenHash: 'h',
      pairingCodeHash: 'p',
      pairingCodeExpiresAt: Date.now() + 60_000,
    });
    retireDefaultWall(db, householdSetUp(db));
    expect(readLayoutWidgets(db, 'w', 'portrait').length).toBeGreaterThan(0);

    // The household clears it deliberately — the Blank card, or every box
    // deleted. A second boot must not put the old canvas back.
    db.prepare(`DELETE FROM layout_widgets WHERE screen_id = 'w'`).run();
    retireDefaultWall(db, householdSetUp(db));
    expect(readLayoutWidgets(db, 'w', 'portrait')).toEqual([]);
  });

  it('seeds a wall on every door that makes one, so none depends on the shared canvas', async () => {
    /*
     * Two of these did not seed and nothing said so: the wall drew the shared
     * canvas instead, which looked identical and was somebody else's row. With
     * that retired, the same omission is a wall that draws "Nothing on this
     * wall yet." for ever — `backfillClassic` runs once per database and has
     * long since run on any install this reaches.
     */
    const h = await harness();

    // The add page.
    await h.post(`${B}/admin/screens`, { name: 'Kitchen' });
    // The device flow: a wall starts pairing and the household approves it.
    const started = await h.post(`${B}/d/pair/device-start`, {});
    expect(started.status).toBe(200);
    const { userCode } = (await started.json()) as { userCode: string };
    const approved = await h.post(`${B}/admin/screens/approve`, {
      code: userCode,
      name: 'Hallway',
      action: 'approve',
    });
    expect(approved.status).toBe(200);

    const walls = h.db
      .prepare(`SELECT id, name FROM screens WHERE kind IS NULL OR kind != 'epaper'`)
      .all() as { id: string; name: string }[];
    expect(walls.map((w) => w.name).sort()).toEqual(['Hallway', 'Kitchen']);
    for (const wall of walls) {
      expect(
        readLayoutWidgets(h.db, wall.id, 'portrait').length,
        `${wall.name} was created with no canvas of its own`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('the Default wall is not a display any more', () => {
  it('sends its page to System and keeps it off the Walls list', async () => {
    const h = await harness();
    const moved = await h.call(`${B}/admin/walls/default`);
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('/admin/system');

    const list = await (await h.call(`${B}/admin/walls`)).text();
    expect(list).not.toContain('Default wall');
    expect(list).not.toContain('admin/walls/default');
  });

  it('keeps every setting it held, on System, and saves them from there', async () => {
    const h = await harness();
    const page = await (await h.call(`${B}/admin/system`)).text();
    // Everything the Default wall's settings sheet carried.
    for (const field of [
      'name="theme"',
      'name="daytime_theme"',
      'name="daytime_starts_at"',
      'name="today_events"',
      'name="next_days"',
      'name="horizon_weeks"',
      'name="week_start"',
      'name="clock_24"',
    ]) {
      expect(page, `System lost ${field}`).toContain(field);
    }

    const saved = await h.post(`${B}/admin/display`, {
      theme: 'almanac',
      daytime_theme: 'none',
      today_events: '9',
      next_days: '4',
      horizon_weeks: '5',
      week_start: 'monday',
      clock_24: '1',
    });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/admin/system?saved=screen-settings');
    const row = h.db
      .prepare(
        `SELECT theme, display_today_events AS today, week_start AS weekStart
           FROM household_settings WHERE id = 'singleton'`,
      )
      .get() as { theme: string; today: number; weekStart: string };
    expect(row).toEqual({ theme: 'almanac', today: 9, weekStart: 'monday' });
  });

  it('is one form, so saving the clock cannot clear the daylight schedule', async () => {
    /*
     * The unticked-checkbox rule, one page along. `POST /admin/display` writes
     * every field it is given, so three sections posting separately would let a
     * form carrying only the clock save a 12-hour clock *and* take the daylight
     * theme off every wall. Sections are markup; the form spans them.
     */
    const h = await harness();
    const page = await (await h.call(`${B}/admin/system`)).text();
    const start = page.indexOf('action="admin/display"');
    expect(start, 'no wall-defaults form on System').toBeGreaterThan(-1);
    const form = page.slice(start, page.indexOf('</form>', start));
    for (const field of ['name="theme"', 'name="daytime_theme"', 'name="week_start"', 'name="clock_24"']) {
      expect(form, `${field} is outside the one form that writes it`).toContain(field);
    }
  });

  it('shows every conditional field, because System ships no script to reveal them', async () => {
    /*
     * The wall's own settings sheet hides the daylight window until a daytime
     * theme is set, and `display-editor.js` reveals it. System does not load
     * that module, so a group rendered `hidden` here would be a control nobody
     * could ever reach — the chores form's rule.
     */
    const h = await harness();
    const page = await (await h.call(`${B}/admin/system`)).text();
    const start = page.indexOf('action="admin/display"');
    const form = page.slice(start, page.indexOf('</form>', start));
    expect(form).toContain('name="daytime_starts_at"');
    expect(form, 'a field ships hidden with nothing to reveal it').not.toMatch(/<div[^>]*\bhidden[^>]*>/);
  });
});

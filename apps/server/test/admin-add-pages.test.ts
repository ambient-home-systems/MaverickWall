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
 * P2.1's "details that must survive the move", held on every add page it made.
 *
 * Moving a form to a page of its own is the kind of change that keeps the form
 * and quietly drops everything around it, because each of these lived in the
 * handler's re-render of the *list*: a refused body came back on the list with
 * what was typed; a success said so on the list; every link was relative so the
 * single `<base>` carries it through ingress. So each is asserted here against
 * the add page, one screen at a time, and one of them — the echo — is stronger
 * than it was: People, Chores and Shift types never echoed a refused body, and
 * a household sent to a page of its own to type something should not lose it.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.26.26.${++clientNumber}`;

async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-add-pages-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });
  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);

  const address = nextClientAddress();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'q'.repeat(32), baseUrl: 'http://localhost' },
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
    name: 'Household', email: 'family@home.local',
    password: 'correct-horse-battery', confirm: 'correct-horse-battery',
  });
  await form('/setup/household', { timezone: 'Europe/London' });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  /*
   * One person, so every conditional add form that used to exist is drawn:
   * Work Schedule only drew "Add a rotation" when there was somebody to give a
   * rotation to, and a crawl of an empty household would have seen no form on
   * that page with or without this change.
   */
  expect((await form('/admin/people', { name: 'Sam', color: '#4C7FD1' })).status).toBe(302);
  return { call, form, db };
}

const ERROR = 'class="error"';

/** A page is relative throughout: nothing a `<base>` cannot carry. */
function expectRelative(html: string, where: string): void {
  expect(html, `${where} links absolutely into the admin`).not.toMatch(/(?:href|action)="\/admin/);
}

/** The back link the app bar draws for a nested page. */
function expectBack(html: string, to: string): void {
  expect(html).toContain(`class="crumb crumb-back" href="${to}"`);
}

describe('each add page', () => {
  it('People: echoes a refused body above the form, and confirms on the list', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/people/new')).text();
    expectRelative(page, '/admin/people/new');
    expectBack(page, 'admin/people');

    const refused = await h.form('/admin/people', { name: 'Jamie Echo', color: 'blue' });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('<h1>Add a person</h1>');
    expect(html).toContain('value="Jamie Echo"');
    expect(html.indexOf(ERROR)).toBeGreaterThan(-1);
    expect(html.indexOf(ERROR)).toBeLessThan(html.indexOf('action="admin/people"'));

    const added = await h.form('/admin/people', { name: 'Jamie', color: '#4C7FD1' });
    expect(added.headers.get('location')).toBe('/admin/people?saved=person-added');
  });

  it('Chores: echoes every field of a refused chore, ticked days included', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/chores/new')).text();
    expectRelative(page, '/admin/chores/new');
    expectBack(page, 'admin/chores');

    const refused = await h.form('/admin/chores', {
      name: 'Bins echo', person_id: '', kind: 'everyNDays', every_n: '0', every_from: '2026-10-01',
      day_2: '1', due_time: '07:30',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('<h1>Add a chore</h1>');
    expect(html).toContain('value="Bins echo"');
    expect(html).toContain('value="everyNDays" selected');
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('value="07:30"');
    expect(html).toMatch(/name="day_2" value="1" checked/);
    expect(html.indexOf(ERROR)).toBeLessThan(html.indexOf('action="admin/chores"'));

    const added = await h.form('/admin/chores', { name: 'Bins', person_id: '', kind: 'daily' });
    expect(added.headers.get('location')).toBe('/admin/chores?saved=chore-added');
  });

  it('Shift types: echoes a refused type, and both ways in confirm on the list', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/shifts/types/new')).text();
    expectRelative(page, '/admin/shifts/types/new');
    expectBack(page, 'admin/shifts/types');
    // The common presets are on this page, not the list's.
    expect(page).toContain('action="admin/shifts/types/preset"');

    const refused = await h.form('/admin/shifts/types', {
      label: 'Swing echo', short_code: 'TOOLONG', color: '#123456', start_time: '14:00',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('<h1>Add a shift type</h1>');
    expect(html).toContain('value="Swing echo"');
    expect(html).toContain('value="#123456"');
    expect(html).toContain('value="14:00"');
    // An unticked "working shift" came back unticked, not reset to its default.
    expect(html).not.toMatch(/name="is_working" value="1" checked/);
    expect(html.indexOf(ERROR)).toBeLessThan(html.indexOf('action="admin/shifts/types"'));

    const added = await h.form('/admin/shifts/types', {
      label: 'Swing', short_code: 'Sw', color: '#123456', is_working: '1',
    });
    expect(added.headers.get('location')).toBe('/admin/shifts/types?saved=shift-type-added');
    const preset = await h.form('/admin/shifts/types/preset', { preset: 'sick' });
    expect(preset.headers.get('location')).toBe('/admin/shifts/types?saved=shift-type-added');

    // And the list's way back is the app bar's, not a link in the body.
    const list = await (await h.call('/admin/shifts/types')).text();
    expectBack(list, 'admin/shifts');
    expect(list).not.toContain('← Work Schedule');
  });

  it('Work Schedule: step one is a page, and a refusal keeps the choice made', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Amy', color: '#E8A33D' });
    const page = await (await h.call('/admin/shifts/new')).text();
    expectRelative(page, '/admin/shifts/new');
    expectBack(page, 'admin/shifts');

    const refused = await h.form('/admin/shifts/new', { person_id: 'nobody', kind: 'pattern' });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('<h1>Add a rotation</h1>');
    expect(html).toContain('value="pattern" selected');
    expect(html.indexOf(ERROR)).toBeLessThan(html.indexOf('action="admin/shifts/new"'));

    // And the schema's own refusal, which is a different branch of the same
    // handler: a person id past the field's length, with the choice kept.
    const shape = await h.form('/admin/shifts/new', { person_id: 'x'.repeat(41), kind: 'pattern' });
    expect(shape.status).toBe(400);
    const shapeHtml = await shape.text();
    expect(shapeHtml).toContain('<h1>Add a rotation</h1>');
    expect(shapeHtml).toContain('value="pattern" selected');
  });

  it('Calendars: the chooser, and both forms behind it, answer relative and echo', async () => {
    const h = await harness();
    for (const path of ['/admin/calendars/new', '/admin/calendars/new/address', '/admin/calendars/new/caldav']) {
      const one = await h.call(path);
      expect(one.status, path).toBe(200);
      expectRelative(await one.text(), path);
    }
    expectBack(await (await h.call('/admin/calendars/new')).text(), 'admin/calendars');

    const ics = await h.form('/admin/calendars', { name: 'Family echo', url: 'not an address', action: 'save' });
    expect(ics.status).toBe(400);
    const icsHtml = await ics.text();
    expect(icsHtml).toContain('<h1>Add a calendar address</h1>');
    expect(icsHtml).toContain('value="Family echo"');
    expect(icsHtml.indexOf(ERROR)).toBeLessThan(icsHtml.indexOf('action="admin/calendars"'));

    const caldav = await h.form('/admin/calendars/caldav', {
      server_url: 'https://caldav.example', caldav_username: 'jo@example',
    });
    expect(caldav.status).toBe(400);
    const caldavHtml = await caldav.text();
    expect(caldavHtml).toContain('<h1>Add a CalDAV account</h1>');
    expect(caldavHtml).toContain('value="jo@example"');
    expect(caldavHtml.indexOf(ERROR)).toBeLessThan(caldavHtml.indexOf('action="admin/calendars/caldav"'));
  });

  it('Themes: "Generate from a colour" is on the add page, and a refusal comes back there', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/themes/new')).text();
    expectRelative(page, '/admin/themes/new');
    expectBack(page, 'admin/themes');
    expect(page).toContain('action="admin/themes/generate"');
    // And only there: an edit already has its colours.
    const list = await (await h.call('/admin/themes')).text();
    expect(list).not.toContain('action="admin/themes/generate"');

    const refused = await h.form('/admin/themes/generate', { name: 'Sea echo', seed: 'nope', mode: 'light' });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain('<h1>Add a theme</h1>');
    expect(html).toContain('value="Sea echo"');
    expect(html).toContain('value="light" selected');
    expect(html.indexOf(ERROR)).toBeLessThan(html.indexOf('action="admin/themes/generate"'));

    const made = await h.form('/admin/themes/generate', { name: 'Sea glass', seed: '#4C7FD1', mode: 'dark' });
    expect(made.headers.get('location')).toMatch(/^\/admin\/themes\/[^/?]+\?saved=theme-generated$/);
  });
});

describe('the Store family', () => {
  it('takes its way back in the app bar, and leaves the action slot to an "Add …"', async () => {
    /*
     * The three pages below the Store used the app bar's filled action for a
     * "Back to…" link. The action slot is only ever "Add …" now (P2.1), so the
     * way back is the header's back link — a quiet crumb, not this page's one
     * main act.
     */
    const h = await harness();
    for (const [path, back] of [
      ['/admin/modules/advanced', 'admin/modules'],
      ['/admin/modules/recipe', 'admin/modules/advanced'],
      ['/admin/modules/install/outside-temperature', 'admin/modules'],
    ] as const) {
      const html = await (await h.call(path)).text();
      expectBack(html, back);
      const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
      expect(header, `${path} still has a filled action in its app bar`).not.toMatch(/<a class="btn/);
      expect(html).not.toContain('Back to');
    }
  });
});

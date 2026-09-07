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
import { isUnitedStatesZone } from '../src/timezone.js';

/**
 * A fresh install says nothing it cannot mean, and a pairing link is never
 * revoked by somebody trying to look at it.
 *
 * Both were found by driving the admin as a household in London. The weather
 * columns default to the shipped United States behaviour — NWS, Fahrenheit,
 * alerts on — and the wizard never touched them, so every household outside
 * that country got a forecast provider that could not forecast for them,
 * units they do not use, and an alert switch on with nothing it could watch,
 * which the Overview then drew in red beside a red "Not connected" for a Home
 * Assistant nobody had asked for. And the wall page's "Pairing link…" posted
 * straight to `/regenerate`, revoking the link a household had just printed
 * and, on a paired wall, cutting the wall off — with the page's own status
 * line pointing at it.
 */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let clientNumber = 0;
const nextClientAddress = (): string => `10.27.27.${++clientNumber}`;

async function harness(timezone = 'Europe/London') {
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-defaults-'));
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
    auth: { secret: 'n'.repeat(32), baseUrl: 'http://localhost' },
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
  await form('/setup/household', { timezone });
  expect((await call('/admin')).status, 'the harness must reach a signed-in /admin').toBe(200);

  const text = async (path: string): Promise<string> => (await call(path)).text();
  const weather = () =>
    db
      .prepare(
        `SELECT weather_provider AS provider, weather_units AS units, alerts_enabled AS alerts
           FROM household_settings WHERE id = 'singleton'`,
      )
      .get() as { provider: string; units: string; alerts: number };
  return { db, call, form, text, weather };
}

describe('the weather defaults follow the timezone the wizard is told', () => {
  it('outside the United States: a worldwide forecast, metric, and the NWS alert switch off', async () => {
    const h = await harness('Europe/London');
    expect(h.weather()).toEqual({ provider: 'openmeteo', units: 'metric', alerts: 0 });
  });

  it('in the United States: the shipped behaviour — NWS, Fahrenheit, alerts on', async () => {
    const h = await harness('America/Chicago');
    expect(h.weather()).toEqual({ provider: 'nws', units: 'imperial', alerts: 1 });
  });

  it('reads the country off the zone, not off the continent', () => {
    // The Americas are not the United States. Toronto, Mexico City and Bogotá
    // are metric and outside the National Weather Service; a prefix test on
    // `America/` would hand all three the wrong defaults.
    for (const zone of ['America/Toronto', 'America/Mexico_City', 'America/Bogota', 'Europe/London', 'Australia/Sydney']) {
      expect(isUnitedStatesZone(zone), zone).toBe(false);
    }
    for (const zone of ['America/New_York', 'America/Phoenix', 'Pacific/Honolulu', 'America/Puerto_Rico', 'US/Eastern']) {
      expect(isUnitedStatesZone(zone), zone).toBe(true);
    }
  });
});

describe('the Overview does not cry wolf', () => {
  it('shows nothing in red on a fresh install that has done nothing wrong', async () => {
    const h = await harness('Europe/London');
    const html = await h.text('/admin');
    expect(html).not.toContain('tag-bad');
    // An integration nobody has set up is neutral, not a fault.
    expect(html).toContain('Not set up');
    expect(html).not.toContain('Not connected');
    expect(html).toContain('Off');
  });

  it('says a place is outside the service rather than promising zones that will never come', async () => {
    // A household set up before the wizard learned to turn the switch off, or
    // one who turned it on themselves: alerts on, a location, no zone.
    const h = await harness('Europe/London');
    h.db
      .prepare(`UPDATE household_settings SET alerts_enabled = 1, latitude = 51.5, longitude = -0.1 WHERE id = 'singleton'`)
      .run();
    const overview = await h.text('/admin');
    expect(overview).toContain('Not available here');
    expect(overview).not.toContain('no zones yet');
    expect(overview).not.toContain('tag-bad');
    const weather = await h.text('/admin/alerts');
    expect(weather).toContain('covers the United States only');
    expect(weather).not.toContain('the first check has not run');
  });

  it('treats "no zones yet" in the United States as a wait, not a fault', async () => {
    const h = await harness('America/Chicago');
    h.db.prepare(`UPDATE household_settings SET latitude = 41.8, longitude = -87.6 WHERE id = 'singleton'`).run();
    const overview = await h.text('/admin');
    expect(overview).toContain('no zones yet');
    expect(overview).not.toContain('tag-bad');
  });

  it('still goes red for something that is on and cannot work', async () => {
    // Alerts on with no location: the one zero-zone case that is the
    // household's to fix, and it says what to fix.
    const h = await harness('America/Chicago');
    const overview = await h.text('/admin');
    expect(overview).toContain('needs your location');
    expect(overview).toContain('tag-bad');
  });
});

describe('the Overview says what needs attention and what the wall draws today', () => {
  it('opens on attention rows rather than stat tiles, and names what a fresh install lacks', async () => {
    const h = await harness();
    const html = await h.text('/admin');
    expect(html).not.toContain('class="card stat"');
    expect(html).not.toContain('Calendars connected');
    expect(html).not.toContain('Signed in as');
    expect(html).toContain('Needs attention');
    expect(html).toContain('No calendars yet');
    expect(html).toContain('No walls paired yet');
    // Each row is a link to where the thing is done.
    expect(html).toContain('href="admin/calendars"');
    expect(html).toContain('href="admin/walls"');
  });

  it('lists a wall that has never connected, and links to its page', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet' });
    const html = await h.text('/admin');
    expect(html).toContain('Kitchen tablet has never connected');
    expect(html).not.toContain('No walls paired yet');
    const id = (h.db.prepare(`SELECT id FROM screens`).get() as { id: string }).id;
    expect(html).toContain(`href="admin/walls/${id}"`);
  });

  it("says today's chores and rota in the Today card, and keeps the zone on its supporting line", async () => {
    const h = await harness();
    await h.form('/admin/chores', { name: 'Empty the dishwasher', kind: 'daily', due_time: '19:00' });
    const html = await h.text('/admin');
    const card = /<div class="card today-card">([\s\S]*?)<div class="row card-foot">/.exec(html)?.[1] ?? '';
    expect(card).toContain('<ul class="ov-today">');
    expect(card).toContain('Empty the dishwasher · by 19:00');
    expect(card).toContain('Europe/London');
  });

  it('says "Nothing on today" rather than drawing an empty list', async () => {
    const h = await harness();
    const html = await h.text('/admin');
    expect(html).toContain('Nothing on today.');
    expect(html).not.toContain('<ul class="ov-today">');
  });
});

describe('the Add-a-rotation form opens on a choice that can be submitted', () => {
  /** The options of the named select, in order, with the one a browser would post first. */
  const options = (html: string, name: string): { value: string; label: string }[] => {
    const select = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '';
    return [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({
      value: m[1]!, label: m[2]!,
    }));
  };
  const stamp = Date.now();
  const addSource = (h: Awaited<ReturnType<typeof harness>>, id: string, name: string): void => {
    h.db
      .prepare(`INSERT INTO calendar_sources (id, name, url_encrypted, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)`)
      .run(id, name, stamp, stamp);
  };

  it('with no calendar, offers only a pattern, and Continue on the untouched form is accepted', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Amy', color: '#E8A33D' });
    const html = await h.text('/admin/shifts');
    expect(options(html, 'kind').map((o) => o.value)).toEqual(['pattern']);
    expect(html).not.toContain('name="source_id"');
    // The form as drawn, posted as a browser would post it untouched.
    const who = options(html, 'person_id')[0]!.value;
    const response = await h.form('/admin/shifts/new', { person_id: who, kind: 'pattern' });
    expect(response.status).toBe(200);
    // The heading escapes the apostrophe.
    expect(await response.text()).toMatch(/Amy(&#39;|')s rotation/);
  });

  it('with a calendar, preselects it rather than a placeholder, so the untouched form is accepted', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Amy', color: '#E8A33D' });
    addSource(h, 'src-work', 'Work');
    const html = await h.text('/admin/shifts');
    expect(options(html, 'kind').map((o) => o.value)).toEqual(['calendar', 'pattern']);
    const calendars = options(html, 'source_id');
    expect(calendars[0]).toEqual({ value: 'src-work', label: 'Work' });
    expect(calendars.some((o) => o.value === '')).toBe(false);
    // The calendar select is disclosed by the kind select, script-free, and
    // both show with script off exactly as before.
    expect(html).toContain('name="kind" data-cond');
    expect(html).toContain('<div data-cond-show="calendar">');
    const response = await h.form('/admin/shifts/new', {
      person_id: options(html, 'person_id')[0]!.value, kind: 'calendar', source_id: 'src-work',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('Choose which calendar');
  });

  it('preselects whoever has no rotation yet, and says who already has one', async () => {
    const h = await harness();
    await h.form('/admin/people', { name: 'Amy', color: '#E8A33D' });
    await h.form('/admin/people', { name: 'Ben', color: '#4A90D9' });
    h.db.prepare(`UPDATE people SET has_shift_rotation = 1 WHERE name = 'Amy'`).run();
    const who = options(await h.text('/admin/shifts'), 'person_id');
    expect(who.map((o) => o.label)).toEqual(['Ben', 'Amy (has a rotation)']);
  });
});

describe('a new pairing link is asked for, never stumbled into', () => {
  const screenId = (h: Awaited<ReturnType<typeof harness>>): string =>
    (h.db.prepare(`SELECT id FROM screens WHERE revoked_at IS NULL`).get() as { id: string }).id;

  it('names the control for what it does and says what it costs on a wall that has never connected', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet' });
    const page = await h.text(`/admin/walls/${screenId(h)}`);
    // The old label read as "show me the link" and revoked it.
    expect(page).not.toContain('>Pairing link');
    expect(page.match(/New pairing link/g)?.length, 'the ⋮ and the Advanced panel').toBe(2);
    // Every regenerate form carries the confirmation, and none is red: an
    // unspent link is the only thing at stake.
    const forms = page.match(/<form method="post" action="admin\/screens\/[0-9a-f]+\/regenerate"[^>]*>/g) ?? [];
    expect(forms.length).toBe(2);
    for (const form of forms) {
      expect(form).toContain('data-confirm="Make a new pairing link for Kitchen tablet? The link and code you were given stop working');
    }
    expect(page).not.toMatch(/regenerate"[^>]*>\s*<button class="[^"]*is-danger/);
    // The status line names the way to a new one, rather than pointing at a
    // control that silently makes one.
    expect(page).toContain('Never connected</b> · open its pairing link on the wall, or make a new one from the menu');
  });

  it('turns red and says the wall drops off once the wall has connected', async () => {
    const h = await harness();
    await h.form('/admin/screens', { name: 'Kitchen tablet' });
    const id = screenId(h);
    h.db.prepare(`UPDATE screens SET last_seen_at = ? WHERE id = ?`).run(Date.now(), id);
    const page = await h.text(`/admin/walls/${id}`);
    const forms = page.match(/<form method="post" action="admin\/screens\/[0-9a-f]+\/regenerate"[^>]*>/g) ?? [];
    expect(forms.length).toBe(2);
    for (const form of forms) {
      expect(form).toContain('Kitchen tablet drops off the wall and shows its pairing screen until the new link is opened on it');
    }
    expect(page.match(/regenerate"[^>]*>\s*<button class="[^"]*is-danger/g)?.length).toBe(2);
  });

  it('tells the household on the pairing page itself that a new link retires this one', async () => {
    const h = await harness();
    const made = await h.form('/admin/screens', { name: 'Kitchen tablet' });
    const shown = await (await h.call(made.headers.get('location') ?? '')).text();
    expect(shown).not.toContain('costs nothing');
    expect(shown).toContain('this one stops working when you do');
  });
});

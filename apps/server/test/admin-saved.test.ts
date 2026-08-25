/**
 * The confirmation strip's plumbing (RFC 009 Phase 3.1).
 *
 * The browser drives the strip end to end in `browser-admin.test.ts`; these are
 * the three things about it that are cheap to check here and expensive to
 * notice anywhere else:
 *
 *  - the redirect actually carries the token, through the *real* app rather
 *    than by reading the helper back to itself;
 *  - dismissing keeps the rest of the query, because a page prefilled by
 *    `?install=…` or `?template=…` losing its prefill on dismiss would be a
 *    smaller version of the bug this whole phase is about; and
 *  - every href it emits is relative. That is the one property Home Assistant
 *    ingress depends on and the one no visual check can see: an absolute `/…`
 *    resolves outside the add-on, into Home Assistant's own UI, and a
 *    household on the sidebar would press Dismiss and leave the application.
 */
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
import { SAVED_MESSAGES } from '../src/http/saved.js';
import { seedDefaultRules } from '../src/api/rules.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const address = `10.31.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-saved-'));
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
    auth: { secret: 's'.repeat(32), baseUrl: 'http://localhost' },
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

  return { db, call, form };
}

/** The strip's markup, if the page carries one. */
function stripOf(html: string): string | undefined {
  return /<div class="saved" [^>]*>[\s\S]*?<\/div>/.exec(html)?.[0];
}

describe('the Weather form marker', () => {
  /**
   * An unticked checkbox is not sent, so an empty body and a form with every
   * switch off are byte-identical — and once the alerts switch joined the
   * forecast's form, that stopped being harmless. The case that matters is a
   * page cached from before the switch moved: it posts a body with no
   * `alerts_enabled` field, which the handler would read as "turn the tornado
   * warnings off".
   */
  it('refuses a body that is not the screen’s own form, and changes nothing', async () => {
    const h = await harness();
    h.db.prepare(`UPDATE household_settings SET alerts_enabled = 1 WHERE id = 'singleton'`).run();

    // Exactly the body the *old* two-form page posted: no marker, no alerts field.
    const stale = await h.form('/admin/weather', {
      weather_enabled: '1', latitude: '51.5', longitude: '-0.1',
      weather_provider: 'nws', weather_units: 'imperial',
    });
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('out of date');

    const row = h.db
      .prepare(`SELECT alerts_enabled AS alerts, latitude FROM household_settings WHERE id = 'singleton'`)
      .get() as { alerts: number; latitude: number | null };
    expect(row.alerts, 'a stale page must not turn weather alerts off').toBe(1);
    expect(row.latitude, 'and must not half-apply either').toBe(null);
  });

  /**
   * The zone poll is brought forward on the *transition*, not on every save.
   *
   * "Bring it forward so the household sees the zones fill in rather than
   * staring at 'working it out' for a minute" is right for the moment somebody
   * turns alerts on, and wrong for every save after it — once the switch shares
   * the forecast's form, changing the units would reset `next_run_at` too and
   * throw away the job's failure backoff, hammering api.weather.gov while it
   * was having a bad morning.
   */
  it('brings the zone poll forward when alerts go on, and not on every save after', async () => {
    const h = await harness();
    // The row the scheduler registers at boot; this harness makes no scheduler.
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
         VALUES ('alerts-sync', 'alerts-sync', ?, 0, ?, ?)`,
      )
      .run(stamp, stamp, stamp);
    const nextRun = (): number =>
      (h.db.prepare(`SELECT next_run_at AS at FROM job_state WHERE kind = 'alerts-sync'`).get() as
        | { at: number }
        | undefined)?.at ?? -1;
    expect(nextRun(), 'the alerts job has to exist for this to mean anything').toBeGreaterThan(-1);

    const save = (fields: Record<string, string>): Promise<Response> =>
      h.form('/admin/weather', {
        weather_form: '1', latitude: '51.5', longitude: '-0.1',
        weather_provider: 'nws', weather_units: 'imperial', ...fields,
      });

    // Off, then on: the transition, which should reach forward.
    await save({});
    h.db.prepare(`UPDATE job_state SET next_run_at = 9999999999 WHERE kind = 'alerts-sync'`).run();
    await save({ alerts_enabled: '1' });
    expect(nextRun(), 'turning alerts on should bring the first check forward').toBe(0);

    // Backed off after a failure, then an unrelated save. The backoff stands.
    h.db.prepare(`UPDATE job_state SET next_run_at = 9999999999 WHERE kind = 'alerts-sync'`).run();
    await save({ alerts_enabled: '1', weather_units: 'metric' });
    expect(nextRun(), 'changing the units must not reset the job’s backoff').toBe(9999999999);
  });

  /**
   * Blank is "not set yet", not a way to delete a location by accident.
   *
   * `writeWeatherSettings` treats a move as a move: clearing the coordinates
   * retires every NWS alert zone, which un-arms every weather rule. "Weather
   * settings saved." would be the strip's word for a household's tornado
   * warnings going quiet.
   */
  it('refuses to clear a stored location while anything still depends on it', async () => {
    const h = await harness();
    const save = (fields: Record<string, string>): Promise<Response> =>
      h.form('/admin/weather', {
        weather_form: '1', weather_provider: 'nws', weather_units: 'imperial', ...fields,
      });

    expect((await save({ weather_enabled: '1', latitude: '51.5', longitude: '-0.1' })).status).toBe(302);

    const cleared = await save({ weather_enabled: '1' });
    expect(cleared.status).toBe(400);
    expect(await cleared.text()).toContain('That would clear the location');
    expect(
      (h.db.prepare(`SELECT latitude FROM household_settings WHERE id = 'singleton'`).get() as
        { latitude: number | null }).latitude,
      'the location is still there',
    ).toBe(51.5);

    // With both switches off there is nothing left to depend on it, so it goes.
    expect((await save({})).status).toBe(302);
    expect(
      (h.db.prepare(`SELECT latitude FROM household_settings WHERE id = 'singleton'`).get() as
        { latitude: number | null }).latitude,
    ).toBe(null);
  });

  it('accepts the same body once it carries the marker', async () => {
    const h = await harness();
    const saved = await h.form('/admin/weather', {
      weather_form: '1', weather_enabled: '1', latitude: '51.5', longitude: '-0.1',
      weather_provider: 'nws', weather_units: 'imperial',
    });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/admin/alerts?saved=weather');
  });
});

describe('an alert rule', () => {
  /**
   * "Turn off" turned the rule back on, and had since it was written.
   *
   * The card sends a *hidden* input rather than a checkbox — `1` to turn on,
   * the empty string to turn off — and the handler read presence-of-key, which
   * is the right reading for a checkbox and the wrong one here: the empty
   * string is still a string. So every "Turn off" in the ladder answered 302
   * and re-enabled the rule, and the card came back saying "Turn off" again.
   * Found by a review running it against the real app; nothing tested it.
   */
  it('turns off when the card says Turn off, and back on when it says Turn on', async () => {
    const h = await harness();
    // The shipped ladder, seeded the way boot seeds it.
    seedDefaultRules(h.db);
    const id = (h.db
      .prepare(`SELECT id FROM interrupt_rules WHERE trigger = 'nws' AND enabled = 1 LIMIT 1`)
      .get() as { id: string } | undefined)?.id;
    expect(id, 'the shipped ladder seeds at least one enabled NWS rule').toBeDefined();
    const enabled = (): number =>
      (h.db.prepare('SELECT enabled FROM interrupt_rules WHERE id = ?').get(id) as { enabled: number })
        .enabled;

    // Exactly what the card posts when it reads "Turn off".
    expect((await h.form(`/admin/alerts/rules/${id}`, { enabled: '' })).status).toBe(302);
    expect(enabled(), 'pressing Turn off must turn it off').toBe(0);

    expect((await h.form(`/admin/alerts/rules/${id}`, { enabled: '1' })).status).toBe(302);
    expect(enabled()).toBe(1);
  });
});

describe('the confirmation strip', () => {
  it('is what a save redirects to, and it names the thing that was saved', async () => {
    const h = await harness();
    const saved = await h.form('/admin/system/timezone', { timezone: 'Europe/Paris' });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/admin/system?saved=timezone');

    const page = await (await h.call('/admin/system?saved=timezone')).text();
    expect(page).toContain('Timezone saved.');
    expect(stripOf(page)).toContain('aria-live="polite"');
  });

  it('says nothing on the page a save did not land on', async () => {
    const h = await harness();
    expect(stripOf(await (await h.call('/admin/system')).text())).toBeUndefined();
    // And nothing for a token the application never mints — the value is only
    // ever a key into a table of literals, so there is nothing to inject and
    // nothing to echo, but a page that invented a confirmation for a stranger's
    // URL would be the dishonest half of the problem this solves.
    const crafted = await (await h.call('/admin/system?saved=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
    expect(stripOf(crafted)).toBeUndefined();
    expect(crafted, 'the token is a key, never text — nothing of it reaches the page').not.toContain('alert(1)');
  });

  it('keeps the rest of the query when it is dismissed', async () => {
    const h = await harness();
    // A page that is prefilled by a query parameter must still be prefilled
    // after the strip is dismissed.
    const page = await (await h.call('/admin/calendars?saved=calendar-added&sort=name')).text();
    const strip = stripOf(page) ?? '';
    expect(strip).toContain('Calendar added.');
    expect(strip).toContain('href="admin/calendars?sort=name"');
  });

  it('emits only relative hrefs, so ingress carries them', async () => {
    const h = await harness();
    const page = await (await h.call('/admin/calendars?saved=calendar-added')).text();
    const strip = stripOf(page) ?? '';
    expect(strip).toContain('href="admin/calendars"');
    // The one thing that would break the add-on: a leading slash resolves past
    // the ingress prefix and out of the application entirely.
    expect(strip).not.toMatch(/href="\//);
  });

  it('only ships the dirty-state script where there is a form to wire', async () => {
    const h = await harness();
    // The settings screens: a `<form data-dirty>` and therefore the script.
    for (const path of ['/admin/system', '/admin/alerts']) {
      const html = await (await h.call(path)).text();
      expect(html, path).toContain('assets/settings-form.js');
      expect(html, path).toMatch(/<form\b[^>]*data-dirty[\s=>]/);
    }
    /*
     * The wall editor: it has a `data-dirty-flag` span of its own and no
     * `form[data-dirty]` at all, so a plain `includes('data-dirty')` would
     * fetch and run the module on the two heaviest pages in the admin for
     * nothing.
     */
    const editor = await (await h.call('/admin/displays/default')).text();
    expect(editor).toContain('data-dirty-flag');
    expect(editor, 'nothing here for it to wire').not.toContain('assets/settings-form.js');
    // A page with neither, for the other direction.
    const people = await (await h.call('/admin/people')).text();
    expect(people).not.toContain('assets/settings-form.js');
  });

  it('has a sentence for every token, and every sentence reads as one', () => {
    // A token whose message is blank redirects, renders an empty strip, and
    // says exactly as much as no strip at all.
    for (const [key, message] of Object.entries(SAVED_MESSAGES)) {
      expect(message.length, `${key} says nothing`).toBeGreaterThan(3);
      expect(message.trim(), `${key} is not trimmed`).toBe(message);
      expect(message, `${key} is not a sentence`).toMatch(/[.!?]$/);
    }
    expect(Object.keys(SAVED_MESSAGES).length).toBeGreaterThan(3);
  });
});

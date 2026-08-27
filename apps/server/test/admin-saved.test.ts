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
import { seedDefaultRules, writeRule } from '../src/api/rules.js';
import { createPerson, saveShiftPlan } from '../src/api/queries.js';
import { watchEntity, writeHaSettings } from '../src/modules/homeassistant/store.js';
import { createTheme } from '../src/api/themes.js';

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
  const keyring = createKeyring(randomBytes(32));
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 's'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
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

  return { db, call, form, keyring };
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
   * The forecast job's backoff, for the same reason.
   *
   * `writeWeatherSettings` brings `weather-sync` forward so the panel fills in
   * without a wait — and did so on *any* save through it, which since the
   * alerts switch joined this form includes toggling alerts, or pressing Enter
   * on an untouched page. It is the cache being wrong (a move, a provider swap,
   * a units change) or the household asking to see it at all; anything else
   * already has the answer it needs.
   */
  it('brings the forecast refresh forward only when there is something to fetch', async () => {
    const h = await harness();
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO job_state (key, kind, next_run_at, consecutive_failures, created_at, updated_at)
         VALUES ('weather-sync', 'weather-sync', ?, 0, ?, ?)`,
      )
      .run(stamp, stamp, stamp);
    const nextRun = (): number =>
      (h.db.prepare(`SELECT next_run_at AS at FROM job_state WHERE kind = 'weather-sync'`).get() as
        { at: number }).at;
    const backOff = (): void => {
      h.db.prepare(`UPDATE job_state SET next_run_at = 9999999999 WHERE kind = 'weather-sync'`).run();
    };
    // `weather_enabled` is deliberately not in the base: it is a checkbox, so
    // "off" is its absence, and a base that always sent it would mean this test
    // never turned weather off at all.
    const save = (fields: Record<string, string>): Promise<Response> =>
      h.form('/admin/weather', {
        weather_form: '1', latitude: '51.5', longitude: '-0.1',
        weather_provider: 'nws', weather_units: 'imperial', ...fields,
      });

    // The coordinates land first, so the later saves change nothing the
    // provider would answer differently.
    await save({});
    backOff();
    await save({});
    expect(nextRun(), 'the same settings again is not a reason to ask').toBe(9999999999);

    // Asking to see it at all.
    await save({ weather_enabled: '1' });
    expect(nextRun(), 'a location arriving is the household asking').toBe(0);

    // An alerts toggle changes nothing the provider would answer differently.
    backOff();
    await save({ weather_enabled: '1', alerts_enabled: '1' });
    expect(nextRun(), 'an alerts toggle must not reset the forecast’s backoff').toBe(9999999999);

    // A units change makes the cached answer wrong.
    await save({ weather_enabled: '1', alerts_enabled: '1', weather_units: 'metric' });
    expect(nextRun(), 'the cache is for the old scale').toBe(0);
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

  /**
   * A closed list always has exactly one option selected, echo or no echo.
   *
   * A value matching no option selects nothing, and the browser then preselects
   * whatever comes first — over a live Save. That is the timezone defect one
   * screen along, and these two selects had it latently: only a body that is
   * not the screen's own form can carry a provider that is not one.
   */
  it('never hands back a select with nothing selected', async () => {
    const h = await harness();
    const refused = await h.form('/admin/weather', {
      weather_form: '1', weather_enabled: '1', latitude: '999', longitude: '-0.1',
      weather_provider: 'nonsense', weather_units: 'furlongs',
    });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    const selected = [...html.matchAll(/<option value="([^"]+)" selected>/g)].map((m) => m[1]);
    expect(selected, 'one provider and one unit, and both are ones a save would store').toEqual([
      'nws',
      'imperial',
    ]);
  });

  /**
   * Saving does not put a block back on a wall the household took it off.
   *
   * `writeWeatherSettings` adds the forecast strip to `display_blocks` when
   * weather is switched on — "enabling is the moment they asked for it", which
   * is right, and was written as `if (settings.enabled)`: true of the intent
   * and false of the code. So any later save with the switch still on re-added
   * it. Merging the alerts switch into this form made it reachable from a
   * second direction, since toggling alerts now writes weather settings too.
   */
  it('does not re-add the forecast block on a save that did not switch it on', async () => {
    const h = await harness();
    const blocks = (): string =>
      (h.db.prepare(`SELECT display_blocks AS b FROM household_settings WHERE id = 'singleton'`)
        .get() as { b: string | null }).b ?? '';
    const save = (fields: Record<string, string>): Promise<Response> =>
      h.form('/admin/weather', {
        weather_form: '1', weather_provider: 'nws', weather_units: 'imperial',
        latitude: '51.5', longitude: '-0.1', ...fields,
      });

    /*
     * The default install, which is the path that matters: `weather_enabled`
     * ships as 1 and `display_blocks` ships without `weather`, so the switch
     * never *moves* — a gate on its off→on transition would leave the strip off
     * every wall for ever, and this is the only writer of it. What the
     * household actually does is type a location.
     */
    expect(blocks(), 'the shipped order has no forecast strip in it').not.toContain('weather');
    await save({ weather_enabled: '1' });
    expect(blocks(), 'typing a location is what asks for the block').toContain('weather');

    // The household takes it off their wall, then comes back and saves again.
    h.db
      .prepare(`UPDATE household_settings SET display_blocks = 'now,next,horizon' WHERE id = 'singleton'`)
      .run();
    await save({ weather_enabled: '1', alerts_enabled: '1' });
    expect(blocks(), 'a save that changed the alerts switch is not "ask for the strip"').toBe(
      'now,next,horizon',
    );

    // And nor is re-saving the same location, or changing the units.
    await save({ weather_enabled: '1', weather_units: 'metric' });
    expect(blocks()).toBe('now,next,horizon');

    // Turning it off and on again *is*, because it was not usable in between.
    await save({});
    await save({ weather_enabled: '1' });
    expect(blocks(), 'switching weather back on asks for it again').toContain('weather');
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

  it('keeps a fragment, and puts the token where the server can read it', async () => {
    /*
     * Splitting on `?` alone turns `…#frag` into `…#frag?saved=key`: the token
     * lands inside the anchor, never reaches the server, and breaks the anchor
     * on the way. Latent today and not for long — the wall editor's
     * `layoutUrl()` already redirects to fragment paths, which is exactly the
     * set Phase 3b converts.
     */
    const { savedRedirect } = await import('../src/http/saved.js');
    const seen: string[] = [];
    const fake = {
      redirect: (url: string): Response => {
        seen.push(url);
        return new Response(null, { status: 302 });
      },
    } as unknown as Parameters<typeof savedRedirect>[0];

    savedRedirect(fake, '/admin/displays/s1#widgets', 'timezone');
    savedRedirect(fake, '/admin/displays/s1?tab=look#widgets', 'timezone');
    savedRedirect(fake, '/admin/system', 'timezone');
    expect(seen).toEqual([
      '/admin/displays/s1?saved=timezone#widgets',
      '/admin/displays/s1?tab=look&saved=timezone#widgets',
      '/admin/system?saved=timezone',
    ]);
  });

  it('keeps every value of a repeated parameter when it is dismissed', async () => {
    // `c.req.query()` keeps only the first, which would quietly drop the rest —
    // the opposite of what the dismiss link is for.
    const h = await harness();
    const page = await (
      await h.call('/admin/calendars?tag=a&saved=calendar-added&tag=b')
    ).text();
    expect(stripOf(page) ?? '').toContain('href="admin/calendars?tag=a&amp;tag=b"');
  });

  it('keeps the rest of the query when it is dismissed', async () => {
    const h = await harness();
    // A page that is prefilled by a query parameter must still be prefilled
    // after the strip is dismissed.
    const page = await (await h.call('/admin/calendars?saved=calendar-added&sort=name')).text();
    const strip = stripOf(page) ?? '';
    // The sentence out of the table rather than a copy of it: this test is
    // about the dismiss link keeping the rest of the query, and pinning the
    // wording here made rewording the confirmation fail a query-string test.
    expect(strip).toContain(SAVED_MESSAGES['calendar-added']);
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
    const editor = await (await h.call('/admin/walls/default')).text();
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

/**
 * The four destructive actions the RFC 009 3.3 audit found with no
 * confirmation at all — a shift rotation, a Home Assistant reading, a Home
 * Assistant rule, and disconnecting Home Assistant outright. Each now takes
 * the GET-then-POST shape `admin-chores.ts` set: an interstitial names what is
 * lost, the interstitial's own GET performs no mutation, and only the POST it
 * renders actually does the deleting.
 */
describe('destructive actions ask first', () => {
  it('removing a shift rotation names the person, changes nothing on GET, and only deletes on POST', async () => {
    const h = await harness();
    createPerson(h.db, 'p1', 'Alex', '#4C7FD1');
    saveShiftPlan(h.db, {
      id: 'plan1',
      personId: 'p1',
      name: "Alex's rotation",
      kind: 'pattern',
      anchorDate: '2026-01-01',
      cycle: ['day', null],
      calendarSourceId: null,
      matchers: null,
      effectiveFrom: '2000-01-01',
    });

    const interstitial = await (await h.call('/admin/shifts/plan1/delete')).text();
    expect(interstitial).toContain('Alex');
    expect(interstitial).toContain('action="admin/shifts/plan1/delete"');
    expect(interstitial).toContain('method="post"');
    expect(interstitial).toContain('btn-danger');

    // Looking at the confirmation page must not itself delete anything.
    expect(h.db.prepare(`SELECT COUNT(*) n FROM shift_plans WHERE id = 'plan1'`).get()).toEqual({ n: 1 });

    const removed = await h.form('/admin/shifts/plan1/delete', {});
    expect(removed.status).toBe(302);
    expect(removed.headers.get('location')).toBe('/admin/shifts?saved=shift-rotation-removed');
    expect(h.db.prepare(`SELECT COUNT(*) n FROM shift_plans WHERE id = 'plan1'`).get()).toEqual({ n: 0 });

    const page = await (await h.call('/admin/shifts?saved=shift-rotation-removed')).text();
    expect(page).toContain('Rotation removed.');
  });

  it('removing a Home Assistant reading names it, changes nothing on GET, and only removes on POST', async () => {
    const h = await harness();
    watchEntity(h.db, {
      entityId: 'sensor.porch',
      friendlyName: 'Porch temperature',
      label: null,
      displayMode: 'label_value',
    });

    const interstitial = await (
      await h.call(`/admin/home-assistant/entities/remove?entity_id=${encodeURIComponent('sensor.porch')}`)
    ).text();
    expect(interstitial).toContain('Porch temperature');
    expect(interstitial).toContain('action="admin/home-assistant/entities/remove"');
    expect(interstitial).toContain('method="post"');
    expect(interstitial).toContain('btn-danger');

    expect(
      h.db.prepare(`SELECT watched FROM ha_entity_cache WHERE entity_id = 'sensor.porch'`).get(),
    ).toEqual({ watched: 1 });

    const removed = await h.form('/admin/home-assistant/entities/remove', { entity_id: 'sensor.porch' });
    expect(removed.status).toBe(302);
    expect(removed.headers.get('location')).toBe('/admin/home-assistant?saved=ha-entity-removed');
    // Nothing referenced it, so `unwatchEntity` drops the row outright rather
    // than leaving a disabled one behind.
    expect(
      h.db.prepare(`SELECT COUNT(*) n FROM ha_entity_cache WHERE entity_id = 'sensor.porch'`).get(),
    ).toEqual({ n: 0 });
  });

  it('deleting a Home Assistant rule names it, changes nothing on GET, and only deletes on POST', async () => {
    const h = await harness();
    writeRule(h.db, {
      id: 'rule1',
      source: 'homeassistant',
      name: 'Garage left open',
      enabled: true,
      match: { entityId: 'binary_sensor.garage', condition: { kind: 'equals', value: 'on', between: null } },
      action: 'banner',
      piercesNightMode: false,
      minDwellSec: 0,
      dismissible: true,
      priority: 40,
    });

    const interstitial = await (await h.call('/admin/home-assistant/rules/rule1/delete')).text();
    expect(interstitial).toContain('Garage left open');
    expect(interstitial).toContain('action="admin/home-assistant/rules/rule1/delete"');
    expect(interstitial).toContain('method="post"');
    expect(interstitial).toContain('btn-danger');

    expect(h.db.prepare(`SELECT COUNT(*) n FROM interrupt_rules WHERE id = 'rule1'`).get()).toEqual({ n: 1 });

    const removed = await h.form('/admin/home-assistant/rules/rule1/delete', {});
    expect(removed.status).toBe(302);
    expect(removed.headers.get('location')).toBe('/admin/home-assistant?saved=ha-rule-removed');
    expect(h.db.prepare(`SELECT COUNT(*) n FROM interrupt_rules WHERE id = 'rule1'`).get()).toEqual({ n: 0 });
  });

  it('disconnecting Home Assistant restates what it destroys, changes nothing on GET, and only disconnects on POST', async () => {
    const h = await harness();
    writeHaSettings(h.db, h.keyring, {
      baseUrl: 'http://192.168.1.10:8123',
      token: 'a-token',
      allowPrivateNetwork: true,
    });
    watchEntity(h.db, {
      entityId: 'sensor.porch',
      friendlyName: 'Porch temperature',
      label: null,
      displayMode: 'label_value',
    });

    const interstitial = await (await h.call('/admin/home-assistant/disconnect')).text();
    // Restates the same consequence the status card's own helper text gives.
    expect(interstitial).toContain('deletes the stored token');
    expect(interstitial).toContain('readings on the wall');
    expect(interstitial).toContain('rules about your house');
    expect(interstitial).toContain('action="admin/home-assistant/disconnect"');
    expect(interstitial).toContain('method="post"');
    expect(interstitial).toContain('btn-danger');

    // Looking must not itself disconnect anything.
    expect(
      h.db.prepare(`SELECT token_encrypted AS t FROM ha_settings WHERE id = 'singleton'`).get(),
    ).not.toEqual({ t: null });

    const disconnected = await h.form('/admin/home-assistant/disconnect', {});
    expect(disconnected.status).toBe(302);
    expect(disconnected.headers.get('location')).toBe('/admin/home-assistant?saved=ha-disconnected');
    expect(
      h.db.prepare(`SELECT token_encrypted AS t FROM ha_settings WHERE id = 'singleton'`).get(),
    ).toEqual({ t: null });

    const page = await (await h.call('/admin/home-assistant?saved=ha-disconnected')).text();
    expect(page).toContain('Disconnected from Home Assistant.');
  });

  it('removing an unused theme says nothing is using it, changes nothing on GET, and only deletes on POST', async () => {
    const h = await harness();
    const theme = createTheme(h.db, {
      name: 'Sea glass',
      tokens: {
        '--bg': '#0B0E11', '--panel': '#151A21', '--rule': '#242D38', '--ink': '#E9EEF4',
        '--muted': '#7E8C9C', '--faint': '#4A5563', '--accent': '#E8A33D', '--s-day': '#E8A33D',
        '--s-night': '#4C7FD1', '--s-break': '#35916A', '--s-straight': '#6B7684', '--radius': '0.2rem',
      },
    });

    const interstitial = await (await h.call(`/admin/themes/${theme.id}/delete`)).text();
    expect(interstitial).toContain('Sea glass');
    expect(interstitial).toContain('Nothing is using it');
    expect(interstitial).toContain(`action="admin/themes/${theme.id}/delete"`);
    expect(interstitial).toContain('method="post"');
    expect(interstitial).toContain('btn-danger');

    expect(h.db.prepare(`SELECT COUNT(*) n FROM themes WHERE id = ?`).get(theme.id)).toEqual({ n: 1 });

    const removed = await h.form(`/admin/themes/${theme.id}/delete`, {});
    expect(removed.status).toBe(302);
    expect(removed.headers.get('location')).toBe('/admin/themes?saved=theme-removed');
    expect(h.db.prepare(`SELECT COUNT(*) n FROM themes WHERE id = ?`).get(theme.id)).toEqual({ n: 0 });
  });

  it('removing a theme in use names what switches to Board', async () => {
    const h = await harness();
    const theme = createTheme(h.db, {
      name: 'Sea glass',
      tokens: {
        '--bg': '#0B0E11', '--panel': '#151A21', '--rule': '#242D38', '--ink': '#E9EEF4',
        '--muted': '#7E8C9C', '--faint': '#4A5563', '--accent': '#E8A33D', '--s-day': '#E8A33D',
        '--s-night': '#4C7FD1', '--s-break': '#35916A', '--s-straight': '#6B7684', '--radius': '0.2rem',
      },
    });
    h.db.prepare(`UPDATE household_settings SET theme = ? WHERE id = 'singleton'`).run(`custom:${theme.id}`);
    const stamp = Date.now();
    h.db
      .prepare(
        `INSERT INTO screens (id, name, token_hash, token_issued_at, theme, created_at, updated_at)
         VALUES ('screen1', 'Kitchen', 'x', ?, ?, ?, ?),
                ('screen2', 'Lounge', 'y', ?, ?, ?, ?)`,
      )
      .run(stamp, `custom:${theme.id}`, stamp, stamp, stamp, `custom:${theme.id}`, stamp, stamp);

    const interstitial = await (await h.call(`/admin/themes/${theme.id}/delete`)).text();
    // A real sentence, not a bare comma-join — "and" before the last item,
    // and no lowercase word opening a paragraph.
    expect(interstitial).toContain(
      'In use by the household default, “Kitchen”, and “Lounge” — they switch to Board.',
    );
  });

  it('the Calendars list draws Remove and Sync now at different visual weights', async () => {
    const h = await harness();
    const added = await h.form('/admin/calendars', {
      action: 'save',
      name: 'Family',
      url: 'https://example.invalid/calendar.ics',
    });
    // A bad address is fine here — this is only checking the two buttons'
    // classes, and both are drawn whether or not the calendar tested well.
    expect([200, 302, 400]).toContain(added.status);

    const page = await (await h.call('/admin/calendars')).text();
    if (page.includes('Sync now')) {
      const syncButton = /<button class="([^"]*)"[^>]*>Sync now/.exec(page)?.[1] ?? '';
      const removeButton = /<button class="([^"]*)"[^>]*>Remove/.exec(page)?.[1] ?? '';
      expect(syncButton).not.toBe(removeButton);
      expect(removeButton).toContain('btn-danger');
    }
  });
});

/**
 * A representative sample of the mechanical sweep (RFC 009 Phase 3.2/3b):
 * screens that previously redirected on a real mutation and said nothing now
 * carry a confirmation token, on the real app rather than by reading the
 * table back to itself.
 */
describe('the mechanical sweep of confirmations', () => {
  it('confirms adding a person', async () => {
    const h = await harness();
    const added = await h.form('/admin/people', { name: 'Jamie', color: '#4C7FD1' });
    expect(added.status).toBe(302);
    expect(added.headers.get('location')).toBe('/admin/people?saved=person-added');
    const page = await (await h.call('/admin/people?saved=person-added')).text();
    expect(page).toContain('Person added.');
  });

  it('confirms adding a chore', async () => {
    const h = await harness();
    const added = await h.form('/admin/chores', { name: 'Bins', kind: 'daily' });
    expect(added.status).toBe(302);
    expect(added.headers.get('location')).toBe('/admin/chores?saved=chore-added');
    const page = await (await h.call('/admin/chores?saved=chore-added')).text();
    expect(page).toContain('Chore added.');
  });

  it('confirms adding a shift type', async () => {
    const h = await harness();
    const added = await h.form('/admin/shifts/types', {
      label: 'Swing', short_code: 'Sw', color: '#6b7684',
    });
    expect(added.status).toBe(302);
    expect(added.headers.get('location')).toBe('/admin/shifts/types?saved=shift-type-added');
  });
});

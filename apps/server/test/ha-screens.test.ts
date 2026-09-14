import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type SqliteDatabase } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { createSetupTokenHolder } from '../src/http/setup.js';
import { createKeyring, type Keyring } from '../src/secrets/keyring.js';
import { createFetcher } from '../src/net/fetcher.js';
import { seedDefaultRules } from '../src/api/rules.js';
import { watchTodoList } from '../src/modules/todo/index.js';
import {
  closeFakeHomeAssistants,
  fakeHomeAssistant,
  TOKEN,
  type FakeHa,
} from './fake-home-assistant.js';

/**
 * Where every exit from the Home Assistant screens lands (RFC 014 §5.1, §5.7).
 *
 * The screen split into a hub and five sub-screens, and the load-bearing
 * finding of the RFC is that it has **forty exits and every one of them named
 * one destination**: eleven `savedRedirect`s, seven bare `c.redirect`s, four
 * `confirmDestroyPage` Cancels and eighteen `render(…, 400)` sites. Splitting
 * the screen without splitting those puts every confirmation strip, every
 * not-found bounce and every Cancel on a page the household is no longer
 * standing on — silently, because the redirect works, the token is valid and
 * the sentence is true. Nothing fails. So this file is the table, driven
 * rather than described.
 *
 * **Forty rather than the RFC's thirty-eight**, and the correction is in the
 * `render(…, 400)` count: §5.7 says eighteen and the brief for the
 * implementation said sixteen. Counted from the file, it is eighteen — the two
 * that make sixteen a defensible number are the two whose *form* is not on the
 * screen that comes back (`POST …/lists` at the eight-list refusal, and
 * `POST …/calendars` on a calendar already added), because in both cases the
 * fixture that reaches the branch is the fixture that empties the form. Those
 * two are in the table with the screen's own identity asserted instead of its
 * form, and said so at the row.
 *
 * Driven against the real app with a real session and a real fake house, for
 * the reason `homeassistant.test.ts` gives: what has ever been wrong here is
 * the seam, and a stub of the client proves the client calls itself correctly.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const roots: string[] = [];
let nextAddress = 0;

afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  await closeFakeHomeAssistants();
});

const HUB = '/admin/home-assistant';
const CONNECTION = `${HUB}/connection`;
const READINGS = `${HUB}/readings`;
const CALENDARS = `${HUB}/calendars`;
const LISTS = `${HUB}/lists`;
const ALERTS = `${HUB}/alerts`;

/**
 * What each screen is, read off the page rather than guessed from the URL.
 *
 * The heading is the identity and the form action is the thing a hub cannot
 * fake — a 400 that re-renders the hub still has an `<h1>`, so asserting the
 * heading alone would pass on a page with no field the error message is about.
 */
const SCREEN = {
  hub: { heading: 'Home Assistant', form: null },
  connection: { heading: 'Connection and token', form: 'admin/home-assistant/connect' },
  readings: { heading: 'Readings', form: 'admin/home-assistant/entities' },
  calendars: { heading: 'Calendars', form: 'admin/home-assistant/calendars' },
  lists: { heading: 'To-do lists', form: 'admin/home-assistant/lists' },
  alerts: { heading: 'Tell me when…', form: 'admin/home-assistant/rules' },
} as const;

type ScreenKey = keyof typeof SCREEN;

interface Harness {
  readonly db: SqliteDatabase;
  readonly keyring: Keyring;
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
  readonly form: (path: string, fields: Record<string, string>) => Promise<Response>;
  readonly text: (path: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const address = `10.9.0.${++nextAddress}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'mw-ha-screens-'));
  roots.push(dataDir);
  const { db } = openDatabase({ dataDir });
  runMigrations(db, { dataDir, migrationsFolder: MIGRATIONS, waitTimeoutMs: 1000 });

  const stamp = Date.now();
  db.prepare(
    `INSERT INTO household_settings (id, created_at, updated_at) VALUES ('singleton', ?, ?)`,
  ).run(stamp, stamp);
  seedDefaultRules(db);

  const keyring = createKeyring(randomBytes(32));
  const fetcher = createFetcher();
  const setupToken = createSetupTokenHolder(() => {});
  const app = createApp({
    db,
    appVersion: '0.1.0-test',
    bootNotices: [],
    auth: { secret: 'a'.repeat(32), baseUrl: 'http://localhost' },
    keyring,
    fetcher,
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

  return { db, keyring, call, form, text: async (path) => (await call(path)).text() };
}

/** Connect through the form, the way a household with a mouse would. */
async function connect(h: Harness, ha: FakeHa): Promise<Response> {
  return h.form(`${HUB}/connect`, {
    base_url: ha.base,
    token: TOKEN,
    allow_lan: '1',
    accept_http: '1',
  });
}

/** A connected household with one of everything on it. */
async function connected(): Promise<{ h: Harness; ha: FakeHa; ruleId: string }> {
  const h = await harness();
  const ha = await fakeHomeAssistant();
  await connect(h, ha);
  await h.form(`${HUB}/entities`, { entity_id: 'sensor.kitchen_temperature', label: '', display_mode: '' });
  await h.form(`${HUB}/lists`, { entity_id: 'todo.shopping', label: 'Shopping' });
  await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only', label: 'Chores' });
  await h.form(`${HUB}/rules`, {
    name: 'Freezer door left open',
    entity_id: 'binary_sensor.freezer_door',
    condition: 'equals',
    value: 'on',
    for_minutes: '5',
    action: 'banner',
  });
  const row = h.db
    .prepare(`SELECT id FROM interrupt_rules WHERE name = 'Freezer door left open'`)
    .get() as { id: string } | undefined;
  expect(row, 'the fixture rule must exist for the rule exits to be drivable').toBeDefined();
  return { h, ha, ruleId: row?.id ?? '' };
}

/** The `<h1>` the shell drew, which is the screen saying which one it is. */
function headingOf(html: string): string {
  const match = /<h1>([^<]*)<\/h1>/.exec(html);
  return match?.[1] ?? '';
}

/**
 * The one `method="get"` form on a `confirmDestroyPage` is the Cancel. The
 * shell has none and the destroy form is a POST, so this cannot pick up
 * anything else — asserted rather than assumed, below.
 */
function cancelActionOf(html: string): string {
  const matches = [...html.matchAll(/<form method="get" action="([^"]+)"/g)];
  expect(matches.length, 'exactly one GET form — the Cancel — on a confirmation page').toBe(1);
  return matches[0]?.[1] ?? '';
}

/** Assert a 400 came back on the screen whose form was posted. */
async function refusedOn(
  response: Response,
  screen: Exclude<ScreenKey, 'hub'>,
  options: { readonly says: string; readonly formIsDrawn?: boolean } = { says: '' },
): Promise<void> {
  expect(response.status).toBe(400);
  const html = await response.text();
  const want = SCREEN[screen];
  expect(headingOf(html), `a refusal must come back on ${screen}`).toBe(want.heading);
  // Not the hub: the boundary card is the hub's alone, so its presence is the
  // one thing that says a refusal landed on a page with no field on it.
  expect(html, 'a refusal must not land on the hub').not.toContain('can tick one kind of box');
  expect(html, 'the error strip carries the refusal').toContain('<div class="error">');
  if (options.says !== '') expect(html).toContain(options.says);
  if (options.formIsDrawn !== false) {
    const at = html.indexOf(`action="${want.form}"`);
    expect(at, `${screen} must re-render its own form`).toBeGreaterThan(-1);
    expect(
      html.indexOf('<div class="error">'),
      'the error strip sits above the form it is about',
    ).toBeLessThan(at);
  }
}

// ---------------------------------------------------------------------------
// 1. The eleven exits that carry a token
// ---------------------------------------------------------------------------

describe('the eleven redirects that carry a token', () => {
  let h: Harness;
  let ha: FakeHa;
  let ruleId: string;

  beforeAll(async () => {
    ({ h, ha, ruleId } = await connected());
  });

  it('ha-connected lands on Connection', async () => {
    const response = await connect(h, ha);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${CONNECTION}?saved=ha-connected`);
  });

  it('ha-entity-added lands on Readings', async () => {
    const response = await h.form(`${HUB}/entities`, {
      entity_id: 'binary_sensor.under_sink',
      label: '',
      display_mode: '',
    });
    expect(response.headers.get('location')).toBe(`${READINGS}?saved=ha-entity-added`);
  });

  it('ha-entity-removed lands on Readings', async () => {
    const response = await h.form(`${HUB}/entities/remove`, { entity_id: 'binary_sensor.under_sink' });
    expect(response.headers.get('location')).toBe(`${READINGS}?saved=ha-entity-removed`);
  });

  it('ha-calendar-added still leaves for the Calendars page, which is unchanged', async () => {
    // The one redirect on these screens that already went somewhere else, and
    // it stays: a calendar's home is /admin/calendars and this is a shortcut
    // into it (RFC 014 §4.3).
    const response = await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: '' });
    expect(response.headers.get('location')).toBe('/admin/calendars?saved=ha-calendar-added');
  });

  it('order-saved lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.read_only')}/move`, { dir: 'up' });
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=order-saved`);
  });

  it('todo-list-removed lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.read_only')}/remove`, {});
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=todo-list-removed`);
  });

  it('todo-list-added lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only', label: 'Chores' });
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=todo-list-added`);
  });

  it('ha-rule-updated lands on Tell me when…', async () => {
    const response = await h.form(`${HUB}/rules/${encodeURIComponent(ruleId)}/toggle`, {});
    expect(response.headers.get('location')).toBe(`${ALERTS}?saved=ha-rule-updated`);
  });

  it('ha-rule-added lands on Tell me when…', async () => {
    const response = await h.form(`${HUB}/rules`, {
      name: 'Under the sink',
      entity_id: 'binary_sensor.under_sink',
      condition: 'equals',
      value: 'on',
      action: 'banner',
    });
    expect(response.headers.get('location')).toBe(`${ALERTS}?saved=ha-rule-added`);
  });

  it('ha-rule-removed lands on Tell me when…', async () => {
    const response = await h.form(`${HUB}/rules/${encodeURIComponent(ruleId)}/delete`, {});
    expect(response.headers.get('location')).toBe(`${ALERTS}?saved=ha-rule-removed`);
  });

  it('ha-disconnected lands on the hub, and that is the exception', async () => {
    /*
     * The one token that does not follow its form. After disconnecting there is
     * no connection, so Connection has nothing to show and the four content
     * screens have nothing in them — the hub is the one page that is still
     * true. Read together with Disconnect's *Cancel*, which goes the other way
     * for the same reason: what decides the destination is what is true
     * afterwards, not which page the form was on.
     */
    const response = await h.form(`${HUB}/disconnect`, {});
    expect(response.headers.get('location')).toBe(`${HUB}?saved=ha-disconnected`);
  });
});

// ---------------------------------------------------------------------------
// 2. The seven that carry none
// ---------------------------------------------------------------------------

describe('the seven exits that carry no token', () => {
  /*
   * Each fires when the thing named in the URL is not there — a double-tapped
   * Remove, a stale tab, a hand-typed id. Nothing happened, so there is nothing
   * for a strip to claim and they stay tokenless. What changes is only where
   * they land: a bounce to the hub after pressing Remove twice reads as the
   * button having thrown the household out of the screen.
   */
  it('a disconnect with no stored token goes to Connection', async () => {
    const h = await harness();
    const response = await h.call(`${HUB}/disconnect`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(CONNECTION);
  });

  it('a removal whose entity id does not shape goes to Readings', async () => {
    const { h } = await connected();
    const response = await h.call(`${HUB}/entities/remove?entity_id=`);
    expect(response.headers.get('location')).toBe(READINGS);
  });

  it('a removal for an entity nothing watches goes to Readings', async () => {
    const { h } = await connected();
    const response = await h.call(`${HUB}/entities/remove?entity_id=sensor.not_watched`);
    expect(response.headers.get('location')).toBe(READINGS);
  });

  it('a confirm page for a list nothing watches goes to To-do lists', async () => {
    const { h } = await connected();
    const response = await h.call(`${HUB}/lists/${encodeURIComponent('todo.nothing')}/remove`);
    expect(response.headers.get('location')).toBe(LISTS);
  });

  it('removing a list that is not watched goes to To-do lists', async () => {
    const { h } = await connected();
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.nothing')}/remove`, {});
    expect(response.headers.get('location')).toBe(LISTS);
  });

  it('a reorder in neither direction goes to To-do lists', async () => {
    const { h } = await connected();
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.shopping')}/move`, { dir: 'sideways' });
    expect(response.headers.get('location')).toBe(LISTS);
  });

  it('a delete page for a rule that is not there goes to Tell me when…', async () => {
    const { h } = await connected();
    const response = await h.call(`${HUB}/rules/nosuchrule/delete`);
    expect(response.headers.get('location')).toBe(ALERTS);
  });
});

// ---------------------------------------------------------------------------
// 3. The four Cancels
// ---------------------------------------------------------------------------

describe('the four Cancels return the household to the screen they came from', () => {
  it('Cancel on a disconnect goes to Connection, not the hub', async () => {
    // Cancelling a disconnect changes nothing, so the connection still exists
    // and Connection is still the true page — the opposite exception to
    // `ha-disconnected`, and the pair is the point.
    const { h } = await connected();
    expect(cancelActionOf(await h.text(`${HUB}/disconnect`))).toBe('admin/home-assistant/connection');
  });

  it('Cancel on removing a reading goes to Readings', async () => {
    const { h } = await connected();
    const html = await h.text(`${HUB}/entities/remove?entity_id=sensor.kitchen_temperature`);
    expect(cancelActionOf(html)).toBe('admin/home-assistant/readings');
  });

  it('Cancel on removing a to-do list goes to To-do lists', async () => {
    const { h } = await connected();
    const html = await h.text(`${HUB}/lists/${encodeURIComponent('todo.shopping')}/remove`);
    expect(cancelActionOf(html)).toBe('admin/home-assistant/lists');
  });

  it('Cancel on deleting a rule goes to Tell me when…', async () => {
    const { h, ruleId } = await connected();
    const html = await h.text(`${HUB}/rules/${encodeURIComponent(ruleId)}/delete`);
    expect(cancelActionOf(html)).toBe('admin/home-assistant/alerts');
  });
});

// ---------------------------------------------------------------------------
// 4. The eighteen refusals
// ---------------------------------------------------------------------------

describe('every refusal comes back on the screen its form is on', () => {
  describe('POST …/connect — five, all on Connection', () => {
    it('refuses an address that is not one', async () => {
      const h = await harness();
      await refusedOn(await h.form(`${HUB}/connect`, { base_url: '' }), 'connection', {
        says: 'The address of Home Assistant',
      });
    });

    it('refuses plain http without the consent', async () => {
      const h = await harness();
      const response = await h.form(`${HUB}/connect`, {
        base_url: 'http://192.168.1.10:8123',
        token: 'a-token',
      });
      await refusedOn(response, 'connection', { says: 'That address is not encrypted.' });
    });

    it('refuses a first connection with no token', async () => {
      const h = await harness();
      const response = await h.form(`${HUB}/connect`, { base_url: 'https://ha.example.com', token: '' });
      await refusedOn(response, 'connection', { says: 'Paste a long-lived access token.' });
    });

    it('refuses an address the guard will not resolve', async () => {
      const h = await harness();
      const response = await h.form(`${HUB}/connect`, {
        base_url: 'http://192.168.1.10:8123',
        token: 'a-token',
        accept_http: '1',
      });
      await refusedOn(response, 'connection', { says: '' });
    });

    it('refuses a connection that will not answer', async () => {
      const h = await harness();
      const ha = await fakeHomeAssistant();
      ha.down = true;
      const response = await h.form(`${HUB}/connect`, {
        base_url: ha.base,
        token: TOKEN,
        allow_lan: '1',
        accept_http: '1',
      });
      await refusedOn(response, 'connection', { says: '' });
    });
  });

  describe('POST …/entities — two, both on Readings', () => {
    it('refuses a body that does not shape', async () => {
      const { h } = await connected();
      await refusedOn(await h.form(`${HUB}/entities`, { entity_id: '' }), 'readings', { says: 'An entity' });
    });

    it('refuses a domain a wall cannot draw', async () => {
      const { h } = await connected();
      const response = await h.form(`${HUB}/entities`, { entity_id: 'automation.morning_routine' });
      await refusedOn(response, 'readings', { says: 'Choose an entity from the list.' });
    });
  });

  describe('POST …/calendars — three, all on Calendars', () => {
    it('refuses a body that does not shape', async () => {
      const { h } = await connected();
      await refusedOn(await h.form(`${HUB}/calendars`, { entity_id: '' }), 'calendars', { says: 'A calendar' });
    });

    it('refuses an id that is not a calendar', async () => {
      const { h } = await connected();
      const response = await h.form(`${HUB}/calendars`, { entity_id: 'sensor.kitchen_temperature' });
      await refusedOn(response, 'calendars', { says: 'Choose a calendar from the list.' });
    });

    it('refuses one that has already been added', async () => {
      const { h } = await connected();
      await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: '' });
      const response = await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: '' });
      // No add form to come back to: this is the branch where the only
      // calendar the house has is the one already added, so the section is an
      // `emptyState` saying so. The screen's own identity is what is asserted.
      await refusedOn(response, 'calendars', {
        says: 'That calendar has already been added.',
        formIsDrawn: false,
      });
    });
  });

  describe('POST …/lists — six, all on To-do lists', () => {
    it('refuses a body that does not shape', async () => {
      const { h } = await connected();
      await refusedOn(await h.form(`${HUB}/lists`, { entity_id: '' }), 'lists', { says: 'A to-do list' });
    });

    it('refuses an id that is not a to-do list', async () => {
      const { h } = await connected();
      const response = await h.form(`${HUB}/lists`, { entity_id: 'sensor.kitchen_temperature' });
      await refusedOn(response, 'lists', { says: 'Choose a to-do list from the list.' });
    });

    it('refuses while the house cannot be reached, and says which', async () => {
      // §5.3's unreachable-house path arriving through the 400 door rather than
      // the page door: the refusal *is* `live.problem`.
      const { h, ha } = await connected();
      ha.down = true;
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.shopping' });
      await refusedOn(response, 'lists', { says: '' });
    });

    it('refuses a list Home Assistant has not got', async () => {
      const { h } = await connected();
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.imaginary' });
      await refusedOn(response, 'lists', { says: 'Home Assistant has no to-do list by that name.' });
    });

    it('refuses a ninth list', async () => {
      const { h } = await connected();
      // Eight already watched, written straight to the store so the refusal is
      // the one under test rather than the house's own list of two.
      for (let i = 0; i < 8; i++) {
        watchTodoList(
          h.db,
          { entityId: `todo.filler_${i}`, name: `Filler ${i}`, label: null, supportsUpdate: true },
          Date.now(),
        );
      }
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.shopping' });
      // The add form is replaced by the "at most eight" hint on this branch by
      // construction — the state that reaches it is the state that removes the
      // form — so the screen is asserted by its heading and its own hint.
      await refusedOn(response, 'lists', { says: 'a wall reads at most 8', formIsDrawn: false });
    });

    it('refuses a list that was added and could not be read', async () => {
      const { h, ha } = await connected();
      ha.refuseItems = true;
      await h.form(`${HUB}/lists/${encodeURIComponent('todo.read_only')}/remove`, {});
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only', label: '' });
      await refusedOn(response, 'lists', { says: 'Added, but the list could not be read' });
      // The write succeeded and the status is still a refusal, so the page must
      // come back with the new row already on it rather than contradicting the
      // database it just wrote to.
      expect(
        h.db.prepare(`SELECT COUNT(*) n FROM ha_todo_lists WHERE entity_id = 'todo.read_only'`).get(),
      ).toEqual({ n: 1 });
    });
  });

  describe('POST …/rules — two, both on Tell me when…', () => {
    it('refuses a body that does not shape', async () => {
      const { h } = await connected();
      await refusedOn(await h.form(`${HUB}/rules`, { name: '' }), 'alerts', { says: '' });
    });

    it('refuses an entity outside the watchable set', async () => {
      const { h } = await connected();
      const response = await h.form(`${HUB}/rules`, {
        name: 'Morning routine',
        entity_id: 'automation.morning_routine',
        condition: 'equals',
        value: 'on',
        action: 'banner',
      });
      await refusedOn(response, 'alerts', { says: 'That entity is not one this can watch.' });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The one query this family has
// ---------------------------------------------------------------------------

describe('?template= keeps its meaning and changes its address', () => {
  it('the rows link to the alerts screen', async () => {
    const { h } = await connected();
    const html = await h.text(ALERTS);
    // Relative, so the single `<base>` decides where it points — which is what
    // lets the same markup work under a Home Assistant ingress prefix.
    expect(html).toContain('href="admin/home-assistant/alerts?template=garage"');
  });

  it('the hub answers an old link with a 302 that carries the query', async () => {
    // A link already in the world is a contract, and this one is the entire
    // interface the feature has. A household who bookmarked one, or a page left
    // open across the upgrade, must not meet a hub that silently ignores it.
    const { h } = await connected();
    const response = await h.call(`${HUB}?template=garage`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ALERTS}?template=garage`);
  });

  it('a bare hub GET is unchanged', async () => {
    const { h } = await connected();
    const response = await h.call(HUB);
    expect(response.status).toBe(200);
  });

  it('following the redirect fills the form in', async () => {
    const { h } = await connected();
    const html = await h.text(`${ALERTS}?template=garage`);
    expect(html).toContain('value="Garage door open late"');
    expect(html).toContain('type="time" name="from_time" value="23:00"');
    expect(html).toContain('type="time" name="to_time" value="06:00"');
    expect(html).toContain('<option value="takeover" selected>');
  });
});

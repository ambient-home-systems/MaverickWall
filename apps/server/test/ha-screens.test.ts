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

/**
 * A connected household with one of everything on it.
 *
 * **One** to-do list rather than both, deliberately: this house has exactly two
 * and the add form is only drawn when there is one left to offer, so a fixture
 * that watches both is a fixture in which no refusal from `POST …/lists` can
 * come back on a form. The tests that need the second watched add it
 * themselves.
 */
async function connected(): Promise<{ h: Harness; ha: FakeHa; ruleId: string }> {
  const h = await harness();
  const ha = await fakeHomeAssistant();
  await connect(h, ha);
  await h.form(`${HUB}/entities`, { entity_id: 'sensor.kitchen_temperature', label: '', display_mode: '' });
  await h.form(`${HUB}/lists`, { entity_id: 'todo.shopping', label: 'Shopping' });
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
): Promise<string> {
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
  return html;
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

  it('todo-list-added lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only', label: 'Chores' });
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=todo-list-added`);
  });

  it('order-saved lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.read_only')}/move`, { dir: 'up' });
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=order-saved`);
  });

  it('todo-list-removed lands on To-do lists', async () => {
    const response = await h.form(`${HUB}/lists/${encodeURIComponent('todo.read_only')}/remove`, {});
    expect(response.headers.get('location')).toBe(`${LISTS}?saved=todo-list-removed`);
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
      // No form: the picker's options *are* the house's lists, and a house that
      // cannot be reached offers none. The screen and its problem are what come
      // back, which is the honest answer rather than an empty picker.
      await refusedOn(response, 'lists', { says: '', formIsDrawn: false });
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
      // A list the house has and this household does not already watch — the
      // refusal only fires for a list that would be a *new* row.
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only' });
      // The add form is replaced by the "at most eight" hint on this branch by
      // construction — the state that reaches it is the state that removes the
      // form — so the screen is asserted by its heading and its own hint.
      await refusedOn(response, 'lists', { says: 'a wall reads at most 8', formIsDrawn: false });
    });

    it('refuses a list that was added and could not be read, with the new row on it', async () => {
      const { h, ha } = await connected();
      ha.refuseItems = true;
      const response = await h.form(`${HUB}/lists`, { entity_id: 'todo.read_only', label: 'Chores' });
      // Both of the house's lists are watched once this one is written, so
      // there is nothing left to offer and no form to come back to. What this
      // one has to show instead is the thing the RFC singles it out for: the
      // write succeeded and the status is still a refusal, so the page must
      // come back with the new row *already on it* rather than contradicting
      // the database it has just written to.
      const html = await refusedOn(response, 'lists', {
        says: 'Added, but the list could not be read',
        formIsDrawn: false,
      });
      expect(html, 'the row the write created must be on the page that refused it').toContain('Chores');
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

// ---------------------------------------------------------------------------
// 6. All six screens, in the three states a household can be in
// ---------------------------------------------------------------------------

const ALL: readonly { readonly path: string; readonly screen: ScreenKey }[] = [
  { path: HUB, screen: 'hub' },
  { path: CONNECTION, screen: 'connection' },
  { path: READINGS, screen: 'readings' },
  { path: CALENDARS, screen: 'calendars' },
  { path: LISTS, screen: 'lists' },
  { path: ALERTS, screen: 'alerts' },
];

describe('all six screens render for a connected household', () => {
  it.each(ALL)('$path', async ({ path, screen }) => {
    const { h } = await connected();
    const response = await h.call(path);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(headingOf(html)).toBe(SCREEN[screen].heading);
    expect(html, 'nothing on these screens is an unhandled throw').not.toContain('Something went wrong');
  });
});

describe('all six screens render for a household that has never connected', () => {
  /*
   * Every one of these is reachable with no connection, because the hub draws
   * all five rows unconditionally — which is a decision rather than a
   * convenience: `admin-vocabulary.test.ts` reaches pages by crawling `href`
   * out of the markup from a fixture that never connects a house, so a row
   * gated on `connected` is a route swept conditionally and the sweep would
   * quietly cover five fewer screens than it thinks it does.
   */
  it.each(ALL)('$path', async ({ path, screen }) => {
    const h = await harness();
    const response = await h.call(path);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(headingOf(html)).toBe(SCREEN[screen].heading);
  });

  it('the hub draws all five rows with nothing behind them', async () => {
    const h = await harness();
    const html = await h.text(HUB);
    for (const row of ['readings', 'calendars', 'lists', 'alerts', 'connection']) {
      expect(html, `the ${row} row must be drawn on a household with no connection`).toContain(
        `href="admin/home-assistant/${row}"`,
      );
    }
  });

  it('the four content screens say to connect first, and Connection offers the form', async () => {
    const h = await harness();
    for (const path of [READINGS, CALENDARS, LISTS, ALERTS]) {
      const html = await h.text(path);
      expect(html, path).toContain('Home Assistant is not connected yet.');
      expect(html, `${path} points at the one screen that can do anything about it`).toContain(
        'href="admin/home-assistant/connection"',
      );
    }
    // Connection is where you connect, so it is the one that does not say this.
    const connection = await h.text(CONNECTION);
    expect(connection).not.toContain('Home Assistant is not connected yet.');
    expect(connection).toContain('action="admin/home-assistant/connect"');
  });
});

describe('Home Assistant unreachable, with a token still stored', () => {
  /*
   * The case that matters and the one a split breaks: five new page functions
   * are five new chances to read `live.entities` without checking
   * `live.problem`. `look()` is built around being allowed to fail, and an
   * unreachable house must still render every stored setting on every one of
   * the six, so a household can fix an address they typed wrong.
   *
   * `ha.close()` rather than `ha.down = true`: a 502 comes from a server, and
   * this is no server at all, which is what an address with a typo in it
   * actually is.
   */
  async function unreachable(): Promise<{ h: Harness; base: string }> {
    const { h, ha } = await connected();
    await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: 'Family' });
    const base = ha.base;
    await ha.close();
    return { h, base };
  }

  it('renders all six, and every stored setting on every one of them', async () => {
    const { h, base } = await unreachable();

    for (const { path, screen } of ALL) {
      const response = await h.call(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(headingOf(html), path).toBe(SCREEN[screen].heading);
    }

    // The address survives so somebody can fix a typo.
    expect(await h.text(CONNECTION)).toContain(base);
    // The watched reading, the added calendar, the watched list and the rule
    // are all this database's own rows and are unaffected by a silent house.
    expect(await h.text(READINGS)).toContain('Kitchen temperature');
    const calendarsHtml = await h.text(CALENDARS);
    expect(calendarsHtml).toContain('Family');
    expect(calendarsHtml).toContain('calendar.family');
    expect(await h.text(LISTS)).toContain('Shopping');
    expect(await h.text(ALERTS)).toContain('Freezer door left open');
  });

  it('the hub keeps its four stored counts and never claims the house has none', async () => {
    const { h } = await unreachable();
    const html = await h.text(HUB);

    // Read from this database, and an unreachable house changes none of them.
    expect(html).toContain('1 reading');
    expect(html).toContain('1 added');
    expect(html).toContain('1 list');
    expect(html).toContain('1 rule');

    /*
     * And the two live counts are *unknown*, not zero. Both of `look()`'s
     * failure branches hand back `entities: []` and `calendars: []` beside the
     * problem, precisely so that the wrong version of this passes every
     * structural check — a row reading `live.entities.length` draws "0 readable
     * entities" for a household whose house is merely unreachable, which is a
     * false statement about their home in the one place they went to find out
     * what was wrong.
     */
    expect(html, 'a count of zero is a claim about the house').not.toContain('0 readable entities');
    expect(html).not.toContain('0 calendars in Home Assistant');
    expect(html).toContain('Home Assistant could not be reached just now.');
  });

  it('a connected house does carry the two live counts', async () => {
    // The other half of the pair: without this the row above passes on a hub
    // that never draws a live count at all.
    const { h } = await connected();
    const html = await h.text(HUB);
    expect(html).toContain('readable entities in your house.');
    expect(html).toContain('1 calendar in Home Assistant.');
  });
});

// ---------------------------------------------------------------------------
// 7. The back crumb, measured rather than matched
// ---------------------------------------------------------------------------

describe('the back crumb', () => {
  const CHILDREN = ALL.filter((entry) => entry.screen !== 'hub');

  it.each(CHILDREN)('$path carries exactly one, resolving to the hub', async ({ path }) => {
    const { h } = await connected();
    const html = await h.text(path);

    const crumbs = [...html.matchAll(/<a class="crumb crumb-back" href="([^"]*)"/g)];
    expect(crumbs.length, `${path} must carry exactly one back crumb`).toBe(1);

    /*
     * Resolved, not string-matched, and the skip link is why. Every page emits
     * a single `<base>` for ingress and a relative href resolves against *that*
     * — the markup reads as correct at every character and only the resolved
     * URL says otherwise. RFC 009's skip link was `href="#mw-main"`, which
     * resolved to `/#mw-main` and left the page entirely.
     */
    const baseMatch = /<base href="([^"]*)"/.exec(html);
    expect(baseMatch, 'every admin page emits one <base> for ingress').not.toBeNull();
    const resolved = new URL(crumbs[0]?.[1] ?? '', new URL(baseMatch?.[1] ?? '/', 'http://localhost'));
    expect(resolved.pathname, `${path}'s crumb resolves off the hub`).toBe(HUB);

    // And no second heading: `pageHeader` owns the back affordance, so a nested
    // page adds no header of its own and in particular no second hamburger.
    expect([...html.matchAll(/<h1>/g)].length, `${path} must have one <h1>`).toBe(1);
  });

  it('the hub carries none, because it is not nested in anything', async () => {
    const { h } = await connected();
    const html = await h.text(HUB);
    expect([...html.matchAll(/<a class="crumb crumb-back"/g)].length).toBe(0);
    expect([...html.matchAll(/<h1>/g)].length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. The picker mounts once
// ---------------------------------------------------------------------------

describe('the entity picker', () => {
  /*
   * The script mounts on an id. A page that ships the script without the div,
   * or the div without the script, fails in the way `<noscript>` fallbacks are
   * designed to hide — the datalist form is not rendered when script is
   * available, so the screen would show a heading and nothing under it.
   */
  it('is served by Readings, both halves of it', async () => {
    const { h } = await connected();
    const html = await h.text(READINGS);
    expect(html).toContain('id="ha-entity-picker"');
    expect(html).toContain('assets/ha-entity-picker.js');
  });

  it('is served by none of the other five, either half', async () => {
    const { h } = await connected();
    for (const { path } of ALL.filter((entry) => entry.screen !== 'readings')) {
      const html = await h.text(path);
      expect(html, `${path} must not mount the picker`).not.toContain('id="ha-entity-picker"');
      expect(html, `${path} must not ship the picker's script`).not.toContain('assets/ha-entity-picker.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The echo, asserted by what comes back rather than by the shape carrying it
// ---------------------------------------------------------------------------

describe('the two forms that hand a rejected body back', () => {
  it('Connection keeps the token when the address is refused', async () => {
    // The worst refusal on these screens: a long-lived access token is an
    // opaque string fetched out of another application, and losing it to a
    // mistyped port means going back for it.
    const h = await harness();
    const response = await h.form(`${HUB}/connect`, {
      base_url: 'http://192.168.1.10:8123',
      token: 'a-very-long-token-somebody-pasted',
      allow_lan: '1',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html, 'the token comes back in the field').toContain('a-very-long-token-somebody-pasted');
    expect(html, 'and so does the address that was refused').toContain('http://192.168.1.10:8123');
    // An unticked box is not sent at all, so the echo records the absence
    // rather than reading it off the body — this one *was* ticked.
    expect(html).toContain('name="allow_lan" value="1" checked');
  });

  it('the rule builder keeps the other six when the entity is refused', async () => {
    const { h } = await connected();
    const response = await h.form(`${HUB}/rules`, {
      name: 'Water under the sink',
      entity_id: 'automation.morning_routine',
      condition: 'changed_to',
      value: 'wet',
      for_minutes: '7',
      from_time: '22:30',
      to_time: '05:15',
      action: 'takeover',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('value="Water under the sink"');
    // The field that was actually refused, back exactly as typed — the mistake
    // is usually one character in a name they now need to see.
    expect(html).toContain('value="automation.morning_routine"');
    expect(html).toContain('value="wet"');
    expect(html).toContain('value="7"');
    expect(html).toContain('name="from_time" value="22:30"');
    expect(html).toContain('name="to_time" value="05:15"');
    // The two closed lists come back selected, because every value they carry
    // is an option by construction.
    expect(html).toContain('<option value="changed_to" selected>');
    expect(html).toContain('<option value="takeover" selected>');
  });

  it('a value no option carries selects nothing rather than whatever sorts first', async () => {
    /*
     * The limit RFC 009 records, checked rather than assumed: handing a rejected
     * value back into a `<select>` selects *nothing*, and the browser then
     * preselects whatever comes first over a live Save. So the two closed lists
     * are normalised to a known key or dropped.
     */
    const { h } = await connected();
    const response = await h.form(`${HUB}/rules`, {
      name: 'Nonsense',
      entity_id: 'automation.morning_routine',
      condition: 'equals',
      value: 'on',
      action: 'shout_about_it',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain('shout_about_it');
    expect(html, 'no action is selected, so the browser takes the first honestly')
      .not.toContain('selected>The whole wall, and wake it');
  });
});

// ---------------------------------------------------------------------------
// 10. The Calendars list (RFC 014 phase 2), across both screens
// ---------------------------------------------------------------------------

describe('the Calendars list', () => {
  /*
   * The round trip across *both* screens, because that is the claim. One screen
   * asserted against itself would pass just as happily on a list that renders
   * whatever it was handed a moment ago, which is the thing a list of somebody
   * else's rows can most easily be.
   *
   * Checked by reverting, which is what says these two are a gate rather than a
   * description. `calendarRows()` returning `''` reddens three: both of the
   * ones below and, one describe up, the unreachable house reading its own
   * stored row back. Dropping the `lastError` branch so no row is ever tagged
   * reddens exactly one — the second of these — and drawing the tag on every
   * row regardless reddens exactly the other, on its `not.toContain`. That
   * third mutation is the one worth running: a list that tags everything is a
   * list whose tag means nothing, and the round trip is the only assertion in
   * the file that can see it.
   */
  it('adds here, reads back here, and goes when the source goes on the Calendars page', async () => {
    const { h } = await connected();

    // Nothing added yet: no list, and no box saying "none yet" directly above
    // the form that adds one. Asserted on the *row*, not on the entity id —
    // which is on this page either way, as the add form's own `<option>`.
    const before = await h.text(CALENDARS);
    // Scoped to the row's own anchor: the sidebar links to /admin/calendars on
    // every page in the admin, so a bare href match is a match on the
    // navigation rather than on the list.
    expect(before, 'no row until something is added').not.toContain(
      'class="mw-row-link" href="admin/calendars"',
    );
    expect(before).toContain('action="admin/home-assistant/calendars"');

    const added = await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: 'Family' });
    expect(added.headers.get('location')).toBe('/admin/calendars?saved=ha-calendar-added');

    const listed = await h.text(CALENDARS);
    expect(listed, 'the name the household gave it').toContain('Family');
    expect(listed, 'and its entity id, as the detail').toContain('calendar.family');
    // Every row links to where the source is actually configured. This screen
    // adds and reports; it does not become a second place to edit one.
    expect(listed).toContain('class="mw-row-link" href="admin/calendars"');
    // Nothing has failed to read, so no tag: "it is added" and "it is working"
    // are two facts and only the second one is worth a badge.
    expect(listed).not.toContain('Not reading');

    // Removed where it is configured, and the sub-screen says so.
    const id = (
      h.db
        .prepare(`SELECT id FROM calendar_sources WHERE ha_entity_id = 'calendar.family'`)
        .get() as { id: string }
    ).id;
    const removed = await h.form(`/admin/calendars/${id}/delete`, {});
    expect(removed.status).toBe(302);
    const after = await h.text(CALENDARS);
    // The row, again — "Family" itself comes back the moment the house offers
    // the calendar again, as the add form's own option text.
    expect(after, 'the row is gone because the source is').not.toContain(
      'class="mw-row-link" href="admin/calendars"',
    );
    expect(after, 'and the house offers it again').toContain('value="calendar.family"');
  });

  it('tags one that has stopped reading, which is what makes the list worth drawing', async () => {
    const { h } = await connected();
    await h.form(`${HUB}/calendars`, { entity_id: 'calendar.family', name: 'Family' });
    h.db
      .prepare(`UPDATE calendar_sources SET last_error = ? WHERE ha_entity_id = 'calendar.family'`)
      .run('Home Assistant answered 404 for that calendar.');

    const html = await h.text(CALENDARS);
    // A Home Assistant calendar that has stopped reading was invisible on this
    // screen before the list existed.
    expect(html).toContain('Not reading');
  });
});

// ---------------------------------------------------------------------------
// 11. The one cross-screen link into this family (RFC 014 Appendix A item 5)
// ---------------------------------------------------------------------------

describe('the dashboard row about a failed read', () => {
  /*
   * Written because nothing caught it. Reverting the href to the hub — one
   * mutation of the six this change was checked against — left the whole suite
   * green, which is the definition of a claim with no test on it and exactly
   * the kind of thing Appendix A lists because "the claims nobody re-reads are
   * the ones that rot".
   *
   * It is the only link in the admin that points at this family for its
   * *content* rather than as a destination, which is why it is the one that
   * breaks: after the split the hub is no longer the page that says what came
   * back. Connection is, because it carries the address and the token somebody
   * has to fix.
   */
  it('sends a household to Connection, and its sentence names that screen', async () => {
    const { h } = await connected();
    h.db
      .prepare(`UPDATE ha_settings SET last_error = ? WHERE id = 'singleton'`)
      .run('Home Assistant answered 502.');

    const html = await h.text('/admin');
    expect(
      html,
      'the attention row must be drawn for a connection with a problem',
    ).toContain('Home Assistant is connected, with a problem');

    /*
     * The href and the title in one string, which is what `listRow` emits —
     * `<a class="mw-row-link" href="…">title</a>`. Asserted together so it
     * cannot pass on some *other* row's href happening to be on the page: this
     * dashboard links to /admin/calendars and /admin/walls too.
     */
    expect(html, 'the row leads to the screen that can fix it').toContain(
      'href="admin/home-assistant/connection">Home Assistant is connected, with a problem</a>',
    );
    expect(html, 'and the sentence names it').toContain(
      'Connection and token says what came back.',
    );
  });
});

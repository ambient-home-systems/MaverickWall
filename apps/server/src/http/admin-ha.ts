import type { Context, Hono } from 'hono';
import { confirmDestroyPage, errorBlock, escapeHtml, icon, networkAccessLabel, page, selectField, textField } from './html.js';
import { card, dataTable, destructive, emptyState, listRow, section, tag } from './components.js';
import { call, resolveConnection, testConnection, type ConnectionMode } from '../modules/homeassistant/client.js';
import {
  DISPLAY_MODES,
  domainOf,
  isSupported,
  parseStates,
  type DisplayMode,
  type HaState,
} from '../modules/homeassistant/entities.js';
import { parseCalendarList } from '../modules/homeassistant/calendars.js';
import {
  addHaCalendarSource,
  disconnectHa,
  haCalendarEntityIds,
  readHaCalendarSources,
  readHaSettings,
  readWatched,
  unwatchEntity,
  watchEntity,
  writeHaSettings,
} from '../modules/homeassistant/store.js';
import { deleteRule, readMatch, readRuleRows, setRuleEnabled, writeRule } from '../api/rules.js';
import {
  MAX_WATCHED_LISTS,
  moveTodoList,
  parseTodoEntities,
  pollTodoList,
  readTodoLists,
  unwatchTodoList,
  watchTodoList,
  type TodoEntity,
  type TodoListRow,
} from '../modules/todo/index.js';

/** JSON that may not be JSON. A rule nobody can read is a rule nobody can delete. */
function safeJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
import {
  parseWindow,
  RULE_TEMPLATES,
  type InterruptAction,
  type RuleTemplate,
} from './rule-templates.js';
import { randomBytes } from 'node:crypto';
import { checkbox, optionalText, parse, text, z } from '../validation.js';
import { readSaved, savedRedirect } from './saved.js';
import { ago, navModules, reorderMenuItems, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';
import { requiredNetworkOptions, type NetworkOption } from '@maverick-wall/core';

/**
 * "Turn on “X” below." — the calendar screens' remedy, in the shape this screen
 * can honour.
 *
 * `networkAccessSuggestion` is not reused verbatim because it ends "under
 * Network access below", and there is no Network access disclosure here: this
 * screen asks the question as one plain checkbox. What *is* reused is the only
 * part that matters — the label, read out of the table that renders it, so the
 * sentence quotes the words the household is looking at.
 *
 * Two options collapse to one sentence because one checkbox sets both flags:
 * `resolveConnection` reads `allow_lan` into `allowPrivateNetwork` *and*
 * `allowLoopback`, since a Home Assistant on this machine and a Home Assistant
 * on this network are one decision to a household. `allowHttp` never reaches
 * here — the plain-http consent is its own gate, several lines earlier — and is
 * dropped rather than mentioned, because a sentence naming a box that is not
 * the one being asked about is the fault this whole change is about.
 */
function networkRemedy(options: readonly NetworkOption[]): string | undefined {
  if (options.every((option) => option === 'allowHttp')) return undefined;
  return `If Home Assistant is inside your house, turn on “${networkAccessLabel('allowPrivateNetwork')}” below.`;
}

/** One schema per form on this screen. */
const connectBody = z.object({
  base_url: text('The address of Home Assistant', 2048),
  token: optionalText(4096),
  allow_lan: checkbox(),
  accept_http: checkbox(),
});

const watchBody = z.object({
  entity_id: text('An entity', 255),
  label: optionalText(60),
  display_mode: optionalText(20),
});

/**
 * The searchable picker's bulk add, as JSON rather than a form: a set of
 * entities and one display mode. A single entity may carry a custom label; a
 * batch takes each one's own name. Rejected, not coerced (rule five).
 */
const addManyBody = z.object({
  entities: z
    .array(z.object({ entity_id: text('An entity', 255), label: optionalText(60) }))
    .min(1)
    .max(50),
  display_mode: optionalText(20),
});

const calendarSourceBody = z.object({
  entity_id: text('A calendar', 255),
  name: optionalText(80),
});

/** A to-do list to watch: its entity id, and what the household calls it. */
const todoListBody = z.object({
  entity_id: text('A to-do list', 255),
  label: optionalText(60),
});

const ruleBody = z.object({
  name: text('What the wall should say', 60),
  entity_id: text('An entity', 255),
  condition: z.enum(['equals', 'above', 'below', 'changed_to'], {
    error: () => 'Choose a condition from the list.',
  }),
  value: text('A state or a number', 100),
  for_minutes: optionalText(4),
  from_time: optionalText(5),
  to_time: optionalText(5),
  action: z.enum(['banner', 'takeover', 'takeover_and_wake'], {
    error: () => 'Choose how loudly this should be shown.',
  }),
}).superRefine((value, ctx) => {
  // Two rules that are about the *combination*, which is the whole reason
  // this is a schema rather than four independent fields.
  if ((value.condition === 'above' || value.condition === 'below') && !Number.isFinite(Number(value.value))) {
    ctx.addIssue({ code: 'custom', message: 'Above and below need a number to compare with.' });
  }

  if (value.for_minutes !== undefined && !/^[0-9]{1,4}$/.test(value.for_minutes)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Enter the wait in whole minutes, or leave it empty.',
    });
  }

  /*
   * The overnight window is all-or-nothing.
   *
   * One time without the other is somebody who filled in half a thought, and
   * honouring it silently would give them a rule that fires at noon.
   */
  const half = (value.from_time === undefined) !== (value.to_time === undefined);
  if (half) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Give both times, or neither. Leaving them empty means the rule applies at any ' +
        'hour; to limit it to the night, set from 23:00 to 06:00.',
    });
    return;
  }
  if (value.from_time !== undefined && parseWindow({ from: value.from_time, to: value.to_time }) === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Those times are not a window. Use HH:MM, and make them different.',
    });
  }
});

/**
 * The Home Assistant screens — a hub and five children (RFC 014).
 *
 * This was one page doing five unrelated jobs: eight top-level blocks, of which
 * four were permanently-expanded add-forms, and nineteen form controls on
 * screen before a household touched anything. The two tallest blocks were the
 * two read exactly once — the Connect form and the boundary card — and both
 * were drawn on every visit for ever.
 *
 * `/admin/home-assistant` is now a landing page answering three questions — is
 * it connected, what is it putting on the wall, and what can it do to your
 * house — and each subject has a route of its own, reached by a `listRow` and
 * returned from by `pageHeader`'s back crumb:
 *
 *   …/connection  the address, the token, network access, Disconnect
 *   …/readings    the watched entities and the picker
 *   …/calendars   the Home Assistant calendars added, and the add form
 *   …/lists       the watched to-do lists, and the add form
 *   …/alerts      the rules, the templates, and the builder under them
 *
 * **Every POST keeps its path.** The only reason to move one would be
 * tidiness, and a household with a page open across the upgrade would have
 * their next submission 404 — rule nine, in the form it takes in an admin
 * rather than on a wall. What moved is where each of the forty exits *lands*,
 * which is `render`'s own note below.
 *
 * Server-rendered like every other admin screen, and the entity picker is a
 * `<datalist>` rather than a search box with a script behind it — a household
 * with four hundred entities gets type-ahead from the browser, and the page
 * still works on whatever is bolted to their wall.
 *
 * What this can and cannot do to a house is stated on the **hub** in as many
 * words, and the *can* is named rather than implied. It is the reason the token
 * is safe to store at all, so it is written where somebody deciding whether to
 * paste one can read it — which is the hub, where a household who has not
 * connected yet lands, and not `…/connection` one click further in. It is
 * exact, because a promise that overstates itself is one a household finds out
 * about by being surprised.
 */

const ACTIONS: readonly { key: InterruptAction; label: string }[] = [
  { key: 'banner', label: 'A strip above the calendar' },
  { key: 'takeover', label: 'The whole wall' },
  { key: 'takeover_and_wake', label: 'The whole wall, and wake it if it has gone dark' },
];

/**
 * The two closed lists in the rule builder, as keys.
 *
 * Derived from what the form actually renders — `ACTIONS` for one and the four
 * `option(…)` calls for the other — so an echo can be checked against the
 * options that exist rather than against a list somebody has to remember to
 * keep in step.
 */
const ACTION_KEYS: readonly InterruptAction[] = ACTIONS.map((entry) => entry.key);
const CONDITION_KEYS = ['equals', 'above', 'below', 'changed_to'] as const;

/** One `<option>`, selected when it is the one a template chose. */
function option(value: string, label: string, selected?: string): string {
  return (
    `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>` +
    `${escapeHtml(label)}</option>`
  );
}

/**
 * What disconnecting costs — stated once, so the settings card's hint and the
 * confirmation page can never drift into two different accounts of the same
 * consequence.
 */
const HA_DISCONNECT_CONSEQUENCE =
  'Disconnecting deletes the stored token, the readings on the wall, and any ' +
  'rules about your house. Calendars you added stay, and stop updating. ' +
  'Recovering means creating a new long-lived token and re-adding every entity ' +
  'and rule by hand.';

/**
 * What the household had on screen, for a form that comes back at 400.
 *
 * This screen has never echoed a rejected body back: all eighteen of its
 * refusals re-render from stored state, so somebody who mistypes an address is
 * handed back the address they had *before* they typed — which is
 * indistinguishable from a save that worked, and is the fault RFC 009 records
 * on Calendars and Weather and fixes there with `SourceEcho` and `WeatherEcho`.
 *
 * **Two forms get one and three do not**, and which follows from what a refusal
 * costs in typing. Connection is an address, a token and two consents, every
 * one of them typed or pasted, and the token is a long opaque string fetched
 * out of another application — losing it to a mistyped port is the worst
 * refusal here. The rule builder is eight fields, most of which a template may
 * have filled in. Readings, Calendars and To-do lists are one field, one field,
 * and a field plus an optional label, every one of them *chosen from a list*
 * rather than typed, so re-picking is a tap and an echo would be machinery
 * guarding nothing.
 *
 * Two shapes rather than one `HaEcho` with both forms' fields in it: a type
 * holding both would let a connect refusal carry rule values, which is the
 * "two that can disagree" the shape exists to avoid. Each travels as its own
 * parameter, the way `WeatherEcho` does.
 *
 * Raw strings on purpose — the whole point is to hand back the thing that
 * failed to parse.
 */
interface ConnectionEcho {
  readonly baseUrl: string;
  readonly token: string;
  /*
   * Checkboxes, and the case RFC 009 warns about from the other side: an
   * unticked box is not sent at all, so the echo has to *record the absence*
   * rather than read it off the body.
   */
  readonly allowLan: boolean;
  readonly acceptHttp: boolean;
}

interface RuleEcho {
  readonly name: string;
  readonly entityId: string;
  readonly condition: string;
  readonly value: string;
  readonly forMinutes: string;
  readonly fromTime: string;
  readonly toTime: string;
  readonly action: string;
}

/** A raw body field as a string — before any schema has had an opinion. */
function str(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === 'string' ? (body[key] as string) : '';
}

function connectionEchoOf(body: Record<string, unknown>): ConnectionEcho {
  return {
    baseUrl: str(body, 'base_url'),
    token: str(body, 'token'),
    allowLan: typeof body['allow_lan'] === 'string',
    acceptHttp: typeof body['accept_http'] === 'string',
  };
}

function ruleEchoOf(body: Record<string, unknown>): RuleEcho {
  return {
    name: str(body, 'name'),
    entityId: str(body, 'entity_id'),
    condition: str(body, 'condition'),
    value: str(body, 'value'),
    forMinutes: str(body, 'for_minutes'),
    fromTime: str(body, 'from_time'),
    toTime: str(body, 'to_time'),
    action: str(body, 'action'),
  };
}

interface PageError {
  readonly message: string;
  readonly suggestion?: string;
}

/**
 * What the screen knows when it is drawn.
 *
 * Fetched live rather than from the cache: somebody on this page has just
 * added an entity in Home Assistant and is looking for it. The whole page is
 * built around this being allowed to fail — an unreachable Home Assistant
 * still renders every stored setting, so a household can fix an address they
 * typed wrong.
 */
interface LiveState {
  readonly mode: ConnectionMode | null;
  readonly host: string | null;
  readonly entities: readonly HaState[];
  readonly calendars: readonly { entityId: string; name: string }[];
  /** The `todo.*` entities in the same `/api/states` the readings picker reads. */
  readonly todo: readonly TodoEntity[];
  readonly problem: PageError | null;
}

export function registerHaRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  async function look(): Promise<LiveState> {
    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      return {
        mode: null,
        host: null,
        entities: [],
        calendars: [],
        todo: [],
        problem:
          resolved.code === 'not-configured'
            ? null
            : {
                message: resolved.message,
                ...(resolved.suggestion !== undefined ? { suggestion: resolved.suggestion } : {}),
              },
      };
    }

    const connection = resolved.connection;
    const states = await call(deps.fetcher, connection, '/states');
    if (!states.ok) {
      return {
        mode: connection.mode,
        host: connection.host,
        entities: [],
        calendars: [],
        todo: [],
        problem: {
          message: states.message,
          ...(states.suggestion !== undefined ? { suggestion: states.suggestion } : {}),
        },
      };
    }

    const entities = parseStates(states.body).sort((a, b) =>
      a.friendlyName.localeCompare(b.friendlyName),
    );

    // The calendar list is a second request, and a cheap one. Failing it is not
    // worth failing the page over — the entity picker is still usable.
    const list = await call(deps.fetcher, connection, '/calendars');
    return {
      mode: connection.mode,
      host: connection.host,
      entities,
      calendars: list.ok ? parseCalendarList(list.body) : [],
      // The same document, read the other way: `parseStates` keeps the domains
      // a reading can be and drops `todo`, and this keeps `todo` alone.
      todo: parseTodoEntities(states.body),
      problem: null,
    };
  }

  /** The response all six of these screens answer with. */
  function html(body: string, status?: number): Response {
    return new Response(body, {
      status: status ?? 200,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
  }

  /**
   * The shell the five children share.
   *
   * `pageHeader`'s `back` rather than a paragraph at the top of the body, which
   * is the other way this repository has done it (`admin-shifts.ts`'s
   * `typesPage`). Both draw an arrow and a label; only this one puts it in the
   * app bar, where `pageHeader` decided it goes, and only this one survives a
   * household scrolling — the app bar is sticky and a paragraph is not. It is
   * also the whole back affordance: a nested page adds no header of its own
   * and, in particular, no second hamburger.
   *
   * `nav` stays `'homeassistant'` on all six, so the sidebar marks Integrations
   * › Home Assistant active throughout rather than going blank one level down.
   */
  function child(c: Context, heading: string, error: PageError | undefined, body: string): string {
    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: `${heading} — Maverick Wall`,
      nav: 'homeassistant',
      heading,
      back: { label: 'Home Assistant', href: 'admin/home-assistant' },
      saved: readSaved(c),
      body: (error === undefined ? '' : errorBlock(error.message, error.suggestion)) + body,
    });
  }

  /*
   * One render function per screen, rather than one `render()` with a screen
   * argument (RFC 014 §5.7).
   *
   * There were forty exits from this file and every one of them named one
   * destination. Eighteen of those are `render(…, 400)` sites, and a 400 is
   * sharper than a redirect: the browser stays on the POST URL and draws
   * whatever comes back, so a site left pointing at the whole screen puts
   * "Paste a long-lived access token." above a page with no token field on it
   * and the only way back to the field the sentence is about is a link the
   * household has to find. A misrouted redirect costs a navigation; a
   * misrouted 400 costs the form. A separate function per screen is what makes
   * that a choice somebody makes at each call site rather than a default.
   */
  async function renderHub(c: Context): Promise<Response> {
    const live = await look();
    return html(hubPage(c, live));
  }

  async function renderConnection(
    c: Context,
    error?: PageError,
    status?: number,
    echo?: ConnectionEcho,
  ): Promise<Response> {
    const live = await look();
    return html(
      child(c, 'Connection and token', error ?? live.problem ?? undefined, connectionScreen(live, echo)),
      status,
    );
  }

  async function renderReadings(c: Context, error?: PageError, status?: number): Promise<Response> {
    const live = await look();
    return html(
      child(c, 'Readings', error ?? live.problem ?? undefined, connectedOr(live, () => readings(live))),
      status,
    );
  }

  async function renderCalendars(c: Context, error?: PageError, status?: number): Promise<Response> {
    const live = await look();
    return html(
      child(c, 'Calendars', error ?? live.problem ?? undefined, connectedOr(live, () => calendars(live))),
      status,
    );
  }

  async function renderLists(c: Context, error?: PageError, status?: number): Promise<Response> {
    const live = await look();
    return html(
      child(c, 'To-do lists', error ?? live.problem ?? undefined, connectedOr(live, () => todoLists(live))),
      status,
    );
  }

  async function renderAlerts(
    c: Context,
    error?: PageError,
    status?: number,
    template?: RuleTemplate,
    echo?: RuleEcho,
  ): Promise<Response> {
    const live = await look();
    return html(
      child(
        c,
        'Tell me when…',
        error ?? live.problem ?? undefined,
        connectedOr(live, () => rules(live, template, echo)),
      ),
      status,
    );
  }

  /**
   * The hub, and the one query this family has.
   *
   * A template row's whole effect is to fill in a form, and after the split
   * that form is on `…/alerts` — so the rows link there. But a link already in
   * the world is a contract, and this one is the *entire* interface the feature
   * has: it is what makes a template script-free, and a household who
   * bookmarked one, or a page left open across the upgrade, must not meet a hub
   * that silently ignores the query. So the hub carries it through, unaltered,
   * and a bare hub GET is untouched.
   *
   * Any non-empty key redirects, including one this version does not know:
   * `…/alerts` draws an empty form for a template it cannot find, which is a
   * better answer to a stale bookmark than a hub that drops the query on the
   * floor.
   */
  app.get('/admin/home-assistant', async (c: Context) => {
    const template = c.req.query('template');
    if (template !== undefined && template !== '') {
      return c.redirect(`/admin/home-assistant/alerts?template=${encodeURIComponent(template)}`, 302);
    }
    return renderHub(c);
  });

  app.get('/admin/home-assistant/connection', async (c: Context) => renderConnection(c));
  app.get('/admin/home-assistant/readings', async (c: Context) => renderReadings(c));
  app.get('/admin/home-assistant/calendars', async (c: Context) => renderCalendars(c));
  /*
   * A GET at a path that is already a POST, which is correct and is the shape
   * every other sub-screen here has (`/admin/shifts/types` is a GET and a
   * POST). Called out because a reader scanning the route list will see `lists`
   * twice and should not "fix" it.
   */
  app.get('/admin/home-assistant/lists', async (c: Context) => renderLists(c));

  /**
   * A template is a query parameter, not a script.
   *
   * Choosing one re-renders the form with its fields already filled in, which
   * is the whole of "prefill" without a line of JavaScript. The household can
   * change every one of them before saving — a template is a starting point,
   * and the hard part of a rule builder is not the fields but knowing that a
   * freezer door is worth five minutes and a leak is worth none.
   *
   * It re-renders a page whose form is *visible* when it lands now, which was
   * the point of moving it: on the old screen the builder sat below three
   * hundred pixels of templates on a four-thousand-pixel page, so on a phone
   * the thing that had just happened was off-screen.
   */
  app.get('/admin/home-assistant/alerts', async (c: Context) => {
    const chosen = RULE_TEMPLATES.find((entry) => entry.key === c.req.query('template'));
    return renderAlerts(c, undefined, undefined, chosen);
  });

  /**
   * Save the address and the token, but only if they work.
   *
   * Tested before storing, for the same reason a calendar feed is: somebody
   * pasting a long-lived access token has no way to know whether they copied
   * the whole thing, and a connection that silently does not work looks
   * identical to a Home Assistant with nothing in it.
   */
  app.post('/admin/home-assistant/connect', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const settings = readHaSettings(deps.db);

    const echo = connectionEchoOf(body);

    const shaped = parse(connectBody, body);
    if (!shaped.ok) {
      return renderConnection(c,
        { message: shaped.message, suggestion: 'Usually something like http://192.168.1.10:8123' },
        400,
        echo,
      );
    }
    const baseUrl = shaped.value.base_url.replace(/\/+$/, '');

    /*
     * Plain http needs saying out loud, once.
     *
     * A long-lived access token is sent on every request, and over http it
     * crosses the household's network in clear — anything on their wifi can
     * read it, and it controls their house. Almost every Home Assistant is at
     * an http address, so refusing outright would make this unusable; a
     * checkbox they have to tick is the honest middle. It is not stored,
     * because it is consent for this address rather than a setting.
     */
    if (baseUrl.startsWith('http://') && !shaped.value.accept_http) {
      return renderConnection(c,
        {
          message: 'That address is not encrypted.',
          suggestion:
            'A Home Assistant token controls your whole house and is sent with every ' +
            'request. Over plain http anything on your network can read it. Turn on ' +
            `“${networkAccessLabel('allowHttp')}” below to use it anyway on a network you trust.`,
        },
        400,
        echo,
      );
    }

    const token = shaped.value.token ?? '';
    if (token === '' && !settings.hasToken) {
      return renderConnection(c,
        {
          message: 'Paste a long-lived access token.',
          suggestion:
            'In Home Assistant: your profile, then Security, then "Create token" at the bottom.',
        },
        400,
        echo,
      );
    }

    writeHaSettings(deps.db, deps.keyring, {
      baseUrl,
      ...(token === '' ? {} : { token }),
      allowPrivateNetwork: shaped.value.allow_lan,
    });

    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      /*
       * `resolveConnection` hands back `validateOutboundUrl`'s message, which is
       * a diagnosis and nothing more. The remedy names a checkbox, and only this
       * layer knows what that checkbox is called — see `networkRemedy`.
       *
       * Asked against the policy the household just submitted, so a switch they
       * have already ticked is never named: `requiredNetworkOptions` reports
       * what is still missing rather than what the address needs in the
       * abstract.
       */
      const suggestion =
        (resolved.code === 'bad-address'
          ? // Only for the address. `key-lost` is the other way this fails, and
            // its own suggestion — restore the backup's key, make a new token —
            // is the last thing that should be swapped for a checkbox.
            networkRemedy(
              requiredNetworkOptions(baseUrl, {
                allowHttp: true,
                allowPrivateNetwork: shaped.value.allow_lan,
                allowLoopback: shaped.value.allow_lan,
              }),
            )
          : undefined) ?? resolved.suggestion;
      return renderConnection(c,
        {
          message: resolved.message,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
        400,
        echo,
      );
    }

    const proved = await testConnection(deps.fetcher, resolved.connection);
    if (!proved.ok) {
      /*
       * Stored, then reported.
       *
       * Discarding it would mean somebody with a typo in a token loses the
       * whole address too and starts again. The connection is marked with its
       * failure and the page says what went wrong, which is recoverable.
       */
      deps.db
        .prepare(
          `UPDATE ha_settings SET last_error = ?, updated_at = ? WHERE id = 'singleton'`,
        )
        .run(proved.message, now());
      // The URL gate could not have answered this one: the name looks public
      // and only the resolver says otherwise, so the options come off the
      // outcome rather than off the address.
      const suggestion = networkRemedy(proved.networkOptions ?? []) ?? proved.suggestion;
      return renderConnection(c,
        {
          message: proved.message,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
        400,
        echo,
      );
    }

    return savedRedirect(c, '/admin/home-assistant/connection', 'ha-connected');
  });

  /**
   * Disconnecting is destroying, not a setting — the token, every reading on
   * the wall, and every rule about the house all go with it, which is exactly
   * what the status card's own helper text has always said. A one-click
   * neutral button on that sentence was the sharpest gap this RFC found, so it
   * now asks first, quoting the same consequence rather than inventing a
   * second account of it.
   */
  app.get('/admin/home-assistant/disconnect', (c: Context) => {
    // Nothing to disconnect, so nothing happened and there is nothing for a
    // strip to claim — but it lands on Connection, where a household who
    // double-tapped can see the state they are actually in.
    if (!readHaSettings(deps.db).hasToken) return c.redirect('/admin/home-assistant/connection', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Disconnect Home Assistant',
        nav: 'homeassistant',
        heading: 'Disconnect Home Assistant?',
        intro: HA_DISCONNECT_CONSEQUENCE,
        destroyAction: 'admin/home-assistant/disconnect',
        destroyLabel: 'Disconnect it',
        /*
         * The opposite exception to `ha-disconnected` below, and the pair is
         * the point. Cancelling a disconnect changes nothing, so the connection
         * still exists and Connection is still the true page; the token for the
         * disconnect that actually happened goes to the hub. What decides a
         * destination is what is true afterwards, not which page the form was
         * on.
         */
        cancelAction: 'admin/home-assistant/connection',
        cancelLabel: 'Keep it connected',
      }),
    );
  });

  app.post('/admin/home-assistant/disconnect', (c: Context) => {
    disconnectHa(deps.db);
    /*
     * The one token on these screens that does not follow its own form.
     *
     * After disconnecting there is no connection, so Connection has nothing to
     * show and the four content screens have nothing in them. The hub is the
     * one page that is still true; sending them back to Connection would leave
     * a household on a page whose whole subject has just been deleted.
     */
    return savedRedirect(c, '/admin/home-assistant', 'ha-disconnected');
  });

  app.post('/admin/home-assistant/entities', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const watched = parse(watchBody, body);
    if (!watched.ok) return renderReadings(c, { message: watched.message }, 400);

    const entityId = watched.value.entity_id;
    if (!isSupported(entityId)) {
      return renderReadings(c,
        {
          message: 'Choose an entity from the list.',
          suggestion:
            'Sensors, binary sensors, weather, people and device trackers. ' +
            'Anything else is not a reading a wall can show.',
        },
        400,
      );
    }

    const mode = watched.value.display_mode ?? '';
    const label = watched.value.label;
    const live = await look();
    const known = live.entities.find((state) => state.entityId === entityId);

    watchEntity(deps.db, {
      entityId,
      friendlyName: known?.friendlyName ?? entityId,
      label: label ?? null,
      displayMode: (DISPLAY_MODES.some((option) => option.key === mode)
        ? mode
        : 'label_value') as DisplayMode,
    });
    return savedRedirect(c, '/admin/home-assistant/readings', 'ha-entity-added');
  });

  /**
   * Add several entities at once, from the searchable picker.
   *
   * A JSON POST answered as JSON: the caller is a `fetch` that reloads the page
   * on success, not a browser following a redirect. Each unsupported id is
   * skipped rather than failing the batch — the picker only offers supported
   * ones, so a stray is a race, not a mistake worth stopping on.
   */
  app.post('/admin/home-assistant/entities/add', async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ message: 'That did not look like a request the picker makes.' }, 400);
    }
    const shaped = parse(addManyBody, raw);
    if (!shaped.ok) return c.json({ message: shaped.message }, 400);

    const mode = shaped.value.display_mode ?? '';
    const displayMode = (DISPLAY_MODES.some((option) => option.key === mode)
      ? mode
      : 'label_value') as DisplayMode;
    const live = await look();

    let added = 0;
    for (const entity of shaped.value.entities) {
      if (!isSupported(entity.entity_id)) continue;
      const known = live.entities.find((state) => state.entityId === entity.entity_id);
      watchEntity(deps.db, {
        entityId: entity.entity_id,
        friendlyName: known?.friendlyName ?? entity.entity_id,
        label: entity.label ?? null,
        displayMode,
      });
      added++;
    }
    return c.json({ ok: true, added });
  });

  /**
   * Removing a reading asks first — the same GET-then-POST shape as every
   * other destructive control, in place of the one-click "Remove" the card
   * used to post directly.
   */
  app.get('/admin/home-assistant/entities/remove', (c: Context) => {
    const queried = parse(z.object({ entity_id: text('An entity', 255) }), {
      entity_id: c.req.query('entity_id') ?? '',
    });
    if (!queried.ok) return c.redirect('/admin/home-assistant/readings', 302);
    const entityId = queried.value.entity_id;
    const watched = readWatched(deps.db).find((row) => row.entityId === entityId && row.watched === 1);
    if (watched === undefined) return c.redirect('/admin/home-assistant/readings', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove reading',
        nav: 'homeassistant',
        heading: `Remove “${watched.label ?? watched.friendlyName ?? watched.entityId}”?`,
        intro: 'It stops showing on the wall. Any rule that watches this entity is untouched.',
        destroyAction: 'admin/home-assistant/entities/remove',
        destroyFields: `<input type="hidden" name="entity_id" value="${escapeHtml(entityId)}">`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/home-assistant/readings',
      }),
    );
  });

  app.post('/admin/home-assistant/entities/remove', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const removal = parse(z.object({ entity_id: text('An entity', 255) }), body);
    if (removal.ok) unwatchEntity(deps.db, removal.value.entity_id);
    return savedRedirect(c, '/admin/home-assistant/readings', 'ha-entity-removed');
  });

  app.post('/admin/home-assistant/calendars', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const picked = parse(calendarSourceBody, body);
    if (!picked.ok) return renderCalendars(c, { message: picked.message }, 400);
    const entityId = picked.value.entity_id;
    if (!entityId.startsWith('calendar.')) {
      return renderCalendars(c, { message: 'Choose a calendar from the list.' }, 400);
    }
    if (haCalendarEntityIds(deps.db).has(entityId)) {
      return renderCalendars(c, { message: 'That calendar has already been added.' }, 400);
    }

    const live = await look();
    const known = live.calendars.find((entity) => entity.entityId === entityId);
    addHaCalendarSource(deps.db, {
      entityId,
      name: picked.value.name ?? known?.name ?? entityId,
    });
    return savedRedirect(c, '/admin/calendars', 'ha-calendar-added');
  });

  /**
   * Watch a to-do list, and read it once before saying so (RFC 012).
   *
   * The first read runs inline rather than waiting for the job, so the token
   * on the redirect is a claim about a branch that has already happened: a list
   * whose first read fails is stored — its row shows the failure and the job
   * keeps trying — and the page is rendered with that failure, never with
   * "added" over a list nothing has read. The same shape as `connect`, which
   * stores the address and then reports the token it could not prove.
   */
  app.post('/admin/home-assistant/lists', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const picked = parse(todoListBody, body);
    if (!picked.ok) return renderLists(c, { message: picked.message }, 400);
    const entityId = picked.value.entity_id;
    if (!/^todo\.[a-z0-9_]+$/.test(entityId)) {
      return renderLists(c, { message: 'Choose a to-do list from the list.' }, 400);
    }

    const live = await look();
    // A house that cannot be reached is not a house with no lists in it. §5.3's
    // unreachable-house path, arriving through the 400 door rather than the
    // page door: the refusal *is* `live.problem`.
    if (live.problem !== null) return renderLists(c, live.problem, 400);
    const known = live.todo.find((entity) => entity.entityId === entityId);
    if (known === undefined) {
      return renderLists(c,
        {
          message: 'Home Assistant has no to-do list by that name.',
          suggestion: 'Pick one from the list below; they come from your Home Assistant as it is now.',
        },
        400,
      );
    }

    const watched = watchTodoList(deps.db, {
      entityId,
      name: known.name,
      label: picked.value.label ?? null,
      supportsUpdate: known.supportsUpdate,
    }, now());
    if (!watched.ok) return renderLists(c, { message: watched.message }, 400);

    const read = await pollTodoList(
      { db: deps.db, fetcher: deps.fetcher, keyring: deps.keyring, now: now() },
      entityId,
    );
    if (!read.ok) {
      // The write succeeded and the status is still a refusal, so this one must
      // come back with the new row already on it — the page contradicting
      // neither itself nor the database it has just written to.
      return renderLists(c,
        {
          message: `Added, but the list could not be read: ${read.message}`,
          suggestion: 'It stays on this page and is tried again every minute. Nothing shows on a wall until a read works.',
        },
        400,
      );
    }
    return savedRedirect(c, '/admin/home-assistant/lists', 'todo-list-added');
  });

  /**
   * Removing a list asks first — the same GET-then-POST shape as every other
   * destructive control here. The id rides in the path, which is what
   * `destructive()` expects and the readings' query-parameter form cannot give
   * it (see the note in `readings`).
   */
  app.get('/admin/home-assistant/lists/:entity/remove', (c: Context) => {
    const entityId = decodeURIComponent(c.req.param('entity') ?? '');
    const row = readTodoLists(deps.db).find((list) => list.entityId === entityId);
    if (row === undefined) return c.redirect('/admin/home-assistant/lists', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Remove to-do list',
        nav: 'homeassistant',
        heading: `Stop showing “${row.label ?? row.name}”?`,
        intro:
          'It comes off every wall and panel that shows it, and any To-do widget set ' +
          'to it is left out until you pick another list there. The list itself stays ' +
          'in Home Assistant, untouched.',
        destroyAction: `admin/home-assistant/lists/${encodeURIComponent(entityId)}/remove`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/home-assistant/lists',
        cancelLabel: 'Keep showing it',
      }),
    );
  });

  app.post('/admin/home-assistant/lists/:entity/remove', (c: Context) => {
    const entityId = decodeURIComponent(c.req.param('entity') ?? '');
    // Only a list that is watched can be removed, and the token says so: a
    // POST for an unknown id lands back on the page with nothing announced.
    const known = readTodoLists(deps.db).some((list) => list.entityId === entityId);
    if (!known) return c.redirect('/admin/home-assistant/lists', 302);
    unwatchTodoList(deps.db, entityId);
    return savedRedirect(c, '/admin/home-assistant/lists', 'todo-list-removed');
  });

  app.post('/admin/home-assistant/lists/:entity/move', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const entityId = decodeURIComponent(c.req.param('entity') ?? '');
    const dir = body['dir'];
    if (dir !== 'up' && dir !== 'down') return c.redirect('/admin/home-assistant/lists', 302);
    moveTodoList(deps.db, entityId, dir, now());
    // `order-saved` is shared with every other screen that has an Up/Down, so
    // its *sentence* stays shared and only this call site moves.
    return savedRedirect(c, '/admin/home-assistant/lists', 'order-saved');
  });

  app.post('/admin/home-assistant/rules', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const echo = ruleEchoOf(body);

    const shaped = parse(ruleBody, body);
    if (!shaped.ok) return renderAlerts(c, { message: shaped.message }, 400, undefined, echo);

    const { name, entity_id: entityId, condition, value, action } = shaped.value;
    // Membership rather than shape: which domains this can watch is a fact
    // about the application, not about the request.
    if (!isSupported(entityId)) {
      return renderAlerts(c, { message: 'That entity is not one this can watch.' }, 400, undefined, echo);
    }

    const minutes = shaped.value.for_minutes;
    const between =
      shaped.value.from_time === undefined
        ? null
        : parseWindow({ from: shaped.value.from_time, to: shaped.value.to_time });

    /*
     * Stored through the shared writer, in the shared model.
     *
     * A Home Assistant rule and a weather rule are the same row in the same
     * table read by the same evaluator — the only difference is which clause of
     * `match` is filled in. That is the abstraction being claimed, and writing
     * it through a Home-Assistant-specific path here would quietly have made it
     * untrue.
     */
    writeRule(deps.db, {
      id: randomBytes(8).toString('hex'),
      source: 'homeassistant',
      name,
      enabled: true,
      match: { entityId, condition: { kind: condition, value, between } },
      action,
      piercesNightMode: action === 'takeover_and_wake',
      // `undefined` now, not `''` — an empty field is absent once the schema
      // has read it, and `Number(undefined)` is NaN rather than zero.
      minDwellSec: minutes === undefined || minutes === '0' ? 0 : Number(minutes) * 60,
      dismissible: true,
      // Ordering matters only when two fire at once, which is rare enough that
      // asking about it would be a field nobody could answer. A takeover
      // outranks a banner, which is the only ordering anybody means.
      priority: action === 'banner' ? 40 : action === 'takeover' ? 60 : 90,
    });

    // The entity has to be polled or the rule can never fire, and it would look
    // exactly like an entity that is simply fine.
    deps.db
      .prepare(
        `INSERT INTO ha_entity_cache (entity_id, friendly_name, watched, fetched_at)
         VALUES (?, ?, 0, 0) ON CONFLICT(entity_id) DO NOTHING`,
      )
      .run(entityId, entityId);
    deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'ha-sync'`).run();

    return savedRedirect(c, '/admin/home-assistant/alerts', 'ha-rule-added');
  });

  /**
   * Deleting a rule asks first — the same GET-then-POST shape as every other
   * destructive control, in place of the one-click "Delete" the card used to
   * post directly.
   */
  app.get('/admin/home-assistant/rules/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const row = readRuleRows(deps.db).find((candidate) => candidate.id === id);
    if (row === undefined) return c.redirect('/admin/home-assistant/alerts', 302);
    return c.html(
      confirmDestroyPage({
        self: selfHref(c),
        modules: navModules(deps.db),
        title: 'Delete rule',
        nav: 'homeassistant',
        heading: `Delete “${row.name}”?`,
        intro: 'The wall stops watching for it. This cannot be undone; you can always add it again.',
        destroyAction: `admin/home-assistant/rules/${encodeURIComponent(id)}/delete`,
        destroyLabel: 'Delete it',
        cancelAction: 'admin/home-assistant/alerts',
      }),
    );
  });

  app.post('/admin/home-assistant/rules/:id/delete', (c: Context) => {
    deleteRule(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/home-assistant/alerts', 'ha-rule-removed');
  });

  app.post('/admin/home-assistant/rules/:id/toggle', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const toggled = parse(z.object({ enabled: checkbox() }), body);
    setRuleEnabled(deps.db, c.req.param('id') ?? '', toggled.ok && toggled.value.enabled);
    return savedRedirect(c, '/admin/home-assistant/alerts', 'ha-rule-updated');
  });

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  function hubPage(c: Context, live: LiveState): string {
    const settings = readHaSettings(deps.db);

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Home Assistant — Maverick Wall',
      nav: 'homeassistant',
      heading: 'Home Assistant',
      saved: readSaved(c),
      body:
        // The problem still leads the hub, because the status card below says
        // "Connected" for a house that cannot be reached — `look()` keeps the
        // mode and loses the readings — and a card claiming that over nothing
        // is the thing the strip is for.
        (live.problem === null ? '' : errorBlock(live.problem.message, live.problem.suggestion)) +
        status(live, settings.lastSyncAt) +
        section('What your house puts on the wall', undefined, hubRows(live)) +
        boundary(),
    });
  }

  /**
   * A sub-screen with no connection behind it.
   *
   * All five rows on the hub are drawn whether or not Home Assistant is
   * connected, so every one of these is reachable with nothing behind it —
   * deliberately. A row that is not drawn reads as a broken link to a household
   * who remembers it being there, and `admin-vocabulary.test.ts` reaches pages
   * by crawling links out of the markup from a fixture that never connects a
   * house: a row gated on `connected` is a route swept conditionally, which is
   * a sweep getting weaker with nothing failing.
   *
   * So an unconnected sub-screen says so and points at the one screen that can
   * do anything about it, which is the shape `emptyState` is for.
   */
  function connectedOr(live: LiveState, draw: () => string): string {
    if (live.mode === null) {
      return emptyState('Home Assistant is not connected yet.', {
        label: 'Connect it',
        href: 'admin/home-assistant/connection',
      });
    }
    return draw();
  }

  /** "3 readings", "1 list" — a count that says what it is counting. */
  function counted(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  /**
   * The half of a row's `detail` that is a reading of the *house*, and only two
   * rows carry one.
   *
   * A count of what the household has set up is a read of this database; a
   * count of what their house currently offers is a read of the house.
   * Conflating them is what makes a count wrong in the one situation somebody
   * consults it — both of `look()`'s failure branches hand back `entities: []`
   * and `calendars: []` *beside* the problem, so a row reading
   * `live.entities.length` draws "0 readable entities" for a household whose
   * house is merely unreachable. A false statement about their home, in the one
   * place they went to find out what was wrong, in the register of a fact.
   *
   * Under a problem it says so; with nothing connected there is no house to
   * count and it says nothing at all, which is a third answer rather than a
   * shade of zero.
   */
  function houseSays(live: LiveState, count: () => string): string {
    if (live.problem !== null) return ' Home Assistant could not be reached just now.';
    if (live.mode === null) return '';
    return ` ${count()}`;
  }

  /**
   * The five rows, which are the counts the old screen made you scroll to find.
   *
   * No new component: a hub of labelled rows with counts is exactly `listRow`
   * with an `href` and a trailing `tag`, which is what that component is for.
   */
  function hubRows(live: LiveState): string {
    const watched = readWatched(deps.db).filter((row) => row.watched === 1).length;
    const added = haCalendarEntityIds(deps.db).size;
    const lists = readTodoLists(deps.db).length;
    const ruleCount = readRuleRows(deps.db).filter(
      (row) => row.trigger === 'homeassistant' || row.trigger === 'ha_entity',
    ).length;

    return (
      listRow(
        '',
        {
          title: 'Readings',
          detail:
            'Temperatures, doors and who is in, beside the calendar.' +
            houseSays(live, () => counted(live.entities.length, 'readable entity', 'readable entities') + ' in your house.'),
          href: 'admin/home-assistant/readings',
        },
        tag(counted(watched, 'reading', 'readings')),
      ) +
      listRow(
        '',
        {
          title: 'Calendars',
          detail:
            'Already in Home Assistant, added without finding an address.' +
            houseSays(live, () => counted(live.calendars.length, 'calendar', 'calendars') + ' in Home Assistant.'),
          href: 'admin/home-assistant/calendars',
        },
        tag(`${added} added`),
      ) +
      listRow(
        '',
        {
          title: 'To-do lists',
          detail: 'Read every minute, and drawn by the To-do widget wherever you put one.',
          href: 'admin/home-assistant/lists',
        },
        tag(counted(lists, 'list', 'lists')),
      ) +
      listRow(
        '',
        {
          title: 'Tell me when…',
          detail: 'The wall interrupts itself for things worth walking over for.',
          href: 'admin/home-assistant/alerts',
        },
        tag(counted(ruleCount, 'rule', 'rules')),
      ) +
      listRow(
        '',
        {
          title: 'Connection and token',
          /*
           * The one row whose words are computed rather than written, because
           * "Address, token and network access" is a lie on an add-on where
           * there is no token to manage — and a row that says something untrue
           * about the install it is on is worse than one that says less.
           */
          detail:
            live.mode === 'supervisor'
              ? 'Reached through the supervisor. There is nothing to configure and no token to manage.'
              : live.mode === 'manual'
                ? 'The address of Home Assistant, its token, and what this may reach.'
                : 'Not connected yet. An address and a long-lived access token are all it takes.',
          href: 'admin/home-assistant/connection',
        },
      )
    );
  }

  /**
   * Connection: the address, the token, the two consents, and Disconnect.
   *
   * Disconnect moves here from the status card, which is where a household
   * reading "is it working" had the irreversible action under their thumb. The
   * hub answers that question and this screen is the one that can change it.
   *
   * Under the supervisor there is no form to draw, and the screen *says so*
   * rather than coming back empty — on the old page that branch simply omitted
   * a section, which reads fine inside a long page and reads as a broken link
   * when the row is the only reason you navigated here.
   */
  function connectionScreen(live: LiveState, echo?: ConnectionEcho): string {
    if (live.mode === 'supervisor') {
      return card(
        `<h2>Reached through the supervisor</h2>` +
        `<p>Maverick Wall is running as a Home Assistant add-on, so it talks to ` +
        `Home Assistant directly. There is nothing to configure here and no token ` +
        `to manage.</p>`,
      );
    }
    return (
      connectionForm(readHaSettings(deps.db), echo) +
      (live.mode === 'manual'
        ? section(
            'Disconnect',
            undefined,
            destructive('Disconnect', {
              thing: 'Home Assistant',
              confirmAction: 'admin/home-assistant/disconnect',
              variant: 'button',
            }) + `<p class="hint">${escapeHtml(HA_DISCONNECT_CONSEQUENCE)}</p>`,
          )
        : '')
    );
  }

  /**
   * The boundary, stated first and stated exactly.
   *
   * Before the form, not after it, because it is the thing that decides
   * whether pasting a token here is a reasonable thing to do — and it is the
   * only claim on this page that somebody has to take on trust.
   *
   * It used to read "Maverick Wall reads. It cannot control anything", which
   * was true when the answer was none. Rule 12 permits exactly one write now,
   * so the heading names it. A boundary that rounds "one thing" down to
   * "nothing" is not reassurance, it is the claim a household would discover
   * was wrong — and `ha-claims.test.ts` fails on the old wording rather than
   * trusting anybody to remember this paragraph.
   */
  function boundary(): string {
    return card(
      `<h2>Maverick Wall reads, and can tick one kind of box.</h2>` +
      `<ul class="plain">` +
      `<li>The one thing it will ever change in Home Assistant is ticking an item ` +
      `off a to-do list you have chosen to show on a wall — ` +
      `<code>todo.update_item</code>, and that is the whole list. Nothing in this ` +
      `version does it yet: the limit is written down first so it cannot grow ` +
      `quietly later.</li>` +
      `<li>No switches, no scenes, no lights, no locks, no covers, no cameras. ` +
      `Not off by default — there is no code in this application that can do ` +
      `any of them.</li>` +
      `<li>The wall receives <strong>resolved values</strong> — “19.4 °C”, “Closed”. ` +
      `It never receives your token, an entity name, or any way to ask Home ` +
      `Assistant a question of its own.</li>` +
      `<li>Your token is stored encrypted, and never appears in a log, an error ` +
      `message, or the diagnostics export.</li>` +
      `</ul>` +
      `<p class="hint">A Home Assistant long-lived access token has full control of ` +
      `your home and cannot be limited to reading. That is why the limit is on this ` +
      `side: if a wall in your hallway were ever compromised, the worst it could do ` +
      `is give away your indoor temperature and tick something off your shopping ` +
      `list.</p>`,
    );
  }

  /**
   * The counts used to be one middle-dotted `.sub` line — exactly the
   * anti-pattern `dataTable`'s own doc-comment names, and the same fix as the
   * System screen's version card: labels down the left, figures on a common
   * right edge.
   *
   * **It carried "Readable entities" and "Calendars" until RFC 014, and they
   * are gone** — not for length, but because the hub's Readings and Calendars
   * rows now carry exactly those two numbers, read from exactly the same
   * `live`. Two readers of one fact side by side on one page is this project's
   * most repeated bug, and the count belongs on the row it is a count *of*,
   * where it answers "of how many" beside the number the household has set up.
   * Measured on a 390px phone: the duplication was 165px of preamble above the
   * first row, on the one screen everybody lands on.
   *
   * What is left is the two facts the rows do not carry and cannot: which house
   * this is, and whether it is still being read.
   */
  function statusReadings(live: LiveState, lastSyncAt: number | null): (readonly string[])[] {
    const rows: (readonly string[])[] = [];
    if (live.mode === 'manual') {
      rows.push(['Host', `<span class="host">${escapeHtml(live.host ?? '')}</span>`]);
    }
    if (lastSyncAt !== null) {
      rows.push(['Last read', escapeHtml(ago(lastSyncAt, now()))]);
    }
    return rows;
  }

  function status(live: LiveState, lastSyncAt: number | null): string {
    if (live.mode === 'supervisor') {
      return card(
        `<h2>Connected — running as an add-on</h2>` +
        `<p>Home Assistant is reached through the supervisor. There is nothing to ` +
        `configure and no token to manage.</p>` +
        dataTable([{ label: 'Reading' }, { label: 'Value', numeric: true }], statusReadings(live, lastSyncAt)),
      );
    }
    if (live.mode === 'manual') {
      // No Disconnect and no consequence hint: both are on Connection now. A
      // household reading "is it working" should not have the irreversible
      // action under their thumb.
      return card(
        `<h2>Connected</h2>` +
        dataTable([{ label: 'Reading' }, { label: 'Value', numeric: true }], statusReadings(live, lastSyncAt)),
      );
    }
    return card(`<h2>Not connected</h2><p>Nothing from your house is on the wall.</p>`);
  }

  function connectionForm(settings: ReturnType<typeof readHaSettings>, echo?: ConnectionEcho): string {
    // The echo wins wherever there is one, so a 400 hands the form back exactly
    // as it was left; with none, the stored row is the form.
    const baseUrl = echo?.baseUrl ?? settings.baseUrl ?? '';
    const allowLan = echo?.allowLan ?? settings.allowPrivateNetwork;
    // `accept_http` is consent for *this* address rather than a setting, so it
    // is never stored and has nothing to fall back to — which is exactly why an
    // echo matters here: a refusal that untick it makes a household tick it
    // twice to learn the same thing.
    const acceptHttp = echo?.acceptHttp ?? false;
    return section(
      'Connect',
      undefined,
      `<form method="post" action="admin/home-assistant/connect">` +
      textField({
        label: 'Address of Home Assistant',
        name: 'base_url',
        required: true,
        placeholder: 'http://192.168.1.10:8123',
        value: baseUrl,
        hint:
          'Use the IP address. Names ending in .local are resolved by the device ' +
          'you are browsing from rather than by this server, so they usually will ' +
          'not work here.',
      }) +
      textField({
        label: 'Long-lived access token',
        name: 'token',
        type: 'password',
        hint: 'In Home Assistant: your profile, then Security, then “Create token” at the bottom of the page.',
        /*
         * Handed back on a refusal, which is the worst loss on this screen: a
         * long-lived access token is an opaque string fetched out of another
         * application, and losing it to a mistyped port means going back for it.
         */
        ...(echo === undefined ? {} : { value: echo.token }),
        ...(settings.hasToken
          ? { placeholder: 'Stored — leave empty to keep it' }
          : { required: true }),
        attrs: 'autocomplete="off"',
      }) +

      /*
       * Two of the same three switches the calendar screens ask about, so they
       * carry the same names — read out of the table that renders them there
       * rather than restated, because a control this screen calls something
       * else is a control an error message cannot point at.
       *
       * What stays different is the *consequence*, which genuinely is: a
       * calendar address over http is a feed URL, and this one is a token that
       * controls a house. That clause is the reason the box exists, so it is
       * kept word for word and the label is prefixed to it.
       *
       * One box for two flags on purpose: `resolveConnection` opens loopback
       * with the same setting, because a Home Assistant on this machine and a
       * Home Assistant on this network are one decision to a household.
       */
      `<div class="checks">` +
      `<label><input type="checkbox" name="allow_lan" value="1"` +
      `${allowLan ? ' checked' : ''}> ` +
      `${escapeHtml(networkAccessLabel('allowPrivateNetwork'))} — Home Assistant is inside your house</label>` +
      `<label><input type="checkbox" name="accept_http" value="1"${acceptHttp ? ' checked' : ''}> ` +
      `${escapeHtml(networkAccessLabel('allowHttp'))} — I understand the token crosses my network unencrypted</label>` +
      `</div>` +
      `<button type="submit">Connect</button></form>`,
    );
  }

  /**
   * The picker.
   *
   * A first-party script turns the entity list — hundreds of them — into a
   * searchable, domain-filtered, multi-select picker that shows each entity's
   * live state, the same pattern the layout editor uses. The data is handed in
   * as JSON on the mount; the script fetches nothing and ships in the image
   * (rule three). A `<datalist>` fallback stays in `<noscript>`, so the page
   * still works with no script, just without the search.
   */
  function readings(live: LiveState): string {
    const watched = readWatched(deps.db).filter((row) => row.watched === 1);

    /*
     * The destructive Remove is a hand-built form rather than `destructive()`,
     * because the target here is `?entity_id=…`, a query parameter, and
     * `destructive()`'s lead button has nowhere to carry a hidden field — its
     * form has no fields at all, only an action. A GET form with no fields
     * replaces the action URL's own query with the (empty) serialised field set
     * on submission, so embedding the id in `confirmAction`'s query string would
     * silently submit with no `entity_id` at all. The rule and calendar deletes
     * below take their id from the *path* instead, which is exactly what
     * `destructive()` expects.
     *
     * It rides in the ⋮ overflow all the same, matching every other list of
     * cards here — a household scanning a list of watched entities should not
     * read a full-weight Remove per row — with the ellipsis and the entity-
     * naming accessible name `destructive()` would have given it.
     */
    const rows = watched
      .map((row) => {
        const label = row.label ?? row.friendlyName ?? row.entityId;
        return card(
          `<div class="card-head"><div class="card-head-main">` +
          `<h2>${escapeHtml(label)}</h2>` +
          `<p class="sub">${escapeHtml(row.state ?? '—')}` +
          `${row.unitOfMeasurement === null ? '' : ' ' + escapeHtml(row.unitOfMeasurement)}` +
          `${row.fetchedAt === 0 ? ' · not read yet' : ' · read ' + escapeHtml(ago(row.fetchedAt, now()))}</p>` +
          `<p class="host">${escapeHtml(row.entityId)}</p>` +
          `</div>` +
          `<details class="ovf" data-overflow>` +
          `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
          `aria-label="More actions for ${escapeHtml(label)}" title="More">${icon('more')}</summary>` +
          `<div class="ovf-menu" role="menu">` +
          `<form method="get" action="admin/home-assistant/entities/remove">` +
          `<input type="hidden" name="entity_id" value="${escapeHtml(row.entityId)}">` +
          `<button class="ovf-item is-danger" type="submit" ` +
          `aria-label="Remove ${escapeHtml(label)}">Remove…</button></form>` +
          `</div></details></div>`,
        );
      })
      .join('');

    // What the picker needs, and no more — a resolved value and a label, never
    // anything that reaches back into the house.
    const entityData = live.entities.map((state) => ({
      id: state.entityId,
      name: state.friendlyName,
      domain: state.domain,
      state: state.state,
      unit: state.unit ?? null,
    }));

    const fallbackOptions = live.entities
      .map(
        (state) =>
          `<option value="${escapeHtml(state.entityId)}">` +
          `${escapeHtml(state.friendlyName)} — ${escapeHtml(state.state)}` +
          `${state.unit === null ? '' : ' ' + escapeHtml(state.unit)}</option>`,
      )
      .join('');

    return (
      section(
        'On the wall',
        'A few readings beside the calendar. This is deliberately not a ' +
          'dashboard — Home Assistant already has one, and it is better at it.',
        // Calendars used to be offered here too, and a calendar added as a
        // reading drew "Bins · On" — its state, which means "an event is on
        // right now". They are not in this picker any more, so this says
        // where they went rather than leaving somebody hunting for one that
        // has quietly vanished. Kept as a second `.hint` paragraph in the
        // body, since `section`'s own `help` is one prose blurb and this is a
        // second, narrower aside rather than the section's main reason.
        `<p class="hint">Calendar entities are not readings — they are added as ` +
        `calendars, below, and behave like any other feed.</p>` +
        (rows === '' ? emptyState('Nothing on the wall yet.') : rows),
      ) +
      section(
        'Add readings',
        undefined,
        `<div id="ha-entity-picker" ` +
        `data-entities="${escapeHtml(JSON.stringify(entityData))}" ` +
        `data-modes="${escapeHtml(JSON.stringify(DISPLAY_MODES))}"></div>` +
        `<script type="module" src="assets/ha-entity-picker.js"></script>` +
        `<noscript>` +
        `<form method="post" action="admin/home-assistant/entities">` +
        textField({
          label: 'Entity',
          name: 'entity_id',
          required: true,
          placeholder: 'Start typing a name',
          attrs: 'list="ha-entities" autocomplete="off"',
        }) +
        `<datalist id="ha-entities">${fallbackOptions}</datalist>` +
        textField({
          label: 'Call it',
          name: 'label',
          placeholder: 'Leave empty to use its own name',
        }) +
        selectField({
          label: 'Show it as',
          name: 'display_mode',
          optionsHtml: DISPLAY_MODES.map(
            (option) =>
              `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`,
          ).join(''),
        }) +
        `<button type="submit">Add to the wall</button></form></noscript>`,
      )
    );
  }

  /**
   * The list this section never had (RFC 014 phase 2).
   *
   * Of the four subjects on the old screen this was the only one that offered a
   * form and no list, so "which of my Home Assistant calendars are on the wall"
   * was a question the screen could not answer and a household had to leave for
   * `/admin/calendars` to find out. It reads no new rows —
   * `haCalendarEntityIds` already reduces exactly these to a set so the add
   * form can stop offering one twice — so this adds a list to a screen and no
   * query to the application.
   *
   * **A tag when it has stopped reading, and that is what makes the list worth
   * drawing** rather than decorative: a Home Assistant calendar that has
   * stopped is invisible here otherwise, and "it is added" and "it is working"
   * are two facts.
   *
   * Every row links to `/admin/calendars`, where the source is actually
   * configured. This screen adds and reports; it does not become a second place
   * to edit one — which is the relationship
   * `savedRedirect(c, '/admin/calendars', 'ha-calendar-added')` already states,
   * drawn rather than only redirected to.
   */
  function calendarRows(): string {
    const rows = readHaCalendarSources(deps.db);
    /*
     * Nothing rather than an `emptyState` when none has been added: the add
     * form is directly underneath, so a box reading "none yet" would be a
     * sentence six inches above its own remedy — the shape
     * `admin-saved.test.ts` already caught once on this family, where an empty
     * state offered "Add a calendar" as an in-page anchor to a form already on
     * screen. The add form's own empty states still say when the *house* has
     * no calendars, which is a different fact.
     */
    if (rows.length === 0) return '';
    return rows
      .map((row) =>
        listRow(
          '',
          { title: row.name, detail: row.entityId, href: 'admin/calendars' },
          row.lastError === null ? '' : tag('Not reading', 'danger'),
        ),
      )
      .join('');
  }

  function calendars(live: LiveState): string {
    const already = haCalendarEntityIds(deps.db);
    const available = live.calendars.filter((entity) => !already.has(entity.entityId));

    const options = available
      .map(
        (entity) =>
          `<option value="${escapeHtml(entity.entityId)}">${escapeHtml(entity.name)}</option>`,
      )
      .join('');

    /*
     * One section holding the list and then the form, which is `todoLists`'
     * shape one subject along rather than a second one invented here. Two
     * sections were tried first — measured on a 390px phone, a second heading
     * and the help prose above it put the add form 454px down a screen whose
     * whole content is that form.
     */
    return section(
      'Calendars',
      'Calendars already in Home Assistant, added without finding a ' +
        'single address. They appear on the Calendars page like any other, and can be ' +
        'coloured and assigned to a person there.',
      calendarRows() +
        (available.length === 0
          ? emptyState(already.size === 0 ? 'Home Assistant has no calendar entities.' : 'All of them have been added.')
          : `<form method="post" action="admin/home-assistant/calendars">` +
            selectField({ label: 'Calendar', name: 'entity_id', optionsHtml: options }) +
            textField({
              label: 'Call it',
              name: 'name',
              placeholder: 'Leave empty to use its own name',
            }) +
            `<button type="submit">Add calendar</button></form>`),
    );
  }

  /**
   * The to-do lists (RFC 012 phase 1): what is watched, and what could be.
   *
   * Built from the component layer and nothing else — a `section`, a `listRow`
   * per list with its state as a `tag` and its actions in the ⋮ (reorder above
   * the rule, `destructive()` below it, the one rule every ordered list here
   * follows), an `emptyState` when there is none, and the add form from the
   * field helpers. The picker is the same `/api/states` datalist the readings
   * form uses, read for `todo.*` alone.
   *
   * The section says plainly where the tick lives, which is **not here**
   * (RFC 012 phase 2). Showing a list and letting a wall write to it are two
   * decisions with two different risks, so they are set in two places: the list
   * is chosen here, once, for the household; whether a given wall may tick
   * anything off it is a fact about that hardware and is on that wall's own
   * page. A household who turns a list on and finds no boxes has not hit a bug,
   * and this is where they are told which switch they are looking for.
   *
   * "Here" is `/admin/home-assistant/lists` since RFC 014 — a screen of its own
   * rather than the eighth block of one page. Nothing in this function changed
   * with it: the rows, the reorder items, `destructive()`, the add form and the
   * `MAX_WATCHED_LISTS` refusal all travelled whole, which is the whole claim
   * that this was a routing change and not a rewrite.
   */
  function todoLists(live: LiveState): string {
    const watched = readTodoLists(deps.db);
    const watchedIds = new Set(watched.map((list) => list.entityId));

    const rows = watched
      .map((list, index) => listRowFor(list, index === 0, index === watched.length - 1))
      .join('');

    const available = live.todo.filter((entity) => !watchedIds.has(entity.entityId));
    const options = available
      .map(
        (entity) =>
          `<option value="${escapeHtml(entity.entityId)}">` +
          `${escapeHtml(entity.name)}${entity.supportsUpdate ? '' : ' — cannot be ticked, in Home Assistant itself'}</option>`,
      )
      .join('');

    const full = watched.length >= MAX_WATCHED_LISTS;
    const addForm = full
      ? `<p class="hint">A wall reads at most ${MAX_WATCHED_LISTS} lists. Remove one to add another.</p>`
      : available.length === 0
        ? emptyState(
            live.todo.length === 0
              ? 'Home Assistant has no to-do lists.'
              : 'Every to-do list Home Assistant has is already shown.',
          )
        : `<form method="post" action="admin/home-assistant/lists">` +
          textField({
            label: 'To-do list',
            name: 'entity_id',
            required: true,
            placeholder: 'Start typing a name',
            attrs: 'list="ha-todo-lists" autocomplete="off"',
          }) +
          `<datalist id="ha-todo-lists">${options}</datalist>` +
          textField({
            label: 'Call it',
            name: 'label',
            placeholder: 'Leave empty to use its own name',
            attrs: 'maxlength="60"',
          }) +
          `<button type="submit">Show this list</button></form>`;

    return section(
      'To-do lists',
      'A Home Assistant to-do list, read every minute, drawn by the To-do widget on ' +
        'any wall or panel you put one on. To tick items off from a wall, turn on ' +
        '“Allow ticking to-do items off” on that wall’s own page — it is off ' +
        'everywhere until you do, and an e-paper panel cannot offer it at all.',
      (rows === '' ? emptyState('No to-do lists are shown yet.') : rows) + addForm,
    );
  }

  /** One watched list: its name, its state as a word, and its actions in the ⋮. */
  function listRowFor(list: TodoListRow, first: boolean, last: boolean): string {
    const name = list.label ?? list.name;
    const enc = encodeURIComponent(list.entityId);
    const state =
      list.lastError !== null
        ? tag('Not reading', 'danger')
        : list.lastFetchedAt === null
          ? tag('Not read yet')
          : list.supportsUpdate
            ? tag('Can be ticked', 'ok')
            : tag('Read-only', 'warn');
    const detail =
      list.lastError !== null
        ? list.lastError
        : list.lastFetchedAt === null
          ? 'Waiting for its first read.'
          : `Read ${ago(list.lastFetchedAt, now())}.`;
    const menu =
      `<details class="ovf" data-overflow>` +
      `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
      `aria-label="More actions for ${escapeHtml(name)}" title="More">${icon('more')}</summary>` +
      `<div class="ovf-menu" role="menu">` +
      reorderMenuItems(`admin/home-assistant/lists/${enc}/move`, first, last) +
      destructive('Remove', { thing: name, confirmAction: `admin/home-assistant/lists/${enc}/remove` }) +
      `</div></details>`;
    return listRow('', { title: name, detail }, state + menu);
  }

  function rules(live: LiveState, template?: RuleTemplate, echo?: RuleEcho): string {
    const stored = readRuleRows(deps.db).filter(
      (row) => row.trigger === 'homeassistant' || row.trigger === 'ha_entity',
    );

    const existing = stored
      .map((row) => {
        const parsed = readMatch(safeJson(row.conditions));
        const match = parsed?.match;
        const wait = row.minDwellSec > 0 ? ` for ${Math.round(row.minDwellSec / 60)} min` : '';
        const window =
          match?.condition?.between != null
            ? `, ${match.condition.between.from}–${match.condition.between.to}`
            : '';
        const id = encodeURIComponent(row.id);
        return card(
          // The same card head every list uses: the rule on the left, the ⋮
          // holding the destructive Delete. Turn on/off stays the one visible
          // control (the Store card's call), so a toggle is never a neighbour of
          // a delete. "(off)" is a tag beside the name — its own element on its
          // own ground, still a word a monochrome screenshot and a colour-blind
          // reader both get — never appended to the name it belongs to.
          `<div class="card-head"><div class="card-head-main">` +
          `<h2>${escapeHtml(row.name)}` +
          (row.enabled === 1 ? '' : tag('Off', 'warn')) +
          `</h2>` +
          `<p class="host">${escapeHtml(match?.entityId ?? 'unknown entity')} ` +
          `${escapeHtml(match?.condition?.kind ?? '?')} ` +
          `${escapeHtml(match?.condition?.value ?? '?')}` +
          `${escapeHtml(wait)}${escapeHtml(window)}</p>` +
          `<p class="sub">${escapeHtml(ACTIONS.find((a) => a.key === row.action)?.label ?? row.action)}</p>` +
          `</div>` +
          `<details class="ovf" data-overflow>` +
          `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
          `aria-label="More actions for ${escapeHtml(row.name)}" title="More">${icon('more')}</summary>` +
          `<div class="ovf-menu" role="menu">` +
          destructive('Delete', {
            thing: row.name,
            confirmAction: `admin/home-assistant/rules/${id}/delete`,
          }) +
          `</div></details></div>` +
          `<div class="row">` +
          `<form method="post" action="admin/home-assistant/rules/${id}/toggle">` +
          `<input type="hidden" name="enabled" value="${row.enabled === 1 ? '' : '1'}">` +
          `<button class="secondary" type="submit">${row.enabled === 1 ? 'Turn off' : 'Turn on'}</button>` +
          `</form></div>`,
        );
      })
      .join('');

    /*
     * A row per template, which fills the form in below.
     *
     * `listRow` rather than a button because choosing one changes nothing —
     * it is a different view of an empty form, and a GET is what that is; the
     * whole row is the target, so a template's hint is not a separate hit
     * from its name.
     */
    const templates = RULE_TEMPLATES.map((entry) =>
      listRow(
        '',
        {
          title: entry.name,
          detail: entry.hint,
          href: `admin/home-assistant/alerts?template=${encodeURIComponent(entry.key)}`,
        },
      ),
    ).join('');

    const options = live.entities
      .map(
        (state) =>
          `<option value="${escapeHtml(state.entityId)}">` +
          `${escapeHtml(state.friendlyName)} — ${escapeHtml(domainOf(state.entityId))}</option>`,
      )
      .join('');

    /*
     * What goes in the fields: the echo wins, then the template, then nothing.
     *
     * A refusal here discards a window, a value and an action a template may
     * have filled in — eight fields, most of them not typed by the household at
     * all — and the field that actually gets refused is `entity_id`, whose
     * mistake is usually one character in a name they now need to see.
     *
     * The two `<select>`s are the limit RFC 009 records and it does not bind
     * here for a reason worth checking rather than assuming: `condition` and
     * `action` are closed lists whose every value is an option by construction,
     * so an echoed value that matches none of them would select *nothing* and
     * the browser would preselect whatever sorts first, over a live Save. They
     * are normalised to a known key or dropped. `entity_id` is a `textField`
     * with a `<datalist>` beside it rather than a `<select>` — a datalist
     * suggests and does not constrain — so it echoes back exactly as typed,
     * which is the whole point.
     */
    const known = <T extends string>(keys: readonly T[], value: string | undefined): T | undefined =>
      value !== undefined && (keys as readonly string[]).includes(value) ? (value as T) : undefined;
    const filled = {
      name: echo?.name ?? template?.name ?? '',
      entityId: echo?.entityId ?? '',
      condition: known(CONDITION_KEYS, echo?.condition) ?? template?.condition.kind,
      value: echo?.value ?? template?.condition.value ?? 'on',
      forMinutes:
        echo?.forMinutes ??
        (template?.minDwellSec ? String(Math.round(template.minDwellSec / 60)) : ''),
      fromTime: echo?.fromTime ?? template?.condition.between?.from ?? '',
      toTime: echo?.toTime ?? template?.condition.between?.to ?? '',
      action: known(ACTION_KEYS, echo?.action) ?? template?.action,
    };

    return section(
      'Tell me when…',
      'The wall interrupts itself for things worth walking over for. ' +
        'Everything else belongs in a Home Assistant notification.',
      (existing === '' ? '' : existing) +
      templates +
      `<form method="post" action="admin/home-assistant/rules">` +
      textField({
        label: 'What to say',
        name: 'name',
        required: true,
        value: filled.name,
        placeholder: 'Water under the sink',
        hint: 'This is the sentence the wall shows, so write it as one.',
        attrs: 'maxlength="60"',
      }) +

      textField({
        label: 'Entity',
        name: 'entity_id',
        required: true,
        value: filled.entityId,
        placeholder: 'Start typing a name',
        attrs: 'list="ha-rule-entities" autocomplete="off"',
      }) +
      `<datalist id="ha-rule-entities">${options}</datalist>` +

      `<div class="row-fields">` +
      selectField({
        label: 'When it is',
        name: 'condition',
        optionsHtml:
          option('equals', 'exactly', filled.condition) +
          option('above', 'above', filled.condition) +
          option('below', 'below', filled.condition) +
          option('changed_to', 'has just become', filled.condition),
      }) +
      textField({
        label: 'This',
        name: 'value',
        required: true,
        value: filled.value,
      }) +
      textField({
        label: 'For (minutes)',
        name: 'for_minutes',
        type: 'number',
        placeholder: '0',
        attrs: 'min="0" max="1440" inputmode="numeric"',
        value: filled.forMinutes,
      }) +
      `</div>` +
      `<p class="hint">A door sensor reads <span class="code">on</span> when it is open. ` +
      `The wait is what separates “somebody is carrying shopping in” from “it has been ` +
      `open all night”.</p>` +

      `<div class="row-fields">` +
      textField({
        label: 'Only after',
        name: 'from_time',
        type: 'time',
        value: filled.fromTime,
      }) +
      textField({
        label: 'And before',
        name: 'to_time',
        type: 'time',
        value: filled.toTime,
      }) +
      `</div>` +
      `<p class="hint">Leave both empty and the rule applies at any hour. A garage door ` +
      `open at teatime is somebody carrying shopping in; the same sensor at midnight is ` +
      `worth walking downstairs for, and only the hour tells them apart. Times wrap past ` +
      `midnight, so 23:00 until 06:00 means the night.</p>` +

      selectField({
        label: 'Show it as',
        name: 'action',
        optionsHtml: ACTIONS.map(
          (entry) =>
            `<option value="${escapeHtml(entry.key)}"` +
            `${entry.key === filled.action ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`,
        ).join(''),
      }) +
      `<button type="submit">Add rule</button></form>`,
    );
  }
}

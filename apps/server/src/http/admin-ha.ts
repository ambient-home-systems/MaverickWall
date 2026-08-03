import type { Context, Hono } from 'hono';
import { errorBlock, escapeHtml, page } from './html.js';
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
  readHaSettings,
  readWatched,
  unwatchEntity,
  watchEntity,
  writeHaSettings,
} from '../modules/homeassistant/store.js';
import { deleteRule, readMatch, readRuleRows, setRuleEnabled, writeRule } from '../api/rules.js';

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
import type { AdminDeps } from './admin.js';

/**
 * The Home Assistant screen.
 *
 * Server-rendered like every other admin screen, and the entity picker is a
 * `<datalist>` rather than a search box with a script behind it — a household
 * with four hundred entities gets type-ahead from the browser, and the page
 * still works on whatever is bolted to their wall.
 *
 * The read-only boundary is stated on the page in as many words. It is a
 * feature and it is the reason the token is safe to store at all, so it is
 * written where somebody deciding whether to paste one can read it.
 */

const ACTIONS: readonly { key: InterruptAction; label: string }[] = [
  { key: 'banner', label: 'A strip above the calendar' },
  { key: 'takeover', label: 'The whole wall' },
  { key: 'takeover_and_wake', label: 'The whole wall, and wake a dark screen' },
];

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value.trim() : '';
}

function checked(body: Record<string, unknown>, name: string): boolean {
  return typeof body[name] === 'string';
}

/** One `<option>`, selected when it is the one a template chose. */
function option(value: string, label: string, selected?: string): string {
  return (
    `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>` +
    `${escapeHtml(label)}</option>`
  );
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
      problem: null,
    };
  }

  async function render(
    error?: PageError,
    status?: number,
    template?: RuleTemplate,
  ): Promise<Response> {
    const live = await look();
    const shown = error ?? live.problem ?? undefined;
    return new Response(haPage(live, shown, template), {
      status: status ?? 200,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
  }

  /**
   * A template is a query parameter, not a script.
   *
   * Choosing one re-renders the form with its fields already filled in, which
   * is the whole of "prefill" without a line of JavaScript. The household can
   * change every one of them before saving — a template is a starting point,
   * and the hard part of a rule builder is not the fields but knowing that a
   * freezer door is worth five minutes and a leak is worth none.
   */
  app.get('/admin/home-assistant', async (c: Context) => {
    const chosen = RULE_TEMPLATES.find((entry) => entry.key === c.req.query('template'));
    return render(undefined, undefined, chosen);
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

    const raw = field(body, 'base_url');
    if (raw === '') {
      return render(
        {
          message: 'Enter the address of Home Assistant.',
          suggestion: 'Usually something like http://192.168.1.10:8123',
        },
        400,
      );
    }
    const baseUrl = raw.replace(/\/+$/, '');

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
    if (baseUrl.startsWith('http://') && !checked(body, 'accept_http')) {
      return render(
        {
          message: 'That address is not encrypted.',
          suggestion:
            'A Home Assistant token controls your whole house and is sent with every ' +
            'request. Over plain http anything on your network can read it. Tick the box ' +
            'below to use it anyway on a network you trust.',
        },
        400,
      );
    }

    const token = field(body, 'token');
    if (token === '' && !settings.hasToken) {
      return render(
        {
          message: 'Paste a long-lived access token.',
          suggestion:
            'In Home Assistant: your profile, then Security, then "Create token" at the bottom.',
        },
        400,
      );
    }

    writeHaSettings(deps.db, deps.keyring, {
      baseUrl,
      ...(token === '' ? {} : { token }),
      allowPrivateNetwork: checked(body, 'allow_lan'),
    });

    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      return render(
        {
          message: resolved.message,
          ...(resolved.suggestion !== undefined ? { suggestion: resolved.suggestion } : {}),
        },
        400,
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
      return render(
        {
          message: proved.message,
          ...(proved.suggestion !== undefined ? { suggestion: proved.suggestion } : {}),
        },
        400,
      );
    }

    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/disconnect', (c: Context) => {
    disconnectHa(deps.db);
    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/entities', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const entityId = field(body, 'entity_id');
    if (entityId === '' || !isSupported(entityId)) {
      return render(
        {
          message: 'Choose an entity from the list.',
          suggestion:
            'Sensors, binary sensors, weather, people, device trackers and calendars. ' +
            'Anything else is not a reading a wall can show.',
        },
        400,
      );
    }

    const mode = field(body, 'display_mode');
    const label = field(body, 'label');
    const live = await look();
    const known = live.entities.find((state) => state.entityId === entityId);

    watchEntity(deps.db, {
      entityId,
      friendlyName: known?.friendlyName ?? entityId,
      label: label === '' ? null : label,
      displayMode: (DISPLAY_MODES.some((option) => option.key === mode)
        ? mode
        : 'label_value') as DisplayMode,
    });
    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/entities/remove', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    unwatchEntity(deps.db, field(body, 'entity_id'));
    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/calendars', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const entityId = field(body, 'entity_id');
    if (!entityId.startsWith('calendar.')) {
      return render({ message: 'Choose a calendar from the list.' }, 400);
    }
    if (haCalendarEntityIds(deps.db).has(entityId)) {
      return render({ message: 'That calendar has already been added.' }, 400);
    }

    const live = await look();
    const known = live.calendars.find((entity) => entity.entityId === entityId);
    const name = field(body, 'name');
    addHaCalendarSource(deps.db, {
      entityId,
      name: name !== '' ? name : (known?.name ?? entityId),
    });
    return c.redirect('/admin/calendars', 302);
  });

  app.post('/admin/home-assistant/rules', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const name = field(body, 'name');
    const entityId = field(body, 'entity_id');
    if (name === '' || entityId === '') {
      return render({ message: 'A rule needs a name and an entity.' }, 400);
    }
    if (!isSupported(entityId)) {
      return render({ message: 'That entity is not one this can watch.' }, 400);
    }

    const condition = field(body, 'condition');
    if (
      condition !== 'equals' &&
      condition !== 'above' &&
      condition !== 'below' &&
      condition !== 'changed_to'
    ) {
      return render({ message: 'Choose a condition from the list.' }, 400);
    }

    const value = field(body, 'value');
    if (value === '') {
      return render({ message: 'Say what state or number this rule is about.' }, 400);
    }
    if ((condition === 'above' || condition === 'below') && !Number.isFinite(Number(value))) {
      return render(
        { message: 'Above and below need a number to compare with.' },
        400,
      );
    }

    const minutes = field(body, 'for_minutes');
    if (minutes !== '' && !/^[0-9]{1,4}$/.test(minutes)) {
      return render({ message: 'Enter the wait in whole minutes, or leave it empty.' }, 400);
    }

    /*
     * The overnight window, which is optional and all-or-nothing.
     *
     * One time without the other is somebody who filled in half a thought, and
     * silently ignoring it would give them a rule that fires at noon.
     */
    const from = field(body, 'from_time');
    const to = field(body, 'to_time');
    if ((from === '') !== (to === '')) {
      return render(
        {
          message: 'Give both times, or neither.',
          suggestion:
            'Leaving them empty means the rule applies at any hour. To limit it to the ' +
            'night, set from 23:00 to 06:00.',
        },
        400,
      );
    }
    const between = from === '' ? null : parseWindow({ from, to });
    if (from !== '' && between === null) {
      return render(
        {
          message: 'Those times are not a window.',
          suggestion: 'Use HH:MM, and make them different from each other.',
        },
        400,
      );
    }

    const action = field(body, 'action');
    if (!ACTIONS.some((candidate) => candidate.key === action)) {
      return render({ message: 'Choose how loudly this should be shown.' }, 400);
    }

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
      action: action as InterruptAction,
      piercesNightMode: action === 'takeover_and_wake',
      minDwellSec: minutes === '' || minutes === '0' ? 0 : Number(minutes) * 60,
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

    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/rules/:id/delete', (c: Context) => {
    deleteRule(deps.db, c.req.param('id') ?? '');
    return c.redirect('/admin/home-assistant', 302);
  });

  app.post('/admin/home-assistant/rules/:id/toggle', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    setRuleEnabled(deps.db, c.req.param('id') ?? '', checked(body, 'enabled'));
    return c.redirect('/admin/home-assistant', 302);
  });

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  function haPage(live: LiveState, error?: PageError, template?: RuleTemplate): string {
    const settings = readHaSettings(deps.db);
    const connected = live.mode !== null;

    return page({
      title: 'Home Assistant — Maverick Wall',
      heading: 'Home Assistant',
      body:
        `<p><a class="link" href="admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error.message, error.suggestion)) +
        boundary() +
        status(live, settings.lastSyncAt) +
        (live.mode === 'supervisor' ? '' : connectionForm(settings)) +
        (connected ? readings(live) : '') +
        (connected ? calendars(live) : '') +
        (connected ? rules(live, template) : ''),
    });
  }

  /**
   * The read-only boundary, stated first.
   *
   * Before the form, not after it, because it is the thing that decides
   * whether pasting a token here is a reasonable thing to do — and it is the
   * only claim on this page that somebody has to take on trust.
   */
  function boundary(): string {
    return (
      `<div class="card">` +
      `<h2>Maverick Wall reads. It cannot control anything.</h2>` +
      `<ul class="plain">` +
      `<li>No switches, no scenes, no service calls. There is no code in this ` +
      `application that writes to Home Assistant.</li>` +
      `<li>The wall receives <strong>resolved values</strong> — “19.4 °C”, “Closed”. ` +
      `It never receives your token, an entity name, or any way to ask Home ` +
      `Assistant a question of its own.</li>` +
      `<li>Your token is stored encrypted, and never appears in a log, an error ` +
      `message, or the diagnostics export.</li>` +
      `</ul>` +
      `<p class="hint">A Home Assistant long-lived access token has full control of ` +
      `your home and cannot be limited to reading. That is why the limit is on this ` +
      `side: if a screen in your hallway were ever compromised, the worst it could ` +
      `give away is your indoor temperature.</p>` +
      `</div>`
    );
  }

  function status(live: LiveState, lastSyncAt: number | null): string {
    if (live.mode === 'supervisor') {
      return (
        `<div class="card"><h2>Connected — running as an add-on</h2>` +
        `<p>Home Assistant is reached through the supervisor. There is nothing to ` +
        `configure and no token to manage.</p>` +
        `<p class="host">${live.entities.length} readable entities · ` +
        `${live.calendars.length} calendars${lastSyncAt === null ? '' : ' · last read ' + escapeHtml(agoOf(lastSyncAt))}</p>` +
        `</div>`
      );
    }
    if (live.mode === 'manual') {
      return (
        `<div class="card"><h2>Connected</h2>` +
        `<p class="host">${escapeHtml(live.host ?? '')} · ${live.entities.length} readable ` +
        `entities · ${live.calendars.length} calendars` +
        `${lastSyncAt === null ? '' : ' · last read ' + escapeHtml(agoOf(lastSyncAt))}</p>` +
        `<form method="post" action="admin/home-assistant/disconnect">` +
        `<button class="secondary" type="submit">Disconnect</button></form>` +
        `<p class="hint">Disconnecting deletes the stored token, the readings on the ` +
        `wall, and any rules about your house. Calendars you added stay, and stop ` +
        `updating.</p>` +
        `</div>`
      );
    }
    return `<div class="card"><h2>Not connected</h2><p>Nothing from your house is on the wall.</p></div>`;
  }

  function agoOf(at: number): string {
    const seconds = Math.max(0, Math.round((now() - at) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  function connectionForm(settings: ReturnType<typeof readHaSettings>): string {
    return (
      `<h2 class="add">Connect</h2>` +
      `<form method="post" action="admin/home-assistant/connect">` +
      `<label for="base_url">Address of Home Assistant</label>` +
      `<input id="base_url" name="base_url" type="text" required ` +
      `placeholder="http://192.168.1.10:8123" ` +
      `value="${escapeHtml(settings.baseUrl ?? '')}">` +
      `<p class="hint">Use the IP address. Names ending in .local are resolved by the ` +
      `device you are browsing from rather than by this server, so they usually will ` +
      `not work here.</p>` +

      `<label for="token">Long-lived access token</label>` +
      `<input id="token" name="token" type="password" autocomplete="off" ` +
      `${settings.hasToken ? 'placeholder="Stored — leave empty to keep it"' : 'required'}>` +
      `<p class="hint">In Home Assistant: your profile, then Security, then “Create ` +
      `token” at the bottom of the page.</p>` +

      `<div class="checks">` +
      `<label><input type="checkbox" name="allow_lan" value="1"` +
      `${settings.allowPrivateNetwork ? ' checked' : ''}> Home Assistant is on my local network</label>` +
      `<label><input type="checkbox" name="accept_http" value="1"> ` +
      `Use plain http — I understand the token crosses my network unencrypted</label>` +
      `</div>` +
      `<button type="submit">Connect</button></form>`
    );
  }

  /**
   * The picker: a datalist, so the browser does the searching.
   *
   * Four hundred entities in a `<select>` is unusable and a search box needs a
   * script. `<input list>` gives type-ahead in every browser that matters,
   * degrades to a plain text box in the ones that do not, and adds nothing to
   * the page that can fail to load.
   */
  function readings(live: LiveState): string {
    const watched = readWatched(deps.db).filter((row) => row.watched === 1);

    const options = live.entities
      .map(
        (state) =>
          `<option value="${escapeHtml(state.entityId)}">` +
          `${escapeHtml(state.friendlyName)} — ${escapeHtml(state.state)}` +
          `${state.unit === null ? '' : ' ' + escapeHtml(state.unit)}</option>`,
      )
      .join('');

    const rows = watched
      .map(
        (row) =>
          `<article class="card">` +
          `<h2>${escapeHtml(row.label ?? row.friendlyName ?? row.entityId)}</h2>` +
          `<p>${escapeHtml(row.state ?? '—')}` +
          `${row.unitOfMeasurement === null ? '' : ' ' + escapeHtml(row.unitOfMeasurement)}` +
          `${row.fetchedAt === 0 ? ' · not read yet' : ' · read ' + escapeHtml(agoOf(row.fetchedAt))}</p>` +
          `<p class="host">${escapeHtml(row.entityId)}</p>` +
          `<form method="post" action="admin/home-assistant/entities/remove">` +
          `<input type="hidden" name="entity_id" value="${escapeHtml(row.entityId)}">` +
          `<button class="secondary" type="submit">Remove</button></form>` +
          `</article>`,
      )
      .join('');

    return (
      `<h2 class="add">On the wall</h2>` +
      `<p class="hint">A few readings beside the calendar. This is deliberately not a ` +
      `dashboard — Home Assistant already has one, and it is better at it.</p>` +
      (rows === '' ? `<p>Nothing yet.</p>` : rows) +
      `<form method="post" action="admin/home-assistant/entities">` +
      `<label for="entity_id">Entity</label>` +
      `<input id="entity_id" name="entity_id" type="text" required list="ha-entities" ` +
      `autocomplete="off" placeholder="Start typing a name">` +
      `<datalist id="ha-entities">${options}</datalist>` +
      `<label for="label">Call it</label>` +
      `<input id="label" name="label" type="text" placeholder="Leave empty to use its own name">` +
      `<label for="display_mode">Show it as</label>` +
      `<select id="display_mode" name="display_mode">` +
      DISPLAY_MODES.map(
        (option) =>
          `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`,
      ).join('') +
      `</select>` +
      `<button type="submit">Add to the wall</button></form>`
    );
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

    return (
      `<h2 class="add">Calendars</h2>` +
      `<p class="hint">Calendars already in Home Assistant, added without finding a ` +
      `single address. They appear on the Calendars screen like any other, and can be ` +
      `coloured and assigned to a person there.</p>` +
      (available.length === 0
        ? `<p>${already.size === 0 ? 'Home Assistant has no calendar entities.' : 'All of them have been added.'}</p>`
        : `<form method="post" action="admin/home-assistant/calendars">` +
          `<label for="cal_entity">Calendar</label>` +
          `<select id="cal_entity" name="entity_id">${options}</select>` +
          `<label for="cal_name">Call it</label>` +
          `<input id="cal_name" name="name" type="text" ` +
          `placeholder="Leave empty to use its own name">` +
          `<button type="submit">Add calendar</button></form>`)
    );
  }

  function rules(live: LiveState, template?: RuleTemplate): string {
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
        return (
          `<article class="card">` +
          `<h2>${escapeHtml(row.name)}${row.enabled === 1 ? '' : ' (off)'}</h2>` +
          `<p class="host">${escapeHtml(match?.entityId ?? 'unknown entity')} ` +
          `${escapeHtml(match?.condition?.kind ?? '?')} ` +
          `${escapeHtml(match?.condition?.value ?? '?')}` +
          `${escapeHtml(wait)}${escapeHtml(window)}</p>` +
          `<p>${escapeHtml(ACTIONS.find((a) => a.key === row.action)?.label ?? row.action)}</p>` +
          `<div class="row">` +
          `<form method="post" action="admin/home-assistant/rules/${encodeURIComponent(row.id)}/toggle">` +
          `<input type="hidden" name="enabled" value="${row.enabled === 1 ? '' : '1'}">` +
          `<button class="secondary" type="submit">${row.enabled === 1 ? 'Turn off' : 'Turn on'}</button>` +
          `</form>` +
          `<form method="post" action="admin/home-assistant/rules/${encodeURIComponent(row.id)}/delete">` +
          `<button class="secondary" type="submit">Delete</button></form>` +
          `</div></article>`
        );
      })
      .join('');

    /*
     * A link per template, which fills the form in below.
     *
     * Links rather than buttons because choosing one changes nothing — it is a
     * different view of an empty form, and a GET is what that is.
     */
    const templates = RULE_TEMPLATES.map(
      (entry) =>
        `<li><a class="link" href="admin/home-assistant?template=${encodeURIComponent(entry.key)}">` +
        `${escapeHtml(entry.name)}</a> — ${escapeHtml(entry.hint)}</li>`,
    ).join('');

    const options = live.entities
      .map(
        (state) =>
          `<option value="${escapeHtml(state.entityId)}">` +
          `${escapeHtml(state.friendlyName)} — ${escapeHtml(domainOf(state.entityId))}</option>`,
      )
      .join('');

    return (
      `<h2 class="add">Tell me when…</h2>` +
      `<p class="hint">The wall interrupts itself for things worth walking over for. ` +
      `Everything else belongs in a Home Assistant notification.</p>` +
      (existing === '' ? '' : existing) +
      `<ul class="plain">${templates}</ul>` +
      `<form method="post" action="admin/home-assistant/rules">` +
      `<label for="rule_name">What to say</label>` +
      `<input id="rule_name" name="name" type="text" required maxlength="60" ` +
      `value="${escapeHtml(template?.name ?? '')}" ` +
      `placeholder="Water under the sink">` +
      `<p class="hint">This is the sentence the wall shows, so write it as one.</p>` +

      `<label for="rule_entity">Entity</label>` +
      `<input id="rule_entity" name="entity_id" type="text" required list="ha-rule-entities" ` +
      `autocomplete="off" placeholder="Start typing a name">` +
      `<datalist id="ha-rule-entities">${options}</datalist>` +

      `<div class="row-fields">` +
      `<span><label for="rule_condition">When it is</label>` +
      `<select id="rule_condition" name="condition">` +
      option('equals', 'exactly', template?.condition.kind) +
      option('above', 'above', template?.condition.kind) +
      option('below', 'below', template?.condition.kind) +
      option('changed_to', 'has just become', template?.condition.kind) +
      `</select></span>` +
      `<span><label for="rule_value">This</label>` +
      `<input id="rule_value" name="value" type="text" required ` +
      `value="${escapeHtml(template?.condition.value ?? 'on')}"></span>` +
      `<span><label for="rule_for">For (minutes)</label>` +
      `<input id="rule_for" name="for_minutes" type="number" min="0" max="1440" ` +
      `inputmode="numeric" placeholder="0" ` +
      `value="${template?.minDwellSec ? Math.round(template.minDwellSec / 60) : ''}"></span>` +
      `</div>` +
      `<p class="hint">A door sensor reads <span class="code">on</span> when it is open. ` +
      `The wait is what separates “somebody is carrying shopping in” from “it has been ` +
      `open all night”.</p>` +

      `<div class="row-fields">` +
      `<span><label for="from_time">Only after</label>` +
      `<input id="from_time" name="from_time" type="time" ` +
      `value="${escapeHtml(template?.condition.between?.from ?? '')}"></span>` +
      `<span><label for="to_time">And before</label>` +
      `<input id="to_time" name="to_time" type="time" ` +
      `value="${escapeHtml(template?.condition.between?.to ?? '')}"></span>` +
      `</div>` +
      `<p class="hint">Leave both empty and the rule applies at any hour. A garage door ` +
      `open at teatime is somebody carrying shopping in; the same sensor at midnight is ` +
      `worth walking downstairs for, and only the hour tells them apart. Times wrap past ` +
      `midnight, so 23:00 until 06:00 means the night.</p>` +

      `<label for="rule_action">Show it as</label>` +
      `<select id="rule_action" name="action">` +
      ACTIONS.map(
        (entry) =>
          `<option value="${escapeHtml(entry.key)}"` +
          `${entry.key === template?.action ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`,
      ).join('') +
      `</select>` +
      `<button type="submit">Add rule</button></form>`
    );
  }
}

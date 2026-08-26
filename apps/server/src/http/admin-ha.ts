import type { Context, Hono } from 'hono';
import { confirmDestroyPage, errorBlock, escapeHtml, page, selectField, textField } from './html.js';
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
import { checkbox, optionalText, parse, text, z } from '../validation.js';
import { readSaved, savedRedirect } from './saved.js';
import { ago, navModules, type AdminDeps } from './admin.js';

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
  { key: 'takeover_and_wake', label: 'The whole wall, and wake it if it has gone dark' },
];

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
    c: Context,
    error?: PageError,
    status?: number,
    template?: RuleTemplate,
  ): Promise<Response> {
    const live = await look();
    const shown = error ?? live.problem ?? undefined;
    return new Response(haPage(c, live, shown, template), {
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
    return render(c, undefined, undefined, chosen);
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

    const shaped = parse(connectBody, body);
    if (!shaped.ok) {
      return render(c,
        { message: shaped.message, suggestion: 'Usually something like http://192.168.1.10:8123' },
        400,
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
      return render(c,
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

    const token = shaped.value.token ?? '';
    if (token === '' && !settings.hasToken) {
      return render(c,
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
      allowPrivateNetwork: shaped.value.allow_lan,
    });

    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      return render(c,
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
      return render(c,
        {
          message: proved.message,
          ...(proved.suggestion !== undefined ? { suggestion: proved.suggestion } : {}),
        },
        400,
      );
    }

    return savedRedirect(c, '/admin/home-assistant', 'ha-connected');
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
    if (!readHaSettings(deps.db).hasToken) return c.redirect('/admin/home-assistant', 302);
    return c.html(
      confirmDestroyPage({
        modules: navModules(deps.db),
        title: 'Disconnect Home Assistant',
        nav: 'homeassistant',
        heading: 'Disconnect Home Assistant?',
        intro: HA_DISCONNECT_CONSEQUENCE,
        destroyAction: 'admin/home-assistant/disconnect',
        destroyLabel: 'Disconnect it',
        cancelAction: 'admin/home-assistant',
        cancelLabel: 'Keep it connected',
      }),
    );
  });

  app.post('/admin/home-assistant/disconnect', (c: Context) => {
    disconnectHa(deps.db);
    return savedRedirect(c, '/admin/home-assistant', 'ha-disconnected');
  });

  app.post('/admin/home-assistant/entities', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const watched = parse(watchBody, body);
    if (!watched.ok) return render(c, { message: watched.message }, 400);

    const entityId = watched.value.entity_id;
    if (!isSupported(entityId)) {
      return render(c,
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
    return savedRedirect(c, '/admin/home-assistant', 'ha-entity-added');
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
    if (!queried.ok) return c.redirect('/admin/home-assistant', 302);
    const entityId = queried.value.entity_id;
    const watched = readWatched(deps.db).find((row) => row.entityId === entityId && row.watched === 1);
    if (watched === undefined) return c.redirect('/admin/home-assistant', 302);
    return c.html(
      confirmDestroyPage({
        modules: navModules(deps.db),
        title: 'Remove reading',
        nav: 'homeassistant',
        heading: `Remove “${watched.label ?? watched.friendlyName ?? watched.entityId}”?`,
        intro: 'It stops showing on the wall. Any rule that watches this entity is untouched.',
        destroyAction: 'admin/home-assistant/entities/remove',
        destroyFields: `<input type="hidden" name="entity_id" value="${escapeHtml(entityId)}">`,
        destroyLabel: 'Remove it',
        cancelAction: 'admin/home-assistant',
      }),
    );
  });

  app.post('/admin/home-assistant/entities/remove', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const removal = parse(z.object({ entity_id: text('An entity', 255) }), body);
    if (removal.ok) unwatchEntity(deps.db, removal.value.entity_id);
    return savedRedirect(c, '/admin/home-assistant', 'ha-entity-removed');
  });

  app.post('/admin/home-assistant/calendars', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const picked = parse(calendarSourceBody, body);
    if (!picked.ok) return render(c, { message: picked.message }, 400);
    const entityId = picked.value.entity_id;
    if (!entityId.startsWith('calendar.')) {
      return render(c, { message: 'Choose a calendar from the list.' }, 400);
    }
    if (haCalendarEntityIds(deps.db).has(entityId)) {
      return render(c, { message: 'That calendar has already been added.' }, 400);
    }

    const live = await look();
    const known = live.calendars.find((entity) => entity.entityId === entityId);
    addHaCalendarSource(deps.db, {
      entityId,
      name: picked.value.name ?? known?.name ?? entityId,
    });
    return savedRedirect(c, '/admin/calendars', 'ha-calendar-added');
  });

  app.post('/admin/home-assistant/rules', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;

    const shaped = parse(ruleBody, body);
    if (!shaped.ok) return render(c, { message: shaped.message }, 400);

    const { name, entity_id: entityId, condition, value, action } = shaped.value;
    // Membership rather than shape: which domains this can watch is a fact
    // about the application, not about the request.
    if (!isSupported(entityId)) {
      return render(c, { message: 'That entity is not one this can watch.' }, 400);
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

    return savedRedirect(c, '/admin/home-assistant', 'ha-rule-added');
  });

  /**
   * Deleting a rule asks first — the same GET-then-POST shape as every other
   * destructive control, in place of the one-click "Delete" the card used to
   * post directly.
   */
  app.get('/admin/home-assistant/rules/:id/delete', (c: Context) => {
    const id = c.req.param('id') ?? '';
    const row = readRuleRows(deps.db).find((candidate) => candidate.id === id);
    if (row === undefined) return c.redirect('/admin/home-assistant', 302);
    return c.html(
      confirmDestroyPage({
        modules: navModules(deps.db),
        title: 'Delete rule',
        nav: 'homeassistant',
        heading: `Delete “${row.name}”?`,
        intro: 'The wall stops watching for it. This cannot be undone; you can always add it again.',
        destroyAction: `admin/home-assistant/rules/${encodeURIComponent(id)}/delete`,
        destroyLabel: 'Delete it',
        cancelAction: 'admin/home-assistant',
      }),
    );
  });

  app.post('/admin/home-assistant/rules/:id/delete', (c: Context) => {
    deleteRule(deps.db, c.req.param('id') ?? '');
    return savedRedirect(c, '/admin/home-assistant', 'ha-rule-removed');
  });

  app.post('/admin/home-assistant/rules/:id/toggle', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const toggled = parse(z.object({ enabled: checkbox() }), body);
    setRuleEnabled(deps.db, c.req.param('id') ?? '', toggled.ok && toggled.value.enabled);
    return savedRedirect(c, '/admin/home-assistant', 'ha-rule-updated');
  });

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  function haPage(c: Context, live: LiveState, error?: PageError, template?: RuleTemplate): string {
    const settings = readHaSettings(deps.db);
    const connected = live.mode !== null;

    return page({
      modules: navModules(deps.db),
      title: 'Home Assistant — Maverick Wall',
      nav: 'homeassistant',
      heading: 'Home Assistant',
      saved: readSaved(c),
      body:
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
      `side: if a wall in your hallway were ever compromised, the worst it could ` +
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
        `${live.calendars.length} calendars${lastSyncAt === null ? '' : ' · last read ' + escapeHtml(ago(lastSyncAt, now()))}</p>` +
        `</div>`
      );
    }
    if (live.mode === 'manual') {
      return (
        `<div class="card"><h2>Connected</h2>` +
        `<p class="host">${escapeHtml(live.host ?? '')} · ${live.entities.length} readable ` +
        `entities · ${live.calendars.length} calendars` +
        `${lastSyncAt === null ? '' : ' · last read ' + escapeHtml(ago(lastSyncAt, now()))}</p>` +
        `<form method="get" action="admin/home-assistant/disconnect">` +
        `<button class="btn-danger" type="submit">Disconnect</button></form>` +
        `<p class="hint">${escapeHtml(HA_DISCONNECT_CONSEQUENCE)}</p>` +
        `</div>`
      );
    }
    return `<div class="card"><h2>Not connected</h2><p>Nothing from your house is on the wall.</p></div>`;
  }

  function connectionForm(settings: ReturnType<typeof readHaSettings>): string {
    return (
      `<h2 class="add">Connect</h2>` +
      `<form method="post" action="admin/home-assistant/connect">` +
      textField({
        label: 'Address of Home Assistant',
        name: 'base_url',
        required: true,
        placeholder: 'http://192.168.1.10:8123',
        value: settings.baseUrl ?? '',
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
        ...(settings.hasToken
          ? { placeholder: 'Stored — leave empty to keep it' }
          : { required: true }),
        attrs: 'autocomplete="off"',
      }) +

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

    const rows = watched
      .map(
        (row) =>
          `<article class="card">` +
          `<h2>${escapeHtml(row.label ?? row.friendlyName ?? row.entityId)}</h2>` +
          `<p>${escapeHtml(row.state ?? '—')}` +
          `${row.unitOfMeasurement === null ? '' : ' ' + escapeHtml(row.unitOfMeasurement)}` +
          `${row.fetchedAt === 0 ? ' · not read yet' : ' · read ' + escapeHtml(ago(row.fetchedAt, now()))}</p>` +
          `<p class="host">${escapeHtml(row.entityId)}</p>` +
          `<form method="get" action="admin/home-assistant/entities/remove">` +
          `<input type="hidden" name="entity_id" value="${escapeHtml(row.entityId)}">` +
          `<button class="btn-danger" type="submit">Remove</button></form>` +
          `</article>`,
      )
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
      `<h2 class="add">On the wall</h2>` +
      `<p class="hint">A few readings beside the calendar. This is deliberately not a ` +
      `dashboard — Home Assistant already has one, and it is better at it.</p>` +
      // Calendars used to be offered here too, and a calendar added as a
      // reading drew "Bins · On" — its state, which means "an event is on right
      // now". They are not in this picker any more, so this says where they went
      // rather than leaving somebody hunting for one that has quietly vanished.
      `<p class="hint">Calendar entities are not readings — they are added as ` +
      `calendars, below, and behave like any other feed.</p>` +
      (rows === '' ? `<p>Nothing on the wall yet.</p>` : rows) +
      `<h2 class="add">Add readings</h2>` +
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
      `<button type="submit">Add to the wall</button></form></noscript>`
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
      `single address. They appear on the Calendars page like any other, and can be ` +
      `coloured and assigned to a person there.</p>` +
      (available.length === 0
        ? `<p>${already.size === 0 ? 'Home Assistant has no calendar entities.' : 'All of them have been added.'}</p>`
        : `<form method="post" action="admin/home-assistant/calendars">` +
          selectField({ label: 'Calendar', name: 'entity_id', optionsHtml: options }) +
          textField({
            label: 'Call it',
            name: 'name',
            placeholder: 'Leave empty to use its own name',
          }) +
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
          `<form method="get" action="admin/home-assistant/rules/${encodeURIComponent(row.id)}/delete">` +
          `<button class="btn-danger" type="submit">Delete</button></form>` +
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
      textField({
        label: 'What to say',
        name: 'name',
        required: true,
        value: template?.name ?? '',
        placeholder: 'Water under the sink',
        hint: 'This is the sentence the wall shows, so write it as one.',
        attrs: 'maxlength="60"',
      }) +

      textField({
        label: 'Entity',
        name: 'entity_id',
        required: true,
        placeholder: 'Start typing a name',
        attrs: 'list="ha-rule-entities" autocomplete="off"',
      }) +
      `<datalist id="ha-rule-entities">${options}</datalist>` +

      `<div class="row-fields">` +
      selectField({
        label: 'When it is',
        name: 'condition',
        optionsHtml:
          option('equals', 'exactly', template?.condition.kind) +
          option('above', 'above', template?.condition.kind) +
          option('below', 'below', template?.condition.kind) +
          option('changed_to', 'has just become', template?.condition.kind),
      }) +
      textField({
        label: 'This',
        name: 'value',
        required: true,
        value: template?.condition.value ?? 'on',
      }) +
      textField({
        label: 'For (minutes)',
        name: 'for_minutes',
        type: 'number',
        placeholder: '0',
        attrs: 'min="0" max="1440" inputmode="numeric"',
        ...(template?.minDwellSec ? { value: String(Math.round(template.minDwellSec / 60)) } : {}),
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
        value: template?.condition.between?.from ?? '',
      }) +
      textField({
        label: 'And before',
        name: 'to_time',
        type: 'time',
        value: template?.condition.between?.to ?? '',
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
            `${entry.key === template?.action ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`,
        ).join(''),
      }) +
      `<button type="submit">Add rule</button></form>`
    );
  }
}

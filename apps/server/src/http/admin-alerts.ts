import type { Context, Hono } from 'hono';
import {
  defaultSubmit, dirtyForm, escapeHtml, errorBlock, icon, noticeBlock, page, saveRow, selectField, switchRow,
  textField,
} from './html.js';
import { LIFE_SAFETY_DISCLAIMER } from '../api/disclaimer.js';
import { hasSomethingToWatch, hasWeatherLocation, readMatch, readRuleRows, setRuleEnabled } from '../api/rules.js';
import { readWeatherSettings, writeWeatherSettings } from '../api/queries.js';
import { call, resolveConnection } from '../modules/homeassistant/client.js';
import { checkbox, coordinate, optionalText, parse, z } from '../validation.js';
import { readSaved, savedRedirect } from './saved.js';
import { ago, navModules, type AdminDeps } from './admin.js';
import { selfHref } from './self.js';

/**
 * The screen's one form (RFC 009 Phase 3.1).
 *
 * It used to be two, and that was the fault: the forecast's fields sat in the
 * first and the alerts switch in the second, with a button labelled "Save" on
 * each, 350px apart, and the lower one directly beneath the hint telling you to
 * fill in the location above. A browser sends the fields of the form whose
 * button was pressed and no others — so typing a location and pressing the
 * Save you could see stored the switch and threw the numbers away without a
 * word. One form and one Save is the fix; two forms on one page was an
 * implementation detail the household was being asked to model.
 *
 * The coordinates are optional here and checked against the switch in the
 * handler: turning the forecast *off* must not demand two numbers first.
 * `checkbox()`, not `z.unknown().transform`, because an unticked box is not
 * sent at all and the latter would make the key required.
 */
const weatherBody = z.object({
  weather_enabled: checkbox(),
  alerts_enabled: checkbox(),
  latitude: optionalText(20),
  longitude: optionalText(20),
  // A select always sends its value, so these are plain optional text with a
  // safe fallback in the handler rather than a required enum that would reject
  // an older form. Only the two known values are honoured.
  weather_provider: optionalText(20),
  weather_units: optionalText(20),
});

/**
 * What "Use my Home Assistant home location" reads off the same form.
 *
 * Deliberately *not* `weatherBody`: this endpoint replaces the coordinates, so
 * a coordinate it cannot parse must not be able to fail it. Reading a narrower
 * shape is what makes that true by construction rather than by an ordering the
 * next edit could undo — and `parse` is non-strict, so the fields it ignores
 * simply travel past.
 */
const haLocationBody = z.object({
  weather_enabled: checkbox(),
  alerts_enabled: checkbox(),
  weather_provider: optionalText(20),
  weather_units: optionalText(20),
});

/**
 * The hidden field the one form carries, and the only way to tell it apart
 * from an empty body. See where it is rendered for why that matters.
 */
const FORM_MARKER = 'weather_form';

/** Did this body come from the screen's own form, or is it something else? */
function fromTheForm(body: Record<string, unknown>): boolean {
  return typeof body[FORM_MARKER] === 'string';
}

/**
 * What the household had on screen, for a form that comes back at 400.
 *
 * Every field as they left it, so a rejected latitude does not also cost the
 * switch they flipped and the provider they chose. Raw strings on purpose: the
 * whole point is to hand back the thing that failed to parse, and re-rendering
 * from the stored row instead is the same silent loss this phase is about, one
 * error message along.
 */
interface WeatherEcho {
  readonly weatherEnabled: boolean;
  readonly alertsEnabled: boolean;
  readonly latitude: string;
  readonly longitude: string;
  readonly provider: string;
  readonly units: string;
}

/** The echo, read off the raw body — before any schema has had an opinion. */
function echoOf(body: Record<string, unknown>): WeatherEcho {
  const str = (key: string): string => (typeof body[key] === 'string' ? (body[key] as string) : '');
  return {
    weatherEnabled: typeof body['weather_enabled'] === 'string',
    alertsEnabled: typeof body['alerts_enabled'] === 'string',
    latitude: str('latitude'),
    longitude: str('longitude'),
    provider: str('weather_provider'),
    units: str('weather_units'),
  };
}

/**
 * The alerts screen.
 *
 * Small on purpose. Almost every household should never come here: the shipped
 * ladder is the decision, and the point of shipping defaults is that nobody has
 * to configure a tornado warning. What this screen owes them is the switch, an
 * honest account of what each level does, the zones being watched so they can
 * tell it is the right place — and the disclaimer, first.
 */

const ACTION_WORDS: Readonly<Record<string, string>> = {
  takeover_and_wake: 'Covers the wall, and wakes it if it has gone dark',
  takeover: 'Covers the wall',
  banner: 'A strip above the calendar',
  none: 'Nothing',
};

export function registerAlertRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/alerts', (c: Context) => c.html(alertsPage(c)));

  /**
   * The alerts switch's old endpoint, kept only to say it has moved.
   *
   * It used to back the second of this screen's two forms and it writes
   * nothing now — but deleting it outright left a page cached from before the
   * merge answering its own Save with a bare 404, while the *other* Save on
   * that same page got the considered "out of date, reload" below. One stale
   * page, two different answers, one of them a stack of nothing.
   *
   * It is not re-honoured, because honouring half a stale page is how a
   * household comes to believe the stale page works. One rule: reload.
   */
  app.post('/admin/alerts', (c: Context) =>
    c.html(
      alertsPage(c, 'That page was out of date, so nothing was changed. Reload this page and try again.'),
      400,
    ),
  );

  /**
   * One rung of the ladder, on or off.
   *
   * The value, not the presence of the key — and that distinction is the whole
   * of a bug that shipped: this is a *hidden* input rather than a checkbox, so
   * the card always sends `enabled`, carrying `1` to turn on and the empty
   * string to turn off. Read as `typeof body['enabled'] === 'string'` (the
   * right reading for a checkbox, which is simply absent when unticked) the
   * empty string is still a string, so **every "Turn off" in the alert ladder
   * re-enabled the rule it was pressed on** — 302, no error, and the card came
   * back saying "Turn off" again. Nothing tested it.
   */
  app.post('/admin/alerts/rules/:id', async (c: Context) => {
    const id = c.req.param('id') ?? '';
    if (!readRuleRows(deps.db).some((row) => row.id === id)) return c.redirect('/admin/alerts', 302);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(z.object({ enabled: optionalText(4) }), body);
    setRuleEnabled(deps.db, id, shaped.ok && shaped.value.enabled === '1');
    return savedRedirect(c, '/admin/alerts', 'alert-rule-updated');
  });

  /**
   * Both settings, written together.
   *
   * `alerts_enabled` used to have a POST of its own. It has none now, because
   * a second endpoint is a second form, and a second form on this page is the
   * bug (see `weatherBody`). Turning alerts on still brings the zone poll
   * forward, which is the only reason this is not a plain two-table write.
   */
  function writeAll(value: {
    weatherEnabled: boolean;
    alertsEnabled: boolean;
    latitude: number | null;
    longitude: number | null;
    provider: 'nws' | 'openmeteo';
    units: 'imperial' | 'metric';
  }): void {
    writeWeatherSettings(deps.db, {
      enabled: value.weatherEnabled,
      latitude: value.latitude,
      longitude: value.longitude,
      provider: value.provider,
      units: value.units,
    });
    /*
     * The poll is brought forward on the *transition*, not on every save.
     *
     * "Bring it forward so the household sees the zones fill in rather than
     * staring at 'working it out' for a minute" is right for the moment
     * somebody turns alerts on. It is wrong for every subsequent save: once the
     * alerts switch shares this form, changing the units would reset
     * `next_run_at` too, which throws away the job's failure backoff — so a
     * household fiddling with the forecast would hammer api.weather.gov while
     * it was having a bad morning.
     */
    const wasOn = readAlertsEnabled();
    deps.db
      .prepare(`UPDATE household_settings SET alerts_enabled = ?, updated_at = ? WHERE id = 'singleton'`)
      .run(value.alertsEnabled ? 1 : 0, now());
    if (value.alertsEnabled && !wasOn) {
      deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'alerts-sync'`).run();
    }
  }

  /**
   * The whole screen's settings, on the Weather page — everything weather in
   * one place. A household answering "do I want weather on the wall, where does
   * it look, and do I want warnings" should not hunt across two forms for it.
   */
  app.post('/admin/weather', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    /*
     * Only this screen's own form may write these settings.
     *
     * Every switch on it is a checkbox, and an unticked checkbox is not sent —
     * so a body missing `alerts_enabled` is indistinguishable from a household
     * turning alerts off. That is fine for the form, which always carries the
     * marker; it is not fine for anything else, and the case that matters is a
     * page cached from before the alerts switch moved into this form. Refusing
     * is louder than silently turning off somebody's tornado warnings.
     */
    if (!fromTheForm(body)) {
      return c.html(
        alertsPage(c, 'That page was out of date, so nothing was changed. Reload this page and try again.'),
        400,
      );
    }
    const shaped = parse(weatherBody, body);
    // Echoed back on every failure below, so a rejected number never also costs
    // the switch they flipped or the provider they chose.
    const echo = echoOf(body);
    if (!shaped.ok) return c.html(alertsPage(c, shaped.message, echo), 400);

    /*
     * Blank is "not set yet"; wrong is an error. The difference is the whole
     * rule, and getting it wrong deadlocked the screen.
     *
     * The first version refused any save with the forecast on and no location —
     * which is the *default state of a fresh install*, because
     * `weather_enabled` defaults to 1 and there are no coordinates. Every
     * submission came back 400, so the alerts switch that now shares this form
     * could not be turned off, or on, at all. A household could not have got
     * out of it from this screen.
     *
     * So a location the household has not filled in is stored as absent and the
     * page says so where it matters (the alerts section names it, and the
     * forecast panel is simply not drawn). A *typed* coordinate that is not one
     * — "999", or one of a pair — is still refused, because that is a mistake
     * they can only fix by being told.
     */
    const blank = shaped.value.latitude === undefined && shaped.value.longitude === undefined;
    const lat = parse(coordinate('Latitude', 90), shaped.value.latitude);
    const lon = parse(coordinate('Longitude', 180), shaped.value.longitude);
    if (!blank && (!lat.ok || !lon.ok)) {
      return c.html(
        alertsPage(
          c,
          'A location is both numbers together — latitude between -90 and 90, longitude ' +
            'between -180 and 180. Your phone’s map app shows both if you press and hold ' +
            'on your house, or leave them empty for now.',
          echo,
        ),
        400,
      );
    }
    /*
     * Blank is "not set yet" — it is not a way to delete one by accident.
     *
     * Clearing a stored location is not a small edit: `writeWeatherSettings`
     * treats a move as a move and retires every NWS alert zone, which un-arms
     * every weather rule. "Weather settings saved." would be the strip's word
     * for the household's tornado warnings going quiet. So an empty pair is
     * saved only while nothing depends on it — which is exactly the fresh
     * install the deadlock fix above is for — and otherwise says what it would
     * cost and how to mean it.
     */
    if (blank && hasWeatherLocation(deps.db) && (shaped.value.weather_enabled || shaped.value.alerts_enabled)) {
      return c.html(
        alertsPage(
          c,
          'That would clear the location this household already has, and both the forecast ' +
            'and the weather alerts are worked out from it. Type a new location, or turn ' +
            'both of them off first.',
          echo,
        ),
        400,
      );
    }

    writeAll({
      weatherEnabled: shaped.value.weather_enabled,
      alertsEnabled: shaped.value.alerts_enabled,
      latitude: lat.ok ? lat.value : null,
      longitude: lon.ok ? lon.value : null,
      provider: shaped.value.weather_provider === 'openmeteo' ? 'openmeteo' : 'nws',
      units: shaped.value.weather_units === 'metric' ? 'metric' : 'imperial',
    });
    return savedRedirect(c, '/admin/alerts', 'weather');
  });

  /**
   * Fill the location from Home Assistant's own home zone.
   *
   * The commonest install is an add-on, and the box already knows where home is
   * — `zone.home` carries a latitude and longitude. Read-only, like everything
   * else here: this only ever reads the zone's coordinates.
   *
   * It is a second submit button *inside* the one form rather than a form of
   * its own (`formaction`), so it carries whatever the household has typed but
   * not yet saved and this handler can put it back. A separate form would be
   * the two-forms bug again in a quieter costume: press it after changing the
   * provider and the provider change would be gone.
   */
  app.post('/admin/weather/use-ha-location', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const posted = fromTheForm(body) ? parse(haLocationBody, body) : undefined;
    const echo = posted === undefined ? undefined : echoOf(body);
    /*
     * A refusal, not a quiet fallback.
     *
     * Reverting to the stored row here would throw away the edits the button
     * was pressed to keep — and then redirect saying "Location filled in from
     * Home Assistant, and saved.", which is the dishonest half of the problem
     * this phase is about. The fallback below is for a body that is *not* this
     * form at all.
     */
    if (posted !== undefined && !posted.ok) {
      return c.html(alertsPage(c, posted.message, echo), 400);
    }
    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      return c.html(
        alertsPage(
          c,
          'Home Assistant is not connected. Connect it on the Home Assistant page, then try this again.',
          echo,
        ),
        400,
      );
    }
    const home = await call(deps.fetcher, resolved.connection, '/states/zone.home');
    if (!home.ok) {
      return c.html(alertsPage(c, 'Could not read your Home Assistant home location.', echo), 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(home.body);
    } catch {
      raw = null;
    }
    const located = parse(
      z.object({ attributes: z.object({ latitude: z.number(), longitude: z.number() }) }),
      raw,
    );
    if (!located.ok) {
      return c.html(
        alertsPage(
          c,
          'Home Assistant did not return a home location. Set your home zone in Home Assistant ' +
            '(Settings → Areas, labels & zones), then try again.',
          echo,
        ),
        400,
      );
    }
    /*
     * The posted form wins over the stored row, and falls back to it.
     *
     * The button lives inside the one form, so the body is normally what is on
     * screen — including a switch the household just flipped. Anything that is
     * *not* that form (a bodyless POST, a page cached from before this release)
     * falls back to what is stored, which is the answer this handler always
     * gave: fill the location in, change nothing else. The marker is what makes
     * the two distinguishable — an unticked checkbox is not sent, so without it
     * an empty body reads as "turn everything off" (see `POST /admin/weather`).
     */
    const stored = readWeatherSettings(deps.db);
    const rest = posted?.ok === true
      ? {
          weatherEnabled: posted.value.weather_enabled,
          alertsEnabled: posted.value.alerts_enabled,
          provider: posted.value.weather_provider === 'openmeteo' ? ('openmeteo' as const) : ('nws' as const),
          units: posted.value.weather_units === 'metric' ? ('metric' as const) : ('imperial' as const),
        }
      : {
          weatherEnabled: stored.enabled,
          alertsEnabled: readAlertsEnabled(),
          provider: stored.provider,
          units: stored.units,
        };
    writeAll({
      ...rest,
      latitude: located.value.attributes.latitude,
      longitude: located.value.attributes.longitude,
    });
    return savedRedirect(c, '/admin/alerts', 'weather-location');
  });

  /** Whether National Weather Service alerts are on, as one reader. */
  function readAlertsEnabled(): boolean {
    const row = deps.db
      .prepare(`SELECT alerts_enabled AS enabled FROM household_settings WHERE id = 'singleton'`)
      .get() as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  /**
   * The Forecast section's head: what it is, and what it is doing right now.
   *
   * Outside the form because none of it is a field, and above it because "is
   * this working" is the question somebody arrives with — a household who can
   * see five real days on the wall has no reason to touch anything below.
   *
   * Reads the *active* provider's own cache, so switching provider shows the
   * new one filling in rather than the old one's last answer.
   */
  function forecastPreview(): string {
    const weather = readWeatherSettings(deps.db);
    const located = weather.latitude !== null && weather.longitude !== null;
    const providerName = weather.provider === 'openmeteo' ? 'Open-Meteo' : 'National Weather Service';

    let forecastBlock = '';
    const row = deps.db
      .prepare(`SELECT payload, fetched_at AS fetchedAt FROM weather_cache WHERE cache_key = ?`)
      .get(`${weather.provider}:forecast`) as { payload: string; fetchedAt: number } | undefined;
    if (row !== undefined) {
      try {
        const days = (JSON.parse(row.payload) as {
          days?: { name: string; high: number | null; low: number | null; icon: string }[];
        }).days ?? [];
        if (days.length > 0) {
          const strip = days
            .slice(0, 5)
            .map(
              (day) =>
                `<li><span class="when">${escapeHtml(day.name)}</span><span>` +
                `${escapeHtml(day.icon)} ` +
                (day.high === null ? '' : `${day.high}°`) +
                (day.low === null ? '' : ` / ${day.low}°`) +
                `</span></li>`,
            )
            .join('');
          forecastBlock =
            `<div class="preview"><h3>On the wall now</h3>` +
            `<p class="host">${escapeHtml(providerName)} · updated ${escapeHtml(ago(row.fetchedAt, now()))}</p>` +
            `<ul>${strip}</ul></div>`;
        }
      } catch {
        // A malformed cache is not worth failing the settings page over.
      }
    }

    return (
      `<h2 class="add" style="margin-top:0;padding-top:0;border-top:0">Forecast</h2>` +
      `<p class="hint">A five-day forecast strip. It is a widget like any other — ` +
      `choose where it sits on the <a class="link" href="admin/walls/default">Default wall</a>.</p>` +
      forecastBlock +
      (weather.enabled && located && forecastBlock === ''
        ? `<p class="hint">Location set — the forecast arrives on the next check, within a few minutes.</p>`
        : '')
    );
  }

  /**
   * The screen's one form: the forecast, then the alerts, then one Save.
   *
   * Everything a household can *set* about weather is in here, in the order
   * they would think about it — is it on, where is home, whose forecast, which
   * units, and do I want warnings. The alert rules below are not settings in
   * this sense: each is an action on one rule with its own verb ("Turn off"),
   * and HTML has no nested forms anyway, so the form closes before them.
   *
   * The Home Assistant button is a second *submit* rather than a second form
   * (`formaction`), which is what lets it carry the unsaved fields — see the
   * handler. It deliberately carries no dirty-state marker: `settings-form.js`
   * manages the one control marked `data-dirty-save`, and a button whose whole
   * job is to fill a field in must work before anything has been edited.
   */
  function weatherForm(echo?: WeatherEcho): string {
    const stored = readWeatherSettings(deps.db);
    const haConnected = resolveConnection(deps.db, deps.keyring).ok;
    // The echo wins wherever there is one, so a 400 hands the form back exactly
    // as it was left; with none, the stored row is the form.
    const number = (n: number | null): string => (n === null ? '' : String(n));
    const weather = {
      enabled: echo?.weatherEnabled ?? stored.enabled,
      latitude: echo === undefined ? number(stored.latitude) : echo.latitude,
      longitude: echo === undefined ? number(stored.longitude) : echo.longitude,
      /*
       * Normalised to the two values the handler honours, never echoed raw.
       *
       * These are closed lists, and a value that matches no option selects
       * *nothing* — the browser then preselects whatever comes first, over a
       * live Save. That is the timezone defect one screen along (see
       * `systemPage`), and the rule is the same: an echo belongs on a text
       * field; a `<select>` gets the value a save would actually store.
       */
      provider:
        echo === undefined
          ? stored.provider
          : echo.provider === 'openmeteo'
            ? ('openmeteo' as const)
            : ('nws' as const),
      units:
        echo === undefined
          ? stored.units
          : echo.units === 'metric'
            ? ('metric' as const)
            : ('imperial' as const),
    };
    const alertsOn = echo?.alertsEnabled ?? readAlertsEnabled();

    return (
      `<form method="post" action="admin/weather"${dirtyForm(echo !== undefined)}>` +
      /*
       * Which form this is, and it is load-bearing rather than tidy.
       *
       * A checkbox that is not ticked is not sent, so an *empty* body and a
       * form with every switch off are byte-identical. Once the alerts switch
       * joined this form that stopped being harmless: a page cached from before
       * this release posts the old form, which has no alerts field and never
       * did, and the household's weather alerts go quietly off. The marker is
       * how a form says "this is me, and everything I do not mention is off".
       */
      `<input type="hidden" name="${FORM_MARKER}" value="1">` +
      defaultSubmit() +
      switchRow({
        label: 'Show the forecast',
        name: 'weather_enabled',
        checked: weather.enabled,
      }) +
      `<div class="row-fields">` +
      textField({
        label: 'Latitude',
        name: 'latitude',
        // "e.g." on purpose: 38.8894 is the geographic centre of the United
        // States, and a plain number here looked like a stored value in an
        // empty field rather than an example of the shape one takes.
        placeholder: 'e.g. 38.8894',
        value: weather.latitude,
        attrs: 'inputmode="decimal"',
      }) +
      textField({
        label: 'Longitude',
        name: 'longitude',
        placeholder: 'e.g. -97.7431',
        value: weather.longitude,
        attrs: 'inputmode="decimal"',
      }) +
      `</div>` +
      `<p class="hint">Press and hold your house in a phone map app to get both numbers. ` +
      `The alert zones below are worked out from the same location.</p>` +

      // The easy way, for the common install: read the location Home Assistant
      // already knows. Only offered when there is a connection to read it from.
      (haConnected
        ? `<div class="row"><button class="secondary" type="submit" ` +
          `formaction="admin/weather/use-ha-location">Use my Home Assistant home location` +
          `</button></div>` +
          `<p class="hint">Fills the latitude and longitude from Home Assistant’s ` +
          `home zone, so there are no numbers to look up. It saves the rest of this ` +
          `form at the same time.</p>`
        : '') +

      `<div class="row-fields">` +
      selectField({
        label: 'Forecast from',
        name: 'weather_provider',
        optionsHtml:
          `<option value="nws"${weather.provider === 'nws' ? ' selected' : ''}>` +
          `National Weather Service (US only)</option>` +
          `<option value="openmeteo"${weather.provider === 'openmeteo' ? ' selected' : ''}>` +
          `Open-Meteo (worldwide)</option>`,
      }) +
      selectField({
        label: 'Units',
        name: 'weather_units',
        optionsHtml:
          `<option value="imperial"${weather.units === 'imperial' ? ' selected' : ''}>Fahrenheit (°F)</option>` +
          `<option value="metric"${weather.units === 'metric' ? ' selected' : ''}>Celsius (°C)</option>`,
      }) +
      `</div>` +
      `<p class="hint">The National Weather Service always reports in Fahrenheit; ` +
      `the units choice applies to Open-Meteo.</p>` +

      (weather.provider === 'openmeteo'
        ? `<p class="hint">Open-Meteo covers the whole world and needs no account ` +
          `or key. Weather alerts, below, are still the US National Weather Service ` +
          `only — Open-Meteo has no alert feed.</p>`
        : noticeBlock(
            'The forecast comes from the US National Weather Service.',
            'It covers the United States only. Outside the US, switch “Forecast from” ' +
              'to Open-Meteo above.',
          )) +

      `<h2 class="add">Alerts</h2>` +
      // Before the switch. Somebody deciding whether to rely on this should
      // read it before they decide, not after. Prominence, not alarm — this is
      // not an error, so it is not in the .error surface.
      noticeBlock('Not a life-safety system.', LIFE_SAFETY_DISCLAIMER) +
      switchRow({
        label: 'Show National Weather Service alerts on the wall',
        name: 'alerts_enabled',
        checked: alertsOn,
        hint:
          'The United States only. There is no account and no key — alerts are ' +
          'a public service. Nothing about your household is sent; the request ' +
          'asks about a public zone code.',
      }) +
      /*
       * Read off the *form*, not off the database.
       *
       * Everything else in here shows `weather`, which is the echo on a 400 —
       * so asking the stored row would put "Fill in the latitude and longitude
       * above" under two boxes that visibly have numbers in them, on exactly
       * the re-render where the household is looking hardest.
       */
      (weather.latitude !== '' && weather.longitude !== ''
        ? ''
        : `<p class="hint">Fill in the latitude and longitude above — the alert ` +
          `zones are worked out from them.</p>`) +

      saveRow('admin/alerts') +
      `</form>`
    );
  }

  function alertsPage(c: Context, error?: string, echo?: WeatherEcho): string {
    const zones = deps.db
      .prepare(
        /*
         * `enabled = 1`, the same predicate the poller and the arming gate use.
         * A zone retired because the household moved is not polled and arms
         * nothing, so listing it under "Zones being watched" on the same page
         * whose rule cards read "not armed — no zones yet" is this screen
         * disagreeing with itself.
         */
        `SELECT code, kind, last_polled_at AS lastPolledAt, last_error AS lastError
           FROM alert_zones WHERE provider = 'nws' AND enabled = 1 ORDER BY kind`,
      )
      .all() as { code: string; kind: string; lastPolledAt: number | null; lastError: string | null }[];

    const live = deps.db
      .prepare(
        `SELECT event, severity, area_desc AS areaDesc FROM active_alerts
          WHERE expires_at IS NULL OR expires_at > ? ORDER BY expires_at`,
      )
      .all(now()) as { event: string; severity: string | null; areaDesc: string | null }[];

    const enabled = readAlertsEnabled();
    /*
     * The one reader of this fact, shared with the evaluator and the overview.
     * Written out here it was `household?.latitude !== null && …`, which is
     * `true` when there is no settings row at all — optional chaining yields
     * `undefined`, and `undefined !== null`. It said "located" on a database
     * with nothing in it.
     */
    const located = hasWeatherLocation(deps.db);

    return page({
      self: selfHref(c),
      modules: navModules(deps.db),
      title: 'Weather — Maverick Wall',
      nav: 'alerts',
      heading: 'Weather',
      saved: readSaved(c),
      intro: 'The forecast strip on the wall, and the National Weather Service alerts — both here, both fed from one location.',
      body:
        (error === undefined ? '' : errorBlock(error)) +

        // Status first, then the one form, then the things that are not
        // settings: the zones, what is in force, and the ladder.
        forecastPreview() +
        weatherForm(echo) +

        `<h2 class="add">Zones being watched</h2>` +
        (zones.length === 0
          ? `<p>` +
            (enabled && located
              ? /*
                 * Not "working them out on the next check", which was said for
                 * every zero-zone case and is only true of one of them. A
                 * location outside the service resolves to nothing at all, and
                 * from here the two are indistinguishable — so both are named
                 * rather than the hopeful one asserted (RFC 009 Phase 2).
                 */
                'None yet — either the first check has not run, or this location ' +
                'is outside National Weather Service coverage. Until there is one, ' +
                'no alert rule below is armed.'
              : 'None yet.') +
            `</p>`
          : zones
              .map(
                (zone) =>
                  `<article class="card"><h2>${escapeHtml(zone.code)}</h2>` +
                  `<p class="host">${zone.kind === 'county' ? 'County' : 'Forecast zone'}` +
                  `${zone.lastPolledAt === null ? '' : ' · checked ' + escapeHtml(ago(zone.lastPolledAt, now()))}</p>` +
                  (zone.lastError === null ? '' : errorBlock(zone.lastError)) +
                  `</article>`,
              )
              .join('')) +
        // Both, and why. Watching only one silently misses a category.
        `<p class="hint">Two: most alerts are issued against the forecast zone, and ` +
        `flood warnings in particular are issued by county.</p>` +

        (live.length === 0
          ? ''
          : `<h2 class="add">In force now</h2>` +
            live
              .map(
                (alert) =>
                  `<article class="card"><h2>${escapeHtml(alert.event)}</h2>` +
                  `<p class="host">${escapeHtml(alert.severity ?? 'Unknown')}` +
                  `${alert.areaDesc === null ? '' : ' · ' + escapeHtml(alert.areaDesc)}</p></article>`,
              )
              .join('')) +

        `<h2 class="add">What each level does</h2>` +
        `<p class="hint">Shipped this way because the shape of the ladder matters more ` +
        `than any one row: the loudest thing the wall can do is reserved for the ` +
        `rarest. Moderate alerts are weekly in some counties, and a takeover for one ` +
        `would be meaningless within a month.</p>` +
        rules(hasSomethingToWatch(deps.db)) +
        `<p class="hint">Turning one off means the wall says nothing at that level.</p>`,
    });
  }

  /**
   * The ladder, and whether each rung is actually armed.
   *
   * A table rather than five ~180px cards: each held three short lines and one
   * small button, 900px of a 2,400px page, and the on/off state was
   * communicated *only* by the button label — a household scanning four "Turn
   * off" buttons had to invert each one to know what was on. A row's state is
   * a chip now, and the button moves to an overflow so it reads as an action
   * rather than as the state itself.
   *
   * `watching` is not decoration: with no zone being watched there is no signal
   * any of these could match, so `readRules` refuses to arm them (RFC 009 Phase
   * 2). A row that said "on" here while the evaluator treated it as off would
   * be the screen disagreeing with the wall, which is exactly the fault this
   * phase is about — so the chip reads the same fact the evaluator does.
   */
  function rules(watching: boolean): string {
    const rows = readRuleRows(deps.db)
      .filter((row) => row.trigger === 'nws')
      .map((row) => {
        const parsed = readMatch(safeJson(row.conditions));
        const severity = parsed?.match.minSeverity ?? 'Any';
        const urgency = parsed?.match.minUrgency;
        const off = row.enabled !== 1;
        const armed = !off && watching;
        const stateLabel = off ? 'Off' : armed ? 'On' : 'Not armed';
        const stateClass = off ? 'tag' : armed ? 'tag tag-ok' : 'tag tag-warn';
        const stateTitle = off || armed ? '' : ' title="No zone is being watched yet"';
        return (
          `<tr>` +
          `<td><div class="rname">${escapeHtml(row.name)}</div>` +
          `<div class="host">${escapeHtml(severity)} or worse` +
          `${urgency === undefined ? '' : `, and ${escapeHtml(urgency)}`}</div>` +
          `<div class="host">${escapeHtml(ACTION_WORDS[row.action] ?? row.action)}` +
          `${row.piercesNightMode === 1 ? ' · may wake a dark wall' : ''}` +
          `${row.dismissible === 0 ? ' · cannot be cleared from the wall' : ''}</div></td>` +
          `<td><span class="${stateClass}"${stateTitle}>${stateLabel}</span></td>` +
          `<td class="ovfcell"><details class="ovf" data-overflow>` +
          `<summary class="ovf-btn" role="button" aria-haspopup="menu" ` +
          `aria-label="More actions for ${escapeHtml(row.name)}" title="More">${icon('more')}</summary>` +
          `<div class="ovf-menu" role="menu">` +
          `<form method="post" action="admin/alerts/rules/${encodeURIComponent(row.id)}">` +
          `<input type="hidden" name="enabled" value="${row.enabled === 1 ? '' : '1'}">` +
          `<button class="ovf-item" type="submit">${row.enabled === 1 ? 'Turn off' : 'Turn on'}</button>` +
          `</form></div></details></td>` +
          `</tr>`
        );
      })
      .join('');
    return `<table class="rules-table"><tbody>${rows}</tbody></table>`;
  }
}

function safeJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

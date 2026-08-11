import type { Context, Hono } from 'hono';
import { escapeHtml, errorBlock, page } from './html.js';
import { LIFE_SAFETY_DISCLAIMER } from '../api/disclaimer.js';
import { readMatch, readRuleRows, setRuleEnabled } from '../api/rules.js';
import { readWeatherSettings, writeWeatherSettings } from '../api/queries.js';
import { call, resolveConnection } from '../modules/homeassistant/client.js';
import { checkbox, coordinate, optionalText, parse, z } from '../validation.js';
import { navModules, type AdminDeps } from './admin.js';

/**
 * The forecast form's body. The coordinates are optional here and checked
 * against the switch in the handler: turning the forecast *off* must not
 * demand two numbers first. `checkbox()`, not `z.unknown().transform`, because
 * an unticked box is not sent at all and the latter would make the key required.
 */
const weatherBody = z.object({
  weather_enabled: checkbox(),
  latitude: optionalText(20),
  longitude: optionalText(20),
});

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
  takeover_and_wake: 'Covers the wall, and lights a screen that has gone dark',
  takeover: 'Covers the wall',
  banner: 'A strip above the calendar',
  none: 'Nothing',
};

export function registerAlertRoutes(app: Hono, deps: AdminDeps): void {
  const now = deps.now ?? ((): number => Date.now());

  app.get('/admin/alerts', (c: Context) => c.html(alertsPage()));

  app.post('/admin/alerts', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const enabled = typeof body['alerts_enabled'] === 'string';
    deps.db
      .prepare(`UPDATE household_settings SET alerts_enabled = ?, updated_at = ? WHERE id = 'singleton'`)
      .run(enabled ? 1 : 0, now());
    if (enabled) {
      // Bring the poll forward so the household sees the zones fill in rather
      // than staring at "working it out" for a minute.
      deps.db.prepare(`UPDATE job_state SET next_run_at = 0 WHERE kind = 'alerts-sync'`).run();
    }
    return c.redirect('/admin/alerts', 302);
  });

  app.post('/admin/alerts/rules/:id', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    setRuleEnabled(deps.db, c.req.param('id') ?? '', typeof body['enabled'] === 'string');
    return c.redirect('/admin/alerts', 302);
  });

  /**
   * The forecast panel's settings, on the Weather page beside the alerts —
   * everything weather in one place. A household answering "do I want weather on
   * the wall, and where does it look" should not hunt across two screens for it.
   */
  app.post('/admin/weather', async (c: Context) => {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const shaped = parse(weatherBody, body);
    if (!shaped.ok) return c.html(alertsPage(shaped.message), 400);

    // A location is only required when the panel is on: turning weather off must
    // not demand two numbers first.
    const lat = parse(coordinate('Latitude', 90), shaped.value.latitude);
    const lon = parse(coordinate('Longitude', 180), shaped.value.longitude);
    if (shaped.value.weather_enabled && (!lat.ok || !lon.ok)) {
      return c.html(
        alertsPage(
          'Weather needs a location — latitude between -90 and 90, longitude between -180 and 180. ' +
            'Your phone’s map app shows both if you press and hold on your house.',
        ),
        400,
      );
    }

    writeWeatherSettings(deps.db, {
      enabled: shaped.value.weather_enabled,
      latitude: lat.ok ? lat.value : null,
      longitude: lon.ok ? lon.value : null,
    });
    return c.redirect('/admin/alerts', 302);
  });

  /**
   * Fill the location from Home Assistant's own home zone.
   *
   * The commonest install is an add-on, and the box already knows where home is
   * — `zone.home` carries a latitude and longitude. Read-only, like everything
   * else here: this only ever reads the zone's coordinates.
   */
  app.post('/admin/weather/use-ha-location', async (c: Context) => {
    const resolved = resolveConnection(deps.db, deps.keyring);
    if (!resolved.ok) {
      return c.html(
        alertsPage('Home Assistant is not connected. Connect it on the Home Assistant screen, then try this again.'),
        400,
      );
    }
    const home = await call(deps.fetcher, resolved.connection, '/states/zone.home');
    if (!home.ok) {
      return c.html(alertsPage('Could not read your Home Assistant home location.'), 400);
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
          'Home Assistant did not return a home location. Set your home zone in Home Assistant ' +
            '(Settings → Areas, labels & zones), then try again.',
        ),
        400,
      );
    }
    const current = readWeatherSettings(deps.db);
    writeWeatherSettings(deps.db, {
      enabled: current.enabled,
      latitude: located.value.attributes.latitude,
      longitude: located.value.attributes.longitude,
    });
    return c.redirect('/admin/alerts', 302);
  });

  /** The forecast panel's own settings block: switch, location, and a live preview. */
  function weatherSection(): string {
    const weather = readWeatherSettings(deps.db);
    const value = (n: number | null): string => (n === null ? '' : String(n));
    const haConnected = resolveConnection(deps.db, deps.keyring).ok;
    const located = weather.latitude !== null && weather.longitude !== null;

    // What the forecast is doing right now, so it is visibly working rather than
    // a switch that may or may not have taken.
    let forecastBlock = '';
    const row = deps.db
      .prepare(`SELECT payload, fetched_at AS fetchedAt FROM weather_cache WHERE cache_key = 'nws:forecast'`)
      .get() as { payload: string; fetchedAt: number } | undefined;
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
            `<p class="host">National Weather Service · updated ${escapeHtml(ago(row.fetchedAt, now()))}</p>` +
            `<ul>${strip}</ul></div>`;
        }
      } catch {
        // A malformed cache is not worth failing the settings page over.
      }
    }

    const status =
      weather.enabled && located && forecastBlock === ''
        ? `<p class="hint">Location set — the forecast arrives on the next check, within a few minutes.</p>`
        : '';

    return (
      `<p class="hint">A five-day forecast strip. It is a block like any other — ` +
      `choose where it sits on the <a class="link" href="admin/displays/default">Default display</a>.</p>` +
      forecastBlock +
      status +
      `<form method="post" action="admin/weather">` +
      `<div class="checks"><label>` +
      `<input type="checkbox" name="weather_enabled" value="1"` +
      `${weather.enabled ? ' checked' : ''}> Show the forecast</label></div>` +
      `<div class="row-fields">` +
      `<span><label for="latitude">Latitude</label>` +
      `<input id="latitude" name="latitude" type="text" inputmode="decimal" ` +
      `placeholder="38.8894" value="${escapeHtml(value(weather.latitude))}"></span>` +
      `<span><label for="longitude">Longitude</label>` +
      `<input id="longitude" name="longitude" type="text" inputmode="decimal" ` +
      `placeholder="-97.7431" value="${escapeHtml(value(weather.longitude))}"></span>` +
      `</div>` +
      `<p class="hint">Press and hold your house in a phone map app to get both numbers. ` +
      `The alert zones below are worked out from the same location.</p>` +
      `<button type="submit">Save</button></form>` +

      // The easy way, for the common install: read the location Home Assistant
      // already knows. Only offered when there is a connection to read it from.
      (haConnected
        ? `<form method="post" action="admin/weather/use-ha-location">` +
          `<button class="secondary" type="submit">Use my Home Assistant home location</button>` +
          `</form>` +
          `<p class="hint">Fills the latitude and longitude from Home Assistant’s ` +
          `home zone, so there are no numbers to look up.</p>`
        : '') +

      errorBlock(
        'The forecast comes from the US National Weather Service.',
        'It covers the United States only. Elsewhere, leave this off — a second ' +
          'provider is the obvious next module.',
      )
    );
  }

  function alertsPage(error?: string): string {
    const household = deps.db
      .prepare(
        `SELECT alerts_enabled AS enabled, latitude, longitude
           FROM household_settings WHERE id = 'singleton'`,
      )
      .get() as { enabled: number; latitude: number | null; longitude: number | null } | undefined;

    const zones = deps.db
      .prepare(
        `SELECT code, kind, last_polled_at AS lastPolledAt, last_error AS lastError
           FROM alert_zones WHERE provider = 'nws' ORDER BY kind`,
      )
      .all() as { code: string; kind: string; lastPolledAt: number | null; lastError: string | null }[];

    const live = deps.db
      .prepare(
        `SELECT event, severity, area_desc AS areaDesc FROM active_alerts
          WHERE expires_at IS NULL OR expires_at > ? ORDER BY expires_at`,
      )
      .all(now()) as { event: string; severity: string | null; areaDesc: string | null }[];

    const enabled = household?.enabled === 1;
    const located = household?.latitude !== null && household?.longitude !== null;

    return page({
      modules: navModules(deps.db),
      title: 'Weather — Maverick Wall',
      nav: 'alerts',
      heading: 'Weather',
      intro: 'The forecast strip on the wall, and the National Weather Service alerts — both here, both fed from one location.',
      body:
        (error === undefined ? '' : errorBlock(error)) +

        // The everyday panel first: the forecast the wall draws day to day.
        `<h2 class="add" style="margin-top:0;padding-top:0;border-top:0">Forecast</h2>` +
        weatherSection() +

        `<h2 class="add">Alerts</h2>` +
        // Before the switch. Somebody deciding whether to rely on this should
        // read it before they decide, not after.
        `<div class="error"><strong>Not a life-safety system.</strong>` +
        `<span>${escapeHtml(LIFE_SAFETY_DISCLAIMER)}</span></div>` +

        `<form method="post" action="admin/alerts">` +
        `<div class="checks"><label>` +
        `<input type="checkbox" name="alerts_enabled" value="1"${enabled ? ' checked' : ''}> ` +
        `Show National Weather Service alerts on the wall</label></div>` +
        `<p class="hint">The United States only. There is no account and no key — ` +
        `alerts are a public service. Nothing about your household is sent; the ` +
        `request asks about a public zone code.</p>` +
        `<button type="submit">Save</button></form>` +

        (located
          ? ''
          : `<p class="hint">Set your latitude and longitude in the Forecast section ` +
            `above first — the alert zones are worked out from them.</p>`) +

        `<h2 class="add">Zones being watched</h2>` +
        (zones.length === 0
          ? `<p>${enabled && located ? 'Working them out on the next check.' : 'None yet.'}</p>`
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
        rules() +
        `<p class="hint">Turning one off means the wall says nothing at that level.</p>`,
    });
  }

  function rules(): string {
    return readRuleRows(deps.db)
      .filter((row) => row.trigger === 'nws')
      .map((row) => {
        const parsed = readMatch(safeJson(row.conditions));
        const severity = parsed?.match.minSeverity ?? 'Any';
        const urgency = parsed?.match.minUrgency;
        return (
          `<article class="card">` +
          `<h2>${escapeHtml(row.name)}${row.enabled === 1 ? '' : ' (off)'}</h2>` +
          `<p class="host">${escapeHtml(severity)} or worse` +
          `${urgency === undefined ? '' : `, and ${escapeHtml(urgency)}`}</p>` +
          `<p>${escapeHtml(ACTION_WORDS[row.action] ?? row.action)}` +
          `${row.piercesNightMode === 1 ? ' · may wake a dark screen' : ''}` +
          `${row.dismissible === 0 ? ' · cannot be cleared from the wall' : ''}</p>` +
          `<form method="post" action="admin/alerts/rules/${encodeURIComponent(row.id)}">` +
          `<input type="hidden" name="enabled" value="${row.enabled === 1 ? '' : '1'}">` +
          `<button class="secondary" type="submit">` +
          `${row.enabled === 1 ? 'Turn off' : 'Turn on'}</button></form>` +
          `</article>`
        );
      })
      .join('');
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

function ago(from: number, at: number): string {
  const seconds = Math.max(0, Math.round((at - from) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

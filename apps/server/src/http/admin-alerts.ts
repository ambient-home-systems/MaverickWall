import type { Context, Hono } from 'hono';
import { escapeHtml, errorBlock, page } from './html.js';
import { LIFE_SAFETY_DISCLAIMER } from '../api/disclaimer.js';
import { readMatch, readRuleRows, setRuleEnabled } from '../api/rules.js';
import type { AdminDeps } from './admin.js';

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
      title: 'Weather alerts — Maverick Wall',
      heading: 'Weather alerts',
      body:
        `<p><a class="link" href="admin">← Back</a></p>` +
        (error === undefined ? '' : errorBlock(error)) +

        // First, before the switch. Somebody deciding whether to rely on this
        // should read it before they decide, not after.
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
          : `<p class="hint">Set your latitude and longitude on the ` +
            `<a class="link" href="admin/display">Display</a> screen first — the zones ` +
            `are worked out from them.</p>`) +

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

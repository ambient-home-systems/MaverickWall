#!/usr/bin/env node
/*
 * A minimal Maverick Wall module — a complete, working reference.
 *
 * Zero dependencies. A module is just an HTTP service that answers these GETs:
 *   GET /maverick.json  →  who you are (Maverick Wall reads `name`)
 *   GET /panel          →  what to show, as Panel Data (docs/building-a-module.md)
 *   GET /signals        →  OPTIONAL: things that are true now, that the wall's
 *                          alert rules can act on (a banner or a takeover)
 *
 * Maverick Wall polls `/panel` every few minutes and draws it beside the
 * calendar. It never runs anything you send — it only shows a few simple shapes.
 *
 * `/signals` is opt-in on both sides: leave it off (return 404, or omit it) and
 * your module is panel-only. If you serve it, a signal still does nothing until
 * the household turns your module's Alerts control on — and even then a module
 * can only raise a banner or cover the wall, never wake a dark screen.
 *
 *   Run it:   node server.mjs
 *   Options:  PORT=9000 TARGET=2026-12-25 LABEL="Christmas" node server.mjs
 *   Add it:   on the Add-ons screen, paste  http://<this-host>:<PORT>
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9000);
const TARGET = process.env.TARGET ?? '2026-12-25'; // the date to count down to (YYYY-MM-DD)
const LABEL = process.env.LABEL ?? 'the big day';

/** The manifest. Maverick Wall reads `name`; the rest documents the contract. */
const manifest = {
  name: `Countdown to ${LABEL}`,
  version: '1.0.0',
  contract: 1, // the Panel Data Schema version you speak
  block: { key: 'countdown', label: 'Countdown' },
  intervalSeconds: 3600, // how often you'd like to be polled (Maverick Wall clamps this)
};

/**
 * The panel. Return exactly one of: readings | stat | tiles | text.
 * Every string is capped and sanitised on the wall; no HTML, no URLs, no code.
 */
function panel() {
  const target = new Date(`${TARGET}T00:00:00`);
  const today = new Date(new Date().toDateString());
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  return {
    kind: 'stat',
    title: LABEL,
    value: days === 0 ? 'Today' : String(Math.abs(days)),
    caption: days === 0 ? '' : `${Math.abs(days) === 1 ? 'day' : 'days'}${days < 0 ? ' ago' : ''}`,
  };

  /*
   * The other shapes you could return instead — see docs/building-a-module.md:
   *
   * return { kind: 'readings', title: 'Bins', items: [
   *   { label: 'Recycling', value: 'Tomorrow', icon: '♻️' },
   *   { label: 'General',   value: 'Mon 25th', icon: '🗑️' } ] };
   *
   * return { kind: 'tiles', title: 'Fuel', items: [
   *   { label: 'Petrol', value: '£1.47' }, { label: 'Diesel', value: '£1.55' } ] };
   *
   * return { kind: 'text', text: 'Bins out tonight — recycling and food.' };
   */
}

/**
 * Signals — facts the wall's alert rules can act on. Optional.
 *
 * Return `{ signals: [...] }`, each `{ key, title, severity?, startsInSec? }`:
 *   - `key`      stable id for the thing, so the household can dismiss it
 *   - `title`    what the wall says, at its largest (capped and sanitised)
 *   - `severity` optional CAP level: Minor | Moderate | Severe | Extreme
 *   - `startsInSec` optional: seconds until it begins (for "starting soon")
 * Return `{ signals: [] }` when nothing is true. Emit only what is worth an
 * alert — you are the filter; the household only chooses banner vs takeover.
 *
 * Here: the day itself is the one thing worth interrupting for.
 */
function signals() {
  const target = new Date(`${TARGET}T00:00:00`);
  const today = new Date(new Date().toDateString());
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return { signals: [{ key: 'the-day', title: `${LABEL} — today!` }] };
  return { signals: [] };
}

function send(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((request, response) => {
  if (request.url === '/maverick.json') return send(response, manifest);
  if (request.url === '/panel') return send(response, panel());
  if (request.url === '/signals') return send(response, signals());
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not found"}');
}).listen(PORT, () => {
  console.log(`Example module listening on http://localhost:${PORT}`);
  console.log(`  manifest  http://localhost:${PORT}/maverick.json`);
  console.log(`  panel     http://localhost:${PORT}/panel`);
  console.log(`  signals   http://localhost:${PORT}/signals`);
});

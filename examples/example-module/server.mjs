#!/usr/bin/env node
/*
 * A minimal Maverick Wall module — a complete, working reference.
 *
 * Zero dependencies. A module is just an HTTP service that answers two GETs:
 *   GET /maverick.json  →  who you are (Maverick Wall reads `name`)
 *   GET /panel          →  what to show, as Panel Data (docs/building-a-module.md)
 *
 * Maverick Wall polls `/panel` every few minutes and draws it beside the
 * calendar. It never runs anything you send — it only shows a few simple shapes.
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

function send(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((request, response) => {
  if (request.url === '/maverick.json') return send(response, manifest);
  if (request.url === '/panel') return send(response, panel());
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not found"}');
}).listen(PORT, () => {
  console.log(`Example module listening on http://localhost:${PORT}`);
  console.log(`  manifest  http://localhost:${PORT}/maverick.json`);
  console.log(`  panel     http://localhost:${PORT}/panel`);
});

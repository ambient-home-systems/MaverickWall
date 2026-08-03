# Maverick Wall

A self-hosted family calendar for a wall display. One container, one volume, no
subscription.

Runs on your own hardware — a NAS, a Pi, a mini PC, or as a Home Assistant
add-on. Wall-mounted tablets and TVs point at it and run unattended.

```
docker run -d -v ./data:/data -p 8080:8080 ghcr.io/<me>/maverick-wall
```

## Status

Works end to end, from a calendar feed to pixels on a wall. **860 tests.**
There is no Docker image yet, so today it runs from a checkout.

- `packages/calendar` — ICS parsing and recurrence expansion. Pure, never
  throws, 153 tests. Extracted as MIT eventually.
- `packages/core` — SSRF guards, civil dates, shift rotation, scheduler policy.
  Pure. No I/O.
- `apps/server` — Hono, SQLite, scheduler, sync, manifest API, and the
  server-rendered setup wizard and admin screens.
- `apps/server/src/modules` — panel modules. Weather (NWS, United States only)
  and Home Assistant.
- `apps/display` — the wall itself. Vanilla TS, portrait and landscape, draws
  from a stored manifest when the server is unreachable.
- `apps/admin` — does not exist, and may never need to. The admin screens are
  server-rendered.

## Home Assistant

Optional, and **read-only — permanently**.

Two ways in, detected automatically: as a Home Assistant add-on there is
nothing to configure, and alongside a separate Home Assistant you paste in a
long-lived access token. After that it is the same code.

It can put a few readings beside the calendar, take your Home Assistant
calendars as sources, and interrupt the wall when something in the house needs
saying — a leak, a garage door open at midnight.

**It cannot control anything, and that is the point.** A long-lived access
token has full control of a home and cannot be limited to reading, so the limit
lives on this side instead:

- Nothing in this repository sends a write of any kind to Home Assistant. No
  service calls, no scenes, no switches.
- Your wall receives **resolved values** — "19.4 °C", "Open". Never the token,
  never an entity name, and never an endpoint it could ask its own questions
  through. There is a test asserting exactly that.
- The token is stored encrypted, and never appears in a log, an error message,
  or the diagnostics export.

If a tablet in your hallway is ever compromised, the worst it can give away is
your indoor temperature.

## Getting started

```bash
pnpm install
pnpm test

export DATA_DIR="$PWD/data"          # must be absolute
pnpm --filter @maverick-wall/server build
node apps/server/dist/tools/add-source.js "Family" "<your-ical-url>"
node apps/server/dist/tools/add-screen.js "Kitchen"
node apps/server/dist/main.js
```

Then `curl -H "Authorization: Bearer <token>" localhost:8080/d/manifest`.

See `CLAUDE.md` for the rules this project is built to, and `HANDOFF.md` for the
reasoning behind them.

## Licence

`packages/calendar` is MIT. The rest is unlicensed for now.

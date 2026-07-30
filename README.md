# Maverick Wall

A self-hosted family calendar for a wall display. One container, one volume, no
subscription.

Runs on your own hardware — a NAS, a Pi, a mini PC, or as a Home Assistant
add-on. Wall-mounted tablets and TVs point at it and run unattended.

```
docker run -d -v ./data:/data -p 8080:8080 ghcr.io/<me>/maverick-wall
```

## Status

Server side works end to end. No display yet.

- `packages/calendar` — ICS parsing and recurrence expansion. Pure, never
  throws, 153 tests. Extracted as MIT eventually.
- `packages/core` — SSRF guards, civil dates, shift rotation, scheduler policy.
  Pure. No I/O.
- `apps/server` — Hono, SQLite, scheduler, ICS sync, manifest API.
- `apps/display`, `apps/admin` — not started.

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

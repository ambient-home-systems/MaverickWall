# Example Maverick Wall module

A complete, working module in one zero-dependency file — a countdown to a date.
Use it as the starting point for your own.

## Run it

```bash
node server.mjs
# or configure it:
PORT=9000 TARGET=2026-12-25 LABEL="Christmas" node server.mjs
```

It serves three endpoints:

```
GET /maverick.json   →  { "name": "...", "version": "...", "contract": 1, ... }
GET /panel           →  { "kind": "stat", "title": "Christmas", "value": "135", "caption": "days" }
GET /signals         →  { "signals": [] }   (on the day itself: [{ "key": "the-day", "title": "Christmas — today!" }])
```

`/signals` is optional. It lets a module raise an alert (a banner, or take over
the wall) — but only if the household turns the module's **Alerts** control on,
and a module can never wake a dark screen. See the contract for the full story.

## Add it to the wall

On the Maverick Wall **Add-ons** screen, paste this service's address —
`http://<the-host-running-this>:9000`. Maverick Wall reads `/maverick.json` for
the name, polls `/panel` every few minutes, and draws it beside the calendar.

The module must be reachable from the Maverick Wall container: run it on the same
network, and use the machine's LAN address (not `localhost`) unless the two run
on the same host.

## What a module may return

Exactly one of four shapes — `readings`, `stat`, `tiles`, `text`. The full
contract, the size limits, and the rules (data not code, no HTML, no URLs) are in
[`docs/building-a-module.md`](../../docs/building-a-module.md); the design
rationale is in [`docs/rfc-001-module-framework.md`](../../docs/rfc-001-module-framework.md).

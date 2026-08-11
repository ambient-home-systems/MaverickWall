# RFC 001 — Third-party module framework

Status: **accepted, in progress** · Owner: — · First drafted 2026-08-10

## Summary

Let third-party modules put a panel on the wall without shipping any code the
wall runs. A module is its own HTTP service that a household installs and
registers by URL; Maverick Wall polls it through the SSRF-guarded fetcher, like
a calendar feed, validates the response against a fixed **Panel Data Schema**,
and a **first-party renderer** draws it. Data crosses the boundary; code never
does.

## Why this is not a rewrite

The seam already exists. `apps/server/src/modules/registry.ts` defines
`PanelModule` — `key`, `ready(db)`, `contribute(ctx) -> manifest slice`, an
optional `job`, an optional `signals()` — and `collectPanels` gathers each
ready module's slice into `manifest.panels[key]` with **per-module error
isolation** (one module throwing costs its own panel, never the calendar).
Weather and Home Assistant are the first two modules through it. Its own comment
already anticipates this RFC:

> That property is what would let a third-party add-on work later without new
> trust — it would run as its own process and answer with the same shape over
> HTTP, through the SSRF-guarded fetcher exactly like a calendar feed.

So this RFC **extends that seam across a process boundary**. It adds nothing the
wall executes.

## The one hard problem

**A module contributes data, never code** (rule three: no third-party origin in
the display bundle). A module cannot ship a renderer, HTML, a font, a script, or
a URL the wall fetches. Therefore the framework stands or falls on one question:

> What vocabulary may a module's data speak, and what first-party renderer
> draws it?

Today the nearest thing is the Home Assistant "house" panel: a list of
`{label, value, icon, mode}` readings, sanitized and drawn with `textContent`
only. That is the template. The linchpin deliverable is generalising it into a
**Panel Data Schema** — a small, safe, on-brand display vocabulary — and a
generic renderer for it.

## The Panel Data Schema (the vocabulary)

Deliberately minimal. It is both the safety boundary and what keeps a
third-party panel looking like the wall rather than an arbitrary dashboard.
Every string is length-capped, stripped of control/bidi characters, and drawn
with `textContent`; there is no colour-as-CSS, no HTML, no URL, no icon beyond a
single glyph the device already has.

One panel is exactly one of these shapes (composition of several sections is a
later expansion):

```ts
interface Base { title?: string }            // an optional caption line

type PanelData =
  | (Base & { kind: 'readings'; items: { label: string; value: string; icon?: string }[] })
  | (Base & { kind: 'stat';     value: string; caption?: string })
  | (Base & { kind: 'tiles';    items: { label: string; value: string }[] })
  | (Base & { kind: 'text';     text: string })
```

- `readings` — rows of label/value(/glyph). The house panel, generalised.
- `stat` — one big value and a caption. The Countdown shape.
- `tiles` — a short strip of label/value. The forecast shape.
- `text` — a line or two.

Caps (enforced server-side, re-checked on render): `title` ≤ 60, `items` ≤ 12,
`label`/`value` ≤ 60, `icon` ≤ 4, `text` ≤ 280.

Two enforcement points, on purpose:

- **Server** validates the module's HTTP body against this schema with Zod —
  **reject, not coerce** (rule five). A bad body is a failed poll and a visible
  `last_error`, never a half-drawn panel.
- **Display** re-reads it defensively (`panelFrom(unknown)`), the same way
  `houseFrom`/`weatherFrom` already treat a manifest slice as untrusted — a wall
  a version ahead of the server must still draw something sane.

## The HTTP contract

A module is its own service. Maverick Wall talks to two endpoints, both through
the **SSRF-guarded fetcher** with the same `UrlPolicy` a calendar feed uses
(loopback/LAN opt-in, size and time limits, redirect validation):

- `GET {module}/maverick.json` — the module manifest, self-describing:
  ```json
  { "name": "Bins", "version": "1.0.0", "contract": 1,
    "block": { "key": "ext:bins", "label": "Bin day" },
    "intervalSeconds": 900 }
  ```
  `contract` is the Panel Data Schema version; the wall refuses a contract it
  does not understand rather than guessing. `block.key` is namespaced `ext:` so
  it can never collide with a first-party key.
- `GET {module}/panel` — returns a `PanelData` body. Polled every
  `intervalSeconds` (clamped to a sane floor), cached, contributed as the
  module's manifest slice.

The module never runs in Maverick Wall's process, never sees the master key,
never touches the database. If it needs its own upstream credential (an API
key), that lives in the module's own service — not here.

## Install and registration

An external module is a database row:

```
external_modules(id, url, name, block_key, enabled, sort_order,
                 last_poll_at, last_error, token_encrypted?)
```

Adding one is the "add a calendar" flow you already have: paste a URL →
fetch `maverick.json` and `panel` once through the SSRF guard as a health check
→ store. A generic `ExternalPanelModule` adapter wraps a row as a `PanelModule`,
so ordering, enable/disable, health and the manifest slice all come for free
from the existing registry. Enable/order/remove on a new admin screen (a
"Modules" or "Add-ons" section).

`token_encrypted` is optional and only for a module that wants to authenticate
Maverick Wall's polls; stored encrypted at rest like the Home Assistant token,
never in the manifest.

## Trust model

The threat is: *a buggy or hostile module must not break the wall, leak a
secret, or reach into the house.* This is achieved by the boundary, not by
trusting the module:

- **Separate process** — its own container/add-on. No in-process plugins, ever.
  An in-process plugin would read the master key, bypass the guard, and take the
  wall down when it throws; that is the version this RFC exists to refuse.
- **SSRF-guarded** poll, size/time limits, redirect validation (reuse the
  fetcher unchanged).
- **Schema-validated, sanitised, `textContent`-only** rendering — a module
  cannot inject markup, an origin, a font, or a script.
- **Per-module isolation** — `collectPanels` already swallows one module's
  failure; add a visible `last_error` per module.
- **No secret in the manifest** — already a test; a module's own token stays
  server-side and encrypted.

## Phases

- **Phase 0 — the vocabulary. DONE.** The Panel Data Schema, its server-side Zod
  validator (`modules/external/panel-data.ts`), its defensive display parser
  (`panelFrom`) and the generic renderer (`renderGenericPanel`). How any new
  panel gets drawn without new renderer code.
- **Phase 1 — external panels. DONE.** The `external_modules` table, the
  add-by-URL admin screen (`/admin/modules`), the shared poll job
  (`pollExternalModules`), the `ExternalPanelModule` adapter (registered rows
  join `collectPanels`), and a health/last-error line per module. The block
  system was widened for `ext:<id>` keys end to end (`parseBlocks`,
  `resolveBlocks`, the render loop), and enabling a module inserts its block
  after the built-ins. Modules are **self-configured** — Maverick Wall stores
  only URL + enable + order.
- **Phase 2 — richer.** Two parts. **2a — an external panel as a free-form
  widget. DONE.** A module block is a `Module` in the layout editor, placeable on
  the free-form canvas like any first-party widget. **2b — module-declared
  signals/interrupts. DONE**, and handled with more care than a panel because one
  can cover the whole wall. A module optionally serves `GET /signals`
  (`modules/external/signal-data.ts` — a strict, sanitised, capped schema, no
  `Unknown` severity), the shared poll caches them (`signals` column, replace on
  a good poll, clear on a 404, keep-last-good on a blip), and the adapter offers
  them to the evaluator stamped with source `ext:<id>`. The guardrail is the
  source scope already in core: `signal.source !== rule.source`, so a module's
  signals can never satisfy a weather rule nor another module's rule. Nothing
  fires until the household sets a per-module **Alerts** action (`none` by
  default; `banner` or `takeover`, never `takeover_and_wake`), which maintains a
  single source-scoped rule (`syncModuleAlertRule`). A module may cover the wall
  when someone is looking; it may never wake a dark bedroom, and its interrupt is
  always dismissible. Still open: per-module config passed through.
- **Phase 3 — ecosystem.** A docs page, a directory of known modules, install-UX
  polish.

## Decisions taken

1. **Vocabulary scope:** start minimal (`readings`/`stat`/`tiles`/`text`),
   expand on demand. It is the safety and brand boundary.
2. **Config ownership:** modules self-configure in their own UI first. Maverick
   Wall stores URL + enable + order, not a generic settings form.
3. **Interrupts:** deferred to Phase 2 — panels first; interrupts drive
   safety takeovers and deserve their own scrutiny.
4. **Distribution:** any HTTP service reachable through the SSRF guard (an HA
   add-on, a standalone container, anything on the LAN). The guard is the gate,
   not a package format.

## Non-goals

- No wall-executed third-party code, ever (no scripts, no HTML, no iframes, no
  fonts, no images fetched by the wall).
- No in-process plugins.
- Not a general dashboard: the vocabulary is intentionally small. Home Assistant
  is better at dashboards, and the wall is a family calendar.

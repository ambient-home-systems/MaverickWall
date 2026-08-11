# RFC 002 — A module catalogue, and recipe modules

Status: **proposed, not started** · Owner: — · First drafted 2026-08-11 ·
Builds on [RFC 001](./rfc-001-module-framework.md)

## Summary

Two things, so a household can **browse a list of modules, pick one, and install
it** — the way [Bubble Card](https://github.com/Clooos/Bubble-Card) modules feel
— without the wall ever running a stranger's code.

1. **A catalogue.** A curated, community-extensible index of modules, rendered as
   a gallery on the Add-ons screen. Discovery layered on the module system RFC
   001 already shipped. First-party-authored and community-authored entries live
   in the same list.
2. **Recipe modules.** A module that is *pure declarative data* — "fetch this
   URL, pull these fields, draw this shape" — run by Maverick Wall's **own**
   first-party engine. No separate service to host. This is what removes the
   real friction today: that every module has to be its own running HTTP
   process, which nobody will stand up for a countdown or a tide clock.

Together they deliver the Bubble Card *experience* (pick from a list, install,
done) on top of Maverick Wall's *architecture* (data crosses the boundary, code
never does).

## The one thing we do not copy

A Bubble Card module ships a `code` section — CSS and JavaScript templates the
card executes on every render (`this.config.field`, `card.style.setProperty`).
That is the mechanism that makes it feel light: paste a blob, it runs.

**Maverick Wall refuses exactly that**, and this RFC changes nothing about it.
Rule three (no third-party origin in the display bundle) and the data-not-code
contract exist because a module dropped onto a kitchen wall runs unattended for
months with access to the display, the master key, and the SSRF guard. RFC 001
already named this the version to refuse:

> In-process plugins are the version to refuse — they would read the master key,
> bypass the guard, and take the wall down when they throw.

So the goal is to reproduce the *catalogue and one-click install*, and to make
modules *self-contained*, **without** adopting the code-execution model that
makes Bubble Card's modules self-contained. The recipe engine is how those two
are reconciled: a recipe is data, and a first-party interpreter — not the
module — turns it into a panel.

## Part A — The catalogue

### What it is

A catalogue is an **index**, not a package format. Each entry describes a module
and how to install it; the module itself is still either a service (RFC 001) or a
recipe (Part B). The index is a plain document Maverick Wall fetches, validates,
and renders as a gallery.

```jsonc
// catalog/index.json — the first-party, curated list (this repo)
{
  "version": 1,
  "modules": [
    {
      "id": "uk-bins",
      "name": "UK bin collections",
      "author": "clooos",
      "description": "Your council's next bin day, from the UK bin API.",
      "icon": "🗑️",
      "kind": "recipe",            // or "service"
      "recipe": { /* the recipe manifest, Part B — or a URL to it */ },
      "config": [ /* fields the household fills in on install */ ]
    },
    {
      "id": "some-container-module",
      "name": "Energy dashboard",
      "author": "someone",
      "kind": "service",
      "install": {
        "hint": "Run the container, then paste its address.",
        "addonRepository": "https://github.com/someone/mw-energy"  // optional
      }
    }
  ]
}
```

### How it is fetched — consent, not a surprise

Contacting the catalogue host (GitHub, by default) reveals that this house runs
Maverick Wall, exactly like the update check does. So it obeys the **same
consent rule already in the codebase**: off until asked, the page names the host
and says what the request reveals and what it does not, and the fetch happens
**server-side through the SSRF-guarded fetcher** — never from the display bundle,
never from the admin page's own origin. A household that never opens Add-ons
never contacts anyone.

### Catalogue sources — one, then many

Start with a single first-party catalogue baked into the image (or fetched from
this repo). Later, allow adding **catalogue sources by URL**, which is the
add-on-repository pattern this project already knows intimately — and knows the
traps of: a private repo that 404s to everyone, a manifest in the wrong
directory, "is not a valid app repository" with no reason given. Reuse that hard
memory rather than rediscover it.

### The gallery and install

`/admin/modules` gains a **Browse** view: a card per entry — glyph, name, author,
description — and an **Install** button. Install branches on `kind`:

- **recipe** → create the module row, then prompt for its `config` and any
  `secrets` (Part B). One screen, no shell, no container.
- **service** → either pre-fill the "add by URL" form, or link out to the add-on
  repository the entry names. Still a separate process the household runs.

### Rendering a stranger's catalogue safely

Every string in an entry was written by someone else, so it gets the same cap
and the same control/bidi strip as CAP and Home Assistant text. **Screenshots
are deferred on purpose**: a remote image is a third-party origin, and even on
the admin page (not the display bundle) it is a beacon and a mixed-content
hazard. v1 shows the module's glyph only; a later version can server-proxy
thumbnails through the fetcher and re-serve them from this origin, the way
`api/media.ts` already sniffs and re-serves uploads.

## Part B — Recipe modules

### The idea in one line

A recipe module produces **the same output as a service module** — validated
Panel Data and, optionally, signals — except the fetch-and-transform happens
**inside Maverick Wall's first-party engine** instead of inside a service the
author hosts. Same contract at the boundary, same renderer, same trust model.
The only new surface is *the fetch instruction* (already the SSRF guard's job)
and *the transform*, which must be data, not code.

This is why it is safe and why it is the right shape: it is not a new capability,
it is **RFC 001's data contract with the HTTP hop removed**.

### What a recipe looks like

```yaml
name: Fuel prices
contract: 1                       # recipe schema version
config:
  - { key: station, label: "Station id", type: string }
secrets:
  - { key: api_key, label: "API key" }     # stored encrypted, injected server-side
fetch:
  url: "https://api.example.com/fuel/{station}"
  header: { "X-Api-Key": "{secret:api_key}" }
  intervalSeconds: 3600
  # PUBLIC INTERNET ONLY by default. Reaching the LAN or loopback needs an
  # explicit per-recipe grant the household ticks, because a community recipe
  # has no business reaching 192.168.x.x uninvited.
panel:
  kind: tiles
  title: "Fuel"
  items:
    for: "prices[*]"              # an array selector, scoping each row below
    label: "{fuel_type | upper}"
    value: "{price_pence | currency:GBP}"
```

### The transform is a selector language, not a language

The whole safety of Part B rests on the transform being **non-executable**. It
is three constrained pieces, each a fixed first-party implementation:

- **Selectors** — dotted / indexed paths into the fetched JSON: `prices[0].amount`,
  `alert.headline`. Traversal only. No expressions, no arithmetic, no calls.
- **Formatters** — a *fixed allowlist* applied to a selected value:
  `upper`, `round:1`, `currency:GBP`, `date:relative`, `truncate:40`. Named,
  parameterised, first-party. Adding a formatter is a first-party code change,
  never something a recipe supplies.
- **Templates** — placeholder substitution into a string: `"{price} per litre"`.
  Substitution only — no conditionals, no loops, no embedded expressions.

That is a declarative data mapping, the kind an ETL tool ships. It is not
Turing-complete, it cannot do I/O beyond the one declared `fetch`, and it cannot
name anything outside `config`, `secrets`, and the fetched body. The output is
then validated against the **existing** `panelDataSchema` and `signalDataSchema`
— so a recipe that computes a nonsense panel fails the same boundary a
misbehaving service does, with the same visible `last_error`.

### Signals from a recipe — keep `when` tiny

A recipe may emit signals, and here is the one place a constrained *condition*
appears:

```yaml
signals:
  - when: "alert.active"          # selected path is truthy — that is all
    key: "{alert.id}"
    title: "{alert.headline}"
    severity: "{alert.level | severity}"
```

`when` is the sharp edge, the way the Panel Data vocabulary is the sharp edge in
RFC 001. Keep it to the minimum that is useful: *a selected path is truthy*,
*equals a literal*, or *compares to a config value*. Explicitly **not** an
expression language — the moment `when` grows `&&` and parentheses, a recipe is
code again. Everything downstream is unchanged: a recipe's signals are stamped
`source: ext:<id>` and do nothing until the household arms the module's Alerts
control, exactly as Phase 2b already enforces.

### Sourceless recipes

A countdown needs no fetch — only the clock and a date the household set. These
are a small **named-generator allowlist** (`countdown`, `days-until`,
`static-list`), each a first-party function chosen by name and parameterised by
`config`. This is deliberately *not* "run arbitrary computation": it is the same
select-a-first-party-behaviour idea as the formatter allowlist. The fetch
pipeline is the core of Part B; named generators are the small adjunct that
covers the trivial widgets.

### It reuses the existing table and adapter

A recipe module and a service module both write a cached `panel` and `signals`
that the display reads, so they share everything downstream. Widen
`external_modules` with `kind` (`service` | `recipe`), a `recipe` JSON column,
and a `config` / encrypted-`secrets` store. The `ExternalPanelModule` adapter is
**unchanged** — it reads cached `panel`/`signals`. Only the poll branches:

- `kind = service` → today's `pollOne` / `pollSignals` (HTTP GET `/panel`,
  `/signals`).
- `kind = recipe` → the recipe engine: fetch (if any) through the SSRF guard,
  transform, validate, cache to the same columns.

So Part B is one new poll branch and one engine — not a second module system.

## Trust and curation

The strongest point, and the same one RFC 001 makes: **the boundary makes it
safe, not the vetting.** A recipe installed from the catalogue can do nothing a
household could not do by typing the same recipe by hand — the catalogue grants
no elevated trust. Every recipe, vetted or not, is bounded by:

- the **SSRF-guarded** fetch, **public-internet-only by default**;
- **no third-party code** — a selector/formatter/template mapping, interpreted
  first-party;
- **sanitised, `textContent`-only** output, validated against the existing
  schemas;
- **secrets** the household supplies, stored encrypted, injected server-side,
  never in the manifest and never on the wall;
- signals that are **inert until the household arms them** (Phase 2b).

So curation is about *quality and honesty* — does this module do what it says, is
the author who they claim — not about *containing damage*. That lets the
first-party catalogue be reviewed by PR (like the add-on repository) and lets
third-party catalogue sources be "you trust whoever runs this list," without
either being load-bearing for safety.

## Phases

- **Phase A1 — the catalogue, service modules only.** `catalog/index.json` in
  this repo, a consent-gated server-side fetch (reuse the update-check consent
  shape), and a Browse gallery on `/admin/modules` that pre-fills the add-by-URL
  form. Small, immediately useful, no architectural change. Proves the
  browse/pick/install UX.
- **Phase B1 — the recipe engine, fetch pipeline.** The recipe schema, the
  selector/formatter/template interpreter, the `kind = recipe` poll branch, the
  `config`/`secrets` store, and public-internet-only fetch defaults. One recipe
  end to end (a real public JSON API) as the proof.
- **Phase B2 — recipe signals and sourceless generators.** The tiny `when`
  predicate and the named-generator allowlist (countdown first).
- **Phase A2 — catalogue polish.** Recipe install directly from the gallery
  (config + secrets prompt), then catalogue *sources* by URL, then
  server-proxied screenshots.

## Decisions taken

1. **No wall-executed code, still.** This RFC is discovery + a declarative
   engine. It does not reopen rule three. A recipe is data; a first-party
   interpreter runs it.
2. **Reuse, don't fork.** Recipes share `external_modules`, the adapter, the
   block system, the Panel/Signal schemas, and Phase 2b's arming. One new poll
   branch, not a parallel system.
3. **Public internet by default.** A community recipe's fetch may not reach the
   LAN or loopback without an explicit household grant — stricter than the
   default a household's own calendar add gets, because the author is a stranger.
4. **Consent to browse.** Fetching the catalogue is contacting a third party;
   it is off until asked and obeys the update-check consent rule.
5. **The boundary carries the safety, not the review.** So the catalogue can be
   permissive and community-driven; vetting is for quality, not containment.

## Non-goals

- No `code` section, no JS/CSS templates, no `eval`, no expression language.
  `when` and the formatters are fixed and first-party.
- Not a general HTTP client — the transform cannot do I/O beyond the one declared
  `fetch`, and that fetch is SSRF-guarded and public-by-default.
- Not a dashboard builder. The vocabulary stays the small Panel Data set; a
  recipe chooses a shape, it does not invent one.
- No auto-update of installed recipes from the catalogue without the household
  seeing it — a changed recipe is a changed fetch target and changed output, and
  that is theirs to accept.

## Open questions

- **Where the catalogue lives.** This repo's `catalog/` (versioned with the
  code, reviewed by PR) versus a separate community repo (moves faster, needs its
  own trust story). Leaning: first-party in-repo to start, sources-by-URL later.
- **Recipe embedded vs referenced.** Inline the recipe in the catalogue entry
  (one fetch, one review) or reference a recipe URL (author owns updates, but now
  two trust surfaces and a second SSRF fetch). Leaning: inline for the curated
  catalogue.
- **How much `when` is enough** before it becomes an expression language — the
  same "keep the sharp edge blunt" judgement RFC 001 makes about the panel
  vocabulary.
- **Politeness across recipes.** The engine makes the requests now, so twenty
  recipes polling one API is Maverick Wall's manners to enforce, not the author's.
  A per-host floor, or just a per-recipe interval floor?

# Building a Maverick Wall module

A module puts an extra panel on the wall — a bin-day countdown, fuel prices, a
train time, whatever you like. There are two kinds, and **most of the time you
want a recipe**:

- A **recipe** is declarative data — it names a public web feed and how to draw
  it, and Maverick Wall does the fetching. No service to host. See
  [Recipes](#recipes--a-module-with-no-server) below, and
  [`adding-to-the-store.md`](./adding-to-the-store.md) to share one in the store.
- A **service module** is its own small HTTP service you run on your own
  network, for the rare thing a recipe cannot do. This document covers that
  contract first; there is a runnable example in
  [`examples/example-module`](../examples/example-module).

Either way, Maverick Wall reads what the module supplies and draws it, and
**never runs anything it sends**.

## The service contract

Your service answers two `GET` requests. That is the whole of it.

### `GET /maverick.json`

Who you are. Maverick Wall reads `name`; the rest is documentation and room to
grow.

```json
{
  "name": "Bin day",
  "version": "1.0.0",
  "contract": 1,
  "block": { "key": "bins", "label": "Bin day" },
  "intervalSeconds": 900
}
```

- `name` — shown to the household in the Store, under **Installed**.
- `contract` — the Panel Data version you speak. Today that is `1`.
- `intervalSeconds` — how often you'd like to be polled. Maverick Wall clamps it
  to a sane range; treat it as a hint.

### `GET /panel`

What to show, as **Panel Data**. Return one of the shapes below; `readings`
is the one to reach for.

## Panel Data — the shapes

Small on purpose. This is the safety boundary and what keeps your panel looking
like the wall rather than a random dashboard. Every string is length-capped and
stripped of control characters, and the wall draws it as **text only** — so
markup, a URL, or a script in a value simply becomes those characters.

### `readings` — rows of label / value (/ glyph)

```json
{
  "kind": "readings",
  "title": "Bins",
  "items": [
    { "label": "Recycling", "value": "Tomorrow", "glyph": "problem" },
    { "label": "General",   "value": "Mon 25th" }
  ]
}
```

A row's `glyph` is optional and is a **key** from the wall's own drawn set,
never a character: `clear`, `mostly-clear`, `partly-cloudy`, `cloudy`, `fog`,
`drizzle`, `rain`, `showers`, `snow`, `sleet`, `thunderstorm`, `wind`,
`temperature`, `humidity`, `pressure`, `battery`, `power`, `illuminance`,
`door`, `garage`, `window`, `motion`, `occupancy`, `moisture`, `smoke`, `gas`,
`problem`, `lock`, `person`, `light`, `switch`, `fan`, `cover`, `thermostat`.
A key the wall does not know is dropped and the row is drawn without one. The
wall draws the picture in the theme's ink, and an e-paper panel draws it in one
bit, so it looks like the rest of the wall on both.

An emoji is not a glyph. The image ships no emoji font, so an emoji set as text
is drawn by whatever font the tablet happens to have — a different picture on
every screen, an empty box on some, and nothing at all on e-paper. The old
`icon` field carried exactly that; it is still **accepted, so an older module's
panel is not refused, and then dropped**.

#### A row's `tone`

A row may also say what it is doing, with `tone`: `active` for something that
is on or running, `alert` for something that wants somebody, and `idle` for
something that is neither.

```json
{
  "kind": "readings",
  "title": "Garden",
  "items": [
    { "label": "Sprinkler", "value": "Running", "glyph": "switch", "tone": "active" },
    { "label": "Shed door", "value": "Open", "glyph": "door", "tone": "alert" },
    { "label": "Soil", "value": "Damp", "glyph": "moisture", "tone": "idle" }
  ]
}
```

The wall draws a row with a tone the way it draws a Home Assistant tile's mark:
the row's `glyph` knocked out of a circle in the tone's colour, or the circle
alone if the row names no glyph. The colours are the theme's own, measured
against its grounds, which is why a module names a tone and never a colour. A
row with no `tone` is drawn exactly as before. An e-paper panel has no colour,
so it puts `! ` in front of an `alert` row and draws `active` and `idle` rows
as plain lines. Any other word is a rejected panel.

#### A row's `progress`

A row may say how far along something is, with `progress`: a number from 0 to
100.

```json
{
  "kind": "readings",
  "title": "Downloads",
  "items": [
    { "label": "Holiday photos", "value": "45%", "progress": 45, "tone": "active" },
    { "label": "Backup", "value": "Done", "progress": 100 }
  ]
}
```

The wall draws a thin bar along the bottom of the row, in the row's tone if it
has one and the theme's accent if not. The bar sits in the row's own padding, so
a row with a bar is no taller than one without. `value` is still what the row
says, so write the number there too if it should be read. An e-paper panel draws
the row's line and not the bar. A number below 0 or above 100 is a rejected
panel, never a bar drawn past its end.

#### A row's `series`

A row may carry a short run of numbers, oldest first, with `series`: from 2 to
48 of them, and `null` for a gap.

```json
{
  "kind": "readings",
  "title": "Greenhouse",
  "items": [
    { "label": "Temperature", "value": "21°", "series": [18, 18.5, 19, null, 20, 21] },
    { "label": "Humidity", "value": "64%" }
  ]
}
```

The wall draws it as a sparkline in a slot at the end of the row. Once any row
has one, every row gets the slot, so the values still line up. The line breaks
at a gap. An e-paper panel draws the same line in one bit. A number that is not
finite, or a run shorter than 2 or longer than 48, is a rejected panel.

### `gauge` — one reading as a ring

```json
{ "kind": "gauge", "title": "Water butt", "label": "Full", "value": "72%", "progress": 72, "tone": "idle" }
```

A ring filled to `progress`, with `value` in the middle and `label` under it.
`value` is your own words for it ("72%", "3 of 8"), because only the module
knows what the number is of. `tone` is optional and colours the ring as it does
a row's circle; without one the ring is the theme's accent. It is the one large
reading a module may draw, so its words are never bigger than a clock's may be,
and get smaller to stay inside a small ring. An e-paper panel draws the label and
value as one line with a bar under it.

### `table` — a few rows of a few columns

```json
{
  "kind": "table",
  "title": "Trains",
  "columns": ["To", "Due", "Platform"],
  "rows": [
    ["London Bridge", "08:12", "2"],
    ["Brighton", "08:20", "1"]
  ]
}
```

One to four `columns` and up to twelve `rows`, each row exactly one cell per
column. The first column gets twice the room of each of the others, and the
others line up on their right edge. A box too short for every row draws the rows
it has room for, never half of one. A long cell wraps at a word on the wall, and
is cut to its column on an e-paper panel.

### `qr` — a code a phone can read

```json
{ "kind": "qr", "title": "Guest Wi-Fi", "text": "WIFI:T:WPA;S:Guest;P:correct-horse;;", "label": "Guest" }
```

`text` is what the code carries: a link, a Wi-Fi code, a contact card. It is
kept exactly as sent, line breaks and all, because it is never drawn as words.
One code holds at most 213 bytes, and a longer `text` is a rejected panel. The
wall draws the code with the QR code widget's own encoder, black on white on
every theme, with `label` under it, and an e-paper panel draws the same code.

### `countdown` — how long until something

```json
{ "kind": "countdown", "title": "Launch", "label": "Falcon 9", "at": "2026-10-20T14:00:00Z" }
```

`at` is an ISO 8601 date and time **with its offset**, or `Z`. A time without
one is rejected, because the wall would have to guess its zone. Say when, never
how long: the wall works out what is left from its own clock on every draw, so it
goes on counting while your service is down. It says "In 2 min", "In 4 h 20 min"
or "In 3 days", then "Now", then how long ago. The words are the panel's one
large reading, capped as a gauge's are. An e-paper panel shows one picture for up
to an hour, so it says the date and time instead.

### `timeline` — a few things at their times

```json
{
  "kind": "timeline",
  "title": "Today",
  "items": [
    { "at": "2026-10-14T08:30:00+01:00", "label": "School run" },
    { "at": "2026-10-14T14:00:00+01:00", "label": "Dentist", "detail": "Dr Smith", "tone": "alert" },
    { "at": "2026-10-15T07:00:00+01:00", "label": "Bins" }
  ]
}
```

Up to twelve `items`, **in order of time**. A timeline out of order is rejected
rather than sorted, so which item is next is never a guess. Each `at` is an
instant with its offset, as a countdown's is. The wall draws the time in the
household's zone and clock, alone on today and with the weekday before it
otherwise. What has passed is drawn quieter and the next item bolder, by the
wall's own clock, so the schedule moves on without a new panel. `tone` adds the
readings' coloured dot. An e-paper panel lists only what is still to come.

### `image` — a picture

```json
{ "kind": "image", "title": "Radar", "url": "https://example.com/radar.png?t=1415", "caption": "Rain at 14:00" }
```

The wall never sees `url`. Maverick Wall fetches the picture itself, through the
same guard as everything else and under your module's own rules: a service
module may reach your network, and a recipe only the public internet unless it
says `allowLan`. It checks the bytes are a PNG, JPEG, GIF or WebP (never an SVG),
keeps a copy, and hands the wall a handle in place of the address. A URL with a
name or password in it is rejected. **A picture at an address is fetched once**:
when it changes, give it a new address (a query string will do), the way a
content-hashed file is named. The wall draws it whole in its box, never cropped,
with `caption` under it. An e-paper panel draws no photographs, so it shows only
the caption.

### `stat` and `tiles` — accepted, drawn as rows

```json
{ "kind": "stat", "title": "Christmas", "value": "135", "caption": "days" }
```

```json
{
  "kind": "tiles",
  "title": "Fuel",
  "items": [
    { "label": "Petrol", "value": "£1.47" },
    { "label": "Diesel", "value": "£1.55" }
  ]
}
```

Both are still valid, and both are drawn exactly like `readings`: a `stat` is
one row with its `caption` as the label, and `tiles` is a list of rows. There is
no big number and no strip of tiles. The wall used to draw them that way, and
took them out because a widget the household placed must not outsize the wall
around it — the one large reading a wall may carry is a designed style's, capped
against the event text. If you are writing a module now, send `readings`.

### `text` — a line or two

```json
{ "kind": "text", "text": "Bins out tonight — recycling and food." }
```

### Limits

| Field | Limit |
|---|---|
| `title`, `label`, `value`, `caption` | 60 characters |
| `glyph` | a key from the list above; anything else is dropped |
| `tone` | `active`, `alert` or `idle`; anything else is rejected |
| `progress` | a number from 0 to 100; anything else is rejected |
| `series` | 2–48 finite numbers or `null` |
| `columns` | 1–4, 24 characters each |
| `rows` (table) | 1–12, one cell per column, 40 characters each |
| `text` | 280 characters; a `qr` code's, 213 bytes |
| `at` | an ISO 8601 date and time with its offset or `Z` |
| `items` (timeline) | 1–12, in order of time |
| `url` (image) | http or https, 2,000 characters, no name or password |
| `caption` (image) | 120 characters |
| `items` | 1–12 rows |

A body that does not fit — an unknown `kind`, a missing field, an extra key, an
oversized list — is **rejected**, not patched. The wall keeps the last good panel
and its card in the Store shows why the last poll failed. So make `/panel` valid, or
return the same shape with placeholder values while your data loads.

## Adding it to the wall

In the admin, open **Store** → **Advanced** → **Add a module by URL**, and
paste your service's address (e.g. `http://192.168.1.20:9000`). Maverick Wall must be able to reach it: run it on
the same network and give the machine's LAN address, not `localhost`, unless both
run on the same host. Plain `http` on the LAN is fine.

Its card in the Store shows whether the module is answering, and lets you turn
it off or remove it. Nothing appears on a wall until somebody puts it there:
open the wall's layout, press **Add widget**, choose **Module**, pick your module
in the widget's settings, and drag the box where it belongs. The Store card says
which walls draw it.

## `GET /signals` — raising an alert (optional)

A panel sits in its row. A **signal** can do more: match one of the wall's alert
rules and raise a **banner** across the bottom, or **take the whole wall over**.
That is the one place a module reaches past its own block, so it is fenced on
every side — and it is entirely opt-in.

Serve `/signals` returning `{ "signals": [ … ] }`, each entry:

```json
{ "signals": [
  { "key": "bins", "title": "Bins out tonight", "severity": "Moderate", "startsInSec": 3600 }
] }
```

| Field | Meaning |
|---|---|
| `key` | Stable id for the thing. The household dismisses *this*, so don't change it every poll. |
| `title` | What the wall says, at its largest. Capped at 80 chars, sanitised. |
| `severity` | Optional. `Minor` \| `Moderate` \| `Severe` \| `Extreme`. Omit if you don't know. |
| `startsInSec` | Optional. Seconds until the thing begins, for a "starting soon" rule. |

Return `{ "signals": [] }` when nothing is true — the ordinary case. At most 12
signals; an unknown key or a `severity` outside that list is **rejected**, like a
panel. Don't serve `/signals` at all (return `404`) and your module is
panel-only.

**A signal does nothing on its own.** Two things have to be true first, and
neither is yours to set:

1. The household turns your module's **Alerts** control on (its Store card). It
   is **off by default**, and they choose **banner** or **take over the wall** —
   never "wake a dark screen", which stays with genuine safety alerts.
2. A rule scoped to your module matches. Maverick Wall keeps exactly one, tied
   to that control, and it can **only ever match your module** — your signals can
   never trip the weather rules, and another module's rules can never see yours.

So the household is always in charge of whether you can interrupt them, and how
loudly. You decide *what* is worth an alert (only emit those); they decide
whether it lands and how. Whatever you raise, they can always clear it from the
wall.

## The rules (and why)

- **Data, never code.** You return values; a first-party renderer draws them.
  There is no way to ship HTML, a font, an image, a script, or a URL the wall
  fetches. This is what lets a household trust a module they did not write.
- **You never receive their data.** Maverick Wall only ever calls your `GET`
  endpoints. It does not send your calendars, their Home Assistant token, or
  anything about the household. Your own upstream credentials (an API key) live
  in your service, not in Maverick Wall.
- **You are polled, not trusted with the wall.** A slow or failing module backs
  off on its own and never stalls the calendar; a malformed answer is dropped.

## Recipes — a module with no server

If your module is really just "fetch a public JSON feed and show a couple of
fields", you do not need to run a service at all. A **recipe** is a small
declarative document that Maverick Wall runs itself: it names a URL, selects
values out of the response, and draws them. Paste one in **Store** →
**Advanced** → **Build a recipe**, or install one from the Store.

A recipe is *data, never code*. It can pull fields and format them, and nothing
else — no expressions, no branching, no I/O beyond its one fetch. That is what
lets Maverick Wall run it in-process safely.

```json
{
  "name": "Bitcoin",
  "contract": 1,
  "fetch": {
    "url": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=gbp",
    "intervalSeconds": 900
  },
  "panel": { "kind": "text", "title": "Bitcoin", "text": "{bitcoin.gbp | currency:GBP}" }
}
```

- **`panel`** is the same shapes as above, except each string is a
  *template*: plain text plus `{selector}` or `{selector | formatter}`
  placeholders. For `readings`, give `items` a `for` (a selector that points at
  an array) and `label`/`value` templates evaluated against each row. A recipe's
  rows carry no `glyph`; `stat` and `tiles` are accepted and drawn as rows, as
  above. A recipe can build a `qr`, a `countdown` or an `image` from templates,
  and a `timeline` from a `for` with `at`, `label` and an optional `detail`;
  a timeline's items are put in order of time for you.
- **Selectors** are dotted / indexed paths into the fetched JSON:
  `bitcoin.gbp`, `results.items[0].name`. Traversal only.
- **Formatters** are a fixed set: `upper`, `lower`, `trim`, `round:N`, `int`,
  `currency:GBP` (also USD/EUR/JPY), `truncate:N`, `date:relative`,
  `date:short`, `default:TEXT`. A formatter this list does not have is a
  rejected recipe, not a broken panel.
- **`config`** (optional) declares fields a household fills in; reference them in
  the URL as `{key}`:
  ```json
  "config": [{ "key": "station", "label": "Station id" }],
  "fetch": { "url": "https://api.example.com/fuel/{station}" }
  ```
  A field may name a `type`, which decides the control the household gets and
  what it will take. With no `type` it is text, as it always was.
  ```json
  "config": [
    { "key": "city", "label": "City", "type": "select",
      "options": [{ "value": "london", "label": "London" }, { "value": "york", "label": "York" }],
      "default": "london" },
    { "key": "days", "label": "Days", "type": "number", "min": 1, "max": 7, "default": "3" },
    { "key": "metric", "label": "Metric units", "type": "boolean", "default": "true" },
    { "key": "outside", "label": "Outside temperature", "type": "ha_reading" }
  ]
  ```
  Every value is a string, and is what `{key}` puts in the URL: a number as
  typed, a switch as `true` or `false`, a choice as its `value`. A value that is
  not its field's shape is refused, never coerced; a recipe whose own default
  is not its field's shape is a rejected recipe. An `ha_reading` field offers
  the readings the household watches, and what reaches your URL is that
  reading's **current value**, never its Home Assistant id. It has no default.

  **Each Module widget can set these for itself.** One install serves every
  widget; a widget that changes a setting is read with it, and one that leaves
  it alone follows the install. Widgets whose settings come to the same request
  (the same address and headers) share one fetch, so a setting your URL does
  not use costs nothing. Signals are raised from the install's own settings
  only.
- **`fetch`** reaches the **public internet over https only**. To point a recipe
  at a service on your own network, add `"allowLan": true` — then it may reach
  the LAN, loopback and plain http.

### A recipe can raise an alert

A recipe may also declare `signals` — the same alerts an add-on module can raise
(a banner, or a takeover), read out of the feed it already fetches:

```json
"signals": [
  { "when": "flood.active", "key": "{flood.id}", "title": "Flood warning: {flood.river}", "severity": "Severe" }
]
```

- **`when`** decides whether the signal is showing. It is deliberately tiny —
  either a selector path (fires when the value there is truthy) or
  `{ "path": "…", "equals": "…" }` (fires on an exact match). Nothing more; it is
  not an expression.
- **`key`** and **`title`** are templates, like a panel's. **`severity`** is one
  of `Minor` / `Moderate` / `Severe` / `Extreme`, optional.

As with any module, a signal does **nothing** until the household turns your
module's **Alerts** control on (its Store card, off by default), and even then a
recipe can only raise a banner or cover the wall — never wake a dark screen. Its
alert clears on its own when `when` stops holding.

### A feed behind an API key

If the feed needs a credential, declare a `secret` and put it in a **header** —
never in the address:

```json
"secrets": [{ "key": "api_key", "label": "API key" }],
"fetch": {
  "url": "https://api.example.com/price?symbol={symbol}",
  "headers": { "Authorization": "Bearer {secret:api_key}" }
}
```

The household types the value into a password field when they install the
recipe. It is stored **encrypted**, injected into the request header at fetch
time, and never appears in the manifest, on the wall, or in a log. A secret may
**not** go in the URL (a URL is stored and logged).

## Sharing a module

There is one store, and it is in this repository: one file per module under
`apps/server/src/catalog/`, shipped to every household with the next release
and working on a wall with no internet. To share a recipe, or a pointer to a
service others can run, open a pull request there —
[`adding-to-the-store.md`](./adding-to-the-store.md) has the steps. There is no
way to add somebody else's list of modules by URL; that was removed so a
household is only ever offered what was reviewed here.

## Versioning

Bump `contract` only if the shapes here change in a way an old wall could not
draw. Adding a new optional field is not a version bump; changing what a field
means is.

## Rationale

The design and its trade-offs are written up in
[`docs/rfc-001-module-framework.md`](./rfc-001-module-framework.md).

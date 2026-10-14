# Building a Maverick Wall module

A module puts an extra panel on the wall — a bin-day countdown, fuel prices, a
train time, whatever you like. There are two kinds, and **most of the time you
want a recipe**:

- A **recipe** is declarative data — it names a public web feed and how to draw
  it, and Maverick Wall does the fetching. No service to host. See
  [Recipes](#recipes--a-module-with-no-server) below, and
  [`adding-to-the-store.md`](./adding-to-the-store.md) to share one in the store.
- A **script** is one file of JavaScript that Maverick Wall runs on its own
  server, in a sandbox, for what a recipe cannot work out: arithmetic,
  conditions, sorting, merging two answers. It returns the same data a recipe
  builds. See [Scripts](#scripts--code-that-runs-in-a-sandbox) below.
- A **service module** is its own small HTTP service you run on your own
  network, for the rare thing a recipe cannot do. This document covers that
  contract first; there is a runnable example in
  [`examples/example-module`](../examples/example-module).

Whichever kind, the wall only ever draws data: a script runs on the server and
never on a wall, and Maverick Wall **never runs anything a service or a feed
sends**.

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
  `bitcoin.gbp`, `results.items[0].name`. Traversal only. A feed whose
  answer is a list at the top is reached with `.` for the whole list (as a
  `for`, say) and `[0].name` for one row of it.
- **Formatters** are a fixed set: `upper`, `lower`, `trim`, `round:N`, `int`,
  `currency:GBP` (also USD/EUR/JPY), `truncate:N`, `date:relative`,
  `date:short`, `default:TEXT`, `number:N`, `duration:UNIT`, `time`, `iso`,
  `plural:WORD` and `map:TABLE` (see below). A formatter this list does not
  have is a rejected recipe, not a broken panel.
- **Times** can be what a feed writes: an ISO time with its zone, seconds or
  milliseconds since 1970, or a date and time with **no** zone, such as
  `2026-10-14 02:56`, which is read as **UTC**, the same on every server.
  `date` and `time` speak the household's own zone; `date:relative` counts
  calendar days there, so 23:00 tonight is "today". A bare date such as
  `2026-12-25` is a day on the calendar and is never moved into a zone.
  `iso` writes any of these as the instant a timeline's or a countdown's `at`
  must be: `{t | iso}`.
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

### Choosing rows, and reading more than one feed

A list's `items` can say which rows of the array to draw, in what order, and how
many:

```json
{
  "name": "Departures",
  "contract": 1,
  "fetch": { "url": "https://api.example.com/departures/LEW" },
  "panel": {
    "kind": "readings",
    "title": "Next trains",
    "items": {
      "for": "services",
      "label": "{destination}",
      "value": "{expected}",
      "where": ["live", { "path": "cancelled", "notEquals": true }],
      "sort": { "by": "expected", "as": "time" },
      "limit": 4,
      "empty": "No more trains today"
    }
  }
}
```

- **`where`** is up to four conditions, and a row is drawn only when **all** of
  them hold. A condition is a selector, which holds when the value there is
  set, or `{ "path", "equals" }`, `{ "path", "notEquals" }`, `{ "path",
  "above" }` or `{ "path", "below" }`. `equals` compares as text, so `3` and
  `"3"` are equal. `above` and `below` compare as numbers, and a row with no
  number there fails them. There is no "or", no arithmetic and nothing nested;
  a path like `late > 3` is a rejected recipe, refused at parse.
- **`sort`** is `{ "by", "order", "as" }`. `order` is `asc` (the default) or
  `desc`. `as` is `number`, `text` or `time`; left out, it is `number` when
  every value is one and `text` otherwise. Rows with no value for the key go
  last whichever way it runs, and rows it cannot tell apart keep the feed's
  order.
- **`limit`** is how many rows to keep, from 1 to 12, taken after the order.
- **`empty`** is what to say when the array is empty or the conditions leave no
  rows, drawn as a line of text. It defaults to "Nothing to show.": no rows is
  an answer, and the wall says it rather than going on drawing the last rows it
  had. A `for` that finds no array at all is different: the feed has changed
  shape, so the read fails and the wall keeps its last good panel.

A `timeline` takes `where`, `limit` and `empty`, but no `sort`: it is always in
time order, so its `limit` is "the next so many".

A recipe can read up to three more feeds, named under `sources`, and reach each
one as `@name`:

```json
{
  "name": "Line status",
  "contract": 1,
  "config": [{ "key": "line", "label": "Line", "default": "southern" }],
  "fetch": { "url": "https://api.example.com/departures/LEW" },
  "sources": { "status": { "url": "https://status.example.com/lines/{line}" } },
  "panel": {
    "kind": "readings",
    "title": "{@status.summary}",
    "items": { "for": "services", "label": "{destination}", "value": "{expected}" }
  }
}
```

A source has its own `url` and `headers`, with the same placeholders and the
same rules as `fetch`: settings in the address, secrets only in a header. It
shares the recipe's interval and its `allowLan`, so one recipe asks for the
network once and is read as one thing. `@name.path` works anywhere a selector
does: in a template, in a `for`, in a condition and in a signal's `when`.
`@name` alone is the whole answer. A recipe that reaches for a source it does
not declare is rejected. When any of its feeds does not answer, the whole read
fails with that source's name in the error, and the wall keeps its last good
panel. The install page names every host the recipe asks.

### Words and colours from what the feed says

Four formatters write numbers and times the way the wall does:

- **`number:N`** groups thousands to `N` places: `12345.6` is `12,345.60` with
  `number:2`. `N` is 0 to 6, and 0 when left out.
- **`duration:UNIT`** says a length of time in the wall's own words: "45 s",
  "12 min", "1 h 20 min", "3 days". `UNIT` is what the feed counts in: `ms`,
  `s` (the default), `min` or `h`. A length has no direction, so a negative one
  is said as its size; "ago" or "left" is yours to write.
- **`time`** is the clock time of an instant in the **household's own zone**,
  so a feed that speaks UTC reads like the kitchen clock: `14:05`, or `2:05 pm`
  with `time:12`.
- **`plural:WORD`** writes a count with its noun: "1 train", "3 trains".
  `plural:child,children` is for a noun that does not take an s. One is
  singular and every other count plural, nought included.

A recipe may declare up to eight **lookup tables** under `lookups`, and
`map:TABLE` turns a value into that table's words. A list's rows can take a
**`tone`** the same way, so a row is coloured by what the thing is doing:

```json
{
  "name": "Plant room",
  "contract": 1,
  "fetch": { "url": "https://plant.example.com/status" },
  "lookups": { "status": { "on": "Running", "off": "Stopped", "*": "Needs a look" } },
  "panel": {
    "kind": "readings",
    "items": {
      "for": "machines",
      "label": "{name}",
      "value": "{state | map:status} since {since | time}",
      "tone": { "from": "state", "map": { "on": "active", "fault": "alert" }, "default": "idle" }
    }
  }
}
```

- A table holds 1 to 50 entries, each a value's words. Words, not templates: a
  table cannot reach into the feed. `*` is the entry for a value the table does
  not name; with no `*`, such a value is said as itself. A `map:` naming a
  table the recipe does not declare is a rejected recipe.
- A row's `tone` looks the value at `from` up in `map`, whose words can only be
  `active`, `alert` or `idle`. `default` is the tone of a value the map does
  not name; with no `default`, that row has no tone and is drawn plain. A
  timeline's items take a `tone` too. See [A row's `tone`](#a-rows-tone) for
  what each looks like.

A lookup is a table and never a comparison, for the reason a condition is one:
`on → active` cannot grow into code.

### A news feed, any XML, and your house

A recipe's address does not have to answer JSON. `format` on `fetch` or on a
source says what it answers:

- **`json`**, the default.
- **`feed`**: an RSS or Atom news feed, in any of the three ways feeds are
  written. It reads as `{ "title": …, "items": [{ "title", "link",
  "published", "id" }] }`, newest as the feed lists them, with `published` an
  instant that `date`, `time` and a `time` sort all read. A feed with nothing in
  it is an empty list, so the recipe's `empty` words say so.
- **`xml`**: any XML document, read as a tree. Each element is reached by its
  name, the root included, so `<rss>` is `rss`. An element with no attributes
  and no children is its text. Any other element has its attributes under
  `_attr`, its own text under `_text`, and its children under their names; one
  child is the child, and several are a list. A name keeps letters, digits and
  `_`, so `xml:lang` is `xml_lang`. Where a list is asked for and one element
  is found, the element is a list of one.

Both are read by the same narrow reader the News screen uses: no DTD, no entity
beyond the five XML built-ins, and nesting capped. A headline can be longer than
a row's 60 characters, so cut it with `truncate:60`.

A source can also be **your house**: `{ "ha": ["inside", "outside"] }` names
the recipe's own `ha_reading` settings, never an entity, because which reading
is the household's choice. It reads as a list in that order, each row the
setting's `key` and what Home Assistant last said about the reading the
household picked: its `name` (as you call it on the Readings screen), its
`state`, its `unit` and when it last `changed`. It asks nobody: it is what the
last Home Assistant poll stored, read each time the recipe runs, and only for a
reading you watch. A setting left empty, or naming a reading you no longer
watch, is a row with its `key` and nothing else. No entity id is ever in it.

```json
{
  "name": "Morning",
  "contract": 1,
  "config": [{ "key": "room", "label": "Room", "type": "ha_reading" }],
  "fetch": { "url": "https://feeds.bbci.co.uk/news/rss.xml", "format": "feed" },
  "sources": {
    "bins": { "url": "https://council.example.com/bins.xml", "format": "xml" },
    "house": { "ha": ["room"] }
  },
  "panel": {
    "kind": "readings",
    "title": "{@bins.council.next.kind} on {@bins.council.next._attr.date | date:short} · {@house[0].state}{@house[0].unit}",
    "items": { "for": "items", "label": "{title | truncate:60}", "value": "{published | time}", "limit": 4 }
  }
}
```

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

### Trying a recipe before it is on a wall

**On the recipe page.** Modules › Advanced › Build a recipe has a *Try it
first* section. Paste what the recipe's address answers (open the address in a
browser and copy the page), and, if the recipe has named sources, a JSON object
of what each answered: a feed or an XML document as its text, JSON as itself, a
house source as the list of readings it would read. **Preview** runs the recipe
on those answers. Nothing is installed and nothing asks the address. The page
draws the panel through the wall's own renderer, in the house's theme, in a
third of a landscape wall and in a strip across a portrait one, so you see the
rows a narrow box gives up. A recipe the wall cannot draw says at which step it
stopped, and where in the built panel the schema refused it:

```
panel.items.3.label: Too big: expected string to have <=60 characters
```

**From a shell**, on a box that has this repository built:

```bash
node apps/server/dist/tools/new-recipe.js my-recipe     # a working starter
node apps/server/dist/tools/test-recipe.js my-recipe    # PASS, or what moved
node apps/server/dist/tools/test-recipe.js my-recipe --update   # record it
```

A fixture is a directory:

| File | What it is |
|---|---|
| `recipe.json` | The recipe, exactly as you would paste it. |
| `answer.json`, `answer.xml` or `answer.txt` | What the main fetch answered. Exactly one. |
| `sources/<name>.json` (or `.xml`, `.txt`) | What a named source answered. A house source's is the JSON list of readings. |
| `fixture.json` | Optional: `{ "at": "2026-10-14T08:00:00Z", "timezone": "Europe/London" }`. Pin the clock, or a `time` or a countdown reads differently tomorrow. |
| `expected.json` | What the recipe should build: `{ "panel": …, "signals": […] }`. |

`test-recipe` exits 0 when every fixture passes, 1 when one does not, and 2
when it is asked wrongly, so it can run in CI. A failure lists the places the
result differs, such as `panel.items.1.value: expected "Monday", got "Tuesday"`.

**For a module already installed**, `diagnose-module [module-id]` reads it now,
the way the poll does, and says which request answered, which did not, and
what the panel built or why it could not. It names addresses by their host
only, never prints a secret or a setting's value, and writes nothing back, so
the module's card still says what the last poll found.

## Scripts — code that runs in a sandbox

A recipe is deliberately not a language. When the job needs one — which of
three bins goes out next, how long until high tide, a train list merged with
its disruptions — write a **script**: one file of JavaScript with a default
function. Maverick Wall runs it on its own server inside QuickJS, a JavaScript
interpreter compiled to WebAssembly, in a thread of its own, and draws what it
returns exactly as it draws a recipe's panel. The wall never runs it.

Its manifest is a recipe's settings and secrets, with the hosts it may reach in
place of a `fetch`:

```json
{
  "name": "Next bin",
  "contract": 1,
  "hosts": ["bins.example-council.gov.uk"],
  "config": [{ "key": "street", "label": "Street", "type": "string" }],
  "secrets": [{ "key": "api_key", "label": "API key", "host": "bins.example-council.gov.uk" }],
  "intervalSeconds": 3600
}
```

And the script:

```js
// The council answers { "bins": [{ "kind": "Recycling", "date": "2026-10-16" }, …] }.
export default async function run(ctx) {
  const res = await ctx.fetch(
    'https://bins.example-council.gov.uk/v1/collections?street=' + encodeURIComponent(ctx.config.street),
    { headers: { 'X-Api-Key': '{secret:api_key}' } },
  );
  if (!res.ok) throw new Error('The council said ' + res.status);
  const bins = (await res.json()).bins.slice().sort((a, b) => a.date.localeCompare(b.date));
  const next = bins[0];
  return {
    panel: { kind: 'countdown', title: 'Next bin', label: next.kind, at: next.date + 'T07:00:00Z' },
    signals: [],
  };
}
```

**What it is given.** `ctx` is frozen, and holds:

| | |
|---|---|
| `ctx.config` | The settings, as strings, each checked against its field. A Home Assistant reading setting is the reading's value, never its entity id. |
| `ctx.now` | The server's clock, in milliseconds. |
| `ctx.timeZone` | The household's zone, such as `Europe/London`. |
| `ctx.local(instant)` | That instant on the household's clock: `{ year, month, day, hour, minute, second, weekday }`, with Sunday as 0. QuickJS has no `Intl`, so this is how a script knows what day it is at home. |
| `ctx.fetch(url, options)` | A GET. `options.headers` may name a secret as `{secret:key}`, which is filled in on the server, only for the host that secret was declared for; the script never sees its value. `options.format` may be `feed` or `xml`, and the answer then carries `data`, read the way a recipe's feed or document is. |

An answer has `ok`, `status`, `contentType`, `text()` and `json()`, and never
the response's headers. A 404 is an answer with `ok: false`. A host the
manifest does not name, an address with a secret in it, a sixth fetch, a
private address without the household's say-so, or an answer over a megabyte
is an error thrown into the script, which it may catch.

**What it returns.** `{ panel, signals }`, either or both. The panel is any of
the [shapes above](#panel-data--the-shapes) and the signals are the
[`/signals` list](#get-signals--raising-an-alert-optional), read by the same
schemas: anything else is refused, never cut down to fit, and the wall keeps
the last good panel while the module's card says why.

**What it cannot do.** There are no files, no timers, no console, no `import`,
no network beyond `ctx.fetch`, and nothing left over from the last run: every
run starts in a new thread with a new interpreter. One run has 16 MB of memory,
200 ms of its own computing time (time spent waiting for a host is not
counted) and ten seconds in all. A loop that never ends, a recursion with no
bottom and a runaway regular expression are each stopped, and cost that one
module its panel and nothing else.

**Adding one.** Modules › Advanced › **Add a script** takes the manifest, the
script, the settings and any secrets. **Check it** shows what it may contact,
which credential goes to which host, and the sha256 of the code; **Run it
once** runs it for real and draws what it built, and **Add script** adds it.
Change a host or a character of the code and the page asks again. The
module's card shows the same sha256, so you can tell which version is running.
A script in the store is reviewed by pull request like a recipe, and may not
reach a household's own network: that is something a household allows only by
pasting a script themselves.

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

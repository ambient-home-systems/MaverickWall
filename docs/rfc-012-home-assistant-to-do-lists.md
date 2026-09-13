# RFC 012 — Home Assistant to-do lists, and the end of rule 12 as written

Status: **proposed; nothing built** · Owner: — · First drafted 2026-09-13 ·
Relates to `apps/server/src/modules/homeassistant/`,
`packages/core/src/ports/fetcher.ts`, `apps/server/src/net/fetcher.ts`,
`apps/server/src/api/widget-schema.ts`, `apps/server/src/api/manifest.ts`,
`apps/server/src/http/app.ts`, `apps/server/src/epaper/honours.ts`,
`apps/display/src/render.ts` · Builds on the module registry (RFC 001), the
free-form canvas (RFC 005) and the write path chores opened (RFC 008 phase 3) ·
Amends hard rule 12 · Constrains RFC 007

## 1. Summary

A household's shopping list already lives in Home Assistant, and a kitchen wall
is the one screen in the house where it is worth reading. We can already draw
it. What we cannot do is let anybody tick anything off, and **a checklist that
cannot be checked is a photograph of a checklist** — on a wall, next to a chore
board whose boxes *do* tick, which makes the difference look like a bug rather
than a policy.

So this RFC does two things, and the first is the one that needs the argument:

1. **It amends hard rule 12.** "Home Assistant integration is READ-ONLY. No
   service calls, no control." becomes a rule that permits exactly one service
   call, `todo.update_item`, and refuses everything else *by shape* rather than
   by a list somebody has to remember to keep short.
2. **It specifies the feature** — a `todo` panel module, a widening of the
   existing `todo` widget, and one new write endpoint modelled on
   `POST /d/chores/tick`.

The load-bearing finding is that **the write decides the transport**, and it
decides it in the direction that makes the build smaller. There is no WebSocket
command to complete a to-do item — core registers exactly three
(`todo/item/subscribe`, `todo/item/list`, `todo/item/move`) — so a tick must be
`todo.update_item`, a service call, over HTTP POST. Once POST is permitted,
`todo.get_items` is free, and the whole integration is one transport through the
existing guarded Fetcher: no `ws` client pointed at Home Assistant, and none of
the supervisor-proxy upgrade risk that kept us on polling in the first place.

The switch is reversible for nothing later, because the two reads are the same
bytes: `_async_get_todo_items` and `websocket_handle_todo_item_list` both
serialise through `dataclasses.asdict(item, dict_factory=_api_items_factory)`.
Write the parser once and the transport stays a latency decision for ever.

## 2. The decision this RFC exists to record

### 2.1 What rule 12 actually protects

Rule 12 is one sentence doing three separate jobs, and only one of them is the
security property:

1. **No control of the house.** This is the claim that matters. A Home Assistant
   long-lived access token has no scopes — the token that reads a temperature
   unlocks a door — so the limit has never been on Home Assistant's side. It is
   entirely on ours, which is why it had to be a rule and not a setting.
2. **No service calls.** This is a *mechanical proxy* for (1), and the valuable
   thing about it is not its strictness. It is that it is checkable by `grep`:
   there is no POST to Home Assistant anywhere in this repository, a person can
   confirm that in one command, and no reviewer has to reason about intent.
3. **Nothing in the manifest is a handle.** The display receives resolved values
   — "19.4 °C", "Open" — never an entity id, never a proxy endpoint, never the
   token. There is already a test asserting it. So a wall tablet in a hallway,
   fully compromised, holds nothing it could query Home Assistant *with*.

Only (2) changes. (1) survives as a narrower promise and (3) is untouched — and
(3) is the reason (1) survives at all, because it means the new write endpoint is
the *only* thing a compromised wall can reach, and that endpoint speaks to
`todo` and nothing else.

The cost is real and should be stated rather than absorbed: the property "this
codebase issues no POST to Home Assistant" was free, and its replacement — "this
codebase issues no POST to Home Assistant outside one frozen constant" — costs a
test to keep true. §10 specifies it.

### 2.2 The replacement rule

Proposed text for CLAUDE.md, replacing rule 12 entirely. The diff is in
Appendix A.

> **12. Home Assistant writes are confined to list data the household
> authored.** The one permitted service call is `todo.update_item`, and its
> whole effect is to set an item's status on a to-do list the household
> explicitly added on the Home Assistant screen. Nothing else — no `light`,
> `switch`, `cover`, `lock`, `alarm_control_panel`, `climate`, `scene`,
> `script`, `automation` or `camera`, and no `todo.add_item`,
> `todo.remove_item` or `todo.remove_completed_items` until one of them is
> argued for on its own merits. The allowlist is a frozen constant and a test
> asserts no outbound request to Home Assistant leaves it. The display still
> receives resolved values and handles this server minted, never an entity id
> and never the token — so a compromised wall tablet can tick an item off a
> shopping list and cannot unlock a door.

Three properties of that wording are deliberate.

**It names the effect, not the endpoint.** "Sets an item's status on a list the
household added" is a sentence somebody can check a proposed change against. "No
service calls" was easier to check and answered the wrong question — it would
have refused this feature, and it would equally have permitted nothing at all
about `todo.add_item`, which is a different risk wearing the same domain.

**It states the blast radius in the same breath.** That sentence exists in
`modules/homeassistant/client.ts` today and it says "somebody saw my indoor
temperature". Leaving that there after this ships would be the thing this
project keeps writing down and doing anyway: a document confidently describing a
property the code no longer has. It gets rewritten in the same commit as the
rule, and §8 is the text.

**It refuses the obvious next three by name.** `add_item` needs a keyboard on a
wall; `remove_item` and `remove_completed_items` destroy data a household typed
somewhere else. None is refused for ever — each is refused *here*, so that
building one is a decision somebody takes rather than a line somebody adds.

### 2.3 The firebreak

Rule 12 was also doing work it never claimed: holding off lights, covers,
scenes, alarms and camera pan/tilt. RFC 007 §13 rests on it explicitly — "Every
one of those is a write to Home Assistant, and rule 12 is not a setting." That
sentence's premise is what this RFC changes, so the replacement has to keep the
conclusion, and the test of the new wording is whether it does.

It does, and without naming cameras: a pan/tilt call is not "list data the
household authored", so the shape refuses it. The enumeration in §2.2 is belt
rather than mechanism, and it includes `camera` so nobody has to re-derive this.
**RFC 007 §13's bullet should be annotated rather than left standing**, because
its reasoning is right and its citation is about to be wrong.

The reason to define the permitted set by shape at all is that the moment one
POST exists, "it is just one more service" is an argument available for ever,
and this is a product whose whole pitch is that it is a calendar and not a
dashboard. `modules/homeassistant/entities.ts` already refuses whole domains on
exactly that ground, with the reasoning written at the declaration. This is the
same refusal one layer up.

## 3. What Home Assistant actually hands us

Everything in this section was read out of `homeassistant/components/todo/` on
`dev` rather than from documentation, because the shape of the payload and the
registration flags are what the design rests on.

### 3.1 The state is a count

A `TodoListEntity`'s state is **the number of incomplete items**. The items are
not in `attributes`. So `GET /api/states/todo.shopping_list` — the one call that
fits today's code perfectly — answers `"4"` and nothing else.

This is worth stating because it is exactly the fault `entities.ts` already
records for calendars: a `calendar.*` entity's state is `on`/`off`, so adding it
as a watched reading put "Bins · On" on the wall, which is neither a reading
anybody wants nor the calendar they meant. `todo.*` is the same trap with a
number instead of a word — "Shopping · 4" is not a shopping list.

### 3.2 Three read paths, and the write forces the choice

| Path | Shape | Covers |
|---|---|---|
| `POST /api/services/todo/get_items?return_response` | service call | every provider |
| WS `todo/item/list`, `todo/item/subscribe` | read command | every provider |
| `GET /api/shopping_list` | plain GET | legacy `shopping_list` only |

The third is genuinely free — `ShoppingListView` at `url = "/api/shopping_list"`
is a plain `get` returning the items, it needs no rule change and no Fetcher
change — and it is a dead end, because it reaches only the legacy integration
and not `local_todo`, Bring!, Grocy or anything else a household actually has.
It is not worth a code path that later has to be removed.

The second was this design's preferred read right up until the write was
specified. With the write requiring POST anyway, a WebSocket client buys nothing
but a second transport, a second auth handshake, and the one risk the project
has already written down: HA's WebSocket auth is reported to behave differently
through the supervisor proxy, which is precisely the add-on household. Dropped,
and recoverable at any time for the reason in §1.

**So: `todo.get_items` for the read, `todo.update_item` for the write, both over
the guarded Fetcher.** One transport, one credential path, one failure mode.

### 3.3 `supported_features` is the affordance

The obvious objection to ticking is a box that does not work, and Home Assistant
answers it rather than leaving us guessing. `update_item` is registered with
`required_features=[TodoListEntityFeature.UPDATE_TODO_ITEM]` — bitflag **4** —
so core itself refuses the call on a list that cannot be updated. And
`supported_features` is an ordinary state attribute, so a plain `GET
/api/states/todo.x` says so before anything is drawn.

Two layers, and both are needed for the reason `/d/interrupts/dismiss` already
gives: **the widget omits the box** when bit 4 is clear, because a control that
cannot work should not be drawn; and **the endpoint checks it too**, because the
wall hides the control as a courtesy and the display token is on the wall.

A list that cannot be ticked is still worth drawing. It is a list.

### 3.4 The uid, never the summary

`_find_by_uid_or_summary` matches `value in (item.uid, item.summary)` and
returns the **first** hit. A household with "Milk" on the list twice, ticking by
name, ticks whichever Home Assistant happens to return first — and which one
that is depends on the integration.

`get_items` returns uids. Carry the uid as the identity and the summary as
something to draw, and this is a bug that never exists. Carry the summary and it
is a bug report six months from now that nobody can reproduce on their own list.

## 4. The Fetcher has to grow one method

`FetchRequest` has no `method` and no `body`, and `net/fetcher.ts:338` hardcodes
`method: 'GET'`. Rule 4 says every user-supplied URL goes through this one
adapter, so this is a change to the boundary rule 4 exists to protect, and it is
the only genuinely security-relevant engineering in this RFC.

Two shapes, and the recommendation is the narrow one:

- **General.** Add `method` and `body` to `FetchRequest`. Simplest diff, and it
  quietly turns the single outbound boundary into a general-purpose HTTP client
  — available to recipe modules, to catalogue entries, to anything a household
  points at. The guard still runs, so this is not a hole; it is a much larger
  surface justified by a shopping list.
- **Narrow (recommended).** A second entry point on the port — call it
  `postJson` — with the method fixed at `POST`, a JSON body, and the same
  `UrlPolicy`, DNS pin, redirect rules, byte ceiling and `SENSITIVE_HEADERS`
  stripping (`fetcher.ts:57`) as `fetch`. The body comes from first-party
  constants and validated ids, never from a household-authored template. `fetch`
  stays GET-only and every existing call site is untouched.

The narrow version keeps a true sentence available: **no arbitrary method and no
household-authored body reaches the network.** That is worth more than the lines
it saves, and it is the version a security review can read in one sitting.

Redirect handling needs one explicit decision either way. `fetch` follows
redirects and strips `authorization` across origins. A POST that follows a
redirect is a request replayed somewhere we did not intend; **`postJson` should
refuse redirects outright** rather than follow them, because the only host it
ever speaks to is the household's own Home Assistant and a redirect off it is
either a misconfiguration or an attack.

## 5. Shape: to-do is its own module

### 5.1 A list is not a reading

It does not go in `ha_entity_cache` and `todo` does not join
`SUPPORTED_DOMAINS`. That table is a snapshot of scalar states with a
`display_mode` and a `label`, built for "Kitchen 19.4 °C". A list is a set of
rows with identity, status and ordering, and forcing it through the readings
table would give us a widget that draws `Shopping · 4` — §3.1's fault, arrived at
by a different route.

It is a `PanelModule` (`modules/registry.ts`) with block key `todo`, which buys
three things for free and the same three chores cites: `ready()` so a household
with no list watched never gets an empty block, the per-module `try/catch` in
`collectPanels` so a to-do bug costs the to-do panel and never the calendar, and
a place in the settings.

**With a job**, unlike chores — a list changes when somebody adds milk on their
phone, and nothing here can know that without asking. Interval is §11's to
settle; 60s matches the manifest poll and is the obvious starting point.

**Without `signals()`.** A shopping list that raises an interrupt is a wall that
nags, and the reasoning chores wrote down applies unchanged: easy to add later,
very hard to take back.

### 5.2 What is stored

Migration **0041**, additive, two tables:

- `ha_todo_lists` — the watched lists. `entityId` (primary key, in clear: a name
  rather than a credential, same reasoning as `calendar_sources.haEntityId`),
  `name`, `label`, `supportsUpdate`, `sortOrder`, `lastFetchedAt`, `lastError`.
- `ha_todo_items` — the cached items. A synthetic `id` primary key, then
  `entityId`, `uid`, `summary`, `status`, `due`, `position`, `fetchedAt`.

**The synthetic `id` is the handle**, and it is why there is a table rather than
a JSON column. Rule 12's surviving clause (3) says the display never receives an
entity id, so the wall cannot post `{entity_id, uid}` — it posts an opaque id
this server minted, and the server resolves it. That is RFC 007's `handle` idea
reused, arrived at independently and for the same reason. A row keyed on
`(entityId, uid)` makes the handle stable across polls with no crypto and no
per-poll registry, which a random token or an HMAC would both need.

No new keyring purpose: the credential is the existing HA token.

### 5.3 The manifest slice

Lists, each with its items: `id` (the handle), `summary`, `done`, and the list's
own `canTick`. No `entity_id`, no `uid`, no `supported_features` bitmask — the
manifest carries a resolved boolean, because a bitflag on the wall is an entity
detail leaking through a different door.

The ETag is free by the same accident chores relies on: the panel travels inside
`panels`, which is in `manifestEtag`'s preimage, so a tick moves the ETag and a
new item on somebody's phone moves it too. Free by accident is worth a test, and
chores has one to copy.

## 6. The widget

### 6.1 The existing `todo` widget is typed text

There is already a `todo` widget. Its items are lines the household types into
the layout editor (`layout-editor.ts:2877`, capped at 40), it renders on the
wall (`render.ts:1221`), on the panel (`epaper/widgets.ts:438`), it has a tier
table (`TODO_TIERS`) and a `PANEL_HONOURS` entry. Most of the drawing is done.

`widget-schema.ts:199` says what it is, and the comment is about to stop being
true:

> To-do — a static checklist. Each item is a line the household typed; the wall
> is read-only, so items are shown, not ticked (edited in the admin).

**Recommendation: widen the existing widget rather than add a second type.** One
new config key, `list`, naming a watched entity; absent means the typed `items`,
which is exactly today's behaviour. The alternative — a second `WIDGET_TYPES`
entry — doubles the tier table, the panel draw, the honours entry, the ink lane
and the palette, and puts "To-do" and "To-do (Home Assistant)" next to each
other in a picker, which reads as two products.

### 6.2 The omission trap

This is the one place the obvious implementation breaks something already
shipped, and it is worth finding here rather than in a kitchen.

`widgetIsSetUp(type, setUp)` (`api/manifest.ts:145`) omits a widget whose
backing module is not ready, via `WIDGET_MODULE`. Adding `todo: 'todo'` to that
map would omit **every existing typed-checklist widget** on every wall whose
household has no Home Assistant list — at one image pull, silently, on walls
that are working today. That is rule nine, and the mechanism is a one-line map
entry that looks like bookkeeping.

The function cannot express the distinction, because it takes a type and the
answer depends on the widget's own config. So `widgetIsSetUp` takes the widget
row, not the type string. That is an honest change rather than a workaround: its
own docstring asks whether *this widget* can ever have anything to say, and for
every other type the answer happens not to depend on the config. Here it does.

The rule: `list` absent → never omitted (it is typed text, it always has
something to say). `list` set and the module not ready, or that list no longer
watched → omitted, and the editor flags it the way it already flags a Weather
box with no location.

### 6.3 Panel parity

`epaper/widgets.ts`'s `drawTodo` must read `list` exactly as `render.ts` does,
or this is `shifts[0]` / `display_mode` / `cellEvents` / `mode` for the sixth
time — two renderers, one stored value, two answers. The specific hazard here is
the same one the calendar widget shipped: **an absent key is a value**, and
`list` absent must mean typed items on both sides.

`PANEL_HONOURS.todo` gains `list`; `showTick` (§7) goes in `PANEL_IGNORES` with
its reason, because a battery panel cannot offer a tick at all. A pixel changes
on every panel drawing a list, so `EPAPER_RENDERER_VERSION` bumps.

`TODO_TIERS` needs one look rather than a rewrite: an item with a tick box is
wider than a line of text at the same type size, so the `ch` thresholds are
measured against a different row. Measure it; do not assume it is free.

## 7. The write path

### 7.1 The route

`POST /d/todo/tick`, built from `/d/chores/tick` (`http/app.ts:675`) the way
that was built from `/d/interrupts/dismiss`. Same gate (`requireScreen`), same
household-wide effect, same "the server is the authority, not the button".

Body: `{ item: <handle>, done?: '0' }`. Absent `done` means done, which is the
overwhelmingly common press — chores' own rule.

What it refuses from the caller:

- **Which entity and which item.** It takes a handle and resolves it against
  `ha_todo_items`. An unknown handle is a 404.
- **Whether this screen may ask.** A new per-screen switch, off by default —
  see §7.6.
- **Whether the list can be ticked.** `supportsUpdate` off is a 409 with a
  sentence, not a silent no-op.

### 7.2 The authority inverts, and that is the genuinely new problem

`/d/chores/tick` works because the server owns the truth: `setChoreDone` writes
the same SQLite the next manifest reads, and the unique index on
`(chore_id, date)` makes it idempotent with no client queue. Here **Home
Assistant owns the truth** and we hold a cache.

What survives free: idempotence. Setting `completed` twice is `completed`, so
two screens pressed at once, or one retrying on a flaky network, is still fine.
No queue, no reconciliation — the property chores relies on holds for a different
reason.

What does not survive is everything in §7.3 to §7.5.

### 7.3 Latency, and the one argument that inverts

The wall's list comes from the manifest, which polls at 60s. A tick that writes
to Home Assistant and returns `{ok:true}` would leave the box empty for up to a
minute — which is "pressing OK on a wall and watching nothing happen", a fault
this project has shipped and written up twice.

The endpoint should write the cached row itself on a successful call and return
the new item state, so the next manifest is already right and the widget can
fill the box on the response. That is not an optimistic tick: the server has
Home Assistant's 200 before it writes anything.

Worth naming explicitly: chores rejected an optimistic tick because "an
optimistic tick reads better on one screen and buys a distributed-state problem
across two". **That argument is weaker here**, because both screens poll one
upstream that is the single source of truth, so a divergence is corrected by the
next poll rather than persisting. It is still not needed if the endpoint writes
through, and this RFC does not propose one — but a later phase proposing it
should not be waved away with a citation to a case that differs.

### 7.4 Failure has to be sayable

`/d/chores/tick` can only fail in ways it fully understands — a 409 for a chore
that is not due. This one can fail because Home Assistant is rebooting, because
the token was revoked on an upgrade, or because the item was deleted on somebody's
phone thirty seconds ago.

So the response carries a message written for somebody standing in a kitchen —
the rule `testFeed` already sets — and the widget draws it rather than leaving a
box that does not fill. Rule nine in the smallest place it has ever applied: the
tick failing is fine, the tick failing silently is not.

The 404-on-stale-handle case deserves its own sentence, because it is the common
one: "That is not on the list any more." is true, useful, and self-correcting on
the next poll.

### 7.5 Completed items accumulate, and we are not clearing them

A shopping list ticked on the wall and never cleared grows for ever. Clearing is
`todo.remove_completed_items`, which is a delete and outside §2.2.

The answer is that the phone app that owns the list does the clearing, and the
widget **hides completed items by default** rather than drawing a growing
graveyard. That is a display decision with no write in it, and it is the honest
one: the wall is a place to read the list and cross things off, not the place
the list is administered. A `showDone` switch is available if somebody wants the
satisfaction of the strikethrough.

This should be decided now rather than discovered, because "why is my list 200
items long" is the bug report.

### 7.6 Its own per-screen switch

`screens.allow_dismiss` and `screens.allow_chores` are separate switches because
"clearing a warning" and "claiming a chore is done" are not the same risk.
Ticking something off a household's real, shared, phone-synced shopping list is
a third one — it changes data outside this application, which neither of the
others does. `screens.allow_todo`, off by default, in the same migration.

## 8. What a leaked display token is worth now

The paragraph in `modules/homeassistant/client.ts` gets rewritten in the same
commit as the rule, and this is the proposed text:

> Nothing here writes. The one exception in the whole application is
> `todo.update_item`, called from `POST /d/todo/tick` against a list the
> household explicitly added, on a screen they explicitly allowed — see rule 12.
> The display still receives resolved values and handles this server minted,
> never an entity id, never a proxy endpoint, and never the token. So the blast
> radius of a compromised wall tablet is "somebody saw my indoor temperature and
> ticked something off my shopping list", and it is not, and must never become,
> "somebody opened my garage".

Two things follow that are not obvious. The handle means a compromised wall can
tick **only items it has been shown** — it cannot enumerate lists, cannot reach a
list the household did not add, and cannot construct a handle for one. And the
existing test asserting the manifest contains no entity id and no base URL now
covers a write path as well as a read one; it needs no change, which is the point
of having had it.

## 9. Phases

**Phase 1 — read only, with the apparatus.** `postJson` on the port and the
adapter; the `todo` module, its job, `ha_todo_lists`/`ha_todo_items`; the
settings section on the Home Assistant screen; `list` on the widget and the
`widgetIsSetUp` change; panel parity. **No tick box anywhere**, and the rule-12
amendment lands here, because the allowlist, the constant and the test are what
make the POST safe and they should exist before anything writes. Ships something
useful on its own: a household's shopping list, on the wall, correct.

**Phase 2 — the tick.** `screens.allow_todo`, `POST /d/todo/tick`, the
write-through, the failure sentence, the `supportsUpdate` gate on both sides.

**Phase 3 — polish, if wanted.** `todo/item/subscribe` for latency;
`showDone`; a per-list item cap.

Phase 1 is a real deliverable and phase 2 is small once it exists. That ordering
is deliberate: it puts the security change under review while the feature it
enables is still read-only, rather than in the same commit as the first write.

## 10. How this gets proven (verification is the job)

**The rule needs a test, because `grep` no longer answers it.** A test that
walks the compiled server for every call into `postJson` and asserts the URL
path is `/api/services/todo/update_item` and nothing else. Checked the way this
repository checks things: add a second permitted service to the constant and
watch it go red, then add a call site that bypasses the constant and watch it go
red for the other reason. A test that only covers the first is a test for the
allowlist rather than for the rule.

**The read needs a fake that answers like the real thing.** The Home Assistant
integration's own precedent is exact here: "a fake HA that answers 404 like the
real one" is how the `/api` path bug was found. This one must answer
`?return_response` correctly, must refuse it when absent with HA's own "Service
call requires responses but caller did not ask for responses", and must serve
a list with `supported_features` **without** bit 4 — the read-only list is the
case the widget's whole affordance rule rests on, and a fixture with only
tickable lists cannot see it.

**Two items with the same summary.** §3.4 is untestable on a well-behaved
fixture. The fixture has "Milk" twice, with different uids, and the assertion is
that ticking the second leaves the first alone. Reverting to summary-matching
must turn it red.

**The omission trap gets its own test.** A wall with a typed-items `todo` widget
and a household with no Home Assistant at all: the widget is drawn. That
assertion must go red when `WIDGET_MODULE` gains a naive `todo` entry — which
means writing it before the change, and watching it fail.

**Panel parity by rendering.** `epaper-ink`'s method: set `list`, decode the
frame, see whether the ink moved. And the absent-key case asserted as
*identical* frames, which is what pins "absence means typed items" on the side
that cannot be read from the editor.

**Looked at, on a real wall.** A paired screen, a real Home Assistant, a real
shopping list, a finger. Then the thing this project counts: somebody adds an
item on their phone and watches it appear, and ticks one on the wall and watches
it disappear from the phone. Neither of those is provable from a test, and the
second is the entire feature.

## 11. Open decisions

- **Poll interval.** 60s matches the manifest and is the obvious default. A
  shopping list is edited in bursts while somebody is standing in a shop, which
  argues for faster; an ESP32 panel and a household with six lists argue for
  slower. Measure before picking, and it may want to be per-list.
- **How many lists.** A cap exists or it does not. Six lists at 60s is 8,640
  requests a day against a Raspberry Pi, which is fine, and 40 is not.
- **Item cap per list.** `get_items` returns the whole list, and a household's
  "someday" list can be hundreds. The manifest should carry what a wall could
  plausibly draw plus a count, the way the month grid's model stops at twelve —
  but which number, and whether the renderer or the model cuts, is the tier
  question one widget along and should be answered by the same method.
- **Whether `status: needs_action` is the right filter on read.** Filtering at
  the service means completed items never reach us and `showDone` becomes
  impossible without a second call. Fetching everything means the cache carries
  a list's whole history. Probably fetch everything and cut in the model, but it
  interacts with the item cap.
- **The e-paper story.** A panel draws the list and cannot tick it, which is
  right and is the documented glance class — but a panel that draws a tick box
  it cannot honour would be a control that does nothing, so the box must be
  absent rather than inert, and that is a `PANEL_IGNORES` entry with a sentence
  in the editor rather than a silent difference.

## 12. Non-goals

- **Adding an item from the wall.** `todo.add_item` needs a keyboard on a wall,
  and every wall this product draws is a screen with no pointer and `cursor:
  none`. The phone that owns the list adds to it.
- **Deleting anything.** Covered in §7.5 and refused in §2.2. The wall crosses
  things off; it does not tidy up.
- **Reordering.** `todo/item/move` exists and is a write with no reading on a
  wall behind it.
- **Any other Home Assistant write, of any kind.** §2.3. If this RFC is
  remembered for one thing it should be the firebreak rather than the feature.
- **To-do lists that are not in Home Assistant.** A Todoist or Google Tasks
  integration would be a second source with its own credential, its own OAuth
  problem and its own failure modes. Not this RFC — and note that the widget's
  `list` key is a Home Assistant entity id, so a later source needs its own key
  rather than overloading this one.
- **Replacing chores.** A chore is a recurring obligation with a schedule and a
  record; a to-do item is a thing somebody typed once. RFC 008 §"Rejected: let
  Home Assistant own it" already argued this and nothing here changes it.

## Appendix A — the CLAUDE.md diff

Under **Hard rules**, replacing rule 12:

```diff
-12. Home Assistant integration is READ-ONLY. No service calls, no control.
+12. **Home Assistant writes are confined to list data the household
+    authored.** The one permitted service call is `todo.update_item`, and its
+    whole effect is to set an item's status on a to-do list the household
+    explicitly added. Nothing else — no `light`, `switch`, `cover`, `lock`,
+    `alarm_control_panel`, `climate`, `scene`, `script`, `automation` or
+    `camera`, and no `todo.add_item`, `todo.remove_item` or
+    `todo.remove_completed_items` until one of them is argued for on its own
+    merits (RFC 012). The allowlist is a frozen constant and a test asserts no
+    outbound request to Home Assistant leaves it. The display still receives
+    resolved values and handles this server minted, never an entity id and
+    never the token — so a compromised wall tablet can tick an item off a
+    shopping list and cannot unlock a door.
```

Also in the same commit, because each is a claim this change falsifies:

- **`modules/homeassistant/client.ts`**, the blast-radius paragraph — §8 has
  the replacement text.
- **The "Home Assistant is read-only, and that is a security property"
  paragraph** in CLAUDE.md's Current state, which says "nothing in the
  repository issues a POST to Home Assistant". One exception, named, with the
  test that keeps it to one.
- **`api/widget-schema.ts:199`**, the `items` comment — "the wall is read-only,
  so items are shown, not ticked".
- **RFC 007 §13**, whose camera bullet cites rule 12 as absolute. Annotated
  rather than rewritten: the conclusion holds, the citation moves to the shape
  clause.

Four places, and the reason to list them is the reason this document's own
header block exists: the most detailed claims in this repository are the ones
nobody re-reads, and a rule that changes in one file and stays the same in four
others is worse than a rule that never changed.

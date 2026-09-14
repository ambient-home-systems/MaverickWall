# RFC 012 — Home Assistant to-do lists, and the end of rule 12 as written

Status: **phases 1 and 2 shipped; phase 3 open** · Owner: — · First drafted 2026-09-13 ·
Relates to `apps/server/src/modules/homeassistant/`,
`packages/core/src/ports/fetcher.ts`, `apps/server/src/net/fetcher.ts`,
`apps/server/src/api/widget-schema.ts`, `apps/server/src/api/manifest.ts`,
`apps/server/src/http/app.ts`, `apps/server/src/epaper/honours.ts`,
`apps/display/src/render.ts` · Builds on the module registry (RFC 001), the
free-form canvas (RFC 005) and the write path chores opened (RFC 008 phase 3) ·
Amends hard rule 12 · Constrains RFC 007

> **Update — phase 1 is implemented**, and the body below is revised where
> building it contradicted it. What shipped: migration `0041` (`ha_todo_lists`,
> `ha_todo_items` with the `(entity_id, uid)` unique index, and
> `screens.allow_todo` — read by nothing yet, so the tick costs no second
> migration); `modules/todo/` with a sixty-second job; the To-do lists section
> on the Home Assistant screen; `list` and `showDone` on the widget; the wall,
> the panel and the editor reading `list` one way; and `widgetIsSetUp` taking
> the widget. The decisions §11 left open are closed and recorded there. Six
> things the body had wrong or had not seen, each fixed in the text where it
> sits and summarised here so a reader knows what to distrust:
>
> 1. **The list needed a key the wall could hold, and §5.3 and §6.1 together
>    put an entity id in the manifest.** The widget stores `todo.shopping`
>    (§6.1) and the manifest carries the layout's config untouched — so the
>    entity id would have travelled in the layout while §5.3 kept it out of
>    the panel. The manifest now rewrites a to-do widget's `list` to a handle
>    on the way out (`displayConfig`, `todoListHandle`) and the panel keys its
>    lists by the same handle; the panel renderer and the editor's preview
>    resolve the stored id the same way. Clause (3) is literally true again.
> 2. **§6.2 undercounted the places omission is keyed by type.** It named
>    `widgetIsSetUp`; there were four more — `widgetsNotDrawn`/`whyNotDrawn`
>    on the server, the editor's parse of that answer, the panel design page,
>    and `omission.ts` with the inspector reading through it — and a fifth
>    nobody could have read out of the source: the editor wrote a box's flag
>    only where the box is *built*, so a flag that follows a config change
>    needed `refreshLabels` to sync it. Found by the browser test, which read a
>    class that was stale over a preview that was not.
> 3. **`supported_features` is not in `get_items`**, so the job reads
>    `GET /api/states/<entity>` first — and a 404 *there* is a deleted list,
>    which the client's 404 sentence (written for the root: "not the Home
>    Assistant API") mis-describes. `CallResult` carries `httpStatus` now so a
>    caller can say so from the code rather than the wording.
> 4. **The status filter is this code's decision, not Home Assistant's
>    default.** Both statuses are named on every read. The fake honours the
>    real default (`needs_action` alone), and that caught the previous PR's
>    own boundary test asking with no status and expecting three items.
> 5. **`showDone` is phase 1**, not phase 3. It is a display decision and
>    costs nothing once every status is cached.
> 6. **`TODO_TIERS` is unchanged, measured rather than assumed**: the row a
>    list draws is the same `.td-row` the typed list draws, so the `ch` and
>    `em` thresholds are against the same markup. The tick box §6.3 worried
>    about is phase 2's problem — and phase 2 did not widen the row either: the
>    44px target is grown out of flow behind the same 1.7rem box, so the table is
>    unchanged again.
>
> Unproven where it counts: nobody has looked at a real wall or a real panel
> drawing a real list. The measurements are a real browser on a paired wall
> against a fake Home Assistant, and a decoded 1-bit frame.

> **Update — phase 2 is implemented**, and §7 is revised where building it
> differed from the specification. What shipped: `screens.allow_todo` read and
> written everywhere the column exists (the two `SELECT`s, the `UPDATE`, the
> wall's settings form, the manifest, and the display's own model);
> `POST /d/todo/tick` behind `requireScreen`; the write-through on a 200 and
> the upstream's own sentence on a failure; the tick box on the wall with its
> 44px target, its focus ring and its place in the `Enter` exemption; and a
> per-widget notice drawn from the model. Nothing on a panel changed and
> `EPAPER_RENDERER_VERSION` is still 9. Five things the body had wrong or had
> not seen:
>
> 1. **§7.1's body key is `item`, not `id`.** A cosmetic difference from
>    `/d/chores/tick` and deliberate: a chore posts the chore's own id and this
>    posts a *handle for one item on one list*, which is a different kind of
>    thing, and one endpoint's habits are not the other's contract.
> 2. **§7.4's sentence had nowhere to live.** The RFC says "the widget draws
>    it" and stops there, which is not buildable as written: `draw()` rebuilds
>    the whole document every fifteen seconds, so a handler writing into the
>    DOM has its sentence wiped before anybody reads it. It is **model state** —
>    a per-widget map in `main.ts` with a short expiry, cleared by the next
>    successful poll, and drawn by `renderTodoWidget` from the model like
>    everything else. That is the same seam `widget-options.ts` and `ink.ts`
>    exist at, for the same reason.
> 3. **The wall offers the tick on open items only.** The endpoint honours
>    `done=0` — idempotence and the correction both need it, and a branch
>    nothing exercises is a branch nobody can trust — but a completed item is on
>    screen at all only when the household asked to see what has been done,
>    which is a record rather than a place to undo one. §7.5's own argument,
>    one control along.
> 4. **§11's "`PANEL_IGNORES` entry with a sentence" is wrong about where it
>    goes.** Both honours tables are keyed on a *widget's config* and the set is
>    closed against `widgetConfigBody`; whether a wall may tick is
>    `screens.allow_todo`, which is not a widget key at all and cannot be set on
>    one. An entry there would be a key no schema has, on a table whose worth is
>    that `epaper-ink.test.ts` derives it by rendering. The reason is written at
>    the declaration instead, and the panel's frames are pinned byte-identical
>    to a clean worktree of the commit before this phase.
> 5. **A panel's own `allow_todo` moves its frame ETag**, and that is the
>    manifest's shape rather than this phase's doing: `manifestEtag` hashes the
>    whole document bar `generatedAt` and the `screen` block carries all three
>    flags, so `allow_chores` has behaved this way since it shipped. It cannot
>    fire in practice — no e-paper settings page offers any of the three — and
>    the *wall* a panel follows flipping its own switch moves nothing. Measured
>    against `allow_chores` rather than asserted, so the two cannot drift.
>
> Unproven where it counts, and it is the same sentence as phase 1's with more
> riding on it: **nobody has ticked an item on a real tablet and watched it
> leave their phone.** §10 says that is the entire feature.

## 1. Summary

A household's shopping list already lives in Home Assistant, and a kitchen wall
is the one screen in the house where it is worth reading. We can already draw
it. What we cannot do is let anybody tick anything off, and **a checklist that
cannot be checked is a photograph of a checklist** — on a wall, next to a chore
board whose boxes *do* tick, which makes the difference look like a bug rather
than a policy.

So this RFC does two things, and the first is the one that needs the argument:

1. **It amends hard rule 12.** "Home Assistant integration is READ-ONLY. No
   service calls, no control." becomes a rule that permits exactly one *write*,
   `todo.update_item`, and refuses everything else *by shape* rather than by a
   list somebody has to remember to keep short. The allowlist it is enforced
   through has **two** members, because `todo.get_items` is a service call as
   well — see the correction under §2.2.
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
> authored.** The one permitted **write** is `todo.update_item`, and its whole
> effect is to set an item's status on a to-do list the household explicitly
> added on the Home Assistant screen. The only other service call permitted at
> all is the read it needs, `todo.get_items`. Nothing else — no `light`,
> `switch`, `cover`, `lock`, `alarm_control_panel`, `climate`, `scene`,
> `script`, `automation` or `camera`, and no `todo.add_item`,
> `todo.remove_item` or `todo.remove_completed_items` until one of them is
> argued for on its own merits. The allowlist is a frozen constant of exactly
> those two and a test asserts no outbound request to Home Assistant leaves it.
> The display still receives resolved values and handles this server minted,
> never an entity id and never the token — so a compromised wall tablet can
> tick an item off a shopping list and cannot unlock a door.

**The first draft of that paragraph said "the one permitted service call", and
it was false in this document's own body.** §3.2 settles the read as
`POST /api/services/todo/get_items?return_response`, which is a service call by
every definition that matters here — it is the same verb, the same path prefix
and the same `postJson` on the port, so a rule phrased against *service calls*
would have been broken by the first line of code written to obey it. The word
that carries the security property is **write**: `get_items` cannot change
anything in a house and `update_item` can, and a rule that cannot tell those
apart is not describing the risk it exists to bound. So the allowlist has two
members and exactly one of them is a write, which is a shape a test can assert
and a reviewer can read in one line.

Three further properties of that wording are deliberate.

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
its reasoning is right and its citation is about to be wrong. So should §3's
constraint bullet one section earlier, which is where §13's premise is actually
stated — "`client.ts` states flatly that nothing here issues a `POST`" — and
which the first pass over this document missed. Appendix A records both.

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

### 4.1 The outcome type, specified

The first draft of this section left the outcome unstated, which is the half
that decides whether §7.4's "failure has to be sayable" is buildable at all. It
is `PostJsonOutcome`, and it is `FetchOutcome` with **two** differences.

```ts
export interface PostJsonRequest {
  readonly url: string;
  readonly policy: UrlPolicy;
  readonly maxBytes: number;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  /** JSON-serialisable. The adapter serialises it; no caller hands over text. */
  readonly body: unknown;
}

export type PostJsonOutcome =
  | { status: 'ok'; body: string; contentType: string; finalUrl: string; byteSize: number }
  | { status: 'rejected'; code: FetchRejectionCode; message: string;
      networkOptions?: readonly NetworkOption[] }
  | { status: 'failed'; code: FetchFailureCode; message: string; httpStatus?: number;
      retryAfterSeconds?: number;
      /** Present for `http-error`, capped by `maxBytes`. */
      responseBody?: string };
```

**There is no `not-modified` case**, because there is no conditional request to
produce one. `postJson` carries no `conditional` and no `acceptContentTypes`:
it always sends `accept: application/json` and `content-type: application/json`,
which is the whole of what it is for, and a call site that could vary either is
a call site that could send something else.

**The `http-error` failure carries the response body as text.** Home Assistant
answers a refused service call with `{"message": "..."}`, and that sentence is
the difference between a message somebody standing in a kitchen can act on and a
bare `400`. §7.4 is unbuildable without it — "the tick failing is fine, the tick
failing silently is not" requires the upstream's own words to reach the wall,
and `fetch` throws them away by design because a calendar feed's error page is
noise. It is capped by the same `maxBytes` the success path is, for the same
reason: an error body is a stranger's bytes.

**Any 3xx is `rejected('redirect-rejected', …)` and never followed**, per the
paragraph above. It is a *rejection* rather than a failure because it is not
retryable and means a misconfigured address rather than a broken network, which
is the distinction the port's own doc-comment already draws.

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
phone, and nothing here can know that without asking. Sixty seconds, matching
the manifest poll (closed in §11), and at most eight lists, which is what keeps
the arithmetic honest.

**Without `signals()`.** A shopping list that raises an interrupt is a wall that
nags, and the reasoning chores wrote down applies unchanged: easy to add later,
very hard to take back.

### 5.2 What is stored

> **Annotated for RFC 014 (2026-09-14).** The conclusion here holds unchanged
> and only the address does: a list is watched on
> `/admin/home-assistant/lists`, which is a screen of its own rather than a
> section of one long Home Assistant page. Nothing about the schema, the
> handle, the cap or the cache moved with it.

Migration **0041**, additive, two tables and one column:

- `ha_todo_lists` — the watched lists. `entityId` (primary key, in clear: a name
  rather than a credential, same reasoning as `calendar_sources.haEntityId`),
  `name`, `label`, `supportsUpdate`, `sortOrder`, `lastFetchedAt`, `lastError`.
- `ha_todo_items` — the cached items. A synthetic `id` primary key, then
  `entityId`, `uid`, `summary`, `status`, `due`, `position`, `fetchedAt`, with a
  **unique index on `(entityId, uid)`** the job upserts on, so the id survives
  a poll. A test asserts the same id before and after a poll whose payload is
  unchanged.
- `screens.allow_todo`, boolean, default false — **unread in phase 1** and
  exposed by no control. It lands here so the feature costs one migration
  rather than two.

The cache carries **every status**; the manifest carries at most forty open
items per list plus the list's total open count (the typed widget's own cap is
forty), and the renderer's tier decides how many of those are drawn. A list
past five hundred items is refused whole, on its last good rows.
**The synthetic `id` is the handle**, and it is why there is a table rather than
a JSON column. Rule 12's surviving clause (3) says the display never receives an
entity id, so the wall cannot post `{entity_id, uid}` — it posts an opaque id
this server minted, and the server resolves it. That is RFC 007's `handle` idea
reused, arrived at independently and for the same reason. A row keyed on
`(entityId, uid)` makes the handle stable across polls with no crypto and no
per-poll registry, which a random token or an HMAC would both need.

No new keyring purpose: the credential is the existing HA token.

### 5.3 The manifest slice

Lists, each keyed by a **handle** (`todoListHandle(entityId)`, a short stable
hash this server mints) with its items: `id` (the item's handle), `summary`,
`done`, `due`, `position`, and the list's own `canTick` and open count. No
`entity_id`, no `uid`, no `supported_features` bitmask — the manifest carries
a resolved boolean, because a bitflag on the wall is an entity detail leaking
through a different door — and **no timestamp**: if `fetchedAt` travelled, the
manifest ETag and the e-paper frame ETag would change every minute with
nothing on the list changed, and a battery panel would re-download a full
frame every poll. Pinned: two manifests built from identical cache rows at
different `now` values have one ETag, and one built after an item's status
changed has another.

The list key is a handle rather than the entity id because of the widget: it
stores the entity id (§6.1), and the manifest carries every widget's config
untouched — so without the rewrite in `displayConfig` the entity id would have
travelled in the *layout* while being kept out of the panel, which is clause
(3) broken through a different door. The panel renderer resolves a stored id
to the handle itself; the editor's preview substitutes the handle the server
handed its picker.

The ETag is free by the same accident chores relies on: the panel travels inside
`panels`, which is in `manifestEtag`'s preimage, so a tick moves the ETag and a
new item on somebody's phone moves it too. Free by accident is worth a test, and
chores has one to copy — and now this has one too.

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
which is exactly today's behaviour — pinned byte for byte on the panel against
frames taken from the renderer before the key existed. A second key,
`showDone`, draws the completed items too (§7.5). A stored `items` array is left
untouched when a list is chosen, so a household who tries a list and comes back
finds their lines where they left them. The alternative — a second `WIDGET_TYPES`
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

**This section undercounted.** Omission was keyed by type in four more places
than `widgetIsSetUp`: `widgetsNotDrawn`/`whyNotDrawn` on the server (now
keyed by widget id, with the sentence table still keyed by type), the editor's
parse of that answer, the panel design page, and `omission.ts` with the
inspector reading through it. And because the flag is computed at page load
and a household picking a list in the inspector must see it change,
`omission.ts` gained a pure predicate over the widget, the watched list ids and
the module-ready facts, evaluated on every config change; the server's answer
seeds it and the predicate keeps it current. The fifth place no reading of the
source could have found: the editor wrote the flag only where a box is
*built*, so a box whose list had been un-watched stayed marked after the
household chose the typed items instead — a stale class over a preview that
had already moved. `refreshLabels` syncs the flag now, and the browser test
that found it holds it.

The test this section asked for was written first and watched go red against
a bare `todo: 'todo'` — `expected ['clock'] to deeply equal ['clock', 'todo']`
— before the function was changed.

### 6.3 Panel parity

`epaper/widgets.ts`'s `drawTodo` must read `list` exactly as `render.ts` does,
or this is `shifts[0]` / `display_mode` / `cellEvents` / `mode` for the sixth
time — two renderers, one stored value, two answers. The specific hazard here is
the same one the calendar widget shipped: **an absent key is a value**, and
`list` absent must mean typed items on both sides.

`PANEL_HONOURS.todo` gains `list` and `showDone`; `INK_LANE.todo` stays empty,
because `list` is the widget's identity and the lane offers density and shape,
never a different list on the panel from the one on the wall.
`EPAPER_RENDERER_VERSION` is **9**: only a panel with a list-backed widget on it
moves, and the absent-key frames are pinned identical to 8.

**This section predicted a `showTick` key and phase 2 built none**, which is the
same correction §11 records and is worth making where the prediction sits. There
is no widget-level `showTick` anywhere: §7 never specified one, and whether a
wall may tick is `screens.allow_todo` — a fact about the *screen*. So it goes in
neither honours table rather than into `PANEL_IGNORES`, because both are keyed on
a widget's config and closed against `widgetConfigBody`; the reason is written at
the `PANEL_IGNORES` declaration instead.

`TODO_TIERS` was looked at and is unchanged: a list draws the same `.td-row`
the typed list draws, so the thresholds are against the same row.

**And the row did not widen after all**, which this section predicted it would
once the tick box arrived. The control is the read-only box — the same 1.7rem
square, now a `<button>` — and the 44px a fingertip needs is grown behind it by
an absolutely positioned pseudo-element, which is the chore tick's own idiom and
changes no layout at all. So `TODO_TIERS` is still unchanged in phase 2, the `ch`
and `em` thresholds are still measured against the same markup, and a wall that
allows ticking draws its rows at exactly the pitch a wall that does not.

## 7. The write path

### 7.1 The route

`POST /d/todo/tick`, built from `/d/chores/tick` (`http/app.ts:675`) the way
that was built from `/d/interrupts/dismiss`. Same gate (`requireScreen`), same
household-wide effect, same "the server is the authority, not the button".

Body: `{ item: <handle>, done?: '0' }`. Absent `done` means done, which is the
overwhelmingly common press — chores' own rule. The key is `item` rather than
chores' `id`, deliberately: a chore posts the chore's own id and this posts a
handle for *one item on one list*, which is a different kind of thing.

What it refuses from the caller, **in this order**, because each check is
cheaper than the one after it and because the order decides which sentence a
household reads:

- **Whether this wall may ask.** `screens.allow_todo`, off by default — see
  §7.6. A 403, "This wall cannot tick things off."
- **Which entity and which item.** It takes a handle and resolves it against
  `ha_todo_items`. An unknown handle, and one whose item has left the list
  since, are the same 404 and the same sentence: "That is not on the list any
  more." True either way, and self-correcting on the next poll.
- **Whether the list can be ticked.** `supportsUpdate` off is a 409 with a
  sentence, not a silent no-op — and **no POST is made to find out**, though
  Home Assistant would happily answer one: the answer is already in the cache,
  and a household reading core's wording for a refusal this server could have
  explained is a worse sentence than the one we can write.
- **What to call the item.** Always the `uid` from the cache row, never the
  summary — §3.4, and the one thing in this whole phase that cannot be
  discovered by a household with a well-behaved list.

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

The endpoint writes the cached row itself on a successful call and answers
`{ ok: true, done }`, so the next manifest is already right. That is not an
optimistic tick: the server has Home Assistant's 200 before it writes anything,
and on a failure it touches nothing at all.

**What the wall does with that answer is nothing**, which is the half the RFC
did not say. It does not fill the box from the response — it re-polls, and the
box fills from a document. One authority, drawn once; a renderer that painted
from a response and then from a manifest would be two, and this project's whole
list of repeated bugs is two readers of one value.

`ha_todo_items.fetched_at` is deliberately **not** moved by that write. The
poll's sweep deletes every row it did not touch by its own stamp, so advancing
it here would make an item ticked between two polls survive a poll that no
longer lists it.

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

**Where that sentence lives is the part this section did not specify, and it is
the only genuinely new mechanism in phase 2.** "The widget draws it" is not
buildable as a handler writing into the DOM: `draw()` rebuilds the whole
document every fifteen seconds, so the sentence would be wiped a moment after it
appeared — which is exactly why `tickChore` fails silently and can afford to. It
is **model state**: a per-widget map in `main.ts`, keyed by the box the press
landed in, with a short expiry and cleared by the next successful poll (both
branches of it — a 200 and a 304 are equally the server confirming the list).
`renderTodoWidget` reads it off the model like everything else it draws, so the
sentence survives a redraw by construction rather than by luck.

The body is read defensively on the way in — not JSON, no `message`, not a
string, empty after stripping all fall back to the wall's own wording, capped
and stripped — which is what `serverSaid` already does for the manifest's own
failures, one endpoint along.

The 404-on-stale-handle case deserves its own sentence, because it is the common
one: "That is not on the list any more." is true, useful, and self-correcting on
the next poll.

### 7.5 Completed items accumulate, and we are not clearing them

A shopping list ticked on the wall and never cleared grows for ever. Clearing is
`todo.remove_completed_items`, which is a delete and outside §2.2.

The answer is that the phone app that owns the list does the clearing, and the
widget **hides completed items by default** rather than drawing a growing
graveyard. The same argument decides where the tick box goes: the wall offers
one on an **open** item and never on a completed one. The endpoint honours
`done=0` and always will — idempotence and the correction both need it, and a
branch nothing exercises is a branch nobody can trust — but a ticked item is on
screen at all only when the household asked to see what has been done, which is
a record rather than a place to undo one. That is a display decision with no write in it, and it is the honest
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

Shipped as specified, and the one thing worth recording is where the column had
to be *named*: the two `SELECT`s in `api/queries.ts`, the `UPDATE` beside them,
the wall's settings form, `buildDisplayManifest`'s screen-like type and
`ManifestScreen`, and the display's own `manifest.ts` and `viewmodel.ts`. The
`SELECT`s are the ones that fail quietly — `readScreens` shipped exactly this
fault once for the e-paper columns, where the types swore a column was there and
it was `undefined` at runtime, and `undefined !== 1` reads precisely like a
household who left the switch off. Dropping `allow_todo` from that one query
turns twelve assertions red.

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

**Phase 1 — read only, with the apparatus. Built.** `postJson` on the port and
the adapter (the boundary PR); the `todo` module, its job,
`ha_todo_lists`/`ha_todo_items` and `screens.allow_todo` in one migration; the
settings section on the Home Assistant screen; `list` and `showDone` on the
widget and the `widgetIsSetUp` change; panel parity. **No tick box anywhere**,
and the rule-12 amendment landed first, because the allowlist, the constant and
the test are what make the POST safe and they should exist before anything
writes. Ships something useful on its own: a household's shopping list, on the
wall, correct.

**Phase 2 — the tick. Built.** `POST /d/todo/tick` behind `screens.allow_todo`
(the column already existed), the write-through, the failure sentence, the
`supportsUpdate` gate on both sides, and the control on the wall's page. Nothing
on a panel moved and `EPAPER_RENDERER_VERSION` is unchanged.

**Phase 3 — polish, if wanted. Open.** `todo/item/subscribe` for latency; a due
date on the row, which the panel already carries; and, if anybody wants it, the
undo on a completed row — the endpoint takes it today and only the wall declines
to offer it.

Phase 1 is a real deliverable and phase 2 is small once it exists. That ordering
is deliberate: it puts the security change under review while the feature it
enables is still read-only, rather than in the same commit as the first write.

## 10. How this gets proven (verification is the job)

**The rule needs a test, because `grep` no longer answers it.** A test that
walks the server's source for every call into `postJson` and asserts there is
exactly one, in `modules/homeassistant/client.ts` and in one function there;
that `HA_SERVICES` has exactly the two members §2.2 names; and that exactly one
of them is named as the write. Then the runtime half, against the fake: every
POST path the fake sees is a member of the constant. Checked the way this
repository checks things: add a **third** permitted service to the constant and
watch it go red, then add a call site in another file and watch it go red for
the other reason. A test that only does the first is a test for the allowlist
rather than for the rule — the whole risk being bounded is a second door, and a
constant cannot see one that does not read it.

**The claims need a test too, and that is the half nobody would think to
write.** Appendix A lists ten places this repository states a property the
amendment falsifies, and nine of them are prose — a heading in the README, two
paragraphs the supervisor renders out of `DOCS.md`, a card on the admin's own
Home Assistant screen. Prose does not fail to compile. The one thing that makes
a stale claim findable is that its wording is distinctive, so
`ha-claims.test.ts` scans for the *retired sentences* rather than for the new
ones: it renders the served Home Assistant page through the real app with a real
session, reads `README.md` and `addon/maverick-wall/DOCS.md` as text, and fails
on "cannot control anything", "no service calls", "never writes",
"read-only, permanently" and "no code in this application that writes". Then, in
the other direction and only on the page, it asserts the *replacement* sentence
is present with the permitted write named — because a claim deleted and not
replaced is a screen that has stopped explaining what pasting a token here
costs, which is worse than one that explains it wrongly.

It reads the page and the two documents rather than a list of files with the
strings in them, which is the difference between this and a `grep` somebody runs
once: `DOCS.md` is what a household sees in the supervisor, the admin card is
what somebody deciding whether to paste a token reads, and both are only worth
asserting in the form they are actually served in.

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

> **Annotated for RFC 014 (2026-09-14).** Two of the closed decisions below
> name "the admin" refusing a ninth list and "the Home Assistant screen" as the
> place a list is chosen. Both still hold and both now happen on
> `/admin/home-assistant/lists`. The e-paper decision at the foot is untouched
> in every respect: `screens.allow_todo` is still a fact about a screen rather
> than a widget key, and the split added no honours entry anywhere.

- ~~**Poll interval.**~~ **Closed: sixty seconds**, matching the manifest
  poll, and not per-list. A poll that varies with a count is a setting nobody
  can explain at a fridge.
- ~~**How many lists.**~~ **Closed: at most eight.** Eight lists at sixty
  seconds is 11,520 requests a day against a Raspberry Pi — two per poll per
  list, the state and the items — and the admin refuses a ninth with a
  sentence.
- ~~**Item cap per list.**~~ **Closed: the manifest carries at most forty open
  items per list plus the list's total open count** (the typed widget's own
  cap), and up to forty completed ones beside them; the renderer's tier decides
  how many are drawn. The cache refuses a list past five hundred items whole,
  on its last good rows.
- ~~**Whether `status: needs_action` is the right filter on read.**~~
  **Closed: fetch everything and cut in the model.** Both statuses are named on
  every read, because the filter is this code's decision and not Home
  Assistant's default — and the fake honouring that default is what caught a
  test asking without one.
- ~~**The e-paper story.**~~ **Closed, and the conclusion held while the
  mechanism did not.** A panel draws the list and cannot tick it, the box is
  absent rather than inert, and that is right — but it is **not** a
  `PANEL_IGNORES` entry. Both honours tables are keyed on a *widget's config*
  and the set is closed against `widgetConfigBody`; whether a wall may tick is
  `screens.allow_todo`, a fact about the screen, which is not a widget key and
  cannot be set on one. An entry there would be a key no schema has, on a table
  whose whole worth is that `epaper-ink.test.ts` derives it by rendering — it
  proves `PANEL_IGNORES` by setting each key and watching no ink move, which it
  cannot do for a key that cannot be set. The reason is written at the
  declaration instead, and what holds the claim is a measurement: the panel's
  frames pinned byte-identical to a clean worktree of the commit before this
  phase, plus an assertion that a list's `canTick` moves no pixel either way.

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
+    authored.** The one permitted *write* is `todo.update_item`, and its whole
+    effect is to set an item's status on a to-do list the household explicitly
+    added. The only other service call permitted at all is the read it needs,
+    `todo.get_items`. Nothing else — no `light`, `switch`, `cover`, `lock`,
+    `alarm_control_panel`, `climate`, `scene`, `script`, `automation` or
+    `camera`, and no `todo.add_item`, `todo.remove_item` or
+    `todo.remove_completed_items` until one of them is argued for on its own
+    merits (RFC 012). The allowlist is a frozen constant of exactly those two
+    and a test asserts no outbound request to Home Assistant leaves it. The
+    display still receives resolved values and handles this server minted,
+    never an entity id and never the token — so a compromised wall tablet can
+    tick an item off a shopping list and cannot unlock a door.
```

### The claims this falsifies

**This list had four entries and the true number is ten.** That is worth more
than the correction, because the four it named were the four somebody working on
*this feature* would open anyway — the client the write goes through, the rule
in CLAUDE.md, the widget schema the key lands on, and the RFC that cites rule 12
by number. The six it missed are the ones nobody working on a to-do list has any
reason to open: a README heading, two paragraphs the supervisor renders on an
add-on page, a doc-comment above an unrelated network helper, a section divider
in the schema, and a bullet in an RFC about cameras. Those are exactly the
claims this document's own header block warns about — the ones nobody re-reads —
and a rule that changes in four files and stays the same in six others is worse
than a rule that never changed. Found by searching for the *sentences* rather
than for the feature, which is what `ha-claims.test.ts` (§10) now does on every
run.

Each of these is a claim this change makes false. All ten are rewritten in the
same commit as the rule.

| # | Where | What it says today |
|---|---|---|
| 1 | `apps/server/src/modules/homeassistant/client.ts`, the file docblock | "**Read-only, permanently.** Nothing in this file or anything that calls it issues a POST" and "Nothing writes" in the blast-radius list. §8 has the replacement. |
| 2 | `CLAUDE.md`, Current state — "Home Assistant is read-only, and that is a security property" | "nothing in the repository issues a POST to Home Assistant". One exception, named, with the test that keeps it to one. |
| 3 | `apps/server/src/api/widget-schema.ts`, the `items` comment | "the wall is read-only, so items are shown, not ticked". |
| 4 | `docs/rfc-007-camera-feeds.md`, **§3 and §13** | §3: "`client.ts` states flatly that nothing here issues a `POST`." §13: "Every one of those is a write to Home Assistant, and rule 12 is not a setting." Two sites, not one — §3 is where the premise is stated and §13 is where it is used. Annotated rather than rewritten: both conclusions hold, and the citation moves to the shape clause. |
| 5 | `apps/server/src/http/admin-ha.ts`, `boundary()` | The card a household reads before pasting a token: "Maverick Wall reads. It cannot control anything." and "There is no code in this application that writes to Home Assistant." Asserted verbatim by `apps/server/test/homeassistant.test.ts`, which changes with it. |
| 6 | `README.md`, **twice** | The feature bullet ("It cannot control anything") and the section heading "Home Assistant: read-only, permanently" with its body ("Nothing in this repository sends a write of any kind"). |
| 7 | `addon/maverick-wall/DOCS.md`, **twice** | The opening line ("it never writes anything back") and "What it will not do" ("It cannot control anything in Home Assistant. There are no service calls"). **The supervisor renders this file**, so it is the claim most households actually read. |
| 8 | `apps/server/src/net/supervisor.ts`, the file docblock | "Read-only, like everything that touches Home Assistant here". |
| 9 | `apps/server/src/db/schema.ts`, the section divider above `ha_settings` | "Home Assistant. Read-only, always." |
| 10 | `docs/rfc-006-epaper-screens.md`, "The rules this touches" | "**Rule 12 (HA read-only).** Maverick never calls an HA service." |

Two of those are worth a sentence each. **(5) is asserted by a test**, so the
claim and its guard move together or the suite goes red — which is the only one
of the ten that could not have gone stale quietly, and is the argument for
`ha-claims.test.ts` covering the other nine. And **(7) is the one a household
sees**: the other nine are read by contributors, and this one is rendered on the
add-on page beside the Install button.

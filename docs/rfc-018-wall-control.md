# RFC 018 — Wall control, and a narrow amendment to rule 12

Status: **accepted 2026-10-05 (MD13); every wall phase built (1–6) — lights,
switches, fans, blinds and speakers operate from a wall, scenes and scripts run
by press-and-hold, and webhook buttons call addresses set in the admin; and
`todo.add_item` runs from the companion API, never a wall (M2.1–M2.2).** Nothing
in this RFC remains to build. Hard rule 12 in `CLAUDE.md` now reads as §3.1 below, with its
last clause qualified for scripts (§3.3). Phase 1 (§12) landed the table,
`buildCall`, the door's issued check and the claims; phase 2 the route, all
three switches, the button, the history and the browser test; phase 3
brightness, colour, white, fan speed, a blind's movement and the panel; phase 4
scenes and scripts; phase 5 webhook buttons; phase 6 a media player's
transport and volume. Every open question was
decided by the owner the same day: the five items in §5.2 are folded into §5
and §5.1, and OQ6–OQ10 are settled in §14 ·
Owner: — · First drafted 2026-10-05 · Relates to
`apps/server/src/modules/homeassistant/client.ts` (`HA_SERVICES`,
`callService`), `apps/server/src/modules/homeassistant/entities.ts`
(`SUPPORTED_DOMAINS`), `apps/server/src/api/manifest.ts` (`haReadingHandle`,
`displayConfig`), `apps/server/src/http/app.ts` (`/d/todo/tick`),
`apps/server/src/http/admin-ha.ts`, `apps/display/src/render.ts`,
`apps/display/src/house-tiles.ts`, `apps/server/src/epaper/honours.ts`,
`apps/server/test/ha-write-boundary.test.ts`, `apps/server/test/ha-claims.test.ts`
· Builds on RFC 012 (the to-do write and its door), P1.3 (readings by handle),
P5.3 (the tile look) · Decision MD2 and plan items M6.0, M6.9, M6.11–M6.13 in
[`plan-2026-10-magic-frame-parity.md`](plan-2026-10-magic-frame-parity.md)

## 1. Summary

This RFC proposes letting a wall **operate a small, named set of things in the
house**: toggle lights, switches and fans; set a light's brightness and colour,
a fan's speed and a blind's position; play, pause, skip and set the volume of a
media player; run a scene or a script the household picked; and press a webhook
button the household defined. Separately, a phone holding a companion token may
add an item to a to-do list the household added. Locks, alarms, helpers
(`input_boolean`), thermostats, and any cover that is a garage, gate, door or
window stay out of reach, by the rule and by a test.

Three switches must all be on before a wall can change anything: the **wall's**
own switch, the **entity's** "can be controlled from walls" in the admin, and the
**widget's** tap action. Every one is off by default. The wall still receives
handles and never an entity id, and every call still leaves through the one door
RFC 012 built, now holding a table of verbs instead of two names.

The sentence this product has always been able to say survives, narrowed and
still true: **a compromised wall tablet can turn off the kitchen light and cannot
open the garage.**

Nothing is built until this is accepted, and the first phase after acceptance
changes the boundary and its tests and draws nothing (§12), as RFC 012's did.

## 2. Why now

The Magic Frame review (the parity plan, Part 1) found that the most-used thing
on a Magic Frame wall is the thing we refuse: tapping a light. Three of its 19
widgets exist mostly to switch things, and its households ask for more of it.
The owner decided (MD2) to propose a narrow version rather than adopt theirs.

Theirs is worth reading as the shape to avoid. Its `/api/ha/action` has no
session check. Since v1.4.0 it limits the entity to one placed on a saved view
and the service to a list of verbs, but before that one lamp on a public view
reached `hassio.host_reboot`, and its default service is the generic
`homeassistant.toggle`, which works on any domain. Every display, and anyone on
the network, can call it.

## 3. The decision this RFC asks for

### 3.1 Rule 12, as accepted

> 12. **Home Assistant writes are confined to what the household picked, through
> one door.** Three kinds of write are permitted. `todo.update_item` sets an
> item's status on a to-do list the household added (RFC 012). `todo.add_item`
> adds an item to such a list, from the companion API and never from a wall.
> And a wall may operate an entity the household marked controllable, on a wall
> they allowed, from a widget they set to act, using only the verbs in §5 of
> RFC 018. The allowlist is a frozen table and a test asserts no outbound
> request to Home Assistant leaves it. **Never** `lock`,
> `alarm_control_panel`, a cover whose device class is `garage`, `gate`, `door`,
> `window` or `damper` or is unset, `input_boolean`, `climate`, `button`,
> `input_button`, `valve`, `siren`, `camera`, `automation`, `update`, `notify`,
> `hassio`, or a generic `homeassistant.*` service — nor a **scene** that sets
> any of them, which is checked member by member when it is marked and again at
> every press. A **script** cannot be checked that way, and nor can a **webhook
> button**, which calls whatever is behind its address — a Home Assistant
> webhook is a script by another name — so either, once the household allows
> it, can do whatever it was written to do, and the admin says so before they
> allow it. The display still receives handles this server minted, never an
> entity id, an address or the token — so a compromised wall tablet can turn
> off the kitchen light and cannot open the garage, unless a script or a webhook
> button the household allowed on that wall does.

### 3.2 What changes for the blast radius

| | Today | With this RFC |
| --- | --- | --- |
| A stolen display token, or a compromised tablet | Read what the wall shows; tick to-do items on lists the household added. | The same, plus operate the entities marked controllable, **on walls allowed to**, within the verbs and rate limits here. |
| Somebody standing at the wall | The same as above. | The same as above. |
| A stolen companion token | Nothing in Home Assistant (the token does not exist yet). | Add items to the to-do lists the household added. |
| What stays impossible | Every other service, every other entity. | Locks, alarms, helpers, thermostats, garage/gate/door/window covers, any entity not marked, any wall not allowed, any free-form service data, any target but one entity. |

The honest cost is the first row. The household decides how large it is, entity
by entity and wall by wall, and the admin says so in those words (§7.3).

### 3.3 Scenes and scripts reach past the table (decided 2026-10-05, phase 4)

The table has no row for a lock or a garage door, but a scene sets every entity
in it and a script can call any service, so "cannot open the garage" was true
only of direct control. Building phase 4 surfaced it, and the owner chose:

- **A scene is checked.** Home Assistant lists a scene's members in its
  `entity_id` attribute. Each is judged by the never-list
  (`sceneReachesNever`, `neverFromAWall`) against the house's current states —
  when the household marks the scene controllable, and again at every press.
  A scene that sets a never-list member is refused, naming the member, and one
  edited to set one later loses its switch at the next press. A scene that
  lists no members is refused as though it set a lock.
- **A script is qualified, not checked.** The REST API offers no list of what a
  script calls. A script stays allowed, behind the three switches and its
  warning, and every "never" sentence — Rule 12's last clause included — says
  "unless a script you allowed does". `ha-claims.test.ts` refuses the
  unqualified sentence and requires the qualifier on the Home Assistant card,
  in the README and in the add-on's documentation.

## 4. What Home Assistant gives us, and does not

- **The token has no scopes.** The same long-lived token that reads a
  temperature can unlock a door, and Home Assistant offers a household no
  per-entity permissions to narrow it. Every limit in this RFC is therefore
  ours, enforced in this process, and tested here.
- **Services are domain-specific.** `light.turn_on` cannot touch a lock. A
  generic service (`homeassistant.toggle`, `homeassistant.turn_on`) takes an
  entity of any domain, so a domain check would have to be on the target rather
  than the service. We never call one.
- **A target can be more than one entity.** `area_id`, `device_id`, `label_id`
  and `entity_id: all` each reach a set this server cannot see. We send exactly
  one `entity_id`, always.
- **Device class and supported features are in the state.** `device_class` on a
  cover, `supported_color_modes` and the colour-temperature range on a light,
  and the `supported_features` bitmask are all on `GET /api/states/<id>`, which
  this module already reads. They can change when an integration updates, so
  they are re-read at call time (§8.2).
- **Persistent notifications are no longer entities.** Listing them needs Home
  Assistant's WebSocket API, which this client does not speak (§14, OQ9).

## 5. The allowlist

`HA_SERVICES` becomes a frozen table. Each row is a domain, a service, the wall
action that reaches it, and the only data the server may send with it. Data is
built by the server from a bounded value; **the wall never sends service data.**

| Domain | Service | Wall action | Data the server sends | Eligible when |
| --- | --- | --- | --- | --- |
| `todo` | `get_items` (read) | — | `status` | A list the household added (RFC 012). |
| `todo` | `update_item` | tick | `item`, `status` | The same. |
| `todo` | `add_item` | — (companion API only, never a wall) | `item`: the text, at most 255 characters, stripped like any stranger's string | A list the household added, whose `supported_features` include creating items. |
| `weather` | `get_forecasts` (read) | — | `type` | The household picked this entity as a weather source (M5.8). |
| `light` | `toggle` | toggle | — | Marked controllable. |
| `light` | `turn_on` | brightness | `brightness_pct` 1–100 | Marked controllable; a dimmable colour mode is supported. |
| `light` | `turn_on` | colour | `rgb_color` (0–255 each) or `color_temp_kelvin` within the light's own range | Marked controllable; that colour mode is supported. |
| `switch` | `toggle` | toggle | — | Marked controllable. |
| `fan` | `toggle` | toggle | — | Marked controllable. |
| `fan` | `set_percentage` | speed | `percentage` 0–100 | Marked controllable; speed is in `supported_features`. |
| `cover` | `open_cover`, `close_cover`, `stop_cover` | open, close, stop | — | Marked controllable; `device_class` is `awning`, `blind`, `curtain`, `shade` or `shutter`. |
| `cover` | `set_cover_position` | position | `position` 0–100 | As above, and position is in `supported_features`. |
| `scene` | `turn_on` | run | — | Marked controllable. |
| `script` | `turn_on` | run | — (no variables) | Marked controllable. |
| `media_player` | `media_play_pause` | play/pause | — | Marked controllable; play and pause are in `supported_features`. |
| `media_player` | `media_next_track`, `media_previous_track` | next, previous | — | Marked controllable; that feature is supported. |
| `media_player` | `volume_set` | volume | `volume_level` 0.0–1.0, converted by the server from the wall's 0–100 | Marked controllable; volume set is supported. |
| `persistent_notification` | `dismiss` | dismiss | `notification_id` | A notification shown on this wall (M6.11). |

Every row sends `entity_id` as a single string, except the `todo` rows, which
keep RFC 012's shape. `ha-write-boundary.test.ts` asserts this table
exactly, row by row, including the data keys.

Webhook buttons are not Home Assistant service calls and have their own section
(§9).

### 5.1 Never

The rule names them so nobody adds them by analogy: `lock`,
`alarm_control_panel`, covers whose `device_class` is `garage`, `gate`, `door`,
`window`, `damper` or **unset** (fail closed), `button` and `input_button` (a
"press" is often an "open the gate" relay), `input_boolean` and `climate`
(§5.2), `valve`, `siren`, `camera`, `automation`, `update`, `notify`, `hassio`,
`homeassistant.*`, and every domain and service not in the table. Also never:
`area_id`, `device_id`, `label_id`, `entity_id: all`, or any service data the
wall supplied. `todo.add_item` is never reachable from a `/d/*` route.

### 5.2 Decided by the owner on 2026-10-05

Five items were argued separately, each a row that could have been added. The
owner accepted every recommendation: three are rows in §5, two are in §5.1.

| Item | Decision | Why |
| --- | --- | --- |
| `media_player` transport: play/pause, next, previous, volume | **Included**, in its own phase (§12, phase 6). | Needed by the now-playing card (M6.9). Low harm: the worst case is music stopping. |
| `todo.add_item`, from the **companion API only**, never the wall | **Included**, with the companion API (M2.2). | The phone-to-shopping-list case (MQ3). It adds to a list the household added; the API needs a token; the wall has no keyboard. |
| `fan.set_percentage` | **Included**, with position (§12, phase 3). | The same shape as brightness. |
| `input_boolean.toggle` | **Excluded.** | These helpers often gate automations: "vacation mode", "alarm armed", "guest mode". A toggle can disarm something the household never thought of as a switch. |
| `climate.set_temperature` | **Excluded.** | Not asked for, and a heating setpoint left at 30 °C by a child costs real money. |

## 6. Three switches, all off by default

1. **The wall: `screens.allow_control`.** Its own column, beside `allow_dismiss`,
   `allow_chores` and `allow_todo`, for the reason RFC 012 gave for separating
   those: each is a different risk. On the wall's own settings, in the same
   group, with one sentence: "Anyone at this wall can operate the things you
   marked controllable." Never offered on an e-paper panel.
2. **The entity: "Can be controlled from walls".** A column on
   `ha_entity_cache`, set on the Readings screen. It is offered only for an
   entity whose domain and device class are eligible under §5, and the screen
   says why when it is not offered ("A garage door is never controllable from a
   wall"). Scripts, scenes and switches carry a warning, because each can do
   more than its name suggests (§7.3).
3. **The widget: a tap action.** A Home Assistant widget gains `tapAction`:
   `none` (absent, the default) or `act`. So a household can show a light's
   state on the hall wall without making it tappable there.

All three are re-checked by the server on every press. The display only hides
what it would not be allowed to do.

## 7. The admin

### 7.1 The Readings screen

Each eligible reading gains a switch, "Can be controlled from walls", stored on
`ha_entity_cache`. The saved strip says what is true ("Kitchen light can be
operated from walls that allow it. No wall allows it yet."), following P1.3's
rule that a token is a claim.

### 7.2 The wall's settings

`allow_control` sits in Touch controls, with the other three switches.

### 7.3 Saying what each choice costs

- A script: "A script can do anything Home Assistant can do. Allow only scripts
  you would let a guest in your kitchen run."
- A scene: "A scene sets every entity in it, including any lock or cover it
  names."
- A switch: "A switch can be wired to anything. Check what this one powers."

### 7.4 Recent wall actions

The admin lists the last 14 days of presses: when, which wall, which reading
(by its label, which is the household's own), what, and whether Home Assistant
accepted it. Stored in an `ha_wall_actions` table, kept 14 days. Not in the logs
and not in the diagnostics export, which keep their rule of carrying no
household content.

## 8. The write path

### 8.1 The route

`POST /d/ha/act`, built from `/d/todo/tick`: the same gate (`requireScreen`),
the same "the server is the authority, not the button".

Body: `{ reading: <handle>, action, value? }`, parsed with Zod. `value` is a
number or an `[r, g, b]` triple and nothing else.

### 8.2 The checks, in order

Each check is cheaper than the next, and the order decides which sentence a
household reads.

1. **This wall may operate things.** `screens.allow_control`. 403, "This wall
   cannot operate things in the house."
2. **The reading exists.** Resolve the handle against the watched entities
   (`haReadingHandle`). 404, "That is not on this wall any more."
3. **It is marked controllable.** 403, "That can't be operated from a wall."
4. **The widget that drew it acts.** The press carries the widget id; the stored
   widget's `tapAction` must be `act`. 403, the same sentence as 3.
5. **The action is in the table for that domain, and the value is in bounds.**
   400.
6. **The entity is still eligible.** Re-read `GET /api/states/<id>`: domain,
   `device_class`, `supported_features`, colour modes and range. A cover that
   became a `garage` since it was marked is refused here, and its controllable
   flag is cleared. 409, "That can't be operated from a wall any more."
7. **Rate.** At most 20 presses a minute per wall, and one in flight per entity.
   429, "Too many presses. Try again in a moment."

Then `buildCall(entry, entity, value)` makes the one call. It is the **only
constructor** of a service call, and `callService` accepts nothing else, so a
call outside the table is a compile error as well as a test failure.

### 8.3 After the call

On a 200, the server re-reads that entity's state, writes the cache, records the
action, and answers `{ ok: true }`. The wall does nothing with the answer but
re-poll, exactly as `/d/todo/tick` does, so there is one authority and one
drawing. On a failure, nothing is written and Home Assistant's own diagnosis
comes back as a sentence with a 502, through `describe`.

### 8.4 The cross-origin guard

`/d/*` POSTs carry the display cookie. The app-wide guard that refuses a non-GET
with a foreign `Origin` already covers this route; a test asserts it does.

## 9. Webhook buttons

A webhook button POSTs to an address the household set up in the admin. It is
not a Home Assistant service call, so it does not go through `HA_SERVICES`. It
is in this RFC because pressing it from a wall is the same kind of act.

- **Targets live in the admin**, each with a name. The address is sealed with
  the keyring, because a webhook address is usually its own secret (a Home
  Assistant webhook id is).
- **The wall sends a handle.** Method POST, an empty body, no headers beyond an
  optional sealed secret header, through `Fetcher` with the target's own network
  options (public https by default; the LAN opt-in per target). The response
  body is discarded; only success or failure comes back, as a sentence.
- **A webhook into Home Assistant is a script by another name.** An address on
  the connected Home Assistant's host under `/api/webhook/` carries the script
  warning (§7.3).
- The same three switches apply, with the target's own "can be pressed from
  walls" in place of the entity's.

## 10. The wall

- A tile or reading with `act` becomes a real `<button>`: 44×44 px target,
  `:focus` and `:focus-visible` rings (a wall has `cursor: none`), `Enter`
  activates, `Escape` is never bound.
- **Tap** toggles. **Brightness, colour and position** open a panel drawn from
  model state, as the to-do failure sentence is, so it survives the 15 s
  rebuild. A slider sends its value once, on release; never a stream while
  dragging.
- **Scenes, scripts and webhooks need a press-and-hold** of 600 ms, with the
  hold drawn as a ring, because tapping again cannot undo them (OQ6,
  decided). On a keyboard, `Enter` held for the same time.
- A failure shows its sentence in the widget, from model state, for 8 s or
  until the next good poll, as RFC 012's tick does.
- **Nothing moves.** A button is the same rectangle as the tile it replaces; a
  panel is an overlay. The reflow-stability test gains a wall with controls.

### 10.1 E-paper

A panel never operates anything. `tapAction` joins `PANEL_IGNORES` with its
sentence, and `allow_control` is in neither honours table, for the reason
`allow_todo` is not (it is a fact about the screen, not a widget key).

### 10.2 The manifest

A reading that the wall may operate carries `actions` — the verbs the server
resolved for it on this wall, such as `["toggle", "brightness"]` — spread, never
emitted empty. A household that turns nothing on sends a byte-identical manifest
and keeps its ETag. Still no entity id: the existing assertion in
`homeassistant.test.ts` runs again with controls on.

## 11. The sentences this falsifies

RFC 012 named four places that said "never writes" and the truth was ten. So
this RFC names what a search found, and §13 requires the search again before
merge rather than trusting this list:

- `CLAUDE.md`, hard rule 12, and the security paragraph under "Home Assistant
  writes go through one door".
- `client.ts`, the header ("Two service calls, one of them a write") and the
  `HA_SERVICES` comment.
- `entities.ts`, the comment on the seven read-only domains.
- `README.md` around lines 152–175 ("tick something off your shopping list").
- `addon/maverick-wall/DOCS.md` line 4 ("The only thing it will ever write back
  is ticking an item off") and lines 86–91.
- `admin-ha.ts` around lines 1516–1535 ("Maverick Wall reads, and can tick one
  kind of box").
- `docs/exposing-safely.md`, which should say what a display token can now do.

`ha-claims.test.ts` gains these as retired sentences, and the Home Assistant
screen is held to naming the controls it permits, as it is held today to naming
the to-do write.

**Retired in phase 1, verbatim** (lower-cased as the test matches them; the
test reads this list to prove each is distinctive enough to find):

- "can tick one kind of box"
- "the one thing this application will ever change"
- "the only thing it will ever write back"
- "the one thing it will ever change in home assistant"
- "it can change exactly one thing in your house"
- "absent from the code entirely"
- "there is no code here that can do any of them"
- "no code in this application that can do any of them"
- "give away your indoor temperature and tick something off your shopping list"

Their replacements say "today" of the to-do tick, "not built yet" of the
controls, and "never" only of what no row in the table can reach.

## 12. Phases

1. **The boundary only — built.** The table (`modules/homeassistant/services.ts`),
   `buildCall`, the door's run-time check that a call was issued, the rewritten
   `ha-write-boundary.test.ts`, the claims, and migration `0056` with two of the
   three switches as unread columns (`screens.allow_control`,
   `ha_entity_cache.controllable`). Nothing is drawable and no wall can press
   anything. `weather.get_forecasts` is a row with no caller until M5.8.
   **One deviation, deliberate:** the widget's `tapAction` key moves to phase 2.
   A widget key nothing reads is an option that does nothing, and the e-paper
   honours tables, which are closed against the widget schema and proved by
   rendering, would have to describe a behaviour that does not exist yet.
2. **Toggles**: lights, switches, fans — **built.** `POST /d/ha/act` over
   `operate` (`modules/homeassistant/control.ts`), which runs §8.2's checks in
   order; the reading's `actions` and the screen's `allowControl` in the
   manifest, both spread only when on; the same element made a `<button>` with
   the same rectangle, list and tile alike; the widget's `tapAction`, in
   `PANEL_IGNORES`; "Can be controlled from walls" and its why-not sentences
   on the Readings screen; the wall's "Allow operating things in the house";
   migration `0057`'s `ha_wall_actions`, fourteen days, on the Readings screen
   only. Held by `ha-act.test.ts` (23, against the fake house over a socket)
   and `browser-ha-act.test.ts` (5, a real paired wall and the real editor);
   33 mutations checked, all red. **Three things to know.** Step 6's 409 —
   "can't be operated any more" — cannot fire for a toggle, whose eligibility
   is its domain alone; it is there for phase 3, where a light's colour modes
   can change between marking and pressing, and is untested until then. The
   reset of `controllable` on removal was written and deleted: a removed
   reading's row is gone unless a rule keeps it, and re-adding is what resets
   the kept one, so the line protected nothing and a mutation said so. And a
   ring assertion on `outline-width` alone passed with the `:focus` half of the
   rule deleted, because this browser reports the initial `medium` (3px) for an
   outline whose style is `none`; it asserts the style too.
3. **Brightness, colour, position and fan speed**, with the panel — **built.**
   The route takes `value` (a number, or three for a colour), shaped by
   `valueFor` and bounded by `buildCall` against the light's own range; the
   wall's words are `brightness`, `colour`, `colour_temp`, `speed`, `open`,
   `close`, `stop` and `position`, and `wallActionsFor` offers a value word
   where the door would refuse it only for want of a value. The cache's
   attribute allowlist gained the control facts and nothing else
   (`supported_color_modes`, the kelvin range and current white,
   `supported_features` for fans and covers, `percentage_step`) — `rgb_color`
   is still refused. The manifest carries `kelvin` and `step` only beside the
   word that uses them. **Four decisions the RFC left open, taken here.** A
   cover's open, close and stop came with position, because a blind has no
   toggle and a panel that could set a position and not open it would be
   strange; they were phase 1 rows already. A reading with any word but a
   lone toggle **opens its panel on a press** rather than switching —
   Lovelace splits the tile into an icon that toggles and a body that opens,
   and a wall has no hover to say which half is which, so the safer press
   wins and the panel's first control is the switch. Colour is **eight named
   swatches**, not a picker: a picker is a drag that streams and starts from a
   current colour the wall is never sent. And the panel **closes itself after
   45 seconds untouched**, because a wall has no pointer and a panel left over
   the calendar is a calendar nobody can read. The panel is drawn from model
   state beside the canvas, never in it; a finger on a slider holds the
   fifteen-second redraw until it lifts; a slider sends on `change`, once.
   Step 6's 409 is reached now — a light narrowed to on/off is refused a
   dimmer and keeps its switch, and the flag is cleared only when nothing a
   wall could do is left. Held by `ha-act.test.ts` (33) and
   `browser-ha-panel.test.ts` (5); 22 mutations checked, all red.
4. **Scenes and scripts**, with press-and-hold — **built.** Scenes and scripts
   became watchable readings: a scene reads "Scene" and a script "Ready" or
   "Running", so neither moves the manifest with the clock. The word is `run`,
   with no value ever. The wall asks for a hold of 600 ms, by a finger or by
   holding the OK key, with a still ring while held — still rather than
   filling, because an animation must sit inside reduced motion and the wall's
   Motion switch, and a hold that showed nothing with motion off would look
   ignored. A shorter press sends nothing and says "Press and hold to run it."
   The hold outlives the fifteen-second rebuild. §7.3's warnings are shown
   beside a scene's and a script's switch verbatim, and the switch's own
   warning is now §7.3's wording too. The scene check and the script qualifier
   are §3.3. Held by `ha-act.test.ts`, `ha-claims.test.ts` and `browser-ha-hold.test.ts`; 18
   mutations checked, all red. Two were green at first: a tap running a scene
   (the test stopped at the first run and could not see a second) and Enter
   clicking at once (a `preventDefault` the click guard already made
   redundant, now deleted).
5. **Webhook buttons** — **built.** Two decisions the RFC left open were the
   owner's (2026-10-05): a webhook button is drawn by **a new Buttons widget**,
   not inside the Home Assistant widget, so a household with no Home Assistant
   can still have one; and **all three switches apply** — the wall's, the
   button's "Can be pressed from walls", and the widget's Tap to operate, as
   §9 says. Targets live on a new **Buttons** admin screen (`webhook_targets`,
   migration `0058`); the address is sealed (`webhook-url`), as is an optional
   header's value (`webhook-secret`), and only the host is shown again. A press
   is `POST /d/buttons/press` with the button's id and widget, and sends an
   empty POST through the fetcher with the target's own network opt-ins (its
   LAN switch covers this machine too, as the Home Assistant connection's
   does), never following a redirect, sharing the wall's twenty presses a
   minute. Held for 600 ms like a scene. History shares `ha_wall_actions` as
   `webhook:<id>`, listed on Buttons. A path under `/api/webhook/` carries the
   script warning, and the "never" claims — Rule 12's last clause included —
   now say "unless a script or a webhook button you allowed does", the §3.3
   decision carried to the thing §9 calls a script by another name. 19
   mutations checked, all red (one of them a body on the webhook POST, which
   `ha-write-boundary.test.ts` now allows exactly once and bodiless); two were green and were dead code: the press
   modules' own copy of the wall's switch, which the route checks first (phase
   2's `operate` had the same, also removed), and a "no panel" branch the
   module registry never reaches.
6. **Media transport**: play/pause, next, previous and volume, for the
   now-playing card (M6.9) — **built.** Media players became watchable
   readings that say what the player is doing ("Playing", "Paused") and never
   what it plays: the attribute allowlist keeps `supported_features` and
   `volume_level` and refuses the title, the artist and the picture, which
   `homeassistant.test.ts` holds by putting a track in the fixture and the
   player in the watched list. The words are `play_pause`, `next`, `previous`
   and `volume`, each eligible by the player's own features, and they open
   phase 3's panel — Previous, Play or Pause by the player's state, Next, and
   a volume slider starting at the player's own volume, carried as `volume`
   only beside its slider. The wall's 0–100 reaches Home Assistant as
   `volume_level` 0.0–1.0 (§13). With nothing left for a later wall phase,
   the Readings screen's "Walls cannot operate this yet" sentence and its list
   are deleted rather than left empty. 10 mutations checked, all red; one
   proved nothing as first written (an allowlist key that was not the title)
   and was replaced by one that caches a player's raw attributes.

`todo.add_item` is not a wall phase. Its row landed with phase 1's table, and
the companion API's list endpoint (plan items M2.1–M2.2) is its one caller:
`POST /companion/todo/add`, behind a per-account companion token, never a
display token. `addTodoItem` in `modules/todo/index.ts` is the one function
that builds the call, and it re-reads the list's state first, so a list whose
`supported_features` lacks `CREATE_TODO_ITEM` is refused with a sentence
before Home Assistant is asked. It reaches only a list on the To-do lists
screen, by its name or entity id; an entity the household never added is a
404. `ha-write-boundary.test.ts` holds both halves in the source: `addTodoItem`
is the only builder of a `todo.add` call, and `http/companion.ts`, which has
no `/d/` route in it, is its only caller. The token is sealed at rest beside
its hash, redacted from every log line by its `mwc_` prefix, and rate limited
twice — twenty wrong tokens per address in five minutes, thirty calls per
account a minute. 27 mutations checked, all red; one proved nothing as first
written (it named `addTodoItem` without calling it) and was replaced by a
real call from a wall route.

## 13. How this gets proven

- **The table.** `ha-write-boundary.test.ts` asserts the table row by row,
  including data keys; that it is frozen; that `callService` is still the only
  caller of `postJson`; and that `buildCall` is the only constructor.
- **The refusal matrix.** Every domain in §5.1 times every wall action, against
  a fake Home Assistant: no request leaves. A cover with `device_class` unset,
  `window` and `garage` is refused. A light whose `device_class` or colour modes
  change between marking and pressing is refused at step 6.
- **The runtime.** A fake Home Assistant records every path and body posted; a
  wall pressing each permitted action posts exactly the table's row and one
  `entity_id`, and nothing else ever.
- **The switches.** Each of the three, turned off alone, refuses the press with
  its own sentence.
- **The values.** Each bounded value at and just past its bounds: brightness,
  colour, position, fan speed, and volume, whose 0–100 must reach Home
  Assistant as `volume_level` 0.0–1.0.
- **The add.** `todo.add_item` reachable through the companion-token route and
  refused from every `/d/*` route; refused for a list without the create
  feature; its text capped and stripped.
- **The manifest.** No entity id anywhere with controls on, in both
  orientations and on a named layout; a household with nothing turned on keeps
  a byte-identical manifest and ETag.
- **A real wall.** A browser test pairs a wall, taps a fake light, reads the new
  state off the tile after the re-poll, holds a script button, and reads a
  failure sentence when the fake answers 502. Measured by the computed state of
  the tile, never a class.
- **Mutations.** Each check in §8.2 removed in turn turns at least one test red;
  `homeassistant.toggle` added to the table turns the matrix red; `area_id`
  accepted turns it red; `actions` emitted on a panel turns `epaper-ink` red.
- **The claims.** A fresh search of household-facing text for "write",
  "control", "tick", "garage" and "door" before merge, and its result in the PR.

## 14. Open questions

All ten were decided by the owner on 2026-10-05: OQ1–OQ5 are the §5.2 items,
and OQ6–OQ10 took the defaults this RFC proposed. None is open.

| ID | Question | Decision |
| --- | --- | --- |
| OQ1 | §5.2: media transport | **Decided:** included, phase 6. |
| OQ2 | §5.2: `todo.add_item` from the companion API | **Decided:** included, companion API only. |
| OQ3 | §5.2: fan speed | **Decided:** included, phase 3. |
| OQ4 | §5.2: `input_boolean` | **Decided:** excluded. |
| OQ5 | §5.2: climate setpoints | **Decided:** excluded. |
| OQ6 | Press-and-hold or a two-step confirm for scenes, scripts and webhooks? | **Decided:** press-and-hold, 600 ms. |
| OQ7 | Rate limits | **Decided:** 20 presses a minute per wall; one in flight per entity. |
| OQ8 | Audit retention | **Decided:** 14 days, admin only. |
| OQ9 | Listing persistent notifications needs the WebSocket API. | **Decided:** build the dismiss row only when a WebSocket client exists; until then M6.11 ships rule-based tiles only. |
| OQ10 | Should a signed-in admin be able to test a control from the editor? | **Decided:** yes, through the same route and checks, with the session standing in for the wall switch only. |

## 15. Non-goals

- Locks, alarms, and garage, gate, door and window covers, at any time, under
  any switch.
- Free-form service calls or service data from a wall, as Magic Frame's Buttons
  widget allows.
- Automations triggered by name, or toggled on and off.
- Control from an e-paper panel.
- Making views public. A wall still needs its pairing.

## Appendix A — the `CLAUDE.md` diff

**Done on acceptance (2026-10-05):** hard rule 12 replaced with §3.1's text,
and a note placed above the "Current state" paragraph "Home Assistant writes go
through one door two services wide" saying the rule moved and the code has not
yet.

**Done with phase 1:** replace that paragraph with one that names the table, the
three switches and `buildCall`, and keeps its last sentence's meaning: the blast
radius of a compromised wall tablet is what the household marked, and never a
lock, an alarm or the garage. The paragraph describes code, so it changes when
the code does.

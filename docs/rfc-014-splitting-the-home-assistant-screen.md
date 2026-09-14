# RFC 014 — Splitting the Home Assistant screen

Status: **implemented** · Owner: — · First drafted 2026-09-13 ·
Revised 2026-09-13 · Implemented 2026-09-14 ·
Relates to `apps/server/src/http/admin-ha.ts`,
`apps/server/src/http/components.ts`, `apps/server/src/http/saved.ts`,
`apps/server/src/http/html.ts` · Builds on the component layer and the
confirmation strip (RFC 009 phases 3 and 10A/10B) · Constrains nothing ·
Amends no hard rule

## 1. Summary

`/admin/home-assistant` is one page doing five unrelated jobs. Counted from
`admin-ha.ts` rather than estimated: **eight top-level blocks**, of which four
are add-forms that are permanently expanded, and **nineteen form controls on
screen before a household touches anything** (counting the entity picker's
`<noscript>` fallback as its three). The two tallest
blocks are the two a household reads exactly once — the Connect form and the
boundary card — and both are drawn on every visit for ever. The rule builder is
eight fields and two explanatory paragraphs, and it sits *below* the three
templates whose whole purpose is to fill it in.

This RFC proposes **a hub and five screens**: `/admin/home-assistant` becomes a
landing page that answers three questions — is it connected, what is it putting
on the wall, and what can it do to your house — and each subject moves to a
route of its own, reached by a `listRow` and returned from by `pageHeader`'s
back crumb.

**The feature set does not change.** Nothing is removed, no schema moves, no
manifest field moves, and the display is not touched. This is a routing and
composition change in one file plus its tests.

**The honest alternative is smaller and was considered first.** Folding each
add-form behind the existing `.disclose` idiom (`html.ts:746`, already used for
"Network access" on the calendar screens) removes most of the length for a
fraction of the diff, adds no route, and needs no new test file. It is written
up in §3.1 as the rejected option, and it remains the right change if this one
is judged too large. It is **not** a first phase of this one: §7 records why
the plan that sequenced them that way was collapsed — the split removes the
disclosures again, so shipping them first is work done twice and, on the
sub-screens, a fold over the one form the page exists for.

> **Implemented, and three things in this document were wrong in ways worth
> keeping rather than editing away.**
>
> **The exit count is forty, not thirty-eight.** §5.7 says eighteen
> `render(…, 400)` sites and the brief for the implementation said sixteen.
> Counted from the file, it is eighteen: five on `…/connect`, two on
> `…/entities`, three on `…/calendars`, six on `…/lists` and two on `…/rules`.
> Sixteen is a defensible number for a reason the table did not have a column
> for — two of the eighteen come back on a screen whose *form* is not drawn,
> because in both the state that reaches the branch is the state that empties
> it (the eight-list refusal, and a calendar already added). Those two assert
> the screen's own identity instead, and say so at the row.
>
> **The hub was 77px *worse* than the page it replaced** on the measurement §8
> asks for, until the reason turned up: `statusReadings` drew "Readable
> entities" and "Calendars" in the status card while §5.3 had just put those
> same two live numbers on the Readings and Calendars rows underneath. Two
> readers of one fact, side by side on one page, and 165px of preamble above
> the first row. The status card keeps Host and Last read — the two facts the
> rows cannot carry — and the hub goes 432px → 340px against the old page's
> 355px.
>
> **§4.3's Calendars list wanted one section, not two.** Drawn as the RFC
> describes it — a list section above an add section — the add form landed
> 454px down a screen whose whole content is that form. It is one `section`
> holding the list and then the form, which is `todoLists`' own shape one
> subject along; 240px. And with nothing added it draws no empty state at all,
> because a box reading "none yet" directly above the form that adds one is the
> shape `admin-saved.test.ts` already caught once on this family.

The load-bearing finding is in §5.1, and it is the kind of thing that only
turns up by reading the file rather than the screen: **every one of this
screen's twenty-two exits names one destination.** Eleven are `savedRedirect`
calls, seven are bare `c.redirect('/admin/home-assistant', 302)` and four are
`confirmDestroyPage` `cancelAction`s. Splitting the screen without splitting
them puts every confirmation strip, every not-found bounce and every Cancel on
a page the household is no longer standing on — which is RFC 009's own rule ("a
token is a claim, so check the branch it is on") failing in a new way.

**The first draft of this document counted eleven of the twenty-two, and §5.7
is the count it missed entirely.** The eleven it found are the ones that carry
a token, which is to say the ones that are easy to `grep` for. The other eleven
are exits with no token on them, and under them sit **eighteen** `render(c,
error, 400)` sites that do not redirect at all — they rebuild the whole page
under an `errorBlock`, which after a split is the one failure mode that leaves
a household on a URL with their own form gone from under them. Recorded here
rather than quietly fixed in the table, because the under-count is the more
useful finding: an exit without a token is still an exit.

## 2. What the screen is today

`haPage` composes, in order:

| # | Block | Drawn when | Roughly |
|---|---|---|---|
| 1 | `errorBlock` | on a 400 | one strip |
| 2 | `status()` — heading, four-row `dataTable`, Disconnect, consequence hint | always | a card |
| 3 | `connectionForm()` — address, token, two checkboxes, Connect | unless supervisor | a section, 4 controls |
| 4 | `boundary()` — heading, four bullets, a hint | always | a card, ~90 words of prose |
| 5 | `readings()` — "On the wall", a card per watched entity | connected | a section |
| 6 | `readings()` — "Add readings", the picker + `<noscript>` fallback | connected | a section, 3 controls |
| 7 | `calendars()` — select, name, Add | connected | a section, 2 controls |
| 8 | `todoLists()` — rows, then add form | connected | a section, 2 controls |
| 9 | `rules()` — rule cards, 3 template rows, the builder | connected | a section, 8 controls |

Three things about that table are the argument.

**The page is sized for its rarest task.** Adding a reading, a calendar, a list
or a rule is a thing a household does a handful of times ever. Reading the page
— "is it still connected, what is on the wall" — is the thing they do every
other time. The rare task is permanently expanded and the common one is what
they scroll past it to reach.

**Two sections are one subject split by mechanism.** "On the wall" and "Add
readings" are separated because the second is a scripted picker and the first
is a list. That is a fact about how the code is built, not about what a
household is thinking about — the same mistake RFC 009's nav grouping records
and fixes ("the grouping is by what a household is thinking about, not by what
the code is").

**The builder is below its own templates.** `RULE_TEMPLATES` renders three
`listRow`s whose entire effect is to re-render the form beneath them with
fields filled in. On a phone the form is off-screen when the template is
tapped, so the thing that just happened is invisible.

There is a fourth, smaller one worth recording because it is the only part of
this that is a missing feature rather than a layout fault: **the Calendars
section has no list.** It offers a form and, when every calendar has been
added, an `emptyState` saying so. Which Home Assistant calendars are actually
on the wall is a question this screen cannot answer; a household has to leave
for `/admin/calendars` to find out. §4.3 adds the list and §9 flags it as the
one net-new thing here.

## 3. The decision

### 3.1 Why routes, and not tabs or disclosure

Three shapes were considered.

**Disclosure.** Fold each add-form behind `<details class="disclose">`, keep
the lists open, keep one URL. Cheapest by a wide margin: no route, no new
template, no redirect change, no new test file, and the idiom already exists
and is already used on the calendar screens. It removes most of the height.
What it does not remove is the *subject count* — a phone still scrolls past
readings, calendars and to-do lists to reach a rule, because all four are still
one document.

**Tabs.** A segmented control over one route, the way the wall editor splits
Layout from Wall settings (RFC 009 phase 5). Rejected for a specific reason
rather than on taste: the editor's tabs are script-driven, and these pages are
not. A script-free tab is either a `<details>` per panel — which is the
disclosure option wearing a different label — or five full page loads behind
one URL with a query parameter, which is five routes with a worse address.

**Routes.** One screen per subject. Chosen, and the argument is that this
repository has already made this call twice and both precedents hold:
`/admin/walls/:id` for a wall, and `/admin/shifts/types` for shift types. In
both the parent is a list and the child is a job. Here the parent is a status
page and the children are four jobs, which is the same shape.

The cost is real and is stated rather than discounted: **five new routes and
five page functions to keep**, against one page nobody can hold in their head.
`admin-ha.ts` is 1,388 lines today; this does not shrink it much, it divides
it.

### 3.2 The route table

Existing routes are unchanged in method and body. What changes is which page
they render and where they redirect.

| Route | Is | Today |
|---|---|---|
| `/admin/home-assistant` | the hub | the whole screen |
| `/admin/home-assistant/connection` | address, token, network access, Disconnect | §3 and §2 of the page |
| `/admin/home-assistant/readings` | watched entities + the picker | §5 and §6 |
| `/admin/home-assistant/calendars` | added HA calendars + add | §7 |
| `/admin/home-assistant/lists` | watched to-do lists + add | §8 |
| `/admin/home-assistant/alerts` | rules, templates, the builder | §9 |

`/admin/home-assistant/lists` already exists as a **POST**. Adding a GET at the
same path is correct and is the shape every other sub-screen here has
(`/admin/shifts/types` is a GET and a POST); it is called out because a reader
scanning the route list will see `lists` twice and should not "fix" it.

Every POST keeps its path. The only reason to move one would be tidiness, and
a household with a page open across the upgrade would have its next submission
404 — rule nine, in the form it takes in an admin rather than on a wall.

**`?template=` is the one query this screen has, and the hub answers it with a
302.** The template rows render `href="admin/home-assistant?template=<key>"`
(`admin-ha.ts:1289`) and the GET picks the form's starting values out of
`c.req.query('template')` (`admin-ha.ts:316`). §4.5 moves the builder to
`…/alerts`, so the rows must link there — a template row whose whole effect is
to fill in a form on another screen is the off-screen-form fault of §2 made
worse by a page load. But a link already in the world is a contract, and this
one is the *entire* interface the feature has: it is what makes a template
script-free, and a household who bookmarked one, or a page left open across the
upgrade, must not meet a hub that silently ignores the query. So the rows link
to `admin/home-assistant/alerts?template=<key>`, and
`GET /admin/home-assistant?template=<key>` answers **302 to
`…/alerts?template=<key>`**, carrying the query through unaltered. A bare hub
GET is unchanged, and no POST moves.

This resolves a contradiction in the first draft of this document, which said
here that the hub keeps the query and in §4.5 that `?template=` "keeps working
exactly as it does" on a screen it had just moved the form off. Both could not
be true.

`homeassistant.test.ts:783–794` pins today's behaviour in both halves — the
listing contains `href="admin/home-assistant?template=garage"`, and following
it renders `value="Garage door open late"` with the window prefilled — so it
changes with this: the href assertion names the new path, and the render
assertion asserts the 302 and then follows it. That is a test changed because
the behaviour it pins moved, which is not the same as one weakened to fit, and
it is named here so a reviewer does not have to decide which it is.

`nav` stays `'homeassistant'` on all six, so the sidebar marks Integrations ›
Home Assistant active throughout; `pageHeader`'s `back` carries
`{ label: 'Home Assistant', href: 'admin/home-assistant' }` on the five
children. That is the *whole* back affordance: a nested page adds no header of
its own and in particular no second hamburger, which is `pageHeader`'s own
documented rule and the reason it owns this decision.

### 3.3 The hub

Three blocks, and nothing else:

1. **The status card.** `status()` as it is today, minus the Disconnect and its
   consequence hint, which move to Connection. A household reading "is it
   working" should not have the irreversible action under their thumb.
2. **A section of five `listRow`s** — Readings, Calendars, To-do lists, Tell me
   when…, Connection and token — each with `href`, a `detail` naming what is
   there in words, and a `tag` carrying the count. The counts are the thing the
   current page makes you scroll to find. **Which count is not one question
   with one answer**: four rows carry a count of what the household has set up,
   read from this database, and two carry a second count of what the house
   currently offers, read from the house. §5.3 is the table and the reason.
3. **The boundary card**, unchanged in wording. §5.4 explains why it stays on
   the hub and cannot simply follow the token to Connection.

No new component. A hub of labelled rows with counts is exactly `listRow` with
`href` and a trailing `tag`, which is what that component is for, and the
CLAUDE.md rule against inventing a ninth component is not in play.

**All five rows are drawn whether or not Home Assistant is connected, and under
the supervisor too.** That settles the fourth open decision in §9, and it is
settled by a measurement rather than on taste. `admin-vocabulary.test.ts`
reaches a page by *crawling* `href` and `action` attributes out of the markup,
starting at `/admin` and queueing what it finds; its own docblock names the
blind spot it already has — "the Home Assistant page renders more once a
connection exists (there is no fake HA here)" — and its fixture never connects
one. So a hub that drew these rows only when `connected` would leave all five
new routes with nothing linking to them, and §8's claim that the sweep picks up
new screens automatically would be false on the exact five screens this RFC
adds. A vocabulary sweep that silently covers less than it did before is the
worst of the three outcomes, because nothing about it fails.

What an unconnected sub-screen draws is therefore an `emptyState`: one sentence
saying Home Assistant is not connected and a link to Connection, which is the
shape `emptyState` is for. That is also better copy than a row that disappears,
for the reason §4.1 already gives about the supervisor — a row that is not
drawn reads as a broken link to a household who remembers it being there — and
it is what makes drawing the row unconditionally honest rather than merely
convenient for a test.

## 4. What moves, screen by screen

### 4.1 Connection

`connectionForm()`, the two network-access checkboxes, `destructive('Disconnect', …)`
and `HA_DISCONNECT_CONSEQUENCE`. Under the supervisor the form is not drawn
(`live.mode === 'supervisor'`), and the screen says so rather than rendering
empty — today that branch simply omits the section, which is fine inside a long
page and reads as a broken link when the row is the only reason you navigated.

**The row on the hub must therefore say something true under the supervisor.**
"Address, token and network access" is a lie on an add-on where there is no
token to manage. The row's `detail` is computed from `live.mode`, and the
supervisor case says so.

### 4.2 Readings

The two sections become one screen: the watched list, then the picker. The
`<noscript>` datalist fallback comes with it unchanged.

The hand-built Remove form stays hand-built. `destructive()` cannot express it
— the target is `?entity_id=…`, a query parameter, and `destructive()`'s form
carries no hidden fields, so a GET form with no fields serialises the query
away on submission. That is recorded at the call site already and is repeated
here because a split is exactly the moment somebody "tidies" it into the
component.

### 4.3 Calendars

Gains the list it does not have: a `listRow` per `calendar_sources` row with
`kind = 'homeassistant'`, each linking to `/admin/calendars` where it is
actually configured, plus the add form. This is the one net-new thing in this
RFC and §9 keeps it as an open decision rather than smuggling it in, with the
shape it would take written out there so the decision is about a thing rather
than about an idea.

`savedRedirect(c, '/admin/calendars', 'ha-calendar-added')` is the one redirect
on this screen that already leaves for another section, and it stays that way:
a calendar's home is the Calendars page, and this screen is a shortcut into it.

### 4.4 To-do lists

Moves whole. `listRowFor`, the reorder items, `destructive()`, the add form,
the `MAX_WATCHED_LISTS` refusal and the sentence about `allow_todo` living on
the wall's own page (RFC 012 §7.6) all travel unchanged.

### 4.5 Tell me when…

Moves whole, and is the screen that gains most from the move. The order becomes
rules → templates → builder, with the templates *above* the form they fill in
rather than above a form that is off-screen. `?template=<key>` keeps its
meaning and changes its address: the rows link to
`admin/home-assistant/alerts?template=<key>`, and the hub redirects an old
`admin/home-assistant?template=<key>` here with the query intact (§3.2). It is
still a query parameter and still not a script, and it now re-renders a page
whose form is visible when it lands — which was the point of moving it.

With a page to itself the builder's three time-and-action fields fit one
`.row-fields` row instead of stacking, which is a consequence of the room
rather than a design change.

## 5. The seams that break

This is the section worth reading twice. Everything above is placement.

### 5.1 Every exit names one destination

**Twenty-two exits, and the first count of them found eleven.** The eleven are
the `savedRedirect` calls, which are the ones with a token on them and so the
ones a `grep` finds. The other eleven carry no token and are exits in the only
sense that matters: a household following one lands on a page somebody chose.
Ten of the eleven tokened ones name `/admin/home-assistant`, and so do all
seven bare redirects and all four Cancels.

Split the screen and every one of those lands the household on the hub after
something they did on a sub-screen. Worse, it is silent: the redirect works,
the token is valid, the sentence is true. Nothing fails. A household adds a
reading and finds themselves back at the top with "Reading added." over a list
of five rows, and has to navigate back in to add a second.

Each exit goes to the screen its action belongs to.

**The eleven `savedRedirect` calls:**

| Token | Line | Goes to |
|---|---|---|
| `ha-connected` | 443 | `…/connection` |
| `ha-disconnected` | 474 | **the hub** — see below |
| `ha-entity-added` | 508 | `…/readings` |
| `ha-entity-removed` | 583 | `…/readings` |
| `ha-calendar-added` | 604 | `/admin/calendars` (unchanged) |
| `todo-list-added` | 661 | `…/lists` |
| `todo-list-removed` | 700 | `…/lists` |
| `order-saved` | 709 | `…/lists` |
| `ha-rule-added` | 768 | `…/alerts` |
| `ha-rule-removed` | 797 | `…/alerts` |
| `ha-rule-updated` | 804 | `…/alerts` |

**The seven bare `c.redirect('/admin/home-assistant', 302)` calls**, every one
of them a "that thing is not there" branch:

| Line | In | The branch |  Goes to |
|---|---|---|---|
| 455 | `GET …/disconnect` | no stored token, so there is nothing to disconnect | `…/connection` |
| 559 | `GET …/entities/remove` | the entity id did not shape | `…/readings` |
| 562 | `GET …/entities/remove` | no watched row by that id | `…/readings` |
| 673 | `GET …/lists/:entity/remove` | no watched list by that id | `…/lists` |
| 698 | `POST …/lists/:entity/remove` | the list is not one that is watched | `…/lists` |
| 707 | `POST …/lists/:entity/move` | the direction was neither `up` nor `down` | `…/lists` |
| 779 | `GET …/rules/:id/delete` | no rule by that id | `…/alerts` |

**These stay tokenless, and that is a decision rather than an omission.** Each
one fires when the thing named in the URL is not there — a double-tapped
Remove, a stale tab, a hand-typed id. Nothing happened, so there is nothing for
a strip to claim, and adding one would be RFC 009's own rule broken in the
direction that file records: "a handler with an early return, a skip or a
nothing-to-do path needs a different token or none." What changes here is only
*where* they land, and landing on the sub-screen is what makes them legible at
all — a bounce to the hub after pressing Remove twice reads as the button
having thrown the household out of the screen.

**The four `confirmDestroyPage` Cancels:**

| Confirm page | Line | Cancel goes to |
|---|---|---|
| Disconnect Home Assistant | 466 | `…/connection` |
| Remove reading | 574 | `…/readings` |
| Remove to-do list | 687 | `…/lists` |
| Delete rule | 790 | `…/alerts` |

**Cancel returns the household to the screen they came from**, which is the
screen the row they pressed lives on and is never the hub. A Cancel that moves
you is not a cancel.

**`ha-disconnected` is the exception and it is not a detail.** After
disconnecting there is no connection, so the Connection screen has nothing to
show and the four sub-screens have nothing in them. It goes to the **hub**,
which is the one page that is still true. A redirect back to `…/connection`
would leave a household on a page whose whole subject has just been deleted.

**Disconnect's Cancel is the opposite exception, and the pair is worth reading
together.** Cancelling a disconnect changes nothing, so the connection still
exists and Connection is still the true page — it goes there, while the token
for the disconnect that actually happened goes to the hub. One screen, two
exits from one confirmation page, in two directions, because what decides the
destination is what is true afterwards rather than which page the form was on.

`order-saved` is shared across every screen with an Up/Down control, so its
*sentence* stays shared and only this screen's call sites move. That is the
distinction the token table already draws and it survives the split.

### 5.2 The back crumb exists twice, done two ways

`pageHeader`'s `back` is used by `admin-chores.ts:267`, `admin-epaper.ts` in
three places and `admin.ts:4972`. `admin-shifts.ts`'s `typesPage` — the closest
precedent to what this RFC builds — instead emits
`<p><a class="link" href="admin/shifts">← Work Schedule</a></p>` as the first
thing in the body.

Both render an arrow and a label. Only one of them puts it in the app bar,
where `pageHeader` decided it goes, and only one of them survives a household
scrolling down a long page, because the app bar is sticky and a paragraph at
the top of the body is not.

**The five new screens use `pageHeader`'s `back`.** Fixing `typesPage` to match
is not in scope and is filed in §9 — it is a two-line change on a screen this
RFC does not otherwise touch, and bundling it would make the diff lie about
what it is.

### 5.3 `look()` fetches everything, for every screen

`render()` calls `look()` on every request, which issues `GET /states` and
`GET /calendars` against Home Assistant. On a household with 412 entities that
is the right cost for a page that draws an entity picker and a calendar select
and a rule entity list. It is the wrong cost for the hub, which needs counts,
and for the to-do screen, which needs `todo.*` alone.

The RFC does **not** propose splitting `look()` into per-screen fetches, and
the reason is worth stating so nobody optimises it later by accident: the two
*live* counts on the hub are readings of the house, and a hub that cached them
would answer a different question from the screen it links to. Two readers of
one fact disagreeing is this project's most repeated bug.

**Which count each row carries is the part that needed deciding, and it is not
one rule for all five rows.** A count of what the household has set up is a
read of this database; a count of what their house currently offers is a read
of the house. Conflating them is what makes a count wrong in the one situation
a household consults it.

| Hub row | Count | Read from |
|---|---|---|
| Readings | watched entities | `readWatched(db)`, `watched === 1` |
| Calendars | Home Assistant calendars added | `haCalendarEntityIds(db)` |
| To-do lists | watched lists | `readTodoLists(db)` |
| Tell me when… | rules | `readRuleRows(db)` |
| Connection and token | none | `live.mode` decides the `detail` (§4.1) |

Every one of those is stored, and every one of them is a number this process
wrote. **Two live counts sit beside two of them rather than replacing them**,
and only two: "412 readable entities" on Readings and "4 calendars in Home
Assistant" on Calendars. Both exist because "3 added" does not answer "of how
many", which is the question a household opens those rows to ask. No live count
is offered for to-do lists or rules, because there is no second number there a
household is asking about.

**Under `live.problem` a live count is not zero, it is unknown**, and this is
the trap the split most invites. Both of `look()`'s failure branches return
`entities: []`, `calendars: []` and `todo: []` *alongside* the problem
(`admin-ha.ts:241–254` and `260–266`), so a row computing
`live.entities.length` draws "0 readable entities" for a household whose house
is merely unreachable — a false statement about their home, in the one place
they went to find out what was wrong, rendered in the register of a fact. The
row shows the problem instead, and never "0". The four stored counts are
unaffected by an unreachable house and draw exactly as they always do, which is
the property named in the next paragraph arriving one row earlier than
expected.

What it does propose is that the **failure** path stays as it is: `look()` is
built around being allowed to fail, and an unreachable Home Assistant must
still render every stored setting on every one of the six screens, so a
household can fix an address they typed wrong. That property is load-bearing
and is the thing a split is most likely to break, because five new page
functions are five new chances to read `live.entities` without checking
`live.problem`.

### 5.4 The boundary card stays on the hub

The obvious move is to put it on Connection, next to the token it is about.
Two things forbid it, and the first is a test that is already right.

`ha-claims.test.ts` renders **the served `/admin/home-assistant`** through the
real app with a real session and asserts in both directions: the five retired
sentences are absent, *and* the page names `todo.update_item`, says "to-do
list", and carries "No switches, no scenes". Moving the card to a sub-screen
turns those three positive assertions red immediately. That is the correct
behaviour and it is worth saying plainly rather than treating the test as an
obstacle: the file was built to make exactly this decision cost a deliberate
edit, and it does.

So the constraint is real but it is not the argument. The argument is in the
card's own docblock, and it is about *when* it is read: "before the form, not
after it, because it is the thing that decides whether pasting a token here is
a reasonable thing to do". A household who has not connected yet lands on the
hub. Putting the boundary one click further in means the first screen they see
no longer says what this costs — and under the supervisor, where there is no
token to paste and the Connection row says so, it would be behind a link they
have no reason to follow at all.

So: the card stays on the hub, and `ha-claims.test.ts` keeps pointing at
`/admin/home-assistant` unchanged. A reviewer who finds that file in the diff
should read this section before accepting it.

### 5.5 `homeassistant.test.ts` asserts the boundary copy verbatim

RFC 012's Appendix A item (5) records that this screen's boundary wording is
asserted by `apps/server/test/homeassistant.test.ts`. That assertion is
unaffected by this RFC as long as §5.4 holds, and is named here so a reader
knows the card has two tests on it and not one.

### 5.6 The picker mounts a script by id

`readings()` emits `<div id="ha-entity-picker" data-entities="…">` and
`<script type="module" src="assets/ha-entity-picker.js">`. The script mounts on
that id. Moving the div to another route moves the mount with it and nothing
breaks — but the script tag must move too, and a page that ships the script
without the div, or the div without the script, fails in the way `<noscript>`
fallbacks are designed to hide: the datalist form is not rendered when script
is available, so the screen would show a heading and nothing under it.

An assertion that the readings screen serves both, and that no other screen
serves either, is cheap and is in §8.

### 5.7 The 400 path re-renders the whole page, eighteen times

A refusal on this screen is not a strip drawn over the form. `render(c, error,
400)` rebuilds `haPage` from the top with an `errorBlock` above it, and there
are **eighteen** such sites — counted from the file rather than estimated, and
attributed to the route they sit in:

| Route | Sites | What each one refuses |
|---|---|---|
| `POST …/connect` | 5 — 334, 352, 366, 407, 434 | the address's shape; an unencrypted address; a missing token; a connection that would not resolve; one that would not answer |
| `POST …/entities` | 2 — 480, 484 | the body's shape; a domain this cannot watch |
| `POST …/calendars` | 3 — 589, 592, 595 | the body's shape; a non-`calendar.` id; one already added |
| `POST …/lists` | 6 — 620, 623, 628, 631, 646, 653 | the body's shape; a non-`todo.` id; `live.problem`; a list Home Assistant does not have; the write itself; a list added but unreadable |
| `POST …/rules` | 2 — 716, 722 | the body's shape; an entity outside the watchable set |

**After the split each must re-render the sub-screen its form lives on**, and
this is a sharper requirement than the redirect table above it, because a 400
is not a redirect. The browser stays on the POST URL and renders whatever comes
back — so a site left pointing at `haPage` puts "Paste a long-lived access
token." above a hub with no token field anywhere on it, and the only route back
to the field the sentence is about is a link the household has to find. A
misrouted redirect costs a navigation; a misrouted 400 costs the form.

Two of the eighteen are worth naming individually. `POST …/lists` line **653**
is a 400 whose message begins "Added, but the list could not be read" — the
write succeeded and the status is still a refusal, which is a call taken at
that site and not this RFC's to revisit; what it means here is that this one
must re-render `…/lists` *with the new row already on it*, so the page
contradicts neither itself nor the database. And `POST …/lists` line **628**
renders `live.problem` directly, which is §5.3's unreachable-house path
arriving through the 400 door rather than the page door.

**One existing test already holds this requirement, which is the best evidence
it is real.** `network-access-labels.test.ts:408–450` posts a LAN address to
`…/connect`, asserts a 400, and then reads the `allow_lan` and `accept_http`
controls *out of the 400 body* — it requires the refusal to render the form's
own boxes so the message can be checked against the name of the box that opens
it. Those controls live on Connection after the split (§4.1). So that file stays
green exactly when the connect route's five sites re-render Connection, and goes
red the moment one of them re-renders the hub. It was written for a different
purpose and it is the readiest mutation available here.

**This screen has never echoed a rejected body back.** Every one of the
eighteen re-renders from stored state, so a household who mistypes an address
is handed back the address they had *before* they typed — which is
indistinguishable from a save that worked, and is exactly the fault RFC 009
records on Calendars and Weather and fixes there with `SourceEcho` and
`WeatherEcho`. It is an open gap on this screen rather than a case those rules
exempt.

**Decided, rather than filed: Connection and Tell me when… echo; the other
three do not.** The split is the moment to take that decision because all
eighteen sites are being read and re-pointed anyway, and doing it in the same
pass costs one shape and a threading rather than a second sweep of the same
file later. Which forms get it follows from what a refusal costs in typing:

- **Connection** — an address, a token and two consent checkboxes, every one of
  them typed or pasted, and the token is a long opaque string a household
  fetched out of another application. Losing it to a mistyped port is the worst
  refusal on this screen.
- **Tell me when…** — eight fields, most of which a template may have filled in
  (`homeassistant.test.ts:789–794` reads five of them back off one). A refusal on
  the entity id discarding the window, the value and the action is the Weather
  screen's own fault one form along, in a form with more in it.
- **Readings, Calendars, To-do lists** — one field, one field, and a field plus
  an optional label. Every one of them is *chosen from a list* rather than
  typed, so re-picking is a tap, and an echo would be machinery guarding nothing.

`HaEcho` is shaped like `WeatherEcho` and travels the way it does, through
`render()`'s existing error argument rather than beside it, so there is one
parameter that means "what to say and what to put back" rather than two that
can disagree. Its limit is the one `setup.ts` already found and RFC 009
records: an echo belongs on a text field and not on a closed list, because
handing a rejected value back into a `<select>` selects nothing and the browser
preselects whatever sorts first — a live Save over a value nobody chose.

**On this form that limit turns out not to bind, and checking why is worth the
line.** The field that gets refused for not being in a list is `entity_id`, and
it is a `textField` with `list="ha-rule-entities"` and a `<datalist>` beside it
(`admin-ha.ts:1319–1326`) rather than a `<select>`. A datalist suggests and
does not constrain, so a refused entity id echoes back into it exactly as typed
— which is the whole point, since the household's mistake is one character in a
name they now need to see. The genuine `<select>`s here (`condition`, and the
action) are closed lists whose every value is an option by construction and are
refused for what they mean rather than for their shape. Connection's two
consents are checkboxes and echo as `checked`, which is the case RFC 009 warns
about from the other side: an unticked box is not sent, so the echo has to
record the absence rather than read it off the body.

## 6. Vocabulary

`admin-vocabulary.test.ts` sweeps served admin pages for retired nouns —
`display`, `displays`, `canvas`, `canvases`, `screen`, `screens`, `block`,
`blocks` — with an empty allow-list. Five new screens are five new sets of
headings, `detail` strings and `emptyState` sentences, and this is the screen
family where "screen" is the most natural word to reach for.

The hub's section heading is **"What your house puts on the wall"** rather than
anything containing those nouns, and the five row labels are the existing
section names: Readings, Calendars, To-do lists, Tell me when…, Connection and
token. Reusing the names already on the page is not only safe for the
vocabulary sweep — it means a household who knew the old page finds the same
words.

"Tell me when…" keeps its ellipsis and its lowercase w. It is the one heading
on this screen written as a sentence a household would say, and renaming it to
"Alerts" for symmetry with the route would be tidying away the only warm thing
in the vocabulary. The *route* is `/alerts` because a URL is not read aloud.

## 7. Phases

**There were three phases here and there are two, because the first was undone
by the second.** The plan as first written folded every add-form behind
`.disclose` in phase 1 and then, in phase 2, removed most of those disclosures
again — its own text said so: "the disclosures from phase 1 mostly become
unnecessary on the sub-screens, where an add-form is the point of the page." A
phase whose main output is deleted by the next phase is not a cheap first step,
it is work done twice and reviewed twice, and on the screens that matter it is
worse than that: a household who gets phase 1 is handed a *folded* add-form on
a page whose whole job is that form, which is one more tap than today for the
one task the screen exists to do. The ordering argument for it — cheap
reversible relief before the structural change — was sound and does not survive
the phases actually being written out.

**Phase 1 — the hub and the five routes.** §3.2, §3.3, §4.1, §4.2, §4.4, §4.5,
every exit in §5.1 and every 400 in §5.7. Two pieces of the old phase 1 come
with it because they are wanted wherever the screen ends up:

- **Connection's disclosure stays.** An address and a token are not what a
  household came to that screen to read; that is the one add-form on this
  screen whose page has something else to say.
- **The entity and rule cards become `listRow`s.** That is the component-layer
  conversion RFC 009 phase 10B did screen by screen, it is what the sub-screens
  compose from, and it is not a disclosure at all — it survived into this phase
  because nothing about it was undone.

Everything else from the old phase 1 is dropped rather than deferred.

**Phase 2 — the Calendars list.** §4.3, kept separate because it is the only
behaviour change in this document and should be reviewable on its own; its
shape is written out in §9. Phase 1 stands without it — the Calendars
sub-screen exists either way and carries the add form — so this is an addition
to a shipped screen rather than the last piece of an unfinished one.

**It was not, in the end, reviewable on its own: phase 2 shipped inside phase
1's own commit (`426c126`), so the one behaviour change in this document went
out in a diff of 1,518 lines about routing.** Recorded rather than edited away,
because the paragraph above it is a good argument and the thing that defeated
it was nothing more than both phases being in front of the same person at the
same time — which is how a phase boundary is usually lost, and the reason to
write the boundary down is that it is the only thing that can be pointed at
afterwards.

**§3.1's disclosure option stays in the text, and it is the fallback rather
than a step.** If the split is judged too large, folding the add-forms on the
page as it stands is still the right change and is still cheap. What it is not
is a phase of this plan.

## 8. How this gets proven (verification is the job)

**A route test that walks all six.** Every screen renders with a connected
household, with an *unconnected* one, and with Home Assistant unreachable
(`look()` failing). The third is the one that matters and the one a split
breaks: five new page functions are five new chances to read `live.entities`
without checking `live.problem`. Checked the way this repository checks things
— make one sub-screen dereference live state unguarded and watch it go red.

**The unreachable-house case asserts the hub's rows, not just that it
renders.** §5.3's rule is the thing most likely to be got wrong quietly: with
`look()` failing, the four stored counts must still read the household's own
numbers off the database — the same numbers the connected case asserts, since
an unreachable house changes none of them — and the two live counts must show
the problem rather than "0", so the assertion names those four numbers and then
names the *absence* of a "0 readable entities" string anywhere on the page. A hub that renders is not a hub that is
telling the truth, and `look()`'s failure branches hand back empty arrays
beside the problem precisely so that the wrong version of this passes every
structural check.

**The exit table is the test, not the prose.** Drive all twenty-two exits
through the real app with a real session and assert the `Location` header: the
eleven tokened redirects, the seven bare ones (five of which are reached
through a GET, so they are driven as GETs with a bad id in the URL), and the
four Cancels, whose destination is read off the rendered confirmation page's
own cancel link rather than from a redirect. Including the two exceptions
explicitly, since they are the two a reasonable implementer gets backwards:
`ha-disconnected` landing on the **hub**, and Disconnect's Cancel landing on
**Connection**.

**It does not start green, and the first draft of this section said it would.**
Three `Location`s on this route are already pinned in `admin-saved.test.ts` —
`ha-entity-removed` at 579, `ha-rule-removed` at 612 and `ha-disconnected` at
646 — so writing this test against the current code reproduces assertions that
exist, and shipping the change edits two of them. **The third does not move**:
646 pins `/admin/home-assistant?saved=ha-disconnected`, which is exactly where
§5.1 still sends it, so that line is the one that proves the exception rather
than one that had to be brought along. Two changed and one unchanged out of
three is the shape to expect.

Editing those two is not weakening a test, and the precedent is named in
CLAUDE.md: the sign-in work's two "is behind the session gate" assertions
pinned an exact `Location` and "went red on a gate that now says *more*", and
were changed to name the destination it carries. Same shape here — the redirect
still happens, still carries its token, and now says which screen. A reviewer
should check that each edited assertion names a *more* specific destination
than it did, because an edit in the other direction is the thing this rule is
protecting against.

**The back crumb, measured rather than asserted from markup.** Each of the five
sub-screens carries exactly one `.crumb-back`, its href resolves to
`/admin/home-assistant` against the page's own `<base>`, and no sub-screen
emits a second `<h1>`. The href needs resolving rather than string-matching for
the reason RFC 009's skip link records: a bare relative href resolves against
`<base>` and can leave the page entirely, and the markup reads as correct at
every character.

**The picker mounts once.** The readings screen serves both the `#ha-entity-picker`
div and the `assets/ha-entity-picker.js` tag; no other of the six serves
either. §5.6.

**Every 400 comes back on the screen its form is on.** Drive one refusal into
each of the five posting routes — a malformed address, an unwatchable domain, a
non-`calendar.` id, a non-`todo.` id, an entity outside the watchable set — and
assert the response is 400 *and* that the body carries that form's own control,
which is the thing a hub cannot fake. §5.7 names the readiest mutation and it
is an existing file rather than a new one:
`network-access-labels.test.ts:408–450` already reads `allow_lan` and
`accept_http` out of a connect 400, so pointing any connect refusal at the hub
turns it red with no new assertion written at all.

**And the echo is asserted by what comes back, not by the shape that carries
it.** Post a Connection body with a good token and a bad address, and read the
token back out of the 400's own field; post a rule with six good fields and a
bad entity id, and read the six back. A `HaEcho` threaded correctly and never
rendered is the failure this is for, and it looks identical to today from
outside.

**`ha-claims.test.ts` is unchanged and must stay that way.** If a reviewer finds
themselves editing it to point at a sub-screen, §5.4 has been violated. Worth
saying in the PR description rather than only here.

**The vocabulary sweep runs on all six, and that is a property to check rather
than to assume.** It sweeps *served* pages by crawling `href` and `action` out
of the markup from `/admin`, which is the argument for it sweeping pages rather
than files and is why §6 is short — but "automatically" is true only because
§3.3 draws the hub's five rows on a household that has never connected. The
crawler's fixture never connects one, and its own docblock says so. So the
assertion is the crawler's own path list: `/admin/home-assistant` and all five
children appear in it. Gate the rows on `connected` and the sweep quietly
covers five fewer screens than it thinks it does, which is a test getting
weaker with nothing failing.

**Two hand-listed `PAGES` arrays do not join automatically, and neither names
this route today.** `admin-icon-rules.test.ts:147` lists nine paths and
`admin-mobile-nav.test.ts:150` lists four; `/admin/home-assistant` is in
neither. So the icon rules — no `.ic` tile, no icon beside a heading, none
inside a tinted rounded square — and the compact drawer's DOM order and
off-canvas anatomy have never been checked on this screen at all, before this
RFC or after it. The implementation adds **the hub and one sub-screen** to each:
one rather than five, because what those files check is `page()`'s shell, and
five children of one shell would be the same assertion five times. That is a
gap this RFC closes in passing rather than one it creates, and it is recorded
here so it is not read as scope.

**Looked at, on a real phone.** The measurement this project counts. RFC 009
phase 5 recorded the wall editor going from a 1,880px document to 936px at
390px wide, and "nobody has used either converted screen on a real phone" is
still the standing caveat on RFC 009 phase 10B. The number to record here is
where the first actionable control sits on each of the six screens at 390px,
against the current page's own figure.

**Taken** (`browser-ha-phone.test.ts`), through the real app with a real
session and a real fake house carrying a reading, a list and a rule. The before
is a clean worktree of `main` at `e819cca`, same fixture, same viewport, same
definition of actionable — the first element inside `main .content` with a box
that a household can act on:

| | first control | document |
|---|---|---|
| **before** `/admin/home-assistant` | **355px** | **5,314px** |
| `…/home-assistant` (the hub) | 340px | 1,576px |
| `…/connection` | 148px | 887px |
| `…/readings` | 267px | 981px |
| `…/calendars` | 240px | 844px |
| `…/lists` | 320px | 844px |
| `…/alerts` | 207px | 1,663px |

Two of those numbers are the whole verification argument rather than a result.
The hub read **432px** first — *worse* than the page it replaces — and
`…/calendars` read **454px**, and both were real faults the assertion caught
rather than numbers to explain; what fixed them is in the note at the head of
this document. The measurement was worth taking precisely because it disagreed
with Appendix B's reconstruction, which is the thing Appendix B says about
itself.

**Still unproven where it counts:** nobody has used any of the six on a real
phone. These are Chromium at 390px, which is the right way to measure a layout
and is not the same as a household holding one.

## 9. Open decisions

- ~~**Whether Calendars gains a list at all (§4.3).**~~ **Decided: yes, and it
  shipped as phase 2 in the same series.** What follows is the shape it was
  decided on, and it is accurate but for the sectioning — see the note at the
  head of this document for why it is one `section` rather than two.
  It is the one net-new
  behaviour in this RFC. Against: the brief for this work was to streamline
  without removing features, and adding one is scope. For: the section is the
  only one of the four with no list, which reads as an inconsistency rather
  than as a decision, and the question it cannot answer — "which of my Home
  Assistant calendars are on the wall" — is one a household asks on this screen
  and has to leave to answer. Phase 2 either way, and it has a shape, because a
  decision about an idea is harder to take than one about a thing:

  **The rows are the `calendar_sources` rows with `kind = 'homeassistant'`**,
  which is not a new read — `/admin/calendars` already selects them, and
  `haCalendarEntityIds(db)` already reduces them to a set of entity ids to stop
  the add form offering one twice (`admin-ha.ts:594`, `1097`). So this adds a
  list to a screen and no query to the application.

  **One `listRow` each: the calendar's name, its entity id as the `detail`, and
  a `tag` when the source carries a `last_error`.** The tag is what makes the
  list worth drawing rather than decorative — a Home Assistant calendar that has
  stopped reading is invisible on this screen today, and "it is added" and "it
  is working" are two facts. Every row links to `/admin/calendars`, where the
  source is actually configured; this screen adds and reports, and does not
  become a second place to edit one. That is the same relationship
  `savedRedirect(c, '/admin/calendars', 'ha-calendar-added')` already states
  (§4.3), drawn rather than only redirected to.

  **The test is the round trip across both screens**, because that is the
  claim: add through the sub-screen, then read the row off the sub-screen's own
  list — name, entity id, and the absence of a tag on a source with no error —
  then remove it on `/admin/calendars` and read its absence back on the
  sub-screen. One screen asserted against itself would pass just as happily on
  a list that renders whatever it was handed a moment ago, which is the thing
  a list of somebody else's rows can most easily be.
- **Whether `typesPage`'s hand-rolled crumb is fixed in the same series
  (§5.2).** Two lines, on a screen this RFC does not otherwise touch. Filed
  rather than bundled.
- ~~**Whether the hub's counts are live or cached (§5.3).**~~ **Decided, and
  the answer was that the question had one word too few in it.** Four of the
  five rows carry a *stored* count and two rows carry a live one beside it;
  §5.3 is the table. What survives as an open question is only the narrow one
  the original bullet was really about: if `GET /states` on the hub turns out to
  cost too much on a Raspberry Pi with 400 entities, the fix is to drop the two
  live counts rather than to cache them, because a stale count beside a live
  screen is two readers of one fact. The four stored counts cost a
  database read and are never the thing to drop.
- ~~**Whether Connection should exist at all under the supervisor.**~~
  **Decided: draw it, and say so** (§3.3, §4.1). The row is drawn under the
  supervisor, and all five rows are drawn on a household that has never
  connected. The argument that settled it is not the aesthetic one about
  differing between installs — it is that `admin-vocabulary.test.ts` reaches
  pages by crawling links from a fixture with no Home Assistant on it, so a row
  drawn conditionally is a route swept conditionally, and §8's claim about the
  sweep picking up new screens would have been false for exactly the five
  screens this RFC adds. A conditional row also costs the thing §4.1 already
  names: a row that is not drawn reads as a broken link to a household who
  remembers it. Each sub-screen says what to do instead, in an `emptyState`.

## 10. Non-goals

- **Changing what the screen can do.** No new capability, no schema change, no
  manifest change, nothing on the display. Rule 12 is untouched and this RFC
  does not go near the write path.
- **Splitting `admin-ha.ts` into more files.** It is 1,388 lines and this makes
  it a little longer. Whether it becomes `admin-ha-*.ts` is a separate question
  from whether the *screen* splits, and answering both in one PR would make the
  diff unreadable.
- **A ninth component.** The hub is `listRow`s. If it turns out to want
  something else, that is a conversation to have before writing it, per
  CLAUDE.md.
- **Touching the entity picker's script.** It moves route and is otherwise
  unchanged.
- **Doing the same to Weather.** `/admin/alerts` carries a merged form with
  five rule cards and has its own history (RFC 009 phase 3.2). It may want this
  shape later; it is not this RFC.

## Appendix A — the claims this falsifies

Short, because this RFC changes no rule and no promise. What it invalidates is
navigational prose: anything that tells a household or a contributor that a
thing is *on* the Home Assistant page rather than under it.

| # | Where | What it says today |
|---|---|---|
| 1 | `apps/server/src/http/admin-ha.ts`, the `haPage` docblock | Describes the composition order of a single page — "Status and the form first; the explainer … sits under them". |
| 2 | `apps/server/src/http/admin-ha.ts`, `todoLists()` docblock | "the list is chosen here" — still true, but "here" becomes a sub-screen. |
| 3 | `CLAUDE.md`, the to-do list paragraph | "The Home Assistant screen has a To-do lists section built from `section`, `listRow`, `tag`, `emptyState` and `destructive`". It becomes a screen rather than a section. |
| 4 | `docs/rfc-012-home-assistant-to-do-lists.md` §5.2 and §11 | Cite the Home Assistant screen as the place a list is watched. Annotated, not rewritten: the conclusion holds and only the address changes. |
| 5 | `apps/server/src/http/admin.ts:1212–1218`, the dashboard's attention row | "Home Assistant is connected, with a problem" / "The last read failed. The Home Assistant page says what came back.", with `href: 'admin/home-assistant'`. Both halves move: the href becomes `admin/home-assistant/connection`, because a failed read is a connection fault and the hub will no longer be the page that says what came back, and the sentence changes with it to name that screen. This is the only cross-screen link in the admin that points at this page for its *content* rather than as a destination, which is exactly why it is the one that breaks. |
| 6 | `apps/server/src/http/admin.ts:5492`, the Calendars page | A `listRow` per offered Home Assistant calendar, each posting to `admin/home-assistant/calendars`. **The POST path does not move** (§3.2), so the form is untouched — but its 400 does: today a refusal from that button drops the household onto the whole Home Assistant page, and after the split it drops them onto `…/home-assistant/calendars`. Strictly better, still not the page they pressed the button on, and worth a sentence at the call site rather than a silent change of scenery. |

Items 1–4 are prose. Items 5 and 6 are code, and the first three of the claims
above have no test asserting them, which is precisely why they are listed —
this document's own header warning is that the claims nobody re-reads are the
ones that rot.

## Appendix B — what the hub looks like

Drawn against the admin's own tokens and components, with the current page
beside it for length, in the design canvas accompanying this RFC.

**Those are measurements of a reconstruction, not of the served page**, and the
distinction is this repository's own — a month grid was once measured on a
widget nobody ships, and the shipped wall turned out tighter. The canvas
rebuilds `admin-ha.ts`'s markup against the real tokens from
`design-tokens.ts`, `html.ts` and `components.ts`, with a plausible household
on it (412 entities, three readings, two calendars, two lists, two rules); it
is not the real app with a real session and a real Home Assistant. At a 1,040px
content column it renders 4,787px for the current page, 1,191px for the hub and
1,251px for the busiest sub-screen.

The number that would settle it is §8's: the first actionable control's offset
at 390px, taken on the **real** page through the real app, before and after.
Nobody has taken it. Until somebody does, the counts in §1 — which are read out
of the source and not off a screen — are the load-bearing evidence here, and
the canvas is an illustration.

## Appendix C — the tests that name this integration

Thirteen files under `apps/server/test/` mention Home Assistant by name.
**Eleven name the route**; the other two name the integration only and do not
move. Listed rather than summarised, because "the tests will need updating" is
the sentence that hides how many and which.

| File | After the split | Why |
|---|---|---|
| `admin-saved.test.ts` | **red, 2 of 3** | Pins three `Location`s: 579 `ha-entity-removed` → `…/readings`, 612 `ha-rule-removed` → `…/alerts`. **646 `ha-disconnected` is unchanged** — it goes to the hub (§5.1), so that line proves the exception rather than following the change. |
| `todo-lists.test.ts` | **red** | Three tokens at 271, 655, 659 → `…/lists`, one bare redirect at 664 → `…/lists`, and four hub GETs (556, 581, 638, 669) reading list markup that now lives on `…/lists`. The most-affected file in the suite. |
| `homeassistant.test.ts` | **red** | The template pair at 783–794 (§3.2), and four hub GETs (302, 324, 342, 1120) asserting content that moves to a sub-screen. Its one `Location` pin, 1036, is `/admin/calendars?saved=ha-calendar-added` and is **unchanged**. |
| `browser-editor.test.ts` | **red** | 1881 `todo-list-added`, 1920 `todo-list-removed`. Both are setup for a wall test rather than assertions about this screen, which is the kind of breakage that reads as unrelated in a diff. |
| `browser-todo-list.test.ts` | **red** | 72, `todo-list-added`. Same shape: setup, not subject. |
| `network-access-labels.test.ts` | **green, and load-bearing** | Posts only to `…/connect`, whose path does not move — but it reads `allow_lan` and `accept_http` out of the **400 body**, so it stays green exactly when §5.7 is done right and goes red if a connect refusal re-renders the hub. The readiest mutation in §8, and it already exists. |
| `ha-claims.test.ts` | **green, and must stay unchanged** | Calls `/admin/home-assistant` at 125 and asserts the boundary card is on it. §5.4. A diff touching this file has violated that section. |
| `admin-origins.test.ts` | **green** | Lists `/admin/home-assistant` among the pages it sweeps for third-party origins; the hub still exists. Extended to the five children in the same pass. |
| `admin-button-anatomy.test.ts` | **green** | Lists the route twice (139, and in `CARD_PAGES` at 210); the hub still renders. Extended likewise. |
| `todo-tick.test.ts` | **green** | Uses `…/connect` and `…/lists` as setup. Paths unchanged. |
| `browser-todo-tick.test.ts` | **green** | The same, at 62 and 67. |
| `ha-write-boundary.test.ts` | **untouched** | Names the integration through the `fake-home-assistant` fixture and never the admin route. Rule 12's boundary is not near this. |
| `addon-repository.test.ts` | **untouched** | The string is a supervisor source path in a comment. |

Two files do **not** appear in that list and should: `admin-icon-rules.test.ts`
and `admin-mobile-nav.test.ts` carry hand-written `PAGES` arrays that have
never included this route. §8 adds it.

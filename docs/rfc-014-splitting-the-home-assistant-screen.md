# RFC 014 — Splitting the Home Assistant screen

Status: **proposed** · Owner: — · First drafted 2026-09-13 ·
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
is judged too large — the two are not exclusive, and §7 sequences them so the
cheap half can ship alone.

The load-bearing finding is in §5.1, and it is the kind of thing that only
turns up by reading the file rather than the screen: **all eleven of this
screen's `savedRedirect` calls name one destination.** Splitting the screen
without splitting those redirects puts every confirmation strip on a page the
household is no longer standing on — which is RFC 009's own rule ("a token is a
claim, so check the branch it is on") failing in a new way.

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
   current page makes you scroll to find.
3. **The boundary card**, unchanged in wording. §5.4 explains why it stays on
   the hub and cannot simply follow the token to Connection.

No new component. A hub of labelled rows with counts is exactly `listRow` with
`href` and a trailing `tag`, which is what that component is for, and the
CLAUDE.md rule against inventing a ninth component is not in play.

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
RFC and §9 keeps it as an open decision rather than smuggling it in.

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
rather than above a form that is off-screen. `?template=<key>` keeps working
exactly as it does — it is a query parameter and not a script, and it now
re-renders a page whose form is visible when it lands.

With a page to itself the builder's three time-and-action fields fit one
`.row-fields` row instead of stacking, which is a consequence of the room
rather than a design change.

## 5. The seams that break

This is the section worth reading twice. Everything above is placement.

### 5.1 Every `savedRedirect` names one destination

Eleven call sites in `admin-ha.ts`. Ten name `/admin/home-assistant` and one
names `/admin/calendars`. Split the screen and ten of those land the household
on the hub after an action they performed on a sub-screen — the strip appears,
correctly worded, on a page they are not on and did not ask for.

Worse, it is silent: the redirect works, the token is valid, the sentence is
true. Nothing fails. A household adds a reading and finds themselves back at
the top with "Reading added." over a list of five rows, and has to navigate
back in to add a second.

Each redirect goes to the screen its action belongs to:

| Token | Goes to |
|---|---|
| `ha-connected`, `ha-disconnected` | `…/connection` — except `ha-disconnected`, see below |
| `ha-entity-added`, `ha-entity-removed` | `…/readings` |
| `ha-calendar-added` | `/admin/calendars` (unchanged) |
| `ha-rule-added`, `ha-rule-removed`, `ha-rule-updated` | `…/alerts` |
| `todo-list-added`, `todo-list-removed`, `order-saved` | `…/lists` |

**`ha-disconnected` is the exception and it is not a detail.** After
disconnecting there is no connection, so the Connection screen has nothing to
show and the four sub-screens have nothing in them. It goes to the **hub**,
which is the one page that is still true. A redirect back to `…/connection`
would leave a household on a page whose whole subject has just been deleted.

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
the reason is worth stating so nobody optimises it later by accident: the
counts on the hub are counts *of live state* — "412 readable entities", "2 of 4
calendars added" — and a hub that cached them would answer a different question
from the screen it links to. Two readers of one fact disagreeing is this
project's most repeated bug.

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

**Phase 1 — fold the add-forms. Ships alone.** The disclosure option from
§3.1, on the page as it stands: each add-form behind `.disclose`, the boundary
collapsed to its heading plus one sentence plus a disclosure, entity and rule
cards converted to `listRow`. No route moves, no redirect moves, no new test
file. This is most of the height for a fraction of the risk, and if §3.2 is
judged too large this is the change that should happen anyway.

**Phase 2 — the hub and the five routes.** §3.2, §3.3, §4, and the redirect
table in §5.1. The disclosures from phase 1 mostly become unnecessary on the
sub-screens, where an add-form is the point of the page; the one that stays is
Connection's, because an address and a token are still not what a household
came to that screen to read.

**Phase 3 — the Calendars list.** §4.3, kept separate because it is the only
behaviour change in this document and should be reviewable on its own.

Phases 1 and 2 are independently shippable and phase 1 is independently
valuable. That ordering is deliberate for the reason RFC 012's was: it puts the
cheap, reversible improvement in front of the structural one, rather than
making the structural one a prerequisite for any relief at all.

## 8. How this gets proven (verification is the job)

**A route test that walks all six.** Every screen renders with a connected
household, with an *unconnected* one, and with Home Assistant unreachable
(`look()` failing). The third is the one that matters and the one a split
breaks: five new page functions are five new chances to read `live.entities`
without checking `live.problem`. Checked the way this repository checks things
— make one sub-screen dereference live state unguarded and watch it go red.

**The redirect table is the test, not the prose.** Drive each of the eleven
POSTs through the real app with a real session and assert the `Location`
header, including `ha-disconnected` landing on the hub rather than on
Connection. This is the assertion that would have caught §5.1 before it
shipped, and it is worth writing *first*, against the current single-page code,
where ten of the eleven pass trivially — a test that starts green and goes red
under the change is what tells you the change did something.

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

**`ha-claims.test.ts` is unchanged and must stay that way.** If a reviewer finds
themselves editing it to point at a sub-screen, §5.4 has been violated. Worth
saying in the PR description rather than only here.

**The vocabulary sweep runs on all six.** It sweeps served pages, so five new
routes join it automatically — which is the argument for it sweeping pages
rather than files, and is why §6 is short.

**Looked at, on a real phone.** The measurement this project counts. RFC 009
phase 5 recorded the wall editor going from a 1,880px document to 936px at
390px wide, and "nobody has used either converted screen on a real phone" is
still the standing caveat on RFC 009 phase 10B. The number to record here is
where the first actionable control sits on each of the six screens at 390px,
against the current page's own figure.

## 9. Open decisions

- **Whether Calendars gains a list at all (§4.3).** It is the one net-new
  behaviour in this RFC. Against: the brief for this work was to streamline
  without removing features, and adding one is scope. For: the section is the
  only one of the four with no list, which reads as an inconsistency rather
  than as a decision, and the question it cannot answer — "which of my Home
  Assistant calendars are on the wall" — is one a household asks on this screen
  and has to leave to answer. Phase 3 either way.
- **Whether `typesPage`'s hand-rolled crumb is fixed in the same series
  (§5.2).** Two lines, on a screen this RFC does not otherwise touch. Filed
  rather than bundled.
- **Whether the hub's counts are live or cached (§5.3).** Proposed live, and
  the reason is written down; if the `GET /states` cost on the hub turns out to
  matter on a Raspberry Pi with 400 entities, the fix is to drop the count
  rather than to cache it, because a stale count beside a live screen is two
  readers of one fact.
- **Whether Connection should exist at all under the supervisor.** The row is
  drawn and says there is nothing to configure (§4.1). The alternative is to
  omit the row entirely on an add-on, which is fewer things on screen and one
  more way for the hub to differ between installs. Proposed: draw it, say so.

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

None of these is a security claim and none has a test asserting it, which is
precisely why they are listed — this document's own header warning is that the
claims nobody re-reads are the ones that rot.

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

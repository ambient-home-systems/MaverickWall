# RFC 016 — The Walls list shows the walls

Status: **phase 2 built, measured, and refused by its own budget** (phases 0 and 1 on `main`; phase 2 is in one PR's history and reverted in the same PR — §9.1 has the numbers and the decision; Forget, listed below as phase 3, shipped with phase 1) · Owner: — · First drafted 2026-09-14 ·
Relates to `apps/server/src/http/admin.ts` (`displaysPage`, `wallCard`,
`displayListCard`, `epaperListCard`, `seenLine`, `wallTemplatePreviews`),
`apps/display/src/template-gallery.ts`, `apps/display/src/preview-css.ts`,
`apps/server/src/api/queries.ts` (`readAdminScreens`, `readLayoutWidgets`,
`touchScreen`), `apps/server/src/http/admin-epaper.ts` (`GET
/admin/epaper/:id/preview.png`), `apps/display/src/orientation.ts` · Builds on the free-form canvas (RFC 005), the component layer
(RFC 009 phases 10A/10B), the add-a-wall page (RFC 009 phase 4) and
`retireDefaultWall` · Constrains nothing · Amends no hard rule ·
**Changes one shipped assertion in `admin-walls-list.test.ts`; §5.1 is why**

> Four layouts were drawn and reviewed before this was written. **A is the one
> chosen**; B, C and D are recorded in §8 rather than deleted, because two of
> them are the right answer for a household this one is not designed for, and
> §9 turns on whether that household exists.

## 1. Summary

A household comes to `/admin/walls` to do two things: **add a wall**, and
**check a wall is alive**. Those are the two things the page currently does
worst.

Adding is a sentence. Both doors — a browser wall and an e-paper panel — are
`<a class="link">` inside `<p class="hint">` (the "Add a wall" section of
`displaysPage`), set in
the body role at 14.5px, in the middle of the prose that explains them, below
every card on the page.

Checking is a line that says nothing. `seenLine` renders
`Last seen ${ago(lastSeenAt, at)}`, and `ago(null)` is the string `'never'`
(`ago` in `admin.ts`) — so on the household this RFC was opened against, **five of
six cards spend their entire second line saying "Last seen never"**, which is
the same sentence for a wall whose pairing link has never been opened and a
wall that was paired and has not drawn since.

And the page never shows a wall. Every card is a name, a kind chip, that status
line and the word "Open" — in a product whose whole subject is that each wall
draws a *different arrangement*, on a screen that already knows how to render
one (`/admin/walls/new` draws fourteen).

This RFC proposes:

1. **The two add paths become buttons**, in an action row under the heading.
2. **Every card carries a preview of what that wall draws**, through the
   mechanism the template gallery already uses, against that wall's own
   manifest and in the orientation it is hung — and for a panel, as one
   `<img>` on the frame endpoint the panel's own page already draws.
3. **"Never" becomes a state with a verb attached**, worded per kind: a browser
   wall is *Not paired yet* with **Pair it**, a panel is *Waiting for its
   device* with **Set up the device** — both links to the page where that
   happens.
4. **One quiet summary line** above the grid, in place of nothing — on a
   household with two walls or more.
5. **The revoked count becomes a disclosure** that can be read and cleared.

No schema change. No migration. No manifest change. (Forget is the one write
this page makes that the application had not made before; §3.5 is what it has
to sweep. It was listed as phase 3 and shipped with phase 1, because the
disclosure it sits in and the delete it needs turned out to be one question.)
The display bundle gains nothing it does not already have; one admin module
gains a second entry point.

**§2.7 is a shipped defect with no design decision attached and should not wait
on any of this.**

## 2. What the screen is today, counted

### ~~2.1 Both primary actions are prose~~ — closed by phase 1

```
`<p class="hint">A tablet, monitor or television with Maverick Wall open in `
  … `<a class="link" href="admin/walls/new">Pair a new wall →</a></p>` +
`<p class="hint">Low-power e-paper panels are added the same way, with ` …
  `<a class="link" href="admin/epaper#add">Add an e-paper wall →</a></p>`
```

`p.hint` is `font-size:var(--mw-t-body-size)` — 14.5px, weight 400
(the `p.hint` rule in `html.ts`'s `STYLE_BODY`). `.link` adds colour and nothing else: no height, no padding,
no container, and no 48px pointer target, which every `button`/`.btn` on this
page gets from `button::after` (same sheet). The one thing a household is
here to do is set in the same type as the paragraph explaining it, and is a
smaller tap target than "Continue" on the pairing-code form below it.

This section also sits **after** the card grid and the revoked line, so on a
phone it is reached by scrolling past every wall the household already has.

### ~~2.2 Five of six status lines say nothing, and "never" is two states~~ — closed by phase 0 and phase 1

`ago(null, at)` returns `'never'`, unconditionally. `seenDot` (`admin.ts`)
draws `dot-idle` for both `lastSeenAt === null` and a stale timestamp, so the
dot does not separate them either.

The two states behind that one word are genuinely different, and the data to
tell them apart is already in the row:

| Row state | Meaning | What the household does |
|---|---|---|
| `revokedAt === null`, `lastSeenAt === null` | no screen has ever fetched this wall's data | open its pairing link on the screen |
| `revokedAt === null`, `lastSeenAt` stale | it drew, and has stopped | look at the screen, or the network |
| `revokedAt !== null` | the token was revoked | nothing; it is a record |

`touchScreen` is called from exactly two places, `/d/manifest` and
`/d/epaper/:file` (both in `app.ts`) — never from `/pair` — so
`lastSeenAt === null` means precisely **no screen has ever used this token**.
That is a claim this page can make without guessing, and it is the one it is
currently declining to make.

**And "alive" is already defined four times, three ways.** The draft of this
RFC said §3.4's summary line would leave "no second definition of alive
anywhere". There are four today, before this RFC adds one:

| Site | Fresh window | Words |
|---|---|---|
| `seenDot` / `seenLine`, the Walls list | 5 min browser, 60 min panel | Last seen N ago |
| the wall page's status line (`/admin/walls/:id`) | 5 min, written as a literal | Never connected / Online / Not seen recently |
| the panel page's status line (`admin-epaper.ts`) | 60 min | Never connected / Online / Not seen recently |
| the Overview's attention rows (`/admin`) | `DAY_MS`, one day | has never connected / last seen N ago |

Three of those agree by coincidence rather than by construction — the wall
page's `5 * 60_000` is a copy of `BROWSER_SEEN_WINDOW_MS` that nothing holds to
it — and the fourth asks a genuinely different question. A summary line counted
from a fifth reading would be a fifth vocabulary. Phase 0 is where that closes
(§6).

### ~~2.3 The largest number on the page is unreachable~~ — closed by phase 1

```
`<p class="hint">${revoked} unpaired wall${…} kept for the record. ` +
`Their tokens no longer work.</p>`
```

On the reviewed household that is **18 against 6 shown** — three times as many
walls reported as displayed, in prose, with nothing to click. There is no route
in the admin to look at them, tell which was which, or clear them out.

### ~~2.4 The rarest action carries the most structure~~ — closed by phase 1

`approveForm` is a full `section()` — heading, two lines of help, a labelled
field, a button — for the path taken when a *wall* starts its own device flow.
It is the same construction as "Add a wall", positioned below it, and it is the
last thing on the page.

### 2.5 Nothing distinguishes two walls but the name

`wallCard` (`admin.ts`) is one shape for both kinds, and
`displayListCard` / `epaperListCard` differ only in the href, the chip, and a
geometry suffix on the status line. A card therefore contains: a name, a chip,
a sentence that on this household is the same sentence six times, and "Open".

The names on the reviewed household are `TEST SCREEN`, `Test`, `Test1`,
`test34`, `testtesttest`, `zy`. That is a testing environment rather than a
kitchen — but a household that names two walls "Kitchen" and "Kitchen TV" is
in the same position, and the product's answer to "which one is which" is
currently to open one.

Meanwhile `/admin/walls/new` renders **fourteen live previews** of layouts the
household has never seen, and does it because a review said so in as many
words: *"it's impossible to know what Classic is, or Meeting Room, from just
text"* (`newWallPage`). The same sentence is true of a wall.

### 2.6 The grid is 2-up from 721px to no limit

`.g2` is `repeat(2,1fr)` with one breakpoint, `@media(max-width:720px)`
(the `.g2`/`.g3` rules in `STYLE_BODY`). `.content` is `max-width:1180px`. So
between 721px and 1180px+ each card is roughly 550px wide and holds a name, a
chip and one short line — and above 1180px the remainder of the viewport is
empty page.

`.g3` already exists, with `repeat(3,1fr)` and its own 1040px step down to two.

### ~~2.7 The list is ordered by name, case-sensitively~~ — closed by phase 0

`readAdminScreens` ends `ORDER BY name` with SQLite's default
`BINARY` collation, so every capitalised name sorts before every lowercase one.
Sorting the reviewed household's six names that way reproduces the rendered
order exactly:

```
TEST SCREEN · Test · Test1 · test34 · testtesttest · zy
```

Two things follow. A household with `Hall`, `Kitchen` and `attic tablet` gets
the attic last, after `Kitchen`, for a reason nothing on the screen explains —
that is a defect, it is one word (`ORDER BY name COLLATE NOCASE`), and it should
not wait for the rest of this RFC. And more fundamentally, **name is the one
order that says nothing about state**: it is stable, which is its virtue, and
it puts a wall that has been dark for a month in whatever position its initial
gives it.

> An earlier draft of this review said the list "arrives in insertion order".
> That was wrong; the `ORDER BY` above is what it does. The corrected finding is
> sharper than the one it replaces, which is the argument for reading the query
> rather than the screenshot.

### 2.8 Two kinds of object, one appearance

A browser wall's card opens `/admin/walls/:id`; a panel's opens
`/admin/epaper/:id/design`. They have different settings, different renderers,
different seen-windows (`BROWSER_SEEN_WINDOW_MS` 5 min against
`EPAPER_SEEN_WINDOW_MS` 60 min, because a battery panel sleeps between pulls) and different failure modes. On the list they
are separated by a 44px chip.

## 3. The decision

Direction **A**: the list shows the walls.

### 3.1 The two doors become buttons, in an action row

Directly under the app bar, above the grid:

```
[ + Pair a browser wall ]   [ + Add an e-paper panel ]   [ Approve a pairing code ]
      filled                       tonal                       ghost
```

Filled, tonal and ghost are the three emphases the `button,.btn` rules in `html.ts` already
declares. The third is the demotion of §2.4: the approve form stops being a
section and becomes a link to one.

**Deliberately not the app bar.** `pageHeader` takes at most one action
(`pageHeader` in `components.ts`), and `displaysPage` carries a comment declining to use it
at all ("No app-bar action: see the Calendars page for the rule"). Two equal doors cannot be one action, and this RFC is not the
place to relitigate that convention — so the row sits in the body, where it can
hold two.

### 3.2 Every card carries a preview

At the wall's own aspect, inside a fixed-height well so that a portrait wall and
a landscape panel produce cards of comparable height. §4 is where this comes
from; it is the substance of this RFC and the only part with real cost in it.

An e-paper panel's preview is a real 1-bit frame on white — which is also what
makes §2.8 legible without reading the chip: the two kinds stop looking alike
because they *are* not alike.

### 3.3 "Never" becomes a state and a verb

Three states, from the table in §2.2, each with its own line — and the words
are per kind, because the two kinds are not in the same position:

| State | Browser wall | E-paper panel | Trailing control |
|---|---|---|---|
| never used | *Not paired yet* | *Waiting for its device* | **Pair it** / **Set up the device** (a link) |
| fresh | *Drawing now* + `dot-ok pulse` | *Checked in 12 minutes ago* + `dot-ok pulse` | card-go "Open" |
| stale | *Not seen recently · last seen 30 days ago from 10.0.0.4* + `dot-idle` | the same | card-go "Open" |

**The first draft's wording is refused by the product's own vocabulary
check.** It read *Waiting for a screen* over **Finish pairing**, and "screen"
— with "display", "canvas" and "block" — is a retired noun on every served
admin page: `admin-vocabulary.test.ts` crawls them and its allow-list is
deliberately empty. The per-kind wording is not a synonym search around that
test. A browser wall *is* paired, by opening a link on it, so "Not paired yet"
names what has not happened; a panel is never paired at all — something is
configured to fetch its frame — so what it is waiting for is its device.

**"Drawing now" is a browser wall's word and not a panel's.** A browser wall
polls every minute and redraws every fifteen seconds, so five minutes of
silence is a fault and a fresh wall is, literally, drawing. A battery panel
pulls a frame and sleeps for half an hour; for most of the hour it is fresh it
is *displaying* a picture it drew earlier, and "Drawing now" would be true of it
for a few seconds an hour. What the row does know is when it last asked, so
that is what the line says.

**The trailing control has a target, and it is a link.** The draft's "Finish
pairing" had nowhere to go. A pairing link is shown **once** and never kept —
the once-only page `POST /admin/screens` redirects to takes it out of the
reveal store on the first visit — so the list cannot re-show it, and the only
thing a household can do for a browser wall nothing has used is the confirmed
**Make a new pairing link** on the wall page's Advanced row, which is a POST
behind a confirmation and does not belong on a card. A panel has no pairing
step at all: its frame URL and the two device recipes are on
`/admin/epaper/:id`. So **Pair it** opens `/admin/walls/:id` and **Set up the
device** opens `/admin/epaper/:id`, each a plain link to the page where the act
actually lives, and neither card carries a form.

A card in the never-used state takes `card.is-warn` — which moves the **edge**
to the warn hue and leaves the ground alone, exactly as the card tone rules in
`COMPONENT_STYLE` document. Not a tinted card: a card is a 400px region and
`--mw-warn-soft` is sized for a chip.

### 3.4 One quiet summary line

`● 1 drawing now · ● 4 not paired yet · ● 1 not seen recently`

One line, body-small, above the grid. **Not three stat tiles**: this is a
calendar, and a 3-up row of big numbers is the dashboard idiom the design rules
already refuse on the wall.

**It does not draw on a household with fewer than two walls.** One wall's
summary is its own card, repeated above it; no walls is the empty state.

The line is the phase 0 presence function (§2.2, §6) **counted**, and nothing
else: each card's state and the line's tallies come from one call per wall, so
the summary cannot disagree with the cards under it. That is the honest form of
the draft's claim that there would be "no second definition of alive
anywhere" — which was false when written, because four already existed, and
becomes true only once all four read one module. The line's own words follow
the cards' per-kind wording, so a household with a panel and a browser wall
both waiting reads two tallies rather than one noun that fits neither.

### 3.5 The revoked count becomes a disclosure

A `<details>` — the script-free idiom `/admin/chores` already uses for its
editor — listing each revoked wall with its name and when it was unpaired.
Closed by default, so the page is unchanged for a household with none.

**What the draft called Forget is a delete this application has never
performed**, and it is not a row button. There is no `deleteScreen` and no
`DELETE FROM screens` anywhere in the server: `revokeScreen` is the whole
lifecycle, and its docstring argues for keeping the row ("leave no record that a
screen ever existed … is the wrong answer when somebody is trying to work out
what is still on their wall"). A forget has to answer that argument, and it has
two things to sweep that no foreign key will sweep for it:
`layout_widgets.screen_id` and `screens.layout_follows` are both plain columns,
so a delete must remove the wall's widgets in **both** orientations in one
transaction with the row, and must decide what a panel **following** the
forgotten wall draws — the built-in view is the answer `panelCanvasOwner`
already gives a panel with no owner, and that decision is written down rather
than fallen into. It is destructive, so it takes the `confirmDestroyPage` idiom
the panel's own Remove uses — a GET that names what goes, then the POST —
rather than an inline button in a `<details>`. (Written as phase 3 and shipped
in phase 1: `deleteScreen` in `api/queries.ts` is that transaction — the refusal
of a still-paired row, both orientations' widgets, and every following panel
sent back to its built-in view — and `screen-forget.test.ts` decodes the
frames.)

**The following case is already wrong one state earlier.** A panel following a
*revoked* wall keeps drawing that wall's canvas today: `panelCanvasOwner` reads
`layout_follows` and never asks whether the wall it names is still paired. A
household who unpairs a wall and expects it gone finds its arrangement still on
the hall panel. Phase 1 closes that, because it is the same question the
disclosure raises and it needs no delete to answer.

## 4. Where the preview comes from

This is the part that can be got wrong quietly, so it is specified rather than
left to the implementation.

### 4.1 A browser wall draws in the browser, through the wall's own renderer

`apps/display/src/template-gallery.ts` already does exactly this for template
cards: it imports `renderFreeform` and `buildModel` from the display bundle and
draws each card **through the same renderer a wall runs**, into a shadow root
carrying `display.css`, against the household's real manifest.

The Walls list needs the same script pointed at different data. A template card
draws `{aspect, widgets}` from `TEMPLATES`; a wall card draws the same shape
from the wall's own stored canvas, with `GET /admin/layout/preview.json?screen=:id`
as the document — the wall's own manifest, the one `previewManifest(id)` builds
and the editor's live preview already fetches.

**The card draws the canvas the wall is hung in, not always portrait.** The
draft read `readLayoutWidgets(db, screenId, 'portrait')` unconditionally, which
draws the wrong arrangement for every wall on its side — and a household with a
landscape television in the hall and a portrait tablet in the kitchen is exactly
the one telling walls apart by their pictures. The pick uses the inputs
`apps/display/src/orientation.ts` uses, in its order: the pinned `orientation`
column when it is not `auto`; else the viewport the wall last reported
(`report_w`/`report_h`, turned through `rotation` the way `canvasFor` turns
it, landscape only when wider than tall); else `rotation` alone on a nominal
portrait viewport; else portrait. The aspect follows the pick —
`layout_aspect` for portrait, `layout_landscape_aspect` for landscape — so the
card's well is the shape of the thing on the wall. The pick is a pure function
of the row and is tested as one; the display's `resolveLayout` stays the only
definition of what "landscape" means, and the card asks it rather than
restating it.

**No second renderer**, which is the constraint this codebase states every time
two things draw one canvas (`shifts[0]`, `display_mode`, `cellEvents`, `mode`,
the Arrange backdrop). The gallery's own docstring in `newWallPage` makes the
argument in full, and every word of it transfers.

### 4.2 A panel's card is one `<img>`, and does not learn a second renderer

A panel's card cannot be drawn in the browser: the 1-bit renderer lives on the
server. The draft reached for `template-gallery.js`'s `panelPreview`, which
**posts** a canvas to `POST /admin/epaper/:id/preview.png` — the mechanism for
a canvas that has not been saved. Nothing on this list is unsaved, and the
right endpoint already exists: **`GET /admin/epaper/:id/preview.png`** in
`admin-epaper.ts` renders the panel's *stored* canvas through
`panelCanvasOwner` — its own canvas, the wall it follows, or `undefined` for the
built-in view — applies `keepWidgetsWithSomethingToSay` exactly as the device
endpoint does, and answers `no-store` behind the session. It is what the panel's
own page draws as "what the panel actually draws".

So a panel card is

```html
<img src="admin/epaper/:id/preview.png" alt="" loading="lazy">
```

and needs **no script at all**: no JSON, no post, no gallery entry point, and
`loading="lazy"` is the observer. It degrades to its alt text, which is rule
nine's "the worst a broken preview may cost is the picture" with nothing to
write.

**This is also what makes a following panel's card correct, which the draft
did not address.** A panel following a wall has no canvas of its own —
`readLayoutWidgets` against its id is empty — so the draft's "the panel's
stored canvas" would have posted `[]` and drawn an empty frame for exactly the
panel whose picture is somebody else's arrangement. `panelCanvasOwner` is the
one resolver shared with the device, so the card and the glass cannot disagree
about whose canvas a panel draws.

### 4.3 Lazily, which is the cost RFC 005 flagged — and the cost is per wall

`template-gallery.ts` renders as cards scroll into view, behind an
`IntersectionObserver` with a no-observer fallback, and says why: *"so a dozen
live walls do not all render at once (the cost RFC 005 flagged)"*.

That comment is about this page, and the cost here is larger than the gallery's
in a way the draft missed. A gallery draws fourteen templates against **one**
manifest. A Walls list cannot: zone, density and theme are per screen, so
**each browser card needs its own manifest**. Every browser card that scrolls
into view costs one `previewManifest(id)` build on the server — the whole
assembly, calendars, panels and all — and one `renderFreeform` in the browser.
Every panel card costs one 1-bit render on the server and nothing in the
browser. `display.css` is fetched once and shared across every shadow root.

So the budget is per wall on **both** sides of the wire, and a household with
six walls opening this page pays six builds, not one. The observer bounds it to
what is on screen, and above the fold the count is three.

### 4.4 What a preview must not become

- **Not live.** It draws once, from one manifest, and does not poll. A wall
  polls every 60s; six previews doing so would make the settings page the
  busiest client in the house.
- **Not a fallback for the wall.** A preview that fails draws nothing and the
  card keeps its name, chip, status and actions. Rule nine: the worst a broken
  preview may cost is the picture.
- **Not authoritative about colour.** The card draws the wall's theme because
  `applyTheme` writes the manifest's resolved theme onto the preview element
  (§9.3) — see §5.3 for the reason that sentence needs a test behind it.
  *Built:* "resolved" turned out to mean less than this bullet assumed, and
  §9.3 records the correction — the daylight window is the wall's own
  arithmetic, and the card repeats it.

## 5. The seams that break

### 5.1 The card stops being a bare link — and one shipped assertion says so

`wallCard` returns `<a class="card wall-card" href="…">` wrapping the whole
card. A `<button>` or `<a>` inside an `<a>` is invalid HTML and, in practice, an
element the keyboard cannot reach. So §3.3's trailing actions cannot simply be
added.

**The fix already exists one component along.** `listRow` puts a stretched link
behind the row and lets controls paint over it:

```
.mw-row-link::after{content:"";position:absolute;inset:0}
```

with the trail's buttons landing on top unaided, because `button,.btn` in this
sheet is already `position:relative` for its own pointer target — a coupling
`listRow`'s docstring in `components.ts` documents at length, including that a
`position:relative;z-index:1` on the trail was written, measured to change
nothing, and reverted. `browser-components.test.ts` guards it by **tapping the
row's own button and reading back what is under the finger**, which is the
assertion that goes red if `button,.btn` ever stops positioning itself. A wall
card adopts the same anatomy.

What this costs is an assertion in `admin-walls-list.test.ts` ("draws … as the
same link card"):

```js
expect(grid.match(/<a class="card wall-card"/g)?.length).toBe(2);
expect(grid).not.toContain('<button');
expect(grid.match(/class="card-go">Open/g)?.length).toBe(2);
expect(grid.match(/Last seen never/g)?.length).toBe(2);
```

That test is not incidental and must not be weakened casually: it pins the
*previous* redesign, where a panel's card was a static `<article>` carrying a ⋮
menu and an "Arrange layout" button **because a panel had no page to open**. Its
intent is "a card is not a control panel, and a panel's actions live on its
page", and A keeps that intent exactly.

The draft allowed "at most two trailing controls", naming **Finish pairing**
and **Design**. Neither survives §3.3: Finish pairing had no target, and Design
is what the card's own link already opens. So the allowance is tightened to
**at most one trailing control, from a fixed set — Pair it, Set up the device —
on the not-yet-paired card only**, and it is a link (`<a class="btn">`) rather
than a `<button>`, so `not.toContain('<button')` survives untouched. Fresh and
stale cards keep the card-go "Open" text and nothing else, and there is still no
⋮, no `<form>` and no `<article>`. The `Last seen never` count goes with it,
because §3.3 removes the string — phase 0 already moves it, when the list starts
reading the presence module. The test
keeps its name and its docstring gains a paragraph saying why the letter moved
and the intent did not.

### 5.2 `displaysPage` compares two clocks

`displaysPage` opens `const at = now()` — the app's injected clock. `lastSeenAt`
is stamped by `touchScreen` from a bare `Date.now()`.

In production those are one clock and no household sees anything. Under
`browser-harness`, which pins the app's `now` to today at `HARNESS_HOUR` in the
household's zone, they are hours apart — which is precisely the
`firstSyncPending` fault this codebase has already paid for twice
(`addCalendarSource`, and `equipHousehold` before it).

Today the page survives it, because `ago(null)` short-circuits and every wall on
a fresh harness is null. **§3.3 makes it load-bearing**: a browser test that
seeds a *fresh* wall to assert "Drawing now" compares a `Date.now()` timestamp
against a pinned `at`, and gets "not seen for 9 hours".

The repair is `touchScreen` taking the caller's clock, **undefaulted**, the
way `addCalendarSource` now does, and it touches both `/d/` routes. `createApp`'s
`now` is optional in `AppDeps`, so the two call sites read
`(deps.now ?? Date.now)()` rather than assuming one is injected. It is phase 0
rather than a footnote because a phase that writes the tests before the repair
will read the result as a layout bug for half a day.

### 5.3 A preview is the one thing here that can be wrong without looking wrong

This has already happened, twice, and both are written up in
`apps/display/src/preview-css.ts`:

- **A shadow root has no `<html>`, so `:root` matches nothing inside it.** Some
  fifty rules in `display.css` were silently dead in both admin previews. Every
  type token computed to the empty string, so `.hz-num` and `.dr-num` fell
  through to an inherited 12px where the wall draws them at 26.5 and 44.9px.
- **Colour was the one thing that survived**, because `applyTheme` writes its
  tokens onto the preview element directly — *"which is why it read as 'close
  but not quite' rather than as a broken preview"*.

A household reported the consequence as *"the samples are not accurate
representations"*, of cards drawing type **5.02x** too large.

The lesson is the one this page is about to depend on: **a preview measured
against itself cannot see itself drift from the wall.** §7 therefore compares a
card against a real paired wall rather than against a recorded number.

### 5.4 Three columns, and where the fold lands

The grid moves from `.g2` to `.g3`, which already carries its own step down to
two at 1040px and to one at 720px. A card gains roughly 200px of height for the
preview well, so the fold holds one row of three rather than two rows of two —
strictly fewer walls above the fold on a desktop, and the same one on a phone.

That is the trade A makes and it should be stated rather than discovered: **A is
a direction for a household with two to six walls.** §8 and §9 are what happens
if that is wrong.

## 6. Phases

Each is shippable alone and each leaves the page better than it found it.

**Phase 0 — the defects, which need none of this.**
1. `ORDER BY name COLLATE NOCASE` (§2.7).
2. `touchScreen` taking the caller's clock (§5.2). The second is what makes
   phase 2's tests meaningful, so it is not optional even though it is
   invisible.
3. **One pure presence module** (§2.2), read by all four sites that define
   "alive" today — the list's `seenLine`/`seenDot`, the wall page's status
   line, the panel page's, and the Overview's attention rows — so the list's
   states and §3.4's summary line are that function counted rather than a fifth
   vocabulary. The Overview keeps its one-day threshold, applied on top of the
   state, because "worth a row on the Overview" is a different question from
   "is it fresh".

**Phase 1 — the actions and the states. Shipped.** The action row (§3.1), the
three states and their per-kind links (§3.3), the summary line on two walls or
more (§3.4), the approve form demoted to a link, the revoked disclosure with
Forget and Forget all behind `confirmDestroyPage` (§3.5, which was phase 3
below), a panel following a revoked wall no longer drawing it (§3.5), the
stretched-link anatomy and the `admin-walls-list` amendment (§5.1).

The list **moves out of `admin.ts`** — 6,561 lines — into `http/admin-walls.ts`,
on the precedent `admin-ha.ts` and `admin-epaper.ts` set when their parents
grew past reading. No preview yet, no new script, no render cost.

**The vocabulary crawl is blind to a conditional section unless its harness
seeds it**, which this document's own history records twice. A never-paired
wall's card and the revoked disclosure are both conditional, so
`admin-vocabulary.test.ts`'s harness seeds **a revoked wall and a never-paired
one** in the same phase, and the mutation that proves it — "screen" put back in
the never-paired line — is run before the phase is called done.

**This phase alone closes findings 2.1, 2.2, 2.3, 2.4 and 2.7.**

**Phase 2 — the preview. Built, measured, refused.** The gallery script gains
a wall-card entry point for browser walls (§4.1), panels are an `<img>` on the
existing GET (§4.2), the grid becomes `.g3` (§5.4). This is the phase with a
cost in it and the one worth reverting if §9.1's measurement says so — and it
did. The whole of it, with its tests, is one commit in the PR that reverted
it, so un-reverting is one `git revert` of the revert; §9.1 says what was
measured and what the gate turned out to mean.

**Phase 3 — Forget. Shipped with phase 1.** The revoked list gains its delete:
both orientations' widgets and the row in one transaction, a decided answer for
panels following the forgotten wall, and `confirmDestroyPage` in front of it
(§3.5). It was to be last, as the first delete of a screen this application has
ever done; it went with phase 1 because the disclosure and the delete answer the
same question, and both Forget and Forget all are there — whether one Forget-all
would have been the whole feature is now something a household can say.

## 7. How this gets proven (verification is the job)

**A card is compared against a real paired wall, never against itself.** The
measurement pairs a wall, opens it at a known size, records the computed
`font-size` of an event name, a date numeral and the section label, then opens
`/admin/walls` and reads the same three off that wall's card scaled by the card's
own ratio. §5.3 is why the control is the wall and not a recorded number: the
5.02x fault was invisible to every assertion that compared a preview to itself.

**The three states are driven, not stubbed.** A browser wall with
`lastSeenAt = null` must render "Not paired yet" and a **Pair it** link to its
own page, and a panel "Waiting for its device" and **Set up the device** to its
recipes page; a wall touched a moment ago must render "Drawing now" (a panel,
"Checked in …") and no such control; a wall touched 30 days ago must render
neither. Driven through the real app with a real
session, and with phase 0 landed, or §5.2 makes the middle case unreachable.

**The card's own button is tapped, and what is under the finger is read back.**
`browser-components.test.ts` already does this for `listRow`; the wall card
inherits the anatomy and the assertion. A `pointer-events` or stacking
regression that made the stretched link swallow **Pair it** would
otherwise be invisible to markup.

**A panel card is decoded, not eyeballed.** The panel preview is a PNG from the
1-bit renderer; the assertion decodes it and holds the ink to the panel's own
canvas — and, for a panel following a wall, to *that wall's* canvas at the
panel's geometry, which is the case the draft's mechanism drew empty — which is what `epaper-*` tests already do and what the QR rule
("verify by decoding, never by looking") states generally.

**A failed preview costs the picture and nothing else.** With the preview
endpoint refused and the script blocked, the card must still carry its name,
chip, status line and actions. Rule nine, asserted rather than assumed.

**Every assertion is checked by breaking its own fix.** This document's own
review turned up four assertions in the mockups that could not go red; the
project's history is mostly that failure. In particular: the state assertions
must be checked against a wall in each of the three states, since an assertion
written only against `null` passes for a page that renders one state for all
three — which is what the page does today.

**And the thing this cannot prove:** nobody has looked at this list on a real
phone in a kitchen, or in a real supervisor's sidebar. By this project's history
that is where the next fault in a settings screen actually surfaces.

## 8. Rejected alternatives

Three other directions were drawn to the same fidelity and reviewed together.

**B — a dense list.** `dataTable` rows grouped by hardware, a
`Paired / Unpaired` segmented control, one action per row. It is the strongest
answer at 24 walls, needs no new component and no render work at all, and is the
only direction where the 18 get a place rather than a disclosure. Rejected
because it is **the one direction that cannot show what a wall draws**, which is
finding 2.5 and the finding most specific to this product. Kept in §9.

**C — grouped by state, with an action rail.** Sections for *Needs attention*
and *Drawing*, the two buttons in a sticky right-hand rail that fills the dead
column of §2.6. It closes findings 2.1–2.4 and 2.7 with no new component and no
render cost, and it is the cheapest direction by a wide margin. Rejected as the
*primary* framing because grouping by state moves a wall's position on the page
as its state changes, and because a household with two walls, one of them
waiting, gets two headings over one row each. Its rail and its state grouping
remain the obvious answer if §9.1 turns out badly.

**D — C's structure with A's preview as a row lead.** The preview moved into
`listRow`'s existing lead slot as a fixed 148×104 well, which removes A's one
new component. Rejected on what the well costs the picture: at 148px a preview
is a silhouette — portrait against landscape, a month grid against an agenda —
and cannot separate Classic from Meeting Room, which is the discrimination
finding 2.5 is about. D also authors two layouts for one page, which is the
divergence this codebase has paid for four times.

## 9. Open decisions

**9.1 — the render budget. Measured; phase 2 refused.** Six walls on a page
opened far more often than the template gallery, and the cost is per wall on
both sides (§4.3): six `previewManifest` builds and six renders, not one
manifest and six renders. The lazy observer and `loading="lazy"` bound it to
what is on screen, and phase 2 is separable precisely so this can be measured
and reverted. **The measurement counts server time per page view for a six-wall
household as well as browser time** — a budget that measures only the browser
would pass a page that makes the server assemble six manifests on every visit —
and **the measurement, not an opinion, decides whether phase 2 ships.** If it
fails, C is the fallback and it is most of the value.

*The gate, as set for the build:* phase 2 does not ship if the six-wall page
costs more than **three times the phase-1 page on the server**, or if the
above-the-fold cards are not drawn within **one second** on the runner.

*Measured, 2026-09-14*, by `apps/server/test/walls-list-budget.test.ts` — four
browser walls and two 7.5" panels, the three family calendars, a forecast and a
rota of `browser-harness` (`HOUSEHOLD_CALENDARS`, `equipHousehold`), on an idle
Apple M5 laptop, the phase-1 figure taken from the same tree with the phase-2
sources stashed and rebuilt. Server time is over loopback, timed at the
caller; warm figures are medians of five rounds after one cold round.

| | phase 1 | phase 2 |
|---|---|---|
| the page, warm | 2.0ms | 2.3ms |
| the six builds a page view asks for, warm | — | 18.0–18.4ms (2.5–2.6 per manifest, 3.8–4.0 per 1-bit frame) |
| page + builds, warm | **2.0ms** | **20.3–20.7ms** |
| page + builds, the cold first round | 2.2ms | 27.3–28.4ms |
| browser at 1280x800: `load` | 4ms | 27–29ms |
| first card drawn, from navigation start | — | 14–18ms |
| all cards above the fold (six of six, at that size) | — | 91–94ms |
| builds asked for by one page view | 0 | 6, exactly one per card |

**The server gate fails by a factor of ten** — 20.5ms against 2.0ms — and the
browser gate passes by a factor of ten. So phase 2 does not ship: it is
reverted in the PR that built it, with its tests, and the page is phase 1's.

**What the gate turned out to mean is worth one paragraph, because it decides
whether this is re-opened.** The phase-1 page costs two milliseconds. Three
times that is six, and a single manifest build is two and a half, so a gate
written as a ratio against this base admits one preview and refuses two: it is
not a budget for six previews, it is a decision that the list draws none,
taken before the base was known. The absolute number the gate was standing in
for is **twenty-one milliseconds of server time per page view** for a six-wall
household, which is less than a third of what those six walls already ask of
the server every minute by polling. The RFC's own concern — a page that makes
the server assemble six manifests on every visit — is true and is what the
twenty-one milliseconds are. Whether that is acceptable is a decision, and it
is one this document declines to take by itself: the gate was set in advance so
that an opinion would not, and it is applied as set. Re-opening it means
re-stating the budget as an absolute cost per page view (or per wall), because
no six-card design can meet the ratio, and the two ways of paying less both
cost the picture — one manifest for every card is not available, since zone,
density and theme are per wall, and drawing fewer cards is direction C.

Two things about the measurement itself. `previewManifest` is not injectable,
so the count is taken at the wire — one `preview.json` per browser card and
one `preview.png` per panel card, each of which is exactly one build by
reading both routes — and asserted, not merely printed, because it is the
structural claim (§4.3) and the one a later change could quietly double. And
the timings are printed on every run with no ceiling, because a wall-clock
ceiling measures the runner and this repository has written one down three
times; a ceiling is opt-in through `MW_WALLS_BUDGET_MS`.

**9.2 — what a household actually has.** Every trade in §5.4 assumes two to six
walls. Nobody knows: this product has no installation outside the author's own
testing environment, which is the premise RFC 015 §4 records for a different
decision. If ten-wall households turn out to exist, B is not a rejected
alternative but the answer, and A becomes what the page does under some count.

**9.3 — whether a preview follows the wall's daylight theme. Decided: it
draws what the wall is drawing right now — and the mechanism this section
named for it was wrong, which building it found.** It said `manifest.theme.active`
is "already resolved for that wall at now, daylight window included". It is
not. `buildManifest` resolves the *active* theme and the *daytime* theme each
to its tokens and shape and carries both, with the window's two clock times
beside them; the wall decides between them on **every draw**, in `main.ts`,
with `daytimeActive(localTime(now, manifest.timezone), …)` — because the switch
to the daylight theme has to wait for the sun and not for a calendar to change.
A card applying `active` alone would therefore have drawn a wall on Almanac by
day and Panels by night as Panels at noon, which is precisely what this
section set out to avoid. So the card repeats the wall's own arithmetic, the
same three arguments in the same order, and "no second reading of the window
in the browser" is amended to "the same reading, in the same code, in a second
browser". The clock it reads is the server's, the manifest's `generatedAt`,
not the admin browser's — a phone with a wrong clock would otherwise put
every card on a different day from the walls it pictures, and under the test
harness, whose server is pinned to eleven in the morning, the browser's own
clock put a daytime theme on the wrong side of its window. Measured, in
`browser-walls-previews.test.ts`: a wall on Almanac with Household from 09:00
to 17:00 draws Household on its card at the harness's hour, and goes red with
either half of the arithmetic removed. Still no control.

**9.4 — what a revoked wall's card looks like**, if phase 3 gives them a screen.
They have canvases too, and a preview of a wall nothing can draw is a photograph
of something that is gone.

## 10. Non-goals

- **Renaming from the list.** `TEST SCREEN` and `testtesttest` argue for it; it
  is the wall's own page's job and stays there.
- **Search or filter.** At six walls it is furniture. At the count that would
  justify it, B is the direction, not a search box bolted to A.
- **Anything on the wall itself.** No renderer changes, no manifest changes, no
  `EPAPER_RENDERER_VERSION` bump. A panel's pixels do not move.
- **Touching the add-a-wall or panel-add pages.** They are one shape already
  (RFC 009 phase 4, `add-display-parity.test.ts`) and this RFC only changes how
  they are reached.

## Appendix A — the claims this falsifies

Nothing in `CLAUDE.md` describes this page, which is itself worth noting: the
Walls list is reached from the sidebar by every household and is not documented
anywhere except the test that pins its card shape. The statements that do exist
and would move:

- `admin-walls-list.test.ts`, "draws … as the same link card" — §5.1.
- `displaysPage`'s comment "No app-bar action: … The pairing form is on this
  page, with the one filled Add wall." The pairing form has not been on this
  page since RFC 009 phase 4 moved it to `/admin/walls/new`; the comment
  outlived the code it describes. §3.1 replaces it.
- The wall page's status-line comment, "The five-minute freshness test is the
  one the list page has always used" — true of the number and false of the
  mechanism, since the literal is a copy nothing holds to the constant. Phase 0.

**`CLAUDE.md` gains a paragraph on this page in each phase**, in the current
state section, and every count it states — tests, files, browser-dependent
failures — is **measured on a clean run rather than added** to the previous
figure, which is the discipline that document spells out at length because the
incremented numbers are the ones that were wrong.

## Appendix B — the mockups

All four directions were drawn at fidelity in the admin's real tokens and
reviewed side by side before A was chosen. The drawings are not in the
repository; what they established is in §3, §5.4 and §8.

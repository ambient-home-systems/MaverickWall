# RFC 016 — The Walls list shows the walls

Status: **proposed** · Owner: — · First drafted 2026-09-14 ·
Relates to `apps/server/src/http/admin.ts` (`displaysPage`, `wallCard`,
`displayListCard`, `epaperListCard`, `seenLine`, `wallTemplatePreviews`),
`apps/display/src/template-gallery.ts`, `apps/display/src/preview-css.ts`,
`apps/server/src/api/queries.ts` (`readAdminScreens`, `readLayoutWidgets`,
`touchScreen`), `apps/server/src/http/admin-epaper.ts` (the panel preview
endpoint) · Builds on the free-form canvas (RFC 005), the component layer
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
`<a class="link">` inside `<p class="hint">` (`admin.ts:4685`, `:4688`), set in
the body role at 14.5px, in the middle of the prose that explains them, below
every card on the page.

Checking is a line that says nothing. `seenLine` renders
`Last seen ${ago(lastSeenAt, at)}`, and `ago(null)` is the string `'never'`
(`admin.ts:717`) — so on the household this RFC was opened against, **five of
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
   mechanism the template gallery already uses — and for a panel, through the
   frame endpoint the panel designer already posts to.
3. **"Never" becomes a state with a verb attached**: *Waiting for a screen*,
   with **Finish pairing** on the card.
4. **One quiet summary line** above the grid, in place of nothing.
5. **The revoked count becomes a disclosure** that can be read and cleared.

No schema change. No migration. No manifest change. The display bundle gains
nothing it does not already have; one admin module gains a second entry point.

**§2.7 is a shipped defect with no design decision attached and should not wait
on any of this.**

## 2. What the screen is today, counted

### 2.1 Both primary actions are prose

```
`<p class="hint">A tablet, monitor or television with Maverick Wall open in `
  … `<a class="link" href="admin/walls/new">Pair a new wall →</a></p>` +
`<p class="hint">Low-power e-paper panels are added the same way, with ` …
  `<a class="link" href="admin/epaper#add">Add an e-paper wall →</a></p>`
```

`p.hint` is `font-size:var(--mw-t-body-size)` — 14.5px, weight 400
(`html.ts:1065`). `.link` adds colour and nothing else: no height, no padding,
no container, and no 48px pointer target, which every `button`/`.btn` on this
page gets from `button::after` (`html.ts:826`). The one thing a household is
here to do is set in the same type as the paragraph explaining it, and is a
smaller tap target than "Continue" on the pairing-code form below it.

This section also sits **after** the card grid and the revoked line, so on a
phone it is reached by scrolling past every wall the household already has.

### 2.2 Five of six status lines say nothing, and "never" is two states

`ago(null, at)` returns `'never'`, unconditionally. `seenDot` (`admin.ts:747`)
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
`/d/epaper/:file` (`app.ts:1298`, `:1481`) — never from `/pair` — so
`lastSeenAt === null` means precisely **no screen has ever used this token**.
That is a claim this page can make without guessing, and it is the one it is
currently declining to make.

### 2.3 The largest number on the page is unreachable

```
`<p class="hint">${revoked} unpaired wall${…} kept for the record. ` +
`Their tokens no longer work.</p>`
```

On the reviewed household that is **18 against 6 shown** — three times as many
walls reported as displayed, in prose, with nothing to click. There is no route
in the admin to look at them, tell which was which, or clear them out.

### 2.4 The rarest action carries the most structure

`approveForm` is a full `section()` — heading, two lines of help, a labelled
field, a button — for the path taken when a *wall* starts its own device flow.
It is the same construction as "Add a wall", positioned below it, and it is the
last thing on the page.

### 2.5 Nothing distinguishes two walls but the name

`wallCard` (`admin.ts:4389`) is one shape for both kinds, and
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
text"* (`admin.ts:4586`). The same sentence is true of a wall.

### 2.6 The grid is 2-up from 721px to no limit

`.g2` is `repeat(2,1fr)` with one breakpoint, `@media(max-width:720px)`
(`html.ts:1072-1074`). `.content` is `max-width:1180px` (`html.ts:396`). So
between 721px and 1180px+ each card is roughly 550px wide and holds a name, a
chip and one short line — and above 1180px the remainder of the viewport is
empty page.

`.g3` already exists, with `repeat(3,1fr)` and its own 1040px step down to two.

### 2.7 The list is ordered by name, case-sensitively

`readAdminScreens` ends `ORDER BY name` (`queries.ts:942`) with SQLite's default
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
`EPAPER_SEEN_WINDOW_MS` 60 min) and different failure modes. On the list they
are separated by a 44px chip.

## 3. The decision

Direction **A**: the list shows the walls.

### 3.1 The two doors become buttons, in an action row

Directly under the app bar, above the grid:

```
[ + Pair a browser wall ]   [ + Add an e-paper panel ]   [ Approve a pairing code ]
      filled                       tonal                       ghost
```

Filled, tonal and ghost are the three emphases `html.ts:813-858` already
declares. The third is the demotion of §2.4: the approve form stops being a
section and becomes a link to one.

**Deliberately not the app bar.** `pageHeader` takes at most one action
(`components.ts:72`), and `displaysPage` carries a comment declining to use it
at all ("No app-bar action: see the Calendars page for the rule",
`admin.ts:4652`). Two equal doors cannot be one action, and this RFC is not the
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

Three states, from the table in §2.2, each with its own line and its own
trailing action:

| State | Line | Action |
|---|---|---|
| never used | *Waiting for a screen* | **Finish pairing** (tonal) |
| fresh | *Drawing now* + `dot-ok pulse` | Open |
| stale | *Last seen 30 days ago from 10.0.0.4* + `dot-idle` | Open |

"Waiting for a screen" is the wording rather than "never connected", because
the row cannot distinguish a pairing link nobody opened from a screen that has
never reached the server, and the household's next move is the same either way:
open the link on the screen.

A card in the waiting state takes `card.is-warn` — which moves the **edge** to
the warn hue and leaves the ground alone, exactly as `components.ts:489-496`
documents. Not a tinted card: a card is a 400px region and `--mw-warn-soft` is
sized for a chip.

### 3.4 One quiet summary line

`● 1 wall drawing now · ● 4 waiting to pair · ● 1 not seen for 30 days`

One line, body-small, above the grid. **Not three stat tiles**: this is a
calendar, and a 3-up row of big numbers is the dashboard idiom the design rules
already refuse on the wall. The line is derived from the same three states, so
there is no second definition of "alive" anywhere.

### 3.5 The revoked count becomes a disclosure

A `<details>` — the script-free idiom `/admin/chores` already uses for its
editor — listing each revoked wall with its name and when it was unpaired, one
**Forget** per row and a **Forget all** at the foot. Closed by default, so the
page is unchanged for a household with none.

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
from the wall's own stored canvas — `readLayoutWidgets(db, screenId, 'portrait')`
and the screen's `layoutAspect` — with `previewManifest(screenId)` as the
document. Both are already exported and already used by this file's neighbours.

**No second renderer**, which is the constraint this codebase states every time
two things draw one canvas (`shifts[0]`, `display_mode`, `cellEvents`, `mode`,
the Arrange backdrop). The gallery's own docstring makes the argument in full at
`admin.ts:4576-4592`, and every word of it transfers.

### 4.2 A panel posts for a frame, and does not learn a second renderer

A panel's card cannot be drawn in the browser: the 1-bit renderer lives on the
server. `template-gallery.ts` already faces this and answers it with
`panelPreview` — the card posts the boxes to the same endpoint the designer's
Arrange backdrop posts to and draws the PNG that comes back, which is the frame
the device would draw.

The Walls list uses the same endpoint with the panel's *stored* canvas, or with
none at all for a panel that draws the built-in view — which is the distinction
`renderScreenFrame` already makes between `undefined` (no canvas) and `[]` (an
empty one).

### 4.3 Lazily, which is the cost RFC 005 flagged

`template-gallery.ts` renders as cards scroll into view, behind an
`IntersectionObserver` with a no-observer fallback, and says why: *"so a dozen
live walls do not all render at once (the cost RFC 005 flagged)"*.

That comment is about this page. A gallery is opened rarely and holds fourteen
cards; the Walls list is opened often and holds as many cards as the household
has walls. The same observer is the same answer, and above the fold the count is
three.

### 4.4 What a preview must not become

- **Not live.** It draws once, from one manifest, and does not poll. A wall
  polls every 60s; six previews doing so would make the settings page the
  busiest client in the house.
- **Not a fallback for the wall.** A preview that fails draws nothing and the
  card keeps its name, chip, status and actions. Rule nine: the worst a broken
  preview may cost is the picture.
- **Not authoritative about colour.** The card draws the wall's theme because
  `applyTheme` writes its tokens onto the preview element — see §5.3 for the
  reason that sentence needs a test behind it.

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
`components.ts:532-540` documents at length, including that a
`position:relative;z-index:1` on the trail was written, measured to change
nothing, and reverted. `browser-components.test.ts` guards it by **tapping the
row's own button and reading back what is under the finger**, which is the
assertion that goes red if `button,.btn` ever stops positioning itself. A wall
card adopts the same anatomy.

What this costs is an assertion in `admin-walls-list.test.ts:113`:

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
page", and A keeps that intent exactly — a panel card gains **Finish pairing**
and **Design**, and everything else about a panel is still on its own page.

So the assertion changes from "no button" to a named allowance: at most two
trailing controls, from a fixed set, and still no ⋮ and no `<article>`. The
`Last seen never` count goes with it, because §3.3 removes the string. The test
keeps its name and its docstring gains a paragraph saying why the letter moved
and the intent did not.

### 5.2 `displaysPage` compares two clocks

`displaysPage` opens `const at = now()` — the app's injected clock. `lastSeenAt`
is stamped by `touchScreen` from a bare `Date.now()` (`queries.ts:1718`).

In production those are one clock and no household sees anything. Under
`browser-harness`, which pins the app's `now` to today at `HARNESS_HOUR` in the
household's zone, they are hours apart — which is precisely the
`firstSyncPending` fault this codebase has already paid for twice
(`addCalendarSource`, and `equipHousehold` before it).

Today the page survives it, because `ago(null)` short-circuits and every wall on
a fresh harness is null. **§3.3 makes it load-bearing**: a browser test that
seeds a *fresh* wall to assert "Drawing now" compares a `Date.now()` timestamp
against a pinned `at`, and gets "not seen for 9 hours".

This is pre-existing and out of this RFC's scope to fix properly — the repair is
`touchScreen` taking the caller's clock, undefaulted, the way `addCalendarSource`
now does, and that touches both `/d/` routes. It is recorded here because a
phase that writes the tests before the repair will read the result as a layout
bug for half a day. §7 orders them accordingly.

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

**Phase 0 — the two defects, which need none of this.**
`ORDER BY name COLLATE NOCASE` (§2.7) and `touchScreen` taking the caller's
clock (§5.2). Neither has a design decision attached. The second is what makes
phase 2's tests meaningful, so it is not optional even though it is invisible.

**Phase 1 — the actions and the states.** The action row (§3.1), the three
states and their verbs (§3.3), the summary line (§3.4), the approve form
demoted to a link, the revoked disclosure (§3.5), the stretched-link anatomy and
the `admin-walls-list` amendment (§5.1). No preview yet, no new script, no
render cost. **This phase alone closes findings 2.1, 2.2, 2.3, 2.4 and 2.7.**

**Phase 2 — the preview.** The gallery script gains a wall-card entry point
(§4.1), panels post for a frame (§4.2), the grid becomes `.g3` (§5.4). This is
the phase with a cost in it and the one worth reverting if §7 says so.

**Phase 3 — the revoked list earns its screen**, if the disclosure proves too
small for 18 rows. Deliberately last: it may turn out that Forget-all is the
whole feature.

## 7. How this gets proven (verification is the job)

**A card is compared against a real paired wall, never against itself.** The
measurement pairs a wall, opens it at a known size, records the computed
`font-size` of an event name, a date numeral and the section label, then opens
`/admin/walls` and reads the same three off that wall's card scaled by the card's
own ratio. §5.3 is why the control is the wall and not a recorded number: the
5.02x fault was invisible to every assertion that compared a preview to itself.

**The three states are driven, not stubbed.** A wall with `lastSeenAt = null`
must render "Waiting for a screen" and a **Finish pairing** control; a wall
touched a moment ago must render "Drawing now" and no such control; a wall
touched 30 days ago must render neither. Driven through the real app with a real
session, and with phase 0 landed, or §5.2 makes the middle case unreachable.

**The card's own button is tapped, and what is under the finger is read back.**
`browser-components.test.ts` already does this for `listRow`; the wall card
inherits the anatomy and the assertion. A `pointer-events` or stacking
regression that made the stretched link swallow **Finish pairing** would
otherwise be invisible to markup.

**A panel card is decoded, not eyeballed.** The panel preview is a PNG from the
1-bit renderer; the assertion decodes it and holds the ink to the panel's own
canvas, which is what `epaper-*` tests already do and what the QR rule
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

**9.1 — the render budget.** Six previews on a page opened far more often than
the template gallery. §4.3's lazy observer bounds it to what is on screen, and
phase 2 is separable precisely so this can be measured and reverted. **The
measurement, not an opinion, decides whether phase 2 ships.** If it fails, C is
the fallback and it is most of the value.

**9.2 — what a household actually has.** Every trade in §5.4 assumes two to six
walls. Nobody knows: this product has no installation outside the author's own
testing environment, which is the premise RFC 015 §4 records for a different
decision. If ten-wall households turn out to exist, B is not a rejected
alternative but the answer, and A becomes what the page does under some count.

**9.3 — whether a preview should follow the wall's daylight theme.** A wall on
Almanac between sunrise and dusk and Board after it draws two different pictures.
The card draws one. Probably the current one, probably without a control, and
this RFC does not decide it.

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
anywhere except the test that pins its card shape. The two statements that do
exist and would move:

- `admin-walls-list.test.ts:113`, "draws … as the same link card" — §5.1.
- `admin.ts:4652`, "No app-bar action: … The pairing form is on this page, with
  the one filled Add wall." The pairing form has not been on this page since
  RFC 009 phase 4 moved it to `/admin/walls/new`; the comment outlived the code
  it describes. §3.1 replaces it.

## Appendix B — the mockups

All four directions were drawn at fidelity in the admin's real tokens and
reviewed side by side before A was chosen. The drawings are not in the
repository; what they established is in §3, §5.4 and §8.

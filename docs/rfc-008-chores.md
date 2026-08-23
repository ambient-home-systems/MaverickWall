# RFC 008 — Chores

Status: **built (phases 1–3); unproven on real hardware** · Owner: — · First
drafted 2026-08-22 · Builds on `people`, the module registry (RFC 001), the
free-form canvas (RFC 005), and the one existing write path from a wall
(`POST /d/interrupts/dismiss`)

> **Update — phase 1 is implemented.** `packages/core/src/domain/chores/` holds
> the schedule model (the five cases below, `dueOn`, `dueDatesBetween`,
> `nextDueOn`, `describeSchedule` — pure, no clock, self-contained the way
> `domain/shift/` is); migration `0032` adds `chores` and `chore_completions`
> with the `(chore_id, date)` unique index; `api/chores.ts` is the storage
> layer and `http/admin-chores.ts` is the screen, in the Modules group beside
> Work Schedule. `packages/core/test/chores.test.ts` and
> `apps/server/test/chores.test.ts` drive it against a temp SQLite file and the
> real app — 46 assertions including the local-midnight case, the idempotent
> tick, and the absence of any way to tick a chore off *here*.
>
> **Nothing is on the wall yet**, which is phase 2, and nothing can record a
> completion from a screen, which is phase 3. `setChoreDone` and
> `completionDates` exist and are tested because the unique index is
> meaningless without something exercising it — the property they prove is what
> lets phase 3 post a tick with no client-side queue.
>
> Two things were found by building it, both by looking rather than by a test.
> The next-due readout said **"Not due again"** for a chore anchored beyond the
> window it had actually searched — the one sentence on that screen a household
> would act on, and a lie about a chore they had just created. And the first
> cut rendered every chore as a fully-expanded edit form: four chores made a
> 5,000px page whose real content was three lines each, and on a 390px phone a
> single card did not fit in the viewport — the wall editor's "scroll with no
> landmarks" fault, reintroduced one screen along. The editor is folded behind
> a `<details>` now (script-free, like the overflow menu), the weekday picker
> is one wrapped row rather than seven 48px rows, and a date field belonging to
> a kind the chore is not shows **blank** rather than today, because seeding it
> read as fact: a monthly chore displayed "Starting 23/08/2026", which was true
> of nothing.

> **Update — the two follow-ups phase 1 deferred are built.** Both were left
> out then for the same reason and are only honest now that a completion can be
> recorded.
>
> **The record.** `recentRecord` was written in phase 1 and removed before it
> shipped, because nothing could tick and the line would have structurally read
> zero. It is back, counted over **occurrences rather than days** — "Done 6 of
> the last 7 Tuesdays", because a weekly chore's denominator should be weeks and
> a monthly one's should be months. Today is excluded: the day is not over, and
> a screen that tells a household they are behind at nine in the morning is one
> they stop believing.
>
> **Pause.** `chores.paused` (migration `0034`, additive) suspends a chore and
> keeps its history — which is the entire difference from Remove, and the reason
> Remove now *asks*, names what it destroys, and offers Pause as the alternative.
> It did not ask before, and that was defensible while there was no history to
> destroy. `activeOn` is one rule shared by the board the wall draws and the
> endpoint that records a tick, so a paused chore can be neither drawn nor
> ticked and the two can never disagree about which.
>
> **Two faults, both the same shape, and the second was found by looking.** A
> chore created a minute ago reported "Done 0 of the last 7 times" — seven
> failures a household could not have committed, on the screen they had just
> used to create it; the window is clamped to the chore's own lifetime now. And
> a *paused* chore reported the same thing, for days it was on no wall and
> nobody could have done it. Both read as accusations for something the
> household chose. Freezing a paused chore's record at the moment of pausing
> would be better than hiding it and needs a `paused_at` column to know when
> that was — worth adding the day somebody asks, not worth inventing for a
> sentence nobody has missed.
>
> Dimming the paused card also dimmed *Resume*, which is the one control
> somebody opens a paused chore to press.

> **Update — phase 3 is implemented, and chores are complete in code.** The
> wall writes: `screens.allow_chores` (migration `0033`, additive, off by
> default) puts a real `<button>` beside each chore, and `POST /d/chores/tick`
> records it — behind `requireScreen`, household-wide, with the server as the
> authority exactly as `/d/interrupts/dismiss` is.
>
> **The endpoint refuses three things from the caller, and each is a bug it
> would otherwise have.** The *day*: a wall tablet's clock drifts and plenty
> never get NTP, so the client sends a chore and never a date, and a date sent
> anyway is ignored — a test posts yesterday and asserts today is what lands.
> Whether the chore is *due*: a completion for a day it does not fall on is a
> row that shows nowhere, refused rather than stored. And whether this *screen*
> may ask: the wall hides the control, but the display token is on the wall, so
> the check is here and the hidden control is only a courtesy.
>
> **Three faults, and two of them were only ever going to be found by
> looking.** The done box drew as an empty outline on a screen allowed to tick:
> `.ch-tick` clears its background so a button looks like the read-only box, and
> `.ch-box-on` fills that background — equal specificity, so source order
> decided it and the tick won. The read-only `<span>` filled correctly the whole
> time, which is what hid it, and the *class* was applied, so a measurement
> counting `.ch-box-on` passed while the pixels were wrong. That is the admin's
> button-states fault one surface along, and the rule it re-teaches is: assert
> on the computed background, never on the class. The focus ring was declared
> `:focus-visible` only and computed to **0px** after a tap — a heuristic
> written for a page with a pointer, on a wall that sets `cursor: none` and is
> driven by a D-pad; every other control here already declares both, which is
> the convention this one failed to copy. And `Enter` on a focused tick box
> would have fired the button *and* acknowledged a showing banner, two actions
> from one key.
>
> Two labels went stale the moment the second switch landed and were fixed with
> it: the settings section read "Whether this screen can clear alerts" and its
> panel "What this screen may do when an alert is showing", both describing half
> of what they now hold.
>
> One decision was reversed while writing the tests. A chore whose panel item
> carries no id was first *dropped*; it is now drawn read-only, because that is
> exactly what a screen without permission shows anyway — losing the control
> costs a household nothing they had, losing the chore costs them the thing they
> walked over to read.
>
> **Verified on a real screen in a real browser**, which is what this project
> counts: ticking off gives a read-only board (0 buttons, 6 boxes); the
> household's own switch turns it on; one tap marks the chore done in *both*
> widgets on the wall, filled in that person's colour and struck through; a
> second tap undoes it; `Enter` on a focused box works; and the tap target
> measures 44×44 while the drawn box stays 17px. **What remains is a real
> household's tablet** — by this project's history, that is where the next fault
> is.

> **Update — phase 2 is implemented.** The board reaches both renderers.
> `modules/chores/` is a panel module (no job, no `signals` — see below), whose
> slice is today plus six days with `done` per item; the wall gets a `chores`
> widget with three views (Today, By person, This week) and the panel gets
> `drawChores` at 1-bit. Both read the stored view *identically*, which is the
> whole of the e-paper calendar lesson, and `apps/display/test/chores.test.ts`
> holds them to each other by reading both sources. Still read-only: there is
> no way to record a completion from a screen, and a test asserts
> `POST /d/chores/tick` is a 404 so phase 3 has to notice.
>
> The ETag worry below turned out to be already satisfied and is worth
> recording rather than deleting: the chore panel travels inside `panels`,
> which is in `manifestEtag`'s preimage, and the manifest's own `days` carry
> dates — so a tick changes the ETag and midnight rolls it, with nothing added.
> A test pins the first half, because the property is load-bearing and free
> only by accident.
>
> **Three faults, all found by looking at a real wall in a real browser, none
> by a test.** The week board inherited the note widget's 0.3 scale floor and a
> week of four daily chores is 28 rows, so `fitToBox` duly shrank the names to
> **8.1px** on a 1280px display — not small, gone, and nobody would report it
> as broken. Three of four names in the by-person columns were ellipsised
> ("Put th…", "Hoover dow…") because a column is narrow by construction and the
> rows were built to ellipse like the wide views. And once the floor was raised
> so the box clipped instead, it clipped *through a row*, which reads as a
> broken renderer rather than as a list that ran out of room. The floor now
> lives in `density.ts` beside the other calibrated ones, with its measurement
> table; names wrap in columns; and the week trims to whole days and re-fits, so
> fewer days are drawn larger. The first attempt at that trim measured
> `.fw-content`, which sits *inside* the transform and is sized to its own
> content — so nothing was ever trimmed and the frame looked identical, which
> is exactly how that kind of mistake survives.

## Summary

A household wants chores on the wall. The instinct that prompted this RFC was
that **an interface in the Admin UI feels like the wrong place**, and that
instinct is right — but for a more specific reason than it first appears, and
the specific reason is the whole design.

A chore has two lifecycles, and they have nothing in common:

| | Defining it | Completing it |
|---|---|---|
| Who | the person who set the box up | anybody in the house, including a child |
| How often | once, then almost never | several times a day |
| Where | a phone or a laptop, sitting down | standing at the fridge, two seconds |
| What proves you may | the household account | being in the kitchen |

The Admin UI is exactly right for the left column and exactly wrong for the
right one. So the recommendation is not "put chores somewhere other than the
admin". It is:

- **Defining a chore is admin work** — `/admin/chores`, in the Modules group
  beside Work Schedule, assigned to the `people` who already exist.
- **Completing a chore is wall work** — a `chores` widget, and a tick that
  posts back behind the display token.

And the second half of that is the real decision this RFC is asking for,
because **the wall has been read-only until now**. Chores is not a request for
a screen. It is a request to make the wall a two-way surface, and that should
be decided deliberately rather than arrived at by adding a form.

## Why the admin feels wrong, stated precisely

Every screen in the admin today is a *rare* act: pair a display, add a
calendar, arrange a canvas, connect Home Assistant, pick a theme. Nothing on it
is done twice in a week, let alone twice in a day.

There is exactly one recurring interaction in the entire product — pressing OK
on an interrupt — and it deliberately does not live in the admin. It lives on
the wall, behind the display token, with no login, reachable by a television
remote. That was not an accident and the reasoning is already written down: a
household acknowledges a *thing*, from wherever they are standing, and the
control is a real button because a touchscreen, a keyboard and a remote all
have to work.

Ticking a chore is the same kind of act as pressing OK, and it belongs in the
same place. Putting it in the admin would mean: a child finds a device, opens a
browser, signs in with the household password, navigates a sidebar, and ticks a
box — to record something they did while standing in front of a screen that was
already showing it to them.

## The precedent that makes the write path safe

`POST /d/interrupts/dismiss` is the template, and it should be copied almost
line for line:

- It sits behind `requireScreen`, so the credential is the display token the
  screen already holds.
- Its effect is **household-wide**, not per screen — "a kitchen tablet and a
  hall television must not disagree".
- Whether a given screen offers the control is **per screen and off by
  default** (`screens.allow_dismiss`), because that is a fact about the
  hardware: a panel behind glass has no input, and a tablet at elbow height
  gets brushed by a passing sleeve.
- **The server is the authority, not the button.** A non-dismissible rule
  answers 403 even though the wall never drew a control for it. The display
  token is on the wall, where anybody can reach it, so the endpoint assumes the
  button was forged.
- On failure it does nothing and says so. Offline means the interrupt stays up,
  "which is the honest outcome".

Chores inherits all five. Concretely:

```
POST /d/chores/tick      { id, date }   →  behind requireScreen
POST /d/chores/untick    { id, date }   →  same
```

`screens.allow_chores`, a new boolean column, default false, on the Displays
settings panel beside "This screen can acknowledge alerts", worded the same
way. A wall with it off draws the chores widget read-only — the list is still
worth showing.

### Three judgements to make now rather than discover later

**A tick is a fact about a civil date, not an instant.** "Bins out Tuesday"
ticked at 23:50 on Monday must not count for Tuesday, and the day must roll at
local midnight in the household's zone. This is the `DTEND`-exclusive class of
bug and it will be got wrong by whoever writes it in UTC. `packages/core/src/time`
already has civil dates; the tick's stored key is `(choreId, civilDate)`.

**Which means the manifest ETag must include the civil-date bucket.**
`manifestEtag` deliberately drops `generatedAt`, so with nothing else changing
overnight a wall would keep serving yesterday's chores as a 304 until something
unrelated moved. The e-paper endpoint hit this exact problem and solved it the
same way — the civil date is part of the preimage.

**Do not build an optimistic offline queue.** A tick that cannot reach the
server should fail and leave the box unticked, exactly as `acknowledge` does.
A local queue sounds kinder and buys a distributed-state problem — two tablets,
one of them offline, both ticking, one of them wrong — for a feature whose
worst case is "tap it again". After a successful post the wall re-polls
immediately rather than waiting out the 60-second interval, which is what makes
the tap feel like a button.

## Identity: the trap is per-person logins

The obvious wrong turn is "each child needs an account so we know who ticked
it". It should be refused, for three reasons:

1. It breaks the one-account model that ingress auth depends on.
   `isTrustedIngress` falls through to the ordinary sign-in when there is more
   than one account, because there is then no way to say which user a Home
   Assistant visitor is. Adding family logins would silently disable the
   auto-login in the sidebar.
2. It puts a password on a fridge.
3. It buys nothing. The identity that matters is **whose chore was ticked**,
   not who was holding the tablet — and that is already answered by the chore's
   assignment.

Physical presence in the kitchen is the credential, the same as it is for
clearing a tornado warning. `people` is the whole identity model chores needs:
name, colour, avatar and sort order, already in the manifest, already drawn by
the wall in the person's own colour. `people` already owns two things — a
calendar source (`calendar_sources.person_id`, which is what puts an avatar
beside an event) and a shift rotation — so a chore assigned to Ella inherits
the colour her calendar and her rota are already drawn in, with no new
identity model and nothing new for the renderer to learn.

## Recurrence: a small vocabulary, not RRULE

A chore that repeats is a recurrence problem, and there is a hardened
recurrence engine in this repository already. It should not be used.

`packages/calendar` implements RFC 5545 — `COUNT`, `BYSETPOS`, `EXDATE`,
`RECURRENCE-ID`, `VTIMEZONE`. A chore needs "every day", "Tuesdays and
Fridays", "every 3 days", "the 1st of the month". Reaching for the general
engine would put a vendor library behind a household form and invite a failure
mode that cannot be explained in a kitchen: somebody types a rule, it expands
to nothing, and the wall is silent about a chore that exists.

The precedent is right there: **shift rotations have their own pattern model in
core rather than an RRULE**, despite calendars being the thing they are derived
from.

So: `packages/core/src/domain/chores/`, deliberately self-contained the way
`domain/shift/` is — importing nothing from core beyond civil dates, imported by
nothing else in core. Same seam, same reason: a household with no chores can
have the whole feature switched off, and it can be extracted later without a
refactor.

```
type Schedule =
  | { kind: 'daily' }
  | { kind: 'weekdays'; days: Weekday[] }     // ["tue","fri"]
  | { kind: 'everyNDays'; n: number; from: CivilDate }
  | { kind: 'monthlyDate'; day: number }      // 1..28, and 28 is the cap on purpose
  | { kind: 'once'; date: CivilDate }
```

`dueOn(schedule, date)` is a pure predicate over civil dates. The whole domain
is one file and a test file, and it has no clock in it — `now` is passed in,
the way the interrupt model takes its wall-clock reading.

`monthlyDate` capping at 28 rather than clamping 31 to "the last day" is a
deliberate refusal: a household that wants the last day of the month should get
a control that says that, not a number that behaves differently in February.

## Shape: chores is a module

`src/modules/chores/`, registered like weather and Home Assistant. This is
precisely what the registry describes — "a module owns a block key, a slice of
the manifest, usually a job, and a corner of the settings" — and it gets three
things for free:

- `ready()`, so a household with no chores never has the block on the wall.
- The per-module `try/catch` in `collectPanels`: a chore bug costs the chores
  panel and never the calendar.
- A nav entry in the Modules group, beside Work Schedule.

Shifts are *not* a module, but shifts predate the registry. The registry is the
newer and better seam and there is no reason to add a second special case.

**It should not implement `signals()`, at least not in v1.** A chore that raises
an interrupt is a wall that nags — "the bins were not put out" covering the
whole screen — and interrupts are deliberately reserved for a tornado warning
and a garage door left open at midnight. A wall that nags is a wall a household
turns off. This is easy to add later and very hard to take back.

The job is small and does exactly one thing: nothing. There is no state to roll
over, because a tick is stored against a civil date and "is it done today" is a
lookup, not a mutation. Resist the urge to write a midnight sweeper — a job
that clears yesterday's ticks is a job that destroys history, and it will
misfire in the one hour a year the clocks go back.

## The widget

A new `chores` type in `WIDGET_TYPES`, with views declared in `WIDGET_VIEWS`:

- **Today** — what is due today, grouped by person, with a tick box.
- **By person** — a column per person, which is what a family chore board on a
  fridge actually looks like.
- **This week** — a grid, people down the side and days across.

Not an extension of the existing `todo` widget. That one is a static checklist
edited in the admin, and it is a genuinely different thing: a note-shaped list
of one-off items with no assignment, no recurrence and no ticking. Two
renderers, two types.

Two traps that the codebase has already paid for once each:

**The default view is stored as an absence.** The e-paper calendar widget read
`mode === 'month'` while the editor stored `month` by leaving the key out, so
every "Show as" setting drew the same thing and the commonest setting was the
one that broke. Whatever reads a chores view must read it exactly as the wall's
renderer does, and the wall is the spec.

**The panel renderer is a second renderer.** `apps/server/src/epaper/widgets.ts`
draws its own 1-bit version of every widget type. A chores widget that ships
without one draws nothing on a panel. It should ship with one — and it should
**show, not tick**: an e-paper panel is documented as a glance class, a sleeping
ESP32 cannot honour a tap, and pretending otherwise would draw a tick box that
does nothing.

## What the admin screen actually holds

`/admin/chores`, and a new file `apps/server/src/http/admin-chores.ts`.

Not in `admin.ts`. That file is 4054 lines and has already needed one split
(`admin-ha.ts` exists for exactly this reason). Chores is the next feature that
would push it past where a person can read it, so it starts in its own file.

The screen is the Work Schedule screen's shape, because it is the same kind of
object — a list, an add form, an edit:

- A chore: a name, a person (or nobody), a schedule from the five above, and
  optionally a time of day it should appear.
- Reorder, edit, delete.
- **A history that is readable**, not a log: "Bins — done 6 of the last 7
  Tuesdays". A household will ask this and the answer should not require a
  database.

And under ingress a household member already signed in to Home Assistant
reaches this with no extra login, so "add a chore from your phone" is nearly
free. That is a consequence, not the design. The completion surface stays on
the wall, or the wall becomes decoration — and the calendar is the product
because the wall is where the household looks.

## Rejected: let Home Assistant own it

Home Assistant has a native `todo` entity domain (Local To-do, Shopping List).
The tempting version is: HA holds the chores, Maverick reads them.

Reading is free — it is the same read-only client that already reads calendars
and sensors. **Ticking is a service call, and rule 12 forbids it outright.** That
rule is a security property rather than a preference: a long-lived access token
has full control of a house and cannot be scoped, so the limit is on this side
and nothing in this repository issues a POST to Home Assistant.

So an HA-backed chores feature is display-only, which is precisely the half the
household is not asking for. It is a good *separate* thing later — "show the
shopping list" is a fine read-only panel, and arguably a recipe rather than
code — but it is not chores.

## Phases

**Phase 1 — the model and the definition.** `domain/chores/` with its schedule
predicate and tests. Migration: a `chores` table and a `chore_completions`
table keyed `(chore_id, civil_date)`. `/admin/chores`. Nothing on the wall yet.

**Phase 2 — the wall, read-only.** The module, the manifest slice, the `chores`
widget in all three views, the e-paper renderer, the civil-date bucket in the
ETag. A household can see today's chores and cannot tick them. This phase is
worth shipping on its own: it is already useful, and it gets the widget in front
of a real wall before there is a write path to argue about.

**Phase 3 — the tick.** `screens.allow_chores`, the two endpoints, the tick box,
the immediate re-poll. The smallest phase and the one with the most to get
wrong.

## The verification bar

By this project's history, none of the faults that matter will be found by
typechecking, and several will be found while the tests are green. The checks
that would actually find them:

- **Tick a chore on a real tablet on a real wall.** Pairing was broken on the
  add-on for months and was found by trying it. The tap target on a 10" tablet
  at arm's length is not something a DOM measurement settles.
- **23:59 in a non-UTC zone.** A test that ticks at 23:50 local and asserts the
  chore is done *today* and not tomorrow, in a zone that is not the runner's.
  This is the `DTEND` bug wearing a different hat.
- **Two screens.** Tick on one, poll the other, watch it go quiet. The dismiss
  path had to learn that the effect is household-wide; this one should be born
  knowing it.
- **A 304 across midnight.** Freeze nothing else and step the clock over local
  midnight; the ETag must change. This is the one that will ship broken if the
  civil-date bucket is left out of the preimage, and it will look like "the wall
  is stuck" rather than like a caching bug.
- **Forge the tick.** Post to `/d/chores/tick` from a screen whose
  `allow_chores` is off and assert 403. The wall hides the box; the box is not
  the control.
- **Read the panel frame.** Decode the e-paper PNG and assert the chore names
  are in the ink — "the frame changed" proves nothing, which the calendar-view
  bug demonstrated at length.

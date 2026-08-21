# RFC 007 — The agenda, redrawn (what to take from Calendar Card Pro)

Status: **proposed, nothing built** · Owner: — · First drafted 2026-08-21 ·
Builds on the display's widget model (`renderWidget`, `viewmodel.ts`,
`render.ts`) and RFC 005 (the free-form canvas)

> **Correction — there is no block model any more, and this RFC was drafted as
> if there were.** `main.ts` says it plainly: *"Every wall is free-form now —
> the responsive `auto` layout was retired"*. `renderDayRow`, `renderHorizon`
> and `renderWeekColumns` are reached only from `renderWidget`, and
> `display_blocks` no longer decides what a wall draws. Two consequences:
>
> - **Tier 1 is unaffected in substance and re-homed in fact.** It lands on the
>   Calendar widget's `list` style rather than on a NEXT block. Better, if
>   anything: one widget with three styles means the same polish reaches month
>   and week without being written three times.
> - **Phase 2 as written is void.** "A new key in `DisplayBlock`", the
>   `ensureBlock` insertion and the landscape-places-grids-by-name rule are all
>   auto-layout machinery that no longer renders anything. `week` is *already* a
>   first-class choice — it is the Style control phase 0 renamed. What survives
>   is the part that is genuinely missing: **the minimum-width fallback** (a week
>   widget dragged narrow today draws seven unreadable slivers) and tier-1 depth
>   for the week and month styles.
>
> The lesson is the one this repository keeps re-learning: `CLAUDE.md`'s
> "Current state" describes v0.1.x and the project is at 0.33.2. It was read as
> current, and the code was read to confirm details rather than to check the
> premise. The premise was the thing that had moved.

> **Update — phases 1 and 2 are built.** Phase 1 shipped in 0.34.0 (the date
> column's month, a per-calendar accent rule, a progress bar on a running event,
> "Day 2 of 4", "Nothing on"). Phase 2 is the revised one described in the
> correction above: the week style falls back to the agenda when a column would
> drop below 5rem — a floor calibrated by rendering the week at shrinking widths
> in a real browser and looking at it, not chosen. `density.ts` holds both
> floors as pure functions.
>
> Phase 2 also turned up a bug older than this RFC: **the agenda list overflowed
> its box by 212px in a narrow widget and its titles were simply cut off**, the
> classic grid blow-out (a grid item's default minimum is its content, so a long
> title refuses to shrink). The box's `overflow: hidden` made it look like a
> deliberate crop. Phase 1's accent rule added 34px to it and did not cause it —
> but the week fallback routes more walls down that path, so it is fixed here:
> `min-width: 0` down the chain, and the time stacks above the title when there
> is no room beside it.

> **Update — phase 3 is built, and it was not "one manifest field".** The
> forecast carried no date, only a provider name ("Monday", "Tonight"), so
> there was nothing to join an agenda day against. The date is threaded from
> both providers instead: NWS periods carry `startTime` local to the forecast
> point, so its date part is already the household's own calendar date and
> `foldPeriods` stays pure; Open-Meteo already had it. A missing date joins
> nothing rather than guessing.
>
> Writing the fixture in Open-Meteo's own shape found a live bug: it emitted
> `unit: '°C'` where NWS emits `'F'`, and the display adds the degree itself,
> so **every Open-Meteo wall read "20°°C"**. Two tests asserted `'°C'` and were
> confidently testing it — the same shape as the link-local case in `CLAUDE.md`.

## Summary

[Calendar Card Pro](https://github.com/alexpfau/calendar-card-pro) is a Home
Assistant dashboard card that draws an agenda better than we draw ours. This RFC
settles three questions about it, in order, because the answers get less
comfortable as they go:

1. **Can we legally use it?** Yes, unambiguously. MIT.
2. **Can we port the code?** No, and not marginally — the parts we want are
   1,200-odd lines of lit templates sitting on top of 15,000 lines we would
   delete.
3. **So what do we actually take?** About half the design. The other half is
   dashboard-card behaviour that would make a wall worse.

The recommendation is a **design port in four phases**, of which the first is
contained entirely in `apps/display` with no manifest change and no migration,
and the second — **a week block, seven days side by side** — is the biggest gap
in the product's zoom pyramid today. A **phase 0** goes ahead of both: renaming
the free-form calendar widget's "Show as" control to **"Style"**, which is one
line and wants doing before the diff that touches that panel for real.

**We copy no code.** That is a design choice and not a legal one; see
[Attribution](#attribution).

## The licence, settled

MIT, `Copyright (c) 2025 Alex Pfau`. MIT into AGPL-3.0 is a one-way compatible
move: we may copy, modify and ship under our own licence, provided the copyright
line and the MIT permission notice travel with whatever we derive, and `NOTICE`
names it.

Two things to know before anybody leans on that:

- Their own `NOTICE` credits **lit** (BSD-3-Clause), **Home Assistant Frontend**
  (Apache-2.0) for interaction patterns, and — the interesting one — the *visual
  design* as inspired by community member @kdw2060's button-card calendar. The
  look has a lineage and we would be the third link in it.
- **A layout is not the copyrightable part.** A date column, a coloured accent
  rule, a progress bar on a running event: those are ideas, and free to anyone.
  MIT only binds us if we copy *code*. The next section is why we won't.

So the licence question, which is the one that usually kills this sort of thing,
is the one part of this RFC with no risk in it.

## Why the code cannot be ported

16,419 lines of TypeScript under `src/`. Every file in `src/rendering/` imports
`lit`. Runtime dependencies are `lit@3.3.2`, `dayjs@1.11.x` and `@mdi/js@7.4.x`.

| Blocker | Detail | Rule |
|---|---|---|
| Framework | `lit` custom element, `css` tagged templates, `ha-card` / `ha-ripple` host | 1, 3 |
| CSS vintage | 3 `:has()` selectors, 5 `color-mix()` calls, logical properties throughout | 2 |
| Redundant layer | `utils/events.ts` — 1,525 lines fetching and caching the HA calendar REST API | — |
| Dead weight | `src/rendering/editor/` is 5,412 lines of `ha-form` schema, plus 35 language files | — |
| Wrong distance | px font config, `height` / `max_height` / scrolling, tap and hold actions | — |

Take those out and `src/rendering/{styles,render,leaves,column,presentation}.ts`
— 2,883 lines — is what remains, and it is expressed against a `hass` object and
a lit render tree. There is no seam at which it detaches.

The CSS blockers are the *easiest* part, which is worth saying plainly so nobody
mistakes them for the reason: all three `:has()` selectors do one job (hang the
indent when a title carries a glyph label), and a class set at render time does
it with no `:has()` at all. `utils/helpers.ts:51` builds tints with
`color-mix(in srgb, …)` for exactly the reason we *rejected* it — a `var()`
reference cannot be decomposed into `rgba(...)` — and `theme.ts` already solved
that by pre-mixing per theme against that theme's own background. We have the
answer; we just have it in a different shape.

**This is a design port, not a code port.** Which is the cheaper of the two, and
means the MIT obligation most likely never attaches at all.

## What is worth taking

Sorted by what it costs us, not by how good it looks. "All of these designs" is
not the answer and pretending otherwise would cost us a phase.

### Tier 1 — transfers nearly free

Contained in `render.ts`, `display.css` and `theme.ts`. No manifest field, no
schema change, no migration.

- **The date column.** Weekday / day number / month stacked at the left of each
  day group, with a vertical accent rule in the calendar's colour. This is the
  signature look and most of why the card reads as clean rather than busy. Our
  NEXT block already groups by day; it draws the date as a heading instead.
- **A progress bar on a running event.** `startsAt`, `endsAt` and now are all in
  `ManifestEvent` already. This is a genuinely good wall feature — "how much of
  this is left" is legible from a doorway in a way a time range is not.
- **Today indicator**, **day separators**, and **empty-day treatment**. Their
  "nothing on" is a stated fact rather than a gap, which is the argument this
  project already made for rest days: `shiftFor` emits a synthetic `break`
  precisely because an absence and a fact are different things. Same reasoning,
  different block.
- **Multi-day position.** We carry `continues: boolean` and never say *"day 2 of
  4"*. The manifest has enough to say it.

### Tier 2 — real features, worth building

- **Column view — a `week` block.** Seven days side by side, one column each, so
  a week reads across the wall rather than down it. This is the missing zoom
  level between `next` (a stacked list of the next few days) and `horizon` (six
  weeks as colour), and the natural landscape and television layout, where we
  currently put a list in the left column and have space to spare.

  **Half of this already exists, in the wrong place.** RFC 005 shipped
  `renderWeekColumns` ([`render.ts`](../apps/display/src/render.ts)) as the
  `week` mode of the free-form calendar widget — weekday, day number and event
  pills, drawn off `model.horizon[0]`. So phase 2 is not "build week columns"; it
  is **promote the renderer to a first-class block in the auto layout, and give
  it the depth the agenda design calls for** — the date column of tier 1, the
  minimum-width fallback below, weather, week numbers. That is a smaller and
  better-founded phase than it looked before somebody read the file.

  Their responsive rule is worth copying wholesale as *reasoning*: a day column
  has a minimum readable width, and a card too narrow to give every day that
  much room **falls back to the list layout**. That is the same shape as
  `orientation.ts` — a computed answer from real measurements, not a media query
  — and it should live beside it as a pure function for the same reason. The
  free-form widget needs it too: a week widget dragged narrow today draws seven
  unreadable slivers rather than falling back to anything.

- **Weather beside the date, not in its own strip.** The weather module already
  supplies the data. Putting the day's high/low against the date in the agenda
  buys back an entire block's worth of wall, and is a `viewmodel.ts` change plus
  one manifest field rather than a new provider.

- **Week numbers.** Pure computation from a civil date. `packages/core/src/time/civil.ts`
  has `dayOfWeek`, `toEpochDay` and `floorMod` and no week-number function;
  `household_settings.week_start` already exists and already reaches the
  manifest. This belongs in core, not in the display.

### Tier 3 — do not take

Listed because each one is individually tempting and collectively a different
product.

- **The visual editor** (`src/rendering/editor/`, 5,412 lines). Our admin is
  server-rendered with no build step, and RFC 005's free-form editor already
  covers "arrange it yourself".
- **`utils/events.ts`.** The manifest supersedes it entirely — we expand
  recurrence server-side and the wall receives resolved events.
- **dayjs and 35 languages.** dayjs in the display bundle is a rule 1 problem in
  core and a rule 3 problem in spirit. We have no i18n story at all today; when
  we want one it is `Intl`, which is already this project's stance on zones.
- **Tap actions and ripples.** A wall is not interactive except the OK key, and
  `cursor: none` is deliberate.
- **`height` / `max_height` / scrolling.** The wall measures itself against the
  viewport and must not overflow. A month grid missing its last week looks
  deliberate, which is why we measure `scrollHeight` against `clientHeight`
  rather than looking.

## The one real risk

Their design is tuned for a card in a dashboard, read at arm's length, where
dense 12–14px type is correct. Ours has to carry from a doorway.

The date column and the accent rule scale up fine. The location and description
line limits, the badge font sizes, the 14px icons and the 60px progress bar do
not — and lifting those numbers is how we get a wall of 5px text on a television
again, which is a bug this project has already shipped once. **Every size wants
re-deriving against the rem basis**, which is `vh` in portrait and `vw` after a
quarter turn. That is not a caveat to note in passing; it is most of the work in
phase 1.

## Phases

**Phase 0 — "Show as" becomes "Style".** One line in the free-form editor, no
dependency on anything below, and it wants doing *before* phase 2 rather than
after. Its own section follows.

**Phase 1 — the tokens and the day group.** Date column, accent rule,
separators, progress bar, today indicator, empty day, multi-day position. All
inside `apps/display`. No server change.

**Phase 2 — the `week` block.** A new key in `DisplayBlock` alongside `now`,
`weather`, `home`, `next`, `horizon`, reusing and deepening the existing
`renderWeekColumns`. Two consequences fall out of the existing model and neither
is optional:

- The order is stored per household (`display_blocks`, default
  `now,next,horizon`), so **a block that did not exist when they last saved can
  never appear on an existing wall.** Turning it on has to *insert* it, the way
  `ensureBlock` in `modules/homeassistant/store.ts` does.
- Landscape places the month by name rather than by position, because it is the
  widest thing and the only block that is itself a grid. A week block is the
  second such thing, and the layout rules need an opinion about what happens
  when both are present before the block ships, not after.

**Phase 3 — weather in the agenda.** One manifest field, a `viewmodel.ts`
change, a settings control for where the household wants it.

**Phase 4 — week numbers** in `packages/core/src/time/civil.ts`, honouring
`week_start`.

Phases 1 and 2 are where nearly all the visual payoff is. 3 and 4 are small and
can slip without hurting anything.

## Phase 0 — "Show as" becomes "Style"

The free-form calendar widget's presentation control is labelled **"Show as"**
([`layout-editor.ts`](../apps/display/src/layout-editor.ts), `buildCalendarConfig`)
and offers *Month grid / Week columns / Upcoming list*. It becomes **"Style"**.

**Why, beyond preference.** The three options are the same events at three
presentations, so the control belongs with the other presentation controls in
that panel — Corners, Drop shadow, Background colour — rather than reading as a
content filter, which is what "Show as" sits next to ("Calendars to show",
"Readings to show", "Events in a day"). One word also survives a narrow config
panel where a two-word phrase wraps. And it generalises: the moment a second
widget grows a presentation choice, "Style" is the label it will want, and two
widgets calling the same idea two different things is the kind of drift that is
free to prevent now and annoying to unpick later.

The counter-argument, stated so it is not rediscovered: every other label in
that panel is a plain-language phrase rather than a noun, and "Style" is the
first abstraction among them. That is a real cost and it is accepted — the
grouping argument wins, because a household scanning the panel is looking for
*where the appearance controls are*, not reading it as prose.

**Scope: the visible label only. The stored key stays `mode`.**

This is the part that matters and the part that is easy to get wrong. `mode` is
persisted inside `household_settings.layout_widgets`, in the JSON of every
canvas any household has already arranged. Renaming the key would mean:

- a migration that rewrites JSON blobs — and this repository has already learned
  what a generated table-recreate can do to data that looked fine
  (`0009`, and the reason is written in the file);
- `widgetConfigBody` (`apps/server/src/api/widget-schema.ts:42`,
  `mode: z.enum(['month','week','list']).optional()`) accepting both spellings
  for a release, or every existing canvas silently falling back to `month` —
  a wall that changes overnight for no reason the household can see;
- the same widening in the epaper widget reader
  (`apps/server/src/epaper/widgets.ts:299` reads `str(config, 'mode')`) and in
  `templates.ts`, which validates a gallery template through the same schema.

Three files and a migration, for a key nobody sees. **Not worth it.** The label
is the product surface; the key is an implementation detail that is already
correct. `corners` and `cellEvents` set the same precedent in that panel —
`'month'` and `'square'` are stored as *absence*, and the stored vocabulary has
never had to match the printed one.

**The change, in full:**

- `layout-editor.ts` — `cfgField('Show as')` becomes `cfgField('Style')`. One
  line. The option labels are unchanged.
- Grep for the string first; today it appears in exactly two tracked places,
  the other being RFC 005's Part C, which describes the control as built.
- **RFC 005 is not rewritten.** It is an as-built record of a shipped decision,
  and this project's convention is an `> **Update —**` block at the top rather
  than editing the body under somebody who has read it. One line there, pointing
  here.
- No test asserts the label today. Whether one should is a fair question and the
  answer is probably no — a census test that pins UI copy makes every future
  wording change a two-file edit, and the label is not a security property the
  way the script-set census in the wizard is.

**Why before phase 2.** Phase 2 promotes `week` out of this widget and into the
block list, which means touching `buildCalendarConfig` and its neighbours
anyway. Doing the rename first means the diff that adds a block is not also a
diff that renames a label, and a one-line cosmetic change does not end up
buried in a layout change where nobody reviews it.

## Verification

This project's own bar, applied to a change that is entirely about how things
look — which is the case where "it looked right" is most tempting and has been
wrong most often:

- **Measure the DOM, don't look at it.** `scrollHeight` against `clientHeight`,
  in both orientations, with three blocks and with four, and with a banner
  present. Four separate shipped bugs are in that sentence.
- **A rest day is a fact.** The empty-day treatment needs a test whose assertion
  matches its name, because the last time we drew an absence the test asserted
  the empty list that proved the bug.
- **The week block against a real feed**, not invented events — a school
  district feed with all-day events is where `DTEND` exclusivity bites, and a
  column layout puts every off-by-one directly beside its neighbour where it is
  visible.
- **Landscape and portrait are different layouts**, so both, and both through a
  quarter turn, where the rem basis switches from `vh` to `vw`.

## Attribution

If we take design only, credit is courtesy rather than obligation — and we
should give it anyway, naming Calendar Card Pro and carrying the @kdw2060 link
their own `NOTICE` carries.

If any file ever does derive from their source, it needs the MIT notice in the
file and an entry in `NOTICE`. Worth noting that `test/addon-repository.test.ts`
now refuses any tracked file ending in ` <number>`, which is what would catch a
stray copied file arriving by sync collision — two duplicate licence files
already shipped that way once.

## Open questions

- **Does `week` replace `next`, or sit beside it?** They are the same events at
  two densities. A household with both is showing tomorrow twice. Leaning
  toward: both keys exist, the settings page says plainly that they overlap, and
  we do not enforce it — the household owns the density, per the existing
  argument.
- **Where does the progress bar go in free-form?** RFC 005 widgets reuse the
  calendar section at canvas width and scale down. A 60px bar scaled to a small
  box is a smear. Probably: the bar is a property of the section and disappears
  below a width threshold, which is a rule the section can own.
- **Per-event glyph labels** (an emoji or icon matched from the title) are
  charming and are a rule 3 question the moment they become images —
  `/d/media` exists and is already the answer for uploaded images, so this is
  probably fine, but it is not phase 1 and should not sneak in.

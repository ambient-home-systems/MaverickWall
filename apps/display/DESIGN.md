---
name: Maverick Wall — Display
description: The kitchen calendar wall, read at a glance from across a room
colors:
  # Frontmatter carries the DEFAULT theme, Panels (dark). The other four themes
  # (Household, Blueprint, Almanac, Swiss) are pure token swaps — same keys,
  # different values — documented in prose below and in .impeccable/design.json.
  ground-slate: "#14181E"
  panel-slate: "#1B212A"
  rule-steel: "#2A323E"
  ink-bone: "#EDEBE6"
  muted-blue-grey: "#9AA5B2"
  faint-blue-grey: "#7E8A99"
  accent-sky: "#5C93E0"
  scaffold-grey: "#9B9B9A"
  shift-day-amber: "#E8A33D"
  shift-night-blue: "#5C93E0"
  shift-break-green: "#35916A"
  shift-straight-slate: "#6B7684"
typography:
  # `fontFamily` below is the *body* stack, which every role shares. The
  # **display** face is a per-theme swap on `--disp`, and four are bundled and
  # `@font-face`d in `display.css`: Roboto Flex condensed (Panels, Blueprint),
  # Space Grotesk (Household), Fraunces (Almanac), and Oswald — which is the
  # brand wordmark's face, outlined to paths at build time, and never a body
  # face. Naming only the first here is what made the mechanical detector
  # report three "fonts outside DESIGN.md" that the wall has always shipped.
  display:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
    # Per theme: `var(--disp)` — Roboto Flex condensed · Space Grotesk (Household)
    # · Fraunces (Almanac). See "Typography" below.
    fontSize: "var(--t-wall-clock, calc(var(--t-event) * 1.8))"
    fontWeight: 700
    lineHeight: 0.82
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
    fontSize: "3.6rem"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.005em"
  title:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
    fontSize: "var(--t-wall-lede, var(--t-event))"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
    fontSize: "var(--t-base)"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "normal"
  label:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
    fontSize: "var(--t-wall-label, 1.25rem)"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0.22em"
rounded:
  # Corners are a **theme property** plus a small set of chip radii, not one
  # global ladder — `The Cell-Is-Not-A-Card Rule` below is why. Listing only
  # three values described a scale the wall does not have: seven of its radii
  # were off it.
  none: "0"                 # Blueprint, Almanac, Swiss — and every month cell
  chip-dense: "0.12rem"     # .sk-bar, the compact month's event bar
  chip: "0.15rem"           # .sk-ev, the compact week's event
  mark: "0.2rem"            # today's knocked-out numeral on the compact month
  swatch: "0.25rem"         # the rota legend's colour block
  pill: "0.28rem"           # .hz-pill and .wc-ev, an event on a month/week cell
  box: "0.3rem"             # a chore's and a to-do's tick box
  theme: "var(--radius)"    # 0 · 0.35rem (Household) · 0.4rem (Panels)
  card: "0.4rem"            # Panels' own --radius, and the fallback for it
  widget: "0.6rem"          # the household's own "rounded corners" control
  full: "50%"               # identity dots, initials chips, face crops
spacing:
  # In em of the wall's event role (--sp), so spacing follows the reader's angle.
  s0: "0"
  s1: "0.14em"
  s2: "0.28em"
  s3: "0.5em"
  s4: "0.85em"
  s5: "1.4em"
components:
  banner-alert:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.ink-bone}"
    rounded: "{rounded.card}"
    padding: "0.9rem 1.4rem"
  alert-ack:
    backgroundColor: "transparent"
    textColor: "{colors.accent-sky}"
    rounded: "{rounded.card}"
    padding: "1rem 2.2rem"
  month-cell:
    backgroundColor: "transparent"
    textColor: "{colors.ink-bone}"
    rounded: "{rounded.card}"
    padding: "0.45rem 0.5rem 0.4rem"
---

# Design System: Maverick Wall — Display

## Overview

**Creative North Star: "The Legible Fixture"**

The display is a fixture in a house, not an app on a screen. It hangs on a
kitchen or hallway wall, has no pointer (`cursor: none`), redraws itself on a
~15-second tick, and runs unattended for months. Every decision in this system
serves one thing: being read at a glance from one and a half to three metres
away, by someone who did not walk over to operate it. The interface recedes and
the calendar is the object. The register is **quiet, architectural, and exact** —
restraint is the point, precision lives in the small details, and nothing on the
wall is allowed to compete with what the household actually came to read.

The system is a set of five pure token themes over one stylesheet that is flat
and still **by default**. When this document was first written there was
no elevation, no animation, no shadow and no emoji anywhere a screen renders
— not as taste but as physics: the panels are e-ink and OLED as often as they are
tablets, a shadow bands on one and burns in on the other, a panel cannot animate,
and an emoji set as text is a third-party asset that resolves differently on
every device. **The owner's decisions of 2026-09-24 (D1–D9, recorded in
`docs/plan-2026-09-household-review.md`) keep the physics and change what
follows from it on a browser wall**: a shadow is a theme token a theme or an
e-ink preset can switch off, motion is phase-locked to the wall clock and gated
by reduced motion and a per-wall switch, emoji are bundled artwork drawn as an
image rather than a device font, and gradients are allowed. An e-paper panel
keeps every one of the old rules.

The most radical decision is that **type is sized by the angle it subtends at
the reader's eye** (arc-minutes derived from the panel's real size
and the reader's distance), not by a pixel count — so one design is correct from
a 7.5-inch e-paper tag to a 43-inch television.

The confirmed anti-reference is **the SaaS dashboard**: no rows of stat tiles,
no KPI cards. This is a calendar. The wall's job is the single thing the
household does *not* already know — an event name — and the things they do know
(the time, the date) are deliberately demoted beneath it. Decision D1 carves out
one thing: a *designed widget style* (the weather "Today" card, a countdown's
number) may make **one** reading its lede, capped against the event role the way
the clock is. A big number with no cap, or a row of them, is still the
dashboard.

**Key Characteristics:**
- Read from across a room; legibility is a physical angle, never a fixed pixel.
- Flat and still by default: separation is space, then a 1px rule, then a ground step. A shadow, a gradient or motion is something a theme or a style a household picks lays on top — on a browser wall only, never on e-paper.
- Five themes, pure token swaps; nothing outside `theme.ts` names a colour.
- The event name is the hero; the numeral and clock are capped beneath it.
- First-party and offline: every face, glyph and emoji picture ships in the image; nothing is fetched and nothing is left to the device's own fonts.
- Degrades by showing less, never by overlapping, clipping through a row, or going blank.

## Colors

A calendar wall's colour does one job — it tells you *whose* something is and
*whether* a day is claimed — over a near-neutral ground that keeps the type
loud. Per-person and per-calendar colour does the heavy lifting; the theme
supplies a restrained ground, one accent, and four rota hues. There are five
themes, all pure token sets: the same keys with different values, so a theme swap
is a token swap and changes no logic. The frontmatter carries the default,
**Panels**; all five are catalogued below.

### Primary (accent — one per theme)
The accent is the wall's single highlight. It marks the next event and the
current-time rule, and nothing else. Each theme carries its own:
- **Sky Blue** (`#5C93E0`, Panels — default): the steel-blue highlight on the dark modular ground.
- **Burnt Sienna** (`#B5651F`, Household): a warm accent for the daylight-paper theme.
- **Steel Blue** (`#5980A6`, Blueprint): the bound design-system-as-a-wall.
- **Almanac Red** (`#B3372B`, Almanac): the paper-ledger red; this is the daylight-scheduled theme.
- **Signal Amber** (`#FFB224`, Swiss): the one colour on a near-black typographic ground; also the brand mark's hue.

### Secondary (rota / shift hues)
Four hues name a work pattern; they wash a cell as a tint and edge a row/badge.
Default (Panels) values, darkened per light theme until each clears 4.5:1 on that
theme's own ground:
- **Day Amber** (`#E8A33D`), **Night Blue** (`#5C93E0`), **Break Green** (`#35916A`), **Straight Slate** (`#6B7684`).

### Neutral
Per theme, four inks and two surfaces. Panels (default):
- **Ground Slate** (`#14181E`): the page behind everything.
- **Panel Slate** (`#1B212A`): a card/panel surface, one ground step up.
- **Rule Steel** (`#2A323E`): the 1px week rule and dividers.
- **Ink Bone** (`#EDEBE6`): event names — the one thing at full ink.
- **Muted Blue-Grey** (`#9AA5B2`): times, labels, secondary readings.
- **Faint Blue-Grey** (`#7E8A99`): out-of-month dates, notes, deliberately quiet.

### Emphasis roles (the type hierarchy, per theme)
Four roles let the stylesheet say which ink a piece of text gets without a colour
at the call site:
- **`--ink-event`** = full ink. Event names only.
- **`--ink-scaffold`** = a demoted ink for date numerals, weekday heads, week numbers, rota chips. Present, legible, never competing. Panels `#9B9B9A`; Household `#706C65`; Blueprint `#6C6D6E`; Almanac `#76716B`; Swiss `#A2A2A2`.
- **`--ink-quiet`** = an overflow count, and the event names on a day that has already happened (`= --muted`). It read *nothing at all* for a while: both of its documented uses were unwired, so a counter was drawn in `--faint` — the sub-bar token — at 2.04:1 on Household. A past event's *time* still has no treatment; the stylesheet's only rule for one matched markup no renderer had emitted since the day block was retired, and is deleted rather than left to read as an implementation.
- **`--rule-week`** = the one hairline per week row (`= --rule`).

### Named Rules
**The One Accent Rule.** The accent marks the next event and the current-time
rule and nothing else. Its scarcity is what makes "next" and "now" read as one
idea across a room — **and only half of it is built.** The current-time hairline
draws; the accent on the *next* event does not, and has not since the day block
was retired. There was a `.te.is-next` rule for it matching an element nothing
emits, which is worse than an absence because it reads as an implementation; it
is deleted. The pairing is still the design and the missing half is an open
decision, not a selector quietly waiting.

**The Scaffold-Contrast Rule.** `--ink-scaffold` is not a fixed mix ratio. It
starts at `mix(ink, bg, 0.62)` and the ratio is raised, per theme, until the
result clears **4.5:1** against that theme's own background — because a fixed
wash reads as low as 1.90:1 on a cream ground that the same wash reads fine on a
dark one. A custom theme's scaffold is derived the same way at token-build time.

**The One Sub-Bar Exception.** Exactly one *token* is allowed below 4.5:1:
`--faint` (on Swiss, `#3F3F46`, ~1.91:1). It has two jobs and both are the same
job: a day belonging to the next month, and the date numeral of a day that has
already gone, are **present without being readable** across a room.

The exception is about a token, never about a *composite*. An `opacity` at the
call site multiplies straight through a tuned ink and is not covered by it —
`.hz-cell.dim` was `opacity: 0.42` and took the derived scaffold to 1.65:1 on
Household, which no rule here ever permitted. Depth is space, a rule and a
ground step; **demotion is a token.**

What *is* still short is measured rather than exempted: on the `--s-*-tint` and
`--s-*-badge` grounds — a rota-washed cell and a shift badge — every theme falls
roughly 0.6 of a point below where it sits on the bare background, because a
tint moves the ground toward the ink by construction. `theme.test.ts` records
the worst ground each token reaches, so the gap is a number somebody has to move
rather than a rule somebody can forget.

**The Derived-Ink Rule.** A calendar's or a person's colour is the one ground on
this wall that is not a theme surface — a household chose it — so no token is
legible on it and none is used. `--pc-ink` / `--ev-ink` are black or white,
picked by measuring the ground (`inkOn`), set beside the hue at the moment a
renderer paints it. The choice is always *sufficient* rather than least-worst:
white and black cross at 4.58:1, so the better of the two clears 4.5:1 for every
colour in the space. Before it, `#fff` was written at six sites and measured
2.16:1 on the second colour a household is auto-assigned.

**The Token-Only Rule.** Nothing outside `theme.ts` names a colour. Every value
in the stylesheet is a custom property; `color-mix()` is banned (ES2019), so
tints are pre-mixed per theme against that theme's own background.

## Typography

**Body / Sans:** Roboto Flex (variable) — `Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif`
**Condensed:** the same face at `wdth 75` (a width, not a second family)
**Display (per theme):** Panels & Blueprint → Roboto Flex condensed; Household → Space Grotesk; Almanac → Fraunces (serif)
**Mark / brand wordmark:** Oswald 700 (outlined to paths at build; not a body face)

**Character:** One variable superfamily does almost all the work, driven by
optical sizing so a 22px event name and a 137px clock read from the same file at
the cut each size wants. The month grid and chore board *narrow the same
letterforms* (width axis) rather than switching typeface, which is why the wall
reads as one product rather than two. Almanac alone reaches for a serif (Fraunces)
to make the month the hero of a paper ledger.

### Hierarchy — the arc-minute scale
The calendar widget's roles are stated as **cap height in arc-minutes** at the
reader's eye and turned into pixels by `orientation.ts` (which alone knows the
panel size and read distance). On an unmeasured wall each falls back to a
canvas-relative rem — its own history, written at the site.
- **Clock / Display** (40′, capped at 1.8× the lede; 700, `line-height 0.82`): the largest thing allowed on the wall, and a placed widget never exceeds it.
- **Lede / Event title** (22′; `--t-wall-lede`, fallback `--t-event` 1.95rem; `line-height 1.2`): the one thing a household does not already know. Every other role is stated against it.
- **Numeral** (16′ = **1.14× the event**, not larger; 700, `--ink-scaffold`): the date is scaffolding, never the fact.
- **Time** (12′; `--muted`, tracked tight, tabular): a household reads the name and *checks* the time.
- **Scaffold** (11′): weekday heads, week numbers, rota chips, month labels.
- **Label** (10′, `0.22em` tracking, uppercase, `--faint`): a section label; the smallest rung, an identifier not a headline.

Everything outside the calendar widget reads from a canvas-relative rem scale
(`--t-micro` 22px … `--t-hero` 211px, at the 1080×1920 design height).

### Named Rules
**The Angle Rule.** Legibility is the angle type subtends at the eye, not a pixel
count. A single hardcoded px floor is right on one screen and wrong on every
other — it is the bug that once named zero events on a small panel.

**The Demotion Rule.** The date numeral is never more than **1.2×** the event
name beside it; the clock never more than **1.8×** the event size. The wall's job
is the thing the household does not already know.

**The Tabular Rule.** `font-variant-numeric: tabular-nums` everywhere — not a
preference. A figure that changes width changes a row's geometry, and a geometry
change forecloses e-ink partial refresh.

**The Calibrated-Leading Rule.** `line-height` is a number (1.15), never
`normal`: `normal` is a property of the font *file*, so a row would move a pixel
the moment the webfont lands. 1.15 was measured to sit inside the range `normal`
resolves to (1.148–1.178), reproducing the wall as drawn rather than inflating
every row.

**The Whole-Word Rule.** A month-cell title is drawn *whole* or not at all;
nothing ellipsises. A row that will not fit is hidden and counted in "+N", so
what is on the glass can always be read and what is missing is always numbered.

*The rule governs the **default** flat treatment, and the carve-out is worth
stating because it was measured rather than chosen.* Four treatments a
household can still select — `pills` on the month, and the two compact
(`.sk-ev`, `.sk-bar`) and week-column (`.wc-ev`) views — do ellipsise, because
a coloured chip cannot wrap without becoming a different shape. That is exactly
the trade the flat treatment was introduced to end: measured on a 1080×1920
wall, pills drew 37 event names and cut 32 of them, the worst at 26% of its
string, so that "Year 6 trip to the Science Museum" and "Year 6 sports day"
both rendered as "Year 6…". Colour is what carries a clipped chip — see *The
Derived-Ink Rule* — and the canvases that store these treatments keep them.

## Layout

**Unit.** `1rem = 1% of the canvas height` (the *canvas*, not the viewport — a
quarter-turn swaps the axis). On the 1080×1920 portrait target, 1rem = 19.2px.
Written by `orientation.ts`; a fallback lays out before script runs.

**Canvas model.** A **free-form canvas of widgets**, authored separately for
portrait and landscape and drawn at whichever matches how the screen is hung.
**Nothing reflows** — what the household dragged is what is drawn; a widget too
big for its box gives up *content* (via density tiers), never scales
photographically. `orientation.ts` computes which canvas to draw from viewport,
rotation, and what the household pinned; a rotation frame turns the whole wall in
the page (because panels forget OS rotation after a power cut) and letterboxes
the unused orientation.

**Spacing.** A six-step ladder in **em of the event role** (0, 0.14, 0.28, 0.5,
0.85, 1.4), so spacing follows the reader's own angle. Three limits bind: a month
cell spends ≤ step 2 on padding per axis; a widget box ≤ step 4; the canvas ≤
step 5 between boxes. These are *permissions*, not suggestions — chrome competes
with content on a fixed number of pixels with no scrollbar.

**Density tiers.** A widget reads its own box (via container queries — the one
ES2019 exception, made because a free-form canvas cannot reflow to help it) and
chooses a *form* from a table (`tiers.ts`) whose thresholds are in `ch` and `em`
of the event role, so one table is right on every panel.

### Named Rules
**The No-Reflow Rule.** The canvas is fixed by design. A widget adapts by reading
its box and choosing a form, never by the renderer reflowing the page around it.

**The Show-Less Rule.** A section that does not fit gives up content, not points.
`transform: scale()` on a laid-out section is banned; degrade by dropping a day,
a reading, or a row — never by shrinking everything uniformly.

## Elevation & Depth

**Flat by default.** Depth is conveyed by, in order: **space**, then a **1px
rule** (`--rule`), then a **ground step** (`--bg` → `--panel`, one tone up). A
"card" is a faint tinted ground and at most a small theme radius. That ladder is
still the whole of how one box is told from another; what changed on 2026-09-24
is what may be laid on top of it on a browser wall.

This section used to open "zero shadows, gradients, or blurs anywhere a screen
renders". Two of the three are reversed and one stands:

- **Gradients are allowed (D2).** Twelve templates already ship canvas
  gradients, so the sentence was false of the product before it was reversed.
  A gradient is a ground, and like any ground it is a theme token or a canvas
  background — a weather style's sky palette is tokens (plan item P4.5), so a
  custom theme can restyle it.
- **Shadows are allowed, through one theme token (D8).** See the rule below.
- **Blur stays out (Q4).** `backdrop-filter` behind a widget on a wallpaper is
  still excluded; a widget over a picture sits on a flat ground (plan item
  P6.3), because nothing measures text over a blur and an old tablet pays for
  one on every frame.

### Named Rules
**The Shadow-Is-A-Token Rule.** *(Was the No-Shadow Rule, rewritten 2026-09-24
for D8.)* The old rule said no shadow on the display at any size, in any theme,
because a shadow bands on e-ink and burns in on OLED. Both are still true, and
they are now why a shadow is a *token* rather than why it is banned:
`--shadow-card` is set per theme — soft on Panels and Household, paper-like on
Almanac, none on Blueprint and Swiss — derived for a custom theme, and set to
none by the e-ink presets of the wall-size picker (plan item P4.4). A literal
`box-shadow` in a widget rule is still wrong, because it is the one shadow a
household on an OLED or e-ink screen could not switch off. An e-paper panel
draws none. A shadow is never the only thing separating two boxes: space, a
rule and a ground step still come first. Enforced by
`builtin-themes-parity.test.ts`, which holds each built-in's value in the
bundle and on the server to each other, and by `browser-widget-shadow.test.ts`,
which reads the computed `box-shadow` on a real wall; that a panel ignores a
stored `shadow` is proved by rendering in `epaper-ink.test.ts`.

**The Phase-Locked-Motion Rule.** *(Was the No-Motion Rule, rewritten
2026-09-24 for D7.)* The old rule said no transition or animation on any surface
a screen sees: the wall has no pointer and redraws every 15s, so motion confirms
nothing and reads as a flicker in a room, and `draw()` rebuilds the whole wall on
every tick, so a naive animation restarts four times a minute. The owner decided
weather and countdown styles may move, and confetti may fall on a countdown's
day. The reasons survive as the conditions (plan item P4.3):

- a looping effect takes a negative `animation-delay` from the corrected wall
  clock, so a rebuilt element resumes where the old one was;
- a one-shot fires once per event, remembered per widget in `main.ts`, never
  once per tick;
- every `@keyframes`, `animation` and `transition` sits inside
  `prefers-reduced-motion: no-preference` and under `.canvas[data-motion="on"]`,
  the wall's own Motion switch (null means on, Q6; off by default on the e-ink
  presets);
- only `transform` and `opacity` are animated, and particle counts are capped.

An e-paper panel draws each style's still frame, always. Motion never carries
state (see the last Don't): a wall that is still must say exactly what a wall in
motion says. **Until S12 lands the ban is still what is enforced** —
`apps/display/test/motion.test.ts` refuses either word anywhere in the wall's
stylesheet, HTML, shell and `main.ts`'s import graph. Once S12 lands it and the
display half of `apps/server/test/motion-scope.test.ts` enforce the scope
instead, and a browser test holds an animation's computed time continuous
across a redraw. The admin's rule is unchanged: it animates under a pointer,
inside reduced motion (see `apps/server`).

## Shapes

Corners are a **theme property**, not a global scale. Household `0.35rem` (~7px)
and Panels `0.4rem` (~8px) read as deliberate panels; Blueprint, Almanac, and
Swiss are **square** (`0`). The only true circles are identity dots and avatars
(`50%`): per-person dots, initials chips, and face crops. Month event pills carry
a small `0.28rem`, with all-day pills opening to a left-edge colour bar
(`0 0.28rem 0.28rem 0`).

### Named Rules
**The Cell-Is-Not-A-Card Rule.** A month cell has no fill, no border, and no
radius of its own. Structure comes from the week rule and the column gutter.
Today is an inset outline; a rota day is a faint tint plus a top border.

## Components

For each: a character line, then shape, colour assignment, states, and any
distinctive behaviour. All draw from theme tokens; values shown are the Panels
default.

### Clock (widget)
- **Character:** a large tabular time, and never the loudest thing it *could* be.
- **Type:** display face, 700, `line-height 0.82`, capped at 1.8× the event size.
- **Behaviour:** width sized per character (`--clock-chars`) because "08:26 pm" is eight glyphs and "20:26" is five; `nowrap` as the belt. No seconds (the wall redraws on a 15s tick).

### Shift badge — the single most important element on the wall
- **Shape:** a card, faint rota-tint ground (`--sc-tint`), a `0.6rem` right edge in the rota hue; theme radius. Almanac drops the fill for a top rule instead.
- **Type:** headline (`.what`) at 3.6rem/700 uppercase in the rota hue.
- **Behaviour:** `min-width: min(24rem, 100%)` — never wider than its box (no scale-to-fit to hide overflow); drops to one line, then to a single *line* rather than a bare name, via its field ladder.

### Agenda / day row + event
- **Shape:** rows separated by a 1px top rule; a `0.45rem` transparent left border that colours in on a rota day; each event carries a `0.3rem` left border in its calendar's colour.
- **Type:** event title = lede; time = time role (right-aligned, tabular, tracked tight); "Day 2 of 4" sits under the title in the title's column.
- **States:** `.narrow` (measured, not a media query) stacks the time above the title; a running event draws a 2px progress bar **out of flow under the time** (glyphs with no descenders), so it never costs a row.

### Month grid (signature component)
- **Shape:** seven equal columns (optional week-number column `2.6rem`), cells `min-height 5.4rem`, transparent — *not cards*. Today = inset outline (`--ink`); rota day = `--sc-tint` ground + top border in the rota hue.
- **Content:** flat whole-word titles by default (never truncated), a per-person dot per row, and a "+N" counter that never costs a name. Multi-day events draw once as a span bar across their days (absolutely-positioned grid item, out of flow). `pills` and `dots` are alternate stored treatments.
- **Named rule — The Overflow-Never-Costs-A-Name Rule:** if a cell can draw one row, that row is an event, not "+3".

### Weather / House strips
- **Shape:** a single row of equal columns (weather) or a wrapping baseline flex row (house), bounded by 1px top/bottom rules — a *strip*, which is the default look. Decision D4 (2026-09-24) adopts a Home Assistant *tile-card* style as an alternative a household picks (plan item P5.3); hard rule 12 is unchanged, so a tile shows state and never controls anything.
- **Type:** uppercase scaffold labels (`--muted`), a bold value; the low temperature is always quieter than the high. Glyphs are first-party silhouettes, sized by density tier and never fetched. In the default look they draw in `currentColor`; a colour weather style (plan item P5.1) may paint them from theme tokens instead (D2, and the condition colours of P4.5). A designed style may also draw emoji as bundled artwork (D6) — an `<img>` from `/assets/emoji/`, never a code point for the device's font.

### People strip
- **Shape:** a wrapping flex row of person chips (dot/avatar + name). Wraps to two lines rather than clipping — a wall never gets a second interaction.

### Banners & Takeover (interrupts)
- **Banner:** a `--panel` card with a `0.45rem` accent left border; an alert banner reads at full ink and weight, housekeeping banners stay muted.
- **Takeover:** the whole screen, centred, a `0.5rem` accent border — **type first, colour second** (a light-theme kitchen is bright; a flooded accent would be unreadable). Category small above a 5rem event line; the *instruction* is second-largest because it is the only line that says what to do.
- **Acknowledge control:** a real `<button>`, transparent with an accent border, large (pressed from across a room with a remote). Its focus ring is the only affordance on a `cursor: none` wall, so `:focus`/`:focus-visible` draw a `0.25rem` ink outline — never omitted.

### Current-time rule
- A 2px accent rule across the agenda column at now, no label. The *only*
  current-time indicator in the product — never on the month grid (a day is not a
  timeline) and never on a battery e-paper panel (a glance class, not an alert class).

## Do's and Don'ts

### Do:
- **Do** size every legibility decision from `--px-arcmin` (panel size + read distance); fall back to the canvas-relative rem scale on an unmeasured wall.
- **Do** keep the event name the loudest thing; cap the numeral at 1.2× and the clock at 1.8× the event size.
- **Do** convey depth with space → a 1px rule → a ground step, in that order; a shadow, where a theme sets one, comes from `--shadow-card` and sits on top of that ladder, never instead of it.
- **Do** use `tabular-nums` and a numeric `line-height` on everything, so geometry is stable for e-ink partial refresh.
- **Do** degrade by showing less (drop a day, a reading, a row) and always keep the wall drawing something legible.
- **Do** keep every colour in `theme.ts`; add the four emphasis roles (and a 4.5:1-checked scaffold) to any new theme.
- **Do** draw glyphs as first-party silhouettes — in `currentColor` by default, or from a theme token in a colour style — and draw emoji, where a designed style uses them, as bundled artwork by key.
- **Do** phase-lock any motion to the wall clock, keep it inside `prefers-reduced-motion: no-preference` and the wall's Motion switch, and animate only `transform` and `opacity`.

### Don't:
- **Don't** build a dashboard: no rows of stat tiles, no KPI cards. This is a calendar. One large reading in a designed style is allowed only under a cap against the event role, the clock's way (D1).
- **Don't** write a literal `box-shadow` on a display surface, or animate anything outside the phase-locked, reduced-motion, Motion-switch scope — and never add a shadow, a gradient, blur or motion to anything an e-paper panel draws. Blur (`backdrop-filter`) stays out on every surface (Q4).
- **Don't** set an emoji as *text* in anything the wall designs — the image ships no emoji font, so a code point is a third-party asset resolved by the device. A designed style draws the bundled artwork; only a household's own typed text (a countdown title) keeps the device's font (Q9). An e-paper panel draws no emoji at all.
- **Don't** use `transform: scale()` to fit a laid-out section, or a hardcoded px legibility floor as anything but a fallback.
- **Don't** let an overflow "+N" cost a name, repeat a multi-day event per cell, or let anything that annotates an event (a bar, a badge, a rule) take a row in flow.
- **Don't** make a month cell a card (no fill, border, radius, or shadow), and don't let the date numeral outsize the event beside it by more than 1.2×.
- **Don't** rely on a pointer, hover, or motion to convey state — the wall has no pointer, and a wall with its Motion switch off, under reduced motion, or on e-paper must say exactly what a moving one says.

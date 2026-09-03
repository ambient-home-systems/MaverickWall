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
  display:
    fontFamily: "Roboto Flex, Roboto Condensed, Roboto, system-ui, sans-serif"
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
  none: "0"
  pill: "0.28rem"
  card: "0.4rem"
  full: "50%"
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

The system is a set of five pure token themes over one flat, motionless
stylesheet. There is no elevation, no animation, no shadow, and no emoji
anywhere a screen renders — not as taste but as physics: the panels are e-ink and
OLED as often as they are tablets, and a shadow bands on one and burns in on the
other while an emoji is a third-party asset that resolves differently on every
device. The most radical decision is that **type is sized by the angle it
subtends at the reader's eye** (arc-minutes derived from the panel's real size
and the reader's distance), not by a pixel count — so one design is correct from
a 7.5-inch e-paper tag to a 43-inch television.

The confirmed anti-reference is **the SaaS dashboard**: no stat tiles, no
big-number-plus-caption rows, no KPI cards. This is a calendar. The wall's job is
the single thing the household does *not* already know — an event name — and the
things they do know (the time, the date) are deliberately demoted beneath it.

**Key Characteristics:**
- Read from across a room; legibility is a physical angle, never a fixed pixel.
- Flat and motionless: separation is space, then a 1px rule, then a ground step.
- Five themes, pure token swaps; nothing outside `theme.ts` names a colour.
- The event name is the hero; the numeral and clock are capped beneath it.
- First-party and offline: every face and glyph ships in the image; nothing is fetched.
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
- **`--ink-quiet`** = overflow counts and past-event times (`= --muted`).
- **`--rule-week`** = the one hairline per week row (`= --rule`).

### Named Rules
**The One Accent Rule.** The accent marks the next event and the current-time
rule and nothing else. Its scarcity is what makes "next" and "now" read as one
idea across a room.

**The Scaffold-Contrast Rule.** `--ink-scaffold` is not a fixed mix ratio. It
starts at `mix(ink, bg, 0.62)` and the ratio is raised, per theme, until the
result clears **4.5:1** against that theme's own background — because a fixed
wash reads as low as 1.90:1 on a cream ground that the same wash reads fine on a
dark one. A custom theme's scaffold is derived the same way at token-build time.

**The One Sub-Bar Exception.** Exactly one token is allowed below 4.5:1: the
out-of-month grey (`--faint` on Swiss, `#3F3F46`, ~1.91:1). A day belonging to
the next month must be *present without being readable* across a room — that is
its job.

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

**Flat, always.** There are zero shadows, gradients, or blurs anywhere a screen
renders — confirmed across the whole stylesheet. Depth is conveyed by, in order:
**space**, then a **1px rule** (`--rule`), then a **ground step** (`--bg` →
`--panel`, one tone up). A "card" is a faint tinted ground and at most a small
theme radius; it never lifts off the page.

### Named Rules
**The No-Shadow Rule.** No shadow on the display at any size, in any theme. It
bands on e-ink and burns in on OLED. Separation is space, then a rule, then a
ground step — in that order.

**The No-Motion Rule.** No transition or animation on any surface a screen sees.
The wall has no pointer and redraws every 15s; the panel physically cannot
animate, so motion would be a flicker in a room. (This is the exact opposite of
the admin surface, which *does* animate under a pointer — see `apps/server`.)

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
- **Shape:** a single row of equal columns (weather) or a wrapping baseline flex row (house), bounded by 1px top/bottom rules — a *strip*, deliberately not a grid of tiles.
- **Type:** uppercase scaffold labels (`--muted`), a bold value; the low temperature is always quieter than the high. Glyphs are first-party silhouettes in `currentColor`, sized by density tier — never fetched, never emoji.

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
- **Do** convey depth with space → a 1px rule → a ground step, in that order.
- **Do** use `tabular-nums` and a numeric `line-height` on everything, so geometry is stable for e-ink partial refresh.
- **Do** degrade by showing less (drop a day, a reading, a row) and always keep the wall drawing something legible.
- **Do** keep every colour in `theme.ts`; add the four emphasis roles (and a 4.5:1-checked scaffold) to any new theme.
- **Do** draw glyphs as first-party silhouettes in `currentColor`.

### Don't:
- **Don't** build a dashboard: no stat tiles, no big-number-plus-caption rows, no KPI cards. This is a calendar.
- **Don't** add any shadow, gradient, transition, or animation to a display surface.
- **Don't** use an emoji as an icon, weather glyph, or device mark — the image ships no emoji font.
- **Don't** use `transform: scale()` to fit a laid-out section, or a hardcoded px legibility floor as anything but a fallback.
- **Don't** let an overflow "+N" cost a name, repeat a multi-day event per cell, or let anything that annotates an event (a bar, a badge, a rule) take a row in flow.
- **Don't** make a month cell a card (no fill, border, radius, or shadow), and don't let the date numeral outsize the event beside it by more than 1.2×.
- **Don't** rely on a pointer, hover, or motion to convey state — the wall has none.

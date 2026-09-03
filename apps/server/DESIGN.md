---
name: Maverick Wall — Admin
description: The hand-set settings surface for a calendar wall — a fixture, not an app
colors:
  # Frontmatter carries the DEFAULT scheme, Dark. Light is a full sibling scheme
  # (same roles, re-derived values) documented below and in .impeccable/design.json.
  bg: "#14161A"
  surface: "#1A1D22"
  surface-2: "#22262C"
  surface-3: "#2A2F36"
  ink: "#E9EBEE"
  ink-2: "#A9B0B9"
  ink-muted: "#8E97A3"
  ink-line: "#7C848E"
  line: "#2E333A"
  line-strong: "#3D444D"
  accent: "#E8A33D"
  accent-ink: "#241703"
  accent-soft: "#3B3226"
  accent-soft-ink: "#F3C079"
  danger: "#FF8A80"
  ok: "#5FD08A"
  warn: "#F0B429"
  night: "#7CA0E0"
typography:
  display:
    fontFamily: "Roboto, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: "40px"
    letterSpacing: "-0.02em"
  h1:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 650
    lineHeight: "32px"
    letterSpacing: "-0.015em"
  h2:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: "27px"
    letterSpacing: "-0.01em"
  h3:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: "22px"
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: "21px"
    letterSpacing: "0"
  body-sm:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0"
  label:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: "17px"
    letterSpacing: "0"
  label-xs:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: "14px"
    letterSpacing: "0.08em"
  wordmark:
    # Brand lockup only (the sidebar/wizard "Maverick Wall" mark). Oswald is the
    # display voice; Roboto Condensed / Arial Narrow are the narrow fallbacks.
    fontFamily: "Oswald, Roboto Condensed, Arial Narrow, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: "27px"
    letterSpacing: "0"
rounded:
  r-0: "0"
  r-1: "2px"
  r-2: "4px"
  r-3: "6px"
  r-4: "8px"
  full: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.r-2}"
    padding: "0 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.r-2}"
    padding: "0 16px"
    height: "40px"
  button-tonal:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-soft-ink}"
    rounded: "{rounded.r-2}"
    padding: "0 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r-4}"
    padding: "16px"
  field-input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "44px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r-2}"
    padding: "0 12px"
    height: "48px"
---

# Design System: Maverick Wall — Admin

## Overview

**Creative North Star: "The Fixture's Settings"**

This is the settings surface for a fixture in a house — the wizard that stands the
wall up and the admin that keeps it running — and it is built to look like one. A
household opens it briefly, months apart, usually on a phone in a kitchen in the
evening. So the register is **calm, precise, and hand-set**: neutral grounds (a
faintly cool graphite in the dark scheme, warm paper in the light), exactly one
brand hue, and a small, reviewable vocabulary. The tool recedes behind the task.

The defining decision is that **the tokens are hand-picked facts, not generated
outputs**. This system replaced a Material 3 tonal palette seeded from the brand
amber, and the objection was not that the ramp was wrong — it was faithful — but
that a tonal engine tints *every* surface with the seed, so the whole admin sat
on a brown-black (`#18120B`) and read as an app wearing somebody's wallpaper. The
confirmed anti-reference is exactly that: **Material tonal "wallpaper"** — seed-tinted
surfaces, fifteen-role scales, rounded pill navigation, elevation ladders. Here
the neutrals are neutral, one hue carries the brand, and changing any value is a
diff a person can review. A contrast test holds every foreground/background pair
to the ratio it needs, so a future tweak cannot quietly go unreadable.

It is a **modern-browser** surface — it uses `color-mix()`, `:has()`, and
container-free CSS freely — and it is the one place in the product that **permits
motion**: a settings screen is something a person is *touching*, where ~180ms of
transition is the only thing confirming a tap landed. That is the deliberate
inverse of the wall (`apps/display`), which has no pointer, redraws every 15s, and
bans motion outright. All of it lives inside a single `prefers-reduced-motion:
no-preference` block, so a reduced-motion visitor gets an instant, still admin.

**Key Characteristics:**
- Hand-picked tokens as reviewable facts; nothing is generated or seed-tinted.
- Neutral grounds, one brand hue; a small vocabulary, not a tonal sprawl.
- Two full schemes (dark default, light), one set of component rules across both.
- Phone-first: 44/48px targets, 16px inputs, a script-free modal drawer, a skip link.
- Motion allowed but pointer-scoped and reduced-motion-gated — the inverse of the wall.
- Depth is a hairline and a ground step; two single-layer shadows, only for surfaces that truly float.

## Colors

Two complete schemes, dark (default) and light, sharing one set of role names so a
single set of component rules works in both with no scheme-specific overrides. The
frontmatter carries the dark values; both are catalogued here.

### Primary (accent)
- **Brand Amber** (`#E8A33D`, dark): the mark's amber, unchanged — on the dark grounds it clears 4.5:1 everywhere it lands, so the brand colour and the accessible colour are one value.
- **Walked-Down Amber** (`#8C5C0C`, light): the amber is 2.16:1 on white, so light *cannot* use the brand value for text. This is the same hue walked down until it clears 4.5:1 on all three surfaces and its own soft wash. Derived for the constraint — do not "correct" it back to the brand amber.
- Each pairs with an `accent-ink` (text on the accent) and an `accent-soft` / `accent-soft-ink` (a tinted selected ground and its text).

### Neutral — grounds
Three surfaces, page outward to raised, 4–6 points of luminance apart so a card
separates from the page without a shadow doing it:
- **Ground** (`#14161A` dark / `#F7F6F4` light): the page. Graphite, not black — an OLED phone strobes on every scroll of pure black.
- **Surface** (`#1A1D22` / `#FFFFFF`): a card.
- **Surface-2 / Surface-3** (`#22262C`,`#2A2F36` / `#F1EFEC`,`#E7E4E0`): nested and control grounds.

### Neutral — inks
Four, in descending importance:
- **Ink** (`#E9EBEE` / `#1A1C1F`): primary text.
- **Ink-2** (`#A9B0B9` / `#5A6169`): secondary.
- **Ink-muted** (`#8E97A3` / `#62676D`): the quietest role a *sentence* may use — clears 4.5:1 on all grounds.
- **Ink-line** (`#7C848E` / `#7E858D`): the one sub-4.5:1 role, and it is a *control boundary only* — a field border, a segmented control's edge. No text is ever set in it.

### Neutral — rules
Two, because a divider inside a card and a border around a control are different
jobs: **Line** (`#2E333A` / `#E2DFDA`, must not be seen) and **Line-strong**
(`#3D444D` / `#CBC7C1`, must be).

### Tertiary (status)
Each has a `-soft` tinted ground so a tag can be washed rather than filled — a
solid status chip is loud on a page that may carry six. **Danger**, **OK**,
**Warn**, and **Night** (the shift palette's blue, kept identical to the wall so a
rota preview here and the same rota on the wall are not two different blues).

### Named Rules
**The Hand-Picked Rule.** Colours are facts, not outputs. Nothing regenerates
them; changing one is a reviewable diff, held by a contrast test.

**The One-Hue Rule.** Exactly one hue carries the brand; every other surface is a
true neutral. The admin is a fixture, not an app wearing wallpaper.

**The Ink-Line Rule.** `ink-line` is the single role allowed below 4.5:1, and it
draws control *boundaries* only — never text.

### Token naming

Colours are emitted as `--mw-<role>` (e.g. `--mw-accent`, `--mw-surface-2`,
`--mw-line-strong`) — the canonical names, and the ones the drift test enforces.
The stylesheet also defines a small set of **bare aliases** that map onto them —
`--bg` → `--mw-bg`, `--panel2` → `--mw-surface-2`, `--rule` → `--mw-line-strong`,
`--ruleSoft` → `--mw-line`, `--accent` → `--mw-accent` — used mainly by the
layout editor's canvas chrome. They are aliases, not a second palette: every one
resolves to a `--mw-*` value. Prefer `--mw-*` in new code; the aliases exist so
the editor's wall-adjacent surfaces can borrow short names.

## Typography

**Sans (everything):** Roboto, variable 100–900 — `Roboto, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif`
**Wordmark (brand lockup only):** Oswald 700 — `Oswald, Roboto Condensed, Arial Narrow, system-ui, sans-serif`
**Mono:** `ui-monospace, SFMono-Regular, Menlo, monospace` — pairing codes, hostnames, timestamps, release addresses

**Character:** A single workhorse sans, tuned for glances rather than arm's-length
reading. Where Material's scale tracks body *out* and sets headings at 400, this
scale sets headings at **650**, lets tracking go **negative as size goes up** (the
way optical sizing wants), and keeps body tracking at zero. Sizes are px — the
admin is a browser on a phone or a laptop, not the wall's canvas-relative rem.

### Hierarchy (size / line-height / weight / tracking)
- **Display** (34/40/700/−0.02em): the wizard's big moments.
- **H1** (26/32/650/−0.015em) · **H2** (21/27/650/−0.01em) · **H3** (16/22/650/−0.005em) · **H4** (14/19/650/0): page and section headings.
- **Body-lg** (16/24/400) · **Body** (14.5/21/400) · **Body-sm** (12.5/18/400): prose; body-sm for the secondary layer.
- **Label** (13.5/17/600) · **Label-sm** (12/15/600/0.01em): control and field labels.
- **Label-xs / Eyebrow** (11/14/700/0.08em, uppercase): the one role that tracks *out* — caps need the air. Section kickers and the drawer's group heads.

### Named Rules
**The Legible-Heading Rule.** Headings are weight 650 with negative tracking, not
airy 400. A settings screen must read at a glance, sometimes across a kitchen.

**The Muted-Floor Rule.** A sentence is never set below `ink-muted`. The secondary
layer ("Last seen 2 minutes ago", group heads, alert explanations) uses
`ink-muted`, which clears 4.5:1 — not `ink-line`, which is a border colour.

## Layout

**Unit:** px throughout (a browser surface). Spacing is a seven-step scale —
**4, 8, 12, 16, 24, 32, 48px** — "a balanced step, neither the 4px enterprise grid
nor the airy mobile one", so controls are comfortable to hit and a screenful of
settings still fits. A `44px` touch minimum and a `1px` hairline sit beside it.

**Shell:** a fixed left sidebar (brand lockup, grouped nav) beside a scrolling
content column. Nav items are 48px with a 2px accent bar for the active route (not
a tinted pill). Content is measured for a readable line; the layout editor alone
opts into a wider column.

**Responsive:** below **900px** the sidebar becomes a **script-free modal drawer**
— a checkbox the CSS reads through `~`, opened from the app bar's leading icon,
over a scrim. A skip link precedes the drawer in DOM order so the keyboard reaches
content first. Inputs are ≥16px so iOS Safari does not zoom on focus.

### Named Rules
**The Token-Spacing Rule.** Every spacing, radius, and font-size is a token —
no raw pixel literals in the stylesheet. A drift test fails the build on one, so
a new screen composes from the vocabulary instead of restating it.

**The Script-Free-Nav Rule.** The mobile drawer and the wizard run with zero
JavaScript. Someone who cannot reach the navigation cannot reach anything else.

## Elevation & Depth

**Flat by default, with two exceptions.** Depth is normally a **ground step**
(`bg` → `surface`, 4–6 points apart) and a **hairline** (`line` / `line-strong`)
— no shadow separates a card from the page. Two single-layer shadow tokens exist
only for surfaces that genuinely float above the page:
- **`--mw-shadow-1`** (`0 1px 2px rgba(0,0,0,.16)`): a subtle lift for a card that must read as pickable, and the focused skip link.
- **`--mw-shadow-2`** (`0 8px 24px rgba(0,0,0,.28)`): the modal drawer and the layout editor's widget sheet — things that overlay content.

State is conveyed by **wash**, not elevation: interactive controls tint by 6% on
hover and 11% on press, mixed against their own ground via `color-mix()` so a
control nested in a card in a sheet still tints correctly.

### Named Rules
**The Two-Shadow Rule.** Shadows are single-layer and reserved for the modal
drawer and the widget sheet. Everything else separates by ground step and
hairline. No elevation ladder.

## Shapes

A tight radius scale — **0, 2, 4, 6, 8px** — with `999px` (`full`) reserved for
things that are *actually circles*: the switch thumb, an 18px close dot, avatars,
status dots. A control is `r-2` (4px); a card is `r-4` (8px). Nothing is a pill
rectangle, and a design-system test names the circle exceptions so a stray `50%`
or `999px` on a rectangle fails.

### Named Rules
**The No-Pill Rule.** `full` radius is for circles only. A rounded-rectangle
"pill" button or nav row is banned — that was the Material look this system
removed.

## Components

A fixed, tested vocabulary — `pageHeader`, `section`, `card`, `listRow`,
`dataTable`, `tag`, `emptyState`, `destructive` — that every screen composes from
rather than hand-typing markup. Values shown are the dark scheme.

### Buttons
- **Shape:** `r-2` (4px), height 40px (`btn-sm` 32px, but ≥44px hit area on touch).
- **Primary** (`button` / `.btn`): filled — accent ground, `accent-ink` label.
- **Ghost** (`.secondary` / `.btn-ghost`): transparent, accent label and border.
- **Tonal** (`.tonal` / `.btn-tonal`): `accent-soft` ground for a weightier secondary action.
- **Text** (`.text` / `.btn-text`): accent label, no ground.
- **Danger** (`.btn-danger`): outlined in `danger`.
- **States:** hover/press are `color-mix()` washes (6% / 11%); keyboard focus draws a ring. **A control that clears the filled ground must also opt out of the filled hover/press** — otherwise it flashes accent-on-accent (gold on gold) on touch.

### Fields
- **Style:** a **label above** a bordered input (not a floating label). Border is `ink-line`; ground transparent; `r-2`.
- **Focus:** border shifts to accent (outline removed, border does the work). Border *width* is deliberately not transitioned — a 1px→2px step would shimmer.
- **Size:** 16px text minimum (no iOS zoom-on-focus).

### Cards & Sections
- **Card:** `surface` ground, `r-4`, `s-4` (16px) padding, separated by ground step + hairline; `shadow-1` only when it must read as pickable.
- **Section:** a heading (optionally an eyebrow) over grouped content; the vocabulary's structural unit.

### List rows / Data tables
- **List row:** ≥48px, a title + secondary line + trailing control; a whole-row link coexists with a trailing button (the button positions itself above the stretched link).
- **Data table:** for genuinely tabular settings; hairline rules, no zebra fills.

### Tags
- **Style:** a small tinted chip (`-soft` ground + hue), never a solid fill; tones `neutral` / `ok` / `warn` / `danger`. **A state is a tag, never a parenthesis** baked into a heading ("Calendar (off)" → the name, then a `tag("Off")`).

### Navigation
- **Sidebar item:** 48px, `ink-2` label, a **2px accent bar** for the active route (not a pill), `r-2` hover wash.
- **Mobile:** the same markup becomes a modal drawer under 900px, script-free.

### Empty state
- **Voice:** name the thing ("No calendars yet", not "Nothing to show"), and **match the branch** — "there are none", "the query failed", and "you filtered them all out" are three different sentences. **No icon, no illustration, no exclamation mark** — an icon here is banned and a test walks a fresh install looking for one.

### Destructive action
- A confirmed, labelled action that names what it destroys. Its generated form carries no hidden fields, so it fits a path-parameter target, not a query string.

## Do's and Don'ts

### Do:
- **Do** compose every screen from the component vocabulary; spend tokens, never raw px/radius/font-size literals.
- **Do** keep colours hand-picked and contrast-tested; add every role to *both* schemes or the missing one resolves to nothing.
- **Do** convey depth with a ground step and a hairline; reserve the two shadows for the drawer and the widget sheet.
- **Do** put every transition inside `prefers-reduced-motion: no-preference`, on the three duration / three easing tokens.
- **Do** set a sentence in `ink-muted` at the quietest; keep `ink-line` for control borders only.
- **Do** use 44/48px targets and 16px inputs; keep the wizard and mobile nav script-free.
- **Do** show state as a `tag`, and write empty states that name the list and match the handler's branch.

### Don't:
- **Don't** reintroduce a Material tonal palette (seed-tinted surfaces), a 15-role scale, an elevation ladder, or pill-shaped nav/buttons.
- **Don't** use `full` radius on anything that isn't a circle.
- **Don't** let a control that clears the filled button keep the filled hover/press (gold-on-gold on touch).
- **Don't** set text in `ink-line`, or a sentence below `ink-muted`.
- **Don't** bake a state into a heading's text ("(off)") — use a tag.
- **Don't** put an icon, illustration, or cheer in an empty state.
- **Don't** copy the "walked-down" light accent back to the brand amber, or add a raw one-off spacing/radius/font-size value.

# RFC 014 — Styling and layout flexibility

Status: **proposed; §7 precondition 1 and §4.3 are built** — the display
serves a Content-Security-Policy (`apps/server/src/http/app.ts`,
`apps/server/test/display-csp.test.ts`), and a custom theme can name a shape
(`apps/server/src/api/themes.ts`'s `resolveTheme`,
`apps/server/test/browser-theme-shape.test.ts`); nothing else here is built ·
Owner: — · First drafted 2026-09-15 ·
Arises from the question "could a household style each widget with a CSS
block?" · Relates to `apps/server/src/api/widget-schema.ts`,
`apps/server/src/api/themes.ts`, `apps/display/src/render.ts`
(`applyWidgetFormat`), `apps/display/src/theme.ts` (`applyTheme`),
`apps/display/src/preview-css.ts`, `apps/display/src/main.ts` (`pickCanvas`),
`apps/server/src/epaper/honours.ts` · Builds on RFC 005 (the canvas), the
custom-theme builder, the density tiers and the ink lane

## 1. Summary

The ask is maximum design flexibility: a household who really wants a unique
look should be able to get one, per widget, and the same should be true of the
arrangement. The obvious answer is a free CSS block on every widget. This RFC
argues that the obvious answer is the *last* thing to build rather than the
first, and lays out four styling steps and four layout steps that get most of
the way there without it — each one a widening of a mechanism the product
already has, validated by a schema it already runs, and drawable by the
e-paper panel where that is possible at all.

The order matters more than the list. The wall is unusually well set up for
**token** customisation and unusually hostile to **free** CSS, and both are
deliberate: every style reaches the glass today as validated data, never as
text; the stylesheet is held by seven tests to properties a household's string
would sit outside of; and the class names it would target are renamed in most
releases. A CSS block is the smallest of these features to write and by far the
largest promise to keep. It is proposed here, in §7, behind three
preconditions — and only if the four steps before it turn out not to be
enough.

## 2. What exists, and what it decides

Three facts from the code shape everything below.

**Every style already reaches the wall as data.** A widget's Format keys —
`align`, `background` with `opacity`, `corners`, `title`, `showTitle` — are
validated by `widgetConfigBody` (`.strict()`, rejecting rather than coercing)
and written as inline styles by `applyWidgetFormat` in `render.ts`. A custom
theme is eleven hex colours, a bounded `--radius` and two font stacks chosen
from `FONTS`, a closed list of bundled faces; `applyTheme` writes them with
`setProperty` on the wall's root element and every rule under it inherits. The
renderer builds nodes with `textContent` and contains no `innerHTML`. There is
no path by which a household-authored string reaches the stylesheet, and the
custom-theme schema's own comment says so is the whole of its safety.

**The stylesheet is under guard.** `motion.test.ts` holds `display.css` and
every module in `main.ts`'s import graph to no transition and no animation;
`no-emoji.test.ts` to no emoji; `reflow-stability.test.ts` to identical
geometry across two walls with different events, and to no `transform: scale()`
anywhere; `browser-tabular-figures.test.ts` to tabular numerals on every
visible run; `wall-density.test.ts` to a ratchet on what the shipped wall
names; and the design rules to no shadow, no absolute pixel in type, and a date
numeral never more than 1.2x the event beside it. Every one of those scans the
repository's stylesheet. None can see a string stored in a household's
database.

**The class names are not an API.** `.te*` is dead styling for markup that is
gone; `hz-dots` was replaced by the density mark; `fitToBox`, `trimCellRows`
and `fitAndTrimToDays` were deleted in one phase; the `.fw-scale` wrapper went
with them. This is the codebase working as intended — a renderer that reads its
box and chooses a form is rewritten as the measurements improve. A CSS block
written against `.hz-num` freezes that DOM on the day the first household saves
one, and every later refactor becomes "somebody's kitchen wall changed".

Two more facts bound the design rather than shape it. ~~**The display serves no
Content-Security-Policy.**~~ **It does now** — §7's precondition 1, built
ahead of the rest of this RFC because it is worth having on its own. Rule three
was a property of the code (nothing in the bundle fetches from anywhere but its
own origin) and is now also a property of the browser. The code is still where
it is *enforced*; the header is the second mechanism, not a replacement for the
first. And **the e-paper panel draws from config, never from CSS.**
`epaper/honours.ts` states per key what a panel honours and what it ignores; a
CSS block would be an ignored key by construction, and a panel following a
styled wall would draw the unstyled one.

## 3. The threat, stated plainly

A free CSS block is not an XSS vector: CSS is not script, and the author is the
household's own signed-in admin, who can already upload images and type titles.
The two real risks are rule three and rule nine.

- **Rule three.** A snippet pasted from a forum can carry `url()`, `@import` or
  `@font-face`, and the wall — a device with no other reason to talk to the
  internet — fetches from a stranger's origin on every redraw, fifteen seconds
  apart, for months. That is a tracking beacon with the household's IP on it,
  installed by somebody trying to make their calendar look nicer. With no CSP,
  nothing in the browser would refuse it.
- **Rule nine.** `display: none` on the canvas, `font-size: 0`, `position:
  fixed` over everything, an `overflow` that clips a week off the bottom — on a
  screen with no pointer, which nobody can fix from the kitchen. The editor's
  live preview shows the household what they did on *that* preview's size; a
  7.5" panel, a 43" television and a wall that lost the font race are three
  other answers.

And one cost that is not a risk: the design rules stop being enforceable.
`transform: scale()` is banned in this codebase because a uniform transform
changes how big a widget looks and can never change what it says; a household
can reintroduce it in one line. That is their wall and arguably their choice —
but it is also the first thing every "make it fit" snippet on a forum will do,
and the product will be blamed for the result.

## 4. Styling — four steps before a CSS block

### 4.1 A per-widget style lane (the ink lane's twin)

Let a widget carry its own token set, applied on its box exactly as
`applyTheme` applies the household's on the root — one element down, so every
rule under the box inherits it and nothing else on the wall does.

```
config.style = {
  '--bg'?, '--panel'?, '--rule'?, '--ink'?, '--muted'?, '--faint'?,
  '--accent'?, '--radius'?, '--disp'?, '--f-sans'?,   // themeTokensSchema, picked
  weight?:   'regular' | 'medium' | 'bold',            // maps to a bounded font-weight
  tracking?: 'tight' | 'normal' | 'wide',              // maps to the existing --ls-* steps
  scale?:    0.8 … 1.25,                               // one multiplier on the widget's type roles
  inset?:    0 … 4,                                    // a step on the existing --s1..--s5 scale
}
```

- **Validation is the existing theme schema, picked**, the way `inkOverrideBody`
  is picked from the widget fields — so a colour that is not a `#rrggbb` is
  refused by the same rule with the same message, for ever, and a font stack
  outside `FONTS` is refused for the same reason it is on a theme. The four new
  keys are enums or bounded numbers. `.strict()`, as everywhere.
- **Application is `setProperty` on the box**, in `applyWidgetFormat`, beside
  the keys it already writes. `scale` multiplies the widget's `--t-wall-*`
  roles on the box, so a measured wall's arc-minute arithmetic still holds
  underneath it; the bound is tight because a scale is the one control here
  that can take a run under the reader's angle, and the editor says so.
- **The tiers keep working.** `tiers.ts` and `widget-tiers.ts` measure the
  *drawn* role size in `ch` and `em`, so a widget whose type is nudged still
  reads its own box and still chooses a form. This is the property a CSS block
  cannot offer and the reason to prefer the lane: the household changes how the
  widget looks, and the widget still decides what it says.
- **The preview is free.** Both admin previews draw through `renderFreeform`
  with inline styles on the boxes; a token on a box is a token on a box.
- **The panel honours part of it, honestly.** `--radius` and `inset` move ink
  on a 1-bit frame and go in `PANEL_HONOURS`; colours and faces do not and go
  in `PANEL_IGNORES` with the sentence a household reads. `epaper-ink.test.ts`
  already derives both tables from the renderer by rendering.
- **The custom-theme derivation must run per widget.** `withTints` derives
  `--ink-scaffold`, `--ink-event`, the cell tints and the badge tints from the
  base colours and raises the scaffold mix until it clears 4.5:1 against
  *that* `--bg`. A widget lane that sets `--bg` and `--ink` without re-deriving
  those puts an invisible date numeral in the one widget the household
  restyled. The lane goes through the same resolver the theme does, on the
  server, and the manifest carries the resolved set — the display bundle never
  learns the lane exists, which is exactly how custom themes already work.

This is most of what "a unique design per module" means in practice: a different
face, a different ground, a different accent, tighter or looser, larger or
smaller, per widget. It costs no new mechanism.

### 4.2 Designed variants per widget type

The calendar already has four cell treatments (`text`, `dots`, `pills`,
`swiss`) and two densities, and Swiss mode is the model: a *mode*, drawn on
purpose, measured on a real wall, panel-aware through the honours tables. The
other widgets have none. Each gets a small `variant` enum:

| Widget | Variants worth drawing |
|---|---|
| clock | `plain` (today), `stacked` (time over date), `analogue` (a filled-path face, no hands animation) |
| weather | `strip` (today), `column`, `today-only` (one large reading, the forecast as a single line) |
| shift | `badge` (today), `line` (one row, the ladder's own one-rung form as a choice), `calendar-strip` (the run as seven small cells) |
| homeassistant | `list` (today), `grid` (readings as a 2-up or 3-up), `strip` |
| notes | `plain` (today), `card` (a rule and a heading), `large` (the text as the widget's lede) |
| countdown | `number` (today), `bar` (days elapsed of the whole), `calendar` (the target on a small month) |

Each variant is a designed alternative and each is a `browser-*` measurement
before it ships, the way Swiss mode was. This is how the project has always
delivered flexibility — as an enum somebody drew rather than a string somebody
typed — and it is the only form of it the panel can follow.

### 4.3 Open the theme's shape — **built**

`display.css` carries per-theme *shape* rules keyed on `data-theme`: Almanac's
400-weight numerals and italic date, Panels' card borders, Blueprint's
condensed heads. A custom theme is pinned to the neutral shape (`board`, which
no built-in resolves to). A custom theme names a shape:

```
theme.shape = 'panels' | 'household' | 'blueprint' | 'almanac' | 'swiss' | 'neutral'
```

One enum, one `setAttribute` that `applyTheme` already made — no display code
changed at all, since `apps/display`'s `applyTheme` has always set `data-theme`
to whatever the manifest sends. What shipped is the server side alone:
`themes.shape`, a nullable column added by migration `0046` (an `ALTER TABLE
ADD COLUMN`, not a recreate, walked through `migration-upgrade.test.ts`);
`themeShapeSchema`, the Zod enum on the body, rejecting anything outside the
six; and `resolveTheme` returning the chosen key — `panels`, say — in place of
the neutral `board` sentinel it always returned before, so a household with a
generated palette gets Almanac's italics or Panels' cards under their own
colours. `null` (a theme saved before the column existed) and an explicit
`'neutral'` both still resolve to `board`, so nothing on any existing wall
moved and no stored manifest ETag churned.

The builder's own control is `segControl` (`apps/server/src/http/html.ts`), a
scriptless radio-per-segment field styled on the `.seg` idiom
`admin-modules.ts`'s per-click Alerts control already used, extended to a
`<label>`-wrapped, `:has(input:checked)`-ringed variant so a shape choice
rides inside the theme form's one Save rather than posting alone — a segment
that posted on click would have discarded whatever colours were mid-edit, the
Weather screen's own fault one control along. The live preview iframe
(`apps/display/src/theme-editor.ts`) reads the checked segment on `change` and
re-themes with it immediately, the same way it already re-themes on a colour
edit.

Verified by measurement rather than by class name
(`apps/server/test/browser-theme-shape.test.ts`): a real paired wall's
`.dr-num` computed `font-weight` under a custom theme with `shape: 'almanac'`,
and the reused calendar section's computed background and corner radius under
`shape: 'panels'` — with the theme's own colours proved to still be its own
alongside the borrowed shape, and a theme with no shape chosen measured
byte-for-byte identical to one carrying a genuine pre-phase `NULL` column.
Days of work, as the estimate said, and a real gap closed.

### 4.4 Canvas-level styling

Two things a household reaches for that are about the wall rather than a
widget: a **gutter step** between boxes (today the canvas spends up to `--s5`
and the household cannot choose less or more), and a **default widget style**
the lane in 4.1 inherits from, so a household who wants every widget in
Fraunces sets it once. Both are one row on the screen's layout settings, both
are the existing scale, and both fall inside the "no absolute px" rule by
construction.

## 5. Layout — four steps

The canvas already gives free placement, z-order, overlap, a canvas per
orientation, a canvas per screen, letterboxing and `follow`. What it lacks is
**composition** and **time**, not freedom of position. What it must not regain
is the retired `auto` layout's reflow — the paragraphs in `CLAUDE.md` marked as
history are the last time the project reasoned that through, and 5.3 below is
the one place this RFC deliberately re-enters that ground.

### 5.1 Groups

A container box that lays its children out in a `row`, `column` or `grid`,
with the gutter step from 4.4 between them. Today a utility strip is three
boxes the household lines up with the Style tab's numeric fields; a group is
the one primitive that makes an arrangement reusable without the "profiles"
RFC 005 declined.

The schema is the load-bearing decision. `layoutWidgets` is one flat list of
boxes per screen and orientation, and everything — the editor's canvas state,
templates, `applyTemplate`, the omission flag, the panel's `drawWidget` — walks
that list. Two shapes are possible:

- **A `group` widget type whose config carries its children.** Keeps the table
  flat. Breaks the invariant that a widget config is one strict object of
  scalars, and puts a second copy of `layoutWidgetBody` inside itself, which
  has to be bounded (one level; a group in a group is refused the way `ink.ink`
  is).
- **A `parent_id` column on `layout_widgets`**, additive, with `x`/`y`/`w`/`h`
  read as fractions of the parent when set. Keeps configs scalar. Every walker
  learns one rule: place the parents, then the children inside them.

The second is recommended: it is the `screen_id` shape one column along, the
migration is three `ALTER TABLE ADD COLUMN`s and no recreate, and the panel's
renderer gets groups for free because a child's box resolves to panel pixels
exactly as a top-level one does. Nesting is bounded at one level; a group's
children are drawn with `z` relative to the group.

### 5.2 Scheduled canvases

The theme already switches on a daylight window. Let the canvas do the same:
a screen holds *named* canvases per orientation rather than exactly one, and
`pickCanvas` in `main.ts` chooses by the household's local time — a school
morning wall from 06:30 to 08:30, an evening one after 20:00, the default
otherwise. No new renderer, no reflow: each canvas is authored whole, the way
both orientations are today.

Storage is one nullable `slot` column on `layout_widgets` (the existing rows
are the default slot) and a small schedule table keyed on the screen. The
manifest carries every slot and the wall picks, for the reason the manifest
carries both orientations: the wall must draw the right one offline, from its
stored copy, at the moment the clock crosses the boundary. The ETag needs
nothing — the slots are in the layout, which is in the preimage.

### 5.3 A fallback for an empty box

`CLAUDE.md` names the hole an unconfigured or empty widget leaves as "the bill"
for retiring `auto`: `keepWidgetsWithSomethingToSay` drops the widget and the
box is simply empty at the size somebody dragged it to. Two per-box rules close
it, and the household picks one in the inspector:

- **`whenEmpty: { type, config }`** — draw this other widget in my box instead.
  A Weather box with no location shows the household's notes; a chore board
  with nothing due shows the countdown. This is *substitution*, not reflow:
  every box keeps its rectangle, and the panel's refresh contract is untouched.
- **`whenEmpty: 'yield'`** — give my room to the box directly below me in the
  same column. This *is* limited reflow, deliberately, and it is bounded to one
  neighbour and one axis so that the wall a household sees is still the wall
  they arranged with one box taller. It is the retired layout's "the week ahead
  yields" as a property a household sets on a box rather than a rule the
  renderer imposes on a block.

Substitution ships first and yield is a separate decision, because yield moves
rectangles and the e-paper panel's partial refresh depends on rectangles that
do not move. On a panel, yield is honoured only as a full refresh, and the
honours table says so.

### 5.4 The snap grid and the numeric fields

`SNAP` is a fixed twenty-fourth. A per-canvas choice of 12, 24 or 48 divisions
is one setting and one argument to `placement.ts`'s snap; the numeric fields on
the Style tab already let a household line two widgets up exactly, so this is a
convenience rather than a capability. Listed for completeness and last.

## 6. What it looks like in the editor

- **Style tab, per widget:** a "Look" picker at the top (4.2's variant), then a
  "Colours and type" section with an *Inherit the wall's theme* switch; off, it
  shows the lane's controls (4.1) with the theme's own values seeded in, the
  way the inherited-number pattern already seeds a field. Contrast guidance from
  the theme builder, non-blocking, reused.
- **Wall settings › Layout:** gutter step, default widget style, snap
  divisions, and the schedule (5.2) as rows of *from – to – canvas*.
- **Inspector, for a flagged box:** the omission note gains a "When this has
  nothing to show" control (5.3) beside the sentence that already explains the
  flag.
- **Toolbar:** *Group* appears when two or more boxes are selected, which the
  editor does not support yet — multi-select is a prerequisite of 5.1 and is
  the largest single piece of editor work in this RFC.

Nothing in the list is a new component. The Style tab's rows are `switchRow`,
`segControl` and `cfgField`; the schedule is `listRow`s.

## 7. The escape hatch, and its three preconditions

If households still ask for something 4.1 to 4.4 cannot express, add one CSS
block per wall and one per widget, on an **Advanced** screen, with these
properties. None is optional and all three preconditions ship before the
textarea does.

**Precondition 1 — a Content-Security-Policy on the display. Built.** It
turns rule three from a property of the code into a property of the browser,
and it is what makes the sanitiser below defence in depth rather than the only
defence.

What shipped is tighter than this paragraph asked for, and the difference is
the useful part. The policy is

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self' ws://<host> wss://<host>;
frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'
```

on `/`, `/pair`, `/d/*`, `/assets/*` and `/sw.js` — every document and asset a
wall loads, and nothing in the admin. **`'unsafe-inline'` turned out not to be
needed**, which this paragraph asserted it was. The claim under it was right —
the CSSOM is not governed by CSP — and its conclusion drew the wrong
consequence: the renderer writes *every* style through that same door
(`element.style.setProperty`, `element.style.x = …`), not only the household's
future block, and the wall's markup carries no `style` attribute and no
`<style>` element for `style-src` to have an opinion about. Measured rather
than reasoned: `apps/server/test/display-csp.test.ts` draws the shipped Classic
wall, the pairing form, the offline shell, the theme builder's preview iframe
and an image widget from `/d/media` in a real Chromium with a
`securitypolicyviolation` listener armed before each navigation, and counts
zero. So the household's block needs no relaxation of its own **and neither
does anything already on the wall** — which is a stronger starting point for
precondition 2 than this RFC expected to have.

**Precondition 2 — a real parser and an allowlist, rejecting.** Parsed on the
server with `css-tree` or `postcss` at save time, never at render time.
Refused outright, with the reason echoed beside the field: `@import`,
`@font-face`, `@keyframes`, any `url()`, `transition`, `animation`,
`position: fixed | sticky`, `!important`, and any selector reaching outside the
widget (`html`, `body`, `:root`, `.screen`, `.canvas`, `.banner*`,
`.alert*`, `.pair-*`, `.message`). Everything else is prefixed under the
widget's own box selector by rewriting each selector list — the mechanism
`preview-css.ts` already uses to move `:root` onto `.preview-wall`, and for the
same reason `@scope` is not used: rule two. A block that fails to parse is a
400 that names the line.

**Precondition 3 — safe mode by construction.** The wall inserts the block
after its own stylesheet and *only* on the canvas: the pairing form, the boot
message, the offline banner and the alert takeover are never under it. A block
the browser refuses to parse is dropped and the wall draws without it. The
stored copy in IndexedDB carries the block, so a wall coming back from a power
cut draws the styled wall it had. And the editor states, beside the textarea,
in these words: *class names may change between releases; a panel ignores
this; the wall's own rules about motion and size are not enforced here.*

What the escape hatch does **not** get: scoping by a shadow root per widget.
It scopes natively without parsing and would be the honest mechanism, but it
reshapes the renderer's DOM and every browser test that queries across the
wall, and custom properties would need re-declaring at each root. If the
parser proves unmaintainable, this is the fallback, and it is a renderer
rewrite rather than a feature.

Even with all three, the block stays where option 4 of anything belongs: after
the four steps above have shipped and a household has named the thing they
cannot do.

## 8. Security considerations (rule map)

| Rule | Where it bites | How it holds |
|---|---|---|
| 2 (ES2019) | Scoping | Selector prefixing, not `@scope`; no `:has()` in any generated rule |
| 3 (no third-party origins) | The CSS block | CSP on the display — **built**, and wider than `/d/*`: `/`, `/pair`, `/d/*`, `/assets/*`, `/sw.js`; `url()`, `@import`, `@font-face` still refused at save |
| 5 (Zod at every boundary) | Every new key | Enums and bounded numbers; the lane is `themeTokensSchema` picked; the block is parsed, never regex-checked |
| 6 (no secrets in logs) | Unchanged | No new string reaches a log |
| 9 (never brick) | The lane's `scale`; the block | Bounds on `scale`; safe mode; chrome never under the block; a refused block is a 400, not a blank wall |
| 12 (HA read-only) | Unchanged | — |
| Design rules | The block | Not enforceable inside it, and the editor says so; enforceable everywhere else, because everything else is an enum |

## 9. What we deliberately do not build

- **A free CSS block as the first step.** §3 and §7.
- **Reflow beyond one neighbour on one axis.** 5.3's yield is the whole of it,
  and it ships second.
- **Nested groups.** One level. `ink.ink` is refused for the same reason.
- **Per-screen-size breakpoints inside one canvas.** A screen already has its
  own canvas and can `follow` another; responsive reflow within a screen is the
  retired layout.
- **Web fonts, uploaded fonts, or any face outside `FONTS`.** A theme naming a
  family the image does not ship is the fault rule three exists to prevent.
- **A marketplace of styles.** Templates stay in-repo source, as RFC 005 says.

## 10. Verification bar

Each step ships with the measurement this project counts, not with a test that
reads a class name.

- **4.1** `browser-widget-style.test.ts`: a widget carrying `--bg` and `--ink`
  draws its date numeral at 4.5:1 or better against *its* ground, read off the
  computed colours; every run in a restyled widget is still its role's angle on
  a measured wall; `scale` at its upper bound takes no run under the floor on
  the shipped seed at five sizes; a sibling widget's computed tokens are
  byte-identical with and without the lane. Reverting the per-widget
  re-derivation must turn the contrast assertion red.
- **4.2** One `browser-*` file per variant, the Swiss-mode shape: measured on a
  paired 1080x1920 and 1920x1080 wall, no run under the floor, nothing clipped,
  and the panel frame *different* from the default variant where the honours
  table says it is honoured and *identical* where it says it is not.
- **5.1** Group children resolve to the same pixels on the wall and on a panel
  frame, decoded; a template with a group applies through `applyTemplate` and
  round-trips through the editor's save.
- **5.2** Drive the wall's clock across a schedule boundary with `HARNESS_HOUR`
  and assert the canvas swapped, offline, from the stored copy.
- **5.3** A Weather box with no location on a fresh wall draws its fallback,
  and the box union (`wall-density`'s `contentSharePercent`) does not fall.
- **7** An enumerated-bypass table against the pure sanitiser in the shape of
  `safeNextPath`'s: `@import` in every spelling the parser accepts, `url()`
  inside `image-set()` and `cursor`, a selector escaping through `,`, a
  `\` -escaped brace, a comment splitting a keyword. Then a browser test that
  installs a refused block by hand and reads the CSP violation report.

## 11. Rollout

1. 4.3 and 4.4 — days each, no schema change beyond one column.
2. 4.1 — the lane, the server-side resolver, the honours table entries.
3. 4.2 — one widget at a time, clock first, each with its measurement.
4. 5.3 substitution, then 5.2, then 5.1 with multi-select, then 5.3 yield as a
   decision on its own.
5. 7, if asked for, behind its three preconditions, and the CSP on its own
   before any of it.

## 12. Open questions

- Should the lane's `scale` exist at all? It is the one control here that can
  take a run under the reader's angle, and a household who wants a bigger clock
  has a bigger box. Leaning towards shipping the lane without it and adding it
  only if a variant cannot cover the case.
- Does a group carry its own style lane that its children inherit? Probably
  yes, because that is the whole of 4.4 one level down, but it doubles the
  places a token can be set and the preview has to show which one won.
- Is `whenEmpty: 'yield'` worth its cost on the panel? A full refresh on a
  battery panel every time a chore board empties is a real price for a hole
  that substitution already fills.

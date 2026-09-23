# RFC 014 — Styling and layout flexibility

Status: **proposed; §7 precondition 1, §4.1, §4.3 and both halves of §4.4 are
built** — the display serves a Content-Security-Policy
(`apps/server/src/http/app.ts`, `apps/server/test/display-csp.test.ts`), a
widget carries its own style lane resolved server-side
(`apps/server/src/api/widget-style.ts`, `apps/display/src/widget-style.ts`,
`apps/server/test/browser-widget-style.test.ts`), a custom theme can name a
shape (`apps/server/src/api/themes.ts`'s `resolveTheme`,
`apps/server/test/browser-theme-shape.test.ts`), a wall names its own gutter
step across both budgets (`screens.layout_gutter`, migration `0047`,
`apps/server/src/gutter.ts`, `apps/display/src/gutter.ts`,
`apps/server/test/browser-canvas-gutter.test.ts`) and its own default widget
style (`screens.layout_style`, migration `0048`,
`apps/server/test/wall-style-settings.test.ts`); and §4.2's first row, the
clock's three variants (`config.variant`, `apps/display/src/clock-face.ts`,
`apps/server/src/epaper/clock-face.ts`,
`apps/server/test/browser-clock-variants.test.ts`); and §5.3's substitution
half, a fallback for an empty box (`config.whenEmpty`, resolved in
`keepWidgetsWithSomethingToSay`, `apps/server/test/browser-when-empty.test.ts`)
— its yield half is not built and is a separate decision; and §5.1's **model
is built; editor pending** — `layout_widgets.parent_id` (migration `0050`), a
`group` widget type laid out by `apps/display/src/group-cells.ts` and its
transcription, both renderers placing the children inside the group, and one
gallery template, Classic Strip, that carries one
(`apps/server/test/widget-groups.test.ts`, `reflow-stability.test.ts`'s grouped
halves, `browser-grouped-card.test.ts`); multi-select and the Group action are
the next session, and until then the editor neither shows a group as one nor
carries its links through a save. Nothing else here is built ·
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

### 4.1 A per-widget style lane (the ink lane's twin) — **built**

Let a widget carry its own token set, applied on its box exactly as
`applyTheme` applies the household's on the root — one element down, so every
rule under the box inherits it and nothing else on the wall does.

**Built, with two of the four new keys and not the other two, by decision.**
The lane is `config.style` on `widgetConfigBody` (`api/widget-style.ts`),
picked from `themeTokensSchema` — the eleven colours and the two faces, all
optional — plus `weight`, `tracking` and `inset`. It carries **no `--radius`**,
because the Corners control already exists and two controls for one decision
is the ink lane's own argument against `showHours`; and **no `scale`**, which
is deferred rather than declined — it is the one control here that can take a
run under the reader's angle, and it waits on its own measurement. Shape is
not per widget. The draft's shape is otherwise what shipped, and the two
paragraphs it got most right are worth restating as what was measured:

- **The custom-theme derivation runs per widget, on the server**, through the
  same `withTints` a custom theme goes through, and only for the derived tokens
  whose inputs the lane moved — so a widget that sets `--accent` alone carries
  `--accent` and nothing else, and the daylight theme still reaches every token
  it did not claim. The RFC's own case is the acceptance: a widget with `--bg
  #FFF8E7` and `--ink #2A2A2A` on a Panels wall draws its date numeral at
  4.5:1 or better against its own ground, where the theme's scaffold would
  land at 2.6:1; reverting the re-derivation turns that assertion red. A wall
  that switches at daylight gets the lane resolved twice, once per ground,
  and the display applies the record for the theme on the glass.
- **The manifest carries `styleTokens` and the display never reads `style`**,
  exactly as the panel reads a merged `ink` and the wall never looks at it.
  Absent is spread, never emitted empty: an unstyled wall's manifest was
  compared byte for byte, and by ETag, against a clean build of the commit
  this landed on, and is identical.

What the draft could not know is where the theme's ground *is*. `applyTheme`
sets `--bg` on the root and the body paints it; a widget box has no ground
rule of its own, so a lane's `--bg` would be a colour nothing reads — the
`options.json` bug in a colour input. The lane paints the box it sets `--bg`
on, which is also the ground its own `--ink-scaffold` was measured against,
and that is what makes the contrast promise true rather than declared. The
wall-level default (§4.4) is applied on the canvas, whose own ground rule
follows `--panel` as it always has.

Two things the panel taught. `style.inset` is in `PANEL_HONOURS` for every
type and moves the frame's own padding, on the wall's spacing ladder scaled to
the panel's own inset; the colours, the faces, weight and tracking are in
`PANEL_IGNORES` under the same `style.<key>` spelling, each with the sentence
a household reads. `epaper-ink.test.ts` expands the schema's `style` key into
its members and probes each by rendering, so `style.inset` is proved to move
ink and `style.--bg` proved not to, exactly as every top-level key is. And
because the lane is absent on every widget until a household opens the tab,
no shipped panel's pixels move and `EPAPER_RENDERER_VERSION` is unmoved.

The editor's "Colours and type" section is the inherited-number pattern one
widget down, with one correction to it: turning "Inherit the wall's theme" off
reveals the controls seeded with what the widget is inheriting and **writes
nothing until a control is touched** — seeding a whole lane the way a single
number is seeded would freeze eleven colours onto every widget a household
merely looked at. The whole section carries one config key no panel lane
offers, so `pruneToLane` drops it on the ink lane in one piece.

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

### 4.2 Designed variants per widget type — the clock **built**

The calendar already has four cell treatments (`text`, `dots`, `pills`,
`swiss`) and two densities, and Swiss mode is the model: a *mode*, drawn on
purpose, measured on a real wall, panel-aware through the honours tables. The
other widgets have none. Each gets a small `variant` enum:

| Widget | Variants worth drawing |
|---|---|
| clock — **built** | `plain` (today), `stacked` (time over date), `analogue` (a filled-path face, no hands animation) |
| weather | `strip` (today), `column`, `today-only` (one large reading, the forecast as a single line) |
| shift | `badge` (today), `line` (one row, the ladder's own one-rung form as a choice), `calendar-strip` (the run as seven small cells) |
| homeassistant | `list` (today), `grid` (readings as a 2-up or 3-up), `strip` |
| notes | `plain` (today), `card` (a rule and a heading), `large` (the text as the widget's lede) |
| countdown | `number` (today), `bar` (days elapsed of the whole), `calendar` (the target on a small month) |

Each variant is a designed alternative and each is a `browser-*` measurement
before it ships, the way Swiss mode was. **The clock's row is built** — `variant` is one enum
on `widgetConfigBody` for every type, the way `mode` is, and each renderer
filters to its own allowlist, so a value a type does not know is "not for me"
and draws that type's default. Absent is `plain`, so no stored config or ETag
moved; `stacked` keeps the 1.8x cap over the lede on the time line, on an
unmeasured wall too, and draws the weekday and the date in the scaffold role;
`analogue` is a filled face on the 24 grid in `glyphs.ts`'s idiom with two
wedge hands and no seconds hand, sized to the shorter side of its box and
taking no type role. A panel honours all three (`PANEL_HONOURS`, `INK_LANE`),
rasterising the face from the same geometry the wall's SVG is drawn from
(`clock-face-parity.test.ts`); `EPAPER_RENDERER_VERSION` did not move, because
nothing stored carries a variant yet. The other five rows wait, one widget a
session. This is how the project has always
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

### 4.4 Canvas-level styling — **built**, both halves

Two things a household reaches for that are about the wall rather than a
widget: a **gutter step** between boxes (today the canvas spends up to `--s5`
and the household cannot choose less or more), and a **default widget style**
the lane in 4.1 inherits from, so a household who wants every widget in
Fraunces sets it once. Both are one row on the screen's layout settings, both
are the existing scale, and both fall inside the "no absolute px" rule by
construction.

**The gutter step shipped, and the draft above was wrong about the top of the
ladder.** It says the canvas "spends up to `--s5`". It does not: the boxes
tile, so the only room between two adjacent widgets is twice the `.fw` padding
and nothing else, and that padding is `calc(var(--s4) / 2)` — a gutter of
exactly `--s4`. The `--s5` in the draft is the spacing scale's *canvas*
permission, which is a ceiling on what a canvas may spend and not a
description of what this one does. So the ladder is five steps down to
nothing, `0` through `4` mapping to `0`, `--s1` … `--s4`, and the top of it is
where every wall already stood.

It stopped there at first, and the reason was half right. The gutter is drawn
as the *widget box's own padding*, and the scale's second permission is that a
widget box spends at most step 4, total, per axis — so a step-5 gutter **spent
as padding** would be canvas spacing taken out of the widget's budget. What
that argument missed is that the scale declares a *third* permission, on the
canvas itself — *at most step 5 between the boxes it holds* — and the wall had
never spent a pixel of it. Two budgets, and only one was in use.

**So the airier half is built, and it is a second mechanism rather than a
larger number.** The ladder is one household-facing rung count and the
renderer decides how to pay for it: up to `--s4` out of the widget's padding,
with the boxes still tiling; past it the padding stays pinned at its
permission and the **canvas** pays, by taking room out of the box rectangle so
the boxes stop sharing edges and the wall's own ground opens between them.
That is the honest reading of "room the boxes do not own". Seven rungs, the
top two spending `--s3` and then `--s5` of the canvas budget, for a widest
gutter of `--s4 + --s5` — the sum of the two permissions and nothing beyond
either.

Three things in it are load-bearing and none is obvious from the diff.
**A box gives up half the gutter on each side that is not the edge of the
layout**, which is what lets the placement be decided per box with no
adjacency graph — two boxes that share an edge each give up half and end up a
full gutter apart — and, more importantly, is what stops an airier wall
letterboxing itself: Classic's boxes were reworked to *tile* because the wall
was losing a third of itself to margins it did not need, and insetting every
side would hand that border straight back. **`--bw`/`--bh` stay the authored
fractions** and `.fw` nets `--buw`/`--buh` of what the box lost, or a widget
that sizes its own type against its box sizes for room the canvas has just
taken. And **the two mechanisms are not interchangeable even where the
arithmetic agrees**: for a widget with no background they move content by the
same distance, but on a theme that draws a widget as a card, padding grows the
card where an inset opens a gap *between* cards — which is what a household
asking for an airier wall is actually asking for.

**The default widget style shipped with §4.1**, and it is that lane once, for
the wall: `screens.layout_style` (migration `0048`, one `ALTER TABLE ADD
COLUMN`), the same schema, resolved the same way against the wall's theme and
carried as `layoutStyleTokens` on the manifest's `screen`, applied on the
canvas so every box inherits it and a widget's own lane overrides it token by
token — a widget setting `--ink` over a wall whose default set `--bg` gets a
scaffold measured against the ground it will actually sit on. It is the
"Colours and type" group on the wall's Layout settings, behind the same
switch. One thing the form had to decide that the inspector did not: a colour
input always posts a value, so the handler diffs every field against the
theme's own colours and **keeps only what differs** — otherwise the first
saved change would freeze all eleven colours onto the wall and the daylight
theme would never reach them again. Null and an absent marker leave the column
as it was, the gutter's rule.

What the gutter step is:

- `screens.layout_gutter`, nullable, migration `0047` — generated and read as
  a single `ALTER TABLE ADD COLUMN`, the `0009` shape. **Null is what the wall
  drew before the column existed**, spread out of the manifest rather than
  emitted as a null, so a household who never opens the setting sends the
  bytes they sent before and no stored ETag churns. Out of the ladder is
  refused rather than clamped, which is `physicalWall`'s rule one setting
  along. The airier half widened the ladder from five rungs to seven and
  touched no schema: the column already held an integer and the step's
  *meaning* is the display's table.
- One custom property, `--fw-gutter`, written on the layout by `renderFreeform`
  and read by exactly one rule: `.fw`'s `padding: calc(var(--fw-gutter,
  var(--s4)) / 2)`. The fallback is the whole of rule nine here — an absent
  property computes to the value every wall has always drawn, and
  `renderFreeform` *removes* the property rather than writing a default, so
  the two directions are one mechanism. No other rule in the stylesheet
  changed.
- `segControl` on the wall's Layout settings, riding the settings form's one
  Save. One segment is always checked, and on a wall that has never been asked
  it is `Normal` — null and step 4 are the same pixels, so that is honest
  rather than a default wearing a different hat (RFC 015 §3.5's argument about
  the theme cards, one row along).
- **In neither honours table, and the note is at `PANEL_IGNORES`.** An entry
  looks right and would turn `epaper-ink.test.ts` red: both tables are keyed
  on a widget's config, closed against `widgetConfigBody`, and every entry is
  proved by setting its key on a widget and watching no ink move. A screen
  column has no widget to be set on — the `allow_todo` argument verbatim. A
  panel's every measurement is arithmetic on the panel, so there is nothing
  for a wall's step to override even when the panel is following that wall.

Verified as §10 asks: `browser-canvas-gutter.test.ts` measures the gap between
two adjacent widgets' **content** edges on a real paired Classic wall at
1080x1920 — zero at step 0, `--s4` at step 4 and `--s4 + --s5` at the top, each
read off a probe planted in the same layout so every `var()` resolves through
the live cascade — with the gap growing at every rung and never shrinking, the
widest padding any box spends pinned at `--s4` across the airier rungs (the two
budgets staying separate), the boxes still reaching all four edges of the
layout at every rung, no run under the floor at either end, and a block of its
own for the wall nobody has asked, which is the one the `.fw` fallback exists
for.

**Two assertions written for the airier half could not turn red and the
probing is why they were replaced.** Whether anything *overflows* its box
cannot see `--buw`/`--buh` being netted: `.clock` is a block, so its
`scrollWidth` is its parent's width until the text is genuinely wider, and on
this fixture it fits at either size. Nor can a 12-hour clock, which is where
this went next on the strength of this repository's own note that "08:26 pm"
puts the clock on its *width* term — measured on the live wall, the clock here
is bound by its **height** term and the width one never binds. What is
observable is the **proportion**: 89.9px of type in a 173px box at the default
rung and 78.0px in a 150px box at the airiest, the same 0.52 twice, because the
widget followed its box down. Reverting the netting moves it to 0.60 and the
file goes red with that sentence. `wall-density` and
`browser-classic-proportions` were run on a clean worktree of `main` and on
the branch at the same pinned hour: with the column null every `BASELINE`
number is unmoved. Six mutations were checked and all six are red, including
the fallback reverted, which reddens the unasked-wall block alone and leaves
both ends of the ladder green.

## 5. Layout — four steps

The canvas already gives free placement, z-order, overlap, a canvas per
orientation, a canvas per screen, letterboxing and `follow`. What it lacks is
**composition** and **time**, not freedom of position. What it must not regain
is the retired `auto` layout's reflow — the paragraphs in `CLAUDE.md` marked as
history are the last time the project reasoned that through, and 5.3 below is
the one place this RFC deliberately re-enters that ground.

### 5.1 Groups — model built; editor pending

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

**Built as the second shape, with four things decided in the building.** The
migration turned out to be *one* `ADD COLUMN` (`0050`, generated then read):
`parent_id`, nullable, null for every row that existed. **Placement is from
order, never from the children's fractions.** A group in `row`, `column` or
`grid` layout divides its inner box — its box less the gutter step it spends
as padding, which is §4.4's `--fw-inset` — equally among its children in `z`
order, from a pure table (`apps/display/src/group-cells.ts`, transcribed into
`epaper/group-cells.ts` and held character-identical), and reads nothing a
child draws; the children keep their own stored `x`/`y`/`w`/`h` only so an
ungroup can put the boxes back. That is what makes a group's rectangles a
function of the arrangement alone, and `reflow-stability.test.ts` holds a wall
carrying one to identical child rectangles across two event sets, on the glass
and in a decoded panel frame's region log — the refresh contract in
`epaper/render.ts` extended to a household's canvas. **The bound is refused
twice**: `placedWidgetsBody` refuses a group naming a parent and a child naming
anything but a group on the same list with a 400 (the `ink.ink` rule), and
`keepWidgetsWithSomethingToSay` prunes the same shapes on the way to either
renderer, dropping an orphan rather than drawing it at fractions of a box that
is not there. **A group speaks when a child does**: it is kept exactly when one
of its children has something to say (a child's own `whenEmpty` counts), and
dropped whole otherwise; it carries no fallback of its own. **A template names
a parent by a local key**, `key`/`parent`, because ids are minted at apply
time; `applyTemplate` mints the parents first and writes the children with the
resolved id, `copyLayout` re-links a copied child to the copied group, and the
gallery's card JSON is resolved the same way so the card draws the group the
wall will. One template carries one: Classic Strip, Classic's calendars
untouched under a row of the clock, the forecast and the rota badge. An
unstyled, ungrouped wall's manifest and a groupless panel's ETag preimage are
byte-identical to what they were, asserted rather than assumed.

What is *not* built is the editor's half, and it is the larger: multi-select,
the Group action, an ungroup, and — first, because it is the one that loses
data — carrying `parentId` through the editor's save. Today the editor shows a
grouped wall's children as top-level boxes at their stored fractions read as
canvas fractions, its live preview draws the group correctly beneath them, and
a Save flattens the group into three boxes at those fractions. Written down
rather than papered over: the template is opt-in, the wall draws, and the next
session's first item is that round trip.

### 5.2 Scheduled canvases **built**

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

**Built, as written, with four things decided in the building.** Storage is
`layout_widgets.slot` (nullable; null is the default canvas, which is every
row that existed) and `layout_schedule` keyed on the screen, migration
`0049`, generated then read: one table, one index, one `ADD COLUMN`. Named
slots are bounded at four per wall (`MAX_LAYOUT_SLOTS`), in the handler
rather than the schema, because a `CHECK` cannot count rows. The schedule's
rows are the interrupt window's all-or-nothing rule and wrap past midnight
exactly as the daylight theme's window does — the display's `windowContains`
is held to `daytimeActive` at every minute of the day, and the server's copy
to the display's character for character. The manifest carries `layout.slots`
and `layout.schedule`, **both spread away** on a wall with one canvas and no
schedule, so that wall's document is byte-identical to the one it always sent
and no stored ETag churns; a schedule change moves the ETag on its own, which
is pinned rather than assumed. `pickCanvas` in `main.ts` takes the wall's
corrected local time on the fifteen-second tick — the same reading the theme
switches on — and picks *within* the orientation: the slot's widgets, the
orientation's own aspect and background. A slot with no canvas on the
orientation the wall is hung at falls back to the default slot's canvas for
it, never to a blank.

- **A panel follows a wall's default slot only.** A battery panel is a glance
  class, asleep for most of an hour showing a frame it drew earlier, so a
  canvas that must change at 06:30 is one it cannot honour. `readLayoutWidgets`
  reads the default slot unless told otherwise and no panel path ever tells it
  otherwise; the panel's own page says so in words, and the server refuses a
  slot posted at a panel.
- **The editor is one mechanism, not two.** The slot tabs beside the
  orientation buttons are `wireTabs` — the roving tabindex the inspector's
  tabs and the ink lane use — drawn only once a wall holds a named layout,
  with New and Remove in the Layout popover, because a second segment in the
  toolbar wrapped it onto a third row on a 390px phone and cost the canvas
  the half-screen floor `browser-editor` measures. The stash became a map keyed on
  `(orientation, slot)`, so dirtiness is a comparison per canvas and Save
  writes every canvas that differs, the named ones with their slot in the
  body and the default without one. Undo is per canvas. **New layout** copies
  the canvas on screen under a new name with fresh widget ids, which is the
  whole "start from what you have" affordance; **Remove layout** takes a named
  one off the server with every rule naming it.
- **The schedule is rows on the wall's Layout settings** — from, until, which
  layout — behind a marker the handler reads them by, so a stale tab saving a
  timezone leaves the schedule alone. A slot is called a *layout* wherever a
  household reads it, because `canvas` is a retired noun on those pages.
- **The measurement is the boundary, not the rule.** A wall loaded ten seconds
  before 06:30 on the harness's clock, `/d/manifest` then blocked at the
  network, swaps on its own tick with zero manifests delivered and its canvas
  rectangle unmoved; a wall whose server has been killed and whose device
  clock is fixed at 07:00 draws the morning canvas out of IndexedDB on a
  reload, and the everyday one at 09:00. The mutation is a window one minute
  later than the wall's clock: same load, same wait, no swap.

### 5.3 A fallback for an empty box — substitution **built**, yield not

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

**Substitution is built, and yield is not.** `whenEmpty` is one strict object
on `widgetConfigBody` — `{ type, config }`, `type` from `WIDGET_TYPES`, and
`config` the widget's own config with `whenEmpty` and `ink` *omitted* from it,
so `whenEmpty.config.whenEmpty` is a rejected key the way `ink.ink` is and
"one level deep" is a fact about the shape. It is resolved in exactly one
place, `keepWidgetsWithSomethingToSay`, which the wall's canvas and the
panel's frame already share: a widget with nothing to say becomes its fallback
— same id, same box, same `z`, marked `substituted: true` on the manifest
widget — provided the fallback has something to say itself, and **the
substitution runs before the never-empty guard**, so a canvas of nothing but
empty boxes with fallbacks draws the fallbacks rather than the placeholders.
Two things were decided in building it that this section did not say:

- **`whenEmpty` never reaches the wall.** It is resolved before the manifest
  is written, so `displayConfig` drops the key; carried, a to-do fallback's
  entity id would have travelled inside a box that is not a to-do widget,
  where `list`'s rewrite never looks — rule 12 one level down.
- **The honours table carries it only on the types that can be left out**
  (Weather, Home Assistant, Shift, To-do). The table is derived by rendering,
  and a fallback on a clock or a calendar can never move ink, because neither
  is ever omitted.

The inspector offers it under the omission note — *Leave the box empty* or
*Show another widget*, a type picker that never offers a type the wall would
leave out too, and that type's minimum content (a note's words, a countdown's
name and date, a checklist's lines). A picture and a module's panel are not
offered, since each needs a picker of its own.

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
  divisions, and the schedule (5.2) as rows of *from – to – canvas* (built:
  *from – until – which layout*, since `canvas` is a retired noun there).
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

- **4.1** `browser-widget-style.test.ts` — **built**: a widget carrying `--bg`
  and `--ink` draws its date numeral at 4.5:1 or better against *its* ground,
  read off the computed colours; every run in a restyled widget is still its
  role's angle on a measured wall; a sibling widget's computed tokens are
  byte-identical with and without the lane; an unstyled wall's document
  carries no trace and round-trips through styling to the same bytes; and the
  inspector reveals the controls seeded with the theme's values while the ink
  lane offers none. Reverting the per-widget re-derivation turns the contrast
  assertion red (checked, with seven other mutations). The `scale` clause is
  not built because `scale` is not: it waits on the control.
- **4.2** One `browser-*` file per variant, the Swiss-mode shape: measured on a
  paired 1080x1920 and 1920x1080 wall, no run under the floor, nothing clipped,
  and the panel frame *different* from the default variant where the honours
  table says it is honoured and *identical* where it says it is not.
  **The clock's is built**, `browser-clock-variants.test.ts`, on an
  unmeasured wall and a 32" television at both sizes: `plain` measures
  exactly what a clean worktree of `main` drew, absent and spelled out;
  `stacked` holds its digits at 1.8x the agenda's title or under, its three
  lines in order and nothing clipped — read as `scrollWidth`, and in two
  dragged-small boxes where its own height share and width term are what
  bind; `analogue` fills 99.8% of its box's short side, holds no text, and
  points its hands at the harness's eleven o'clock, read back out of the path
  data. The panel's frames (`epaper-clock-variants.test.ts`) are `main`'s
  bytes for plain at three sizes and four configs, and different for the
  other two. Fifteen mutations, all red.
- **5.1** Group children resolve to the same pixels on the wall and on a panel
  frame, decoded; a template with a group applies through `applyTemplate` and
  round-trips through the editor's save. **The model's half is built**:
  `reflow-stability.test.ts` draws Classic Strip twice with different events
  and holds every group and child rectangle identical to the hundredth, and
  renders a grouped panel canvas twice with identical region logs, ink inside
  every child's content box and none in its padding; `widget-groups.test.ts`
  holds the two refusals at the boundary and in the walker, the keep rule, the
  minted parent-before-child rows, the copy's re-link and the byte-identical
  groupless documents; `browser-grouped-card.test.ts` reads the gallery card's
  group against the paired wall's. The editor round trip waits on the editor.
- **5.2** Drive the wall's clock across a schedule boundary with `HARNESS_HOUR`
  and assert the canvas swapped, offline, from the stored copy. **Built**,
  `browser-scheduled-canvas.test.ts`: the app's clock moved to ten seconds
  before the window (`shiftClock`, so the wall reads it off `x-server-time`),
  the manifest blocked, the swap read back after one tick with zero manifests
  delivered; then the server killed, the device clock fixed inside and outside
  the window, and the reload drawing the right canvas from IndexedDB each
  time. The one-minute mutation does not swap. `browser-editor-slots.test.ts`
  drives the editor: an edit on one slot dirty across a switch, clean after
  undo, both slots posted by one Save, a layout started from the current one
  and removed again. `layout-schedule.test.ts` pins the byte-identical
  unscheduled document, the moving ETag, the panel frame unmoved, the window
  parity and every refusal at the two boundaries.
- **5.3** A Weather box with no location on a fresh wall draws its fallback,
  and the box union (`wall-density`'s `contentSharePercent`) does not fall.
  **Substitution's is built**, `browser-when-empty.test.ts`: two fresh walls
  through the add page on the full Classic canvas, one with a note behind its
  Weather box — the note drawn in that box on the wall, ink in the same box on
  a following panel's decoded frame where the plain wall's panel has none, and
  `contentSharePercent` 86.0% → 100.0% at 1080x1920. The fallback never
  replacing a widget with something to say and the substitute-before-guard
  ordering are unit assertions (`widget-omission.test.ts`,
  `epaper-ink.test.ts`), and the editor's accessible name following a change
  of fallback in place is `browser-editor.test.ts` §10. Six mutations, all
  red.
- **7** An enumerated-bypass table against the pure sanitiser in the shape of
  `safeNextPath`'s: `@import` in every spelling the parser accepts, `url()`
  inside `image-set()` and `cursor`, a selector escaping through `,`, a
  `\` -escaped brace, a comment splitting a keyword. Then a browser test that
  installs a refused block by hand and reads the CSP violation report.

## 11. Rollout

1. 4.3 and 4.4 — days each, no schema change beyond one column.
2. 4.1 — the lane, the server-side resolver, the honours table entries.
   **Built**, with §4.4's default widget style beside it.
3. 4.2 — one widget at a time, clock first, each with its measurement.
4. 5.3 substitution (**built**), then 5.2 (**built**), then 5.1 — the model
   and one template **built**, multi-select and the Group action next — then
   5.3 yield as a decision on its own.
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

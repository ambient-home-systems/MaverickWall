# RFC 015 — One place for colour, and no default theme

Status: **shipped** (phases 1, 2 and 3) · Owner: — · First drafted 2026-09-13 ·
Revised 2026-09-14 · Shipped 2026-09-14 ·
Relates to `apps/server/src/http/admin-themes.ts`,
`apps/server/src/http/theme-cards.ts` (phase 1; `themeCards` and its table moved
out of `admin.ts`), `apps/server/src/http/admin.ts` (`wallDefaultsForm`,
`newWallPage`, the wall settings Appearance pane), `apps/server/src/api/templates.ts`,
`apps/server/src/api/queries.ts` (`createScreen`, `setOwnerTheme`),
`apps/server/src/db/schema.ts` · Builds on the component layer (RFC 009 phases
10A/10B), the add-a-wall page (RFC 009 phase 4) and `retireDefaultWall` ·
Constrains nothing · Amends no hard rule ·
**Rests on a premise recorded in §4: this product has no installation outside
the author's own testing environment**

> **Revised after review, and the revision is the document.** The first draft
> proposed keeping a household default theme on System and turning Themes into
> the gallery that edits it. That was rejected: **there should be no default
> theme at all.** Every wall picks one when it is created, cannot be created
> without one, and can be changed afterwards. §2 survives the revision intact —
> if anything the count in §2.8 argues the stronger case — and §3 onwards is
> rewritten. The old §3.3 ("System keeps a stated summary") is gone; §5 records
> why keeping it was wrong.

> **Revised again after a source audit, and every number below was re-measured
> rather than carried forward.** Thirteen corrections, of which four change what
> the document asks for rather than what it claims: `screens.theme` cannot be
> `NOT NULL` while an e-paper panel is a row in the same table (§4); the count
> in §2.8 is six rather than four, and the two it missed are server-side
> literals rather than settings (§2.8, §3.2); deleting a theme in use leaves a
> dangling reference under a rule that says every wall names its own theme
> (§3.4); and **Duplicate costs a transcription of five token sets the server
> does not hold**, which the document priced at nothing (§3.4). The rest are
> facts: `screens` carries 46 columns and not 92, `migration-upgrade.test.ts`
> already walks four screens, §4 drops four household columns and not two,
> §2.1's one retired-name site is four, §3.1's suggestion needs a script the
> page does not load, §3.6's saved strip collides with `saved.ts`'s own rule,
> and §6 lists the tests to write and none of the ones that have to change.
> Line numbers in this note are measured at `3f7940e`; the ones in the body
> predate it and have drifted. A **Phasing** section is added at the end,
> because the audit's first finding is that this document is three changes in
> a trench coat and the copy-only one is shippable today.

## 1. Summary

A household reported two places to pick colours. Counted from the source it is
**three screens and six mechanisms**, and the screen named "Themes" is not one
of them.

| Screen | Sets the theme? | Control |
|---|---|---|
| `/admin/system` → "Wall appearance" (`admin.ts:3134`) | yes — household default, daytime theme, daylight window | `themeCards` — radio swatch cards |
| `/admin/themes` (`admin-themes.ts`, 385 lines, 8 routes) | **no** | — |
| `/admin/walls/:id` → Appearance pane (`admin.ts:4047`) | yes — per-wall override | plain `<select>` ×2 |

So the sidebar entry named after colour is the one screen where colour cannot be
chosen, and the two that do choose it render **one stored value through two
different controls** — `shifts[0]` / `display_mode` / `cellEvents` one layer up,
occurring in the controls rather than in the renderers.

This RFC proposes:

1. **The household default theme is retired.** `household_settings.theme` and
   `daytime_theme` are dropped, along with the column default of `board` — a
   theme key that has not existed for releases (§2.8).
2. **Every wall names its own theme, and cannot exist without one.**
   `/admin/walls/new` asks, with nothing preselected, and refuses to proceed
   until the household has chosen. Every other door that creates a wall answers
   the same question.
3. **Themes is where every theme is seen, understood and changed**, for walls
   that already exist — the five built-ins and every custom one in one grid,
   each tagged with which walls wear it.
4. **The wall page drops its two selects for the same cards**, so the choice has
   one appearance wherever it is taken.

No token set changes, no manifest *shape* changes, and the display bundle is not
touched.

**One fault in §2.1 is a shipped defect with no design decision attached and
should not wait on any of this.**

## 2. What is wrong, counted

### 2.1 The Themes page names three themes that no longer exist

`admin-themes.ts:256`, inside `emptyState(…)`:

> "The four built-in directions (Board, Kitchen Slate, Paper Almanac, Glance)
> can be chosen in each wall's settings."

`board`, `slate` and `glance` are every member of `LEGACY_THEME_ALIASES`
(`admin.ts:573`), all three mapping onto `panels`. The live set is `THEMES`
(`admin.ts:545`) and it is **five**: Panels, Household, Blueprint, Paper Almanac,
Swiss. The sentence names four, three of them retired, and omits three that ship.

It has **propagated in both directions**: CLAUDE.md's closing "The design file"
section names the identical retired four. The prose outlived the code and then
became what somebody copied from. `THEMES` and `LEGACY_THEME_ALIASES` are what
the picker actually renders.

**And it is four sites, not one.** The audit found three more, and the third is
the one that reaches a wall:

- **The delete confirmation** (`admin-themes.ts:165`) tells a household that the
  walls wearing the theme they are removing "switch to Board". A sentence
  printed at the moment somebody is destroying something, naming a theme that
  has not existed for releases.
- **`resolveTheme` answers `shape: 'board'`** for a dangling `custom:<id>`
  (`api/themes.ts:266`, `:269`), so a wall whose theme was deleted carries a
  retired key in its manifest and is rescued by the display's alias table. The
  third `'board'` beside them (`:270`, a custom theme that *did* resolve) reads
  like the same fault and is not: `applyTheme` sets `data-theme` from that value
  verbatim and `:root[data-theme="panels"]` is a live **shape** rule, so `board`
  there is a deliberate *neutral sentinel* — the display's own comment says so
  — and renaming it would give every custom theme the Panels card treatment.
  Retiring that one needs a real neutral key in the display bundle, which is a
  display change and therefore not a copy fix.
- **`themeUsage`'s docstring** (`api/themes.ts:333`) says a dangling reference
  "falls back to Board", which is what the function it describes does and not
  what a household should be told it does.

### 2.2 The built-ins vanish the moment a household makes one theme

They are named nowhere on the page but inside that empty state, drawn only when
`custom.length === 0`. Create one theme and the five built-ins are listed nowhere
in the product except two dropdowns and one card grid on other screens.

### 2.3 `themeUsage()` answers the one question a list needs, and the list does not ask it

`api/themes.ts:338` returns `{ household, screens[] }`. It has exactly one
caller: the delete confirmation. The fact that turns an inventory into something
navigable — *which wall is wearing this* — is computed, tested, and read only at
the moment a household is destroying something.

### 2.4 There is no route from building a theme to applying it

`POST /admin/themes` and `POST /admin/themes/:id` both `savedRedirect` to a list
with no chooser on it (lines 97, 131). The only instruction is the page intro's
prose — "selectable on the Walls page" — which is not a link.

### 2.5 The swatch cards were built for a screen that does not use them

`THEME_SWATCHES`' docstring (`admin.ts:554`) says the colours are "for the wall
settings theme cards". `themeCards` has **one** call site in the whole server,
`admin.ts:3169`, which is System. The wall settings page renders `selectRow`
twice instead.

### 2.6 Documentation says what a token paints, never what breaks

`TOKEN_HELP` (`admin-themes.ts:51`) is eleven one-line entries: "Panels — the
surface of cards and the month grid." Accurate and insufficient. Nothing on any
screen says:

- **why the shift hues matter** — they have to separate at ten feet, which is
  the whole reason there are four and the reason Panels is recommended. That
  argument lives in the design file and CLAUDE.md and nowhere a household reads;
- **that `--faint` is deliberately below the contrast bar**, so a contrast panel
  flagging it reads as a defect the household is being asked to fix;
- **that four more tokens are derived from theirs and silently corrected** —
  `withTints` (`api/themes.ts:229`) derives `--ink-event`, `--ink-scaffold`,
  `--ink-quiet` and `--rule-week`, and `scaffoldInk` raises its mix ratio until
  it clears 4.5:1 against that theme's own ground, so a low-contrast pair yields
  a result that is not what was chosen, with nothing explaining the correction;
- **what a theme does not control.** Type size comes from panel size and read
  distance on the wall's Device pane; layout comes from the editor. A household
  chasing "the text is too small" will come here — and `--radius`, the one
  non-colour control on the screen, encourages the belief that they are right.

### 2.7 The daylight window is written twice and behaves differently in each

System (`admin.ts:3173`) carries both sentences in one hint. The wall page
(`admin.ts:4059`, `:4093`) splits them across a hint and a trailing paragraph.
And From/Until are **always drawn** on System, **script-revealed** on the wall
page (`data-reveal-if="daytime_theme"`).

The divergence is deliberate and documented — System loads no editor script, so
a `hidden` group there would be a control nobody could reach, which is the
chores form's rule. The reasoning is right. The household still sees two screens
disagreeing about one setting and no screen saying why.

### 2.8 A wall's theme is decided in six places, five of them invisible

This is the finding that makes the revision's case, and it is not in the first
draft. Counted from the source, a theme reaches a wall by:

1. **`screens.theme`** — the per-wall override, nullable, null meaning follow.
2. **`household_settings.theme`** — the default, and the terminal fallback:
   `manifest.ts:1272` is `pick(input.screen?.theme, input.household.theme) ??
   input.household.theme`.
3. **Applying a template.** `applyTemplate` (`templates.ts:112`) calls
   `setOwnerTheme` when the card names a theme, and **twelve of the fourteen
   shipped wall templates name one** — seven `panels`, five `almanac`. Only
   Classic and Blank do not, and CLAUDE.md records that exemption as deliberate
   ("a card called 'Blank' repainting a kitchen is the last thing somebody
   pressing it expects"). Which means the other twelve **do** repaint a kitchen,
   and the household is told only by a caption on the gallery card.
4. **The column default.** `schema.ts:63` is
   `text('theme').notNull().default('board')` — the database's own default is a
   **retired key**, resolved by alias at read time. Nothing is broken by it and
   nobody could have known: it is a theme that has not existed for releases,
   sitting in the schema as the value every household starts from.
5. **`degradedManifest`'s own literal.** `http/app.ts:1090` hard-codes
   `theme: 'board'` in the stand-in manifest a wall gets when its database could
   not be read. Right to have a fixed value there — the row it would otherwise
   read is the thing that failed — and wrong to spell it as a retired key with
   nothing saying it is a stand-in.
6. **`previewManifest(null)`.** `http/app.ts:1612` passes `theme: null` and so
   resolves through the household row, which is the default again, one layer
   further out. It has four callers and none of them is a wall: the dashboard's
   today card (`admin.ts:1365`), `/admin/layout/preview.json` with no screen
   named (`admin.ts:3122`), the e-paper gallery card preview
   (`admin-epaper.ts:1215`) and `haReadingLabels` (`admin.ts:5212`).

Six mechanisms, of which the household can see one. "There is no reason for a
default theme" is the right conclusion, and it is stronger than it looks: the
default is not merely redundant, it is the thing that lets the other five stay
invisible, because every one of them is silently overriding a value nobody chose.

The last two are the ones that say what retiring the household row actually
costs. Neither is a setting, so neither is deleted by dropping a column — each
is a place that will have *no* value to read and must therefore name one. Both
must name **`panels`**, as a stated stand-in with a comment saying it is a
stand-in and not a default, which is §3.2's distinction written at the two
sites that would otherwise reintroduce it.

## 3. Proposal

### 3.1 Creating a wall asks for a theme, and will not proceed without one

`/admin/walls/new` already asks **name → what the hardware is → where the layout
starts → pair** (`admin.ts:2111`, `:2423`). A theme step joins it, between the
layout and the pairing, because the template is what suggests it.

- Rendered as `themeCards`, the same grid Themes and the wall page use.
- **Nothing is preselected.** The mandate is the whole point: a preselected card
  is a default wearing a different hat, and the household would proceed past it
  without a decision exactly as they do today.
- **Choosing a template moves the suggestion, not the answer.** Twelve cards
  name a theme; picking Sky Week highlights Paper Almanac *as a suggestion* and
  the household still has to confirm it. Nothing about which card is suggested
  can satisfy the requirement on the household's behalf.

  **That needs a script and this page does not have one**, which the first
  draft did not check. `/admin/walls/new` loads exactly one module,
  `assets/template-gallery.js`, whose whole job is drawing the thumbnails;
  nothing on it reacts to a radio. So the no-script form is the *specification*
  and the script is the enhancement: **nothing is suggested, and a choice is
  still required.** A household with no scripting picks a template and then
  picks a theme, which is the mandate working exactly as stated. The script,
  when it lands, only *marks* a suggestion — it can never check a card, because
  a checked card is a default wearing a different hat and that is the one thing
  this step exists to refuse.
- **The daylight pair does not join this page at all.** The first draft kept it
  here as "optional", which is the right answer to the wrong question: the
  wall page draws From/Until behind `data-reveal-if="daytime_theme"`, and
  `data-reveal-if` is implemented in `apps/display/src/display-editor.ts` and
  nowhere else — a bundle this page does not load. So the pair would arrive
  either always-drawn (two time fields on a creation form, for a schedule
  nobody has asked for) or `hidden` with no script to reveal them, which is the
  chores form's rule and a control nobody can reach. The wall page keeps the
  daylight schedule; creating a wall asks one colour question and stops. "The
  same theme all day" is still a real answer rather than a missing one — it is
  simply the only answer this page offers.

Enforcement is in the schema, not in the markup: `theme` becomes a required
member of the add-wall body, so a hand-posted body with no theme is a 400 and
not a wall wearing whatever the column defaults to. This is the form-versus-POST
rule `apply-template` already states — the form is a convenience and the POST is
the boundary.

### 3.2 What "no default theme" cannot mean, and this is rule nine

**Retiring the setting is not the same as deleting the fallback**, and the
distinction is `retireDefaultWall`'s word for word: *not reading the row is not
the same as retiring it*. Two things stay and neither is a default theme in the
sense being retired:

- `resolveName()` in the display bundle (`theme.ts:252`) falls back to
  `DEFAULT_THEME` (`panels`) for any key it does not recognise. That is the
  bundle refusing to draw a wall with no colours on it when handed a value from
  a newer server, and it must not be removed. A wall that fails to resolve a
  theme draws Panels rather than nothing — rule nine.
- The manifest still carries a resolved theme on every wall. What changes is
  only where the server resolved it *from*: `screen.theme`, and nothing behind
  it. `manifest.ts:1272`'s `?? input.household.theme` goes.
- **Two server-side stand-ins name a theme because no row will answer for
  them** (§2.8's fifth and sixth mechanisms). `degradedManifest`
  (`http/app.ts:1090`) builds the document a wall gets when its database could
  not be read; there *is* no screen row to ask. `previewManifest(null)`
  (`http/app.ts:1612`) builds the household's own document for four callers
  that name no wall — the dashboard's today card, `/admin/layout/preview.json`
  with no screen, the e-paper gallery card preview and `haReadingLabels`.
  Both take **`panels`**, written as a literal with a comment saying it is a
  stand-in and not a default. The distinction is the whole of this section: a
  default is a value a household's walls inherit, and these are values nobody
  inherits because nobody is asking for a wall.

  `degradedManifest` spells its literal `'board'` today, which is the retired
  key in the one document a household reads when everything else has failed.

The test that matters here is the one that would go red if somebody
"simplified" the display's fallback away while implementing this: a wall whose
manifest carries an unknown theme key must still draw.

### 3.3 An e-paper panel is not asked, and that is the rule applied rather than a hole in it

`grep` for `theme` across `apps/server/src/epaper/` returns **three hits, all of
them comments**. The panel renderer reads no theme. A panel is one bit.

So `/admin/epaper` does **not** gain a theme step. Asking a household to choose
between Panels and Paper Almanac for a black-and-white panel is a control that
does nothing, which is the `options.json` bug this project has now recorded
three times — and CLAUDE.md already names this exact case, where the panel
gallery captioned its cards "Looks best in <a theme>" on a screen that has no
theme.

The rule is therefore stated as: **every wall that draws colour names its own
theme.** A panel names none because it has none to name, and `panelCanvasOwner`
already establishes that a panel following a wall borrows that wall's canvas and
not its palette.

### 3.4 Themes becomes the gallery, for walls that already exist

`/admin/themes` lists every theme the wall can draw — five built-ins and every
custom one — as one `themeCards` grid, each card carrying its swatch, one line
of what it is for, and a `tag` from `themeUsage()`: "Kitchen, Hall", or nothing.

**Deleting a theme in use reassigns its wearers, in the same transaction.**
`deleteTheme` (`api/themes.ts:324`) is a bare `DELETE FROM themes`, so a wall
storing `custom:<id>` keeps pointing at a row that is gone and `resolveTheme`
rescues it at read time. That is rule nine working and it is also, under "every
wall names its own theme", a wall wearing a value nobody chose — which is
§2.8's whole complaint arriving through the back door. So the delete writes
`panels` onto every wearer as part of the same transaction, and the
confirmation names the walls **and the theme they will wear**, through
`themeName` rather than through a literal. The literal is how this sentence
came to say "Board" (§2.1); a second literal is how it would come to say
something else.

**Duplicate is deferred, and the reason is a cost this document did not
count.** A built-in offering Duplicate where a custom theme offers Edit is the
missing on-ramp — "I like Almanac but greener" today means starting from a
dark palette and matching Almanac by eye. But Duplicate has to *write a token
set*, and the server does not have one: the five built-in token sets live only
in `apps/display/src/theme.ts`, and what the server holds is
`THEME_SWATCHES` — three colours each, for drawing a card. Bringing them over
is a transcription held by a parity test, the `epaper/ladder.ts` seam this
project already runs three times, and a transcription of eleven colours ×
five themes is a larger commitment than a gallery. It belongs to a later phase
with the parity test written first.

With no household default there is nothing to *set* here, which is what makes
the screen coherent: it shows and edits themes, and walls choose them. Changing
which theme a wall wears is the wall's page, reached from the usage tag.

### 3.5 The wall page and the creation page share one control

The Appearance pane drops `selectRow` for `themeCards`, with no "follow the
household" card, because there is no household theme to follow. One decision,
one appearance, everywhere it is taken. §2.5 says the cards were written for
this screen; this is them arriving.

**Only the theme itself.** The *daylight* theme stays a `<select>`, whose first
option is "Same theme all day". Two card grids on one pane is two controls that
look identical and answer different questions, and the one a household reaches
for first is whichever is nearer the top — which is the `shifts[0]` fault
expressed as furniture. The daylight theme is also the half with a real absence
in it, and an absence is a line in a list rather than a card in a grid.

### 3.6 Applying a template stops repainting a wall silently

§2.8's third mechanism. `applyTemplate` keeps writing `template.theme` — it has
to, because a template's canvas backgrounds are designed for its theme and a
light background under a dark theme is unreadable, which is the comment's own
reason at `templates.ts:110`. What changes is that it stops being silent: the
`savedRedirect` token says which theme the wall is now wearing, rather than the
generic "Template applied."

**It is two keys, not a sentence.** `saved.ts`'s first stated property is that
the token is a **key and never a message** — nothing a caller passes is echoed,
the strip draws a literal from `SAVED_MESSAGES`, and rule five is satisfied by
the shape rather than by a validator. "Say which theme" would hand that
straight back. It does not have to: the fourteen shipped templates name exactly
two themes between them — seven `panels`, five `almanac`, and Classic and Blank
name none — so it is `layout-template-applied-panels` and
`layout-template-applied-almanac` beside the existing
`layout-template-applied`, which the two nameless cards keep. A test asserts
that **every template naming a theme has a key**, so a fifteenth template in a
third theme is a compile-time hole rather than a strip that quietly says the
wrong colour.

That is deliberately the cheap fix. The expensive one — asking, and carrying the
backgrounds across a theme the household kept — is written up in §5 and rejected.

### 3.7 The documentation gaps close where the household is standing

Not a docs page: this product has no published docs site, and that is now the
only entry on CLAUDE.md's "not started" list. The four facts in §2.6 go **on the
builder**, beside the controls they are about.

## 4. Migration

**This section rests on a premise, and the premise is recorded here because the
section is wrong without it: as of this writing the product has no installation
anywhere outside the author's own testing environment.** Confirmed by the
author. No household's wall changes colour because no household has one. If
that stops being true before this ships — a tagged release anybody has pulled —
§4 has to be rewritten, and the first draft's version of it (a boot-time
`retireDefaultThemes` behind a `default_theme_retired` flag, in
`retireDefaultWall`'s shape) is what it should be rewritten back into.

With no data to preserve, three things that were expensive become cheap, and
the whole of the first draft's migration machinery is deleted rather than
built.

**`screens.theme` gets a database constraint now, not later — and it cannot be
`NOT NULL`.** The first draft said `NOT NULL` and §5 recorded why it no longer
deferred it. The audit says `NOT NULL` is not available at all, and the reason
is §3.3 one table along: **an e-paper panel is a row in `screens`.**
`screens.kind` is `'browser' | 'epaper'` (`schema.ts:382`) and
`createEpaperScreen` (`queries.ts:1166`) writes no theme, deliberately, because
a panel is one bit and has no theme to name. A `NOT NULL` on that column would
either force every panel to store a colour it cannot draw — the `options.json`
bug written into the schema — or make §3.3 unimplementable. The two sections
contradicted each other and the contradiction was invisible because each is
right on its own.

So the constraint is a **CHECK**:

```
kind = 'epaper' OR theme IS NOT NULL
```

declared through `drizzle-orm`'s `check()` (present in 0.45.2; `drizzle-kit`
0.31 emits `CONSTRAINT "…" CHECK (…)` for SQLite — both verified against the
installed tree, not read off a changelog). It says exactly what §3.3 says —
*every wall that draws colour names its own theme* — and it says it in the
database, so every door in §4.1 is enforced by the engine rather than by a
reviewer and a door somebody adds in five years fails loudly at the insert.
SQLite has no `ALTER TABLE … ADD CONSTRAINT`, so this is still a **table
recreate** and §4.0's review step applies to it unchanged.

**That makes the "broken until a theme is selected" state unnecessary**, which
is worth stating because it is stronger than what was asked for. There is no
need for a wall to render an apology while it waits to be themed, and no need
for a renderer branch that draws one: an unthemed wall stops being a state the
product has — for a wall. A panel's `NULL` is not that state; it is the column
correctly saying the question does not apply.

**The backfill survives as one SQL expression, because it costs nothing.**
Permission to break existing walls is permission not to *build machinery*, and
the machinery is what was expensive — the boot function, the flag column, the
once-per-database guard. Preserving what a test wall was already drawing is a
`COALESCE` inside the migration's own copy step:

```sql
COALESCE(s.theme, (SELECT theme FROM household_settings WHERE id = 'singleton'), 'panels')
```

No boot code, no flag, no separate function. `retireDefaultWall` needed all of
that because it was copying *canvases* — rows in `layout_widgets`; a theme is
one scalar and fits in the migration that needs it.

**The alternative is one line and may be the better one for a test
environment:** `DELETE FROM screens`, and re-pair. It costs a few minutes and
it exercises the new creation flow end to end, which is the thing this RFC is
actually about and which a backfill lets you skip testing. Recommended if the
test walls are cheap to re-pair; the `COALESCE` if they are not.

**Four `household_settings` columns are dropped, not two.** The first draft
named `theme` and `daytime_theme`; `daytime_starts_at` and `daytime_ends_at`
(defaults `'07:00'` and `'21:00'`) go with them, and they are not decoration —
`manifest.ts:1274-1275` reads them as the fallback *schedule* for a wall that
set a daylight theme and no hours. Leaving them would keep a household row
deciding when a wall changes colour after retiring the row that decides which
colour, which is the same fault with the interesting half removed. All four
go. The first draft kept them unread, on CLAUDE.md's `display_blocks` reasoning
—
*somebody will otherwise read the column and believe it*. That argument is
about not rewriting a shipped household's row. With no shipped households the
cleaner thing is to remove them, so there is no dead column to misread at all.
better-sqlite3 11.x bundles SQLite 3.45+ and `ALTER TABLE … DROP COLUMN` landed
in 3.35, so this is a plain `ALTER` rather than a second table recreate —
**verify that with a one-liner before relying on it**, since it was not checked
empirically here (this session has no `node_modules` installed) and a
drizzle-kit that decides to recreate instead puts `household_settings` through
the hazard below for no reason.

**`schema.ts:63`'s `.default('board')` goes with them**, which retires §2.8's
fourth mechanism outright rather than leaving a retired key as the value every
new database starts from.

**And the diagnostics export changes shape.** `api/diagnostics.ts:169` reports
`household.theme`, which with the column gone has nothing to read. It becomes a
per-wall list of `{ name, theme }` — a theme key is a name the household chose
from a list of five, not content, so it belongs in the document that is safe to
hand to a stranger, and it is the only place an export would otherwise stop
being able to say what a wall looks like. Its test changes with it: `system.test.ts`
is where the "carries nothing that belongs to the household" assertion lives,
and a new field in that document is a field that assertion has to have been run
against.

### 4.0 What the premise does not excuse

The `0009` hazard is **not** removed by having no deployments, and this is the
one place to be careful about what the permission bought.

The hazard is that drizzle-kit generates an `INSERT … SELECT` naming columns
the old table does not have, SQLite resolves a double-quoted unknown name as a
**string literal** rather than erroring, and the migration reports success
while writing the wrong value into every row. What changed is the *cost* of
that happening — a testing database, recoverable by wiping it — not the
*likelihood*, and not the fact that it would be silent.

`screens` carries **46** columns — counted from
`apps/server/migrations/meta/0041_snapshot.json`, not from the 92 the first
draft asserted — including `token_hash`, the credential every paired wall and
panel authenticates with. The number is smaller and the argument is not: a bad
copy there is every screen in the house dropping off at once, which reads as a
pairing bug rather than as a migration bug and can burn an afternoon before
anybody suspects the migration. Forty-six columns is still forty-six chances
for a double-quoted name to resolve as a string literal.

So the review requirement is unchanged and is now cheap to meet: **generate the
migration, then read the `INSERT … SELECT` column list against the old table's
columns before running it**, exactly as `0009` was.

`migration-upgrade.test.ts` **already walks four screens**, which the first
draft said it walked none of: `scr-1`, paired before `orientation` and
`rotation` existed (0004) and hung sideways once they did; `scr-eink`, turned
into an 800×480 panel; `scr-todo`; and `scr-dav`, which RFC 013 §6.2.1 added
"precisely because a table recreate elsewhere would still be visible" — the
review step in this very section, already written down one migration earlier.

What none of the four has ever held is a **theme state**: every one is
inserted with `(id, name, token_hash, token_issued_at, created_at, updated_at)`
and never touches the column. So the work is not "add a screen", it is
**extend the existing walk with three theme states**: a wall with its own
theme, a wall following a household on `almanac`, and a wall following a
household still carrying `board`. The third is the one that can tell a
resolved backfill from a copied one, which is why a fixture using a live key
proves nothing (§6).

### 4.1 Every door, and this is where the last one hides

Three call sites create a browser wall:

| Door | Where | Today | After |
|---|---|---|---|
| The add form | `admin.ts:2423` | no theme | required field |
| Device-flow approve | `admin.ts:2221` | no theme | the approve form carries the picker |
| The `add-screen` CLI | `tools/add-screen.ts:85` | no theme | a required `--theme`, refused without one |

`createScreen` (`queries.ts:1077`) takes `(db, id, name, pairing)` and writes no
theme at all, so all three inherit the column default — which is §2.8's fourth
mechanism, and the retired key.

**That table is `default-wall-retired.test.ts`'s finding repeating.** That file
exists because the device-flow approve and the CLI both created a screen and
stopped, and the shared canvas made it invisible for as long as it existed; with
the canvas retired the same omission was a wall reading "Nothing on this wall
yet." for ever. The theme is that fault one column along, and it will read the
same way: a wall that silently draws Panels when the household chose Almanac
everywhere else. The cure is the same — every door answers, and a test walks
every door.

The cleanest enforcement is to make `createScreen` **take the theme as a fourth
argument and not default it**, which is `addCalendarSource`'s rule verbatim: a
default is precisely how the second mechanism comes back. Every caller then has
to answer, and the compiler is what asks.

## 5. Rejected alternatives

**Keep a household default and make Themes edit it** — the first draft's §3.3.
Rejected on review. The argument for it was that the default is a wall setting
like the clock and the content counts, so a "what every wall inherits" list
missing one entry is worse than a link. That is true of the *clock*, which is a
household preference a wall rarely overrides. It is not true of colour, because
§2.8 is: the default is what lets three other mechanisms set a theme without
anybody seeing it, and a household with two walls in two rooms has two answers
to this question and one row to hold them. A setting whose right value differs
per wall is not a household default that walls may override; it is a per-wall
setting with a misleading home.

**Defer the database constraint to a later migration.** This was the first
draft's position and it is **withdrawn**. It was the right call while the risk
was somebody else's kitchen calendar; with no installation outside the author's
testing environment, the recreate costs a wipe and re-pair, and the constraint
is what turns §4.1's rule from a convention the doors observe into one the
database enforces. `0009`'s lesson survives as a review step (§4.0), not as a
deferral.

**`NOT NULL` on `screens.theme`**, which is what the second draft asked for, is
rejected on a different ground and by the tree rather than by judgement: an
e-paper panel is a row in `screens` and has no theme, so the constraint §3.3
actually describes is `kind = 'epaper' OR theme IS NOT NULL`. See §4. It is the
same strength — a wall with no theme cannot be inserted — expressed as the rule
that is true.

**Ask before a template repaints a wall, and carry the backgrounds across.**
Rejected as out of scope and probably wrong: the template's backgrounds are
authored for its theme, so "keep my theme" would need every template's canvas
backgrounds re-derived against five palettes. §3.6's saved-strip wording is the
honest cheap answer — the household is told, on the branch where it happened.

**Fix only the copy** (§2.1, §2.2, §2.6 and one `themeUsage()` call). This needs
no endpoint change, no migration and no schema change, and it is most of the
sting of the original report. It remains a **viable first phase** — nothing in
it is undone by §3 — and if only one thing ships from this document it should be
§2.1.

## 6. Verification

§4's premise removes the assertion the first draft led with — "every existing
wall draws exactly what it drew" — because there are no existing walls to hold
it to. What replaces it is the constraint.

- **A wall with no theme cannot be inserted, and a panel with none still can.**
  The CHECK is the assertion and it takes **two** tests, not one: the insert of
  a `kind = 'browser'` row with a null theme throws, and the insert of a
  `kind = 'epaper'` row with a null theme does not. Only the pair says what the
  constraint means; either alone passes under a constraint that is simply
  absent, or under one that has been tightened into refusing every panel. Worth
  writing precisely because a schema constraint is the kind of thing a later
  migration quietly relaxes.
- **The migration's copy step preserves the resolved theme**, if the `COALESCE`
  form is taken — one case per state that exists today (own theme, following an
  Almanac household, following a household still carrying `board`) against
  `migration-upgrade.test.ts`. That file already walks **four** screens
  (`scr-1`, `scr-eink`, `scr-todo`, `scr-dav`); what none of them has ever held
  is a theme state, so the work is to extend the existing walk rather than to
  add a screen.
- **A wall cannot be created without a theme, through every door** — the §4.1
  table as a test that walks all three, in the shape `default-wall-retired.test.ts`
  already walks them. `createScreen` gaining a required parameter means the
  compiler catches a fourth door, which is the point of not defaulting it.
- **A hand-posted body with no theme is a 400**, not a wall wearing the column
  default. The form is a convenience; the POST is the boundary.
- **The built-in names on Themes derive from `THEMES`** rather than being typed,
  so §2.1 cannot recur. A literal-string test would have gone green on the wrong
  four names for as long as nobody edited it, which is exactly how they survived.
- **An unknown theme key still draws**, so §3.2's fallback cannot be tidied away.
- The wall page and the creation page assert to render the *same* control, by
  reading both pages for the `themecard` markup.

**And the tests that have to *change*, which the first draft did not count.**
This is the larger half of the work and it is the half that gets skipped,
because none of it is a new file.

- **`browser-harness` creates every wall in the suite by posting `{ name }` to
  `/admin/screens`**, through two helpers: `pairWall` (5 files, 6 call sites)
  and `pairLink` (23 files, 33 call sites) — 26 files and 39 call sites
  between them. Under a required `theme` every one of those posts is a 400.
  **The harness sends a theme in one place**, defaulted in the helper the way
  `pairWall(name = 'Kitchen')` already defaults the name, so the suite is one
  edit rather than thirty-nine. That is a harness default and not a product
  one: the POST is still the boundary and still refuses a body with no theme,
  which is what the hand-posted-400 assertion above is for.
- **`wall-editor.test.ts:321` and `:327`** assert the strings
  `"Household default — Paper Almanac"` and
  `"Household default — the same theme all day"` after posting the household's
  theme to `/admin/display`. Both sentences stop existing. **The rule is that
  every one of these is rewritten to name the theme the wall now draws, never
  deleted** — an assertion that "the household default no longer applies"
  passes just as happily on a wall drawing nothing at all, which is the first
  of the three things to watch below.
- **Ten test files construct a fixture carrying a `theme:`** — four of them
  (`layout`, `manifest`, `wall-sizing`, `widget-omission`) as the `household`
  input to `buildManifest`, where the field disappears with the column; the
  other six as form bodies to `/admin/display` or `/admin/screens/:id`, where
  it moves rather than going. Ten more files insert a `household_settings` row
  naming a theme.

**Three things to watch, because the pattern says they exist.** An assertion that
"the household default no longer applies" passes just as happily on a wall that
draws nothing at all — it has to name the theme it *does* draw. A usage tag read
off a card's class rather than its rendered text is the class-versus-pixels fault
this codebase has shipped twice. And the backfill's own test must seed a
household whose theme is `board`, because a fixture using a live key cannot tell
a resolved backfill from a copied one.

**Still unproven where it counts:** nobody has created a wall on a real phone or
in a real supervisor's sidebar, which by this project's history is where a form
fault surfaces. Every measurement in §2 is the source, not a screen.

## 7. Phasing

The audit's first finding is that this document is three changes wearing one
coat, and that the smallest of them is shippable today and undone by neither of
the others. §5 already says so — "fix only the copy … remains a viable first
phase" — and then §3 and §4 are written as one landing. Split, so each phase is
reviewable as itself:

**Phase 1 — the copy, the gallery, and no schema.** `/admin/themes` becomes the
gallery every theme is seen on: the five built-ins from `THEMES` and every
custom theme in one grid, each with its swatches, a one-line caption, and a tag
per wall wearing it from an extended `themeUsage`. The card is split so it can
be drawn with a radio (the picker) or without one (the gallery), and the whole
group — `THEMES`, `THEME_SWATCHES`, `LEGACY_THEME_ALIASES`, `displayThemeRef`,
`themeName`, `themeCards` — moves out of `admin.ts` into `http/theme-cards.ts`
so a screen about themes can import it without importing the admin. The
retired-name sites of §2.1 are fixed, except the neutral sentinel, which is a
display change. §2.6's four facts go on the builder. No schema, no migration,
no manifest shape, nothing in `apps/display`. A vocabulary test earns its keep
here: **Board, Kitchen Slate, Slate and Glance become words no served admin
page may contain**, run over the same crawl `admin-vocabulary.test.ts` already
walks, so §2.1 cannot recur the way it recurred four times.

**Phase 2 — retiring the household theme.** Four `household_settings` columns,
two migrations (the `screens` recreate that adds the CHECK, and the
`household_settings` drop), `createScreen` taking the theme as a parameter it
does not default, every door in §4.1, the harness's one edit and the
assertions that name a theme, `manifest.ts`'s terminal fallback, the two
stand-ins of §3.2, and the diagnostics export's new shape. This is where the
whole of §4 and §6 lives, and it is the phase that cannot be reviewed in
pieces because a column and its readers go together.

**Phase 3 — one control.** The creation step (§3.1), cards on the wall page
(§3.5), the template repaint's two saved keys (§3.6), and the documentation.
Duplicate (§3.4) lands here at the earliest, behind the parity test its
transcription needs.

> **Phase 3 shipped, and it found one thing this document did not anticipate.**
> §3.1 reasoned the creation step through as a question of *what is
> preselected* and got that exactly right — nothing is, the script marks a
> suggestion and can never check a card. What it did not ask is what happens to
> the answer afterwards. `applyTemplate` writes `template.theme` when the card
> names one, the creation handler seeds the chosen template immediately after
> creating the wall, and **twelve of the fourteen templates name a theme** — so
> choosing Sky Week and then Panels made an Almanac wall. The step phase 2 made
> mandatory was a control that did nothing on twelve fourteenths of the form,
> which is the `options.json` rule arriving through the one door this document
> spent a section defending. It is invisible from the markup: every assertion
> §6 asks for passes over it, because each is about what the form *offers*. A
> real browser driven end to end is what found it, which is this repository's
> own table repeating.
>
> The fix is one line in the creation handler — the household's theme written
> after the seed, never instead of it, because `applyTemplate` is the one place
> a canvas and its theme are kept consistent. Applying a template *later*, from
> the gallery, still repaints the wall and is meant to: that is the act §3.6
> makes audible rather than silent.
>
> Three smaller things are worth recording against what was written here. The
> suggestion needed the template's **name** as well as its theme, so
> `wallTemplatePreviews` carries one — §3.1 assumed the script had what it
> needed. The wall page's save bar is `display-editor.ts`'s rather than
> `settings-form.ts`'s, so "Save arms on a card change" runs through a different
> mechanism from the one a reader of §3.5 would look at; it arms on the settings
> form's own `change`, which a label-wrapped radio fires. And the daylight
> window's two sentences (§2.7) became one hint in System's own words, System's
> section having been retired in phase 2 — so the divergence that section
> describes is closed by there being one screen rather than by the two agreeing.
>
> Duplicate (§3.4) did not land and is still behind its parity test.

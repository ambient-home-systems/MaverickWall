# RFC 015 — One place for colour, and no default theme

Status: **proposed** · Owner: — · First drafted 2026-09-13 · Revised 2026-09-13 ·
Relates to `apps/server/src/http/admin-themes.ts`,
`apps/server/src/http/admin.ts` (`themeCards`, `wallDefaultsForm`, `newWallPage`,
the wall settings Appearance pane), `apps/server/src/api/templates.ts`,
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

## 1. Summary

A household reported two places to pick colours. Counted from the source it is
**three screens and four mechanisms**, and the screen named "Themes" is not one
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

### 2.8 A wall's theme is decided in four places, three of them invisible

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

Four mechanisms, of which the household can see one. "There is no reason for a
default theme" is the right conclusion, and it is stronger than it looks: the
default is not merely redundant, it is the thing that lets the other three stay
invisible, because every one of them is silently overriding a value nobody chose.

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
- The daylight pair stays **optional**, because "the same theme all day" is a
  real answer rather than a missing one. It is the one thing here that keeps a
  sensible absence.

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

A built-in offers **Duplicate** where a custom theme offers Edit — the missing
on-ramp, since "I like Almanac but greener" today means starting from Board's
palette and matching Almanac by eye.

With no household default there is nothing to *set* here, which is what makes
the screen coherent: it shows and edits themes, and walls choose them. Changing
which theme a wall wears is the wall's page, reached from the usage tag.

### 3.5 The wall page and the creation page share one control

The Appearance pane drops `selectRow` for `themeCards`, with no "follow the
household" card, because there is no household theme to follow. One decision,
one appearance, everywhere it is taken. §2.5 says the cards were written for
this screen; this is them arriving.

### 3.6 Applying a template stops repainting a wall silently

§2.8's third mechanism. `applyTemplate` keeps writing `template.theme` — it has
to, because a template's canvas backgrounds are designed for its theme and a
light background under a dark theme is unreadable, which is the comment's own
reason at `templates.ts:110`. What changes is that it stops being silent: the
`savedRedirect` token says which theme the wall is now wearing, rather than the
generic "Template applied."

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

**`screens.theme` becomes `NOT NULL` now, not later.** The first draft deferred
it and §5 records why it no longer defers. With the constraint in the schema, a
wall with no theme is not merely discouraged, it **cannot be inserted** — so
every door in §4.1 is enforced by the database rather than by a reviewer, and a
door somebody adds in five years fails loudly at the insert.

**That makes the "broken until a theme is selected" state unnecessary**, which
is worth stating because it is stronger than what was asked for. There is no
need for a wall to render an apology while it waits to be themed, and no need
for a renderer branch that draws one: an unthemed wall stops being a state the
product has.

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

**`household_settings.theme` and `daytime_theme` are dropped, not kept.** The
first draft kept them unread, on CLAUDE.md's `display_blocks` reasoning —
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

### 4.0 What the premise does not excuse

The `0009` hazard is **not** removed by having no deployments, and this is the
one place to be careful about what the permission bought.

The hazard is that drizzle-kit generates an `INSERT … SELECT` naming columns
the old table does not have, SQLite resolves a double-quoted unknown name as a
**string literal** rather than erroring, and the migration reports success
while writing the wrong value into every row. What changed is the *cost* of
that happening — a testing database, recoverable by wiping it — not the
*likelihood*, and not the fact that it would be silent.

`screens` carries 92 columns including `token_hash`, the credential every
paired wall and panel authenticates with. A bad copy there is every screen in
the house dropping off at once, which reads as a pairing bug rather than as a
migration bug and can burn an afternoon before anybody suspects the migration.

So the review requirement is unchanged and is now cheap to meet: **generate the
migration, then read the `INSERT … SELECT` column list against the old table's
columns before running it**, exactly as `0009` was. `migration-upgrade.test.ts`
already walks every migration in order against a database that has a calendar
in it; it should gain a *screen* for this one, which it does not have today.

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

**Defer `NOT NULL` to a later migration.** This was the first draft's position
and it is **withdrawn**. It was the right call while the risk was somebody
else's kitchen calendar; with no installation outside the author's testing
environment, the recreate costs a wipe and re-pair, and the constraint is what
turns §4.1's rule from a convention the doors observe into one the database
enforces. `0009`'s lesson survives as a review step (§4.0), not as a deferral.

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

- **A wall with no theme cannot be inserted.** The `NOT NULL` is the assertion;
  the test is that the insert throws, and it is worth writing precisely because
  a schema constraint is the kind of thing a later migration quietly relaxes.
- **The migration's copy step preserves the resolved theme**, if the `COALESCE`
  form is taken — one case per state that exists today (own theme, following an
  Almanac household, following a household still carrying `board`) against
  `migration-upgrade.test.ts`, which must gain a **screen** for this: it walks
  every migration against a database holding a calendar and holds no screen at
  all, so nothing in the suite today would see a `screens` recreate go wrong.
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

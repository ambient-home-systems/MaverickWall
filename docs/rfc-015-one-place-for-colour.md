# RFC 015 — One place for colour

Status: **proposed** · Owner: — · First drafted 2026-09-13 ·
Relates to `apps/server/src/http/admin-themes.ts`,
`apps/server/src/http/admin.ts` (`themeCards`, `wallDefaultsForm`, the wall
settings Appearance pane), `apps/server/src/api/themes.ts` · Builds on the
component layer and the confirmation strip (RFC 009 phases 3 and 10A/10B) and
on RFC 014's hub-and-screens shape · Constrains nothing · Amends no hard rule

## 1. Summary

A household reported two places to pick colours. Counted from the source, it is
**three**, and the one named "Themes" is not one of them.

| Screen | Sets the theme? | Control |
|---|---|---|
| `/admin/system` → "Wall appearance" (`admin.ts:3134`) | yes — household default, daytime theme, daylight window | `themeCards` — radio swatch cards |
| `/admin/themes` (`admin-themes.ts`, 385 lines, 8 routes) | **no** | — |
| `/admin/walls/:id` → Appearance pane (`admin.ts:4047`) | yes — per-wall override of all three | plain `<select>` ×2 |

So the sidebar entry named after colour is the one screen where colour cannot be
chosen, and the two screens that do choose it render **one stored value through
two different controls**. That is `shifts[0]` / `display_mode` / `cellEvents`
one layer up: the same fault this project has now found four times in renderers,
occurring in the *controls* instead. The cure is the same one it was every other
time — resolve it once, and have both readers ask the same thing.

This RFC proposes: **Themes becomes the gallery where every theme is seen,
understood and chosen; System keeps a stated summary and a link; the wall page
drops its selects for the same cards.** No token changes, no schema change, no
manifest field moves, and the display is not touched.

**The feature set does not shrink.** Everything a household can set today they
can still set, from a screen whose name matches what it does.

**One fault in here is a shipped defect with no design decision attached and
should not wait on any of this** — §2.1. The Themes page names three themes that
do not exist.

## 2. What is wrong, counted

### 2.1 The Themes page names three themes that no longer exist

`admin-themes.ts:256`, inside `emptyState(…)`:

> "The four built-in directions (Board, Kitchen Slate, Paper Almanac, Glance)
> can be chosen in each wall's settings."

`board`, `slate` and `glance` are all members of `LEGACY_THEME_ALIASES`
(`admin.ts:573`), every one of them mapping onto `panels`. The live set is
`THEMES` (`admin.ts:545`) and it is **five**: Panels, Household, Blueprint,
Paper Almanac, Swiss. So the sentence names four, three of which were retired,
and omits three that ship.

This is the rot this repository's own header warning describes, and it has
**propagated in both directions**: CLAUDE.md's closing "The design file" section
names the identical retired four. The prose outlived the code and then became
the source somebody else copied from. Read `THEMES` and `LEGACY_THEME_ALIASES`,
which are what the picker actually renders.

It also contains a second, smaller lie: "can be chosen in each wall's settings"
is true and incomplete — they are chosen in each wall's settings *and* on
System, which is the subject of this whole document.

### 2.2 The built-ins vanish the moment a household makes one theme

They are named nowhere on the page but inside that empty state, which is drawn
only when `custom.length === 0`. Create one theme and the five built-ins are no
longer listed anywhere in the product except two dropdowns and one card grid on
other screens. A household who wants to go back to a built-in, or to see what
they are choosing between, has no list to look at.

### 2.3 `themeUsage()` exists, answers the one question a list needs, and the list does not ask it

`api/themes.ts:338` returns `{ household: boolean; screens: string[] }` for a
theme id. It has exactly one caller: the delete confirmation. So the data that
turns an inventory into a navigable list — *which wall is wearing this* — is
already computed, already tested, and read only at the moment a household is
destroying something.

### 2.4 There is no route from building a theme to applying it

`POST /admin/themes` and `POST /admin/themes/:id` both `savedRedirect` to
`/admin/themes` (lines 97, 131). The generator lands in the builder (line 120),
which is right. But the end of every path is a list with no chooser on it, and
the only instruction is the page intro's prose — "selectable on the Walls page"
— which is not a link. A household who has just spent ten minutes on a palette
has to work out unaided that the next step is a different section of the
sidebar.

### 2.5 The swatch cards were built for a screen that does not use them

`THEME_SWATCHES`' own docstring (`admin.ts:554`) says the colours are "for the
wall settings theme cards". `themeCards` is called **once** in the entire
server, at `admin.ts:3169`, which is System. The wall settings page renders
`selectRow` twice instead. The richer control was written for the screen that
does not have it.

### 2.6 Documentation is thin in a particular way

`TOKEN_HELP` (`admin-themes.ts:51`) is eleven entries, each one line, each
saying *what a token paints*: "Panels — the surface of cards and the month
grid." Accurate and insufficient. What no screen says:

- **Why the shift hues matter.** They have to separate at ten feet, which is the
  whole reason there are four of them and the reason Panels is recommended. That
  argument exists in the design file and in CLAUDE.md and nowhere a household
  reads.
- **That `--faint` is deliberately below the contrast bar.** The display's grey
  for out-of-month days is intentionally under 4.5:1. A contrast panel flagging
  it reads as a defect the household is being asked to fix.
- **That four more tokens are derived from theirs and silently corrected.**
  `withTints` (`api/themes.ts:229`) derives `--ink-event`, `--ink-scaffold`,
  `--ink-quiet` and `--rule-week`, and `scaffoldInk` raises its mix ratio until
  it clears 4.5:1 against that theme's own background. A household who picks a
  low-contrast pair gets a result that is not what they chose, with nothing
  anywhere explaining the correction.
- **What a theme does *not* control.** Type size on a wall comes from panel size
  and read distance, on the wall's Device pane. Layout comes from the editor. A
  household chasing "the text is too small" will go to Themes — and `--radius`
  sitting there, the one non-colour control on the screen, actively encourages
  the belief that they are in the right place.

### 2.7 The daylight window is written twice and behaves differently in each

System (`admin.ts:3173`): "A lighter theme during the hours below. A dark theme
at noon is a hole in the wall; a light one at 2am is a lamp." The wall page
(`admin.ts:4059`, `:4093`) splits the same two sentences across a hint and a
trailing paragraph. And the From/Until fields are **always drawn** on System and
**script-revealed** on the wall page (`data-reveal-if="daytime_theme"`).

The divergence is deliberate and documented — `wallDefaultsForm`'s docstring
says System loads no editor script, so a `hidden` group there would be a control
nobody could reach, which is the chores form's rule. The reasoning is right. The
household still sees only two screens disagreeing about one setting, and neither
says why.

## 3. Proposal

### 3.1 Themes becomes the gallery

`/admin/themes` lists **every** theme the wall can draw — the five built-ins and
every custom one — as one grid of `themeCards`, each card carrying:

- the three-colour swatch it already has,
- its name and one line of what it is for,
- and a `tag` from `themeUsage()`: "Household default", "Kitchen, Hall", or
  nothing at all.

A built-in's row offers **Duplicate** where a custom theme offers Edit, which is
also the missing on-ramp: "I like Almanac but want it greener" currently means
starting from Board's palette in the builder and matching Almanac by eye.

Choosing happens on this grid. It is the household default that is being set
here, which is the same value System sets today.

### 3.2 The wall page and Themes share one control

The wall settings Appearance pane drops `selectRow` for `themeCards`, with one
extra card at the head — "Follow the household default — Panels" — standing for
the empty string the selects carry today. One decision, one look, everywhere it
is taken. §2.5 says the cards were built for this screen; this is them arriving.

### 3.3 System keeps a summary, not a second editor

"Wall appearance" shrinks to a stated line — *Panels, with Paper Almanac from
07:00 until 21:00* — and a link. It stays **on System**, because the household
default theme is a wall default exactly like the clock and the content counts,
and moving it would make System's "what every wall inherits" section a partial
list. What it stops being is a place to edit.

### 3.4 The builder ends somewhere

On save, the builder offers "Apply to…" — household default, or a named wall —
rather than redirecting to a list. Declining is one click and lands on the
gallery, which is today's behaviour.

### 3.5 The documentation gaps close where the household is standing

Not a docs page — this product has no published docs site (CLAUDE.md's "not
started" list, which is now that list's only entry). The four facts in §2.6 go
**on the builder**, beside the controls they are about: the shift hues get the
ten-feet sentence, `--faint` says it is meant to be quiet, the contrast panel
says which roles are derived and that they are corrected upward, and the page
carries one line naming what a theme does not control, with a link to the wall's
Device pane.

## 4. The trap, and it is the reason to price this before starting

**System's appearance fields ride `POST /admin/display`, and that form is one
form for a load-bearing reason.** `wallDefaultsForm`'s own docstring
(`admin.ts:3122`) states it: the handler writes every field it is given and an
unticked checkbox is not sent at all, so a form carrying only the clock would
save a 12-hour clock *and* silently take the daylight schedule off every wall.
Sections are markup; the form spans them.

§3.3 splits that form. So the theme fields need an endpoint of their own, and
the hazard is the opposite of the one the docstring describes:

`theme` is `text('a theme', 64)` in `wallDefaultsSchema` (`admin.ts:505`) —
**required**. A page cached from before the split posts a body with no `theme`
in it and gets a 400 on a save that should have succeeded, on the screen where
the household was only changing the clock.

So the ordering is: make `theme` and `daytime_theme` absent-means-unchanged on
`POST /admin/display` **first**, keep that handler accepting them for ever, and
only then move the controls. That is the Weather screen's `weather_form` marker
pointing the other way — there a missing field had to mean *off*, here it has to
mean *unchanged*, and the difference is that a checkbox has two states and a
theme has none it can fall back to.

Two smaller ones:

- **`savedRedirect` tokens are claims about a branch.** Four exist
  (`saved.ts:126`); a new `theme-applied` needs to be on the branch that
  actually applied one. RFC 009's rule.
- **`admin-vocabulary.test.ts` reads rendered copy for retired nouns.** Every
  new sentence here is copy about walls and layouts, which is precisely the
  vocabulary that test polices — RFC 009 phase 4 caught two strings in one run
  that way.

## 5. Rejected alternatives

**Move the household default onto Themes and leave System with nothing.**
Rejected: System's section is *"what every wall inherits"*, and a list of
inherited defaults missing one of them is worse than a link. §3.3.

**Leave the split alone and only fix the copy.** This is the honest smaller
change and it is genuinely most of the reported complaint's sting — §2.1, §2.2
and §2.6 are all copy and one `themeUsage()` call, need no endpoint change, and
touch no schema. It remains the right change if §3 is judged too large, and
unlike RFC 014's rejected option it **is** a viable first phase: nothing in it
is undone by the restructure. If only one thing ships from this document, it
should be this.

**A published docs page for theming.** Rejected for now on the same reasoning
`options.json` produced: a household standing on the builder will not go and
find a document. The facts belong beside the controls.

## 6. Verification

Nothing here changes a pixel on a wall, so the acceptance is the admin's own:

- `admin-themes.test.ts` gains the usage tags and the built-ins being listed at
  all — the case that matters is **one custom theme present**, since that is the
  state where §2.2 bites and an empty-database test cannot see it.
- A guard that the built-in names rendered on Themes are derived from `THEMES`
  rather than typed, so §2.1 cannot recur. A literal-string test would have gone
  green on the wrong four names for as long as nobody edited it, which is how
  they survived.
- A test that `POST /admin/display` still accepts a body with no `theme` in it
  and changes no theme — §4, and it must be written **before** the controls
  move, and watched go red against today's required field.
- The wall page and System asserted to render the *same* control, by reading
  both pages for the `themecard` markup rather than by comparing screenshots.

**Two things to watch for, because this document cannot predict them and the
pattern says they exist.** An assertion that "the household default changed"
passes just as happily when every card writes the same value; and a usage tag
read off the card's class rather than its computed text is the class-versus-
pixels fault this codebase has already shipped twice. Assert the rendered words.

**Still unproven where it counts:** nobody has picked a theme on a real phone or
in a real supervisor's sidebar, which by this project's history is where a form
fault actually surfaces. Every measurement in §2 is the source, not a screen.

# Material 3 adoption — AI session prompts

Eight prompts, one per coding-agent session (Claude Code or similar), each sized
to land as one reviewable PR. Run them in order — each assumes the previous ones
are merged — except Prompt 5 (icons, any time after Prompt 1) and Prompt 7 (the
wall theme generator, fully independent). Paste a prompt verbatim as the
session's first message; every prompt is self-contained and assumes the session
can read the repository, including `CLAUDE.md`.

## Decisions these prompts encode

Settled during the evaluation that produced this file. Edit the prompts if you
decide differently.

- **Scope: the server-rendered admin and the first-run wizard only.** The wall
  keeps its four design directions; `apps/display/**` is untouched by every
  prompt except none at all — even Prompt 7 lives entirely in `apps/server`.
- **M3 as a specification, implemented by hand** in the existing vanilla CSS.
  No `@material/web`, no MDC, no CSS framework, nothing fetched at runtime
  (hard rule 3). The only new dependency anywhere is Google's small,
  pure-TypeScript colour library, and in Prompts 1–6 it is build-time only.
- **Faithful M3 look for the admin.** The admin will stop matching the wall's
  blueprint/board identity: registration-mark corners, blueprint cards and the
  uppercase condensed kickers are retired; the brand lockup (mark + Oswald
  wordmark) stays — a logo is not a component. If you would rather keep the
  house look and adopt only M3's rigor (tokens, contrast guarantees, state
  layers, touch targets), say so at the top of Prompts 2–4 and skip the shape,
  type and card-anatomy changes.
- **Baseline M3 spec** (m3.material.io as of 2026), not the Expressive
  variants, wherever the two differ.
- One branch per prompt (`feature/m3-<topic>`), release-notes line under
  `## Unreleased` in `addon/maverick-wall/CHANGELOG.md` per repo convention.

---

## Prompt 1 — Token foundation (colour roles, type scale, shape, elevation, state layers)

```
We are adopting Material Design 3 (m3.material.io) in the server-rendered admin
UI of this repository, as a specification implemented by hand — no component
library, and nothing fetched at runtime (hard rule 3 in CLAUDE.md). Read
CLAUDE.md first, then apps/server/src/http/html.ts: the admin's entire
stylesheet is the STYLE constant there, and it already has a token system with
dark as default, light under :root[data-theme="light"], and an auto mode under
prefers-color-scheme. Nothing in this task touches apps/display/** — rule 2's
ES2019/no-color-mix constraint is the display's, and the STYLE block already
uses color-mix() deliberately (its own comment says why that is fine).

Task: replace the admin's colour, type, shape and elevation foundations with M3
system tokens, without editing page markup — this phase must land as a pure
re-skin.

1. Scheme generation, build-time only. Add @material/material-color-utilities
   (Apache-2.0, pure TS) as a devDependency of apps/server. Write a small
   generator script, following the precedent of the build scripts in
   docs/brand/ (run by hand, output committed): derive complete M3 dark and
   light schemes from seed #E8A33D (the Board amber), and harmonize three
   custom roles with Blend.harmonize against that seed — success from the
   current --ok green, warning from --warn, night/info from --night. Commit the
   generated output as a TS module (e.g. apps/server/src/http/m3-tokens.ts)
   that html.ts imports into STYLE. The runtime image must gain no dependency
   and no build step.

2. Wire the schemes into the existing switching mechanism unchanged: dark on
   bare :root, light under :root[data-theme="light"], and the same light block
   under the prefers-color-scheme auto rule. Emit the roles as
   --md-sys-color-* custom properties.

3. Keep every existing token name working by redefining it as an alias of an M3
   role, so the ~6,000 lines of server-rendered pages restyle without markup
   edits: --bg → surface; --panel → surface-container; --panel2 → a higher
   container step chosen so inputs and insets keep reading as distinct from
   cards; --rule → outline-variant; --ruleSoft → a subtler divider derived
   from it; --ink → on-surface; --muted → on-surface-variant; --faint →
   outline; --accent → primary; --accentInk → on-primary; --danger → error
   (with on-error where a fill needs text); --ok, --warn, --night → the
   harmonized custom roles.

4. Type scale. Add the fifteen M3 roles as tokens (display/headline/title/
   body/label × large/medium/small: family, size, line-height, weight,
   tracking). Bundle Roboto 400/500/700 (latin subset, woff2) into
   apps/server/assets/fonts beside the existing faces, add it to LICENSES.md
   there (Apache 2.0), and @font-face it in STYLE with a system-ui fallback
   stack — served same-origin, never fetched from a third party. Map the
   existing heading/body/label styles onto the scale. Leave --wordmark (Oswald)
   and the brand lockup untouched.

5. Shape and elevation. Add --md-sys-shape-corner-{none,extra-small,small,
   medium,large,extra-large,full} (0/4/8/12/16/28px/999px) and the M3
   elevation levels 0–5 as box-shadow tokens (with the dark-scheme
   surface-tint approach noted in a comment for the component phase to use).

6. State layers. Add hover 8% / focus 12% / pressed 12% opacity tokens and a
   color-mix() recipe comment showing how components will apply them next
   phase. Do not restyle components yet.

Verify the way this project verifies (CLAUDE.md: verification is the job):
- A unit test that imports the committed scheme module and asserts contrast for
  every paired role it emits: on-X over X ≥ 4.5:1, and outline against surface
  ≥ 3:1 — the M3 tonal system should guarantee this; the test proves the
  generator and any future hand edit keep it true.
- pnpm test (it builds first; never skip the build).
- Start the server, render /admin and /setup in both schemes, screenshot
  headlessly, and look at the screenshots — dark, light, and auto.
- Assert the served admin HTML still references no third-party origin: no
  <link>, <script>, <img> or CSS url() resolving off-origin. Add this as a
  route test if none exists.
- Add a line under ## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 2 — Core controls (buttons, fields, segmented, chips, tabs)

```
This repository's server-rendered admin adopted Material 3 system tokens in a
previous change: apps/server/src/http/html.ts imports a committed M3 scheme
(m3-tokens.ts) and its STYLE constant now carries --md-sys-color-*, type-scale,
shape, elevation and state-layer tokens, with the old token names aliased onto
M3 roles. Read CLAUDE.md, html.ts and that token module first. This task is the
first component pass: restyle the core controls to M3 anatomy. Rule 3 still
holds (nothing fetched at runtime), apps/display/** is untouched, and — 
important — several admin class names are constructed by scripts that ship in
the display bundle (the layout editor and the Home Assistant entity picker
build .le-* and .hep-* markup at runtime), so restyle by changing CSS
declarations and keep every existing class name working.

Restyle, per the M3 component specs:

1. Buttons. Map the existing variants onto M3 common buttons: default
   button/.btn → filled; button.secondary/.btn-ghost → outlined (or tonal
   where a page uses it as a strong secondary action — judge per page);
   .btn-danger → outlined with error colour roles; .btn-sm and the toolbar
   buttons (.le-tool-btn, .le-cfg-btn, .signout) → text/outlined at the small
   metrics. Adopt 40px container height, full (pill) corner shape, label-large
   type, 24px gap-and-padding geometry, and state layers (hover 8%, focus 12%,
   pressed 12% via color-mix over the container colour) instead of the current
   filter:brightness hovers. Every interactive control gets a minimum 48x48px
   pointer target — where the visual control is smaller (icon buttons like
   .signout, .fieldhelp, .hep-pill-x), extend the target with padding or a
   pseudo-element, not the visual.

2. Text fields and selects. Adopt the M3 outlined text field: 56px height,
   extra-small corner, outline colour → outline role, focus ring → primary at
   the M3 focus width. Keep the label ABOVE the field as a documented
   adaptation (these pages are deliberately script-free and server-rendered
   with pre-filled values, so the floating-label pattern is out; say so in a
   comment where the field styles live). Restyle textarea, input[type=color],
   input[type=file] consistently. Placeholder → on-surface-variant.

3. Checkboxes. Keep the native accent-color approach (a faithful M3 checkbox
   needs scripting or heavy pseudo-element work on pages that must stay
   simple); size to 18px with a 48px target, note the adaptation in a comment.

4. Segmented buttons. .seg, .le-orient and .themebar become M3 segmented
   buttons: one outlined container, full corner on the ends, selected segment
   filled with secondary-container/on-secondary-container, unselected
   on-surface, with state layers.

5. Chips. .hep-chip and .walls links → M3 filter chips (32px height, small
   corner, outline when unselected, secondary-container when selected);
   .hep-pill → input chip with its trailing remove affordance sized to target.

6. Tabs. .tabbar/.tab → M3 primary tabs: title-small/label-large type, active
   indicator 3px primary rounded, state layers on hover, on-surface-variant
   inactive.

Verify: pnpm test; then start the server and screenshot every admin page that
uses these controls in both schemes (Overview, Calendars, Screens, Display,
Layout, Shifts, Alerts, Home Assistant, Modules, Themes, Settings — enumerate
the routes from http/app.ts rather than trusting this list); measure in the
headless pass that button containers are 40px, fields 56px, and every
interactive target ≥ 48px or explicitly documented as an exception; keyboard-
tab through a form page and confirm the focus indicator is visible on every
control. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 3 — Surfaces and navigation (cards, sidebar, top bar, dialogs, popovers, status)

```
This repository's server-rendered admin has adopted Material 3 tokens and M3
core controls in previous changes (see apps/server/src/http/html.ts: the STYLE
constant, the m3-tokens module, and the M3 buttons/fields/chips/tabs already in
it). Read CLAUDE.md and html.ts first. This task is the second component pass:
surfaces and navigation. Same standing constraints: nothing fetched at runtime
(rule 3), apps/display/** untouched, and class names built by display-bundle
scripts (.le-*, .hep-*) keep their names — restyle declarations only.

1. Navigation drawer. The sidebar (.side/.nav/.nav-item) adopts M3 navigation
   drawer anatomy: active item becomes a full-pill indicator (56px height,
   secondary-container fill, on-secondary-container content) instead of the
   current accent fill; items label-large with 24px icons; group headers
   (.nav-group>span) → title-small on-surface-variant, dropping the uppercase
   letterspaced kicker treatment. Keep the 216px width if it holds the pill
   comfortably, else widen toward the spec inside the existing 820px collapse
   breakpoint. The brand lockup at the top (mark + Oswald wordmark) stays
   exactly as it is.

2. Top app bar. .topbar becomes an M3 small top app bar: 64px, title-large,
   surface colour with the on-scroll surface-container tint (the sticky
   backdrop-blur can stay — note it as an adaptation).

3. Cards. .card → M3 filled card (surface-container-highest at rest? choose
   filled vs outlined per use: stat/link cards that navigate → elevated or
   filled with hover elevation + state layer; static section cards → outlined).
   medium (12px) corner. Retire the corner registration marks (.cm) and the
   blueprint-style transparent .tpl-card in favour of standard M3 cards — this
   is the deliberate identity trade recorded in docs/m3-adoption-prompts.md;
   delete the dead rules rather than leaving them.

4. Dialogs and menus. .le-modal → M3 basic dialog: extra-large (28px) corner,
   surface-container-high, headline-small title, actions right-aligned as text
   buttons, scrim at 32%. .helppop and .le-layers-pop → M3 menu/rich-tooltip
   surfaces: extra-small corner, surface-container, elevation level 2.

5. Bars and status. .savebar → M3 bottom-bar treatment on surface-container
   with a tonal top divider; .error → the M3 error container pattern
   (error-container/on-error-container) replacing the left-border box; .tag →
   label-small on secondary-container (keep the ok/bad/accent variants on the
   harmonized roles); .dot and .pulse keep their behaviour with role colours.
   .qr keeps its white plate — a QR needs its quiet zone, note it.

Verify: pnpm test; screenshot every admin page plus the layout editor and the
Home Assistant screens in both schemes and actually look at them; drive the
layout editor far enough to open the add-widget dialog and the Layers popover
so the restyled surfaces are seen live, not assumed; confirm the sidebar's
active state is legible in both schemes; re-run the served-HTML third-party-
origin assertion. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 4 — Wizard and sign-in

```
This repository's server-rendered admin has adopted Material 3 (tokens,
controls, surfaces — see apps/server/src/http/html.ts and previous changes).
The first-run wizard (/setup, apps/server/src/http/setup.ts) and the sign-in
page share that stylesheet through the body.wiz shell and largely inherit the
new look already. Read CLAUDE.md, html.ts and setup.ts first. This task
finishes the wizard-specific pieces.

The one constraint that outranks the spec here: the wizard and sign-in are
deliberately plain server-rendered HTML with no script and no build step,
because they are the screens that must work before anything else does. Add no
JavaScript to them, required or optional. Where an M3 component is inherently
scripted, use the static adaptation and write a comment saying so.

1. The step indicator (.steps) becomes an M3-flavoured progress treatment:
   linear-progress-style bars in primary for done/current with
   surface-container-highest track, label-small captions in on-surface-variant
   (current step primary). No animation is needed for a page that re-renders
   per step.

2. The wizard card, fields and buttons should already inherit Prompts 1–3;
   sweep each step for stragglers: the bootstrap-code entry (.code), the
   timezone select, the skippable calendar step, and every .error state.

3. The sign-in page gets the same sweep.

4. Contrast check the bootstrap-code and error texts specifically — these are
   read from a terminal log and a kitchen respectively.

Verify by driving the real thing, not by reading: the wizard has route tests
and an ingress proxy harness in apps/server/test (setup, ingress and
screen-pairing tests) — run them all via pnpm test; then run the server
fresh (empty DATA_DIR), walk the wizard end to end in a headless browser
through all three steps including the error paths (wrong code, failed feed
test), screenshot each step in both schemes, and confirm document scripts on
/setup and /admin/sign-in are absent (assert it in a test: the rendered wizard
HTML contains no <script> beyond what it contains today — if the theme script
is present in the wiz shell today, pin today's exact behaviour rather than
guessing). Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 5 — Iconography (Material Symbols)

```
This repository's server-rendered admin uses a small set of first-party inline
SVG icons: ICON_PATHS in apps/server/src/http/html.ts, hand-copied line-icon
paths drawn stroke-based at stroke-width 1.6, rendered through an icon()
wrapper. Rule 3 (CLAUDE.md) forbids fetching anything third-party at runtime,
so icons are inlined — that mechanism stays. Read CLAUDE.md and html.ts first.

Task: replace the icon set with Material Symbols while keeping everything
inline and first-party.

1. Source each icon in ICON_PATHS from Material Symbols Outlined (24dp grid,
   default weight) in the google/material-design-icons repository — copy the
   path data into ICON_PATHS, do not add a dependency, an icon font, or a
   fetch. Choose the closest Symbols glyph per key (overview, calendars,
   shifts, alerts, homeassistant, screens, layout, display, and the rest of
   the map — enumerate ICON_PATHS rather than trusting this list).

2. Material Symbols are FILLED OUTLINE PATHS, not strokes. Audit and update
   every svg rule in STYLE that assumes stroke rendering (stroke-width
   settings on .nav-item svg, button svg, .ic svg, .link svg, .fieldhelp svg
   and any others) to fill-based rendering with currentColor, keeping each
   slot's current size.

3. Record the licence: Material Symbols is Apache 2.0 — add it to the
   attribution the repo already keeps (apps/server/assets/fonts/LICENSES.md
   has the pattern; put icon attribution where a reader will find it, and
   check whether the root NOTICE needs a line, since this is an AGPL project
   that takes attribution seriously).

4. Do not touch the brand MARK, the favicon, or the wordmark — identity, not
   iconography.

Verify: pnpm test; render every page that shows icons (sidebar on every page,
Overview stat cards, buttons with leading icons, the layout-editor toolbar)
in both schemes and look at each slot — a stroke rule left behind renders a
Symbols glyph as a hairline ghost, which is exactly the kind of fault this
project's history says only looking will catch. Re-run the third-party-origin
assertion. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 6 — Motion and interaction polish

```
This repository's server-rendered admin has adopted Material 3 tokens and
components (apps/server/src/http/html.ts, STYLE constant and m3-tokens
module). Read CLAUDE.md and html.ts first. This task adds M3 motion — the
smallest phase, and deliberately last of the admin passes.

1. Add md.sys.motion tokens to STYLE: easing standard
   cubic-bezier(0.2, 0, 0, 1), emphasized-decelerate
   cubic-bezier(0.05, 0.7, 0.1, 1), emphasized-accelerate
   cubic-bezier(0.3, 0, 0.8, 0.15); duration short (50–200ms), medium
   (250–400ms), long (450–600ms) as a few named steps.

2. Apply them to what already moves or should: state-layer hover/press
   transitions on buttons, chips, nav items and cards; the tab indicator; the
   popovers and dialog (enter emphasized-decelerate, exit accelerate — pure
   CSS transitions only, these pages gain no script); the admin theme toggle's
   colour change.

3. Wrap every transition and animation in the stylesheet — including the
   existing .pulse keyframes — behind @media (prefers-reduced-motion:
   no-preference), or provide a reduce override that stills them. A wall
   product's admin gets used on whatever device is nearest; respect the
   setting.

Verify: pnpm test; screenshot pass on the main pages in both schemes; in the
headless browser, emulate prefers-reduced-motion: reduce and confirm computed
transition durations are zero/none on the controls above. Add a release-notes
line under ## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 7 — Wall theme generator from a seed colour (optional, independent)

```
This repository has a custom display-theme system: households compose wall
themes from eleven colour tokens plus an allowlisted font stack, stored and
resolved in apps/server/src/api/themes.ts (COLOUR_TOKENS, withTints, the
custom: prefix), edited on /admin/themes, and delivered to the wall as fully
resolved tokens in the manifest — the display bundle never learns new theme
names. Read CLAUDE.md, apps/server/src/api/themes.ts, the themes admin page in
apps/server/src/http (admin-themes.ts), and apps/display/src/theme.ts (for the
tint maths and token vocabulary — read only; apps/display/** must have ZERO
changes in this task).

Task: add "Generate from a colour" to the custom-theme builder, using Material
Design 3's colour engine, so one seed colour yields a complete
contrast-guaranteed wall theme through the existing custom-theme pipeline.

1. Add @material/material-color-utilities (Apache 2.0, small, pure TS) as a
   runtime dependency of apps/server only — rule 1 fences packages/core and
   packages/calendar, not apps, and CLAUDE.md's image-size concern means you
   should note the size cost in the PR description (the library is tens of
   kilobytes). Nothing new reaches the display bundle.

2. Server-side generator: from a seed colour and a light/dark choice, derive
   M3 tonal palettes and map them onto COLOUR_TOKENS: surface → --bg,
   surface-container → --panel, outline-variant → --rule, on-surface → --ink,
   on-surface-variant → --muted, outline → --faint, primary → --accent. For
   the four shift hues, Blend.harmonize the display's defaults (--s-day
   #E8A33D, --s-night, --s-break, --s-straight from apps/display/src/theme.ts)
   toward the seed, then adjust tone until each is ≥ 3:1 against the generated
   --bg — a shift colour that vanishes into the background is a rota nobody
   can read from across a kitchen.

3. UI: a small section on the themes screen — colour input, light/dark choice,
   a name field — that posts to a route which runs the generator and then the
   EXISTING create path (schema-validated per rule 5; validation.ts already
   has a colour() validator), so the result is an ordinary custom theme:
   previewable in the existing builder, editable afterwards, resolved with
   withTints, carried in the manifest like any other. Copy written for someone
   standing in a kitchen, per the house rule: say what a seed colour is in one
   sentence.

4. Tests, in the project's touch-something-real style: a unit test asserting
   every generated pairing meets its contrast bar (ink/bg ≥ 4.5:1, muted/bg ≥
   4.5:1, faint/bg ≥ 3:1, accent/bg ≥ 3:1, each shift hue/bg ≥ 3:1) across a
   spread of seed colours including ugly ones (#000000, #FFFFFF, a neon); a
   route test that generates a theme, selects it, and reads /d/manifest to
   assert the wall receives resolved tokens; and a check that the apps/display
   diff is empty.

Verify: pnpm test (builds first); run the server, generate a theme from the
admin UI, select it for a screen, open the display in a headless browser and
screenshot the wall drawing it in portrait and landscape. Add a release-notes
line under ## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 8 — Close-out audit

```
This repository's server-rendered admin and first-run wizard have been restyled
to Material Design 3 across several merged changes (tokens, controls, surfaces,
wizard, icons, motion — see apps/server/src/http/html.ts and
docs/m3-adoption-prompts.md for what was intended). Read CLAUDE.md first; its
"verification is the job" table is the standard this task applies. This is an
audit-and-fix pass: find what the phase work missed, fix small faults directly,
and file anything larger as a clear list in the PR description.

Sweep, measuring rather than trusting:

1. Render EVERY admin route (enumerate them from apps/server/src/http/app.ts
   and the admin-* files, do not work from memory) plus every wizard step and
   the sign-in page, in dark and light, at 390px, 820px (the collapse
   breakpoint) and 1280px. Screenshot all of it and look at all of it. Assert
   in the headless pass that no page scrolls horizontally at any of the three
   widths.

2. Interaction audit: every interactive control ≥ 48px target or a written
   exception; keyboard focus visible on every control; the layout editor and
   Home Assistant entity picker driven live (their markup is script-built from
   the display bundle and is where a missed class rename would hide).

3. Token hygiene: grep the STYLE constant and every admin-* page for raw hex
   colours outside the token/scheme definitions — everything should pass
   through an M3 role or an alias of one. Grep for leftover stroke-width rules
   from the old icon set. Delete dead rules the component passes orphaned.

4. Contrast suite green (the scheme-pair unit test from the token phase), and
   spot-check the two texts that matter most by hand: error boxes and the
   wizard's bootstrap-code screen.

5. Rule three, proven not assumed: a test asserting the served admin and
   wizard HTML reference no third-party origin (links, scripts, images, CSS
   urls); run it and read it to confirm it actually parses served output.

6. Ingress: run the ingress proxy tests, and render at least one sidebar-
   mounted page through the ingress harness to confirm the restyle holds under
   the <base>-prefixed path (relative font/asset URLs are where this breaks).

7. Docs: update CLAUDE.md's current-state section with a short paragraph on
   the M3 admin (what was adopted, what was deliberately adapted: static
   labels over floating, native checkboxes, script-free wizard), and add the
   closing release-notes line under ## Unreleased in
   addon/maverick-wall/CHANGELOG.md.

The one thing this audit cannot do from inside a test harness — and should say
so rather than claim — is the real-hardware check this project ends every
feature with: the sidebar opened through a real Home Assistant supervisor, on
both HA themes. List it in the PR description as the remaining verification,
the way CLAUDE.md records such things.
```

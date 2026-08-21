# Material 3 adoption — AI session prompts

Eight prompts, one per coding-agent session (Claude Code or similar), each sized
to land as one reviewable PR. Paste a prompt verbatim as the session's first
message; every prompt is self-contained and assumes the session can read the
repository, including `CLAUDE.md`.

## Status

- **Prompt 1 is DONE** — commit `23e31aa` ("Re-skin the admin on Material
  Design 3 foundations") on branch `claude/material-design-3-admin-o7mjew`,
  one commit on top of v0.31.1 main. Merge it before running Prompt 2, or
  start Prompt 2's branch from it. What it landed (later prompts build on
  these exact artifacts):
  - `apps/server/src/http/m3-tokens.ts` — committed dark + light schemes from
    seed `#E8A33D` (TonalSpot, 2021 spec), emitted as `--md-sys-color-*`, with
    harmonized Board status colours as `--md-custom-color-{success,warning,
    night}` plus their `on-`/`-container` partners.
  - `apps/server/scripts/generate-m3-tokens.mjs` regenerates that module;
    `@material/material-color-utilities` is a devDependency of `apps/server`.
  - Roboto (variable, 100–900, latin) bundled as `assets/fonts/roboto.woff2`;
    `--md-ref-typeface-brand` / `--md-ref-typeface-plain` both resolve to it.
  - The full fifteen-role type scale as
    `--md-sys-typescale-<role>-{font,size,line-height,weight,tracking}`; the
    shape scale `--md-sys-shape-corner-*` (0/4/8/12/16/28px/999px); elevation
    `--md-sys-elevation-level0..5` with the dark-scheme surface-tint recipe
    documented in a STYLE comment (5/8/11/12/14% for levels 1–5); state-layer
    opacities `--md-sys-state-{hover,focus,pressed,dragged}-state-layer-opacity`
    (8%/12%/12%/16%).
  - The legacy token names aliased onto roles (`--bg`→surface,
    `--panel`→surface-container, `--panel2`→surface-container-high,
    `--rule`→outline-variant, `--ruleSoft`→outline-variant at 55%,
    `--ink`→on-surface, `--muted`→on-surface-variant, `--faint`→outline,
    `--accent`→primary, `--accentInk`→on-primary, `--danger`→error,
    `--ok`/`--warn`/`--night`→ the custom roles), which is why the pages
    re-skinned with no markup edits.
  - First type-role mappings (page titles headline roles, section heads
    title-large, card heads title-medium, buttons/nav label-large, form labels
    label-medium, kickers/tags label-small, field text body-large).
  - Tests: `apps/server/test/m3-tokens.test.ts` (WCAG contrast over every
    on-X/X pair, computed from the definition, independent of the library) and
    `apps/server/test/admin-origins.test.ts` (rule three on the wire — no
    third-party reference in served admin/wizard HTML, and every same-origin
    asset it references actually fetches).
- **Run next, in order:** Prompts 2 → 3 → 4 → 6 → 8. Prompt 5 (icons) can run
  any time after 1; Prompt 7 (wall theme generator) is independent of all of
  them.
- One branch per prompt (`feature/m3-<topic>`), release-notes line under
  `## Unreleased` in `addon/maverick-wall/CHANGELOG.md` per repo convention.

## The fidelity contract

These prompts implement the **faithful M3 look** — the admin should read as a
Material 3 application, not as the house style with M3 tokens underneath. That
means, concretely:

- M3 anatomy, metrics, shape and colour roles for every component: full-pill
  buttons, floating-label outlined text fields, the navigation-drawer active
  pill, M3 cards/dialogs/menus, state layers instead of `filter:brightness`.
- **Mixed-case type throughout.** The uppercase, wide-tracked kicker treatment
  is retired everywhere in the admin — Prompt 1 kept it and left a comment
  calling it a brand device; Prompts 2–3 reverse that decision and must update
  those comments so no comment survives contradicting the code.
- **Roboto throughout.** Every remaining `--cond` (Roboto Condensed) use in
  admin component rules moves to the `--md-sys-typescale-*` roles. Roboto
  Condensed stays bundled (the display and the wordmark fallback use it); the
  admin's components do not.
- The blueprint identity motifs go: corner registration marks (`.cm`), the
  transparent blueprint template cards, the topbar's backdrop blur, the
  hand-picked 7–8px radii.
- Where a faithful detail needs script, admin shell pages may use a small
  **inline, first-party** script (the precedent is THEME_SCRIPT in `html.ts`)
  — that covers the ripple in Prompt 6.

Three exceptions, deliberate and final:

1. **The brand lockup stays** — the mark, the Oswald wordmark and the favicon,
   in the sidebar, the wizard header and the tab. A product's logo is not a
   component; M3 apps keep theirs.
2. **The wizard and sign-in gain no script, ever.** They are the screens that
   must work before anything else does. Every M3 component they use must be
   the CSS-only construction; where a detail is script-only (the ripple),
   they use the pressed state layer instead.
3. **The QR keeps its white plate** — a code needs its quiet zone.

---

## Prompt 2 — Core controls (buttons, text fields, checkboxes/switches, segmented, chips, tabs)

```
This repository's server-rendered admin adopted Material Design 3 foundations
in a previous change: apps/server/src/http/html.ts imports committed colour
schemes from m3-tokens.ts and its STYLE constant now carries --md-sys-color-*
roles (plus --md-custom-color-{success,warning,night} and partners), the full
--md-sys-typescale-* scale on bundled Roboto, --md-sys-shape-corner-*,
--md-sys-elevation-level0..5, and --md-sys-state-*-state-layer-opacity tokens,
with the legacy token names (--bg, --panel, --accent, …) aliased onto roles.
Read CLAUDE.md, html.ts and m3-tokens.ts first.

This task is the first component pass: rebuild the core controls to faithful
M3 anatomy — the admin should read as a Material 3 application. Standing
constraints: nothing fetched at runtime (hard rule 3 — data-URI SVG is fine,
it is first-party); apps/display/** untouched (rule 2's ES2019/no-color-mix
limit is the display's — the admin already uses color-mix() and may use
:has(); it runs on phones and desktops); these pages are server-rendered and
script-free, so every construction here must work with CSS alone; and some
admin markup is built at runtime by scripts shipped in the display bundle (the
layout editor's .le-* and the entity picker's .hep-*), so keep every existing
class name working — restyle declarations, and change markup only in the
server-rendered templates (apps/server/src/http/admin*.ts, setup.ts).

New styles reach for --md-* tokens directly; the legacy aliases stay only for
rules this pass does not touch.

1. Buttons, per the M3 common-button spec. Map: default button/.btn → filled;
   button.secondary/.btn-ghost → outlined (use tonal where a page's secondary
   action deserves more weight — judge per page); .btn-danger → outlined on
   the error roles. Anatomy: 40px container height,
   border-radius var(--md-sys-shape-corner-full), 24px horizontal padding
   (16px beside a leading icon), label-large. Replace every
   filter:brightness hover with state layers: the label colour laid over the
   container at the hover/pressed opacities via color-mix. Compact controls
   (.btn-sm, .le-tool-btn, .le-cfg-btn, the toolbar buttons) become the same
   anatomy at negative density (32px container) rather than a different
   design. Icon-only buttons (.signout, .fieldhelp, .hep-pill-x,
   .le-modal-close) → M3 icon buttons: 40px standard/appropriate smaller
   variants, full corner, state layers. Every interactive control gets a
   ≥48x48px pointer target — extend targets with padding or a pseudo-element
   where the visual is smaller, never the visual.

2. Text fields: the faithful M3 outlined text field, floating label included,
   CSS-only. Introduce a shared field-rendering helper in html.ts (label +
   input wrapped in a .field container) and sweep the server-rendered forms
   in admin*.ts and setup.ts onto it. Mechanics without script: give text-like
   inputs placeholder=" " when they have no real placeholder, and rest the
   label over the input, floating it to the outline gap on
   :focus-within and whenever the input is not :placeholder-shown — a
   server-prefilled value is not :placeholder-shown, so edit forms render
   floated, which is correct; :has() is available if the structure needs it.
   Metrics: 56px height, extra-small corner, outline colour → outline role
   (on-surface-variant label), focus → 2px primary outline and primary label,
   error variant on the error role for pages that re-render with a field
   error. Controls that always render content (select, input[type=time],
   number, color, file, textarea with rows) keep the label permanently
   floated. Populated and empty states must both be verified — see below.

3. Checkboxes and switches, faithful and CSS-only via appearance:none on the
   native input (no script): checkbox 18px, 2px-radius container, 2px
   on-surface-variant outline unchecked, primary fill with an on-primary check
   glyph (inline data-URI SVG or clip-path) when checked, state layer behind,
   48px target. Where a lone checkbox means an on/off setting (enable/disable
   toggles rather than a pick-many list), render it as an M3 switch instead —
   still an input[type=checkbox], styled: 52x32 track
   (surface-container-highest off, primary on), thumb 16px growing to 24px
   with on-primary/inner colours per spec. Update .checks styling to suit;
   keep semantics and names identical so form handling is untouched.

4. Segmented buttons: .seg, .le-orient and .themebar become faithful M3
   segmented buttons — one outlined container, full corner on the outer ends,
   40px height, selected segment secondary-container/on-secondary-container
   with a leading check glyph (::before with a first-party data-URI mask or
   inline SVG), unselected on-surface, state layers on all.

5. Chips: .hep-chip and the .walls links → M3 filter chips (32px height,
   small corner, outline border unselected; selected: secondary-container
   fill, no border, leading check). .hep-pill → input chip with its trailing
   remove icon button on a 48px target.

6. Tabs: .tabbar/.tab → M3 primary tabs: 48px height, label-large mixed case
   (drop the uppercase transform — the fidelity decision recorded in
   docs/m3-adoption-prompts.md retires the uppercase kicker treatment; update
   the STYLE comment from the foundations pass that called it a kept brand
   device), active indicator 3px primary with rounded top corners, inactive
   on-surface-variant, state layers on hover.

7. Focus: replace the current 2px accent outline with the M3 focus-ring
   treatment on every control this pass touches — a 3px ring on the primary
   role, offset outward ~2px, keyboard-driven (:focus-visible).

Verify the way this project verifies: pnpm test (it builds first; never skip
the build — and it typechecks the tests). Then start the server and, in a
headless browser, walk every admin route (enumerate them from
apps/server/src/http/app.ts and the admin-* files rather than trusting a
list), in dark and light, screenshotting each — and look at the screenshots.
Measure, don't trust: filled buttons 40px, fields 56px, every interactive
target ≥48px or a written exception; a form with server-prefilled values
(edit an existing calendar) shows every label floated clear of its value; an
empty add form shows labels resting; keyboard-tab a form page and confirm the
focus ring on every control. Extend test/admin-origins.test.ts if any new
asset reference appears. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 3 — Surfaces and navigation (drawer, top bar, cards, dialogs, menus, status)

```
This repository's server-rendered admin has Material Design 3 foundations and
M3 core controls from previous changes: apps/server/src/http/html.ts carries
--md-sys-color-* / --md-custom-color-* roles (from m3-tokens.ts), the
--md-sys-typescale-* scale on bundled Roboto, shape/elevation/state tokens,
and M3 buttons, floating-label outlined fields, checkboxes/switches, segmented
buttons, chips and tabs. Read CLAUDE.md and html.ts first. This task is the
second component pass: surfaces and navigation, to the faithful M3 look — the
admin should read as a Material 3 application, with the blueprint-era identity
motifs retired. Standing constraints: nothing fetched at runtime; no script
added to server-rendered pages; apps/display/** untouched; class names built
by display-bundle scripts (.le-*, .hep-*) keep working.

1. Navigation drawer. Rebuild the sidebar (.side/.nav/.nav-item) to M3
   navigation-drawer anatomy: container on surface-container-low with no
   right border; active item a full-height pill indicator (56px,
   border-radius full, secondary-container fill, on-secondary-container icon
   and label) replacing the primary-filled active state; items label-large
   mixed case with 24px icons and state layers; section headers
   (.nav-group>span) → title-small, mixed case, on-surface-variant — the
   uppercase letterspaced treatment is retired (update the foundations-pass
   comment that kept it). Widen the 216px column enough to hold the pill
   anatomy comfortably (~280px; the spec's 360dp is a maximum, not a target)
   — and note .savebar hardcodes left:216px to clear the sidebar: it must
   follow the new width, and the 820px collapse breakpoint must be re-checked
   at the new width. The brand lockup at the top stays exactly as it is; the
   .nav-badge "off" pill becomes a label-small badge on the roles.

2. Top app bar. .topbar becomes a faithful small top app bar: 64px container,
   title-large title, on-surface, container surface-container while stuck
   (drop the backdrop blur and the translucent background — not M3 — and the
   bottom border with them; separation comes from the container colour).
   The .crumb kicker above the title → label-medium mixed case.

3. Cards. Faithful M3 cards at medium (12px) corner. Choose per use:
   interactive cards that navigate (a.card, the stat cards) → elevated card
   (surface-container-low, elevation level1, hover level2 + state layer; in
   the dark scheme convey elevation with the surface-tint recipe documented
   in the STYLE comment, keeping the shadow beside it); static section cards
   (.card) → filled card (surface-container-highest, no border). Retire the
   corner registration marks (.cm and every card that renders them — remove
   the markup too) and rebuild the blueprint template cards (.tpl-card) and
   theme-picker cards (.themecard) as standard M3 cards; delete the orphaned
   rules rather than leaving dead CSS. pre.log's hardcoded #0B1015 moves to
   the inverse-surface/on-inverse-surface roles.

4. Dialogs and menus. .le-modal → faithful M3 basic dialog: extra-large
   (28px) corner, surface-container-high, headline-small title, body-medium
   content, actions as text buttons right-aligned, scrim black at 32%.
   .helppop and .le-layers-pop → M3 menu surfaces: extra-small corner,
   surface-container, elevation level2, list rows as label-large with state
   layers.

5. Bars and status. .savebar → surface-container with no blur, its message
   text body-medium (keep the mechanism; it is already the M3 bottom-bar
   shape). .error → the error-container pattern: filled, 12px corner,
   on-error-container heading, no left accent border. .tag → label-small
   mixed case in tonal containers — use the custom-role containers
   (success-container/on-success-container, warning-, night-, error-) instead
   of outlined uppercase; .dot/.pulse keep their behaviour on the same roles.
   .qr keeps its white plate — a code needs its quiet zone; say so in a
   comment if one is not already there.

6. Sweep the remaining --cond uses in admin component rules onto typescale
   roles (grep for var(--cond) in STYLE: .today-big, .cpreview, .pv-*,
   .tpl-name, .disp-status, .settings-head, .le-* labels and the rest) —
   mixed case, tracking from the role. When the sweep is done, update the
   foundations-pass comment that says component styles "stay on --cond until
   the component phase"; after this change only the wordmark stack and the
   display's own CSS reference Roboto Condensed.

Verify: pnpm test; screenshot every admin route in both schemes and look at
them; drive the layout editor live far enough to open the add-widget dialog
and the Layers popover, and the Home Assistant entity picker (script-built
markup is where a missed class would hide); measure the drawer pill (56px),
dialog corner (28px), and that .savebar clears the widened drawer at desktop
width and the 820px collapse still works; grep STYLE for text-transform:
uppercase (only the brand lockup's small caps should remain) and for
var(--cond) (only the wordmark fallback should remain). Add a release-notes
line under ## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 4 — Wizard and sign-in

```
This repository's server-rendered admin has been rebuilt to the faithful
Material Design 3 look across previous changes (foundations in
apps/server/src/http/html.ts + m3-tokens.ts; M3 controls including CSS-only
floating-label outlined fields; M3 surfaces and navigation). The first-run
wizard (/setup, apps/server/src/http/setup.ts) and the sign-in page share
that stylesheet through the body.wiz shell and inherit most of it. Read
CLAUDE.md, html.ts and setup.ts first. This task finishes the wizard-specific
pieces to the same fidelity.

The one constraint that outranks the spec here: the wizard and sign-in are
deliberately plain server-rendered HTML with no script, because they are the
screens that must work before anything else does. Add no JavaScript to them,
required or optional. Every M3 component they use must be the CSS-only
construction from the earlier passes (the floating-label field already is);
where a detail is script-only, they use the pressed state layer and nothing
else.

1. The step indicator (.steps) becomes an M3 linear-progress treatment:
   4px full-corner track in surface-container-highest, done/current segments
   primary, captions label-medium mixed case (current step primary, done
   on-surface-variant, upcoming outline) — the uppercase letterspaced step
   captions are retired with the rest of the kicker treatment.

2. Sweep every wizard step and the sign-in page for stragglers the shared
   restyle missed: the wizard card should be the filled-card treatment, its
   fields the floating-label construction (setup.ts markup must use the
   shared field helper — including the bootstrap-code field, the timezone
   select with a permanently floated label, and the calendar URL step), its
   buttons the filled/outlined pair with the skip affordance as a text
   button, every .error state the error-container pattern. The brand lockup
   at the top stays exactly as it is.

3. Contrast-check the two texts that matter most by hand: the bootstrap-code
   entry (read from a terminal log, typed under time pressure) and the error
   messages (read in a kitchen).

Verify by driving the real thing, not by reading: run the existing wizard,
ingress and screen-pairing tests via pnpm test; then start a fresh server
(empty DATA_DIR), walk the wizard end to end headlessly through all three
steps including the error paths (wrong code, failed feed test), screenshot
each step in both schemes, and confirm the floating labels behave on the
wizard's own forms (empty account form at rest; re-rendered form with values
after a validation error shows labels floated). Pin the no-script property in
a test: capture the exact set of <script> elements /setup and /admin/sign-in
serve today (the shared theme script, if the wiz shell includes it, is
today's baseline — pin whatever is actually there) and assert this change
adds none. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 5 — Iconography (Material Symbols)

```
This repository's server-rendered admin uses a small set of first-party inline
SVG icons: ICON_PATHS in apps/server/src/http/html.ts, hand-copied line-icon
paths drawn stroke-based at stroke-width 1.6, rendered through an icon()
wrapper. Rule 3 (CLAUDE.md) forbids fetching anything third-party at runtime,
so icons are inlined — that mechanism stays. The admin has adopted Material
Design 3 (see the --md-* tokens and M3 components in html.ts). Read CLAUDE.md
and html.ts first.

Task: replace the icon set with Material Symbols, the M3 icon family, keeping
everything inline and first-party.

1. Source each icon in ICON_PATHS from Material Symbols Outlined (24dp grid,
   default weight) in the google/material-design-icons repository — copy the
   path data into ICON_PATHS. No dependency, no icon font, no fetch. Choose
   the closest Symbols glyph per key — enumerate ICON_PATHS rather than
   trusting any list, and cover every icon() call site in admin*.ts and
   setup.ts.

2. Material Symbols are FILLED OUTLINE PATHS, not strokes. Update the icon()
   wrapper to fill-based rendering with currentColor and audit every svg rule
   in STYLE that assumes strokes (stroke-width on .nav-item svg, button svg,
   .ic svg, .link svg, .fieldhelp svg and any others) — a stroke rule left
   behind renders a Symbols glyph as a hairline ghost or a blob.

3. Standardize sizes to the M3 grid where the slot allows: 24px in the
   navigation drawer and icon buttons, 18px inside buttons and chips. Keep
   smaller decorative slots proportionate rather than forcing 24px into them.

4. Record the licence: Material Symbols is Apache 2.0 — add the attribution
   beside the font attributions (apps/server/assets/fonts/LICENSES.md has the
   pattern; check whether the root NOTICE wants a line too — this is an AGPL
   project that takes attribution seriously).

5. Do not touch the brand MARK, the favicon, or the wordmark — identity, not
   iconography.

Verify: pnpm test; render every page that shows icons (the sidebar appears on
all of them; Overview's stat cards, buttons with leading icons, the
layout-editor toolbar) in both schemes and look at each slot — this project's
history says an asset fault surfaces only when somebody looks. Re-run
test/admin-origins.test.ts. Add a release-notes line under ## Unreleased in
addon/maverick-wall/CHANGELOG.md.
```

## Prompt 6 — Motion, ripple and interaction polish

```
This repository's server-rendered admin has been rebuilt to the faithful
Material Design 3 look (foundations, controls, surfaces — see
apps/server/src/http/html.ts, its STYLE constant and m3-tokens.ts). Read
CLAUDE.md and html.ts first. This task adds M3 motion — deliberately the last
admin pass.

1. Add md.sys.motion tokens to STYLE: easing-standard
   cubic-bezier(0.2, 0, 0, 1), easing-emphasized-decelerate
   cubic-bezier(0.05, 0.7, 0.1, 1), easing-emphasized-accelerate
   cubic-bezier(0.3, 0, 0.8, 0.15); durations short (50–200ms), medium
   (250–400ms), long (450–600ms) as named steps.

2. Apply them: state-layer hover/press transitions on buttons, chips, nav
   items, cards and list rows; the tab indicator; the switch thumb and track;
   dialog and menu enter (emphasized-decelerate) and exit (accelerate) as
   pure CSS transitions; the admin theme toggle's scheme change.

3. The ripple. A faithful M3 pressed state is a ripple expanding from the
   press point, and that needs script. The admin shell already carries one
   inline first-party script (THEME_SCRIPT in html.ts — applied before paint,
   no fetch); follow that precedent: a small inline script in the shell
   pages only that delegates pointerdown on buttons, chips, tabs, nav items
   and segmented buttons and animates a radial state layer from the press
   point, honouring prefers-reduced-motion (skip the animation, keep the
   pressed layer). The wizard and sign-in pages get NO script — they keep the
   static pressed state layer, and the script must not be included in the wiz
   shell. Progressive enhancement only: with the script absent every control
   still shows its pressed state via CSS.

4. Wrap every transition and animation in the stylesheet — including the
   .pulse keyframes — behind @media (prefers-reduced-motion: no-preference),
   or provide a reduce override that stills them.

Verify: pnpm test; screenshot pass on the main pages in both schemes; in the
headless browser, emulate prefers-reduced-motion: reduce and assert computed
transition durations are 0s/none on the controls above and the ripple does
not animate; confirm /setup and /admin/sign-in serve exactly the scripts they
served before this change (the wizard script census test from the wizard pass
should already pin this — run it). Add a release-notes line under
## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 7 — Wall theme generator from a seed colour (optional, independent)

```
This repository has a custom display-theme system: households compose wall
themes from eleven colour tokens plus an allowlisted font stack, stored and
resolved in apps/server/src/api/themes.ts (COLOUR_TOKENS, withTints, the
custom: prefix), edited on /admin/themes, and delivered to the wall as fully
resolved tokens in the manifest — the display bundle never learns new theme
names. Separately, the admin already uses Material Design 3: an earlier
change added apps/server/scripts/generate-m3-tokens.mjs and
@material/material-color-utilities as a devDependency of apps/server, and
committed admin colour schemes in apps/server/src/http/m3-tokens.ts. Read
CLAUDE.md, apps/server/src/api/themes.ts, the themes admin page
(admin-themes.ts), the generator script, and apps/display/src/theme.ts (for
the tint maths and token vocabulary — read only; apps/display/** must have
ZERO changes in this task).

Task: add "Generate from a colour" to the custom-theme builder, using M3's
colour engine, so one seed colour yields a complete contrast-guaranteed wall
theme through the existing custom-theme pipeline.

1. Promote @material/material-color-utilities from devDependency to a regular
   dependency of apps/server — this feature runs at request time, not design
   time. Rule 1 fences packages/core and packages/calendar, not apps; note
   the image-size cost in the PR description (the library is tens of
   kilobytes, pure TS). Nothing new reaches the display bundle.

2. Server-side generator (share what makes sense with the logic in
   scripts/generate-m3-tokens.mjs rather than re-deriving it): from a seed
   colour and a light/dark choice, derive the M3 scheme and map it onto
   COLOUR_TOKENS: surface → --bg, surface-container → --panel,
   outline-variant → --rule, on-surface → --ink, on-surface-variant →
   --muted, outline → --faint, primary → --accent. For the four shift hues,
   Blend.harmonize the display's defaults (--s-day #E8A33D, --s-night,
   --s-break, --s-straight from apps/display/src/theme.ts) toward the seed,
   then adjust tone until each is ≥3:1 against the generated --bg — a shift
   colour that vanishes into the background is a rota nobody can read from
   across a kitchen.

3. UI: a small section on the themes screen — colour input, light/dark
   choice, a name field — that posts to a route which runs the generator and
   then the EXISTING create path (schema-validated per rule 5; validation.ts
   already has a colour() validator), so the result is an ordinary custom
   theme: previewable in the existing builder, editable afterwards, resolved
   with withTints, carried in the manifest like any other. Copy written for
   someone standing in a kitchen: say what a seed colour is in one sentence.

4. Tests, in the project's touch-something-real style: a unit test asserting
   every generated pairing meets its contrast bar (ink/bg ≥ 4.5:1, muted/bg ≥
   4.5:1, faint/bg ≥ 3:1, accent/bg ≥ 3:1, each shift hue/bg ≥ 3:1) across a
   spread of seeds including ugly ones (#000000, #FFFFFF, a neon) — reuse the
   WCAG arithmetic pattern from test/m3-tokens.test.ts; a route test that
   generates a theme, selects it, and reads /d/manifest to assert the wall
   receives resolved tokens; and a check that the apps/display diff is empty.

Verify: pnpm test (builds first); run the server, generate a theme from the
admin UI, select it for a screen, open the display headlessly and screenshot
the wall drawing it in portrait and landscape. Add a release-notes line under
## Unreleased in addon/maverick-wall/CHANGELOG.md.
```

## Prompt 8 — Close-out audit

```
This repository's server-rendered admin and first-run wizard have been rebuilt
to the faithful Material Design 3 look across several merged changes —
foundations (m3-tokens.ts, the --md-* token system in
apps/server/src/http/html.ts), core controls with CSS-only floating-label
fields, surfaces and a navigation drawer, the script-free wizard, Material
Symbols icons, and motion with an admin-only inline ripple.
docs/m3-adoption-prompts.md records what was intended, including the fidelity
contract and its three exceptions (brand lockup, script-free wizard, the QR's
white plate). Read CLAUDE.md first; its "verification is the job" table is
the standard this task applies. This is an audit-and-fix pass: find what the
phase work missed, fix small faults directly, and file anything larger as a
clear list in the PR description.

Sweep, measuring rather than trusting:

1. Render EVERY admin route (enumerate them from apps/server/src/http/app.ts
   and the admin-* files, not from memory) plus every wizard step and the
   sign-in page, in dark and light, at 390px, 820px (the collapse breakpoint)
   and 1280px. Screenshot all of it and look at all of it. Assert in the
   headless pass that no page scrolls horizontally at any width.

2. Interaction audit: every interactive control ≥48px target or a written
   exception; :focus-visible ring on every control; floating labels correct
   in both states (an edit form with prefilled values floats every label; an
   empty add form rests them); the layout editor and Home Assistant entity
   picker driven live (script-built markup is where a missed class hides);
   the ripple present on admin pages, absent on /setup and /admin/sign-in,
   and still on those pages every control shows a CSS pressed state.

3. Fidelity greps over the STYLE constant and admin-* pages, with the three
   contract exceptions as the only survivors: raw hex colours outside the
   token/scheme definitions (everything through an --md-* role or an alias);
   var(--cond) (wordmark fallback only); text-transform:uppercase (brand
   lockup small caps only); filter:brightness (none); backdrop-filter (none);
   border-radius literals that bypass --md-sys-shape-corner-* (case-by-case:
   a literal is a smell, not automatically a fault); leftover stroke-width
   rules from the old icon set (none). Delete dead rules the component
   passes orphaned, and confirm no comment survives describing the retired
   uppercase/condensed treatment as current.

4. Contrast: test/m3-tokens.test.ts green, and spot-check by hand the two
   texts that matter most — error boxes and the wizard's bootstrap-code
   screen — in both schemes.

5. Rule three, proven not assumed: test/admin-origins.test.ts green, and read
   it once to confirm it still parses everything the pages now serve
   (including any data-URI assets the M3 controls introduced — data URIs are
   first-party and should pass).

6. Ingress: run the ingress proxy tests, and render at least one
   sidebar-mounted page through the ingress harness to confirm the restyle
   holds under the <base>-prefixed path — relative font/asset URLs (including
   roboto.woff2) are where this breaks.

7. Layout regressions the restyle could have caused: the widened drawer vs
   .savebar's left offset at desktop width; the 820px collapse; the sticky
   top app bar over scrolling content with the blur gone.

8. Docs: update CLAUDE.md's current-state section with a short paragraph on
   the M3 admin (what was adopted; the three deliberate exceptions; where the
   tokens live and how to regenerate them), and add the closing release-notes
   line under ## Unreleased in addon/maverick-wall/CHANGELOG.md.

The one thing this audit cannot do from inside a test harness — and should
say so rather than claim — is the real-hardware check this project ends every
feature with: the sidebar opened through a real Home Assistant supervisor, on
both HA themes, and the wizard completed once on a fresh add-on install. List
it in the PR description as the remaining verification, the way CLAUDE.md
records such things.
```

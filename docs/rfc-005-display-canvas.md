# RFC 005 — Canvas-first displays with a template gallery

Status: **proposed** · Owner: — · First drafted 2026-08-13 ·
Builds on the free-form layout that shipped in v0.1.5 (`layout_mode`,
`layout_widgets`, `renderFreeform`, the `/admin/layout` editor) and the
first-party `WIDGET_TYPES` allowlist where [RFC 001](./rfc-001-module-framework.md)'s
"data crosses the boundary, code never does" posture lives.

## Summary

Make the arrangeable **canvas** the default way a display is built, add a
**template gallery** to start from, and let a canvas be authored for **portrait
and landscape** separately so a rotated wall looks intentional rather than
letterboxed by accident. Reframe the on-ramp: *add a display → pick a blank
canvas or one of twelve templates → land in the editor*, where every item is
movable, removable, and configurable.

The complaint this answers, in the owner's words: *"the default layout is just
there with no options, no way to adjust its layout, no removing parts."* That is
true today — the responsive `auto` layout is a black box. This RFC keeps that
layout (it is the only orientation-aware, always-safe fallback the product has)
but demotes it to **one template among many** and makes a real editable canvas
what a new display gets by default.

Crucially, **most of the machinery already exists.** v0.1.5 shipped a genuine
drag-and-drop canvas with a live preview that renders the real manifest through
the wall's own `renderFreeform`, per-widget config, layering, and box-level
format. This RFC is not "build a canvas." It is: promote it, add templates, add
the second orientation, and fix the door.

## What this is *not*

- **Not a cloud template marketplace.** Templates are baked-in source, one file
  each, shipped in the image and validated at build — the same posture as the
  Store ([`http/catalog.ts`](../apps/server/src/http/catalog.ts) and
  `apps/server/src/catalog/`). A wall with no internet has all ten.
- **Not a new widget-embedding surface.** A template can place nothing a
  household could not place by hand, because it validates through the *same*
  `WIDGET_TYPES` / `layoutWidgetBody` a hand-built canvas does. Rule three holds
  by construction — no `website`, no `iframe`, no video, however much a template
  gallery invites them (see the Mango screenshots' "GIFs & Stickers", which this
  product cannot and will not draw).
- **Not reusable layout profiles or "Linked Displays" (this RFC).** A display
  stays **the shared Default or a single paired screen**. The convenience Mango
  gets from profiles is delivered instead by two cheaper moves — *apply a
  template* and *copy layout from another display* — with no new abstraction and
  no schema for a device-to-profile relation. (Profiles are noted under Open
  questions, not built.)
- **Not backgrounds.** Photos and gradients are Phase 3. The first twelve templates
  are **layout + theme colour only**. This is a deliberate sequencing call: the
  background system (uploaded images through the SSRF-guarded media store, no
  external URLs) is its own effort, and templates ship sooner without it.

## Why it fits the architecture

The seam is already cut. `renderFreeform`
([`render.ts`](../apps/display/src/render.ts)) draws widgets by canvas fraction
and scales reused sections to their box; `buildLayout`
([`api/manifest.ts`](../apps/server/src/api/manifest.ts)) is the one place a
stored row becomes a wall widget, clamping coordinates and checking types; the
editor ([`layout-editor.ts`](../apps/display/src/layout-editor.ts)) already
previews through the wall's real renderer in a shadow root. The three changes
this RFC needs — a second orientation, a template that is just a saved widget
set, and an on-ramp — all bolt onto those existing seams rather than cutting new
ones.

The `auto`/`freeform` split already exists on both the household default and per
screen (`household_settings.layout_mode`, `screens.layout_mode`). "Adaptive
becomes a template" is therefore not a new mode — it is the mode that is already
there, given a name and a card in the gallery.

---

## Part A — Two canvases per display (portrait + landscape)

This is the one genuinely new modelling decision, and it touches storage, the
manifest, and the renderer.

**The problem.** A canvas is authored at a fixed aspect and letterboxed onto a
wall of a different shape. Walls get rotated (`screens.rotation`) and mounted in
both orientations. A single portrait canvas on a landscape TV wastes half the
screen; the reverse clips. The owner's decision: **each display authors two
canvases**, and the wall draws the one matching its real orientation.

**Who chooses which canvas — the display, not the server.** Only the wall knows
its live orientation: `geometryFor` ([`orientation.ts`](../apps/display/src/orientation.ts))
already resolves portrait vs. landscape from viewport, rotation, and the
per-screen pin. A television turned on its end reports a landscape viewport while
the thing a person looks at is portrait — which is exactly why the existing code
computes orientation rather than reading a media query, and exactly why the
server must not try to pick the canvas. So **the manifest carries both**, and the
display selects.

`Manifest['layout']` changes from one widget set to two:

```ts
readonly layout: {
  readonly mode: 'auto' | 'freeform';
  readonly portrait:  { readonly aspect: number; readonly widgets: readonly ManifestWidget[] };
  readonly landscape: { readonly aspect: number; readonly widgets: readonly ManifestWidget[] };
};
```

`buildLayout` builds both sets. `renderFreeform` gets a thin selector — given
`geometryFor().layout`, it draws `layout[orientation]` — and everything below it
(the box positioning, the fit-to-box scaling, the takeover/banner handling) is
unchanged.

**The fallback rules, stated precisely (rule nine).** The owner chose *require
both / letterbox* over *fall back to Adaptive per orientation*, so:

| Display state | What the wall draws |
|---|---|
| `mode = auto` (Adaptive, or no canvas at all) | The responsive zoom-pyramid, both orientations. Unchanged. |
| `freeform`, both canvases have widgets | Each orientation draws its own canvas. |
| `freeform`, only one orientation authored | **Letterbox** the authored canvas onto the other orientation. |
| `freeform`, *both* canvases empty | Fall back to `auto`. A blank wall is the one outcome rule nine forbids. |

The templates always ship both orientations (Part C), so a template-started
display is never in the one-sided case. It arises only when a household builds a
blank canvas by hand and stops after one orientation — and letterboxing what
they built beats showing them a layout they did not author.

### Storage — additive only, no table recreate

This is where rule seven and the migration-`0009` corruption story bite. That
migration is the one edited-after-generation file in the repo because a
`drizzle-kit` table recreate silently turned every calendar's `kind` into the
string literal `'kind'`. **No table recreate here.** Additive columns and one
defaulted column only:

```
layout_widgets
  + orientation  TEXT NOT NULL DEFAULT 'portrait'
    -- existing rows were authored at the portrait default aspect (0.5625),
    -- so 'portrait' is the honest backfill, not a guess.

household_settings, screens
  + layout_landscape_aspect  REAL
    -- the existing layout_aspect keeps its meaning as the PORTRAIT aspect.
    -- Landscape defaults to 1.7778 (16:9) when null. Documented in schema.ts
    -- so nobody "cleans up" the asymmetry and re-breaks the backfill.
```

`readLayoutWidgets` / `replaceLayout` ([`api/queries.ts`](../apps/server/src/api/queries.ts))
grow an `orientation` parameter; a save writes one orientation's rows without
touching the other's (the existing per-owner `DELETE ... WHERE screen_id IS ?`
becomes `... AND orientation = ?`), so saving portrait never wipes landscape.

**The verification that settles it:** `test/migration-upgrade.test.ts` must walk
this migration against a database that already holds a free-form canvas — the
one path every other test skips, because they start from empty, and the only
path where this migration could destroy something. An existing v0.1.5 canvas
must come out as a portrait canvas with its widgets intact and a landscape side
that is empty (→ letterboxes onto landscape, per the table above).

---

## Part B — The "Add a display" flow (the priority)

Today pairing a screen just names it; the canvas is edited elsewhere, later, and
the default is the un-editable `auto`. The new flow makes layout the first-class
thing.

**The on-ramp**, reshaping [`displaysPage`](../apps/server/src/http/admin.ts):

1. **Add a display** → pair a physical screen (the existing QR + short-code flow,
   unchanged — it is proven on real hardware and this RFC does not touch it), or
   configure the shared **Default**.
2. **Pick a starting point** — a gallery (Mango screenshot #1): a **Blank
   canvas** card plus the templates, under **Home / Office** tabs. Selecting
   one applies it and opens the editor.
3. **Land in the editor** with that starting point in place, both orientations.

**Existing displays** get two affordances on their page, which is the whole of
the "hybrid" convenience the owner chose over profiles:

- **Apply a template** — destructive, confirmed ("this replaces the current
  layout"), writes both orientations via `replaceLayout` and sets
  `mode = freeform`.
- **Copy layout from…** — reads another display's canvases (Default or any
  screen) and writes them onto this one. One `replaceLayout` per orientation from
  the source rows.

Both are server routes, server-rendered confirm, no new client app. Neither
introduces a profile or a device-to-layout relation — they are one-shot copies
into the existing per-owner storage.

**Endpoints** (server-rendered, relative-URL, ingress-safe like the rest of
`admin.ts`):

```
POST /admin/displays/:owner/apply-template   { templateId }
POST /admin/displays/:owner/copy-from        { sourceOwner }
GET  /admin/displays/:owner/gallery          the template picker for this owner
```

`:owner` is `default` or a screen id, resolved by the existing `resolveOwner` /
`resolveConflicts`-adjacent code and validated against the real screens — a
stranger's id must not write onto a wall, the same guard `POST /admin/layout`
already applies.

---

## Part C — Templates

**A template is a saved `LayoutState` × two orientations.** Nothing more:

```ts
interface DisplayTemplate {
  readonly id: string;                       // stable, kebab-case
  readonly name: string;
  readonly category: 'home' | 'office';
  readonly portrait:  { readonly aspect: number; readonly widgets: readonly TemplateWidget[] };
  readonly landscape: { readonly aspect: number; readonly widgets: readonly TemplateWidget[] };
}
```

`TemplateWidget` is the same shape the editor already emits and the server
already validates — `{ type, x, y, w, h, z, config? }` — so a template is
parsed through the **same** `layoutWidgetBody` / `widgetConfigBody` a POST to
`/admin/layout` is. A malformed template is therefore a **build failure**, never
a broken wall.

**They live in the repo, as source.** One file per template under
`apps/server/src/templates/`, an `index.ts` listing them, assembled into a
validated `TEMPLATES` constant, guarded by `test/templates.test.ts` — the exact
pattern `test/catalog.test.ts` uses for the Store, for the exact reason (a
directory of source bakes into the image and works offline; a fetched document
does not). A new template is a pull request against that directory and ships to
everyone next release.

**Applying a template** = `replaceLayout(owner, 'portrait', template.portrait)`
and `replaceLayout(owner, 'landscape', template.landscape)` and
`layout_mode = 'freeform'`. Because it goes through `replaceLayout`, the
manifest a wall next polls carries the applied canvas with nothing downstream
knowing a template was involved.

### Thumbnails — rendered, not fetched

Rule three forbids a fetched image, so a template card **cannot** carry a
screenshot from a CDN. Two honest options:

- **Live render** each card through `renderFreeform` in a shadow root, the way
  the editor preview already draws the real wall. Always accurate, zero new
  assets — but a dozen live month-grids on one page is a measurable cost.
- **Baked static thumbnails** generated at build time (the brand pipeline already
  runs headless Chrome; see `docs/brand/`), shipped as inline SVG/PNG data —
  cheap to display, but a second source of truth that can drift from the
  template.

**Recommendation:** live render, **lazily** — draw a card's preview when it
scrolls into view (an `IntersectionObserver`, ES2019-safe), so the page pays for
what it shows. Decide with a measurement during the build, not a guess; if ten
live previews judder on a Raspberry-Pi-class admin browser, fall back to baked
thumbnails. This is called out now because "render a dozen real walls on one page"
is precisely the kind of thing that passes on the author's laptop and stutters on
the hardware this product runs on.

### The twelve templates (designed as part of this work)

Theme-coloured, both orientations, first-party widgets only. Widget types drawn
from the existing allowlist: `clock`, `calendar`, `weather`, `homeassistant`,
`shift`, `notes`, `todo`, `countdown`, `image`, `external`.

The list is led by two **Skylight-style** clones — the recognisable "digital
family calendar" a household arriving from a Skylight/Cozi/Hearth device is
looking for — on the Paper Almanac (white) theme, which is the closest of the
four to that product's bright look:

| # | Home | # | Office |
|---|---|---|---|
| 11 | **Sky Calendar** — Skylight-style month, near-full-bleed, colour-coded event pills per person | 7 | **Team Week** — week agenda + clock + weather |
| 12 | **Sky Week** — Skylight-style week: month+weather rail beside vertical day columns | 8 | **Meeting Room** — big today schedule + clock |
| 1 | **Family Hub** — month grid + clock + weather + todo | 9 | **Ops Dashboard** — module/HA panels + calendar |
| 2 | **Today Focus** — large agenda + weather strip | 10 | **Reception** — clock + weather + notes |
| 3 | **Command Center** — calendar + HA readings + shift | | |
| 4 | **Chore Board** — todo + notes + calendar list | | |
| 5 | **Countdown** — big countdown + month grid | | |
| 6 | **Minimal Clock** — huge clock + weather (Glance theme) | | |

(The two Sky templates are numbered 11–12 as the eleventh and twelfth authored,
but sort **first** in the gallery — they are the front door for a household
replacing a commercial calendar. The `n`umber is a label; gallery order is set
by the list.) Each template is authored twice (portrait 9:16 and landscape 16:9)
so the "require both" rule is satisfied out of the box. They lean on theme tokens
for colour and carry no photo, so they are complete under Phase-1's
no-backgrounds constraint and gain a background pass in Phase 3.

The design mock that settled these is a live gallery rendering all twelve through
the real theme tokens (both orientations), built and reviewed before any source
was written — the "look at it, then measure the DOM" step this project keeps
learning it cannot skip.

### The two renderer widenings the Sky templates need

This is the one place the "a template can place nothing a household couldn't
place by hand" claim earns scrutiny, so state it plainly. The two Sky clones use
**two calendar-widget capabilities the display does not have yet**:

1. **A `week` mode on the calendar widget** — vertical day columns (the Skylight
   week view), beside today's existing `month` and `list`. New rendering in the
   calendar renderer; today's `renderWidget('calendar', …)` branches on
   `mode: 'month' | 'list'` only.
2. **In-cell event pills for `month`** — the Skylight tell is a coloured,
   labelled bar per event *inside* the day cell, in the owning person's colour,
   rather than the quiet dot the wall's month grid draws now. A per-widget
   `cellEvents: 'dots' | 'pills'` (default `dots`, so no existing wall changes).

The important part: **both become first-class calendar-widget options, exposed
in the editor's Calendar config**, not template-only magic. So the invariant
holds — a household can build Sky Calendar or Sky Week by hand from the palette;
the templates are just a saved arrangement of options that exist anyway. Concrete
changes:

- `widgetConfigBody` (in `admin.ts`): `mode` enum gains `'week'`; add
  `cellEvents: z.enum(['dots','pills']).optional()`. Both default to today's
  behaviour when absent, so a v0.1.5 canvas is unchanged (rule five: absence is
  the default, not a coercion).
- The display calendar renderer ([`render.ts`](../apps/display/src/render.ts))
  grows the `week` columns branch and honours `cellEvents` in `month`. The event
  colour is the one the manifest **already** carries per event (`color` /
  `personId`) — no new data, and no entity/owner detail the manifest withholds.
- The editor's Calendar config (`buildCalendarConfig`) offers "Show as: Month
  grid / Week columns / Upcoming list" and, for month, "Events as: dots / pills".

These are contained additions to one widget, not a new widget type — so they
cost the calendar renderer and its config, and nothing else. They are worth
pulling out of the template files because a Skylight refugee will reach for them
directly, template or not.

---

## Part D — Editor upgrades

[`layout-editor.ts`](../apps/display/src/layout-editor.ts) is the one client-side
app in the admin — vanilla TS, ES2019, same-origin, shipped in the image. It
needs:

**For Phase 1 (blocking the flow above):**

- **Orientation switch** — a Portrait | Landscape toggle. The editor holds two
  widget sets in state, edits one at a time, and its live preview draws the
  matching one at the matching aspect. Save posts the edited orientation.
- **Full palette.** `notes`, `todo`, and `image` are already valid
  `WIDGET_TYPES` but missing from the editor's `PALETTE`. Expose them.
  - `image` picks from the SSRF-guarded media store (`/admin/media`, magic-byte
    sniffed, **SVG refused** — [`api/media.ts`](../apps/server/src/api/media.ts),
    already built). No external URL field, ever (rule three).
  - `notes` / `todo` are first-party text the household types; their config is a
    string list validated by `widgetConfigBody`.
  - *(Quotes widget deferred — `notes` covers the free-text case for now.)*

**For Phase 2 (polish, the Mango-canvas parity):**

- **Layers panel** — a reorderable list (drag to restack) replacing the
  front/back-only buttons, matching the "Layers" control in the screenshots.
- **Snap-to-grid** — a toggle that rounds x/y/w/h to a grid step on drag/resize;
  storage stays fractional, so snapping is an editor affordance, not a data
  change.
- **Unified per-display settings** — consolidate the today-scattered controls
  into the display's own page (Mango screenshot #3): Name, Fonts & Colors (the
  existing theme editor), Display Orientation pin + rotation, Timezone,
  24-hour, Visual Overlays (≈ the interrupts/banners the household already
  configures), Schedule (≈ the theme daylight window), Preview, Reset & Remove.
  Most of these exist — the work is one page, not new features.
- **Match display resolution** — set a canvas aspect from a screen's *real*
  reported viewport. This needs the display to report its resolution in the
  heartbeat (a small new field), which does not exist yet; until then, the aspect
  presets + a manual entry stand in. Called out as its own line item rather than
  pretending the aspect dropdown already does it.

---

## Security considerations (rule map)

- **Rule three (no third-party origins on the wall):** enforced in the two
  places it already lives — `WIDGET_TYPES` gates every template and every hand
  placed widget, and `image` resolves only through the media store. Template
  thumbnails render locally; nothing on the gallery page fetches a remote asset.
  A template is data the server assembles from its own source, not a document it
  downloads.
- **Rule five (Zod at boundaries):** templates parse through the existing
  `layoutWidgetBody`; the apply/copy endpoints take Zod bodies in
  `validation.ts` like every other form; the new `orientation` parameter is a
  closed `z.enum(['portrait','landscape'])`, not a string.
- **Rule seven (forward-only migrations):** additive columns and one defaulted
  column, **no table recreate** — the `0009` precedent is why. Walked against a
  database that already has a canvas.
- **Rule nine (never blank):** the fallback table in Part A is the contract; each
  branch gets a test whose *name* matches its assertion (the "rest day" lesson —
  a test named for the empty case that then asserted the empty list).
- **Rule ten (secure defaults):** apply-template and copy-from are behind the
  session gate and the origin check like every other non-GET; `:owner` is
  validated against the real screens so a forged id cannot write onto a wall.

---

## What we deliberately do not build (this RFC)

- **Reusable layout profiles / Linked Displays.** A display stays Default-or-
  screen. *Apply template* and *copy from* deliver the reuse without a
  device-to-profile schema. Profiles are a real future step (they are what makes
  one layout drive a wall of identical kiosks) but they are a data-model change
  worth its own RFC, not a rider on this one.
- **Backgrounds.** Phase 3. Solid / gradient / uploaded image through the media
  store, no external URLs. The twelve templates are colour-and-layout until then.
- **Auto-reflow across orientations.** The owner chose letterbox over reflow; a
  canvas authored for one orientation is shown, letterboxed, on the other rather
  than being silently re-placed into a layout the household did not author.
- **The quotes widget** and other net-new widget types beyond exposing the three
  already-typed ones (`notes`, `todo`, `image`).
- **"GIFs & Stickers" and web embeds** from the Mango palette — impossible under
  rule three and not a goal.

## Testing — verification is the job

Per this project's history, none of these are found by typechecking:

- **The migration**, walked against a database that already holds a v0.1.5
  free-form canvas — the row must come out `orientation = 'portrait'` with its
  widgets intact and the landscape side empty. This is the `0009` trap and the
  one path the empty-start tests never cover.
- **Both-empty → Adaptive** and **one-sided → letterbox**, each a test named for
  the case it asserts, driving a real manifest through `buildLayout` and
  `renderFreeform`.
- **Apply-template round-trip** — apply template X to the Default, read the
  manifest back, assert both orientations carry X's widgets and `mode` is
  `freeform`; and that applying to a screen leaves the Default untouched (the
  per-owner `DELETE` scoping).
- **Copy-from isolation** — copying Default→Kitchen writes Kitchen's rows and
  touches no other wall's.
- **All twelve templates** parse through `layoutWidgetBody` in `test/templates.test.ts`
  — a malformed one fails the build, never a wall.
- **The calendar `week` mode and `cellEvents: 'pills'`**, driven through the real
  `renderWidget('calendar', …)` against a manifest with events on several days:
  a week canvas draws seven columns with each event under its own day, and pills
  colour from the event's own `color`/`personId` — the `DTEND`-exclusive rule
  still holds (an event on the 15th is under the 15th, not the 16th). `cellEvents`
  absent still draws the quiet dot, so no existing wall changes.
- **Thumbnail cost** measured on a low-power browser before choosing live vs.
  baked, not asserted from the author's laptop (the performance-budget lesson).
- **The editor**, driven through the sidebar on a real Home Assistant supervisor,
  because the shadow-DOM preview and its fetches under ingress are exactly the
  class of thing a stand-in has hidden before. The paired-wall-screen path
  drawing a two-orientation canvas is the real-hardware check that is *not* the
  sidebar and remains the last unproven step, as it already is for free-form.

## Rollout

Additive and forward-only. Existing displays are untouched: an `auto` display
stays `auto`, a v0.1.5 free-form display becomes a portrait canvas with an empty
landscape side (which letterboxes onto landscape — the same single-orientation
picture it effectively had before). No data migration of existing layouts beyond
the defaulted `orientation` backfill. Ships as normal releases: notes under
`## Unreleased`, `advertise` writes the version last.

**Phasing:**

- **Phase 0 — Foundation.** Two-canvas manifest, the display picks by
  orientation, the additive migration. Nothing user-visible; everything hangs off
  it.
- **Phase 1 — The door (priority).** The "Add a display" flow, the template
  gallery, the twelve templates (with the two Sky clones leading), the calendar
  `week`/`pills` widenings, apply/copy, editor orientation switch + full
  palette.
- **Phase 2 — Editor polish.** Layers panel, snap-to-grid, unified per-display
  settings, match-resolution (with the heartbeat resolution report).
- **Phase 3 — Backgrounds.** The background layer and a template refresh.

## Open questions

1. **Live vs. baked thumbnails** — decided by measuring a dozen previews on
   low-power hardware, not before.
2. **`match display resolution`** needs a display→server resolution report in the
   heartbeat. Build it in Phase 2, or defer and keep aspect presets? It is a
   small change but it is a new field on the wall→server path.
3. **Reusable profiles / Linked Displays** — the deliberate omission. Worth its
   own RFC once a household actually runs a wall of identical screens; the
   *copy-from* built here is the cheap stand-in until then.
4. **Whether the Adaptive template is editable at all** — it is the responsive
   `auto` layout, whose only knobs are `display_blocks` (order) and the density
   columns. Do those appear in the gallery flow as "Adaptive options", or does
   picking Adaptive just drop the household onto the existing Display-defaults
   screen? Leaning toward the latter — one door, not two.

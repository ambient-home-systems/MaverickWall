# Product

<!-- impeccable:product-schema 1 -->

> Distilled companion record for the **display** surface. `CLAUDE.md` at the repo
> root remains the deep product + engineering authority; this file holds the
> durable product truth Impeccable needs and defers to it for detail. When the
> two disagree, `git log`, `pnpm test`, the file tree, and `CLAUDE.md` win.

## Platform

web

## Users

- **Primary — the passive wall reader.** A household member reading the wall from
  ~1.5–3 m (5–10 ft) across a kitchen or hallway. They do not interact: there is
  no pointer (`cursor: none`) and the wall redraws itself on a ~15 s tick. Their
  job is to glance and know what the household does not already know — today, the
  week ahead, whose turn it is, whether anything needs attention.
- **Secondary — the installer at pairing.** The person who mounts a screen and
  pairs it. On the display surface they meet the code-entry / pairing screen the
  wall renders (typed on a TV remote or tablet, camera-less), plus the boot and
  offline messages. Ongoing configuration lives in the separate admin surface
  (`apps/server`), not here.

The only writes the wall itself performs are two deliberate, per-screen,
off-by-default affordances: ticking a chore and dismissing an alert. In both the
server, not the button, is the authority.

## Product Purpose

Maverick Wall is a **self-hosted family calendar wall display**. One household
runs one container on their own hardware; screens point at it and run unattended
for months. The display is the product's face: it draws the household's calendars
(and a small set of supporting widgets) on a fixed, hand-arranged canvas that a
family reads at a glance. **The calendar is the product** — everything else is
extra. Success is a screen that is always right, always legible from across the
room, and never dark. There is no cloud version and none is planned.

## Positioning

What a neighbouring product could not truthfully copy:

- **Self-hosted, single-container, no cloud, offline-first.** Everything ships in
  the image; the wall works with no internet beyond the calendar feeds
  themselves. No CDN, no web fonts, no analytics, no third-party origins in the
  bundle or HTML.
- **Legibility is a physical angle, not a pixel count.** Type derives from the
  panel's measured size and the reader's distance (arc-minutes), so one design is
  correct across a 3.7× range of panels — from a 7.5" e-paper tag to a 43"
  television — rather than tuned for one screen.
- **It never bricks the kitchen calendar.** Every failure degrades to reduced
  function with a clear on-screen message; never a blank screen, never a refusal
  to start.
- **Read-only, first-party, privacy-preserving by construction.** Home Assistant
  integration is read-only; the display receives resolved values, never entity
  ids, endpoints, or tokens.

## Operating Context

- **Where:** mounted screens in kitchens and hallways, read at a distance, for
  months without a keyboard or mouse. Two device classes:
  - **Browser walls** (tablets, televisions, kiosk WebViews): poll the manifest
    (~60 s), draw a free-form canvas, cache the last-good manifest in IndexedDB,
    and paint it before the first request so a screen returning from a power cut
    is instant.
  - **E-paper / e-ink panels** (e.g. ESPHome Wi-Fi panel pulling, OpenDisplay BLE
    tag pushed via Home Assistant): consume server-rendered 1-bit frames. Battery
    panels are a **glance class, not an alert class** — a sleeping panel cannot
    honour a takeover.
- **Canvas:** a fixed free-form arrangement of widgets, authored separately for
  portrait and landscape; what the household dragged is what is drawn, and
  nothing reflows. Widgets read their own box and choose a density form.
- **Content source of truth is upstream and untrusted:** ICS feeds and read-only
  Home Assistant. Event titles are strings a household does not control and are
  sanitised for legibility, not for taste.
- **Rhythm:** redraws on a ~15 s tick; e-paper favours partial refresh, which
  requires geometry that does not move between frames.
- **Install shapes:** plain `docker run`, `docker compose`, and the Home
  Assistant add-on (ingress in the sidebar; wall screens on the mapped port with
  a display token).

## Capabilities and Constraints

Durable, design-relevant facts (see `CLAUDE.md` for the full list and rationale):

- **Stack (fixed):** vanilla TypeScript, targeting **ES2019**, **no framework**
  and **no bundler** (plain `tsc`, `rootDir` pinned to the display's own `src`).
  Container queries are permitted; `:has()`, subgrid, `@layer`, top-level await,
  and `structuredClone` are not.
- **No third-party origins** in the bundle or HTML — no CDN, no web fonts, no
  analytics. Every face and asset is self-hosted from the image.
- **No emoji** in anything a screen renders; a first-party glyph vocabulary
  (skies, device classes) is drawn in code and used instead.
- **No shadows, no transitions, no animation** on any display surface. Separation
  is space, then a 1px rule, then a ground step.
- **Tabular figures everywhere** (`tabular-nums`): a figure that changes width
  changes a row's geometry, which forecloses e-ink partial refresh.
- **No scale-to-fit as a substitute for a density tier.** A section that does not
  fit gives up content, not points; widgets choose a form from their box.
- **All type derives from `--px-arcmin`** (panel size + read distance) with an
  ES2019 fallback; no absolute px legibility floor.
- **Manifest-driven:** the display draws whatever the server's manifest carries,
  offline from a stored copy when needed. Rendering decisions are computed in a
  DOM-free viewmodel so they can be tested without a browser.
- **Read-only:** the wall never controls anything; its two writes (chore tick,
  alert dismiss) are per-screen, off by default, and server-authoritative.

## Brand Commitments

- **Name:** Maverick Wall.
- **Mark:** a seven-column month grid with one cell lit amber — the product's real
  geometry, not a drawing of it. A five-column redraw is used below ~20 px (the
  favicon and the small sidebar icon).
- **Wordmark:** Oswald 700, outlined to paths at build time (bundled under SIL
  OFL 1.1); no font install required and no silent fallback.
- **Themes** are pure token sets with no logic differences — five ship:
  **Household** (warm daylight paper), **Blueprint** (light technical), **Panels**
  (dark modular dashboard — the default), **Almanac** (paper ledger, scheduled for
  daylight hours), and **Swiss** (near-black typographic ground). Each carries its
  own accent; the amber above is the *mark's* identity hue, not a universal wall
  accent (Panels' accent is a steel blue). Board/Slate/Glance are retired and
  resolve to Panels for any stored value. Custom themes are allowed via a
  name/token allowlist. (See `DESIGN.md` for the palettes.)
- **Voice:** errors and messages are written for someone standing in a kitchen,
  not a log reader — name the fix when a message can. Warnings and logs never
  contain event content or credentials.

## Evidence on Hand

- **Real data proven end to end:** Google Calendar and a real school-district ICS
  feed fetched through the SSRF guard, gzip-decoded, recurrence-expanded, stored
  encrypted, served as a manifest, and drawn.
- **Brand assets:** `docs/brand/` (marks, wordmark, build scripts). Design token
  directions live in `maverick-wall-design-directions.html` (in the project, not
  the repo).
- **Test suite** is the project's core discipline (thousands of tests; layout is
  verified by measuring the DOM / decoding frames, not by looking).
- **Absences future work must not fabricate:** there is no cloud service, no
  testimonials, customers, pricing, or licensing tiers to cite. E-paper output is
  built and measured (decoded framebuffers) but **not yet photographed on real
  hardware**, and no real household kitchen wall has been observed — state these
  as unproven rather than claiming them.

## Product Principles

1. **The calendar is the product.** The wall's job is the thing the household does
   not already know; the date and the clock never outcompete an event name.
2. **Never brick the kitchen calendar.** Every failure degrades to reduced
   function with a clear on-screen message — never blank, never a refusal to
   start.
3. **Legibility is an angle, not a pixel.** Every size on the wall derives from
   the panel's real size and the reader's distance; one design must be right on
   every panel.
4. **First-party and offline by default.** Nothing a screen renders is fetched
   from a third party; the wall keeps working with no internet beyond the feeds.
5. **The wall reads; it does not ask.** No pointer, minimal writes, the server as
   authority — the panel is a fixture in a house, not an app to operate.

## Accessibility & Inclusion

- **Distance-first legibility:** cap-height sized in arc-minutes at the reader's
  eye; a per-theme scaffold ink is lifted until it clears **4.5:1** against that
  theme's own background.
- **No motion:** physical panels cannot animate and the wall has no pointer, so
  motion is banned by construction (also correct under `prefers-reduced-motion`).
- **Stable geometry** for e-ink partial refresh (tabular figures; region
  rectangles that do not move between frames).
- **Daylight-aware theming:** a light theme (Almanac) is scheduled for daytime and
  a dark one (Board) for night, since the same hues do not separate at both a
  ten-foot glance and a 2 a.m. lamp.

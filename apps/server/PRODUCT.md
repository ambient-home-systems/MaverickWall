# Product

<!-- impeccable:product-schema 1 -->

> Distilled companion record for the **server** surface — the single process plus
> its server-rendered **admin UI** and **first-run wizard**. `CLAUDE.md` at the
> repo root remains the deep product + engineering authority; this file holds the
> durable product truth Impeccable needs. Companion to `apps/display/PRODUCT.md`,
> which covers the wall the household reads. When sources disagree, `git log`,
> `pnpm test`, the file tree, and `CLAUDE.md` win.

## Platform

web

## Users

- **Primary — the household administrator / installer.** One person (or a couple)
  in the household who sets the wall up and maintains it. They are not necessarily
  a sysadmin. They meet this surface twice-shaped: the **first-run wizard**
  (account, timezone, an optional first calendar, an optional location + person),
  then the ongoing **admin** (calendars, the walls / layout editor, weather,
  Home Assistant, the modules store, screens & pairing, chores, shifts, people,
  system / backup / diagnostics / updates). They configure briefly, then months
  apart, and are as likely to be on a 390 px phone as on a laptop.
- **Under the Home Assistant add-on** they reach the admin through the sidebar via
  ingress, already authenticated by Home Assistant.

This is the **control surface**, distinct from the display (the wall) that the
whole household reads. `[Inference to confirm: the admin/installer is the sole
primary user of this surface; the wider household are users of the display, not
the admin.]`

## Product Purpose

The server is the single container that turns feeds, screens, widgets, and
settings into a working wall. Its admin and wizard are the one place a household
does that: add and test calendar feeds, pair screens, arrange each wall's
free-form canvas, browse and install modules, configure weather and read-only
Home Assistant, manage chores / shifts / people, and back up or diagnose the box.
Success is a household that can stand this up once, safely, on whatever device is
to hand — and come back months later and still find their way.

## Positioning

What a neighbouring product could not truthfully copy:

- **Server-rendered, no framework, no build step for the admin.** Vanilla TS plus
  a small hash router; the one client-side app is the drag-and-drop layout editor,
  whose live preview renders the *real display bundle* in a shadow root. There is
  no admin bundle that can fail to load, and the **wizard and sign-in are
  script-free by design** — the screens that must work before anything else does.
- **Secure defaults, no default credentials, exposed-badly assumed.** A bootstrap
  code gates the first sign-up; in-app rate limiting is keyed per real client IP;
  non-GET requests are origin-checked. The design premise is that someone will
  expose this box to the internet, badly.
- **Home Assistant add-on with ingress that trusts HA's own login** — pinned to
  the supervisor's socket source, never a forgeable header, over one shared port.
- **One container.** SQLite (WAL), forward-only Drizzle migrations behind a file
  lock, secrets encrypted at rest, backups trivial (database + key), staged
  restore. If it seems to need Redis, it does not.

## Operating Context

- **Two entry modes:** the **first-run wizard** (four steps, script-free, marked
  complete after the timezone so a failing feed can never strand setup) and the
  **ongoing admin** (server-rendered, hash-routed screens).
- **Reached three ways**, each with its own constraints: plain `docker run`
  (browsed by IP from the sofa — so trusted origins include the arrival address),
  `docker compose`, and the **HA add-on sidebar** (ingress: a per-session path
  prefix stripped and re-added, a single `<base>` deciding relative links, a
  cookie scoped to the prefix, HA session forwarded).
- **Phone and desktop are both first-class.** Below 900 px the nav is a
  script-free modal drawer; a skip link precedes it; forms carry dirty-state
  guards and `aria-live` "saved" confirmations; inputs are ≥16 px to avoid iOS
  zoom-on-focus.
- **The admin is where** feeds are added and tested with a real fetch, screens are
  paired by a typed code (camera-less), walls are arranged, modules are browsed
  from a curated in-repo store (with an Advanced escape hatch for hand-written
  recipe/service modules), weather and read-only HA are wired, chores are defined,
  shifts and people are managed, and the system is backed up, diagnosed, and
  updated.

## Capabilities and Constraints

Durable, design-relevant facts (see `CLAUDE.md` for full detail and rationale):

- **Stack (fixed):** TypeScript strict, Node LTS, Hono, SQLite via
  better-sqlite3 (WAL), Drizzle, Better Auth, in-process scheduler, local
  filesystem blobs, **Zod at every boundary (reject, do not coerce)**. The admin
  UI is **no framework** — vanilla TS + a small hash router; the layout editor is
  the one client-side app.
- **Admin design system is a real component layer.** Two hand-picked colour
  schemes (light/dark) in `design-tokens.ts`; a fixed component vocabulary —
  `pageHeader`, `section`, `card`, `listRow`, `dataTable`, `tag`, `emptyState`,
  `destructive` — in `components.ts`. **Spacing, radius, and font-size are tokens
  only**; raw literals fail the build. A new screen is built from a component or a
  new one is added (raised first), never hand-typed markup. Material Design 3 was
  adopted and then deliberately removed.
- **Motion is allowed here, unlike the display** — but only inside
  `prefers-reduced-motion: no-preference`. The admin is a settings screen someone
  is touching, where ~180 ms confirms a tap landed; the wall, with no pointer and
  a 15 s redraw, bans motion entirely.
- **Rule 3 still holds for served HTML:** no third-party origins. Icons are
  inlined (Lucide, ISC), fonts self-hosted, the QR encoder is first-party.
- **Separation without shadow** (a small allowance exists only for the two
  genuinely floating surfaces — a modal drawer and a widget sheet).
- **Read-only outward:** nothing here issues a control call to Home Assistant.

## Brand Commitments

- Shares the product identity in `apps/display/PRODUCT.md`: **Maverick Wall**, the
  seven-column month-grid mark (one cell lit amber), the Oswald 700 wordmark, amber
  accent. The mark and wordmark appear in the sidebar, the wizard, and the favicon.
- The **admin has its own two-scheme palette** (`design-tokens.ts`), distinct from
  the wall's display themes: the wall's themes are for a room read at distance, the
  admin's are for a lit screen under a pointer.
- **Voice:** copy and errors are written for someone standing in a kitchen, and
  name the fix when they can. The alerts disclaimer is one constant reused across
  the wizard, the alerts screen, and the README.

## Evidence on Hand

- **Proven on real hardware / real dependencies:** Better Auth sign-up / gate /
  sign-out against the live library; ingress auto-login on a real HA supervisor;
  the layout editor working through the sidebar under ingress; the mobile nav used
  on a real phone.
- Admin screens are driven in headless Chromium at 390 px and desktop widths;
  layout is verified by measuring the DOM, not by looking.
- **Absences future work must not fabricate:** no cloud service, no testimonials /
  customers / pricing / licensing tiers; some newer brand assets and the fixed
  pairing flow are proven against the app but **not yet on a real HA supervisor** —
  state these as unproven.

## Product Principles

1. **Configure once, briefly, months apart.** The admin must be legible and safe
   to a household member who is not a sysadmin, on whatever device they have.
2. **Never brick the wall from the admin.** A failed form must not lose typed work
   or blank a wall — echo-on-400, dirty-state guards, staged restore, secure but
   recoverable defaults.
3. **Secure by default; assume it is exposed badly.** No default credentials, a
   bootstrap gate, rate limiting, origin checks, HA trust from the socket source
   rather than a header.
4. **The server is the authority.** The wall reads a manifest; the admin writes
   the truth. One container.
5. **Read-only outward.** Home Assistant is read-only; the admin never gains
   control of a house.

## Accessibility & Inclusion

- **Phone-first admin:** a skip link before the nav, ≥48 px touch targets, 16 px
  inputs (no iOS zoom), a script-free modal drawer, and a visible focus ring on
  every control.
- **Token contrast is test-enforced** for both admin schemes; a role defined in
  one scheme and not the other fails the build.
- **Motion only within `prefers-reduced-motion: no-preference`.**
- **Script-free wizard and sign-in**, so a household that blocks script can still
  complete setup and sign in.

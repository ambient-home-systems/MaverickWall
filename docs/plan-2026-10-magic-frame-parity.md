# Plan: parity with Magic Frame

**Status: in progress.** RFC 018 (M6.0) is built, and so are the companion token, its Home Assistant to-do add, timers and messages, and refreshing walls and showing one wall's layout on the others (M1.1–M1.5, M2.1, M2.2, M2.3, M4.10 for wallpapers, M5.1–M5.11); everything else is planned. On 2026-10-05 the owner asked for a
competitive review of [Magic Frame](https://github.com/jeremiaa/magic-frame)
against Maverick Wall, then a deeper look at its custom widgets and its
backgrounds. This document is that review, the decisions taken on it, and the
work it implies, in the order it should be built. A shareable copy for comment
lives as a Claude Doc; **this file is the source of truth** (MD1).

Nothing here has been implemented. Magic Frame was read at `b7ff1d2`
(v1.5.5); Maverick Wall at `02386d6` (release 0.75.0). Both will drift.

**How to read an item.** Each has an ID (`M3.2`), what it is, its size, and the
rule or mechanism it has to respect. Sizes are relative: **S** is one focused
session, **M** is two or three, **L** is a phase of its own. Items marked **†**
follow the phases of RFC 018, the Rule 12 amendment accepted on 2026-10-05
(MD13); its phase 1, the boundary and its tests, comes first.

**Discipline.** The same bar as everything else in this repository
(`CLAUDE.md`, "Verification is the job"):

- Measure the computed value, never the class name.
- Check every new assertion by reverting its fix and watching it go red.
- Change a ratchet's baseline only in the same commit as a measured,
  explained change.
- Run `pnpm test`, which builds first.

The two density ratchets, `wall-density` and `browser-classic-proportions`,
must not move for a wall that has not opted into anything new.

---

## Contents

- [Summary](#summary)
- [Decisions taken on 2026-10-05](#decisions-taken-on-2026-10-05)
- [Where Maverick Wall already leads](#where-maverick-wall-already-leads)
- [Do not copy](#do-not-copy)
- [Part 1: feature parity](#part-1-feature-parity)
- [Part 2: custom widgets](#part-2-custom-widgets)
- [Part 3: backgrounds and glass](#part-3-backgrounds-and-glass)
- [Order of work](#order-of-work)
- [Questions, all decided](#questions-all-decided)
- [Considered, not planned](#considered-not-planned)
- [Appendix A: Magic Frame inventory](#appendix-a-magic-frame-inventory)
- [Appendix B: what was read](#appendix-b-what-was-read)

---

## Summary

Maverick Wall reaches parity with Magic Frame by adding three things it lacks:
**your own photos behind the wall, saves that reach every screen within a
second, and touch control of the house.** Everything else here is smaller.

Magic Frame (created April 2026, 489 stars, Polyform Noncommercial) is a
Next.js, Postgres and Caddy dashboard. It has 19 widget types on a 24×24 grid,
Socket.IO live sync, Immich and NAS photo wallpapers under frosted-glass cards,
and interactive Home Assistant control. Its views are public with no login, and
it has no test files at all.

It looks good mostly because of those three things. The third conflicted with
Hard Rule 12 directly, which is why it needed a rule change before it could be
planned: RFC 018, accepted on 2026-10-05 (MD13).

## Decisions taken on 2026-10-05

| ID | Question | Decision |
| --- | --- | --- |
| MD1 | Where the plan lives | This file is the source of truth; the Claude Doc is the shareable copy. |
| MD2 | Wall control vs Hard Rule 12 | Propose a **narrow amendment** ([RFC 018](rfc-018-wall-control.md)): toggles, dimming/colour/position, scene and script buttons, webhook buttons. Locks, alarms and garage, gate, door and window covers stay excluded. Accepted on 2026-10-05 (MD13). |
| MD3 | Custom widgets vs Hard Rule 3 | **Data only.** A much richer data contract now; a server-side sandbox whose output is still data is designed now (RFC 017) and built later. No code runs on the wall. |
| MD4 | Glass (Q4) | **Prototype, then decide.** Glass is built behind a flag with measured per-picture opacity; Q4 flips only if the prototype passes MQ1. |
| MD5 | Bundled images | Allowlist: museum CC0 art, US government public domain, CC BY 4.0 with credit, the owner's own photos. **No Unsplash, Pexels, Pixabay or AI-generated images.** |
| MD6 | Wallpaper size budget | Raise the size test's cap from 15 MB to about 25 MB, recorded as a decision. |
| MD7 | Timers and messages on the wall | A wall may dismiss them behind its own per-wall switch, off by default, with the server as the authority. |
| MD8 | Order of work | Push and remote control first, then photos and glass, then widgets, HA depth, custom widgets, admin. |
| MD9 | `CLAUDE.md` | Gets a short pointer paragraph naming this plan and its two open proposals. |
| MD10 | RFC 018 §5.2, the five items argued separately | Every recommendation accepted: media transport, `todo.add_item` from the companion API only, and fan speed are **in**; `input_boolean` helpers and thermostat setpoints are **out**. The RFC as a whole was accepted afterwards (MD13). |
| MD11 | RFC 018's remaining open questions, OQ6–OQ10 | Every proposed default accepted: press-and-hold of 600 ms for scenes, scripts and webhooks; 20 presses a minute per wall and one in flight per entity; 14 days of wall-action history, admin only; persistent-notification dismiss waits for a WebSocket client; a signed-in admin may test a control from the editor. RFC 018 had no open questions left, and was then accepted as a whole (MD13). |
| MD12 | The plan's open questions, MQ1, MQ2 and MQ4–MQ12 | Every proposed default accepted, as written in the questions table below. None is open. |
| MD13 | Accept RFC 018 | **Accepted.** Hard Rule 12 in `CLAUDE.md` now reads as RFC 018 §3.1. Nothing is built: phase 1 (the boundary and its tests) comes first, and until it lands the code still holds RFC 012's two-service allowlist. |

## Where Maverick Wall already leads

Keep all of these. Parity work must not trade any of them away.

| Area | Maverick Wall | Magic Frame |
| --- | --- | --- |
| Wall security | Paired display tokens; the wall only receives resolved values. | `/view/*`, `/api/ha/entities` (every entity), any camera snapshot, lists and Todoist are readable with no login. `/api/ha/action` has no session check. |
| Never brick | Last good manifest in IndexedDB, plus an offline shell. | If the photo source is down at load, the background goes black with no fallback. |
| Ticking things off at the wall | Chores and HA to-do lists, behind a per-wall switch. | Local lists are read-only on a kiosk and the tick silently reverts; their docs call it a defect. |
| Legibility | Type sized by read distance, density tiers, reflow stability. | One font-size dial per widget; auto-fit is their open issue #8. |
| Coverage | E-paper panels, NWS alerts with takeover, shift rotations, chores, hardened CalDAV. | None of these, apart from basic CalDAV. |
| Extensibility | Modules send data; the wall draws everything. | Uploaded JavaScript runs unsandboxed in every display. |
| Quality and ops | About 4,800 tests, one container, SQLite, signed images. | No tests, three containers, Postgres. |

## Do not copy

- **Public views and open HA routes.** Breaks Hard Rule 10.
- **Unsandboxed uploaded JavaScript.** Breaks Hard Rule 3, and a module opened
  in a browser signed into their editor can call `/api/admin/*` as an admin.
- **API keys stored in widget config.** Their `/api/layout/get` needs no login,
  so those keys are readable on the network.
- **Postgres plus three containers.** Breaks Hard Rule 8.
- **The "Unsplash" wallpaper source.** It actually sends search words to an
  external AI image generator (`image.pollinations.ai`).
- **Unlicensed bundled photos.** Their 20 wallpapers carry no source, credit or
  licence anywhere in the repository or the files.

---

## Part 1: feature parity

Forty-four items close the feature gap outside custom widgets and backgrounds,
which are Parts 2 and 3. Each names the rule it has to respect, because most of
Magic Frame's features exist in a form we cannot ship as it is.

### M1 — Live sync and remote control

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M1.1 | Connect the browser wall to the existing push hub (`net/push-hub.ts`), so a save reaches it in about a second instead of up to 60 s. **Built**: `apps/display/src/push.ts`, and every write nudges a tick 250 ms later. | M | The push carries no data: it tells the wall to poll, and the poll (ETag, 304) stays as the fallback. Auth is the display-token cookie on the upgrade. `ingress_stream` already carries it. |
| M1.2 | Remote refresh of every wall, or one wall. **Built**: from Walls, a wall's menu and the token; a wall acts on it at its next poll. | S | Admin action and token API (M2.3). A reload is safe because the wall draws its IndexedDB copy first. |
| M1.3 | Show one wall's layout on every wall, temporarily, with a way back. **Built**: 10 minutes unless told otherwise, two hours at most, ended early from Walls or the token, and by each wall's own clock at its time. | S | An override with an expiry (default 10 min), so no wall can be stuck on someone else's layout (rule 9). |
| M1.4 | Next-picture command for the background. **Built**, on the bundled wallpapers' rotation (M4.10): a wall's menu and `/companion/walls/next-picture`. Photo sources will rotate through the same steps. | S | Restarts that picture's countdown. Depends on M3.6. |
| M1.5 | Walls reload themselves once after a server update. **Built**: the page carries the release that served it, every answer the one answering; a mismatch reloads past the shell cache, staggered, at most every 10 min. | S | A version header on every `/d/manifest` answer; reload at most once per 10 min, staggered 0–30 s. |

### M2 — Inbound API for phones and automations

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M2.1 | A per-account companion token: show, copy, rotate. **Built**: System › Phone and automations; `mwc_` tokens, sealed beside their hash. | S | Sealed at rest; redacted in logs and the diagnostics export (rule 6). `Authorization: Bearer` preferred; `?key=` accepted for iOS Shortcuts, with a warning that addresses end up in logs. Rate-limited. |
| M2.2 | Endpoints: start and end timers, post and clear messages, add to a Todoist list or a Home Assistant to-do list. **Built**: the to-do add (`POST /companion/todo/add`) to a Home Assistant list or, since M5.7, a Todoist project, and timers and messages (`/companion/timers`, `/companion/timers/end`, `/companion/messages`, `/companion/messages/clear`). | M | Zod at every boundary. Adding to an HA list is `todo.add_item`, which RFC 018 permits from this API only (MD10), so that half waits on RFC 018's phase 1, which adds its allowlist row; Todoist works without it. |
| M2.3 | Display-control endpoints with the token: refresh, show a layout, next picture. **Built but next picture**, which waits on photo slideshows (M3.6): `/companion/walls/refresh`, `/companion/walls/show`, `/companion/walls/show/end`. | S | The same handlers as M1.2–M1.4. |
| M2.4 | Documented recipes: iOS Shortcuts and Home Assistant `rest_command`. | S | In the docs site (M9.1). |

### M5 — New widgets and data sources

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M5.1 | **Timers**: started from a phone, an automation or the admin; countdown, "done" state. **Built**: a Timers widget, minutes then a phase-locked seconds reel, Done for 30 minutes; Timers and messages in the admin. | M | The end instant travels in the manifest and the wall computes the rest, so it works offline. Dismiss on the wall behind a per-wall switch (MD7). Seconds versus the 15 s rebuild: MQ4. |
| M5.2 | **Messages**: short notes from a phone that expire on their own. **Built**: a Messages widget; an hour unless told otherwise, a day at most. | S | The same per-wall dismiss switch as timers. Drawn with `textContent`, capped and sanitised. |
| M5.3 | **QR code**: guest Wi-Fi, a link or text. **Built**: on the wall and on a panel, black on white, read back by a decoder in every test; the encoder's versions 7–10 were unreadable until this found them. Dot and eye styles, gradients and a centre icon are not built. | S | Reuses `http/qr.ts`; verified by decoding, never by looking. One bit is a natural fit, so the panel draws it too. |
| M5.4 | **Text / heading** widget with optional divider and glyph. **Built**: a heading and a second line, three sizes that are the wall's own roles (large is the clock's cap), top/middle/bottom, a glyph from the drawn set, a rule and capitals, on the wall and on a panel. Size is a widget setting rather than the style lane's, which still has none. | S | Style lane for size and face; household text in the device font (Q9). |
| M5.5 | **RSS headlines**, list or one at a time, with a QR to read on a phone. **Built**: RSS 2.0, RSS 1.0 and Atom through the CalDAV reader, now shared (`xml/read.ts`), not a dependency; a News screen and widget, on the wall and on a panel. Up to eight feeds. No summaries or pictures. | M | Fetched by the server through the SSRF-guarded fetcher; nothing on the wall is a link. Needs an XML parser in `apps/server`. |
| M5.6 | **Environment** widget: AQI, PM2.5/PM10, ozone, NO₂, pollen, UV, solar, plus HA sensors. **Built**: in the air-quality request the Weather switch already consents to, sunlight from the forecast; pollen absent outside Europe and "None" inside it on a clear day; tiles on the wall, lines on a panel. | M | Extends the existing air-quality fetch, which stays off until switched on (Q5). Pollen data exists for Europe only. |
| M5.7 | **Todoist** as a list source. **Built**: Todoist API v1, five calls; projects join the to-do store as `todoist:<project>`, so the widget, the tick and the companion add are the Home Assistant lists' own; open items only, top level only. | M | Token sealed with the keyring. Wall ticks behind the same switch as HA lists. |
| M5.8 | **Weather providers**: HA weather entity, DWD ICON, OpenWeatherMap, Pirate Weather, Weather Underground. **Built**: all five, chosen on the Weather screen. DWD ICON is Open-Meteo's `dwd-icon` endpoint through the same reader. A Home Assistant entity is read with `weather.get_forecasts` through RFC 018's row, and needs no location. The three keys are sealed per provider (`weather_keys`). Pirate Weather's key goes in a header. OpenWeatherMap's and Weather Underground's can only go in the address, which exists for one request and is never stored or shown. | M | The HA entity needs `weather.get_forecasts`, a service `HA_SERVICES` does not yet hold: RFC 018 permits it as a read, in its phase 1. Keys sealed, never in a URL. |
| M5.9 | **Animated weather icon sets** (Meteocons is MIT). **Built**: Meteocons' static set, in Colour and Outline, as bundled `<img>` artwork. Each picture moves as a whole through `motion.ts`: a sun turns, cloud sways, a night sky is still. A clear night shows the moon's phase. The animated files' SMIL is never shipped. The 3D set and a separate solid set are not built. | M | Bundled artwork only. Animation goes through `motion.ts` and D7's rules, never SVG's own: MQ7. |
| M5.10 | **Mini weather line on the clock.** **Built**: `showWeather` on a clock draws a picture and the temperature under every look, with humidity, wind and UV when ticked and the forecast's picture set (`icons`). With no reading for now it shows today's high and low. A panel's clock leaves the line to the forecast widget. | S | Values from the existing forecast panel. |
| M5.11 | **Google and Microsoft 365 calendar sign-in.** **Built**: both sign in with the household's own app, read-only. Microsoft uses a code at microsoft.com/devicelogin and works on any install. Google uses its consent page, offered only where the wall has a public https address; elsewhere the page says why and points to the iCal address and Home Assistant (MQ12). A revoked sign-in is said on the account and held for a week, and Sign in again lifts it. | L | The household's own OAuth app; read-only scopes; tokens sealed. Google refuses private redirect addresses, so this needs a public HTTPS name: MQ12. A failed refresh says so, unlike Magic Frame's silent empty feed. |
| M5.12 | **Image widget slideshow** from the same sources as backgrounds. | S | Depends on Part 3's photo sources. |

### M6 — Home Assistant depth

The read-only items can start now. Items marked † follow RFC 018's phases (accepted 2026-10-05, MD13): phase 1, the boundary, comes first.

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M6.0 | **RFC 018**: the narrow Rule 12 amendment, accepted on 2026-10-05 (MD13): [`rfc-018-wall-control.md`](rfc-018-wall-control.md). Phases 1–3 are built: the table and its door; toggles for lights, switches and fans behind the three switches, with a fortnight's history on the Readings screen; and brightness, colour, white, fan speed and a blind's movement from a panel over the wall. Phase 4 is built too: scenes and scripts run by press-and-hold, a scene refused if it sets anything on the never-list, and a script allowed with the claims qualified (RFC 018 §3.3). Phase 5 is built too: webhook buttons, set on a new Buttons screen and drawn by a new Buttons widget. Phase 6 is built too: a media player's play, pause, skip and volume from the panel. Every wall phase of RFC 018 is done, and `todo.add_item` runs from the companion API (M2.2). | M | Scope: toggles for lights, switches and fans; brightness, colour, position and fan speed; media transport; scene and script buttons; webhook buttons; `todo.add_item` from the companion API only (MD10); the read-only services weather forecasts and notification listing need. Excluded outright: locks, alarms, and covers whose device class is garage, gate, door, window, damper or unset. Three opt-ins (wall, entity, widget), handles never entity ids, `HA_SERVICES` a frozen table held by `ha-write-boundary.test.ts`. |
| M6.1 | **Camera snapshot tile.** | M | RFC 007's opaque handle and frame hub. Must survive the 15 s rebuild without reconnecting. |
| M6.2 | **Camera live stream** (MJPEG/WebRTC through HA or go2rtc). | L | RFC 007. |
| M6.3 | **Doorbell pop-up**: a camera covers the wall when an entity triggers, then returns. | M | Built as an interrupt action, so it shares dismissal, night hours and source scope with alerts. |
| M6.4 | **Show a widget while an entity has a state.** | M | Hidden is a substitution, never a moved rectangle (the reflow-stability contract). |
| M6.5 | **Pulse / auto-hide timer** for momentary triggers. | S | State kept per widget in `main.ts`, like the to-do sentence map. |
| M6.6 | **Stacked widgets with a swap button.** | M | A local tap, no server write. Survives the rebuild as model state. |
| M6.7 | **HA presses a button**: an entity shows or hides a group. | S | The same mechanism as M6.4. |
| M6.8 | **Status card**: washer, car charging; picture, details, progress, loud "finished". | M | Builds on the tile look (P5.3); picture via a proxied handle. |
| M6.9 | **Now-playing card**; playback controls only †. | M | Cover art proxied by the server. |
| M6.10 | **Sensor sparklines** from HA history. | M | A history read, not a service call. Fixed-height series, so no reflow. |
| M6.11 | **Notification tiles**: rule-based, plus HA persistent notifications; dismissing one in HA is †. | M | Rule-based tiles reuse the interrupt matcher. |
| M6.12 | **Wall control** †: whatever RFC 018 accepts. | L | Rate-limited, logged without entity names, never offered on e-paper. |
| M6.13 | **Webhook button** †: a wall button that POSTs to a URL. | S | Through the SSRF-guarded fetcher; targets set in the admin, never typed on the wall: MQ9. |

### M8 — Admin, editor and layout safety

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M8.1 | **Multiple users with Admin and View-only roles.** | M | What View-only may do is MQ5; who an ingress visitor signs in as with several accounts is MQ6. |
| M8.2 | **TOTP 2FA** with recovery codes. | M | Better Auth's two-factor plugin; a generated migration; recovery codes hashed. |
| M8.3 | **Lockout panel**: recent sign-in attempts, release a lock. | S | Built on the existing in-app rate limiting; addresses only, no credentials. |
| M8.4 | **Snapshot before every save**, with one-click restore. | M | Keep the last N per wall; a restore snapshots the current state first. |
| M8.5 | **Export and import layouts** as JSON. | M | No credentials in the file; Zod on import; unknown widget types refused, not coerced. |
| M8.6 | **Duplicate a wall**: canvases, named layouts, schedule, background, settings. | S | A new wall needs its own pairing. |
| M8.7 | **Light/dark by the sun or an HA entity**, with the clock as fallback. | S | A state read of `sun.sun` or the chosen entity. |
| M8.8 | **Connected-size chips** in the editor, previewing at each wall's real size. | S | Uses the viewport each wall already reports. |

### M9 — Documentation

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M9.1 | **A published docs site**, checked against the code in CI, plus `llms.txt`. | L | It is the one item still in `CLAUDE.md`'s "Not started" list. Magic Frame's 28-page wiki, checked in CI by `scripts/check-wiki.mjs`, is the model. |

---

## Part 2: custom widgets

Magic Frame's modules can draw anything because they are code; ours can draw
two things because they are data. We close the gap by making the data much
richer, and never by running uploaded code on the wall (MD3).

### How each works today

**Magic Frame.** Two uploaded files, `module.json` and `bundle.js`, live a
second later with no restart. The bundle is plain React and receives
`createElement`, five hooks, its `config`, `dashboardId` and the browser's
`fetch` (`src/lib/modules/runtime.tsx`). Settings are per widget, in six field
types: text, textarea, number, boolean, colour, URL. An error boundary and a
5 s registration timeout contain a broken module. Building one needs a checkout
of their source and `scripts/build-module.mjs` (esbuild). There is no store.

**Maverick Wall.** A service module answers `GET /panel` and optionally
`/signals`; a recipe is JSON that fetches one URL and pulls fields with dotted
paths and a fixed formatter list (`modules/external/recipe.ts`). Settings are
per installed module and free-text only. `readings`, `stat` and `tiles` all
draw as label/value rows since the type-hierarchy pass, plus `text`: two looks
in practice, at most 12 rows, 60-character strings
(`modules/external/panel-data.ts`, `renderGenericPanel`). The store has two
entries.

### Side by side

| | Magic Frame | Maverick Wall |
| --- | --- | --- |
| What it can draw | Anything | Rows or a paragraph |
| Touch | Yes | No |
| Settings | Per widget, 6 field types | Per install, free text |
| Two widgets, two settings | Yes | Needs two installs |
| Data reach | What the browser can fetch and CORS allows | Anything the server reaches, SSRF-guarded, no CORS limit |
| API keys | Stored in widget config, readable on the LAN via `/api/layout/get` | Sealed on the server, sent only in a header |
| No-code authoring | No; needs a checkout and esbuild | Recipes are JSON |
| Can raise an alert | No | Yes, opt-in, scoped to its own rule |
| Offline | No | Yes, in the cached manifest |
| E-paper | Not applicable | Draws on panels |
| Theme and legibility rules | Font and colour only | All of them |
| Editor preview | None for modules | The wall's own renderer |
| Store | None | Curated, 2 entries |

The cost of Magic Frame's freedom: its docs say a module "runs with everything
your browser has", and the bundle is served from the app's own origin. Open a
view in a browser that is signed into the editor and a module can call
`/api/admin/*` as an admin: create users, rewrite the Caddy configuration,
upload more modules.

### M7 — Plan

| ID | Item | Size | Detail |
| --- | --- | --- | --- |
| M7.1 | **Fix the stale module docs.** | S | `docs/building-a-module.md` still advertises `stat` and `tiles` as distinct looks and emoji `icon`s; the wall draws all three as rows and drops `icon` (`panel-data.ts`). |
| M7.2 | **Contract 2: rows with a tone.** | M | `active` / `alert` / `idle` per row, drawn like the HA tiles (P5.3). |
| M7.3 | **Contract 2: progress and gauge.** | M | Bars, rings and one gauge; a gauge is capped against the event role like the clock (D1). |
| M7.4 | **Contract 2: series and table.** | M | Sparklines from a number series; a small table with fixed columns. |
| M7.5 | **Contract 2: image, QR, countdown, timeline.** | L | Images fetched by the server, type-sniffed and served by handle like media; QR through `qr.ts`; a countdown the wall computes from an instant; a schedule or timeline. |
| M7.6 | **Per-widget settings** with real controls: dropdown, number, switch, HA reading picker. | M | One install serves many widgets; polls are de-duplicated by resolved URL. |
| M7.7 | **Recipes: several fetches, plus filter, sort and limit** on arrays. | M | Still refused at parse if it looks like an expression. |
| M7.8 | **Recipes: lookup tables and more formatters** (number, duration, local time, plurals). | S | A lookup maps a value to a tone, e.g. `on → active`. |
| M7.9 | **Recipes: RSS/Atom/XML and HA states as sources.** | M | HA states through our client, values only. |
| M7.10 | **Tooling**: a test-a-recipe preview with sample data, a `diagnose-module` CLI, a scaffold template and a fixture test command. | M | The preview uses the wall's renderer. |
| M7.11 | **Seed the store** with 10–15 recipes: bins, fuel, trains, pollen, tides, launches and similar. | M | One file per entry under `apps/server/src/catalog/`, as today. |
| M7.12 | **RFC 017: sandboxed module code**, written in this PR and built later. | L | [`rfc-017-sandboxed-module-code.md`](rfc-017-sandboxed-module-code.md). |

Every new shape needs density tiers, an e-paper drawing and entries in the
panel's honours tables (`epaper/honours.ts`, proved by `epaper-ink.test.ts`). A
`contract: 1` body must keep drawing exactly as it does now.

What stays out of reach: interactive modules, such as the Music Assistant
browser in Magic Frame's issue #57. RFC 018 does not change that: its controls
belong to first-party widgets, and a module still sends data only.

---

## Part 3: backgrounds and glass

Magic Frame looks better because its photos are vivid and its cards are frosted
glass; ours are dimmed drawings under a near-opaque ground. The fix is real,
licensed photos plus a Glass ground whose opacity is measured for each picture,
so the picture no longer has to be dimmed to keep text readable.

### What Magic Frame ships

- **20 bundled photos** (`public/wallpapers/mf-01.jpg` … `mf-20.jpg`),
  909×1920 portrait JPEGs, 9.6 MB in all: idealised landscapes, auroras, sea
  cliffs. No licence, credit or source exists for them in the repository, its
  history or the files' own metadata, and they look AI-generated. We neither
  copy nor imitate them.
- **The glass recipe** (`src/lib/ui/glass.ts`): fill black (or white) at 40%,
  `backdrop-filter: blur(12px)`, a 1px edge at 10% white, 1.5rem corners, and
  a black text shadow at 80%.
- **Darkening layers over the photo** (`src/components/WallpaperEngine.tsx`): a
  top gradient at 30%, a bottom gradient at 80%, and a 30% vignette.
- **Rotation** every 45 s, with a crossfade or a slow zoom.

### Why ours look dull

All 26 of our wallpapers are drawn by `scripts/wallpapers/generate.mjs`. The
contrast gate for the Soft ground (`--panel` at 0.86,
`browser-wallpaper-contrast.test.ts`) holds a dark picture's brightest block
under about sRGB 150 on Panels, so every picture was made dark to pass it. And
Classic tiles almost the whole canvas, so the picture reads as a texture under
the widgets rather than a picture between them.

### M3 — Photo sources and presentation

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M3.1 | **Uploaded photo albums** in our own media store. | M | Type sniffed from bytes, SVG refused (`api/media.ts`), HEIC named and refused with a sentence. Resizing is MQ2. |
| M3.2 | **Immich**: albums, people, favourites, memories. | M | One connection, key sealed with the keyring; previews fetched through the SSRF-guarded fetcher with the LAN opt-in; the wall gets handles behind the display token, never a URL. |
| M3.3 | **WebDAV / NAS folder.** | M | Credentials sealed; reuses the CalDAV multistatus parser (`caldav/multistatus.ts`); HEIC and RAW counted and named. |
| M3.4 | **Album art while music plays.** | M | A state read of the chosen `media_player`; artwork proxied by handle. |
| M3.5 | **Fit modes, including blur-fill**, for portrait photos on landscape walls. | S | Blur-fill is `filter: blur` on a copy of the picture, a different cost from Q4's `backdrop-filter`; prefer a pre-blurred copy if MQ2 ends with a resizer. |
| M3.6 | **Crossfade and slow zoom** between pictures. | M | `opacity` and `transform` only, phase-locked to the wall clock, inside reduced motion and the wall's Motion switch (D7, `motion.test.ts`). The next picture is decoded before the swap. The photo layer must survive the 15 s rebuild: MQ8. No slow zoom behind Glass. |
| M3.7 | **Portrait pairing and split view.** | M | Orientation from Immich metadata, or from the JPEG header we already read when sniffing. |
| M3.8 | **Never go black.** | S | Where Magic Frame shows black, keep the last playlist and fall back to a bundled wallpaper, and the admin says why (rule 9). |

An e-paper panel ignores photos (MQ11).

### M4 — Bundled backgrounds and glass

| ID | Item | Size | What it must respect |
| --- | --- | --- | --- |
| M4.1 | **Glass prototype**, behind a flag (MD4). | M | New theme tokens `--glass-fill` (pre-mixed rgba, since `color-mix()` is out under rule 2), `--glass-blur`, `--glass-saturate`, `--glass-edge`. Wrapped in `@supports (backdrop-filter: blur(1px))` with the `-webkit-` form, falling back to Soft. Off on e-ink presets; never on a panel. |
| M4.2 | **Measured glass opacity per picture** (`glassAlpha`). | M | Blur each raster at the glass radius, then solve for the lowest opacity that keeps `--ink` and `--ink-scaffold` at 4.5:1 against its brightest and darkest blocks. Stored in the catalogue, held by the browser contrast test. Household photos are measured on the wall at load: MQ10. |
| M4.3 | **Glass decision gate.** | S | Measure tick cost against Soft at 6× CPU throttling, as S22 did; flip Q4 in `CLAUDE.md` and `apps/display/DESIGN.md` in its own PR only if it passes MQ1. |
| M4.4 | **Vivid gradients**: regenerate our gradient category as iOS-style mesh gradients. | M | Only after M4.3 passes, because their contrast is carried by `glassAlpha` rather than by dimming. |
| M4.5 | **A bundled photo set**: 16–20 photos and paintings. | L | From the MD5 allowlist only. Each catalogue entry records source URL, author, licence, retrieval date and sha256; `LICENSES.md` and `NOTICE` are generated from it; a test fails on a file with no entry or a licence off the allowlist. A focal point per orientation. |
| M4.6 | **Raise the size budget to about 25 MB** (MD6). | S | A recorded change to `wallpapers.test.ts`; three sizes kept (320/1600/2880). |
| M4.7 | **Darken-picture setting**: none / light / strong gradient and vignette. | S | Gradients are allowed (D2); counted in the contrast gate for text with no ground. |
| M4.8 | **Text-shadow token** per theme, for text placed straight on a photo. | S | A token, never a literal, like `--shadow-card` (D8). |
| M4.9 | **Photo-frame template**: clock, weather and a short agenda as floating cards with the picture around them. | S | Keeps the wall's theme, as Classic does. |
| M4.10 | **Collection rotation**: rotate a category every few minutes, hourly or daily. **Built for the bundled wallpapers**: a category of one tone, or all of it, every 5 or 15 minutes, hourly or daily at the wall's midnight; a plain swap, the crossfade being M3.6's. | M | The same transition and fallback as M3.6 and M3.8. |
| M4.11 | **Gutter suggestion**: when a photo is chosen, suggest the airier gutter rungs 5–6. | S | A hint only; the editor never changes a wall by itself. |
| M4.12 | **Edge-to-edge mosaic with floating cards.** | M | Gutter 0 and square corners exist already; a floating card keeps its radius and shadow token over the mosaic. |

### Image sources for the bundle (MD5)

| Source | Licence, as the source states it | Good for |
| --- | --- | --- |
| [The Met Open Access](https://www.metmuseum.org/hubs/open-access) | CC0 for images of public-domain artworks | Painted landscapes; Hiroshige and Hokusai woodblock prints |
| [Art Institute of Chicago](https://api.artic.edu/docs/) | Use only works tagged public domain; their data is CC0 | Monet and Impressionist landscapes |
| [National Gallery of Art](https://www.nga.gov/artworks/free-images-and-open-access) | Public-domain images "free of charge for any use, whether commercial or non-commercial" | Hudson River School skies |
| [Rijksmuseum](https://data.rijksmuseum.nl/policy) | Public domain or CC0, as marked per item | Dutch skies and seascapes |
| [Smithsonian Open Access](https://www.si.edu/openaccess/faq) | CC0 | Nature photography |
| [NASA](https://www.nasa.gov/nasa-brand-center/images-and-media/) | Generally not subject to US copyright; logos and third-party items excepted | Earth from orbit, auroras |
| [National Park Service](https://www.nps.gov/aboutus/disclaimer.htm) (also USGS, NOAA) | NPS-made material generally public domain; not all of it | Parks, coasts, weather |
| [ESA/Hubble](https://esahubble.org/copyright/), ESA/Webb | CC BY 4.0, with visible credit | Nebulae and deep space; credit in `NOTICE` |
| Wikimedia Commons, via [Openverse](https://openverse.org) | Per file: CC0, public domain or CC BY 4.0 only | Anything; verify each file |
| The owner's own photos | Project licence | The cleanest option |

Excluded: Unsplash, Pexels and Pixabay, whose own licences restrict
redistribution, and AI-generated images, whose copyright status is unclear.
Every source above says "generally" or "as marked", which is why M4.5 records
the licence per file rather than per source. Painted landscapes are the
distinctive choice: they look like a picture on a wall in a way stock
photography does not, and suit Almanac and Household.

These pages were read on 2026-10-05. The Art Institute's own open-access page
refused automated access, so its row rests on its API documentation.

---

## Order of work

Push and remote control ship first, because they are small and every later
feature benefits from them (MD8). Two gates hold work back.

1. **M0 — Plan and RFCs** (this PR): this plan, RFC 017, the `CLAUDE.md`
   pointer, and RFC 018 (accepted 2026-10-05, MD13).
2. **M1 and M2 — Push and API**: the wall on the push hub, remote commands,
   the companion token and its endpoints.
3. **M3 and M4 — Photos and glass**: photo sources and presentation, the Glass
   prototype, the bundled photo set.
   - **Gate: Q4 flips only if the Glass prototype passes MQ1.** M4.4 (vivid
     gradients) and Glass as a shipped ground wait on it.
4. **M5 — New widgets and data sources.**
5. **M6 — Home Assistant depth.** The read-only items start without waiting.
   - **Gate passed: RFC 018 was accepted on 2026-10-05 (MD13).** The † items
     follow its phases, phase 1 (the boundary and its tests) first.
6. **M7 — Custom widgets**: contract 2, per-widget settings, richer recipes,
   tooling, the store. The RFC 017 sandbox is built after this, if at all.
7. **M8 — Admin, editor and layout safety.**
8. **M9 — The docs site.**

Phases run in order, but the items inside a phase can ship one at a time, each
with its own measurement and mutation check, as the September plan's sessions
did.

---

## Questions, all decided

All twelve are decided. MQ3 was settled with RFC 018 (MD10); the owner accepted
the proposed default for each of the other eleven on 2026-10-05 (MD12).

| ID | Question | Decision |
| --- | --- | --- |
| MQ1 | What must the Glass prototype measure to flip Q4? | **Decided (MD12):** Tick main-thread time within 20% of Soft at 6× CPU throttling (S22 measured 645–750 ms throttled for Soft); no new long task over 50 ms; every shipped picture holds 4.5:1 under its `glassAlpha`. |
| MQ2 | How are uploaded photos resized, with no image library in the image today? | **Decided (MD12):** Resize in the admin browser with a canvas before upload; the server stores what it receives, capped in size. No native image dependency. |
| MQ3 | Adding to an HA shopping list from a phone needs `todo.add_item`, which Rule 12 excludes. | **Decided (MD10):** permitted by RFC 018 from the companion API only, never from a wall; until RFC 018's phase 1 lands the API adds to Todoist only. |
| MQ4 | A timer showing seconds cannot be right on a wall that redraws every 15 s. | **Decided (MD12):** Show minutes ("4 min left"); only the last minute counts seconds, through a phase-locked animation under D7. |
| MQ5 | What may a View-only account do? | **Decided (MD12):** Look at everything, change nothing. Stricter than Magic Frame, whose View-only can still edit layouts. |
| MQ6 | Which account does an HA sidebar visitor sign in as once there are several? | **Decided (MD12):** A setting naming one account for ingress; with none set, the normal sign-in page (fail closed, as `isTrustedIngress` already does). |
| MQ7 | Animated icon sets carry their own SVG animation, which bypasses `motion.test.ts`. | **Decided (MD12):** Ship them still, or re-animate them through `motion.ts`; never SVG's own animation. |
| MQ8 | The wall empties and rebuilds its tree every 15 s; a photo layer rebuilt each tick restarts its transition. | **Decided (MD12):** A persistent background layer outside the rebuilt root, phase-locked to the wall clock. |
| MQ9 | Where are webhook button targets set? | **Decided (MD12):** In the admin only, through the SSRF-guarded fetcher with the LAN opt-in. |
| MQ10 | Household photos (Immich, NAS, uploads) cannot have a pre-measured `glassAlpha`. | **Decided (MD12):** The wall measures each picture once at load on a small canvas; until it has, it uses Soft's opacity. |
| MQ11 | Should an e-paper panel draw photos, dithered? | **Decided (MD12):** No. Panels ignore photo backgrounds, and the editor says so. |
| MQ12 | Google OAuth needs a public HTTPS address, which most installs and the add-on do not have. | **Decided (MD12):** Document the limitation; point those households at the HA calendar route (RFC 013 B) or CalDAV. |

---

## Considered, not planned

Each was weighed on 2026-10-05 and left out. Reopen one by moving it into a
phase above.

| Item | Where it came from | Why not now |
| --- | --- | --- |
| Photo info bar (EXIF date, place, camera) | Magic Frame wallpapers | Not chosen. |
| MCP server for agents | Magic Frame v1.5.0 | Not chosen. |
| Tap a camera for full screen | Magic Frame camera | Not chosen; the doorbell pop-up covers the main case. |
| Lock and alarm control | Magic Frame HA entity | Excluded from RFC 018 outright. |
| `input_boolean` helpers and thermostat setpoints from a wall | RFC 018 §5.2 | Excluded (MD10): helpers often gate automations such as "alarm armed", and a setpoint left high costs money. |
| Local shopping list in our database | Magic Frame family widgets | Not chosen; HA lists and Todoist cover it. |
| OIDC sign-in | Magic Frame roadmap | Not chosen. |
| Copy a widget between walls | Magic Frame editor | Not chosen; duplicating a wall (M8.6) covers the bigger case. |
| More UI languages | Magic Frame (de, en, nb, nn) | Not chosen. |
| One-line installer and Helm chart | Magic Frame install | Not chosen. |
| Built-in auto-HTTPS and dynamic DNS | Magic Frame hosting | Not chosen; also strains Hard Rule 8. |
| Swipe or auto-cycle between layouts | Magic Frame roadmap | Not chosen; timed layouts (RFC 014 §5.2) already exist. |
| Unsplash, Pexels, Pixabay, AI-generated images | Common wallpaper sources | Excluded by MD5. |
| A browser iframe sandbox for module code | Part 2 option | Excluded by MD3. |
| Public views and open HA routes | Magic Frame security model | Breaks Hard Rule 10. |

---

## Appendix A: Magic Frame inventory

What Magic Frame v1.5.5 offers, from its wiki and code, so a later session can
check a detail without re-reading their documentation. The right-hand column
says where each lands in this plan.

### Widgets (19)

| Widget | What it offers | Here |
| --- | --- | --- |
| Clock | Time zone override; 12/24 h; date format; hide seconds; optional mini weather line (temperature, humidity, wind, UV, icon set). | We have the clock; mini weather is M5.10. |
| Weather | Six providers; four icon sets (Lucide, solid, Meteocons with moon phases and animation, a 3D set); current, hourly and daily; humidity, wind, UV, sun times, feels-like; atmospheric background. | Providers M5.8; icons M5.9; styles exist (P5.1). |
| Environment | AQI (EU or US scale), PM2.5, PM10, ozone, NO₂, pollen (hide zeros), UV, solar, wind; HA sensor tiles. | M5.6. |
| Calendar | List, agenda, month; iCal, Google, Microsoft, CalDAV, HA feeds; per-feed colour; cards or minimal design; week numbers; location and description lines; per-day limit auto/all/fixed; month title. | We lead on the month grid; Google/Microsoft is M5.11. |
| HA entity | Pills per entity; tap to toggle; brightness, colour and position pop-ups; `colorWhen` with numeric comparisons; hide-when and show-if rules; sparklines; live or polled. | Reads exist (tiles, P5.3); control is M6.12 †; sparklines M6.10. |
| Notifications | Rule-based tiles (trigger, message, icon, colour, duration, acknowledge entity, tap action); HA persistent notifications; timers, media, RSS and status cards docked in one stack. | M6.11. |
| Camera | HA or URL source; snapshot, MJPEG, WebRTC; caption; tap for full screen; full screen on an HA trigger. | M6.1–M6.3; tap-for-full-screen not planned. |
| Sensor | Large numbers; cards or two-column grid; unit and decimals override; icon colour; sparklines; polled every 15 s. | Covered by readings and tiles; sparklines M6.10. |
| Buttons | Up to four; toggle/show/hide widgets, HA toggle, HA service with JSON, webhook, reload; long-press action; shapes; HA "Auto" press. | M6.6, M6.7, M6.12 †, M6.13 †. |
| Image | Immich album slideshow in a tile; fit modes incl. blur; interval; corner radius. | M5.12 with M3. |
| Media Player | Row, stack and cover layouts chosen from the tile; several players with auto-follow; progress seek; volume; spinning circular cover; artwork as tile background; hide when idle. | M6.9 (controls †). |
| RSS Feed | Up to 8 feeds merged; list or rotate; source, date, summary, image; QR to read on a phone; no links by default. | M5.5. |
| QR Code | Wi-Fi, link or text; dot and eye styles; gradient; centre icon (raises error correction); transparent or solid background. | M5.3. |
| Status | Card while an entity is active; alert states that pulse and ring; picture from entity, URL or icon; up to four detail entities; progress bar or ring; tap entity. | M6.8. |
| Timer | Started over HTTP; countdown ring; "done" state; dismiss; max four shown. | M5.1. |
| Messages | Posted over HTTP; expiry; optional image URL; per-view target. | M5.2. |
| Shopping list | Local, HA or Todoist source; tick, clear done; light markdown. | HA lists exist; Todoist M5.7; local not planned. |
| To-dos | Same sources; per-person filter (local only); due dates, overdue outline, priority colour. | Chores and HA lists exist; Todoist M5.7. |
| Text | Heading and second line; alignment incl. vertical; icon; uppercase and tracking; divider. | M5.4. |

Every widget also has: a custom name; grid position and size; pixel nudge up to
±500 px; background opacity; floating card in edge-to-edge mode; hidden on load;
show-while-entity-state with auto-hide seconds; font size (fixed or
responsive), family (nine faces), weight, colour and a black text shadow.

### Backgrounds

Six sources (bundled, colour, a fixed URL, WebDAV, Immich, and a generated
"Unsplash" source); fit modes cover, contain, blur-fill, stretch, original;
image position top/centre/bottom; split view off/auto-pair/2/4; transitions
crossfade, Ken Burns, slide, cut, 0.3–4 s; Ken Burns intensity; interval 10 s
to 24 h; EXIF info bar with date, camera and place (Immich resolves place
names, WebDAV shows coordinates); a timer ring (measured by them at 37% of a
CPU core); top and bottom gradients, vignette, whole-background blur; album art
while a chosen player plays; a "next wallpaper" API.

### Editor and views

A 24×24 grid that stretches with the screen; drag and resize; overlapping
widgets with a layer list; three inspector tabs (Layout, Text and colour,
Content) and a live preview; copy and paste a widget between views; a phone
editor at `/editor/mobile` (a list, no grid); view settings for auto-refresh
(1–24 h), light/dark (fixed, by the sun, by time, by an HA entity) and
edge-to-edge with a tile gap; connected-display size chips; TV sync, its cancel,
and refresh; duplicate, rename and delete a view; a dashboard with mini layout
maps and status tiles.

### Integrations

Home Assistant (token, or the Supervisor when an add-on; one WebSocket, fanned
out over SSE; an allowlist on `/api/ha/action` since v1.4.0); Immich (global or
per view); Google and Microsoft OAuth with the household's own app; CalDAV;
OpenWeatherMap; Weather Underground and Pirate Weather (keys from the
environment only); Todoist (token); RSS.

### Administration and operations

Admin and View-only accounts; TOTP 2FA with ten recovery codes; brute-force
lockout per address and per account with a release panel; a session status
panel; a companion token per account; layout export and import; 20 automatic
snapshots across all views; an update banner; displays reload after an update;
a schema-downgrade guard; languages de, en, nb, nn; installer script, Docker
Compose, Kubernetes with Helm, an HA add-on; built-in Caddy with Let's Encrypt
(HTTP-01 or DNS-01 with ten providers) and dynamic DNS; a System page; a
28-page wiki checked in CI and `llms.txt`; an MCP server with 16 tools.

---

## Appendix B: what was read

- Magic Frame at `b7ff1d2` (v1.5.5): `README.md`, `ROADMAP.md`, `llms.txt`,
  all of `llms-full.txt` (the 28 wiki pages), `src/lib/modules/runtime.tsx`,
  `src/lib/ui/glass.ts`, `src/lib/mcp/server.ts`, the `src/app/api` route tree,
  `public/wallpapers/` (dimensions, metadata, history), and its open issues.
- Maverick Wall at `02386d6`: `CLAUDE.md`, `docs/plan-2026-09-household-review.md`,
  `docs/building-a-module.md`, `docs/rfc-007-camera-feeds.md`,
  `apps/display/DESIGN.md`, `modules/external/panel-data.ts`,
  `modules/homeassistant/client.ts` (`HA_SERVICES`), `api/manifest.ts`
  (`WIDGET_TYPES`), `renderGenericPanel` and `renderImageWidget` in
  `apps/display/src/render.ts`, `epaper/honours.ts`, and the wallpaper
  catalogue and assets.
- The licence pages linked in Part 3.

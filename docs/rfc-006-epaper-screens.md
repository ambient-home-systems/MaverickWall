# RFC 006 — eInk (e-paper) screens

Status: **phase 1 built (in code, tested); unproven on hardware** · Owner: — ·
First drafted 2026-08-13 · Builds on the display token / `screens` model and
RFC 001 (modules)

> **Update — phase 1 is implemented.** The B/W PNG + ESPHome path below is built
> and tested: migration `0029` (additive columns on `screens`), a pure 1-bit
> framebuffer + `node:zlib` PNG encoder, an embedded font, Bayer dither, the
> eInk viewmodel over the server manifest, a landscape/portrait renderer, the
> `/d/epaper/:token.{png,bin}` endpoint with the input-derived ETag and `304`,
> and the **Walls › eInk Displays** admin page with both consumption recipes.
> `apps/server/src/epaper/` holds the renderer; `apps/server/test/epaper-*.test.ts`
> drives it end to end through the real app. **What is not done is the
> verification bar below** — nothing has been pushed to a real Seeed 7.5" or a
> real OpenDisplay tag yet, which by this project's history is where the faults
> that matter surface.

## Summary

Support low-power **e-paper** panels as a wall screen kind — a Seeed 7.5"
(ESP32) on the bench as the first target — without adding a browser, a BLE
stack, or any new coupling to the container.

The whole design is one move: **the server renders a finished frame; the device
is dumb.** Everything else falls out of that.

- A new endpoint, `/d/epaper/<token>.png`, renders the calendar for the panel
  paired to that token and serves it as an ordinary image, gated by the display
  token exactly as `/d/manifest` is gated today.
- Two documented ways to *consume* it, both of which leave the server a passive
  image source: an **ESPHome wifi panel that pulls** the URL, and an
  **OpenDisplay BLE tag that Home Assistant pushes** to. Maverick never speaks
  BLE and never calls Home Assistant — rule 8 and rule 12 stay intact.
- An **eInk theme**: the wall's design language re-expressed for 1–3 colours,
  where meaning is carried by shape, weight and pattern rather than hue.
- One admin surface: a **Walls** nav header with a single option, **eInk
  Displays**.

Nothing here is a cloud feature, and nothing here executes third-party code on
the wall. It is the existing "manifest is data, the renderer is separate" seam
pointed at a device that cannot run the renderer, so the server runs it instead.

## Why this is a new client kind, not a down-rezzed wall

`apps/display` is a browser bundle. An ESP32 is ~500KB of RAM with no DOM and no
JavaScript engine — it cannot run `render.ts`. So an e-paper screen is not the
wall made smaller; it is a **second backend for the same viewmodel**. The
renderer is already split the right way for this — `viewmodel.ts` does the
thinking with no DOM, `render.ts` only builds nodes — so the e-paper path is a
new emitter behind the same viewmodel that produces a packed framebuffer instead
of HTML. The "what to show" logic (the product) stays in one place; only the
rasterizer is new.

## The two consumers, and why the server stays passive for both

There are two device ecosystems worth serving, and the important property is
that **the same endpoint serves both, and Maverick initiates nothing** in either
case.

### ESPHome wifi panel — device pulls

The device is an ESPHome node (stock `online_image` + `display` + `deep_sleep`).
It wakes on a timer, does an HTTP `GET` of the URL, blits the image, and sleeps.
Maverick is a passive HTTP server; the ESP32 reaches out. This is the same
inversion the browser wall uses (the client pulls a manifest), so it needs no
new trust model — just the display token in the URL.

Because the ESP32 is dumb, **this path needs the full rasterizer**: a
panel-ready, colour-reduced, bit-packed frame.

### OpenDisplay BLE tag — Home Assistant pushes

[OpenDisplay](https://opendisplay.org/) (the open successor to OpenEPaperLink)
is a **BLE push** protocol: a sender pushes a rendered image *to* the tag over
Bluetooth; the tag cannot fetch for itself. There is a **core Home Assistant
integration** (`opendisplay.upload_image`) that does the BLE and the
panel-specific image work.

The wrong shape is Maverick pushing to the tag itself — that means either a BLE
central inside the container (fights rule 8; needs a Bluetooth adapter, a native
BLE lib, host HCI access) or Maverick calling a Home Assistant service (breaks
**rule 12** — the read-only property whose whole point is that a compromised
wall's blast radius is "somebody saw my indoor temperature"). We do neither.

The right shape is **Home Assistant initiates, Maverick stays passive**: a
household-authored HA automation fetches Maverick's PNG and hands it to
`opendisplay.upload_image`. Maverick never calls out; HA reaches in for a plain
image, the same relationship the browser wall has. See
[Appendix B](#appendix-b--the-opendisplay-recipe-core-integration) for the
concrete recipe and the decision to standardise on the **core** integration (not
the HACS `drawcustom` variant).

Because the OpenDisplay integration is **device-aware** — it knows the tag's
size and colours from BLE discovery and applies fit, rotation, dither and
palette itself — **this path needs *less* of the rasterizer**: Maverick serves a
clean, high-contrast, un-dithered eInk-themed PNG and the integration finishes
it for whatever tag it is aimed at.

### One endpoint, three levels of finish

| Consumer | What Maverick serves |
|---|---|
| Browser wall (today) | JSON manifest |
| ESPHome wifi panel | 1-bit packed frame — needs the full rasterizer |
| OpenDisplay tag via HA | plain eInk-themed PNG — the integration finishes it |

## The endpoint

Modelled directly on `/d/manifest` in `apps/server/src/http/app.ts`, which
already does conditional GET, `304`, a stable `ETag`, and token gating via
`requireScreen`.

```
GET /d/epaper/:file            # :file is "<token>.png" or "<token>.bin"

Auth:   display token in the path (see below)
Lookup: token → screens row → panel geometry (w, h, colour, rotation)
200:    image bytes + strong ETag + Cache-Control: no-cache
304:    on If-None-Match match — the device skips the panel refresh entirely
```

**Token in the path, not a cookie or header.** `/d/manifest` resolves the screen
from the token carried by a browser that can hold state; a dumb e-paper client
cannot. ESPHome's `online_image` and an HA Generic Camera both do a plain `GET`
of a URL and nothing more, so the token rides in the path (`<token>.png`). It is
the same ten-year display token minted for every screen; pasting it into the
device or the HA config **is** the pairing step (below).

**The `304` is the feature, not an optimisation.** E-paper panels have a bounded
number of refresh cycles and a full refresh is a visible 2–4s flash. On
`304 Not Modified` the device must **skip the panel redraw** — no flash, no
wasted cycle, battery saved. `/d/manifest` already emits an `ETag` and honours
`if-none-match`; the epaper endpoint reuses that exact discipline.

### The ETag must be derivable without rendering

To answer a `304` cheaply — and to save server CPU — derive the ETag from the
*inputs*, not by rendering and hashing the bytes:

```
etag = hash(
  manifestVersion,     // events / weather / shift changed
  screenId, geometry,  // this panel's w/h/colour/rotation
  themeId,             // the eInk theme
  rendererVersion,     // ← bump whenever draw logic changes
  civilDateBucket,     // rolls over at local midnight even if data did not
)
```

Two rules keep it honest, both the same shape as bugs this project has already
paid for:

- **`rendererVersion` in the preimage.** Change how a cell is drawn without
  moving the ETag and every panel silently keeps the old frame for months —
  the migration/journal "a version that lies" failure class.
- **The civil-date bucket.** Without it a panel with no data change never
  redraws, and "today" points at yesterday at 00:01 — the `DTEND`-exclusive /
  `describeAge` family of off-by-a-day bugs.

The reverse collision (same ETag, different pixels) cannot happen if every
layout input is in the preimage, so a stale frame is never served. Two manifests
that render identically send a needless `200`, which is harmless.

## Schema

`screens` (in `apps/server/src/db/schema.ts`) grows a kind and the panel facts.
Everything else it already has — `rotation`, `theme`, `tokenHash`, the pairing
code, `lastSeenAt` — is reused unchanged.

```
kind          text  not null default 'browser'   -- 'browser' | 'epaper'
panel_width   integer                            -- device px, native landscape
panel_height  integer
panel_colour  text                               -- 'bw' | 'bwr' | 'spectra6'
```

`rotation` already exists and is applied *before* packing (see the renderer
note). `browser` is the default so every existing wall is untouched.

**Migration caution.** These are additive columns — a plain `ALTER TABLE ADD
COLUMN`, not a table rebuild. That matters: migration `0009` is the one edited
migration in the repo because a drizzle-kit table-recreate silently corrupted
every calendar. Keep this migration additive; if a later change ever needs to
rebuild `screens`, `test/migration-upgrade.test.ts` (which walks migrations
against a database that already has a screen) is the guard.

## The renderer

Pipeline, reusing the existing viewmodel:

```
buildManifest(screen)              # already done for /d/manifest
   ↓
epaperViewModel(manifest, geom)    # reuse viewmodel.ts' thinking, no DOM
   ↓
draw → Uint8Array                  # pure-TS: rects, lines, month grid, glyphs, dither
   ↓
.bin  → the packed buffer as-is
.png  → wrap with node:zlib
```

**No rasterization library, and no headless browser.** The image is already
~482MB and "one container" is a rule; a headless Chrome to render a calendar is
exactly the wrong trade. A 1-bit grayscale PNG is trivial to emit by hand — PNG
signature, `IHDR` (bit depth 1, colour type 0), one `IDAT` that is
`zlib.deflateSync` of the scanlines (each row prefixed with filter byte `0x00`),
`IEND`. `node:zlib` is Node standard library, allowed in `apps/server`, no
third-party origin, nothing added to the image. It is the same "draw what nobody
else supplies" decision as `http/qr.ts` and the outlined wordmark.

So the **only real build is `draw`**: a bitmap font renderer, rectangle/line
fills, the month grid, and ordered (Bayer) dithering for anything grey. It can
live as a pure module in `apps/server` (no I/O; it could sit in `core`, but does
not need to).

### Seeed 7.5" — the first target's numbers

800×480, black/white, 1 bit per pixel (UC8179-class controller):

- 800 ÷ 8 = **100 bytes per row**, MSB = leftmost pixel
- × 480 = **48,000 bytes** for a full frame — trivial for ESP32 RAM
- row-major, top-to-bottom

Three things to bake in, each the "verify by decoding, not by looking" lesson:

- **Render in the panel's native scan orientation** and apply `screens.rotation`
  *before* packing — the same trap as the wall's rem-basis swap, where a wrong
  rotation halves the display.
- **Dither ordered (Bayer), not error-diffused** — it does not drift and fights
  e-paper ghosting less than Floyd–Steinberg.
- **Pin the bit-invert convention once and assert it by decoding a known
  frame** — a globally inverted panel passes every check a person can reason
  about and fails the moment a scanner (or a real panel) reads it.

### Colour variants

| Panel | Encoding | Serve as |
|---|---|---|
| 7.5" B/W (first target) | 1bpp grayscale | **PNG** (`online_image type: BINARY`) |
| 7.5" B/W/R (tri-colour) | two 1bpp planes | raw `.bin`, planes concatenated |
| 7.5" Spectra 6 | 6-colour, 4bpp | deferred — own theme, later |

Start with **B/W + PNG**. The eInk theme designs *for* 1-bit, so red on the
tri-colour panel is a bonus channel on a design that already reads without it,
never a crutch.

## The eInk theme

The wall's whole language leans on hue — Board's amber lit cell, shift hues that
"separate best at ten feet", presence colours, weather severity colour. On 1–3
colours that channel is gone. The eInk theme, in the spirit of
`apps/display/src/theme.ts` (nothing outside it names a colour), re-expresses
meaning without hue:

- **The lit cell** (the mark's whole promise) → an inverted or bordered cell; or
  the red plate on a B/W/R panel — the one place a third colour earns its keep.
- **Shift hues** → hatch/dither patterns, not colours.
- **Density / month heat** → dot density, not tint.
- **Type must be bitmap-crisp** — antialiasing does not exist at 1-bit, so a
  hinted bitmap font at the sizes actually used, not the outlined display fonts
  shrunk. Same instinct as the hand-drawn mark and the QR encoder.
- **Layout** — 800×480 is closer to the wall's landscape two-column than
  portrait; `orientation.ts` already computes this from geometry.

## Admin surface

A new nav header, **Walls**, with a single option under it: **eInk Displays**.

Today the browser walls live in the unified `/admin/displays` section (Screens
and Layout, merged). The eInk page is a sibling under the same **Walls** header:
pair an e-paper screen (mint a token / show the pairing code), name it, set panel
geometry and rotation, and copy the two consumption recipes (ESPHome YAML, HA
automation) pre-filled with this screen's URL. It is deliberately **one option**,
not a spread of paths — the same "fewer doors" lesson as the module Store
reframe in RFC 002.

## Pairing

No new mechanism. An e-paper screen is a `screens` row with `kind = 'epaper'`;
pairing mints the same display token (and the same 8-character hand-typed code
already used for camera-less screens). There is no QR to scan on a tag or an
ESP32 — **pasting the token into the device or HA config is the pairing act**:

- ESPHome: the token goes in `secrets.yaml`, referenced by `online_image.url`.
- OpenDisplay via HA: the token is in the URL the Generic Camera fetches.

The eInk Displays page shows the token once (like every token) and builds the
recipe URL from it.

## The rules this touches, stated plainly

- **Rule 8 (one container).** No BLE, no adapter, no native BLE lib. The tag's
  BLE lives entirely in the household's Home Assistant.
- **Rule 12 (HA read-only).** Maverick never calls an HA service. HA initiates
  every push; Maverick only ever answers a `GET` with an image.
- **Rule 9 (never brick / degrade).** A frame that fails to render answers a
  `503`, not a broken image; the device keeps its last frame. And see the
  alerts note below — this is the honest limit.
- **Rule 3 (no third-party origin in the display bundle).** Not engaged — the
  rendering is server-side, and nothing a module supplies is executed. The
  OpenDisplay integration is the *household's* HA, not our bundle.

### The honest limit: battery panels are a glance class, not an alert class

A battery e-paper panel deep-sleeping 15–30 minutes **cannot** show a tornado
takeover promptly; `api/push.ts`'s `wakeScreen` is meaningless to a sleeping
ESP32. This collides with the interrupt system, and the answer is to say so
rather than pretend:

- **Battery panels are documented as glance-only** — they show the calendar,
  not time-critical alerts. This is the same discipline as the "service worker
  will not register over plain http" note: state what is and is not true.
- **Mains-powered panels** can poll every 1–5 minutes (drop `deep_sleep`) and
  carry interrupts in a degraded-but-real way.

The `docs/` recipe must say which panel is which. A wall that looks like it woke
for a warning and did not is worse than one that never claimed to.

## Phasing

1. **B/W PNG + ESPHome pull.** Schema columns, `/d/epaper/:token.png`, the 1-bit
   rasterizer, the eInk theme, the Walls › eInk Displays page, the ESPHome
   recipe. Proven on the Seeed 7.5".
2. **OpenDisplay via HA.** The plain-PNG contract already exists from phase 1;
   this is the HA recipe (Appendix B) plus the "verified on real hardware" pass.
3. **Tri-colour (`.bin` two-plane)**, then Spectra 6 — each its own theme work.

## Verification bar

By this project's history, an asset or layout fault surfaces only on real
hardware, so phase 1 is not "done" until a frame has been **pushed to a real
Seeed 7.5" and photographed**, and the bit-invert/rotation asserted by
**decoding** a known frame rather than by looking. Phase 2 is not "done" until a
frame has reached a **real OpenDisplay tag through a real supervisor** — the same
bar the ingress and pairing flows were held to.

## Open questions

- **Bitmap font.** Bundle a hinted bitmap font for the eInk theme, or generate
  glyph bitmaps at build time from Oswald (already bundled) at the fixed sizes
  the theme uses? The second keeps one type source; the first is simpler to get
  crisp.
- **Which staging bridge for the core HA integration** (Appendix B) survives
  contact with a real supervisor — Generic Camera + snapshot is the candidate
  because it doubles as the last-good-frame buffer, but the `/media` /
  `allowlist_external_dirs` plumbing is exactly the fiddly HA config this
  project proves rather than asserts.
- **Where the eInk viewmodel bounds live.** `viewmodel.ts` already clamps
  density for the browser wall; an 800×480 1-bit panel wants its own, tighter
  opinion about events-per-day before a NEXT row stops being readable.

---

## Appendix A — the ESPHome recipe (device pulls)

Stock ESPHome; the only project-specific line is the URL. Battery variant shown;
drop `deep_sleep` and poll for the mains/alert-capable variant.

```yaml
# secrets.yaml
wifi_ssid: "MyHouse"
wifi_password: "..."
maverick_epaper_url: "http://maverick-wall.local:8080/d/epaper/YOUR_TOKEN.png"
```

```yaml
esphome:
  name: kitchen-eink
esp32:
  board: esp32dev
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

display:
  - platform: waveshare_epaper      # or the Seeed panel's driver
    model: 7.50inv2
    cs_pin: 5
    dc_pin: 17
    busy_pin: 4
    reset_pin: 16
    update_interval: never          # redraw manually, not on a timer
    lambda: |-
      it.image(0, 0, id(wall_image));

online_image:
  - id: wall_image
    url: !secret maverick_epaper_url
    format: PNG
    type: BINARY                     # 1-bit

deep_sleep:
  run_duration: 30s
  sleep_duration: 30min

interval:
  - interval: 25s
    then:
      - component.update: wall_image
      - component.update: display
```

## Appendix B — the OpenDisplay recipe (core integration)

**Decision: standardise on the core `opendisplay.upload_image` action, not the
HACS `drawcustom` variant.** `drawcustom` accepts a URL directly (zero setup)
but is a community integration and does a live fetch with no buffer. The core
action consumes a **media source** (a file HA already holds), which requires one
staging step — and that step is the point: the staged file is a **last-good-frame
buffer**, so if Maverick blips at push time the tag refreshes stale-but-present
instead of blank. That is rule 9 / "the wall remembers" in HA's clothing, and
core also avoids a HACS dependency and matches HA's own SSRF-cautious posture
(consume a held file, do not blind-fetch a URL).

The staging bridge (candidate — to be proven on real hardware): a **Generic
Camera** points at Maverick's URL (HA does the fetch — rule 12 safe), a schedule
runs `camera.snapshot` to a file under `/media`, and `opendisplay.upload_image`
reads that file. The camera entity inherently holds the last frame, so the
staging mechanism and the buffer are the same object.

```yaml
# configuration.yaml — HA fetches Maverick (Maverick never calls HA)
camera:
  - platform: generic
    name: Kitchen eInk source
    still_image_url: "http://maverick-wall.local:8080/d/epaper/YOUR_TOKEN.png"
```

```yaml
# automation — runs entirely inside Home Assistant
trigger:
  - platform: time_pattern
    minutes: "/15"
action:
  - action: camera.snapshot
    target:
      entity_id: camera.kitchen_eink_source
    data:
      filename: /media/eink/kitchen.png
  - action: opendisplay.upload_image
    data:
      device_id: <the tag's device_id>
      image:
        media_content_id: media-source://media_source/local/eink/kitchen.png
        media_content_type: image/png
      fit_mode: contain
      dither: floyd_steinberg     # the integration dithers to the tag's palette
      refresh_mode: full
```

Maverick's obligation for this path: a plain, high-contrast eInk-themed PNG with
a strong `ETag` and `Cache-Control: no-cache`. No 1-bit packing, no dithering,
no per-panel geometry — the integration finishes it.

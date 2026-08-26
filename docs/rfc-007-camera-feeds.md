# RFC 007 — Camera feeds on the wall

Status: **draft** · Owner: — · First drafted 2026-08-13 ·
Relates to `apps/server/src/modules/homeassistant/`, `apps/server/src/api/media.ts`,
`apps/server/src/http/app.ts`, `apps/display/src/`, the SSRF-guarded `Fetcher`

## Summary

A household with cameras in Home Assistant — a Reolink doorbell is the case that
prompted this — should be able to put one on the wall: the front door, live,
next to the calendar. This RFC says how, and it says it as a **ladder**, because
the honest version of "live camera" and the cheap version of it are different
amounts of work with different security costs, and conflating them is how the
wall ends up leaking the house's Home Assistant address to a hallway tablet.

Three shapes exist, and only the order matters:

1. **Tier A — snapshot refresh.** Poll `/api/camera_proxy/<entity>` for a JPEG
   every second or three, swap an `<img>`. Not live, but "what's at the door
   right now-ish". Pure `GET`. A weekend.
2. **Tier B — MJPEG proxy.** Pipe `/api/camera_proxy_stream/<entity>` through
   the server to an `<img>` on the wall. Sub-second, smooth-ish, renders in any
   WebView with zero bundled video code. Pure `GET`. **This is the one to
   build.**
3. **Tier C — WebRTC.** True real-time (~200ms), the technology Home Assistant
   itself ships (go2rtc is bundled). Also the one that fights this project's two
   load-bearing invariants harder than anything before it. **Pinned as an open
   decision, not built** — see [§7](#7-the-webrtc-decision).

The decision this RFC asks for is: **build Tier B, agree the security surface it
introduces, and do not slip Tier C in silently** — because the easy way to do
WebRTC trades away the exact property the whole Home Assistant module is built
to protect.

## The one thing we do not build

We do not let the wall talk to Home Assistant.

Everything in `modules/homeassistant/` exists to keep one promise, written at the
top of [`client.ts`](../apps/server/src/modules/homeassistant/client.ts): the
display receives resolved *values* — "19.4 °C", "Open" — and "never an entity
handle, never a proxy endpoint it could query with, and never the token." A Home
Assistant long-lived access token has full control of the house and cannot be
scoped; the blast radius of a compromised hallway tablet is held to "somebody
saw my indoor temperature" **because the tablet has no way to reach Home
Assistant at all.** `homeassistant.test.ts` asserts the manifest carries neither
the token nor the base URL.

A camera is the first module surface that ships *pixels from inside the house*,
and the temptation it introduces is to let the wall fetch the stream directly —
which is exactly what native WebRTC wants to do, and exactly what we refuse. The
wall requests an **opaque, first-party, token-gated handle** on *our* origin; the
server is the only thing that knows which entity it maps to and the only thing
that ever holds a socket to Home Assistant. This is the same boundary the media
pipeline already draws for uploaded photos, and it does not move for cameras.

## Constraints, and why they decide the shape

Three rules from `CLAUDE.md` set the whole design, and every tier is judged
against them:

- **Rule 12 — Home Assistant is read-only, and that is a security property.**
  `client.ts` states flatly that nothing here issues a `POST`. Snapshot and MJPEG
  are `GET`s and stay inside this. WebRTC signaling is inherently a `POST`/socket
  exchange (you have to send an SDP offer *up*), so Tier C crosses this line and
  must do so *loudly*.
- **The blast-radius model** (above). The wall must not learn Home Assistant's
  address. This is what makes Tier C's "media goes direct" shape unacceptable and
  Tier B trivially fine.
- **Rule 3 — no third-party origins, ES2019, works offline.** This *kills native
  HLS* (Chrome/Android WebViews don't play it natively; you'd bundle `hls.js`, a
  heavy dep, into a "no framework, vanilla TS" display). It does **not** touch
  MJPEG — a plain `<img>` streams it with no JS at all — and it does **not** touch
  WebRTC, which is a native browser API, not a bundled library. So rule 3, for
  once, is not the thing that decides between B and C.

The tiers, scored:

| Tier | HA source | Latency | Wall side | Read-only clean? | Leaks HA address? | Effort |
|---|---|---|---|---|---|---|
| **A. Snapshot** | `GET /api/camera_proxy/<e>` JPEG, polled | ~1–3s, choppy | `<img>` on a timer | ✅ `GET` | No | Low |
| **B. MJPEG** | `GET /api/camera_proxy_stream/<e>` | sub-second | `<img src=/d/camera/…>` | ✅ `GET` | No | Medium |
| **C. WebRTC** | signaling exchange + media | ~200ms, true live | `RTCPeerConnection` | ⚠️ `POST`/WS | **Shape-dependent** | High |

## Architecture — Tier B, the streaming proxy

The existing [`call()`](../apps/server/src/modules/homeassistant/client.ts) cannot
carry a stream, and that is not a bug to fix in place — it is *deliberately*
bounded: `maxBytes: FETCH_LIMITS.json`, `acceptContentTypes: ['application/json']`,
one buffered response. An MJPEG feed is an unbounded `multipart/x-mixed-replace`
that never completes. That is a genuinely different outbound mode, and it is the
core new piece of work.

```
  wall <img src="/d/camera/<handle>">
        │  (display token cookie, first-party origin)
        ▼
  apps/server  /d/camera/:handle
        │  1. gate on display token
        │  2. handle → entity_id   (opaque map, server-only)
        │  3. resolveConnection()  (token, base, policy — never leaves here)
        ▼
  streamProxy(fetcher, connection, `/camera_proxy_stream/${entity_id}`)
        │  SSRF-guarded, DNS-pinned, authorization: Bearer …
        │  idle timeout · max duration · backpressure · one stream per handle cap
        ▼
  Home Assistant / go2rtc  ──▶  multipart JPEG frames, piped straight through
```

Load-bearing properties of the proxy leg:

- **Bounded in time, not in bytes.** A live stream has no content-length, so the
  `maxBytes` guard is replaced by an **idle-read timeout** (no frame in N seconds
  → close) and a **hard max duration** (reconnect on a schedule so a wedged
  socket can't pin a connection for a month — rule 9, "never brick the kitchen
  calendar", applies to the server too).
- **Still through the SSRF guard.** The DNS-pinned fetcher and the redirect-origin
  refusal do not relax for streams; the `authorization` header is dropped on a
  cross-origin redirect exactly as it is today. A camera feed is still a
  user-adjacent URL under rule 4.
- **Backpressure to the wall.** If the tablet stops reading, the upstream read
  stops — we do not buffer frames the wall will never see.
- **One upstream stream per handle**, fanned out if two screens watch the same
  camera, so N tablets don't open N sockets into Home Assistant.

Tier A is the same picture with the stream replaced by a buffered JPEG `GET` on a
timer — worth shipping first as the plumbing proof, because it exercises the
handle, the gate, the entity map and the fallback with none of the streaming
subtlety.

## The opaque handle, and the gate

A camera URL on a wall must reveal nothing and be reachable by no one who isn't a
paired screen. Two mechanisms, both already precedented:

- **The handle is ours, like a media name.** [`media.ts`](../apps/server/src/api/media.ts)
  derives a stored name from a content hash so "nothing an uploader writes can
  reach the filesystem" and no entity id appears in a URL. Cameras get the same:
  a random opaque handle minted per watched camera, mapped server-side to an
  entity id. The manifest carries the *handle*, never `camera.front_door`. The
  existing "manifest contains no entity id" assertion extends to cover it.
- **The gate is the display token, mandatory.** `/d/camera/*` sits behind the
  same display-token check as `/d/media` — "a family's photographs must not be
  readable by anything on the LAN that knows a filename," and a live doorbell is
  strictly more sensitive than a photograph. Served `nosniff`. There is no
  unauthenticated camera path, ever.

And one addition cameras need that photos did not:

- **Per-screen opt-in, off by default.** A temperature reading is ambient; a
  continuous view into the home is not. A camera appears **only on screens the
  household explicitly placed it on** — not broadcast to every paired wall
  because someone added the block once. This mirrors `screens.allow_dismiss`
  being a per-screen fact about the hardware: the tablet in the kitchen and the
  television in the hall are mounted differently and watched by different people.

## Data model

A watched camera is a new small table (or a row shape reusing the existing
watched-entity machinery), holding:

- `handle` — the opaque, unguessable public id (what the manifest and URL carry).
- `entity_id` — server-only, never serialized outward.
- `label` — the household's name for it ("Front door"), the one string the wall
  sees.
- `tier` — `snapshot` | `mjpeg` (| `webrtc`, reserved), so a household on a slow
  box can fall back to snapshots per camera.
- `refresh_ms` — snapshot cadence, ignored for streams.
- placement — which screens show it (the per-screen opt-in above).

`camera` joins `SUPPORTED_DOMAINS` in
[`entities.ts`](../apps/server/src/modules/homeassistant/entities.ts), but it does
**not** flow through `toReading()` / `readState()` — a camera has no state string
to word. It resolves to a handle, not a reading. The entity picker lists camera
entities so the household can choose one; everything after diverges from the
value path.

## The display side

A first-party `camera` widget/block, and nothing fetched from anywhere but our
origin:

- **Tier A/B render as a bare `<img>`** pointed at `/d/camera/<handle>` — MJPEG
  and periodic JPEG both "just render" in a WebView with no script, no codec, no
  bundled library. This is the property that makes B cheap.
- **Rule 9 is the hard part of the renderer, not the easy part.** A dead camera
  degrades to a labelled placeholder ("Front door — no signal"), never a black
  rectangle (which looks deliberate) and never a hung image load that stalls the
  wall. `onerror` → fallback, a staleness note the way readings already carry
  one, and a reconnect that backs off. The camera must be able to fail without
  the calendar noticing.
- **It honours the free-form canvas.** A camera is a natural free-form widget
  (RFC 005) — someone will want the doorbell in a corner — so it lands in the
  `WIDGET_TYPES` allowlist as a *first-party* renderer. Rule 3 lives in that
  allowlist: this is a first-party block drawing a first-party-proxied stream, not
  a video-URL widget, and it must stay that way.

## 7. The WebRTC decision

Home Assistant bundles go2rtc, and Reolink over WebRTC is the well-trodden path,
so this is a real option and worth pinning rather than hand-waving. WebRTC wins
on two axes — it is the only tier that is *actually* real-time, and being a
native browser API it costs no bundle under rule 3. It loses on the two axes this
project cares about most, and there is **no free reconciliation**. You pick a
shape:

**Shape 1 — server brokers signaling, media goes direct.** The server (holding
the token) does the SDP offer/answer with go2rtc and hands the answer to the
wall, which peers directly. Easy — a weekend. But the SDP answer *contains
go2rtc's ICE candidates*: Home Assistant's LAN address and port. The instant the
wall receives it, a compromised tablet knows how to reach Home Assistant and has
a live media socket into it. WebRTC media is secured by the DTLS keys from
signaling, not a revocable token, so there is nothing to scope or expire on that
leg. **This breaks the blast-radius model** — the one thing the whole module is
built to hold — and it does so quietly, which is the worst way. We do not ship
Shape 1.

**Shape 2 — the server relays the media.** Browser peers with our container; our
container peers with go2rtc; we forward SRTP between the legs (or run a TURN relay
so the wall's candidates only ever point at us). This *keeps* the model: Home
Assistant's address never reaches the wall. But now the single container is a
**real-time media server** — a Node WebRTC stack (`werift` / `wrtc` / mediasoup,
all heavy or half-maintained native deps), per-stream CPU on the small box this
runs on, and UDP/ICE that has to work through the supervisor network under
ingress. That is a large departure from "one container, if you think you need
Redis you don't," and by this project's own history it is exactly the class of
thing only a real Home Assistant supervisor would shake the bugs out of.

**And the read-only question, separately.** Signaling is a `POST`/WebSocket
exchange whichever shape you pick. An SDP offer changes no *device* state — it
negotiates a session, it does not unlock a door — so it arguably keeps the
*spirit* of rule 12. But it crosses the line [`client.ts`](../apps/server/src/modules/homeassistant/client.ts)
draws in ink ("nothing here issues a POST"), and given the token controls the
house, that is a carve-out to document and defend, not to discover in a diff.

So the WebRTC position is: **not now, and not without a decision.** If it is
built, it is Shape 2, and the read-only exception is written down first. Where it
would genuinely earn the media-relay cost is two-way audio (talk back through the
doorbell) — but that is an audio *uplink*, squarely a control action on the wrong
side of rule 12, and out of scope until read-only is deliberately revisited.

## What we build, in order

1. **Tier A — snapshot.** Proves the handle, the display-token gate, the
   entity-id-never-leaves map, the per-screen opt-in, and the rule-9 fallback,
   with zero streaming subtlety and zero new trust surface. A real product on its
   own ("front door, refreshed every couple of seconds").
2. **Tier B — MJPEG.** The streaming proxy on top: idle timeout, max duration,
   backpressure, per-handle fan-out. This is the target — a live doorbell that
   renders in any WebView.
3. **Then, only if the appetite is there, revisit Tier C as Shape 2**, with the
   read-only carve-out documented. Everything Tier C needs downstream — the
   widget, the gate, the opt-in — is already built by then, so the marginal work
   is only the media leg, which is the honest place to weigh it.

## How this gets proven (verification is the job)

In the spirit of `CLAUDE.md`'s bug table — the checks that would actually catch
the failures this design invites:

- **A real MJPEG source, not a stub.** A local HTTP server emitting
  `multipart/x-mixed-replace` frames, proxied end to end, decoded to confirm
  frames actually arrive — the same "prefer tests that touch something real" that
  found the gzip and cookie bugs. A mocked stream would pass over every timeout
  and backpressure bug in the proxy.
- **The manifest carries a handle and never an entity id.** Extend the existing
  assertion: seed `camera.front_door`, render the manifest, assert
  `front_door` / `camera.` appear nowhere and the opaque handle does.
- **The gate refuses without a display token**, and `/d/camera/<handle>` for a
  camera not placed on *this* screen is refused — the per-screen opt-in is a
  boundary, so it gets a test that fails when the check is removed.
- **A dead camera degrades.** Kill the upstream mid-stream and assert the wall
  shows the placeholder and the calendar is untouched — not a black box, not a
  hung load. Rule 9, measured rather than assumed.
- **The proxy cannot be wedged.** A source that opens and never sends a frame
  must hit the idle timeout and close, not hold the connection. A source that
  redirects off-origin must drop the `authorization` header.

## Open decisions

- **Tier C at all** — is a true-live doorbell worth a media-relay subsystem
  (Shape 2) and a documented read-only carve-out? Or is Tier B "live enough"
  forever? This RFC recommends deferring, not deciding.
- **go2rtc's non-WebRTC outputs.** Because go2rtc is bundled, it can also serve
  MSE/fMP4, which is smoother than MJPEG and lower-bandwidth — but needs
  Media Source Extensions and a bit of JS on the display, a smaller rule-3
  question than HLS but not zero. Worth a look as a "Tier B+", after B works.
- **Snapshot vs stream default.** MJPEG is heavier on the box and the camera; a
  household on a Pi with six cameras may want snapshots by default. The
  `tier`-per-camera column exists for this; the *default* is the open question.
- **Recording / history.** Explicitly out of scope. The wall shows *now*. Storing
  frames is a different product with a different threat model.

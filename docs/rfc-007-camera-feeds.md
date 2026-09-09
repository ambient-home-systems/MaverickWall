# RFC 007 — Camera feeds on the wall

Status: **proposed; rewritten after review, nothing built** · Owner: — · First
drafted 2026-08-13 · Rewritten 2026-09-09 · Relates to
`apps/server/src/modules/homeassistant/`, `packages/core/src/ports/fetcher.ts`,
`apps/server/src/net/fetcher.ts`, `apps/server/src/api/widget-schema.ts`,
`apps/server/src/api/queries.ts`, `apps/display/src/main.ts`,
`apps/server/src/epaper/honours.ts`

> **Rewritten 2026-09-09.** The first draft's argument — three tiers in a
> ladder, an opaque first-party handle, and a wall that never learns Home
> Assistant's address — survives untouched, and §2, §3 and §9 are largely the
> text it had. What did not survive was the mechanism, and the review that
> found out was the ordinary one this repository asks for: reading the draft
> against the code it named. Five things were wrong enough to change the
> design rather than the wording, and they are recorded here because each is
> the kind of thing a second draft would otherwise reintroduce.
>
> - **The wall rebuilds its whole tree every fifteen seconds.** Every renderer
>   in `main.ts` begins `root.textContent = ''`, on `TICK_MS`. The draft's bare
>   `<img>` would have torn down and reconnected its stream four times a
>   minute on every screen, for months. §7 exists because of this.
> - **"Piped straight through", "fanned out" and "backpressure stops the
>   upstream" contradict one another.** A late joiner on a raw pipe starts
>   mid-JPEG, and one slow tablet stalls every other. §5 replaces the pipe with
>   a frame hub.
> - **`camera` in `SUPPORTED_DOMAINS` makes a camera a reading**, because
>   `isSupported` filters the states poll and the watched-entity form, and
>   `entities.ts` records `calendar` being removed for exactly this. §6.1.
> - **The latency claim for Tier B is not true of the camera that prompted
>   it.** Reolink hands Home Assistant no native MJPEG stream, so the stream
>   endpoint is core's own still-frame loop. §4.
> - **A placement column and a per-screen switch duplicate the canvas**, which
>   is already per screen and already what a household arranges. §6.3.
>
> Four smaller ones are recorded where they land: a per-frame byte cap (§5.1),
> the stream port's home in core (§5.5), the e-paper panel (§7.4), and a cache
> header (§6.4).

## 1. Summary

A household with cameras in Home Assistant — a Reolink doorbell is the case
that prompted this — should be able to put one on the wall: the front door,
live, next to the calendar. This RFC says how, and it says it as a **ladder**,
because the honest version of "live camera" and the cheap version of it are
different amounts of work with different security costs, and conflating them
is how the wall ends up leaking the house's Home Assistant address to a
hallway tablet.

Three shapes exist, and only the order matters:

1. **Tier A — snapshot.** A JPEG fetched through the existing bounded
   `Fetcher` on a short timer and swapped into a picture that never leaves the
   page. Not live, but "what is at the door right now-ish". Pure `GET`, and
   no new outbound mode at all.
2. **Tier B — the proxied stream.** Home Assistant's MJPEG endpoint, read by
   the server, cut into frames, and re-served to every screen watching the
   same camera from one upstream socket. Renders in any WebView with zero
   bundled video code. Pure `GET`. **This is the target**, with one honest
   caveat about how live it actually is (§4).
3. **Tier C — WebRTC.** True real-time, the technology Home Assistant itself
   ships. Also the one that fights this project's two load-bearing invariants
   harder than anything before it. **Pinned as an open decision, not built** —
   see §9.

The decision this RFC asks for is: **build the frame hub, then Tier A on it,
then Tier B on it; agree the security surface; and do not slip Tier C in
silently** — because the easy way to do WebRTC trades away the exact property
the whole Home Assistant module is built to protect.

## 2. The one thing we do not build

We do not let the wall talk to Home Assistant.

Everything in `modules/homeassistant/` exists to keep one promise, written at
the top of [`client.ts`](../apps/server/src/modules/homeassistant/client.ts):
the display receives resolved *values* — "19.4 °C", "Open" — and "never an
entity handle, never a proxy endpoint it could query with, and never the
token." A Home Assistant long-lived access token has full control of the house
and cannot be scoped; the blast radius of a compromised hallway tablet is held
to "somebody saw my indoor temperature" **because the tablet has no way to
reach Home Assistant at all.** `homeassistant.test.ts` asserts, in one test
named "sends the wall a value and never a way to ask for another", that the
manifest carries neither an entity id, nor the token, nor the base URL.

A camera is the first module surface that ships *pixels from inside the
house*, and the temptation it introduces is to let the wall fetch the stream
directly — which is exactly what native WebRTC wants to do, and exactly what
we refuse. The wall requests an **opaque, first-party, token-gated handle** on
*our* origin; the server is the only thing that knows which entity it maps to
and the only thing that ever holds a socket to Home Assistant. This is the
same boundary `api/media.ts` already draws for uploaded photos, and it does
not move for cameras.

## 3. Constraints, and why they decide the shape

Five rules from `CLAUDE.md` set the whole design, and every tier is judged
against them:

- **Rule 12 — Home Assistant is read-only, and that is a security property.**
  `client.ts` states flatly that nothing here issues a `POST`. Snapshot and
  MJPEG are `GET`s and stay inside this. WebRTC signaling is inherently a
  `POST`/socket exchange (an SDP offer has to be sent *up*), so Tier C crosses
  this line and must do so *loudly*.
- **The blast-radius model** (§2). The wall must not learn Home Assistant's
  address. This is what makes Tier C's "media goes direct" shape unacceptable
  and Tiers A and B trivially fine.
- **Rule 3 — no third-party origins, ES2019, works offline.** This rules out
  HLS on two grounds, and the first draft named the weaker one. The weaker:
  desktop Chromium and the Linux kiosk builds a Pi runs do not play HLS
  natively, so it would mean bundling `hls.js` into a "no framework, vanilla
  TS" display — Android WebView does play it natively, so the portability
  problem is real but partial. The stronger: Home Assistant's HLS is a
  segment stream with several seconds of latency by construction, which is
  not a live doorbell. Rule 3 does **not** touch MJPEG — a plain `<img>`
  draws it with no script — and it does not touch WebRTC, which is a native
  browser API rather than a bundled library. So rule 3, for once, is not the
  thing that decides between B and C.
- **Rule 9 — never brick the kitchen calendar, and that includes the server.**
  A held-open socket is the first long-lived thing this process would do on
  behalf of a screen. Everything about the hub in §5 is bounded because a
  wedged camera must not pin a connection, a buffer or a CPU for a month.
- **Rule 1 — core imports nothing beyond the standard library.** The stream
  port has to be typed in `packages/core` without Node, and §5.5 says how.

The tiers, scored:

| Tier | Home Assistant source | Latency | Wall side | Read-only? | Leaks the address? | Effort |
|---|---|---|---|---|---|---|
| **A. Snapshot** | `GET /api/camera_proxy/<e>`, one JPEG | seconds | `<img>` on a timer | yes, `GET` | no | low |
| **B. Stream** | `GET /api/camera_proxy_stream/<e>` | see §4 | `<img>` on `/d/camera/…/stream` | yes, `GET` | no | medium |
| **C. WebRTC** | signaling exchange plus media | ~200 ms, true live | `RTCPeerConnection` | no, `POST`/WS | **shape-dependent** | high |

## 4. What Home Assistant actually hands us

The first draft scored Tier B as "sub-second, smooth-ish". That is true of a
camera whose integration relays the camera's own MJPEG stream, and it is not
true of the doorbell this RFC was written for. As core's camera component
reads at the time of writing:

- `GET /api/camera_proxy/<entity>` answers one JPEG from the integration's
  snapshot method.
- `GET /api/camera_proxy_stream/<entity>` calls the integration's MJPEG
  handler. An integration *may* override it to relay a native stream. Core's
  **default** is a still-frame loop: fetch a snapshot, write it only if its
  bytes differ from the last one, sleep the frame interval (half a second by
  default), repeat. It also writes the very first frame twice, which is a
  Chrome quirk it works around and which a parser has to shrug at.
- Reolink implements a snapshot and an RTSP `stream_source`, and does not
  override the MJPEG handler. So on a Reolink the stream endpoint is **two
  snapshots a second on one socket, sent only when they change** — and a
  snapshot can be a full-resolution JPEG from a 4K doorbell.
- Under the add-on both endpoints are reached at
  `http://supervisor/core/api/…`, through the supervisor's own proxy, which
  has to hold a response open for as long as the wall watches. Nothing in
  this repository has ever asked it to. By this project's history that is
  where the first real fault will be.
- go2rtc is bundled with Home Assistant, and its WebRTC signaling is exposed
  through Home Assistant's WebSocket API. Its *own* HTTP outputs — MJPEG at
  full rate, MSE, fMP4 — are on go2rtc's port inside the core container, and
  this RFC does not know them to be reachable through `core/api` at all. That
  is a fact to check before "Tier B+" (§12) counts as an option.

What follows from it:

| Path | A Reolink, today | A camera with a native MJPEG integration |
|---|---|---|
| Snapshot | one JPEG per request | the same |
| Proxied stream | core's loop, at most 2 fps, changed frames only | the camera's own rate |
| WebRTC through go2rtc | ~200 ms | the same |

**On a Reolink, Tiers A and B converge.** B still buys two things worth
having — one socket into the house however many screens watch, and Home
Assistant pacing the camera rather than us — but it does not buy "live", and
the RFC must not promise it. The **snapshot vs stream default** is therefore
decided by measurement on the household's actual camera, and until that
measurement exists the default is snapshot (§12).

## 5. Architecture — the frame hub

The existing [`call()`](../apps/server/src/modules/homeassistant/client.ts)
cannot carry a stream, and that is not a bug to fix in place — it is
*deliberately* bounded: `maxBytes: FETCH_LIMITS.json`,
`acceptContentTypes: ['application/json']`, one buffered response. So is the
`Fetcher` under it: [`ports/fetcher.ts`](../packages/core/src/ports/fetcher.ts)
answers with a `body: string`, one `timeoutMs` for the whole exchange, and a
`maxBytes` enforced while the bytes arrive. An MJPEG feed is an unbounded
`multipart/x-mixed-replace` that never completes. That is a genuinely
different outbound mode, and it is the core new piece of work — but it is
**not a pipe**, and the difference is the whole of this section.

```
  wall   <img src="/d/camera/<handle>/stream">     (display cookie, our origin)
           │
           ▼
  apps/server   GET /d/camera/:handle/stream
           │   1. requireScreen  (already on /d/*)
           │   2. effective canvas → is this handle placed on this screen?
           │   3. handle → entity_id   (server-only table)
           │   4. resolveConnection()  (token, base, policy — never leaves here)
           ▼
  CameraHub.subscribe(handle, screenId)
           │   one upstream per handle · latest-frame-wins per subscriber
           │   re-served under our own boundary · caps · demand-driven
           ▼
  StreamFetcher.open(`/camera_proxy_stream/${entity_id}`)
           │   DNS-pinned · redirect-checked · authorization stripped cross-origin
           │   idle timeout · max duration · per-frame byte cap
           ▼
  Home Assistant  ──▶  multipart JPEG  ──▶  parsed into whole frames
```

### 5.1 Frames, not bytes

The hub **parses the upstream into whole JPEG frames** and re-emits them.
The parser finds a frame by its own start and end markers (`FF D8` … `FF D9`)
and treats the multipart boundary in the `content-type` header as a hint —
honoured when a `content-length` is present, verified against the markers,
never trusted alone — because cameras and integrations disagree about
boundaries in every way a header can be wrong. Once the hub owns the frames,
five things come for free that a pipe cannot have:

- **A late joiner starts on a frame.** A second screen opening the same
  camera is handed the latest frame first, so it paints at once, and then
  joins the flow at the next boundary. On a raw pipe it would start
  mid-JPEG and show garbage until the next frame happened along.
- **A slow reader drops, and never stalls anyone else.** Every subscriber has
  a mailbox of exactly one frame; a new frame overwrites an unread one. The
  first draft's "backpressure stops the upstream read" is right for one
  reader and wrong for two, because the slowest tablet would set the frame
  rate for the whole house. Backpressure still applies **per subscriber**:
  the Node adapter waits on `drain` and cancels the reader when the socket
  closes (`@hono/node-server` 1.19, `writeFromReadableStreamDefaultReader`),
  so a wall that stops reading costs a mailbox and nothing more.
- **An upstream reconnect is invisible to the wall.** The subscriber's stream
  is framed under *our* boundary, so the hub can drop and reopen the socket
  into Home Assistant — for the max-duration rule, for an idle timeout, for
  a hiccup — and the `<img>` on the wall sees an unbroken stream with a
  pause in it.
- **A frame can be capped in bytes.** The first draft said "bounded in time,
  not in bytes", which is right about the *stream* and wrong about a
  *frame*: once frames are held in memory for fan-out, a source that sends
  one enormous frame is a memory bomb on the one container. A frame over the
  cap drops the upstream, which reconnects with backoff — a source doing
  that is misbehaving and is treated as such.
- **Tier A is the latest frame.** A snapshot request for a camera whose
  stream is already open is answered from the hub, and never costs Home
  Assistant a second fetch.

### 5.2 Demand-driven, bounded

**Nothing runs unwatched.** An upstream opens on the first subscriber and
closes a few seconds after the last one leaves — a grace period, so a wall
reloading itself does not thrash the socket — and boot opens nothing. A
household on a Pi with six cameras and one wall showing one of them has one
socket into the house, not six.

Every limit is a named constant in one file, with its reason beside it. The
values below are the proposal; the measurement in §10 phase 3 may move them,
and moving them is a one-line diff with a sentence:

| Limit | Proposed | Why |
|---|---|---|
| Idle frame timeout | 30 s | longer than a scene that has not changed (§5.3) |
| Max upstream duration | 10 min | a wedged socket cannot last a month |
| Per-frame cap | 4 MB | a 4K snapshot fits; a byte bomb does not |
| Upstreams per household | 8 | the box is small and so is the house |
| Streams per screen | 4 | a wall is not a security console |
| Grace after last subscriber | 5 s | a reloading wall must not reopen the socket |

A refused subscription answers `503` with a sentence for somebody in a
kitchen ("This wall is already showing as many cameras as it can."), never
an exception into anything. The hub is a service the route uses and **not a
module job**: it never runs inside `collectPanels`, so it cannot cost the
calendar a panel, and manifest assembly does not know it exists.

### 5.3 Silence is not death

Because core's still-frame loop skips a frame whose bytes match the last one,
a camera pointed at an empty porch can legitimately send nothing for a
while. Sensor noise makes byte-identical JPEGs rare from a real camera, but
"rare" is not "never", and some cameras answer a snapshot from a cache. So an
idle timeout is **a quiet reconnect, not a failure**: the hub reopens the
upstream with backoff and the subscribers see nothing, because the picture on
the wall is the frame their `<img>` already holds. Only after several
consecutive failed opens does the hub end its subscribers' responses — which
is what reaches the wall as an error, and what the wall answers with a
placeholder (§7.3). The count and the backoff are constants beside the ones
above.

### 5.4 Tier A rides the Fetcher that exists

A snapshot needs no streaming at all. `GET /d/camera/:handle/still` answers
the hub's latest frame if that camera's upstream happens to be open, and
otherwise one bounded `GET` of `/camera_proxy/<entity>` through the ordinary
`Fetcher`, with `maxBytes: FETCH_LIMITS.image` and
`acceptContentTypes: ['image/jpeg']`. Requests are **single-flighted per
handle** with a TTL of one refresh interval, so three screens polling the
same doorbell cost Home Assistant one fetch. That is the plumbing proof the
first draft wanted from Tier A, done honestly: the table, the handle, the
gate, the widget and the fallback all ship with zero new outbound surface,
and the stream mode arrives with Tier B and is used by the hub alone.

### 5.5 The stream port lives in core

Rule 1 keeps `packages/core` free of Node, and the existing `Fetcher` port
returns a string. A stream port needs a shape core can express without a
new global, and an async iterable of byte arrays is exactly that — ES2018,
nothing to add to `globals.d.ts`:

```ts
export interface StreamRequest {
  readonly url: string;
  readonly policy: UrlPolicy;
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent: string;
  readonly connectTimeoutMs?: number;
}

export type StreamOutcome =
  | {
      readonly status: 'ok';
      readonly contentType: string;
      readonly chunks: AsyncIterable<Uint8Array>;
      close(): void;
    }
  | { readonly status: 'rejected'; /* the Fetcher's rejection codes */ }
  | { readonly status: 'failed';   /* the Fetcher's failure codes   */ };

export interface StreamFetcher {
  open(request: StreamRequest): Promise<StreamOutcome>;
}
```

The server implements it by **factoring** the pieces of
[`net/fetcher.ts`](../apps/server/src/net/fetcher.ts) that make a fetch safe
— `resolveAndCheck`, `validateRedirect`, `isCrossOrigin`, `SENSITIVE_HEADERS`
— into helpers both fetchers call, rather than by copying them. A copy is a
second SSRF guard that drifts. Redirects on a stream follow the same rules
as today's, hop by hop, with the sensitive headers stripped on any
cross-origin hop; the body of the final hop is the stream. The
`connectTimeoutMs` bounds the handshake and nothing after it, because after
it the hub's own timers apply.

## 6. Cameras, handles and the gate

### 6.1 A camera is not a reading

The first draft put `camera` into `SUPPORTED_DOMAINS` and then said it would
not flow through `toReading()`. It would have. `isSupported` is what
`parseStates` filters the poll with and what the watched-entity form checks
on add, so anything in that list becomes a reading — and
[`entities.ts`](../apps/server/src/modules/homeassistant/entities.ts) already
records the shape of this mistake at length: `calendar` was in the list, put
"Bins · On" on the wall, and was taken out because "the thing a household
means is not a reading". A camera entity's state is `idle`, `recording` or
`streaming`, and a chip reading "Front door · idle" is the same fault with a
worse picture.

So cameras are **their own list**. A small additive migration adds
`ha_cameras`: `id`, `handle`, `entity_id`, `created_at`. The Home Assistant
screen gets a **Cameras** section beside the watched entities, listing the
`camera.*` entities out of the same `/api/states` fetch the picker already
makes, filtered by a second, camera-only domain list. Adding one mints the
handle; removing one deletes the row and drops that handle's subscribers.
`SUPPORTED_DOMAINS` and `parseStates` are untouched.

**Availability comes from the poll that already runs.** The thirty-second
states poll reads every entity in the house and keeps the supported ones; a
second, narrower reader over the same body asks only whether each watched
camera is present and not `unavailable`, and the module stores the answer.
The Home Assistant panel slice carries it —
`cameras: [{ handle, available }]` — so a wall can draw the placeholder
without ever opening a stream, and the route refuses an unavailable camera
with a `503` so an older bundle that ignores the flag cannot hammer the
house. A camera widget on a household with no Home Assistant connection is
omitted with the same reason a readings widget is: `WIDGET_MODULE` maps it
to `home`, and `widgetIsSetUp` does the rest.

### 6.2 The handle

The handle is minted with the same generator the display and setup tokens
use, and it is **an identifier, not a credential**. The display token is the
credential; the handle's unguessability is belt and braces, so that a URL in
a screenshot or a support thread names nothing. Nowhere the wall can see
carries `camera.front_door`: not the manifest, not the widget config, not the
URL, not a log line. The existing "sends the wall a value and never a way to
ask for another" assertion extends to seed a camera, render the manifest and
assert the entity id is absent and the handle present.

### 6.3 Placement is the canvas

The first draft asked for a placement column and a per-screen switch, on the
model of `screens.allow_dismiss`. Both duplicate something the product
already has. RFC 005 gives every screen its own canvas, or one it *follows*
by an explicit choice on that screen's page (`panelCanvasOwner`,
`effectiveDisplay` in [`queries.ts`](../apps/server/src/api/queries.ts)) —
so "which screens show this camera" is already answered by where the
household dragged the widget, and a second copy of that fact is the
`shifts[0]` bug in a new costume. A wall that follows the household's default
canvas shows what is on it, which is the household's choice; the Walls page
lists **"Cameras on this wall"** so that choice is visible rather than
inferred.

The `allow_dismiss` analogy was also the wrong one: those switches are about
*input* from a screen — whether a passing sleeve can clear a warning — and a
camera is output. There is no switch.

### 6.4 The route

`GET /d/camera/:handle/stream` and `GET /d/camera/:handle/still`, in order:

1. **The screen gate**, inherited: `app.use('/d/*', requireScreen)` already
   refuses an unpaired caller with `401` and puts the screen on the context.
2. **Placement**: resolve the screen's effective canvas with
   `effectiveDisplay`, read its widgets in **both** orientations (the gate
   cannot know which one the screen is drawing), and require a `camera`
   widget whose config carries this handle. Otherwise **`404`** — not `403`.
   Nothing tells a screen that a handle it was not given exists. This is the
   opposite call from `lan_only`'s `403`, deliberately: there the caller had
   already proven possession of the secret for that very resource.
3. **Resolution**, server only: handle → entity id, then `resolveConnection()`.
4. **Availability**: an unavailable camera answers `503` with a kitchen
   sentence and never the entity id.
5. **Caps** (§5.2): a refused subscription answers `503` likewise.
6. **The answer**: `multipart/x-mixed-replace` under our boundary, or one
   JPEG; `cache-control: no-store` on both, because `/d/media` sends a
   day-long public cache header and a snapshot that came out of the browser
   cache is a picture of nothing; `x-content-type-options: nosniff` as
   `/d/media` already does. The socket closing unsubscribes.
7. **Revocation closes streams.** Setting `screens.revoked_at` drops every
   subscription that screen holds within a second; the hub is keyed by screen
   as well as by handle for exactly this. A stolen tablet's picture ends when
   the household says so, not when the socket next happens to reconnect.

### 6.5 What the widget stores

`camera` joins `WIDGET_TYPES` in
[`api/manifest.ts`](../apps/server/src/api/manifest.ts) as a first-party
renderer — the allowlist is where rule 3 lives, and this is a first-party
block drawing a first-party-proxied picture, not a video-URL widget, and it
must stay that way. `widgetConfigBody` in
[`widget-schema.ts`](../apps/server/src/api/widget-schema.ts) is `.strict()`,
so the keys are declared there, rejected not coerced:

| Key | Values | Absent means |
|---|---|---|
| `camera` | a handle, by its alphabet | the widget is empty and says so |
| `cameraMode` | `snapshot` · `stream` | `snapshot` |
| `cameraRefreshSec` | 1–60, snapshot only | 3 |
| `cameraFit` | `cover` · `contain` | `cover` |

plus `title` and `showTitle`, which every widget has and which is the
household's name for it. There is no label column: the widget title is the
one string the wall sees.

Three things in it are load-bearing. **Entity to handle happens once, on the
Home Assistant screen, at add time** — the editor's inspector offers a
`<select>` of the household's cameras by title with a handle as its value, so
neither the editor's markup nor the manifest ever holds an entity id. **The
mode is per placement, deliberately**, which the first draft's own reasoning
already implied: "a household on a slow box may want snapshots" is a fact
about a screen, and the same doorbell can stream on the kitchen tablet and
refresh on the Pi in the hall. And **a handle whose row is gone flags the
widget** in the editor the way `omission.ts` flags a widget the wall leaves
out — "This camera was removed from Home Assistant settings" — rather than
drawing a box that fails quietly.

## 7. The display side

### 7.1 The wall clears itself every fifteen seconds

`main.ts` draws on `TICK_MS` and polls on `POLL_MS`, and every renderer
begins `root.textContent = ''`. That is a design rather than an accident —
the whole wall is rebuilt from the model so nothing measured is ever kept —
and it means anything living inside the drawn subtree is destroyed and
recreated four times a minute. For a stream that is a reconnect four times a
minute on every screen, a flash to blank each time, and a hub whose
subscriber count never settles. The first draft's "bare `<img>`" is that
bug.

The precedent for surviving the clear is already in the file, and its
comment is worth reading before touching this: the a11y live region and the
focus control live **outside the subtree that is cleared** and are updated
**keyed on what they are for rather than on the redraw**, because a live
region recreated every draw would read a household a tornado warning four
times a minute. A camera is the same hazard with pixels.

### 7.2 The live layer

The drawing surface moves one level down: `#wall` keeps the rotation
transform it carries today and holds two children, a drawing root that the
renderers clear as they always have, and a **live layer** beside it that is
created once and never cleared. The layer holds one `<img>` per camera widget,
keyed by handle and orientation. On every draw `main.ts` reconciles rather
than rebuilds: create a picture the model gained, reposition one it kept,
remove one it lost, and set `src` **only when it changes** — so a stream
opened at boot is the same stream ten thousand ticks later.

Two properties make the layer honest rather than merely working:

- **It is positioned by the same arithmetic the canvas uses.** The box a
  widget occupies — the letterboxed canvas rect, then the widget's fractional
  box within it — is one exported pure function, and both `renderFreeform`
  and the layer call it. A test holds a picture's rect to its canvas box to
  the pixel at three viewports and under a quarter turn, because a layer that
  is one pixel off is a picture with a hairline of the box's chrome showing
  through, and nobody would report it as broken.
- **It is visible only while a plain canvas is showing.** A takeover, a
  banner, the pairing form and the boot or fault message are all drawn in the
  root, over the canvas, and a camera box may sit under any of them. The
  layer is hidden whenever the draw was anything but the freeform wall, so a
  tornado warning is never behind a doorbell. That costs a household the
  picture for as long as a banner is up, which is correct.

The canvas still draws the widget's **box**: the chrome, the title, and a
placeholder body underneath the picture — "Waiting for the first picture",
then "No signal" — so hiding the picture reveals a labelled box rather than
a hole. One limitation is stated rather than hidden: a widget the household
stacks *over* a camera is under the picture, because the layer is above the
root. A camera is a natural corner widget and this is unlikely to bite, but
if it does the fix is a reconciling renderer, which is a different change.

**Do not adopt a detached picture across draws instead.** The obvious cheaper
version pulls the `<img>` nodes out before the clear and puts them back
after. Some engines abort a picture's fetch when it leaves the document, the
wall targets several, and a design that works on the WebView it was tested on
is this project's most familiar failure. The layer avoids the question.

### 7.3 Rule 9 on the wall

Rule 9 is the hard part of the renderer, not the easy part. A dead camera
degrades to the labelled placeholder — never a black rectangle, which looks
deliberate, and never a hung load, which stalls nothing here because the
picture is out of the render path entirely. The picture's error handler
hides it and schedules a reload with backoff, five seconds doubling to a
minute; its load handler shows it again. A camera the manifest marks
unavailable is never requested at all. Snapshot mode runs its own timer per
picture, and re-requests by changing a counter on the query string — a
first-party URL, nothing personal in it — because a browser may not refetch a
`src` that reads the same. When the last successful load is older than three
refreshes a caption says so inside the picture's box, **out of flow**, because
nothing that annotates a widget may cost it a row. The calendar must not
notice any of this, and it cannot: a camera failing changes no model and
moves no box.

### 7.4 Geometry, tiers and the panel

The picture is `position: absolute; inset: 0` inside a box whose rect is a
function of canvas geometry alone, with `object-fit` from the widget's own
setting, so the reflow-stability contract holds **by construction**: two
walls, one with a frame and one without, have identical geometry, and
[`reflow-stability.test.ts`](../apps/server/test/reflow-stability.test.ts)
asserts it rather than assumes it. A camera has no density tier and needs
none — it joins the clock and the image in the "fills its box in CSS"
branch of `renderFreeform`. It carries no shadow and no rounded picture
beyond what the widget's own corner setting already does.

**On an e-paper panel a camera draws what the image widget draws**: the
bracketed placeholder and the title. There is no JPEG decoder on the panel
(`drawImage` says "not shown on eInk yet" for the same reason), and RFC 006
documents a battery panel as a glance class that should not be polling a
doorbell. `PANEL_HONOURS.camera` is `['title', 'showTitle']`, every other key
is in `PANEL_IGNORES`, `INK_LANE.camera` is empty, and
[`honours.ts`](../apps/server/src/epaper/honours.ts) is closed against
`widgetConfigBody`, so forgetting any of that is a build failure rather than
a control that does nothing. No existing frame moves, so
`EPAPER_RENDERER_VERSION` is unchanged. A dithered snapshot on a panel is a
real feature and a real decoder and belongs in its own decision (§12).

One trap is worth a sentence: `apps/display/test/motion.test.ts` holds every
module in `main.ts`'s import graph to carrying neither the word "transition"
nor the word "animation", comments included. A camera module will want to
write both. It must not.

## 8. Privacy, logs and what a token is worth

- **No entity id and no camera title reaches a log or the diagnostics
  export.** Counts only, and at most a handle's first few characters —
  "camera 1 of 2 reconnected". The export is built to be safe to hand to a
  stranger, and "front door" is a fact about a house.
- **No frame is ever written to disk.** Not a cache, not a thumbnail, not a
  last-known image for the placeholder. The wall shows *now*; storing frames
  is a different product with a different threat model (§13).
- **A placed camera is visible to anyone holding that screen's token, until
  the screen is unpaired.** That is already true of the calendar and is why
  `add-screen --revoke` exists; §6.4 makes revocation end a stream at once
  rather than at its next reconnect. The Walls page says which cameras a
  screen shows, so a household deciding whether to pair a screen in a shared
  hallway is deciding with the facts.
- **`lan_only` is deliberately not extended to cameras**, for the reason it
  was not extended to `/d/manifest`: the display token is a cookie a browser
  does not give up the way a device gives up a URL. If that reasoning ever
  changes for the manifest it changes for cameras in the same commit.

## 9. The WebRTC decision

Home Assistant bundles go2rtc, and Reolink over WebRTC is the well-trodden
path, so this is a real option and worth pinning rather than hand-waving.
WebRTC wins on two axes — it is the only tier that is *actually* real-time,
and being a native browser API it costs no bundle under rule 3. It loses on
the two axes this project cares about most, and there is **no free
reconciliation**. You pick a shape:

**Shape 1 — server brokers signaling, media goes direct.** The server
(holding the token) does the SDP offer/answer with go2rtc and hands the answer
to the wall, which peers directly. Easy — a weekend. But the SDP answer
*contains go2rtc's ICE candidates*: Home Assistant's LAN address and port. The
instant the wall receives it, a compromised tablet knows how to reach Home
Assistant and has a live media socket into it. WebRTC media is secured by the
DTLS keys from signaling, not a revocable token, so there is nothing to scope
or expire on that leg. **This breaks the blast-radius model** — the one thing
the whole module is built to hold — and it does so quietly, which is the
worst way. We do not ship Shape 1.

**Shape 2 — the server relays the media.** Browser peers with our container;
our container peers with go2rtc; we forward SRTP between the legs (or run a
TURN relay so the wall's candidates only ever point at us). This *keeps* the
model: Home Assistant's address never reaches the wall. But now the single
container is a **real-time media server** — a Node WebRTC stack (`werift`,
`wrtc`, mediasoup, all heavy or half-maintained native deps), per-stream CPU
on the small box this runs on, and UDP/ICE that has to work through the
supervisor network under ingress. That is a large departure from "one
container, if you think you need Redis you don't", and by this project's own
history it is exactly the class of thing only a real Home Assistant
supervisor would shake the bugs out of.

**And the read-only question, separately.** Signaling is a `POST`/WebSocket
exchange whichever shape you pick. An SDP offer changes no *device* state —
it negotiates a session, it does not unlock a door — so it arguably keeps the
*spirit* of rule 12. But it crosses the line
[`client.ts`](../apps/server/src/modules/homeassistant/client.ts) draws in
ink ("nothing here issues a POST"), and given the token controls the house,
that is a carve-out to document and defend, not to discover in a diff.

So the WebRTC position is: **not now, and not without a decision.** If it is
built, it is Shape 2, and the read-only exception is written down first.
Where it would genuinely earn the media-relay cost is two-way audio (talk
back through the doorbell) — but that is an audio *uplink*, squarely a
control action on the wrong side of rule 12, and out of scope until
read-only is deliberately revisited. Everything Tier C needs downstream —
the widget, the gate, the live layer, the hub's caps — is built by the end of
Tier B, so the marginal work is only the media leg, which is the honest place
to weigh it.

## 10. What we build, in order

0. **The hub, with nothing on the wall.** The frame parser, the stream port
   and its server implementation with the guard helpers factored out of
   `net/fetcher.ts`, and the hub with its caps and timers — tested against a
   real local multipart server (§11), not a stub. No UI, no migration, no
   route. This is where every streaming subtlety lives and it is proven
   before anything depends on it.
1. **Tier A, end to end.** The `ha_cameras` migration, the Cameras section
   on the Home Assistant screen, the `camera` widget type and its schema
   keys, the `/still` route with the gate, the live layer, the placeholder on
   the wall and on the panel, the honours tables. A real product on its own:
   "front door, refreshed every few seconds", with zero new outbound surface.
2. **Tier B.** The `/stream` route on the hub, `cameraMode: stream` in the
   inspector, and the snapshot path answering from the hub when a stream is
   open. On a Reolink this is §4's "two frames a second on one socket"; on a
   camera with a native stream it is live.
3. **Hardware, and the measurements that decide the defaults.** The
   supervisor proxy holding one response open for ten minutes. The measured
   cadence of the actual Reolink through both endpoints. The picture on an
   Android WebView and on one WebKit device. A photograph of the wall. The
   snapshot-vs-stream default and the §5.2 constants are settled here and
   not before.
4. **Optionally: the doorbell shows the door.** A press is already a
   `binary_sensor` that reaches the interrupt model through `signals()`, so a
   rule can take the wall over with the camera for thirty seconds and hand
   it back. No new trust, rule 12 untouched, and it is what makes a small
   corner widget worth having: quiet most of the day, full-screen when it
   matters. It needs the interrupt to carry a widget for the first time,
   which is its own small decision (§12), and it is deliberately last.

Tier C is not on the list. §9 says when it would be.

## 11. How this gets proven (verification is the job)

In the spirit of `CLAUDE.md`'s bug table — the checks that would actually
catch the failures this design invites, each with the failure it exists for:

- **The parser, against captured bytes.** Real multipart output from a real
  source, split at **every** byte offset and reassembled, must yield
  identical frames — a parser that works at one chunking is a parser that
  works on one network. A boundary that does not match its header, a
  `content-length` that lies, a first frame sent twice, and a frame over the
  cap each fail the way §5.1 says.
- **The hub, against a real local multipart server**, never a stub, because
  a mocked stream passes over every timeout and every backpressure bug. Two
  subscribers with one that never reads, asserting the fast one keeps
  receiving and the upstream count is one. Silence past the idle timeout
  reconnects with no error reaching a subscriber. An upstream killed
  mid-frame is invisible to a subscriber. The last subscriber leaving closes
  the upstream after the grace and not before. Max duration reconnects
  seamlessly. Revoking a screen ends its stream inside a second.
- **The route, through the real app.** No token is `401`. A paired screen
  whose canvas lacks the handle is `404`. The secrecy assertion extended to a
  seeded camera: no `camera.`, no `front_door`, no base URL, the handle
  present. An unavailable camera is `503` with a sentence and no entity id.
  A redirect off-origin in stream mode drops the `authorization` header,
  driven by a real redirecting server. Both responses carry `no-store`.
- **The wall, on a real paired screen.** **One upstream over a full minute
  of ticks** — the assertion that fails the first draft, and the one to write
  first. Pixels change, against a fake source that stamps a counter into
  each frame. Killing the source shows the placeholder, and the calendar's
  geometry before and after is identical to the pixel. A takeover hides the
  picture. Geometry with and without a frame is identical, in the
  reflow-stability file. Snapshot mode refreshes at the configured cadence
  and never from the cache, counted at the fake source. The picture's rect
  matches its canvas box at three sizes and under a quarter turn.
- **Hardware**, listed as unproven until done and in the order §10 phase 3
  gives. A fake Home Assistant that streams proves the hub; by this project's
  history the supervisor is where it will actually break.

## 12. Open decisions

- **Snapshot or stream by default.** Decided by the phase-3 measurement, not
  here. Until it exists the default is snapshot, because on the camera that
  prompted this the two converge and snapshot holds no socket open through
  the supervisor.
- **"Tier B+" through go2rtc's own outputs.** MSE or fMP4 would be smoother
  and lighter than MJPEG and would need Media Source Extensions plus a little
  script on the display — a smaller rule-3 question than HLS, not zero. It is
  not an option until somebody has shown those outputs are reachable through
  `core/api` at all (§4).
- **Tier C at all.** Is a true-live doorbell worth a media-relay subsystem
  and a documented read-only carve-out, or is Tier B "live enough" forever?
  This RFC recommends deferring, not deciding.
- **The interrupt that carries a widget** (phase 4). Today an interrupt is
  text with a severity. A takeover that draws a camera is the first with a
  payload, and whether that is a `handle` on the interrupt or a rule action
  that names a widget is a small decision with a long tail.
- **A 1-bit snapshot on a panel.** Worth doing, not free: a baseline JPEG
  decoder is the kind of thing `qr.ts` and `png.ts` already are — draw what
  nobody else supplies — and belongs beside them if it is built.

## 13. Non-goals

- **Recording, history, or a last-known frame on disk.** The wall shows now.
- **Two-way audio, pan/tilt, or any control.** Every one of those is a write
  to Home Assistant, and rule 12 is not a setting.
- **Cameras that are not in Home Assistant.** A plain MJPEG or RTSP address
  would be a user-supplied URL through the SSRF guard, like a calendar feed,
  and could sit behind the same hub — but it is a second source with its own
  settings and its own failure modes, and it is not this RFC.

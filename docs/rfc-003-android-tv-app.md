# RFC 003 — The Android / Google TV app

Status: **draft** · Owner: — · First drafted 2026-08-12 ·
Relates to `apps/display`, `apps/server/src/api/push.ts`, `apps/server/src/http/app.ts`

## Summary

A native app for Android and Google/Android TV that turns a television or a
wall-mounted tablet into a Maverick Wall screen — one that boots straight into
the calendar, stays on, pairs without anyone typing an IP address, and can turn
a dark screen **on** for a tornado warning.

It is a **kiosk shell, not a second renderer.** The calendar is `apps/display`,
loaded over the LAN exactly as a browser screen loads it today. Native code owns
only the five things a browser cannot do on a wall: keep the screen on and in
the foreground, start on boot, wake a dark screen, give a remote's OK button a
target, and discover-and-pair without a hand-typed address.

Four decisions frame everything below:

1. **WebView kiosk shell**, reusing `apps/display` — no reimplementation of the
   renderer.
2. **One APK for both TV and mobile/tablet**, adapting per form factor.
3. **Self-hosted socket + local wake** — build the WebSocket server the push
   contract already anticipates; no FCM, no cloud.
4. **Discovery + device-flow + QR pairing, LAN-only** — mDNS to find the server,
   a device-authorization flow to get a token, a QR that only ever encodes the
   LAN address the app actually reached.

And, added from the start rather than retrofitted:

5. **HTTPS is supported everywhere and mandated nowhere.** http stays the
   default; the app makes self-signed HTTPS *secure and invisible* on a LAN by
   pinning the cert it saw at pairing. The server learns to sit correctly behind
   TLS. No mandate, and **no HSTS, ever** — see [§7](#7-transport-security-https).

## The one thing we do not build

We do not rebuild the renderer. Every one of the bugs catalogued in `CLAUDE.md`
lived in the display or the server — `viewmodel.ts`, `orientation.ts`,
`render.ts`, the manifest, the interrupt pipeline, the QR encoder. A Compose
rewrite would clone all of that into a second place where those bugs get to live
again, and would drift from what a browser screen shows the day after it ships.

So the WebView loads the display **from the server origin** (`http://<server>:8080/`),
not from bundled assets. This is the load-bearing decision:

- Relative `fetch('/d/manifest')`, `/pair`, `/d/media/:name` and
  `/d/interrupts/dismiss` resolve against the server with **zero code changes** —
  the same paths `apps/display/src/main.ts` already calls.
- The display token lives in the `DISPLAY_COOKIE` that `/pair` already sets
  (`app.ts` — `Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000`). The app
  pairs by pointing the WebView at `/pair?token=…`, reusing the exact flow a
  QR-paired browser screen uses.
- Themes, portrait/landscape, per-screen rotation, the IndexedDB manifest cache
  in `store.ts`, the 60-second poll and `watchdog.ts` — all inherited, all in
  lockstep with web screens forever.

The version to refuse is "the app knows how to draw a calendar." It must not.
It knows how to host the thing that does.

## Architecture

```
 device boot ─▶ BootReceiver ─▶ KioskActivity ───────────────┐
                                   │ hosts                    │
                                   ▼                          │
                              WebView  ── loads ──▶  http(s)://<server>/   (apps/display)
                                   ▲                          │  ▲
                        JS bridge  │ "re-poll" / "wake"       │  │ /d/manifest (60s, ETag)
                                   │                          │  │ /pair, /d/media, dismiss
                              PushService ── WSS/WS ──────────┘  │
                             (foreground svc)   push channel     │
                                   │                             │
                            WakeLock + turn-screen-on            │
                                                                 │
   NsdManager (mDNS) ─ discover ─▶ device-flow pairing ─ token ─┘
```

The WebView is the wall. `PushService` is a foreground service holding the push
socket; when a `wakeScreen` interrupt arrives it takes a wake lock and turns the
screen on, then nudges the WebView to re-poll. Pairing is a one-time native flow
that ends by handing the WebView a `/pair?token=…` URL.

## Project layout

A Gradle project at **`apps/android/`**, excluded from the pnpm workspace:

```
apps/android/
  app/
    src/main/
      AndroidManifest.xml        # MAIN/LAUNCHER + LEANBACK_LAUNCHER; touch + leanback both optional
      java/…/KioskActivity.kt    # WebView host, lock-task, keep-awake, D-pad → WebView
      java/…/BootReceiver.kt     # BOOT_COMPLETED / QUICKBOOT_POWERON → KioskActivity
      java/…/push/PushService.kt # foreground service: WS(S) client, wake lock, screen-on
      java/…/net/ServerFinder.kt # NsdManager mDNS discovery
      java/…/net/CertPin.kt      # trust-on-pairing cert pinning (WebView + OkHttp)
      java/…/pairing/…           # device-flow UI (Compose): code + QR + status
      res/                       # TV banner, "connecting…" status screens
  build.gradle.kts
```

**In the monorepo, on purpose.** `CLAUDE.md` prizes "one tag, one image, all
three agree." Keeping the app beside the server and display means a release tags
one commit and the three cannot disagree. A CI step asserts the app's compiled
`PUSH_PROTOCOL_VERSION` equals the constant in `api/push.ts` — the file's own
comment warns that a shipped app with a stale message shape is a tablet in a
hallway that never wakes for a tornado warning. The alternative, a separate repo
(the eventual home of `packages/calendar`), loses that lockstep and is not worth
it while the socket contract is still being written.

Baseline: Kotlin, `minSdk 24` (old wall tablets), current `targetSdk`,
`androidx.leanback` only for the TV launcher card, Compose for the pairing and
status chrome — never for the calendar.

## Rendering, offline, and rule nine

Rule nine is absolute: never a blank screen, never a refusal to start. Three
layers carry it, native-first:

1. The display already renders its last manifest from IndexedDB **before** the
   first poll, and survives the server coming and going while loaded — the
   common wall case (`CLAUDE.md`: "a wall that stays loaded for months while the
   server comes and goes underneath it").
2. Set the WebView `cacheMode = LOAD_CACHE_ELSE_NETWORK` on load failure, so the
   shell HTML/JS serve from WebView's own disk cache at a cold boot with the
   server down. There is no service worker to lean on — a SW needs a secure
   context and will not register over plain http, which is the ordinary LAN
   case; the app's native offline is what replaces it.
3. If the WebView cannot load at all (never cached, server unreachable), the
   native shell shows a **branded "connecting to `<server>`…" status screen**
   with backoff-retry, and hands over the instant `/healthz` answers. A native
   status screen is not a blank one, and it is the app honouring rule nine in
   the one place the web display cannot reach.

Rendering a *cached calendar natively* at a first-ever cold boot — bundling
`apps/display/dist` into the APK — is a **stretch goal**. The obstacle is the
WebView cross-origin footgun (a bundled `file://` page fetching `http://server`),
and the native status screen already satisfies rule nine, so this waits.

## The five native jobs

**Keep the screen on and in front.** `FLAG_KEEP_SCREEN_ON` plus a `SCREEN_BRIGHT`
wake lock while the wall is showing. Immersive-sticky fullscreen, system bars
hidden. Lock-task mode (`startLockTask()`) for locked-down installs, documented
via the device-owner provisioning path but never *required* — households
sideload, and a hard lock-task requirement would strand them.

**Start on boot.** A `BOOT_COMPLETED` receiver (and `QUICKBOOT_POWERON` for OEM
TVs) launches `KioskActivity`.

**Wake on a takeover.** `PushService` holds the socket. On an `INTERRUPT_PUSH`
with `wakeScreen: true`, acquire `FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP`, call
`setTurnScreenOn(true)`, dismiss the keyguard, bring the activity forward. The
app reads `wakeScreen` and `piercesNightMode` as **separate** fields off each
interrupt — `api/push.ts` is explicit that anding them made
`takeover_and_wake` with `piercesNightMode:false` a silent no-op. A browser
screen ignores `wakeScreen` entirely; the app is the only client that acts on
it.

**Give the remote an OK.** Map D-pad `CENTER` / `ENTER` into the display's
existing acknowledge handler — `main.ts` already binds `Enter` and focuses the
control when its target changes, because the focus ring is the only affordance
on a wall with `cursor: none`. BACK / `Escape` is deliberately **not** bound to
dismiss: Android BACK sends Escape and must not clear a warning nobody has read.
Whether the control is even offered stays the server's `screens.allow_dismiss`,
per screen.

**Own nothing about layout.** Rotation and orientation are applied in-page from
`screens.rotation` and `screens.orientation`; the app lets the WebView fill the
panel and does no rotation logic of its own. One source of truth.

## Discovery and pairing

The owner's standing objection (memory: *pairing must be frictionless*) is no
hand-typed addresses and no port hunting. The flow:

**Discovery (mDNS, LAN-only).** The server advertises `_maverickwall._tcp` with
host, port, and instance name (new server work — [§8](#8-server-side-work)). The
app browses with `NsdManager`, lists servers by name, resolves to `host:port`.
Manual host entry is the fallback for segmented or guest Wi-Fi where mDNS is
blocked — a UX degrade, never a dead end.

**Device-authorization flow** (the "sign a TV into an account" pattern), so a
token lands on the *TV* with no typing and nothing leaving the LAN:

1. App discovers the server → `POST /d/pair/device-start` → `{ deviceCode,
   userCode, verifyUrl, pollInterval }`.
2. The TV shows the short `userCode` **and** a QR encoding `verifyUrl`
   (`http://<discovered-LAN-host>:8080/admin/screens/approve?code=…`). The QR
   host is the address the app actually connected to, so it is LAN-reachable by
   construction — this is the direct fix for the bug in `CLAUDE.md` where a
   pairing QR carried the supervisor's internal Docker address and scanned as a
   dead link.
3. The household approves either way — type `userCode` at `/admin/screens`, or
   scan the QR with a phone already on the LAN and approve behind the normal
   session.
4. The TV polls `POST /d/pair/device-poll {deviceCode}`; on approval it receives
   the display token, hands it to the WebView via `/pair?token=…`, and starts
   drawing.

The QR is a convenience over the code; both terminate at the household's own
server and neither works or is needed off-LAN.

**Shipping order.** v1 can consume the *existing* pairing (admin creates a
screen at `/admin/screens`, the app reads the code/link) so the kiosk ships
before the device-flow endpoints exist. Device-flow is the Phase 3 polish that
removes the last manual step.

## Steady state and push

The WebView polls `/d/manifest` every 60s with an ETag, unchanged. `PushService`
holds the socket:

- `MANIFEST_CHANGED` → nudge the WebView to re-poll now (JS bridge) instead of
  waiting out the interval.
- `INTERRUPT_PUSH` → wake if `wakeScreen`, then re-poll.

The socket is an **optimization, never a dependency.** If it drops, polling
still carries interrupts in the manifest — which is how a reconnecting display
gets them today (`CLAUDE.md`). The app degrades to exactly the web screen's
behaviour.

## 7. Transport security (HTTPS)

The position: **support HTTPS everywhere, mandate it nowhere.** A mandate
collides with rule nine (a cert misconfig or a silent expiry becomes a blank
wall) and rule eleven (renewal fails on a box nobody can reach). But the native
app is the one client that can make self-signed HTTPS both secure and invisible
on a LAN, so we build for that from the start rather than bolting it on.

### What HTTPS actually buys us here

- **Confidentiality on the LAN.** Today anyone on the Wi-Fi can read the
  manifest (calendar contents, "garage · open", indoor temperature) and sniff
  the display token, then replay it. The blast radius is already capped by
  design — the manifest carries no HA entity id, no base URL, no control token —
  so this is "someone on your Wi-Fi saw your calendar," not house takeover. Real,
  but bounded.
- **Integrity** — no MITM injecting into the manifest or the display bundle.
- **Secure-context web features** matter far less here than usual, because the
  app already provides offline, boot-start and wake **natively** — the
  service-worker-needs-https limitation that bites browser screens simply does
  not apply to the app. HTTPS's headline web benefit is the thing the shell
  replaces.

### Why mandating is wrong on a private LAN

A cert is bound to a name, and households reach the box by `192.168.x.x` or
`something.local`. Public CAs will not issue for private IPs or `.local`, and
the ones that would need a public domain with exposed DNS or port 80 —
contradicting "no cloud, works with no internet." That leaves self-signed or a
local CA; a local CA means installing a root on every device, which is
impossible on a wall-mounted kiosk TV and a flat violation of "assume you can
never reach the user's machine." And under Home Assistant ingress the supervisor
already terminates TLS and proxies plain http inward — originating TLS in the
container would double-terminate and break that path.

### How it works — mechanisms, ranked for this project

1. **App-side cert pinning / trust-on-pairing (the one that fits).** During
   pairing the app is already talking to the discovered LAN address. Capture the
   server's cert fingerprint then, store it, and pin it in both
   `WebViewClient.onReceivedSslError` and the OkHttp/WSS client. A self-signed
   cert is now fully secure for the app — no CA, no household action, no warning
   — because the app trusts *exactly that one cert*. This is precisely what a
   browser cannot do and the native app can. Browser screens stay on http; the
   app path gets confidentiality for free. A re-pair re-pins if the cert ever
   changes.
2. **Fronted by a user-supplied reverse proxy** (Caddy/Traefik/NPM with the
   household's own domain). Power-user path. The server's only job is to sit
   correctly behind it — see the server work below. Never originate TLS in the
   container for this.
3. **HA ingress** — already TLS upstream; left exactly as is.
4. **Auto-generated self-signed cert in-container, off by default.** Usable only
   by the app (via #1); browser screens would choke on it. Low priority.

### The gotchas, each written down so nobody re-discovers them

- **Mixed content kills the socket.** An https page cannot open a `ws://` socket
  — the WebView blocks it. The moment the display loads over https the push
  socket **must** be `wss://`. Scheme has to be consistent end to end; a
  half-migration silently kills push. The client derives the socket scheme from
  the page scheme.
- **The display cookie is not `Secure` today** (`app.ts`:
  `DISPLAY_COOKIE_ATTRS`). Serving https keeps it working, but it is still sent
  over http — no downgrade protection. Set `Secure` **conditionally on the
  effective scheme**, never unconditionally: an unconditional `Secure` means
  every http screen loses its cookie and cannot pair — an instant rule-nine
  brick.
- **Scheme is derived from `c.req.url`** (`app.ts` builds origins and the CSRF
  origin check that way, and there is no `X-Forwarded-Proto` handling anywhere
  today). Behind a TLS proxy the server sees http and builds `http://` redirects
  and origins, breaking the cross-origin guard and every absolute link. It must
  trust `X-Forwarded-Proto` — but only from a **configured proxy source**,
  exactly as ingress already refuses to trust `X-Ingress-Path` except from the
  supervisor's socket address. A forgeable header is not a credential.
- **Never set HSTS.** On a self-signed LAN box HSTS is a self-inflicted brick:
  once a browser pins "https only" for this host, any drop back to http or any
  cert change locks the household out with no in-product recovery. This gets a
  comment in the source so nobody restores it as a "hardening" fix — the same
  shape as the `USER node` comment in the Dockerfile.
- **Cert rotation/expiry** on an appliance nobody logs into is a silent
  months-later failure. Pinning plus a long-lived self-signed cert avoids the
  renewal treadmill; the SAN must include both the IP and the mDNS name or the
  pinning UX gets noisier.
- **The pairing code is the juiciest thing to sniff**, and short-lived
  single-use device-flow codes protect it *regardless of transport*. That
  hardening lands first, before any TLS.

## 8. Server-side work

This app is not purely client work; it needs three additions to `apps/server`,
each built the way the repo insists — a test that drives something real, not a
stub (the `requireSession`-forwarded-no-headers lesson):

1. **The WebSocket server.** The endpoint that emits `PushMessage`
   (`api/push.ts` already fixes the shape and the protocol version). Screens
   connect with the display token; auth reuses `requireScreen`. Under ingress
   `ingress_stream: true` is already set for exactly this. This closes the
   long-standing "not started: ws push." Test: a real socket, a real token, a
   seeded interrupt delivered end to end.
2. **mDNS advertiser.** In-process service registration (host/port/name),
   guarded for the add-on's host networking versus plain `docker run`.
3. **Device-flow endpoints.** `/d/pair/device-start`, `/d/pair/device-poll`, and
   an admin approve action. Zod-validated at every boundary (rule five),
   rate-limited (rule ten), codes short-lived and single-use.
4. **TLS-behind-a-proxy correctness** (from §7): trust `X-Forwarded-Proto` only
   from a configured source, derive origin/redirects/cookie-`Secure` from the
   effective scheme, allow an `https://` `BASE_URL`. No in-container TLS
   origination in v1, and **no HSTS**.

## TV versus mobile in one APK

- **Manifest:** both `LEANBACK_LAUNCHER` (TV) and `MAIN/LAUNCHER` (touch)
  entries; `uses-feature android.hardware.touchscreen required="false"` and
  `android.software.leanback required="false"` so one APK installs on both.
- **TV:** D-pad OK acknowledges; the focus ring is the only affordance
  (`cursor: none`); a banner drawable for the launcher card.
- **Mobile/tablet:** touch to acknowledge (the control is already a real
  `<button>`); a small native settings screen for host/pairing.
- Layout and orientation stay entirely server-driven per screen — a kitchen
  tablet and a hall television are mounted differently, and that is a fact about
  the screen, not the app.

## Security posture (against the hard rules)

- The app is just another display-token holder. A compromised hallway tablet
  keeps the blast radius at "someone saw my calendar / indoor temperature" — the
  manifest carries no entity id, no base URL, no control token, and a test
  asserts it.
- No third-party origins in the app's own traffic (rule three): no FCM, no CDN,
  no analytics. The WebView is locked to a URL allowlist so a hostile manifest
  cannot navigate it off the household server. The JS bridge is minimal.
- Plain http on the LAN stays supported; the app's cert pinning is what lets a
  security-conscious household upgrade to HTTPS without a CA dance.
- No secrets in the APK or logs (rule six).

## Testing (verification is the job)

Per the repo's own doctrine — prefer tests that touch something real:

- Instrumented tests on a real emulator/device: pair against a **real running
  server** over a temp SQLite database, draw a real manifest, fire a real
  `wakeScreen` over a **real socket**, and assert the screen turns on.
- Espresso/UiAutomator for the pairing flow and for a D-pad OK acknowledging a
  seeded, dismissible interrupt — and for BACK *not* clearing one.
- A CI assertion that the app's `PUSH_PROTOCOL_VERSION` equals `api/push.ts`.
- A cert-pinning test: point the app at a self-signed HTTPS server, confirm it
  connects when the fingerprint matches and refuses when it does not.
- Real-hardware checks mirroring `CLAUDE.md`'s pattern — an actual Google TV
  cold-booting into the wall, an actual tablet waking for a seeded tornado
  warning, an actual remote's OK clearing a banner. These are the ones that will
  find the real bugs.

## Phasing

- **Phase 0 — Server socket + mDNS + TLS-behind-proxy. ✅ shipped.** The
  WebSocket server, the mDNS advertiser, and `X-Forwarded-Proto` trust, each with
  real-connection tests. Nothing app-side depends on a stub.
- **Phase 1 — Kiosk shell MVP. ✅ shipped.** WebView loads the server; keep-awake,
  boot-start, lock-task, the native "connecting…" fallback. A usable wall on day
  one.
- **Phase 2 — Wake + remote + HTTPS pinning. ✅ shipped.** `PushService` socket
  client, `wakeScreen`/`piercesNightMode` handling, D-pad OK → acknowledge, and
  trust-on-pairing cert pinning.
- **Phase 3 — Frictionless pairing. ✅ built.** mDNS discovery + device-authorization
  flow + QR, LAN-only. Server: `/d/pair/device-start`, `/d/pair/device-poll` and
  the session-gated `/admin/screens/approve`, with the in-memory device-flow store
  (`auth/device-flow.ts`) and an end-to-end test that drives a session-less screen
  and a signed-in household at once (`test/device-flow.test.ts`). App:
  `net/ServerFinder.kt` (NsdManager), `pairing/DeviceFlow.kt` +
  `pairing/PairingActivity.kt` (start → code + QR → poll → `/pair?token=`),
  `pairing/QrCode.kt` (offline ZXing). The security property that carries it: the
  8-character user code is only ever approvable from behind the household login,
  so a LAN attacker with the code can approve nothing. Still unproven on real
  hardware — a TV cold-pairing from the QR is the check that counts.
- **Phase 4 — Distribution & polish. ✅ built.** Signed APK on GitHub releases
  (sideload-first, matching the self-hosted ethos). `release.yml`'s `android` job
  builds `assembleRelease` with the release version injected and attaches
  `maverick-wall-X.Y.Z.apk` to the Release, from the same commit as the server
  image; the signing config is in `app/build.gradle.kts` and the key comes from
  repository secrets (`docs/releasing-the-app.md`). `KioskDeviceAdminReceiver` is
  the device-owner hook for lock-task; a TV banner drawable ships. Play Store /
  TV listing is deliberately later — it adds review/policy work and is not on the
  path to a working wall. Unproven until the first signed release actually runs
  the job and a household installs the APK.

## Decisions taken

- **Distribution: sideload-first.** A signed APK on GitHub releases, matching the
  no-cloud ethos. The Play Store stays a later option that adds review/policy
  work (TV quality guidelines, privacy declarations) and is not on the path to
  a working wall.
- **Auth: reuse the `/pair` cookie.** The app pairs by pointing the WebView at
  `/pair?token=…` and lets the existing `DISPLAY_COOKIE` carry the token —
  already tested, far less code than a bearer path, and the token never has to
  live outside the WebView.

## Open decisions

- **mDNS on segmented Wi-Fi.** Imperfect on guest/isolated networks; manual host
  entry is the always-available fallback, so it is a UX degrade, never a dead
  end.
- **Battery tablets that sleep.** Wall screens are plugged in, so a persistent
  socket is fine and the no-FCM decision costs nothing. If battery panels that
  deep-doze ever become a target, that is the one case where no-FCM costs wake
  reliability — flag it then, do not design for it now.

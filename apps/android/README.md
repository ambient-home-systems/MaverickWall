# Maverick Wall — Android / Google TV app

A **kiosk shell**, not a second renderer. This app turns a television or a
wall-mounted tablet into a Maverick Wall screen: it boots straight into the
calendar, keeps the screen on, and stays pointed at the household's own server.

The calendar itself is [`apps/display`](../display), loaded over the LAN from the
server exactly as a browser screen loads it. The native code here does only the
handful of things a browser tab on a wall cannot — see
[`docs/rfc-003-android-tv-app.md`](../../docs/rfc-003-android-tv-app.md) for the
full design and the reasoning behind "the one thing we do not build."

## What's implemented

**Phase 1 — the kiosk shell:**

- **A WebView kiosk** locked to the configured server origin, keep-awake,
  immersive fullscreen, BACK swallowed so the wall can't be navigated away.
- **Start on boot**, including the OEM `QUICKBOOT_POWERON` variants that cheap
  TV boxes send instead of `BOOT_COMPLETED`.
- **A three-layer offline story** (rule nine — never a blank screen): the
  display's own IndexedDB manifest, then the WebView disk cache, then a native
  "connecting to `<server>`…" status that hands back the instant `/healthz`
  answers.
- **Manual server-address entry** (`SetupActivity`). Pairing is then done by the
  display itself: read the code off the server's `/admin/screens` and type it on
  the wall.

**Phase 2 — wake, remote, HTTPS pinning:**

- **`PushService`** — a foreground service holding a WebSocket to the server's
  `/d/push` (the Phase 0 endpoint), authenticated with the display cookie. On an
  `INTERRUPT_PUSH` with `wakeScreen` it turns a dark screen on, shows over the
  keyguard, and re-polls so the warning is on the glass; on `MANIFEST_CHANGED`
  it just nudges a re-poll. The socket is an **optimisation, never a
  dependency** — against a server with no `/d/push` it degrades cleanly to
  poll-only and keeps retrying with backoff.
- **D-pad OK → acknowledge** — `DPAD_CENTER`/`ENTER`/`NUMPAD_ENTER` are forwarded
  into the display's `window.maverickWall.acknowledge()` bridge. BACK is not,
  deliberately.
- **Trust-on-pairing HTTPS** (`net/TlsPinning.kt`) — a self-signed LAN server is
  made secure by pinning the exact certificate seen at first connection, in both
  the socket (OkHttp) and the WebView (`onReceivedSslError`). http is untouched
  and never mandated; **no HSTS**.

**Phase 3 — frictionless pairing (mDNS + device-flow + QR):**

- **mDNS discovery** (`net/ServerFinder.kt`) — the app browses the LAN for
  servers advertising `_maverickwall._tcp` (the Phase 0 advertiser) with
  `NsdManager` and lists them to tap, so nobody types an address. Manual entry
  stays underneath as the always-available fallback for a segmented or guest
  network where discovery is blocked.
- **Device-authorization pairing** (`pairing/DeviceFlow.kt`,
  `pairing/PairingActivity.kt`) — the screen starts a flow at
  `/d/pair/device-start`, shows a short code and a QR of the approve link, and
  polls. The household approves from a phone (scan) or the admin Screens page
  (type the code) — **behind their login, which is the whole reason a short code
  is safe**. On approval the token is handed to the WebView via `/pair?token=…`,
  the same cookie exchange every other pairing ends with.
- **The QR only ever encodes a LAN-reachable address** — the server builds
  `verifyUrl` from a reachable origin (`base_url` under ingress), so it cannot
  carry an internal address that scans as a dead link. Drawn offline with ZXing
  (`pairing/QrCode.kt`); nothing is fetched.
- **Every exit honours rule nine.** A server too old for the flow (`404` →
  `Unsupported`), or a household that would rather type the code into the wall
  itself, both fall straight through to the display's own on-screen pairing.

**Phase 4 — distribution:**

- **Signed release APK on every stable release.** `release.yml` builds
  `assembleRelease` with the release version injected and attaches
  `maverick-wall-X.Y.Z.apk` to the GitHub Release — the same commit the server
  image is built from, so the app and the image never disagree. Sideload-first,
  no store. The signing config lives in `app/build.gradle.kts`; the key and
  passwords come from repository secrets, never the tree
  ([`docs/releasing-the-app.md`](../../docs/releasing-the-app.md)).
- **Device-owner kiosk hook** (`KioskDeviceAdminReceiver`) — present so a managed
  install can pin the wall with lock-task. A plain sideload never provisions it
  and runs unpinned, deliberately.

### Not yet (later phases)

- Play Store / TV store listing (adds review/policy work; not on the path to a
  working wall, so deliberately later).
- A real-hardware pass on the whole flow: a TV cold-pairing from the QR, and a
  signed release APK installed and upgraded on a device.

> **Phase 2 needs a push-capable server to exercise.** The socket, wake, and the
> D-pad bridge require a server built from `main` (or later) — it must have
> `/d/push` *and* serve the display bundle that carries the `window.maverickWall`
> bridge. Against an older server the app runs exactly as Phase 1 did.

## Building

Requires the Android SDK and JDK 17. The easiest path is **Android Studio**
(Koala or newer): open the `apps/android` directory and let it sync.

### With Android Studio (recommended)

Android Studio bundles its own JDK and installs the SDK for you — nothing else
to set up.

1. **Install it.** Download from
   [developer.android.com/studio](https://developer.android.com/studio) — pick
   the **Apple chip** build on an M-series Mac, **Intel chip** otherwise — or
   `brew install --cask android-studio`. Run it once and let the setup wizard
   install the SDK and platform-tools.
2. **Open `apps/android`** (that folder, not the repo root — it is a standalone
   Gradle project) and let Gradle sync. It offers to install any missing SDK
   pieces (`compileSdk 34`, build-tools) — accept.
3. **Build & run:** press ▶︎ against an emulator or a connected device, or
   **Build → Build APK(s)** for a sideloadable APK.

Seeing it against a **real dev server:**

- On the **emulator**, the host machine is reachable at `10.0.2.2`, not
  `localhost` — so enter `10.0.2.2:8080` on the app's setup screen. The emulator
  is fine for the setup screen and the phone/tablet layout; the boot-start and
  connecting-fallback behaviour are better judged on hardware.
- On a **real device** (the meaningful check), enter the server's LAN address,
  e.g. `192.168.1.10:8080`.

### From the command line

The Gradle wrapper is committed, so a clean checkout builds directly:

```bash
cd apps/android
./gradlew assembleDebug
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Install it
onto a running emulator or device with `adb install -r <that path>`.

> **If the build fails with `Type … is defined multiple times` (a dex merge
> error):** a file-sync tool (iCloud/Dropbox/OneDrive) has dropped `… 2.jar`
> duplicates into `build/`. This is the Android echo of the `… 2` sync
> collisions CLAUDE.md documents. Fix it with a clean — the outputs are
> disposable:
> ```bash
> rm -rf app/build build .gradle/configuration-cache && ./gradlew assembleDebug
> ```
> Keeping the working copy out of a synced folder avoids it entirely.

> This project lives in the monorepo so app, display and server tag as one
> commit, but it is **excluded from the pnpm workspace** — it builds with Gradle
> and the Android toolchain, never with pnpm. `pnpm test` does not touch it.

## Installing on a device (sideload)

For a real wall, download the **signed release APK** from the repository's
[Releases](https://github.com/ambient-home-systems/maverick-wall/releases)
(`maverick-wall-X.Y.Z.apk`) and install it — no build toolchain needed:

```bash
adb install -r maverick-wall-X.Y.Z.apk
adb shell monkey -p systems.ambienthome.maverickwall 1   # launch it
```

To install a local development build instead:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p systems.ambienthome.maverickwall 1   # launch it
```

On first launch it lists the servers it found on the network (mDNS) and offers a
field to type one (e.g. `192.168.1.10:8080`) if none appear. Pick or enter a
server and the app shows a **pairing code and a QR**: scan it with a phone on the
same network, or open your Maverick Wall settings and enter the code — approve it
there and the wall starts drawing. (An older server with no device-flow, or the
"pair on the screen instead" button, falls back to the previous flow: the wall
shows its own pairing screen and you type a code created at `/admin/screens`.)

### Kiosk lock-down (optional)

Lock-task mode (`startLockTask`) is used **only** where the device permits it
(device-owner provisioning). A plain sideload runs unpinned — deliberately, so a
household is never stranded by a hard requirement. To pin, provision the app as
device owner on a **factory-fresh device with no accounts** (Android's rule for
device owner, not this app's):

```bash
adb shell dpm set-device-owner systems.ambienthome.maverickwall/.KioskDeviceAdminReceiver
```

`KioskDeviceAdminReceiver` requests no policies — it exists only to become the
owner so lock-task is available. Once set, the kiosk pins itself with no
screen-pinning prompt. Unpinned kiosk works today without any of this.

## Verifying

Phase 1 has no automated tests yet — the meaningful checks are on real hardware,
per the project's doctrine:

- A TV box cold-booting straight into the wall.
- Pulling the server (or the network) and watching the native "connecting…"
  status appear and then clear on its own when the server returns.
- A wall that was loaded staying up (its cached calendar) while the server
  restarts underneath it.

Instrumented tests that pair against a real running server land alongside the
Phase 2 socket work, where there is behaviour worth asserting on a device.

## Layout

```
app/src/main/
  AndroidManifest.xml                 LAUNCHER + LEANBACK_LAUNCHER, boot receiver, cleartext config
  java/systems/ambienthome/maverickwall/
    KioskActivity.kt                  the WebView host: keep-awake, immersive, offline fallback
    WallWebViewClient.kt              URL allowlist + load-error → native status
    HealthProbe.kt                    polls /healthz with backoff
    BootReceiver.kt                   relaunch on boot
    KioskDeviceAdminReceiver.kt       device-owner hook for lock-task pinning (Phase 4)
    SetupActivity.kt                  server chooser: mDNS list + typed address (Compose)
    ServerConfig.kt                   the one stored fact: which box to talk to
    Theme.kt                          dark Board-ish chrome for setup/status
    net/ServerFinder.kt               mDNS discovery of _maverickwall._tcp (NsdManager)
    net/TlsPinning.kt                 trust-on-pairing cert pinning (WebView + OkHttp)
    pairing/DeviceFlow.kt             the device-authorization client (start/poll)
    pairing/PairingActivity.kt        code + QR + poll → hand /pair?token= to the WebView
    pairing/QrCode.kt                 offline QR of the approve link (ZXing)
    push/                             the Phase 2 wake socket (PushService/Bus/Message)
  res/                                layout, strings, colors, themes, vector icon + TV banner
```

## App ID

`systems.ambienthome.maverickwall`. Stable identifier; change it before any Play
Store / TV listing if a different namespace is wanted (it is forever once
published).

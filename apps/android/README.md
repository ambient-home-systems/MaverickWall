# Maverick Wall — Android / Google TV app

A **kiosk shell**, not a second renderer. This app turns a television or a
wall-mounted tablet into a Maverick Wall screen: it boots straight into the
calendar, keeps the screen on, and stays pointed at the household's own server.

The calendar itself is [`apps/display`](../display), loaded over the LAN from the
server exactly as a browser screen loads it. The native code here does only the
handful of things a browser tab on a wall cannot — see
[`docs/rfc-003-android-tv-app.md`](../../docs/rfc-003-android-tv-app.md) for the
full design and the reasoning behind "the one thing we do not build."

## What Phase 1 includes

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

### Not in Phase 1 (later phases)

- Wake-on-takeover over the WebSocket, D-pad OK → acknowledge, HTTPS cert
  pinning (**Phase 2**).
- mDNS discovery + device-flow pairing + QR (**Phase 3**). Manual entry above is
  the always-available fallback that never goes away.
- Signed release APK on GitHub, TV store polish (**Phase 4**).

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

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p systems.ambienthome.maverickwall 1   # launch it
```

On first launch it asks for the server address (e.g. `192.168.1.10:8080`). Then
it loads the wall; when the wall shows its pairing screen, create a screen at the
server's `/admin/screens` and type the code shown there.

### Kiosk lock-down (optional)

Lock-task mode (`startLockTask`) is used **only** where the device permits it
(device-owner provisioning). A plain sideload runs unpinned — deliberately, so a
household is never stranded by a hard requirement. To pin, provision the app as
device owner:

```bash
adb shell dpm set-device-owner systems.ambienthome.maverickwall/.DummyDeviceAdmin
```

(A device-admin receiver for this is a Phase 4 polish item; unpinned kiosk works
today.)

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
    SetupActivity.kt                  server-address entry (Compose)
    ServerConfig.kt                   the one stored fact: which box to talk to
    Theme.kt                          dark Board-ish chrome for setup/status
  res/                                layout, strings, colors, themes, vector icon + TV banner
```

## App ID

`systems.ambienthome.maverickwall`. Stable identifier; change it before any Play
Store / TV listing if a different namespace is wanted (it is forever once
published).

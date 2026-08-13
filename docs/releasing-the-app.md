# Releasing the Android app

The wall app ships as a **signed APK attached to the GitHub Release**, built by
the same `release.yml` run that builds the server image — one commit, one tag,
the app and the image agreeing about what a release is (RFC 003 Phase 4).
Distribution is sideload-first, matching the no-cloud ethos: no Play Store, no
account, download the APK and `adb install` it.

Once the signing secrets below exist, releasing the app is **automatic** — every
stable release (`Run workflow`, or a pushed `vX.Y.Z` tag) builds the APK with the
release version baked in and attaches it. There is nothing app-specific to do at
release time.

## One-time setup: the signing key (you, not CI)

An APK is installable only if it is signed, and the signing key is the app's
**permanent identity** — Android will not upgrade an installed app with one
signed by a different key, so this key is forever once the first release ships.
It cannot live in the repo (rule six) and it is not something automation can
create for you: generating it and safeguarding it is yours to do.

### 1. Generate the keystore

On a machine you trust, with a JDK installed:

```bash
keytool -genkeypair -v \
  -keystore maverick-wall-release.jks \
  -alias maverick-wall \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass 'CHOOSE-A-STRONG-PASSWORD' \
  -keypass 'CHOOSE-A-STRONG-PASSWORD' \
  -dname 'CN=Maverick Wall, O=Ambient Home Systems'
```

**Back this file and its passwords up somewhere durable and private.** If you
lose them, you can never ship an update that upgrades an installed app — every
household would have to uninstall and reinstall. Never commit it; the app's
`.gitignore` already refuses `*.jks` and `keystore.properties`, but the file
belongs nowhere near the working tree.

### 2. Add four repository secrets

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add these four (the workflow reads exactly these names):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the keystore file, base64-encoded (below) |
| `ANDROID_KEYSTORE_PASSWORD` | the `-storepass` you chose |
| `ANDROID_KEY_ALIAS` | `maverick-wall` (the `-alias`) |
| `ANDROID_KEY_PASSWORD` | the `-keypass` you chose |

Encode the keystore for the first secret:

```bash
base64 -i maverick-wall-release.jks | pbcopy   # macOS
# base64 -w0 maverick-wall-release.jks          # Linux, then copy the output
```

That is the whole setup. The four secrets are the only thing standing between a
tagged release and a signed APK on the Release page; until they exist, the
`android` job fails loudly (by design — an unsigned APK a household cannot
install is worse than a red release that names the missing secret).

## What happens at release time

`release.yml`'s `android` job runs **after** `advertise`, so the tag already
exists on both release paths (a pushed tag, or the one-click dispatch where
`advertise` creates the tag with `GITHUB_TOKEN` — which is also why the APK build
lives in this workflow rather than a separate tag-triggered one that would never
fire for a dispatched release). It then:

1. decodes the keystore from the secret,
2. builds `assembleRelease` with the release version injected
   (`-PmwVersionName=X.Y.Z`, and a monotonic `-PmwVersionCode`), so the APK
   carries the same version as the image — no number is hand-maintained in
   `build.gradle.kts`,
3. verifies the APK is actually signed (`apksigner verify`), and
4. attaches `maverick-wall-X.Y.Z.apk` to the release.

Stable only: like the `stable` image tag and the Home Assistant advertisement, a
pre-release (`X.Y.Z-rc.1`) does not produce an APK — a household sideloads
releases, not release candidates.

## Building a signed APK locally (optional)

You never need this to release, but to produce a signed APK by hand — put a
`keystore.properties` beside `apps/android/` (it is gitignored):

```properties
storeFile=/absolute/path/to/maverick-wall-release.jks
storePassword=…
keyAlias=maverick-wall
keyPassword=…
```

then `./gradlew assembleRelease` in `apps/android`. With no `keystore.properties`
and no `MW_KEYSTORE_*` environment variables, the release build still succeeds
but is **unsigned** — fine for inspecting the build, not installable.

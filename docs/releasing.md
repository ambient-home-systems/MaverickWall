# Releasing Maverick Wall

Status: **proposed** · First drafted 2026-08-11

This exists because of one real failure: a household clicked **Update** in Home
Assistant and got *"an unknown error occurred with app … check Supervisor logs."*
Nothing was broken — the release was just half-done in a way the supervisor
surfaced as a dead pull. This document is the fix and the procedure that avoids
it.

## The race, and why it bites

Two things carry a version, and they go live at different times:

1. **`addon/maverick-wall/config.yaml`'s `version:`** — this is what the
   supervisor reads, **straight from `main` over `raw.githubusercontent.com`**,
   to decide a new version is available. It is visible the instant a commit
   bumping it lands on `main`.
2. **The image `ghcr.io/…/maverick-wall:X.Y.Z`** — built only when the `vX.Y.Z`
   **tag** is pushed, by `release.yml`, which takes **~8 minutes** (multi-arch,
   emulated, native module, cosign).

The old procedure did them in the wrong order:

```
merge release PR  →  config says 0.10.0 on main   (HA now offers 0.10.0)
push tag          →  release.yml starts building  (image does not exist yet)
~8 minutes later  →  image 0.10.0 published        (HA can finally pull it)
```

For those ~8 minutes **Home Assistant advertises a version whose image is a
404.** A household who updates in that window runs `docker pull …:0.10.0`, gets
"manifest unknown", and sees the generic supervisor error. Their existing
install is untouched — a failed pull changes nothing — but the update looks
broken.

The root cause in one line: **the version households can see went live before
the image that version names existed.**

## The fix: publish before the version reaches `main`

Reorder the last two steps. Tag and publish the image **first**, and merge the
release PR to `main` **last** — so the supervisor never sees the new version
until the image it names is already in the registry.

```
push tag on the release branch  →  release.yml builds & publishes the image
verify the image is pullable    →  (anonymously — see below)
merge the release PR to main    →  HA sees 0.10.0 now, and the image exists
```

This needs no workflow change and no code change — only the order. It is also
**strictly safer on failure**: if the build breaks, `main` still advertises the
old version and nothing is offered, instead of pointing every household at an
image that will never arrive.

The `v0.1.0` lesson still holds — *a tag is a photograph, not a pointer* — so the
commit you tag must be **finished**. It is: the release commit (the version +
changelog bump) is the whole of the release. Nothing is added to that commit
after the tag; the later merge commit is history glue and does not change a
tracked byte, so the image built from the tagged commit and the `config.yaml`
`main` serves after the merge are identical.

## The procedure

Given a release branch with the version bumped in `config.yaml` and an entry at
the top of `CHANGELOG.md` (the `addon-repository` test enforces that they agree):

1. **Gate.** `pnpm test` green locally, and the release PR open.
2. **Tag the release commit** (the one that bumps the version), on the branch:
   ```bash
   git tag -a vX.Y.Z -m "Release X.Y.Z: <one line>"
   git push origin vX.Y.Z
   ```
   `release.yml` starts. (`type=semver` strips the `v`, so it publishes `:X.Y.Z`.)
3. **Wait for the workflow to finish, then verify the image anonymously** —
   with a fresh pull token and no login, because a package private-by-default is
   invisible from the owner's own logged-in tab:
   ```bash
   REPO=ambient-home-systems/maverick-wall
   TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:$REPO:pull" | jq -r .token)
   curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     "https://ghcr.io/v2/$REPO/manifests/X.Y.Z" | jq '.manifests[].platform'
   ```
   Expect `linux/amd64` and `linux/arm64` (plus two attestation manifests).
4. **Only now, merge the release PR to `main`** — with a merge commit, so the
   tagged commit stays an ancestor of `main`. The moment this lands, the
   supervisor can see the new version, and the image is already there.
5. **Tell the household it is available.** Not before step 4: "merged" is the
   same instant as "announced", and by then the image is proven live.

## What the tests already guard

- **`addon-repository.test.ts`** — the top `## x.y.z` in `CHANGELOG.md` equals
  `config.yaml`'s version (a release with no changelog entry is caught), the
  declared `arch` list matches what `release.yml` builds, and there is exactly
  one add-on manifest.
- **`migration-upgrade.test.ts`** — every migration applies against a database
  that already holds a calendar, so a release cannot corrupt an existing wall.

Neither of these sees the registry, which is why step 3 is a manual `curl` and
not a test.

## The heavier alternative, and why it is not the default

The race could be closed *automatically* by never putting the version bump in a
human commit at all: merge features to `main` with `config.yaml` unchanged, tag
`main`, and have `release.yml`, as its final post-publish step, commit the bump
(`version:` derived from the tag) back to `main` itself. Then "config advertises
X.Y.Z" is, by construction, after "image X.Y.Z published."

It is not the default because it costs more than it saves here:

- the workflow needs write access to `main` and a bypass if `main` is protected;
- the changelog is prose a person writes, so it cannot ride the bot commit — and
  the `changelog == config version` guard would have to weaken to *"the changelog
  contains an entry for the config version"* to tolerate config lagging the
  human-written entry for the length of one build;
- it adds a bot commit to `main` per release.

The manual reorder above closes the same window with no new moving parts. Adopt
the automated version only if the ordering proves easy to get wrong in practice
— at which point the thing to automate is step 4 (merge-on-publish), gated on the
same anonymous pull check as step 3.

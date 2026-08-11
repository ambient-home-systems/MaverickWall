# Release checklist

Ordered so that nothing is announced before it can be installed.

1. **Green.** `pnpm test` — it builds first, then runs. That is what CI runs.
2. **CHANGELOG.** `addon/maverick-wall/CHANGELOG.md`, in the format Home
   Assistant renders. Write it for a household, not for a commit log.
3. **Version.** Bump `version:` in `addon/maverick-wall/config.yaml` — the one
   place. The running app's version is *not* a literal to edit: `main.ts` reads
   `MW_VERSION`, which the image sets from the `VERSION` build-arg, which
   `release.yml` sets to the tag — so the tag is what the app reports. Make the
   tag equal `config.yaml`'s version; a mismatch means the store advertises a
   version whose image was built under a different tag (see step 6).
4. **Migrations.** If any migration recreates a table, read the generated
   `INSERT ... SELECT` before shipping it. SQLite resolves a double-quoted name
   that matches no column as a *string literal*, so a generated rebuild can
   silently write the text `'kind'` into every row and report success.
   `test/migration-upgrade.test.ts` is the guard; make sure it covers what you
   changed.
5. **Tag.** `git tag -a v1.2.3 -m 'v1.2.3' && git push --tags`.
6. **Watch the release workflow — and do not touch Home Assistant until it is
   green.** Multi-arch build, cosign signature, SBOM, and the tags (`stable`
   moves only for a non-pre-release). This step is load-bearing: the add-on
   store reads `config.yaml` from `main`, so the moment the bump merged the
   supervisor began advertising the new version — but its image does not exist
   until *this* workflow finishes. Push the tag right after the merge, not
   later; a forgotten or deferred tag leaves the store offering a version whose
   image is a 404, and the supervisor's Update fails with "an unknown error
   occurred". The **Add-on image published** workflow guards exactly this — it
   goes red when `main`'s declared version has no public image — but treat that
   as a backstop, not a licence to skip the wait. 0.16.0 shipped this way once.
7. **Verify what shipped**, from a clean machine, exactly as the README says:
   ```bash
   docker run -d -v ./data:/data -p 8080:8080 ghcr.io/ambient-home-systems/maverick-wall:stable
   cosign verify ghcr.io/ambient-home-systems/maverick-wall:stable \
     --certificate-identity-regexp 'https://github.com/ambient-home-systems/MaverickWall/.*' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```
8. **Add-on.** Confirm the store offers the new version, then install it on a
   real Home Assistant — the sidebar for the settings, a screen on the port.
   Ingress is the path least like anything else and the most likely to break.
9. **Docs.** Anything in `docs/` that a change makes wrong.
10. **Announce**, with the screenshot. Nothing converts like a real install
    photo, so take a new one if the wall looks different.

## Before the first public release

- [x] Replace the maintainer address in `repository.yaml`. It is the
      issues URL rather than an inbox — public, permanent, and answerable by
      more than one person.
- [x] **Make the repository public.** Separate switch from the package, and
      for a while only the package was on — which broke the whole add-on path,
      because Home Assistant adds a repository by fetching
      `raw.githubusercontent.com/.../repository.yaml`. Both are public now;
      repo, raw manifest and issues all verified 200 signed out. Re-check it
      with `curl` and not from a browser you are logged into, which is the one
      place it looks fine either way.
- [ ] Take the README screenshots. They are the top of the page and the only
      thing there that cannot be written.
- [ ] Decide whether `packages/calendar` moves to its own MIT repository now or
      after the first release. The licence split already says it will.

# Release checklist

Ordered so that nothing is announced before it can be installed.

1. **Green.** `pnpm test` — it builds first, then runs. That is what CI runs.
2. **CHANGELOG.** `addon/maverick-wall/CHANGELOG.md`, in the format Home
   Assistant renders. Write it for a household, not for a commit log.
3. **Versions.** Bump `addon/maverick-wall/config.yaml` and `APP_VERSION` in
   `apps/server/src/main.ts`. They are checked against each other by nothing
   yet, so check them.
4. **Migrations.** If any migration recreates a table, read the generated
   `INSERT ... SELECT` before shipping it. SQLite resolves a double-quoted name
   that matches no column as a *string literal*, so a generated rebuild can
   silently write the text `'kind'` into every row and report success.
   `test/migration-upgrade.test.ts` is the guard; make sure it covers what you
   changed.
5. **Tag.** `git tag -a v1.2.3 -m 'v1.2.3' && git push --tags`.
6. **Watch the release workflow.** Multi-arch build, cosign signature, SBOM,
   and the tags — `stable` moves only for a non-pre-release.
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

- [ ] Replace the maintainer address in `addon/repository.yaml`.
- [ ] Take the README screenshots. They are the top of the page and the only
      thing there that cannot be written.
- [ ] Decide whether `packages/calendar` moves to its own MIT repository now or
      after the first release. The licence split already says it will.

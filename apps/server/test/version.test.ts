import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isReleaseVersion, readPackageVersion, resolveAppVersion } from '../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('the version this process reports', () => {
  it('uses the build tag when there is one, which is the shipping path', () => {
    // The image sets `MW_VERSION` from the release tag. That path is the one
    // that ships and this fix must not touch it.
    expect(resolveAppVersion('0.54.2', '0.54.2')).toEqual({
      version: '0.54.2',
      isRelease: true,
    });
    // `v` stripped, exactly as before: a tag is `v0.54.2` and a version is not.
    expect(resolveAppVersion('v0.54.2', '0.1.0').version).toBe('0.54.2');
    // And the tag wins over the package, even when they disagree — the image
    // was built for that tag whatever the tree said.
    expect(resolveAppVersion('1.2.3', '0.54.2').version).toBe('1.2.3');
  });

  it('falls back to the package version, labelled as the dev build it is', () => {
    // The bug: a checkout has no `MW_VERSION` at all and reported 0.0.0.
    expect(resolveAppVersion(undefined, '0.54.2')).toEqual({
      version: '0.54.2-dev',
      isRelease: false,
    });
    expect(resolveAppVersion('', '0.54.2').version).toBe('0.54.2-dev');
  });

  it('does not mistake the Dockerfile placeholder for release 0.0.0', () => {
    /*
     * `ARG VERSION=0.0.0-dev` is what an image built with no `--build-arg`
     * carries, and `0.0.0` is what four releases' worth of missing environment
     * looked like. Neither is a release, and reading either as one puts the
     * phantom update straight back.
     */
    expect(resolveAppVersion('0.0.0-dev', '0.54.2')).toEqual({
      version: '0.54.2-dev',
      isRelease: false,
    });
    expect(resolveAppVersion('0.0.0', '0.54.2').isRelease).toBe(false);
  });

  it('treats a pre-release as not-a-release, the way the check itself does', () => {
    // `checkForUpdate` refuses to offer a pre-release because getting their
    // ordering subtly wrong tells a household they are behind when they are
    // not. Using one as the baseline is the same mistake from the other side.
    expect(isReleaseVersion('1.2.3-rc1')).toBe(false);
    expect(isReleaseVersion('1.2.3')).toBe(true);
    expect(isReleaseVersion('v1.2.3')).toBe(true);
    expect(isReleaseVersion('not a version')).toBe(false);
  });

  it('never produces an empty version, whatever it is handed', () => {
    // Rule nine: this runs on the first line of boot and a version number is
    // not worth failing a start over.
    expect(resolveAppVersion(undefined, '').version).toBe('0.0.0-dev');
    expect(resolveAppVersion(undefined, 'garbage').version).toBe('0.0.0-dev');
  });

  it('reads the real package manifest sitting beside dist', () => {
    // Not a stub: the fallback is only worth anything if this file is where
    // the code thinks it is, in this tree and in the flattened one the image
    // deploys. Reading it here is what proves the relative path.
    const declared = (JSON.parse(read('apps/server/package.json')) as { version: string }).version;
    expect(readPackageVersion()).toBe(declared);
    // Explicitly not the "we could not read it" answer, which matches the
    // shape of a version and so would pass a looser assertion.
    expect(readPackageVersion()).not.toBe('0.0.0');
    // And a missing file is a fallback rather than a crashed boot.
    expect(readPackageVersion(new URL('file:///nowhere/package.json'))).toBe('0.0.0');
  });

  it('is the version the add-on advertises', () => {
    /*
     * The two have to stay level or a checkout reports a version that was
     * never released. `release.yml`'s `advertise` job writes both in the same
     * commit — this is the thing that fails the build when it does not, the
     * same shape as the CHANGELOG parity check next door.
     */
    const addon = parseYaml(read('addon/maverick-wall/config.yaml')) as { version: string };
    const server = JSON.parse(read('apps/server/package.json')) as { version: string };

    expect(server.version).toBe(addon.version);
  });
});

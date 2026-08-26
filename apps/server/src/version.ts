import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * What version this process is, and whether that is a released one.
 *
 * The image is handed its tag at build time (`MW_VERSION`, from the
 * Dockerfile's `VERSION` arg) and that path is correct and untouched. What was
 * missing is every *other* way this is run — a checkout, `pnpm build` and
 * `node dist/main.js`, which is what the README documents for development —
 * where the environment variable is simply absent and the whole product
 * reported `0.0.0`. Three things read that number and all three lied: the page
 * whose only job is to say what you are running, the diagnostics export
 * attached to bug reports, and the update check, which compares `0.0.0`
 * against the latest release and so always answered "yes, there is an update".
 *
 * So a build with no tag falls back to the package's own version with `-dev`
 * on it. The suffix is not decoration: `isReleaseVersion` is what suppresses
 * the update check, and a phantom update every day is worse than no check at
 * all.
 */

export interface AppVersion {
  /** What to show, log and export. Never empty. */
  readonly version: string;
  /** Whether this is a published release, and so worth comparing against one. */
  readonly isRelease: boolean;
}

/**
 * A released version is three plain numbers and nothing else.
 *
 * `0.0.0` is excluded deliberately rather than by accident of the regex: it is
 * the Dockerfile's placeholder for "nobody said", so an image built locally
 * with no `--build-arg` must not be mistaken for release 0.0.0 and told it is
 * eleven versions behind.
 *
 * A pre-release (`1.2.3-rc1`) is not a release here either. The update check
 * refuses to *offer* pre-releases for the same reason — getting their ordering
 * subtly wrong tells a household they are behind when they are not — so
 * treating one as a baseline would be the same mistake from the other side.
 */
export function isReleaseVersion(version: string): boolean {
  const raw = version.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(raw) && raw !== '0.0.0';
}

/**
 * Resolve the version from the build tag, falling back to the package's own.
 *
 * Pure, so the whole rule can be tested without a filesystem or an image.
 */
export function resolveAppVersion(tag: string | undefined, packageVersion: string): AppVersion {
  const fromTag = (tag ?? '').trim().replace(/^v/, '');
  if (isReleaseVersion(fromTag)) return { version: fromTag, isRelease: true };

  const base = packageVersion.trim().replace(/^v/, '');
  /*
   * `-dev` says which side of a release this is without pretending to know how
   * far: a checkout is somewhere after `base` and before the next one, and
   * `git describe` would say exactly where — at the cost of running git at
   * runtime, in a container that has none, for a number nothing acts on.
   */
  const version = /^\d+\.\d+\.\d+/.test(base) ? `${base}-dev` : '0.0.0-dev';
  return { version, isRelease: false };
}

/**
 * The version out of the package manifest sitting beside `dist/`.
 *
 * Works in both trees by being relative rather than clever: in a checkout that
 * is `apps/server/package.json`, and in the image `pnpm deploy` flattens this
 * package to the root so it is `/app/package.json`. That is the same
 * resolution trap `defaultDisplayDir()` documents, from the other direction —
 * here the file moves *with* `dist`, so one relative path is right in both.
 *
 * Never throws. This runs on the first line of boot, and rule nine does not
 * make an exception for a missing version number.
 */
export function readPackageVersion(from: URL = new URL('../package.json', import.meta.url)): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(from), 'utf8'));
    const value = (parsed as { version?: unknown }).version;
    return typeof value === 'string' ? value : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * What the settings page says in place of an update result.
 *
 * Written for somebody standing in a kitchen who did not build this: it says
 * what is running, why the check is quiet, and what would bring it back —
 * rather than leaving a switch that is on beside a section that never answers.
 */
export const DEV_BUILD_NOTE =
  'This is a development build rather than a released version, so there is nothing ' +
  'to compare it against. Update checking resumes on a released build.';

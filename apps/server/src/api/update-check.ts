import { FETCH_LIMITS, type Fetcher } from '@maverick-wall/core';
import { parseJson, z } from '../validation.js';
import { bareVersion, isReleaseVersion } from '../version.js';

/**
 * The update check: the only thing in this product that contacts anybody.
 *
 * It is off unless the household turns it on, and turning it on has a real
 * cost that the settings page states outright — a request to a third party
 * reveals this house's IP address to whoever runs it, and the fact that
 * somebody there runs Maverick Wall. Nothing else is sent. There is no
 * identifier, no telemetry, no count of anything.
 *
 * It is also only ever a *check*. Nothing is downloaded and nothing is
 * installed. An unattended installer in a house nobody can reach is the most
 * direct way to break rule nine, and the household updating their own
 * container when it suits them is the whole deployment model.
 */

/**
 * Where the version comes from.
 *
 * A constant rather than a setting: a configurable update endpoint is a
 * request to fetch an attacker-chosen URL on a schedule, which is exactly what
 * the SSRF guard exists to prevent, and no household has ever wanted one.
 */
export const RELEASE_URL = 'https://api.github.com/repos/ambient-home-systems/MaverickWall/releases/latest';

/** The host shown on the settings page, so the disclosure names something real. */
export const RELEASE_HOST = 'api.github.com';

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a version, tolerating the shapes release tags actually take.
 *
 * `v1.2.3`, `1.2.3`, and `1.2.3-rc1` all read as the same three numbers. A
 * pre-release suffix is deliberately ignored rather than ordered: getting
 * pre-release precedence subtly wrong would tell a household they are behind
 * when they are not, and the honest fix is to not offer them pre-releases.
 */
export function parseVersion(value: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Negative when `a` is older, zero when they match, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isNewer(candidate: string, current: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (left === undefined || right === undefined) return false;
  return compareVersions(left, right) > 0;
}

export type UpdateCheckResult =
  | { readonly status: 'ok'; readonly latest: string; readonly newer: boolean }
  /** Reached somebody, but not something we understood. */
  | { readonly status: 'failed'; readonly message: string };

/**
 * A GitHub release, of which four fields matter.
 *
 * Loose: this is somebody else's API and it returns forty fields. `catch` on
 * the booleans rather than `optional`, because "we could not tell whether this
 * is a draft" should read as "not a draft" and not as a parse failure — the
 * worst case is telling a household about a version that exists.
 */
const releasePayload = z.looseObject({
  tag_name: z.string().optional(),
  name: z.string().optional(),
  draft: z.boolean().catch(false),
  prerelease: z.boolean().catch(false),
});

/**
 * Ask once, and never throw.
 *
 * Through the guarded fetcher like everything else that leaves the process:
 * this URL is not user-supplied, but routing it anywhere else would mean a
 * second network path with its own timeout, size limit and redirect policy to
 * get right.
 */
export async function checkForUpdate(
  fetcher: Fetcher,
  currentVersion: string,
  url: string = RELEASE_URL,
): Promise<UpdateCheckResult> {
  const response = await fetcher.fetch({
    url,
    policy: {},
    maxBytes: FETCH_LIMITS.json,
    acceptContentTypes: ['application/json'],
    // Short. Nothing waits on this and a slow answer is the same as no answer.
    timeoutMs: 10_000,
    headers: { accept: 'application/vnd.github+json' },
  });

  if (response.status === 'rejected' || response.status === 'failed') {
    return { status: 'failed', message: describeFailure(response) };
  }
  if (response.status === 'not-modified') {
    return { status: 'failed', message: 'The release feed answered with nothing.' };
  }

  /*
   * `JSON.parse('null')` is valid JSON and is not an object, which used to be
   * a hand-written guard here — the schema covers it, and nothing in this file
   * is allowed to throw at a caller that is a scheduled job on a kitchen wall.
   */
  const shaped = parseJson(releasePayload, response.body);
  if (!shaped.ok) {
    return { status: 'failed', message: 'The release feed did not answer with a version.' };
  }
  const payload = shaped.value;

  // A draft or pre-release is not something to tell a kitchen about.
  if (payload.draft || payload.prerelease) {
    return { status: 'ok', latest: currentVersion, newer: false };
  }

  const tag = payload.tag_name ?? payload.name;
  if (tag === undefined || parseVersion(tag) === undefined) {
    return { status: 'failed', message: 'The release feed did not answer with a version.' };
  }

  return { status: 'ok', latest: tag.trim(), newer: isNewer(tag, currentVersion) };
}

function describeFailure(
  response: { status: 'rejected' | 'failed'; code: string; message: string },
): string {
  switch (response.code) {
    case 'dns-failed':
      return `Could not look up ${RELEASE_HOST}. This machine may have no internet access.`;
    case 'timeout':
      return `${RELEASE_HOST} did not answer in time.`;
    case 'http-error':
      return `${RELEASE_HOST} refused the request.`;
    case 'network-error':
      return `Could not reach ${RELEASE_HOST}.`;
    case 'url-rejected':
    case 'address-rejected':
    case 'redirect-rejected':
    case 'too-many-redirects':
      /*
       * The guard's own wording is written for a household pasting a calendar
       * address, and it says so — "calendar addresses are passwords in effect".
       * Shown here it is about a URL nobody typed, which reads as nonsense and
       * sends somebody looking for a setting that does not exist.
       */
      return `The release address was refused by the outbound guard (${response.code}).`;
    default:
      return response.message;
  }
}

/**
 * Whether there is a newer release to tell the household about, and its name.
 *
 * The one answer, because there used to be two. The System page asked
 * `isNewer(latestVersion, appVersion)` and the Overview's "Needs attention"
 * asked `latestVersion !== appVersion`, which is a different question wearing
 * the same words — and the wrong one in three separate ways:
 *
 *  - the two sides are not the same shape. `recordUpdateCheck` stores GitHub's
 *    tag verbatim (`v0.59.0`) and `resolveAppVersion` strips the `v`
 *    (`0.59.0`), so an install that is *exactly* up to date compares unequal.
 *    That is the bug a household reported: they updated, the daily check ran,
 *    and the row never went away;
 *  - inequality is true when this box is *ahead*, which is not rare. The
 *    release workflow's `advertise` writes `config.yaml`'s version last, so a
 *    household who updates the moment Home Assistant offers it is briefly
 *    running a version the releases API has not caught up with — and was shown
 *    an *older* version as an available update;
 *  - and it never asked whether this build is a released one, so a dev build
 *    carrying a `latestVersion` from back when it was on a release drew the
 *    banner the System page deliberately suppresses.
 *
 * Two renderers holding one rule is this project's most repeated bug —
 * `shifts[0]`, `display_mode`, `cellEvents`, `mode` — and the cure has been
 * the same every time: resolve it once and hand over the answer. Returning the
 * *name* rather than a boolean is part of that: a caller cannot re-read
 * `latestVersion` for the label and quietly disagree about which version it
 * just decided to offer.
 *
 * The name comes back in the same shape as `appVersion`, which is the third
 * thing that difference was costing. Both screens set the two versions in one
 * sentence — "Version v0.60.0 is available. This box runs 0.59.0" — so the
 * stored tag's `v` was one number written two ways in consecutive clauses.
 * Normalising here rather than at the write is deliberate: every household
 * already has a `v` in that column, and a read that copes needs no migration
 * to reach them.
 */
export function updateOnOffer(
  state: { readonly enabled: boolean; readonly latestVersion: string | null },
  appVersion: string,
): string | undefined {
  if (!state.enabled || state.latestVersion === null) return undefined;
  /*
   * A build nobody released is never behind. `isNewer` would read
   * `0.54.2-dev` as 0.54.2 and answer from a comparison that means nothing,
   * which is the same reason the check itself does not run on one.
   */
  if (!isReleaseVersion(appVersion)) return undefined;
  return isNewer(state.latestVersion, appVersion) ? bareVersion(state.latestVersion) : undefined;
}

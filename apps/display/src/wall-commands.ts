import type { Manifest } from './manifest.js';

/**
 * What a wall does when told to from elsewhere (plan items M1.2, M1.3, M2.3).
 * Pure — no DOM — so both rules can be tested without a wall; `main.ts` calls
 * them and does the reload and the drawing.
 */

/**
 * The layout to draw at `now`: another wall's, while one is being shown here
 * and its time has not run out, else this wall's own.
 *
 * `now` is the corrected wall clock, the reading the theme and the schedule
 * are taken from. The comparison is here rather than trusted to the server,
 * which stops sending a borrowed layout at the same instant, because a wall
 * drawing from its stored copy with the server gone has nobody else to send it
 * back to its own layout — and rule nine says no wall may be left on somebody
 * else's. A borrowed layout that is not a layout at all is not drawn.
 */
export function activeLayout(manifest: Manifest, now: number): Manifest['layout'] {
  const borrowed = manifest.layoutOverride;
  if (
    borrowed !== undefined &&
    typeof borrowed.until === 'number' &&
    Number.isFinite(borrowed.until) &&
    now < borrowed.until &&
    typeof borrowed.layout === 'object' &&
    borrowed.layout !== null
  ) {
    return borrowed.layout;
  }
  return manifest.layout;
}

/**
 * Whether this page should reload: somebody asked after it started.
 *
 * `startedAt` is the server's time on the page's first fresh poll — the
 * server's clock, because the request was stamped with it. A page started after
 * the request has nothing to reload for, which is what keeps a reload from
 * becoming a loop: the reloaded page's first poll is later than the request.
 */
export function refreshDue(manifest: Manifest, startedAt: number | undefined): boolean {
  const asked = manifest.screen?.refreshRequestedAt;
  return (
    startedAt !== undefined &&
    typeof asked === 'number' &&
    Number.isFinite(asked) &&
    asked > startedAt
  );
}

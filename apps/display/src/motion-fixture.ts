import { lockLoop, lockOnce, oneShotPhase, type OneShotMemory } from './motion.js';

/**
 * A demonstration of motion for the tests to measure — **a fixture, not a
 * product feature** (plan P4.3).
 *
 * The mechanism in `motion.ts` is groundwork: the weather styles (S15) and the
 * countdown styles (S16) are what will actually move on a household's wall.
 * Until they land there is nothing on a wall that animates, and a test of "a
 * loop is continuous across a redraw" or "a one-shot does not refire on the
 * next tick" needs *something* to be continuous or to refire. So this is the
 * smallest thing that can be each: a dot that drifts on a loop, and a bar that
 * arrives once per event.
 *
 * **No household can place it, and that is a property rather than a promise.**
 * `motion-fixture` is not in the server's `WIDGET_TYPES` allowlist, so the
 * layout save refuses it with a 400 and `buildLayout` drops a stored row naming
 * it; the editor's palette does not offer it; and the only way it reaches a
 * wall is a test rewriting the manifest on its way to the page
 * (`patchManifest` in `browser-harness.ts`). `browser-motion.test.ts` asserts
 * the refusal beside the measurements, so the day somebody adds it to the
 * allowlist is a day a test goes red rather than a day a demonstration quietly
 * becomes a feature.
 *
 * It is kept after the real styles land rather than replaced by them, because
 * the tests measure the *mechanism* and a style is free to change its look,
 * its timing or whether it moves at all.
 *
 * Both parts are drawn through the same helpers a real style uses, so what the
 * tests measure is the path S15 and S16 take: `lockLoop` for the loop, and
 * `lockOnce` over the per-widget memory for the one-shot. Their keyframes sit
 * in the scoped block at the foot of `display.css` like any other.
 */

/** The widget type a patched manifest names, and nothing else does. */
export const MOTION_FIXTURE_TYPE = 'motion-fixture';

/**
 * One cycle of the drifting dot.
 *
 * Six seconds, and the number is chosen against the tick rather than for the
 * look: 15,000 mod 6,000 is 3,000, exactly half a cycle. So a loop that
 * restarted on every tick — the fault this module exists to show fixed — lands
 * half a cycle away from where a continuous one would be, which is the largest
 * discrepancy a phase can have and the one no tolerance can swallow.
 */
export const FIXTURE_LOOP_MS = 6_000;

/** How long the bar takes to arrive: shorter than a tick, so a refire is visible. */
export const FIXTURE_ONCE_MS = 2_400;

/**
 * Draw the fixture.
 *
 * `event` in its config names the occasion the one-shot belongs to; a config
 * with none draws the loop alone. The bar is drawn whether or not it is
 * playing, because its still frame is where the arrival ends — a one-shot that
 * has finished leaves the element in place rather than taking it away.
 */
export function renderMotionFixture(
  now: number,
  widgetId: string,
  config: unknown,
  oneShots: OneShotMemory,
): HTMLElement {
  const box = document.createElement('section');
  box.className = 'fx-fixture';

  const loop = document.createElement('span');
  loop.className = 'fx-fixture-loop';
  lockLoop(loop, FIXTURE_LOOP_MS, now);
  box.appendChild(loop);

  const said = typeof config === 'object' && config !== null ? (config as Record<string, unknown>)['event'] : undefined;
  if (typeof said === 'string' && said !== '') {
    const once = document.createElement('span');
    once.className = 'fx-fixture-once';
    once.dataset['event'] = said;
    lockOnce(once, FIXTURE_ONCE_MS, oneShotPhase(oneShots.firedAt(widgetId, said, now), FIXTURE_ONCE_MS, now));
    box.appendChild(once);
  }
  return box;
}

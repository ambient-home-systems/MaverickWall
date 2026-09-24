/**
 * Motion that survives the fifteen-second rebuild (plan P4.3, decision D7).
 *
 * A browser wall may move now, and the reason it never could is still true:
 * `draw()` empties the wall and builds it again from the model every fifteen
 * seconds (`TICK_MS` in `main.ts`, and `root.textContent = ''` in
 * `renderFreeform`). An element with a CSS animation on it is a *new* element
 * after every tick, and a new element's animation starts from nought — so a
 * cloud drifting across a forecast would jump back to where it began four times
 * a minute, and a burst of confetti would go off four times a minute for a
 * whole day. Both read as a broken renderer in a room somebody lives in.
 *
 * Two answers, one for each shape of effect, and both are the same idea: **the
 * animation's position is a function of the wall clock, never of when the
 * element was made**.
 *
 *  - **A loop** (clouds drifting, snow falling, balloons floating) is given a
 *    negative `animation-delay` of however far into its cycle the corrected
 *    wall clock is (`phaseDelay`). A rebuilt element therefore starts exactly
 *    where the one it replaced had got to, and the loop is continuous across
 *    every redraw. Two walls in one house show the same cloud in the same
 *    place, too, since they read the same server clock.
 *  - **A one-shot** (confetti on the day, a page flipping at midnight) is
 *    anchored to the moment it first fired rather than to the epoch. That
 *    moment has to outlive a draw, so it is remembered per widget and per event
 *    by `main.ts` (`createOneShotMemory`, the mechanism the to-do widget's
 *    failed-tick sentence uses: model state rather than a node). A redraw in
 *    the middle of a burst resumes it; a redraw after it has finished draws the
 *    still frame; and the same event never fires twice.
 *
 * ## Where the fence is
 *
 * This is the **only** module in the wall's import graph that says "animation",
 * and it writes exactly two properties: `animation-duration` and
 * `animation-delay`, inline, on the element it is handed. Neither of those
 * moves anything on its own. What moves an element is an `animation-name`, and
 * that is declared only in `display.css`, inside
 * `@media (prefers-reduced-motion: no-preference)` and under
 * `.canvas[data-motion="on"]` — so a household who has asked their system for
 * less motion, or switched this wall's Motion off, or is looking at an admin
 * preview (whose canvas carries no `data-motion` at all), gets two inert inline
 * values and a still picture. `apps/display/test/motion.test.ts` holds both
 * halves of that: the stylesheet's scope, and this file as the one door.
 *
 * **The duration is stated here and nowhere else**, which is why the stylesheet
 * is forbidden from declaring one. The delay is computed *from* the duration,
 * so a keyframe set whose `animation-duration` said 6s beside a caller that
 * locked it to 5000ms would resume a fifth of a cycle out on every tick — two
 * places stating one number is how they come to disagree.
 *
 * An e-paper panel never reaches any of this: it draws a packed raster on the
 * server (`apps/server/src/epaper/`) and every style draws its still frame
 * there.
 */

/**
 * The negative `animation-delay` that puts a loop where the wall clock says it
 * is: `-(now mod duration)`.
 *
 * Measured against the *corrected* wall clock (`model.now`), never the tablet's
 * own — the same reading the theme, the schedule and the clock face are taken
 * from, so a wall whose device clock is hours out still draws the same phase as
 * the wall beside it. The modulus is taken the long way round so a clock before
 * the epoch cannot hand CSS a positive delay, which would *hold* the element
 * still for that long rather than start it part-way through.
 *
 * A duration that is not a positive finite number answers `0ms` rather than
 * throwing: a draw must never be the thing that fails.
 */
export function phaseDelay(durationMs: number, wallNowMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(wallNowMs)) return '0ms';
  const into = Math.round(((wallNowMs % durationMs) + durationMs) % durationMs);
  return into === 0 || into === durationMs ? '0ms' : `-${into}ms`;
}

/** Where a one-shot is: still playing (and how far in), or done. */
export type OneShotPhase =
  | { readonly playing: true; readonly delay: string }
  | { readonly playing: false };

/**
 * Whether a one-shot that fired at `firedAtMs` is still playing at `wallNowMs`,
 * and the delay that resumes it if so.
 *
 * `undefined` for the moment is a surface with no memory — an admin preview,
 * where there is nobody to remember an event *for* — and that draws the still
 * frame, which is the side to be wrong on: a preview that went off every time
 * the household touched a control would be the fault this module exists to
 * prevent, one screen along.
 *
 * A moment later than now means the corrected clock was moved back by a
 * resync after the effect fired. That is read as "fired just now" rather than
 * as done, because a burst the household has not finished seeing is worth more
 * than one they were denied by a correction of a few milliseconds.
 */
export function oneShotPhase(
  firedAtMs: number | undefined,
  durationMs: number,
  wallNowMs: number,
): OneShotPhase {
  if (firedAtMs === undefined || !Number.isFinite(firedAtMs)) return { playing: false };
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(wallNowMs)) {
    return { playing: false };
  }
  const elapsed = Math.max(0, Math.round(wallNowMs - firedAtMs));
  if (elapsed >= durationMs) return { playing: false };
  return { playing: true, delay: elapsed === 0 ? '0ms' : `-${elapsed}ms` };
}

/**
 * What the renderer asks about a one-shot: when did this widget's event fire?
 *
 * `firedAt` records `wallNowMs` as the moment the first time it is asked about
 * an event, and answers that same moment every time after — which is the whole
 * of "once per event". `undefined` is a surface that keeps no memory.
 */
export interface OneShotMemory {
  firedAt(widgetId: string, event: string, wallNowMs: number): number | undefined;
}

/** A surface with nothing to remember for: every one-shot draws its still frame. */
export const NO_ONE_SHOTS: OneShotMemory = { firedAt: () => undefined };

/**
 * How long an event nobody has asked about is remembered.
 *
 * An hour, and the reason it is not "for ever" or "until the next draw" is the
 * two ways each goes wrong. Forgotten on the next draw that does not ask, an
 * event would fire again the moment an alert takeover — which draws no canvas
 * at all — gave the wall back. Remembered for ever, a wall left up for a year
 * holds every event it ever drew. An event that is still current is asked about
 * on every tick, so it is never an hour stale; one that has ended stops being
 * asked about and goes an hour later.
 *
 * What it does not survive is a reload, and that is stated rather than papered
 * over: the memory lives in the page, so a wall reloaded by its watchdog or by
 * a power cut in the middle of its countdown's day sees the burst once more.
 * Once per page life is honest; persisting it would be a second store with its
 * own ways to disagree with the first.
 */
export const ONE_SHOT_FORGET_MS = 60 * 60_000;

/** A bound on what one page holds, as a belt: far above any real wall. */
export const ONE_SHOT_MAX = 256;

/**
 * The per-widget memory `main.ts` keeps across draws.
 *
 * Keyed by widget id *and* event, so two countdowns on one wall reaching their
 * day together each fire, and one countdown whose date moves fires again for
 * the new date. The event is whatever string the style names its occasion by —
 * a target date, a date and an hour for a celebration that replays hourly, a
 * split-flap's new value — so what counts as "the same event" is decided by the
 * widget that knows, and nothing here has an opinion about it.
 *
 * `sweep` forgets what has not been asked about for `ONE_SHOT_FORGET_MS`, and
 * is called once per draw.
 */
export function createOneShotMemory(): OneShotMemory & { sweep(wallNowMs: number): void; readonly size: number } {
  const fired = new Map<string, { readonly at: number; asked: number }>();
  return {
    firedAt(widgetId: string, event: string, wallNowMs: number): number {
      const key = JSON.stringify([widgetId, event]);
      const known = fired.get(key);
      if (known !== undefined) {
        known.asked = wallNowMs;
        return known.at;
      }
      fired.set(key, { at: wallNowMs, asked: wallNowMs });
      // Oldest first, which is insertion order: a belt, never reached by a wall.
      while (fired.size > ONE_SHOT_MAX) {
        const oldest = fired.keys().next();
        if (oldest.done === true) break;
        fired.delete(oldest.value);
      }
      return wallNowMs;
    },
    sweep(wallNowMs: number): void {
      for (const [key, entry] of fired) {
        if (wallNowMs - entry.asked > ONE_SHOT_FORGET_MS) fired.delete(key);
      }
    },
    get size(): number {
      return fired.size;
    },
  };
}

/**
 * Lock a looping element to the wall clock: its duration, and where in it now is.
 *
 * The element's class is what names the keyframes, in the scoped block of
 * `display.css`; this is what makes the rebuilt copy resume rather than restart.
 */
export function lockLoop(node: HTMLElement, durationMs: number, wallNowMs: number): void {
  node.style.animationDuration = `${durationMs}ms`;
  node.style.animationDelay = phaseDelay(durationMs, wallNowMs);
}

/**
 * Lock a one-shot to the moment it fired, and say whether it is still playing.
 *
 * Playing, the element gets its duration, the delay that resumes it and the
 * `fx-playing` class the scoped block keys its keyframes on. Done — or on a
 * surface with no memory — it gets nothing, and is drawn as its still frame.
 */
export function lockOnce(node: HTMLElement, durationMs: number, phase: OneShotPhase): boolean {
  if (!phase.playing) return false;
  node.style.animationDuration = `${durationMs}ms`;
  node.style.animationDelay = phase.delay;
  node.classList.add('fx-playing');
  return true;
}

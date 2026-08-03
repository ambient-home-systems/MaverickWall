import type { Fetcher } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';
import type { Keyring } from '../secrets/keyring.js';
import type { Signal } from '@maverick-wall/core';

/**
 * Panel modules.
 *
 * A module is a thing that puts a block on the wall: it owns a slice of the
 * manifest, usually a job to keep that slice fresh, and a corner of the
 * settings screen. Weather is the first; interrupts and Home Assistant
 * entities are the next two, and they are the reason this is a seam rather
 * than three special cases wired individually.
 *
 * **A module contributes data, never code.** Rule three forbids third-party
 * origins in the display bundle, so nothing here can ship anything the wall
 * executes or fetches. A module says what it wants shown and a first-party
 * renderer draws it. That is a real constraint and it is also what makes the
 * idea safe: a module cannot break the layout, leak an origin, or run
 * anything.
 *
 * That property is what would let a third-party add-on work later without new
 * trust — it would run as its own process and answer with the same shape over
 * HTTP, through the SSRF-guarded fetcher exactly like a calendar feed. Nothing
 * here commits to that, but nothing here rules it out either.
 */

export interface ModuleContext {
  readonly db: SqliteDatabase;
  readonly fetcher: Fetcher;
  readonly now: number;
  /** The household's zone, for anything that has to name a day. */
  readonly timezone: string;
  /**
   * For a module whose upstream needs a credential.
   *
   * Only the module's own job touches this. Nothing a module returns carries a
   * secret: the manifest gets resolved values, and rule six is a test rather
   * than an intention.
   */
  readonly keyring: Keyring;
}

export interface ModuleJob {
  /** Scheduler key. Must be stable: it is a row in `job_state`. */
  readonly kind: string;
  readonly intervalMs: number;
  /** Never throws. A module that fails is a missing panel, not a dead wall. */
  run(context: ModuleContext): Promise<void>;
}

export interface PanelModule {
  /**
   * The block key.
   *
   * Also what the household orders and switches off on the Display screen, and
   * what the renderer keys off. Stable for ever once shipped: it is stored in
   * `household_settings.display_blocks`.
   */
  readonly key: string;
  /** Shown in the block-order settings. */
  readonly label: string;
  /**
   * Whether this module has anything to say right now.
   *
   * False when the household has switched it off, or has not configured it —
   * a weather panel with no location is a hole in the wall, not a feature.
   */
  ready(db: SqliteDatabase): boolean;
  /**
   * The manifest slice, or null.
   *
   * Never throws: this runs inside manifest assembly, which every display poll
   * depends on. A module that cannot answer returns null and the block is
   * simply not drawn.
   */
  contribute(context: ModuleContext): unknown;
  readonly job?: ModuleJob;

  /**
   * Facts this module can offer the interrupt evaluator, if any.
   *
   * Separate from `contribute` because an interrupt is not a panel: it is not
   * ordered, it is not switched off with a block, and it draws over everything
   * rather than in a row. A module that only puts a panel on the wall does not
   * implement this, and a source of signals that has no panel — weather alerts
   * are the likely next one — would implement only this.
   *
   * Never throws, same as everything else here.
   */
  signals?(context: ModuleContext): readonly Signal[];
}

/**
 * Ask every ready module for its slice.
 *
 * Failures are swallowed per module, deliberately. One module throwing must
 * cost its own panel and nothing else — the alternative is a calendar that
 * stops rendering because a forecast provider changed a field name.
 */
export function collectPanels(
  modules: readonly PanelModule[],
  context: ModuleContext,
): Record<string, unknown> {
  const panels: Record<string, unknown> = {};
  for (const module of modules) {
    try {
      if (!module.ready(context.db)) continue;
      const slice = module.contribute(context);
      if (slice !== null && slice !== undefined) panels[module.key] = slice;
    } catch {
      // Nothing. A module that throws is a missing panel; the wall keeps its
      // calendar, which is the product.
    }
  }
  return panels;
}

/**
 * Every signal every module can offer, for the interrupt rules to match on.
 *
 * Deliberately not gated on `ready`. A module can be switched off as a *panel*
 * and still be the thing that knows the freezer door is open — "do not draw
 * this on the wall" and "do not tell me when the house is flooding" are
 * different requests, and conflating them would silently disarm a rule.
 *
 * Caught per module, for the same reason as panels.
 */
export function collectSignals(
  modules: readonly PanelModule[],
  context: ModuleContext,
): Signal[] {
  const signals: Signal[] = [];
  for (const module of modules) {
    if (module.signals === undefined) continue;
    try {
      signals.push(...module.signals(context));
    } catch {
      // A module that cannot say is not the same as a module saying nothing is
      // wrong — but there is no honest way to express that here, and taking the
      // wall down is not it. Its own health surfaces on its own screen.
    }
  }
  return signals;
}

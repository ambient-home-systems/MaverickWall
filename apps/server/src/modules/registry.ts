import type { Fetcher } from '@maverick-wall/core';
import type { SqliteDatabase } from '../db/open.js';

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

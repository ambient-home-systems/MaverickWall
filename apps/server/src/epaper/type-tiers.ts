/**
 * Which face a panel draws its type in — the e-paper type tier (RFC 006).
 *
 * A tier is one row of the table below: a panel's short side in, a rung of
 * `TYPE_RUNGS` out, and a **name** that everything downstream can be stated
 * over. It is pure — a number in, a table row out, no framebuffer and no model
 * — which is the seam `metrics.ts`, `tiers.ts`, `ladder.ts` and `ink.ts`
 * already exist at: a decision taken inside a draw call is a decision nothing
 * can test.
 *
 * ## Why a tier rather than a multiplication
 *
 * The shipped ladder was `round(2 * (short / 480) ** 0.6)` used as an integer
 * multiplier of one 8x8 face, so the only sizes a panel could reach were 8, 16,
 * 24 and 32 pixels. Two panels a third of a metre apart in diagonal landed on
 * the same rung all the way up the range, and the role that carries a month
 * cell's event names — `round(body / 2)` — was **2 on a 10.3" panel and 2 on a
 * 13.3" one**, which is 12.6 arc-minutes at one panel's read distance and 9.9
 * at the other's. The larger, further panel drew it smaller. `font.ts` has the
 * measurements.
 *
 * With three drawn faces the ladder has a rung at every height the range asks
 * for, each of them narrower than the 8x8 could reach it at, so a tier is a
 * *choice of face* rather than a multiplier.
 *
 * ## The table
 *
 *     tier  short side     body rung        header      small
 *     E1    up to 696      f12@1  16 / 13   f16@1  24   f8@1    8
 *     E2    697 - 1219     f16@1  24 / 17   f12@2  32   f12@1  16
 *     E3    1220 - 2210    f12@2  32 / 26   f16@2  48   f16@1  24
 *     E4    2211 - 4344    f16@2  48 / 34   f16@3  72   f12@2  32
 *     E5    4345 and up    f16@3  72 / 51   f16@4  96   f16@2  48
 *
 * **It is anchored, not invented.** The boundaries are where the nearest rung
 * to `16 * (short / 480) ** 0.6` changes, and the 7.5" Seeed panel this whole
 * layout was tuned on — short side 480 — lands on a 16px body, which is the
 * height it has always drawn. Every *vertical* metric in `metrics.ts` therefore
 * reproduces its shipped 800x480 value to the pixel; what moves is the advance,
 * 18px to 13px, which is a third more of a household's event title on the same
 * line. The exponent is unchanged and its argument is unchanged with it: at 1.0
 * a bigger panel shows exactly what a smaller one shows only larger, which is
 * what a household with a 13.3" panel did not pay for, and at 0.0 it shows more
 * at a size that stops being readable across a kitchen.
 *
 * **The floor is E1 and it is deliberate.** The shipped ladder clamped the body
 * scale to 2 "so the 4.2" and 2.9" presets keep the type they have today", and
 * a 296x128 panel resolves to a target of 7px without it — half the type those
 * panels draw now, on the panels that can least afford it. `f8@1` still ships
 * and is still drawn: it is E1's *small* rung, which is what a 7.5" panel names
 * its month cells in today.
 *
 * ## Why the roles are offsets rather than four more columns
 *
 * `header` is one rung above the body and `small` one below, everywhere. The
 * shipped code said `round(body * 1.5)` and `round(body / 2)`, which are the
 * same relationships expressed in a ladder whose rungs happened to be eight
 * pixels apart — and the second of those is exactly the arithmetic that
 * collapsed onto one value for two panel sizes. An offset cannot collapse: the
 * ladder is strictly increasing, so a panel a tier up draws every role larger.
 */

import { rungAt, rungStep, type TypeRung } from './font.js';

/** The tier names, smallest first. Stable for ever once shipped: they are in the frame's ETag. */
export const TYPE_TIER_NAMES = ['E1', 'E2', 'E3', 'E4', 'E5'] as const;
export type TypeTierName = (typeof TYPE_TIER_NAMES)[number];

export interface TypeTier {
  readonly tier: TypeTierName;
  /** The smallest panel short side that reaches this tier. */
  readonly minShortSide: number;
  /** Its body rung's index into `TYPE_RUNGS`. */
  readonly body: number;
}

/** The panel the ladder is anchored on, and the body height it draws there. */
export const ANCHOR_SHORT_SIDE = 480;
export const ANCHOR_BODY_HEIGHT = 16;

/**
 * How type grows with the panel. Unchanged from the constant ladder this
 * replaces — 1.0 is "the same panel, bigger", 0.0 is "the same type, more of
 * it", and this is deliberately nearer the second.
 */
export const SIZE_EXPONENT = 0.6;

export const TYPE_TIERS: readonly TypeTier[] = [
  { tier: 'E1', minShortSide: 0, body: 1 },
  { tier: 'E2', minShortSide: 697, body: 2 },
  { tier: 'E3', minShortSide: 1220, body: 3 },
  { tier: 'E4', minShortSide: 2211, body: 4 },
  { tier: 'E5', minShortSide: 4345, body: 5 },
];

/**
 * The tier this panel draws at, from its **short side** and never its height.
 *
 * A panel hung sideways is the same piece of hardware: `min(w, h)` is the one
 * number a quarter turn cannot change, and deriving from the height would make
 * one 13.3" panel draw 32px type landscape and 48px portrait.
 */
export function typeTierFor(shortSide: number): TypeTier {
  let found = TYPE_TIERS[0] as TypeTier;
  for (const tier of TYPE_TIERS) {
    if (shortSide >= tier.minShortSide) found = tier;
  }
  return found;
}

/** Every role this tier resolves, so nothing downstream recomputes an offset. */
export interface TierRungs {
  readonly tier: TypeTierName;
  /** Agenda rows, event titles, a widget's ordinary text. */
  readonly body: TypeRung;
  /** The inverted date band across the top of the built-in layout. */
  readonly header: TypeRung;
  /** The year beside it, and the weekday letters over the month grid. */
  readonly year: TypeRung;
  readonly label: TypeRung;
  /** Names inside a month cell, a widget's title bar, every "+N". */
  readonly small: TypeRung;
}

/** One rung above the body for the header, one below it for the small role. */
const HEADER_RUNGS_ABOVE_BODY = 1;
const SMALL_RUNGS_BELOW_BODY = 1;

export function tierRungs(tier: TypeTier): TierRungs {
  const body = rungAt(tier.body);
  return {
    tier: tier.tier,
    body,
    header: rungStep(body, HEADER_RUNGS_ABOVE_BODY),
    year: body,
    label: body,
    small: rungStep(body, -SMALL_RUNGS_BELOW_BODY),
  };
}

/**
 * The body height this panel would ask for if the ladder were continuous.
 *
 * Exported because it is the derivation the table's boundaries come from, and a
 * table whose rows nobody can check against their own arithmetic is a table
 * somebody will edit by eye. `type-tiers.test.ts` walks the whole supported
 * range and asserts every boundary is where the nearest rung to this changes.
 */
export function bodyHeightTarget(shortSide: number): number {
  return ANCHOR_BODY_HEIGHT * (Math.max(1, shortSide) / ANCHOR_SHORT_SIDE) ** SIZE_EXPONENT;
}

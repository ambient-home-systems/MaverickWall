import { z } from 'zod';

/**
 * Signal Data — what a module may offer the interrupt evaluator.
 *
 * The other half of the module contract from Panel Data (panel-data.ts). A
 * panel is a block on the wall; a signal is a *fact the rules can match on*,
 * and matching one can raise a banner or take the whole wall over. So this is
 * the safety-sensitive boundary, and it is deliberately narrow:
 *
 *   - Every string is sanitised the way CAP and Home Assistant strings are —
 *     whitespace collapsed, control and bidi characters stripped, length
 *     capped. A signal title ends up in the largest text on the wall.
 *   - `severity` is the closed CAP-style enum and nothing else. `Unknown` is
 *     not offered: a module either knows or omits it. Absent reads as "no
 *     severity", which the household's rule treats as the lowest rank.
 *   - Times are relative (`startsInSec`) so nothing depends on the module's
 *     clock agreeing with ours; the adapter anchors them to our `now`.
 *   - The array is capped. A module cannot bury the wall under signals.
 *
 * `.strict()` throughout: an unknown key is a module doing something this
 * contract did not agree to, and the safe answer is to reject the payload
 * rather than draw part of it.
 *
 * None of this decides whether a signal does anything. That is the household's
 * per-module `alerts_action` (default `none`) and a source-scoped rule — a
 * validated signal from a module the household never armed still raises
 * nothing. See modules/external/index.ts and api/rules.ts.
 */

/**
 * The control class the CAP and Home Assistant sanitisers strip, expressed as
 * Unicode properties so there is not a single literal control byte in the
 * source: `Cc` is the C0/C1 controls, `Cf` the zero-width, bidi-override and
 * isolate format characters plus the BOM, and `Zl`/`Zp` the line and paragraph
 * separators. A signal title is drawn at the largest size on the wall, so a
 * bidi override in it is not a typo — it is a legibility attack.
 */
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Collapse whitespace, strip control/bidi characters, cap length. */
function clean(max: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    return value
      .replace(/\s+/g, ' ')
      .replace(CONTROLS, '')
      .replace(/\s+/g, ' ')
      .trim();
  }, z.string().min(1).max(max));
}

const signalSchema = z
  .object({
    /**
     * Stable within the module. A module changing this every poll is a new
     * interrupt every poll — the household never gets to dismiss one, because
     * the thing it dismissed is already gone.
     */
    key: clean(120),
    /** What the wall says: `Bins out tonight`, `Freezer door open`. */
    title: clean(80),
    /** Optional CAP-style severity. Absent means the rules see the lowest rank. */
    severity: z.enum(['Minor', 'Moderate', 'Severe', 'Extreme']).optional(),
    /**
     * Seconds until the thing itself begins, for a "starting soon" rule. The
     * adapter turns this into an absolute `startsAt` against our own clock, so
     * the module's clock never has to agree with ours. Capped at 30 days.
     */
    startsInSec: z.number().int().min(0).max(30 * 24 * 60 * 60).optional(),
  })
  .strict();

export const signalDataSchema = z
  .object({
    // 0 is allowed and means "nothing is true right now" — the ordinary case a
    // module reports far more often than an alert.
    signals: z.array(signalSchema).max(12),
  })
  .strict();

export type SignalData = z.infer<typeof signalDataSchema>;
export type ModuleSignal = z.infer<typeof signalSchema>;

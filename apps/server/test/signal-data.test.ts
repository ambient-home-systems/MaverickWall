import { describe, expect, it } from 'vitest';
import { signalDataSchema } from '../src/modules/external/signal-data.js';

/**
 * Signal Data validation (modules/external/signal-data.ts).
 *
 * This is the boundary a third-party module's alerts cross, and one of them can
 * cover the whole wall — so the tests are about what the schema *refuses* as
 * much as what it accepts.
 */
describe('signal data schema', () => {
  it('accepts an empty list — the ordinary "nothing is true" report', () => {
    const parsed = signalDataSchema.safeParse({ signals: [] });
    expect(parsed.success).toBe(true);
  });

  it('accepts key, title, optional severity and startsInSec', () => {
    const parsed = signalDataSchema.safeParse({
      signals: [{ key: 'bins', title: 'Bins out', severity: 'Moderate', startsInSec: 3600 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('strips control and bidi characters from a title', () => {
    // A right-to-left override in the largest text on the wall is a legibility
    // attack, not a typo. The same class the CAP sanitiser removes.
    const parsed = signalDataSchema.safeParse({
      signals: [{ key: 'k', title: 'Bins‮tuo  out​' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.signals[0]!.title).toBe('Binstuo out');
  });

  it('rejects an unknown key rather than drawing part of the payload', () => {
    const parsed = signalDataSchema.safeParse({
      signals: [{ key: 'k', title: 't', action: 'takeover_and_wake' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a severity outside the CAP enum, including Unknown', () => {
    expect(signalDataSchema.safeParse({ signals: [{ key: 'k', title: 't', severity: 'Unknown' }] }).success).toBe(false);
    expect(signalDataSchema.safeParse({ signals: [{ key: 'k', title: 't', severity: 'Loud' }] }).success).toBe(false);
  });

  it('rejects a title that is only whitespace and control characters', () => {
    const parsed = signalDataSchema.safeParse({ signals: [{ key: 'k', title: '​ ' }] });
    expect(parsed.success).toBe(false);
  });

  it('caps the number of signals so a module cannot bury the wall', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, title: `t${i}` }));
    expect(signalDataSchema.safeParse({ signals: many }).success).toBe(false);
  });

  it('rejects a negative or fractional startsInSec', () => {
    expect(signalDataSchema.safeParse({ signals: [{ key: 'k', title: 't', startsInSec: -1 }] }).success).toBe(false);
    expect(signalDataSchema.safeParse({ signals: [{ key: 'k', title: 't', startsInSec: 1.5 }] }).success).toBe(false);
  });
});

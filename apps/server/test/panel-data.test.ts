import { describe, expect, it } from 'vitest';
import { panelDataSchema } from '../src/modules/external/panel-data.js';

/**
 * The Panel Data Schema — the boundary between a third-party module's HTTP body
 * and the manifest (docs/rfc-001-module-framework.md). The tests that matter are
 * about what it refuses: an unknown kind, an extra key, an over-long string, an
 * empty list. Rule five — reject, not coerce.
 */
describe('panelDataSchema', () => {
  it('accepts each shape in the vocabulary', () => {
    expect(panelDataSchema.safeParse({ kind: 'readings', title: 'House', items: [{ label: 'Door', value: 'Locked', glyph: 'lock' }] }).success).toBe(true);
    expect(panelDataSchema.safeParse({ kind: 'stat', value: '135', caption: 'days' }).success).toBe(true);
    expect(panelDataSchema.safeParse({ kind: 'tiles', items: [{ label: 'Mon', value: '24' }] }).success).toBe(true);
    expect(panelDataSchema.safeParse({ kind: 'text', text: 'Bins out tonight' }).success).toBe(true);
  });

  it('refuses an unknown kind', () => {
    expect(panelDataSchema.safeParse({ kind: 'website', url: 'https://evil' }).success).toBe(false);
  });

  it('refuses an unknown key rather than dropping it (strict)', () => {
    expect(panelDataSchema.safeParse({ kind: 'stat', value: '1', script: 'alert(1)' }).success).toBe(false);
    expect(
      panelDataSchema.safeParse({ kind: 'readings', items: [{ label: 'a', value: 'b', href: 'x' }] }).success,
    ).toBe(false);
  });

  it('refuses an empty or oversized list, and an over-long string', () => {
    expect(panelDataSchema.safeParse({ kind: 'readings', items: [] }).success).toBe(false);
    const many = Array.from({ length: 13 }, () => ({ label: 'a', value: 'b' }));
    expect(panelDataSchema.safeParse({ kind: 'readings', items: many }).success).toBe(false);
    expect(panelDataSchema.safeParse({ kind: 'text', text: 'x'.repeat(281) }).success).toBe(false);
  });

  it('refuses a missing required field', () => {
    expect(panelDataSchema.safeParse({ kind: 'stat' }).success).toBe(false);
    expect(panelDataSchema.safeParse({ kind: 'text' }).success).toBe(false);
  });
});

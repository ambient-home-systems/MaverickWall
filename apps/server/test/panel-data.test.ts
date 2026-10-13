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

  it('keeps a row’s tone, from the closed list, and refuses any other word (M7.2)', () => {
    const parsed = panelDataSchema.parse({
      kind: 'readings',
      items: [
        { label: 'Shed door', value: 'Open', glyph: 'door', tone: 'alert' },
        { label: 'Sprinkler', value: 'Running', tone: 'active' },
        { label: 'Soil', value: 'Damp' },
      ],
    });
    expect(parsed).toEqual({
      kind: 'readings',
      items: [
        { label: 'Shed door', value: 'Open', glyph: 'door', tone: 'alert' },
        { label: 'Sprinkler', value: 'Running', tone: 'active' },
        { label: 'Soil', value: 'Damp' },
      ],
    });
    for (const tone of ['red', 'Alert', '#ff0000', '']) {
      expect(panelDataSchema.safeParse({ kind: 'readings', items: [{ label: 'a', value: 'b', tone }] }).success).toBe(false);
    }
    expect(panelDataSchema.safeParse({ kind: 'tiles', items: [{ label: 'a', value: 'b', tone: 'idle' }] }).success).toBe(true);
    expect(panelDataSchema.safeParse({ kind: 'tiles', items: [{ label: 'a', value: 'b', tone: 'loud' }] }).success).toBe(false);
  });

  it('keeps a row’s progress from 0 to 100, and refuses one outside it (M7.3)', () => {
    expect(
      panelDataSchema.parse({ kind: 'readings', items: [{ label: 'Backup', value: '45%', progress: 45 }] }),
    ).toEqual({ kind: 'readings', items: [{ label: 'Backup', value: '45%', progress: 45 }] });
    for (const progress of [0, 100, 12.5]) {
      expect(panelDataSchema.safeParse({ kind: 'readings', items: [{ label: 'a', value: 'b', progress }] }).success).toBe(true);
    }
    for (const progress of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY, '45', '45%']) {
      expect(panelDataSchema.safeParse({ kind: 'readings', items: [{ label: 'a', value: 'b', progress }] }).success).toBe(false);
    }
    expect(panelDataSchema.safeParse({ kind: 'tiles', items: [{ label: 'a', value: 'b', progress: 50 }] }).success).toBe(true);
  });

  it('accepts one gauge, and refuses one with no progress, a progress out of range or a stray key (M7.3)', () => {
    const gauge = { kind: 'gauge', title: 'Water butt', label: 'Full', value: '72%', progress: 72, tone: 'idle' };
    expect(panelDataSchema.parse(gauge)).toEqual(gauge);
    expect(panelDataSchema.safeParse({ kind: 'gauge', label: 'Full', value: '72%' }).success).toBe(false);
    expect(panelDataSchema.safeParse({ ...gauge, progress: 150 }).success).toBe(false);
    expect(panelDataSchema.safeParse({ ...gauge, tone: 'red' }).success).toBe(false);
    expect(panelDataSchema.safeParse({ ...gauge, colour: '#f00' }).success).toBe(false);
    expect(panelDataSchema.safeParse({ ...gauge, label: undefined }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { M3_SCHEMES, type M3Scheme } from '../src/http/m3-tokens.js';

/**
 * The committed Material Design 3 schemes, held to the contrast the tonal
 * system promises.
 *
 * The generator derives every role from tone pairs the spec guarantees are
 * legible; this test proves that from the committed hex values with WCAG's own
 * arithmetic, independently of the library that produced them. So it holds
 * twice over: against a generator upgrade that quietly changes a mapping, and
 * against the hand edit the module's header says not to make.
 */

/** WCAG 2.x relative luminance, from the definition, not from a library. */
function luminance(hex: string): number {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  expect(match, `${hex} is not a #RRGGBB colour`).not.toBeNull();
  const value = parseInt((match as RegExpExecArray)[1] as string, 16);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every `on-X` role paired with its `X`, by the naming rule itself. */
function pairsOf(roles: Readonly<Record<string, string>>): [string, string][] {
  return Object.keys(roles)
    .filter((role) => role.startsWith('on-'))
    .map((role) => [role, role.slice(3)]);
}

const schemes: ['dark' | 'light', M3Scheme][] = [
  ['dark', M3_SCHEMES.dark],
  ['light', M3_SCHEMES.light],
];

describe.each(schemes)('the %s scheme', (name, scheme) => {
  it('keeps every on-X legible over its X at 4.5:1', () => {
    for (const record of [scheme.sys, scheme.custom]) {
      for (const [on, base] of pairsOf(record)) {
        const baseHex = record[base];
        expect(baseHex, `${name}: ${on} has no partner role ${base}`).toBeDefined();
        const ratio = contrast(record[on] as string, baseHex as string);
        expect(ratio, `${name}: ${on} over ${base}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The rule above walks whatever the module emits, so an emptied or renamed
    // module must fail here rather than pass over nothing.
    expect(pairsOf(scheme.sys).length).toBeGreaterThanOrEqual(10);
    expect(pairsOf(scheme.custom).length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the inverse pair legible too', () => {
    // `inverse-on-surface` does not start with `on-`, so the naming rule
    // misses it; it is the one pairing spelled by hand.
    const ratio = contrast(
      scheme.sys['inverse-on-surface'] as string,
      scheme.sys['inverse-surface'] as string,
    );
    expect(ratio, `${name}: inverse-on-surface over inverse-surface`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the outline visible against every surface it can border', () => {
    const surfaces = [
      'surface', 'surface-dim', 'surface-bright',
      'surface-container-lowest', 'surface-container-low', 'surface-container',
      'surface-container-high', 'surface-container-highest',
    ];
    for (const surface of surfaces) {
      const ratio = contrast(scheme.sys['outline'] as string, scheme.sys[surface] as string);
      expect(ratio, `${name}: outline against ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps body text legible on every container the aliases put it on', () => {
    // --ink and --muted land on --bg, --panel and --panel2, which alias
    // surface, surface-container and surface-container-high. The M3 pairing
    // only names on-surface over surface; the stylesheet leans harder than
    // that, so the test does too.
    for (const text of ['on-surface', 'on-surface-variant']) {
      for (const surface of ['surface', 'surface-container', 'surface-container-high']) {
        const ratio = contrast(scheme.sys[text] as string, scheme.sys[surface] as string);
        expect(ratio, `${name}: ${text} over ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

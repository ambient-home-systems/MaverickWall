import { describe, expect, it } from 'vitest';
import {
  ADMIN_SCHEMES,
  TYPE_ROLES,
  adminColorVars,
  adminTypeVars,
  type AdminScheme,
} from '../src/http/design-tokens.js';

/**
 * The admin's hand-picked schemes, held to the contrast they claim.
 *
 * The palette this replaced was generated from a seed by Material's tonal
 * engine, which guarantees its own pairings — so the test that guarded it was
 * really checking the library had not regressed. These values are chosen, so
 * the guarantee has to come from here: every pair the stylesheet actually
 * paints is listed below with the ratio it needs, computed from the committed
 * hex with WCAG's own arithmetic.
 *
 * The list is written out rather than derived from a naming rule (the old
 * `on-X` over `X` convention) because the new vocabulary has no such rule —
 * `ink-2` on `surface-3` is a real pairing and no name says so. A pair missing
 * from this table is a pair nothing checks, which is the one weakness of doing
 * it this way; the role-parity test below is what stops the table going stale
 * as roles are added.
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

/**
 * Text pairs, at 4.5:1 — the ratio for body copy at these sizes.
 *
 * The three grounds are listed against each ink because the stylesheet really
 * does put all of them everywhere: a card is `surface`, an input and the
 * compact settings rows are `surface-2`, a tag and a nav badge are `surface-3`.
 */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ...['ink', 'ink-2', 'accent'].flatMap((ink) =>
    ['bg', 'surface', 'surface-2', 'surface-3'].map((ground) => [ink, ground] as const),
  ),
  // Filled and tinted containers, each with the text that lands on it.
  ['accent-ink', 'accent'],
  ['accent-soft-ink', 'accent-soft'],
  ['danger-ink', 'danger'],
  ['danger', 'danger-soft'],
  ['ok', 'ok-soft'],
  ['warn', 'warn-soft'],
  ['night', 'night-soft'],
  // Status text set directly on a card, which is what a .frow does.
  ...['danger', 'ok', 'warn', 'night'].map((hue) => [hue, 'surface'] as const),
  // And directly on the page ground: the settings form's "Not saved yet" flag
  // sits in `.content`, which is `bg` rather than a card (RFC 009 Phase 3.2).
  ['warn', 'bg'],
];

/**
 * Non-text pairs, at 3:1 — a border or an icon has to be *seen*, not read.
 * `line` is exempt and checked separately: a divider inside a card is supposed
 * to be near-invisible, and holding it to 3:1 would make it a box rule.
 */
const OBJECT_PAIRS: readonly (readonly [string, string])[] = [
  // `ink-3` is the control-boundary role: the text field's border, the
  // segmented control's, a chip's outline. It is deliberately NOT the divider
  // colour — see the rule-ordering test below for why they are separate.
  ['ink-3', 'bg'],
  ['ink-3', 'surface'],
  ['ink-3', 'surface-2'],
  ['focus', 'bg'],
  ['focus', 'surface'],
];

const schemes: ['dark' | 'light', AdminScheme][] = [
  ['dark', ADMIN_SCHEMES.dark],
  ['light', ADMIN_SCHEMES.light],
];

describe.each(schemes)('the %s scheme', (name, scheme) => {
  const role = (key: string): string => {
    const value = scheme.color[key];
    expect(value, `${name}: no such role ${key}`).toBeDefined();
    return value as string;
  };

  it('keeps every text pair legible at 4.5:1', () => {
    for (const [ink, ground] of TEXT_PAIRS) {
      const ratio = contrast(role(ink), role(ground));
      expect(ratio, `${name}: ${ink} over ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
    // The table must not be silently emptied — this test passing over nothing
    // is the failure mode the old one guarded against too.
    expect(TEXT_PAIRS.length).toBeGreaterThanOrEqual(20);
  });

  it('keeps every border and icon visible at 3:1', () => {
    for (const [object, ground] of OBJECT_PAIRS) {
      const ratio = contrast(role(object), role(ground));
      expect(ratio, `${name}: ${object} against ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('orders the three rules from invisible to visible', () => {
    // `line` separates rows inside a card and should barely register;
    // `line-strong` separates sections; `ink-3` bounds a control and has to
    // clear 3:1 above. Collapsing any two of them is how a settings page ends
    // up looking either boxed-in or unstructured.
    const against = (key: string): number => contrast(role(key), role('surface'));
    expect(against('line')).toBeLessThan(against('line-strong'));
    expect(against('line-strong')).toBeLessThan(against('ink-3'));
  });

  it('keeps the soft divider present but quiet', () => {
    // Both directions matter. Below 1.15 it vanishes and a card's rows run
    // together; above 2.2 it stops being a hairline and starts boxing things
    // in, which is the look this design system is getting away from.
    const ratio = contrast(role('line'), role('surface'));
    expect(ratio, `${name}: line against surface`).toBeGreaterThan(1.15);
    expect(ratio, `${name}: line against surface`).toBeLessThan(2.2);
  });

  it('separates the three grounds enough to read without a shadow', () => {
    // The whole reason there is no elevation ladder: a card must be tellable
    // from the page, and an input from the card, by ground alone.
    const steps: readonly (readonly [string, string])[] = [
      ['bg', 'surface'],
      ['surface', 'surface-2'],
      ['surface-2', 'surface-3'],
    ];
    for (const [a, b] of steps) {
      const step = Math.abs(luminance(role(a)) - luminance(role(b)));
      expect(step, `${name}: ${a} to ${b} is not a visible step`).toBeGreaterThan(0.004);
    }
  });

  it('states every colour as a hex or an rgba, and nothing else', () => {
    // A role that is a bare name or a color-mix() would resolve differently
    // per browser and could not be checked above.
    for (const [key, value] of Object.entries(scheme.color)) {
      expect(value, `${name}: ${key} = ${value}`).toMatch(
        /^(#[0-9A-F]{6}|rgba\(\d+,\d+,\d+,\.\d+\))$/,
      );
    }
  });
});

describe('the two schemes together', () => {
  it('declare exactly the same roles', () => {
    // A role in one scheme and not the other is a var() that resolves to
    // nothing on whichever theme is missing it — an invisible control, and
    // only on the theme nobody happened to be looking at.
    const dark = Object.keys(ADMIN_SCHEMES.dark.color).sort();
    const light = Object.keys(ADMIN_SCHEMES.light.color).sort();
    expect(light).toEqual(dark);
  });

  it('are genuinely different palettes, not one with a flipped flag', () => {
    const dark = ADMIN_SCHEMES.dark.color;
    const light = ADMIN_SCHEMES.light.color;
    const shared = Object.keys(dark).filter((k) => dark[k] === light[k]);
    expect(shared, `roles identical in both schemes: ${shared.join(', ')}`).toHaveLength(0);
  });

  it('put a dark ground under the dark scheme and a light one under the light', () => {
    expect(luminance(ADMIN_SCHEMES.dark.color['bg'] as string)).toBeLessThan(0.1);
    expect(luminance(ADMIN_SCHEMES.light.color['bg'] as string)).toBeGreaterThan(0.7);
  });
});

describe('the emitted custom properties', () => {
  it('name every colour role once, prefixed', () => {
    const css = adminColorVars(ADMIN_SCHEMES.dark);
    for (const key of Object.keys(ADMIN_SCHEMES.dark.color)) {
      expect(css).toContain(`--mw-${key}:`);
    }
    expect(css.split(';')).toHaveLength(Object.keys(ADMIN_SCHEMES.dark.color).length);
  });

  it('emit four parts and a shorthand for every type role', () => {
    const css = adminTypeVars();
    for (const role of TYPE_ROLES) {
      for (const part of ['size', 'lh', 'weight', 'tracking']) {
        expect(css, `${role} is missing its ${part}`).toContain(`--mw-t-${role}-${part}:`);
      }
      // The shorthand, which is what most call sites use.
      expect(css, `${role} has no font shorthand`).toMatch(
        new RegExp(`--mw-t-${role}:\\d+ [\\d.]+px/\\d+px var\\(--sans\\)`),
      );
    }
    expect(TYPE_ROLES.length).toBeGreaterThanOrEqual(10);
  });

  it('sets headings heavier than body text', () => {
    // The brief this scale was drawn for is glanceability, and Material's
    // scale set every heading at 400. If a heading ever drops back to body
    // weight, the scale has been quietly undone.
    const css = adminTypeVars();
    const weightOf = (role: string): number => {
      const match = new RegExp(`--mw-t-${role}-weight:(\\d+)`).exec(css);
      expect(match, `no weight for ${role}`).not.toBeNull();
      return Number((match as RegExpExecArray)[1]);
    };
    for (const heading of ['display', 'h1', 'h2', 'h3', 'h4']) {
      expect(weightOf(heading), `${heading} is not heavier than body`).toBeGreaterThan(
        weightOf('body'),
      );
    }
  });
});

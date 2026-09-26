import { describe, expect, it } from 'vitest';

import { buildManifest, type BuildManifestInput, type HouseholdRow, type PlacedWidgetRow } from '../src/api/manifest.js';
import { BUILTIN_THEME_TOKENS, builtinThemeTokens } from '../src/api/builtin-themes.js';
import { withTints } from '../src/api/themes.js';
import { widgetConfigBody } from '../src/api/widget-schema.js';
import {
  STYLE_DERIVED,
  STYLE_INSET_CSS,
  STYLE_LANE_TOKENS,
  resolveStyleTokens,
  storedStyleLayer,
  styleLayerOf,
  widgetStyleBody,
} from '../src/api/widget-style.js';

/**
 * The per-widget style lane (RFC 014 §4.1), at the boundary and in assembly.
 *
 * Three things have to be true and none of them is provable by reading:
 *
 * 1. **The schema is the theme's, picked.** A colour that is not a `#rrggbb`
 *    and a face outside `FONTS` are refused by the same rule a theme's are;
 *    `--radius` and `scale` are not in the lane by decision; and `ink.style`
 *    is a rejected key, so there is no second lane nobody designed.
 * 2. **Resolution emits what the lane moved and nothing else**, with the
 *    derived tokens re-measured against *that* widget's ground. The sharp
 *    case is the one the RFC names: a widget that sets `--bg` and `--ink`
 *    gets an `--ink-scaffold` that clears 4.5:1 against its own `--bg`, not
 *    the theme's.
 * 3. **An unstyled wall's document is byte-identical to the one it sent
 *    before the lane existed.** Spread, never emitted empty: `manifestEtag`
 *    hashes the serialisation, so a `styleTokens: undefined` on every widget
 *    in the world would churn every stored ETag at one image pull.
 */

const FRAUNCES = "'Fraunces', Georgia, serif";

describe('the lane’s shape', () => {
  it('is the theme schema picked, every member optional', () => {
    expect(widgetStyleBody.safeParse({}).success).toBe(true);
    expect(widgetStyleBody.safeParse({ '--accent': '#FF0000' }).success).toBe(true);
    expect(widgetStyleBody.safeParse({ '--disp': FRAUNCES, weight: 'bold', tracking: 'wide', inset: 2 }).success).toBe(
      true,
    );
  });

  it('refuses by the theme’s own rules: a non-hex colour, a face off the allowlist', () => {
    expect(widgetStyleBody.safeParse({ '--accent': 'red' }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ '--f-sans': 'Comic Sans, cursive' }).success).toBe(false);
  });

  it('carries no radius and no scale, and nothing it was not told about (rule five)', () => {
    expect(widgetStyleBody.safeParse({ '--radius': '0.4rem' }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ scale: 1.1 }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ nonsense: 1 }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ weight: 'heavy' }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ inset: 5 }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ inset: 1.5 }).success).toBe(false);
  });

  it('sits on a widget beside ink, and never inside it', () => {
    expect(widgetConfigBody.safeParse({ style: { '--accent': '#FF0000' } }).success).toBe(true);
    expect(widgetConfigBody.safeParse({ ink: { style: { '--accent': '#FF0000' } } }).success).toBe(false);
    expect(widgetConfigBody.safeParse({ style: { style: {} } }).success).toBe(false);
  });

  it('reads a stored lane defensively, and an empty one as none', () => {
    expect(styleLayerOf(undefined)).toBeUndefined();
    expect(styleLayerOf('nonsense')).toBeUndefined();
    expect(styleLayerOf([])).toBeUndefined();
    expect(styleLayerOf({})).toBeUndefined();
    expect(styleLayerOf({ '--accent': 'red' })).toBeUndefined();
    expect(styleLayerOf({ '--accent': '#FF0000' })).toEqual({ '--accent': '#FF0000' });
    expect(storedStyleLayer(null)).toBeUndefined();
    expect(storedStyleLayer('')).toBeUndefined();
    expect(storedStyleLayer('{not json')).toBeUndefined();
    expect(storedStyleLayer('{}')).toBeUndefined();
    expect(storedStyleLayer('{"inset":1}')).toEqual({ inset: 1 });
  });
});

/** WCAG contrast, spelled again here so the assertion is a second opinion. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1), 16);
    // eslint-disable-next-line no-bitwise
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const ch = (raw: number): number => {
      const c = raw / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(rgb[0]!) + 0.7152 * ch(rgb[1]!) + 0.0722 * ch(rgb[2]!);
  };
  const [la, lb] = [lum(a), lum(b)];
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('resolution', () => {
  const PANELS = builtinThemeTokens('panels');

  it('emits nothing for no lane, and nothing for a lane that says nothing', () => {
    expect(resolveStyleTokens(PANELS, [], undefined)).toBeUndefined();
    expect(resolveStyleTokens(PANELS, [], {})).toBeUndefined();
  });

  it('emits exactly what the lane set, plus the derived tokens that input feeds', () => {
    const accent = resolveStyleTokens(PANELS, [], { '--accent': '#FF0000' });
    expect(accent).toEqual({ '--accent': '#FF0000' });
    // `--muted` feeds two derived tokens and no other: the quiet ink, a
    // straight copy, and the idle Home Assistant state (P4.5), which is the
    // muted ink pushed toward `--ink` until it clears 4.5:1 on both grounds —
    // `#808080` does not on Panels' ground, so it comes back lifted. The
    // letter moved when that token joined `STYLE_DERIVED`; the intent — a
    // lane emits exactly what its own tokens feed — did not.
    const muted = resolveStyleTokens(PANELS, [], { '--muted': '#808080' });
    expect(Object.keys(muted!).sort()).toEqual(['--ink-quiet', '--muted', '--state-idle']);
    expect(muted!['--ink-quiet']).toBe('#808080');
    expect(contrast(muted!['--state-idle']!, PANELS['--bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted!['--state-idle']!, PANELS['--panel'])).toBeGreaterThanOrEqual(4.5);
  });

  it('re-derives the scaffold against the widget’s own ground, clearing 4.5:1 (the RFC’s case)', () => {
    const tokens = resolveStyleTokens(PANELS, [], { '--bg': '#FFF8E7', '--ink': '#2A2A2A' });
    expect(tokens).toBeDefined();
    const scaffold = tokens?.['--ink-scaffold'];
    expect(scaffold).toBeDefined();
    expect(contrast(scaffold!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
    // And it is the theme derivation, not a second one: the same call
    // `withTints` makes for a custom theme over the same effective colours.
    const asTheme = withTints({ ...PANELS, '--bg': '#FFF8E7', '--ink': '#2A2A2A', '--radius': '0' });
    expect(scaffold).toBe(asTheme['--ink-scaffold']);
    // Panels' own scaffold would not have cleared it — which is the fault.
    expect(contrast('#9B9B9A', '#FFF8E7')).toBeLessThan(4.5);
    // `--bg` moved, so every tint moved with it, measured against the new ground.
    for (const entry of STYLE_DERIVED) {
      if (entry.from.includes('--bg') || entry.from.includes('--ink')) expect(tokens).toHaveProperty(entry.token);
      else expect(tokens).not.toHaveProperty(entry.token);
    }
  });

  it('measures a widget’s scaffold against the wall’s default lane beneath it', () => {
    // The wall's default set a cream ground; the widget sets only its ink.
    const canvas = { '--bg': '#FFF8E7' };
    const tokens = resolveStyleTokens(PANELS, [canvas], { '--ink': '#2A2A2A' });
    expect(tokens?.['--bg']).toBeUndefined();
    expect(contrast(tokens!['--ink-scaffold']!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
    // Without the context the same lane is measured against Panels' dark
    // ground and lands somewhere else entirely.
    const alone = resolveStyleTokens(PANELS, [], { '--ink': '#2A2A2A' });
    expect(alone!['--ink-scaffold']).not.toBe(tokens!['--ink-scaffold']);
  });

  it('maps the three enums to the properties the box reads', () => {
    expect(resolveStyleTokens(PANELS, [], { weight: 'medium' })).toEqual({ 'font-weight': '500' });
    expect(resolveStyleTokens(PANELS, [], { tracking: 'tight' })).toEqual({ 'letter-spacing': 'var(--ls-time)' });
    expect(resolveStyleTokens(PANELS, [], { tracking: 'normal' })).toEqual({ 'letter-spacing': 'normal' });
    expect(resolveStyleTokens(PANELS, [], { inset: 0 })).toEqual({ '--fw-inset': '0px' });
    expect(resolveStyleTokens(PANELS, [], { inset: 4 })).toEqual({ '--fw-inset': 'var(--s4)' });
    expect(STYLE_INSET_CSS).toHaveLength(5);
  });

  it('can take the theme’s shadow away and can never add one (P5.3)', () => {
    // The tile look draws the theme's `--shadow-card`; the lane's one say in
    // it is "none", so a household can switch a widget's shadow off and no
    // lane can put a literal shadow on a wall an e-ink preset keeps flat.
    expect(resolveStyleTokens(PANELS, [], { shadow: 'none' })).toEqual({ '--shadow-card': 'none' });
    expect(widgetStyleBody.safeParse({ shadow: 'none' }).success).toBe(true);
    expect(widgetStyleBody.safeParse({ shadow: 'soft' }).success).toBe(false);
    expect(widgetStyleBody.safeParse({ shadow: '0 2px 8px black' }).success).toBe(false);
  });

  it('emits its keys in one order whatever order the lane was written in', () => {
    const a = resolveStyleTokens(PANELS, [], { weight: 'bold', '--ink': '#000000', '--bg': '#FFFFFF' });
    const b = resolveStyleTokens(PANELS, [], { '--bg': '#FFFFFF', '--ink': '#000000', weight: 'bold' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a!)[0]).toBe('--bg');
  });

  it('names every derived input among the lane’s own tokens', () => {
    for (const entry of STYLE_DERIVED) {
      for (const input of entry.from) expect(STYLE_LANE_TOKENS).toContain(input);
    }
  });
});

// ---- Assembly -----------------------------------------------------------------

const NOW = Date.parse('2026-09-10T12:00:00Z');

const HOUSEHOLD: HouseholdRow = {
  timezone: 'Europe/London',
  shiftEnabled: 0,
  displayTodayEvents: 8,
  displayNextDays: 6,
  displayHorizonWeeks: 5,
  displayBlocks: 'now,next,horizon',
  clock24: 1,
  weekStart: 'monday',
  layoutMode: 'freeform',
  layoutAspect: 0.5625,
  layoutLandscapeAspect: 1.7778,
  layoutBackground: null,
  layoutLandscapeBackground: null,
};

const widget = (id: string, config: unknown): PlacedWidgetRow => ({
  id, type: 'clock', x: 0, y: 0, w: 0.5, h: 0.2, z: 0, config,
});

const BASE: BuildManifestInput = {
  household: HOUSEHOLD,
  events: [],
  sources: [],
  people: [],
  shiftTypes: [],
  shiftPlans: [],
  shiftOverrides: [],
  today: '2026-09-10',
  daysBefore: 1,
  daysAfter: 5,
  now: NOW,
  appVersion: '0.1.0',
  screen: { orientation: 'auto', rotation: 0, theme: 'panels' },
  layoutWidgetsPortrait: [widget('a', { showDate: false }), widget('b', undefined)],
};

describe('assembly', () => {
  it('leaves an unstyled wall’s document without a trace of the lane', () => {
    const json = JSON.stringify(buildManifest(BASE));
    expect(json).not.toContain('styleTokens');
    expect(json).not.toContain('StyleTokens');
    // The exact key set a placed widget has always had — a new key here is a
    // new key on every wall in the world.
    for (const placed of buildManifest(BASE).layout.portrait.widgets) {
      expect(Object.keys(placed).sort()).toEqual(['config', 'h', 'id', 'type', 'w', 'x', 'y', 'z']);
    }
    // And a stored column that is null, empty, or not a lane is the same document.
    for (const column of [null, '', '{}', '{"nonsense":1}', 'not json']) {
      expect(JSON.stringify(buildManifest({ ...BASE, screen: { ...BASE.screen!, layoutStyle: column } }))).toBe(json);
    }
  });

  it('resolves a widget’s lane against the wall’s theme and carries it beside the config', () => {
    const styled = widget('c', { style: { '--bg': '#FFF8E7', '--ink': '#2A2A2A', inset: 1 } });
    const manifest = buildManifest({ ...BASE, layoutWidgetsPortrait: [styled] });
    const placed = manifest.layout.portrait.widgets[0]!;
    expect(placed.config).toEqual({ style: { '--bg': '#FFF8E7', '--ink': '#2A2A2A', inset: 1 } });
    expect(placed.styleTokens?.['--bg']).toBe('#FFF8E7');
    expect(placed.styleTokens?.['--fw-inset']).toBe('var(--s1)');
    expect(contrast(placed.styleTokens!['--ink-scaffold']!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
    // No daylight theme, no second record.
    expect(placed.daytimeStyleTokens).toBeUndefined();
  });

  it('resolves against a custom theme’s own tokens when the wall wears one', () => {
    const custom = { ...BUILTIN_THEME_TOKENS.household, '--radius': '0' };
    const styled = widget('c', { style: { '--ink': '#2A2A2A' } });
    const manifest = buildManifest({
      ...BASE,
      screen: { ...BASE.screen!, theme: 'custom:abc' },
      resolveTheme: () => ({ tokens: withTints(custom), shape: 'board' }),
      layoutWidgetsPortrait: [styled],
    });
    const placed = manifest.layout.portrait.widgets[0]!;
    // Measured against Household's cream, not Panels' near-black.
    expect(contrast(placed.styleTokens!['--ink-scaffold']!, custom['--bg'])).toBeGreaterThanOrEqual(4.5);
    expect(placed.styleTokens!['--ink-scaffold']).toBe(
      resolveStyleTokens(BUILTIN_THEME_TOKENS.household, [], { '--ink': '#2A2A2A' })!['--ink-scaffold'],
    );
  });

  it('resolves twice when the wall switches at daylight, once per ground', () => {
    const styled = widget('c', { style: { '--ink': '#2A2A2A' } });
    const manifest = buildManifest({
      ...BASE,
      screen: { ...BASE.screen!, daytimeTheme: 'almanac', daytimeStartsAt: '07:00', daytimeEndsAt: '19:00' },
      layoutWidgetsPortrait: [styled],
    });
    const placed = manifest.layout.portrait.widgets[0]!;
    expect(placed.styleTokens).toBeDefined();
    expect(placed.daytimeStyleTokens).toBeDefined();
    expect(placed.styleTokens!['--ink-scaffold']).not.toBe(placed.daytimeStyleTokens!['--ink-scaffold']);
    expect(contrast(placed.daytimeStyleTokens!['--ink-scaffold']!, BUILTIN_THEME_TOKENS.almanac['--bg'])).toBeGreaterThanOrEqual(4.5);
  });

  it('carries the wall’s default lane on the screen, and beneath every widget’s own', () => {
    const styled = widget('c', { style: { '--ink': '#2A2A2A' } });
    const manifest = buildManifest({
      ...BASE,
      screen: { ...BASE.screen!, layoutStyle: JSON.stringify({ '--bg': '#FFF8E7', weight: 'bold' }) },
      layoutWidgetsPortrait: [styled, widget('d', undefined)],
    });
    expect(manifest.screen.layoutStyleTokens).toEqual(
      expect.objectContaining({ '--bg': '#FFF8E7', 'font-weight': '700' }),
    );
    expect(manifest.screen.layoutDaytimeStyleTokens).toBeUndefined();
    const [styledOut, plain] = manifest.layout.portrait.widgets;
    // The widget's ink is measured against the wall lane's cream.
    expect(contrast(styledOut!.styleTokens!['--ink-scaffold']!, '#FFF8E7')).toBeGreaterThanOrEqual(4.5);
    // A sibling with no lane of its own carries nothing: the canvas is where it inherits from.
    expect(Object.keys(plain!).sort()).toEqual(['config', 'h', 'id', 'type', 'w', 'x', 'y', 'z']);
  });
});

// ---- A calendar's look (plan item P5.4) -----------------------------------------

describe('a calendar’s look, laid as a lane under the widget’s own', () => {
  const calendar = (id: string, config: unknown): PlacedWidgetRow => ({ ...widget(id, config), type: 'calendar' });
  const placedOf = (config: unknown, extra: Partial<BuildManifestInput> = {}) =>
    buildManifest({ ...BASE, ...extra, layoutWidgetsPortrait: [calendar('cal', config)] }).layout.portrait.widgets[0]!;

  it('carries nothing for the standard look, so an unstyled calendar sends the row it always sent', () => {
    expect(Object.keys(placedOf(undefined)).sort()).toEqual(['config', 'h', 'id', 'type', 'w', 'x', 'y', 'z']);
    expect(Object.keys(placedOf({ cellEvents: 'swiss' })).sort()).toEqual(['config', 'h', 'id', 'type', 'w', 'x', 'y', 'z']);
    // A look another type owns is not a calendar's.
    expect(placedOf({ variant: 'analogue' }).styleTokens).toBeUndefined();
  });

  it('lays a paper ground on a planner, with its numerals and scaffold measured against the paper', () => {
    const tokens = placedOf({ variant: 'planner' }).styleTokens!;
    expect(tokens['--bg']).toBe(BUILTIN_THEME_TOKENS.almanac['--bg']);
    expect(tokens['--disp']).toBe(FRAUNCES);
    // On Panels' near-black wall, the scaffold is re-derived for cream, not kept dark-on-dark.
    expect(contrast(tokens['--ink-scaffold']!, tokens['--bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(tokens['--ink-scaffold']).not.toBe(withTints({ ...BUILTIN_THEME_TOKENS.panels, '--radius': '0' })['--ink-scaffold']);
  });

  it('lets the household’s own lane win over the planner’s token by token', () => {
    const tokens = placedOf({ variant: 'planner', style: { '--accent': '#0B3D91' } }).styleTokens!;
    expect(tokens['--accent']).toBe('#0B3D91');
    expect(tokens['--bg']).toBe(BUILTIN_THEME_TOKENS.almanac['--bg']);
  });

  it('rules a bold month in the ink the box draws in, under whichever theme is showing', () => {
    const placed = placedOf(
      { variant: 'bold' },
      { screen: { ...BASE.screen!, daytimeTheme: 'almanac', daytimeStartsAt: '07:00', daytimeEndsAt: '19:00' } },
    );
    expect(placed.styleTokens!['--rule']).toBe(BUILTIN_THEME_TOKENS.panels['--ink']);
    expect(placed.styleTokens!['--rule-week']).toBe(BUILTIN_THEME_TOKENS.panels['--ink']);
    expect(placed.daytimeStyleTokens!['--rule']).toBe(BUILTIN_THEME_TOKENS.almanac['--ink']);
    // And follows a widget that set its own ink.
    expect(placedOf({ variant: 'bold', style: { '--ink': '#2A2A2A' } }).styleTokens!['--rule']).toBe('#2A2A2A');
  });
});

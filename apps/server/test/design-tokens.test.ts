import { describe, expect, it } from 'vitest';
import {
  adminStylesheet,
  declarationsOf,
  rulesOf,
  stripComments,
} from './admin-stylesheet.js';
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

/**
 * The same question again, asked of the stylesheet instead of the intent
 * (RFC 009 Phase 6, assertion 4).
 *
 * Everything above validates a token against the job it was *designed* for.
 * That is worth having and it is not enough, and `--mw-ink-3` is the proof:
 * it is declared "placeholder and disabled text only", certified above at 3:1
 * as the control-boundary role — 3.73:1 on `surface`, comfortably clear — and
 * then set as the `color` of twenty-three rules, `.hint` among them, where the
 * bar is 4.5:1 and it does not reach it on any ground in either scheme. Both
 * statements were true at once. Nothing was wrong with the table; the table
 * was answering a different question from the one the browser asks.
 *
 * So this block asks the browser's question: for every rule in the served
 * stylesheet, what does it paint on what? A rule that sets both a `color` and
 * a `background` states its own pair. A rule that sets only a `color` does not
 * know where it will land, so it is held against **all four grounds** — which
 * is not pessimism, it is what the sheet does: a card is `surface`, an input
 * and a settings row are `surface-2`, a tag and a nav badge are `surface-3`.
 *
 * The hand-written tables above are kept rather than replaced. They say what a
 * role is for; this says what the stylesheet does with it. The gap between the
 * two is the bug, so both halves have to be written down for the gap to be
 * visible at all.
 */

/** The four grounds the admin actually paints text on. */
const GROUNDS = ['bg', 'surface', 'surface-2', 'surface-3'] as const;

/**
 * The two rules are exempt from the 3:1 object bar, and are checked instead by
 * `orders the three rules from invisible to visible` and `keeps the soft
 * divider present but quiet` above.
 *
 * This is a real exemption rather than an allow-listed failure: a divider
 * inside a card is *supposed* to be near-invisible, and a derivation reading
 * `border:1px solid var(--mw-line)` cannot tell a hairline between two rows
 * from the outline of a control. Holding them to 3:1 would not fix anything —
 * it would box the whole admin in, which is the look this design system was
 * built to get away from.
 */
const NOT_AN_OBJECT = new Set(['line', 'line-strong']);

/**
 * Pairs the stylesheet paints that do not clear their bar today.
 *
 * `ink-3` as text is the finding this assertion was written for and is the
 * larger half of the list. `ok` on `surface-3` is the same class, one hue
 * along. The `accent-ink` entries are a limitation of the derivation rather
 * than a defect: they are the checkmark drawn inside a *checked* checkbox, so
 * its ground is the accent fill on the parent rule and not any of the four
 * page grounds — the fan-out cannot see that, and narrowing the fan-out to
 * avoid it would lose the `ink-3` border finding beside it, which is worth
 * more.
 *
 * Ratios are recorded so a change to a scheme shows up as a moved number
 * rather than as a line that silently still passes.
 */
const UNMET_PAIRS: readonly string[] = [
  'dark object: accent-ink on bg = 1.03 (needs 3)',
  'dark object: accent-ink on surface = 1.04 (needs 3)',
  'dark object: accent-ink on surface-2 = 1.15 (needs 3)',
  'dark object: accent-ink on surface-3 = 1.30 (needs 3)',
  'dark text: ink-3 on surface = 4.46 (needs 4.5)',
  'dark text: ink-3 on surface-2 = 4.02 (needs 4.5)',
  'dark text: ink-3 on surface-3 = 3.56 (needs 4.5)',
  'light object: accent-ink on bg = 1.08 (needs 3)',
  'light object: accent-ink on surface = 1.00 (needs 3)',
  'light object: accent-ink on surface-2 = 1.15 (needs 3)',
  'light object: accent-ink on surface-3 = 1.27 (needs 3)',
  'light object: ink-3 on surface-3 = 2.95 (needs 3)',
  'light text: ink-3 on bg = 3.46 (needs 4.5)',
  'light text: ink-3 on surface = 3.73 (needs 4.5)',
  'light text: ink-3 on surface-2 = 3.25 (needs 4.5)',
  'light text: ink-3 on surface-3 = 2.95 (needs 4.5)',
  'light text: ok on surface-3 = 4.21 (needs 4.5)',
];

describe('the pairs the stylesheet actually paints', () => {
  const alias = (css: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*var\(\s*(--mw-[a-z0-9-]+)\s*\)/g)) {
      out.set(m[1] as string, m[2] as string);
    }
    return out;
  };

  /**
   * A value that names exactly one role, resolved through the alias layer.
   *
   * `border:1px solid var(--mw-line)` names one; `background:var(--ink-2)`
   * names one through an alias. A value carrying any *other* function names
   * none — and that exclusion is load-bearing rather than tidy. A hover ground
   * here is `color-mix(in srgb, var(--mw-ink-2) 6%, transparent)`: a six per
   * cent wash over whatever the control is sitting on, not a ground of
   * `ink-2`. Reading the mix's first ingredient as the ground reported
   * `.signout:hover` as ink-on-ink-2 at 1.83:1, which is a pair no browser
   * ever paints. An element whose ground is a translucent wash has an unknown
   * ground, so it falls through to the four-ground fan-out below, which is the
   * honest answer.
   */
  const roleOf = (value: string, aliases: Map<string, string>): string | undefined => {
    const references = [...value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)];
    if (references.length !== 1) return undefined;
    if (value.replace(/var\(\s*--[a-zA-Z0-9-]+\s*\)/g, '').includes('(')) return undefined;
    const named = references[0]?.[1] as string;
    const token = aliases.get(named) ?? named;
    if (!token.startsWith('--mw-')) return undefined;
    const role = token.slice('--mw-'.length);
    return role in ADMIN_SCHEMES.dark.color ? role : undefined;
  };

  const BORDER = /^(border|outline)(-(top|right|bottom|left))?(-color)?$/;

  /** Every `role on ground` the sheet paints, as text and as an object. */
  const painted = async (): Promise<{ text: Set<string>; object: Set<string> }> => {
    const css = stripComments(await adminStylesheet());
    const aliases = alias(css);
    const text = new Set<string>();
    const object = new Set<string>();
    for (const rule of rulesOf(css)) {
      if (rule.selectors.some((s) => s.includes(':root'))) continue;
      let ink: string | undefined;
      let ground: string | undefined;
      for (const [property, value] of declarationsOf(rule)) {
        if (property === 'color') ink = roleOf(value, aliases) ?? ink;
        if (property === 'background' || property === 'background-color') {
          ground = roleOf(value, aliases) ?? ground;
        }
      }
      const place = (into: Set<string>, role: string): void => {
        if (ground !== undefined) into.add(`${role}|${ground}`);
        else for (const g of GROUNDS) into.add(`${role}|${g}`);
      };
      if (ink !== undefined) place(text, ink);
      for (const [property, value] of declarationsOf(rule)) {
        if (!BORDER.test(property)) continue;
        const role = roleOf(value, aliases);
        if (role === undefined || NOT_AN_OBJECT.has(role)) continue;
        place(object, role);
      }
    }
    return { text, object };
  };

  it('keeps every painted pair at the bar its job needs', async () => {
    const { text, object } = await painted();
    // A guard on the guard: a derivation that stops finding pairs passes over
    // everything, which is the failure mode of the table it is checking.
    expect(text.size, 'no text pairs derived from the stylesheet').toBeGreaterThan(20);
    expect(object.size, 'no border pairs derived from the stylesheet').toBeGreaterThan(10);

    const unmet: string[] = [];
    for (const [name, scheme] of schemes) {
      for (const [kind, pairs, bar] of [
        ['text', text, 4.5],
        ['object', object, 3],
      ] as const) {
        for (const pair of [...pairs].sort()) {
          const [role, ground] = pair.split('|') as [string, string];
          if (role === ground) continue;
          const a = scheme.color[role];
          const b = scheme.color[ground];
          // `scrim` is an rgba over whatever is behind it and has no ratio.
          if (a === undefined || b === undefined) continue;
          if (!a.startsWith('#') || !b.startsWith('#')) continue;
          const ratio = contrast(a, b);
          if (ratio >= bar) continue;
          unmet.push(`${name} ${kind}: ${role} on ${ground} = ${ratio.toFixed(2)} (needs ${bar})`);
        }
      }
    }

    const permitted = new Set(UNMET_PAIRS);
    const fresh = unmet.filter((entry) => !permitted.has(entry));
    expect(
      fresh,
      `${fresh.length} newly unreadable pairs (allow-list holds ${UNMET_PAIRS.length}):\n` +
        fresh.map((entry) => `  ${entry}`).join('\n'),
    ).toEqual([]);

    const seen = new Set(unmet);
    const stale = UNMET_PAIRS.filter((entry) => !seen.has(entry));
    expect(
      stale,
      `${stale.length} allow-listed pairs are fixed or have moved — delete these lines, ` +
        `the list is down to ${UNMET_PAIRS.length - stale.length}:\n` +
        stale.map((entry) => `  ${entry}`).join('\n'),
    ).toEqual([]);
  });

  it('sees the pairs the hand-written table cannot', async () => {
    // The specific gap this exists for, pinned so a future narrowing of the
    // derivation cannot quietly close it: `ink-3` is in `OBJECT_PAIRS` above
    // at 3:1 and nowhere in `TEXT_PAIRS`, and the stylesheet sets it as
    // `color` all the same.
    const { text } = await painted();
    expect([...text].some((pair) => pair.startsWith('ink-3|'))).toBe(true);
    expect(TEXT_PAIRS.some(([ink]) => ink === 'ink-3')).toBe(false);
  });
});

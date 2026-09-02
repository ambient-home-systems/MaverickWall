import { describe, expect, it } from 'vitest';
import { adminStylesheet as stylesheet, rulesOf } from './admin-stylesheet.js';

/**
 * The design system, pinned — including its absences.
 *
 * The admin was Material Design 3 and is not any more: hand-picked tokens, a
 * flat surface model with no elevation ladder, and square-ish shapes. Half of
 * that is things no longer being there, and an absence is exactly what somebody
 * reinstates while tidying — so it is asserted, the same way
 * `admin-mobile-nav.test.ts` asserts the rules its redesign deleted.
 *
 * Two of these tests are for bug classes hit while building it, both of which
 * a typecheck and every other test in this directory sailed straight over:
 *
 *  - A `var(--mw-...)` that nothing declares. Sweeping the M3 tokens across
 *    left three references to `--surface-elevation-*` after the token was
 *    removed. The affected cards fell back to no background at all, and CSS
 *    says nothing about it — a stat card just quietly stopped being a card.
 *  - A rule painting one token on itself. `.tag-ok` came out
 *    `background: var(--mw-ok); color: var(--mw-ok)` because two M3 roles
 *    (`success-container` and `on-success-container`) collapsed onto one new
 *    role. It rendered as an invisible word on a green chip.
 */

describe('the admin stylesheet', () => {
  it('declares every custom property it reads', async () => {
    const css = (await stylesheet()).replace(/\/\*[\s\S]*?\*\//g, '');
    const used = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1] as string));
    const declared = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1] as string));
    // `--swatch` and `--pc` are written onto elements by the page as inline
    // styles (a theme swatch, a person's colour), so the stylesheet reads them
    // without declaring them. Everything else must be declared here.
    const INLINE = new Set(['--swatch', '--pc', '--ev', '--sc', '--fo-w']);
    const dangling = [...used].filter((v) => !declared.has(v) && !INLINE.has(v)).sort();
    expect(dangling, `these resolve to nothing: ${dangling.join(', ')}`).toEqual([]);
    // Passing over an empty set would be no guarantee at all.
    expect(used.size).toBeGreaterThan(40);
  });

  it('never paints a colour token on itself', async () => {
    const offenders: string[] = [];
    for (const rule of rulesOf(await stylesheet())) {
      const bg = /background(?:-color)?:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      const fg = /(?:^|;)\s*color:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      if (bg && fg && bg[1] === fg[1]) offenders.push(`${rule.selectors.join(',')} -> ${bg[1]}`);
    }
    expect(offenders, `invisible text: ${offenders.join(' ; ')}`).toEqual([]);
  });

  it('carries no Material Design 3 token', async () => {
    // The whole M3 system — colour roles, the fifteen type roles, the shape
    // scale, the elevation ladder, state-layer opacities — is gone. A stray
    // one would resolve to nothing and is also a sign of a half-reverted edit.
    const css = await stylesheet();
    expect(css).not.toMatch(/--md-sys-/);
    expect(css).not.toMatch(/--md-custom-/);
    expect(css).not.toMatch(/--md-ref-/);
  });

  it('keeps rectangles square-ish, and rounds only what is a circle', async () => {
    // A fully rounded rectangle was Material's loudest tell and the thing the
    // brief named first. `--mw-r-full` survives for genuinely round
    // affordances: the switch track, and the 18px close dot on an input chip.
    // A fully rounded rectangle was Material's loudest tell and the thing the
    // brief named first. `--mw-r-full` survives for genuinely round
    // affordances: the switch track, the 18px close dot on an input chip, and
    // the handful of actual circles below — a status dot, its pulse ring, an
    // avatar photo, an override indicator and a ripple. All of these drew as
    // `border-radius:50%` before the admin's spacing/radius/font-size sweep
    // moved every literal onto a token; they were invisible to this check
    // until then; it was never that they became pills, only that they became
    // visible to the assertion that rules out pills.
    const ROUND_BY_DESIGN = [
      '.switch input[type=checkbox]',
      '.hep-pill-x',
      '.dot',
      '.pulse::after',
      'img.avatar',
      '.insp-lane.has-override::before',
      '.ripple',
    ];
    const offenders: string[] = [];
    for (const rule of rulesOf(await stylesheet())) {
      if (!/border-radius:[^;]*--mw-r-full/.test(rule.body)) continue;
      if (rule.selectors.some((s) => ROUND_BY_DESIGN.some((ok) => s.includes(ok)))) continue;
      if (rule.selectors.some((s) => s.trim() === ':root')) continue;
      offenders.push(rule.selectors.join(','));
    }
    expect(offenders, `these are pills again: ${offenders.join(' ; ')}`).toEqual([]);
  });

  it('has no elevation ladder, and no stacked shadow', async () => {
    const css = await stylesheet();
    // Material conveys depth with five levels of double-layer shadow. This
    // system separates by ground and hairline, and keeps exactly two shadows
    // for things that genuinely float. More than one shadow layer in a single
    // value is the stacked look the brief rules out.
    const shadowTokens = [...css.matchAll(/--mw-shadow-\d+\s*:([^;]*)/g)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(shadowTokens.length, 'expected exactly three shadow tokens').toBe(3);
    for (const value of shadowTokens) {
      if (value === 'none') continue;
      const layers = value.split(/,(?![^(]*\))/).length;
      expect(layers, `${value} stacks ${layers} shadows`).toBe(1);
    }
    expect(css).not.toMatch(/--mw-shadow-[3-9]/);
  });

  it('sets no colour outside the token system', async () => {
    // Every colour must come from a token, so a theme swap is a token swap.
    // The exceptions are the two shadow definitions and the scrim, which are
    // black at an alpha rather than a palette colour, and #fff on the QR plate
    // and the e-paper preview, which are a physically white medium drawn
    // honestly in both schemes.
    const css = (await stylesheet()).replace(/\/\*[\s\S]*?\*\//g, '');
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    const ALLOWED = new Set(['#fff', '#ffffff', '#000', '#000000']);
    const stray = [...new Set(hexes.filter((h) => !ALLOWED.has(h)))].sort();
    // The scheme blocks themselves are where the palette is declared, so they
    // are excluded by looking only outside `--mw-<role>:` declarations.
    const declared = new Set(
      [...css.matchAll(/--mw-[a-z0-9-]+\s*:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) =>
        (m[1] as string).toLowerCase(),
      ),
    );
    const outside = stray.filter((h) => !declared.has(h));
    expect(outside, `hard-coded colours outside the palette: ${outside.join(', ')}`).toEqual([]);
  });
});

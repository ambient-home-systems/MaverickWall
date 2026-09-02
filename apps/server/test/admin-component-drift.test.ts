import { describe, expect, it } from 'vitest';
import { adminStylesheet, declarationsOf, rulesOf, splitTopLevel, stripComments } from './admin-stylesheet.js';

/**
 * Phase 10B — the component conversion's own definition of done.
 *
 * `components.ts` measured the drift precisely: 379 of 384 spacing
 * declarations bypassed `--mw-s-1..7`, a third of `border-radius` and half of
 * `font-size` were raw pixels against token sets that already existed. Eight
 * components and two converted screens (calendars, system) later, the number
 * was still 297/407, 25/100 and 45/94 — the component layer gives a screen
 * something to reach for, it does not retroactively reach for anything on a
 * screen nobody has touched yet.
 *
 * This file is the hard version of `admin-design-drift.test.ts`. That file is
 * an allow-listed burn-down of two *numeric* properties — is a font-size one
 * of the scale's declared values, is a spacing value a multiple of 4px — and
 * both of those are satisfied by a raw literal that merely happens to land on
 * a rung. This file asks the sharper question the task was actually about:
 * does the declaration *use the token*. `margin:16px` is on the 4px grid and
 * is exactly the drift this exists to end; `margin:var(--mw-s-4)` is the same
 * pixel, spent as a token that can be retuned in one place.
 *
 * There is no allow-list here on purpose. The task was to drive all three
 * numbers to zero, not to freeze today's offenders the way Phase 6 froze its
 * own — so this is a flat assertion, and the day it goes red is the day a new
 * screen shipped a raw literal where a token already existed for it.
 *
 * A `0` needs no token — there is nothing to standardise about the absence of
 * space or the absence of rounding — so a bare zero atom is never a violation.
 * A length in `vh`/`vw` (the widget sheet's `70vh`) is not on this scale at
 * all and is exempted the same way `onGrid` exempts non-px/rem units.
 */

const SPACING_PROPERTY =
  /^(margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(grid-)?(row-|column-)?gap$/;

function siteOf(selectors: readonly string[], property: string, value: string): string {
  return `${selectors.join(',')} { ${property}: ${value} }`;
}

function isZero(atom: string): boolean {
  return /^-?0(\.0+)?(px|rem|em|%)?$/.test(atom);
}

/** An atom is fine if it is zero, a viewport-relative length, or already a token. */
function spacingAtomIsRaw(atom: string): boolean {
  if (isZero(atom)) return false;
  if (/vh|vw/.test(atom)) return false;
  if (/var\(--mw-s-|var\(--mw-touch\)|var\(--mw-hairline\)/.test(atom)) return false;
  return /[\d.]/.test(atom);
}

function radiusAtomIsRaw(atom: string): boolean {
  if (isZero(atom)) return false;
  if (atom === 'inherit') return false;
  if (/var\(--mw-r-|var\(--mw-hairline\)/.test(atom)) return false;
  if (!/[\d.]/.test(atom)) return /%$/.test(atom); // a bare "50%" with no digit before the sign
  return true;
}

describe('the admin component conversion (spacing, radius, font-size)', () => {
  it('spends a spacing token for every non-zero margin, padding and gap', async () => {
    const css = stripComments(await adminStylesheet());
    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rulesOf(css)) {
      for (const [property, value] of declarationsOf(rule)) {
        if (!SPACING_PROPERTY.test(property)) continue;
        counted += 1;
        if (splitTopLevel(value, ' ').some(spacingAtomIsRaw)) {
          offenders.push(siteOf(rule.selectors, property, value));
        }
      }
    }
    expect(counted, 'no spacing declarations found at all').toBeGreaterThan(200);
    expect(offenders, `${offenders.length} spacing declarations off the token scale`).toEqual([]);
  });

  it('spends a radius token for every non-zero border-radius', async () => {
    const css = stripComments(await adminStylesheet());
    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rulesOf(css)) {
      for (const [property, value] of declarationsOf(rule)) {
        if (property !== 'border-radius') continue;
        counted += 1;
        if (splitTopLevel(value, ' ').some(radiusAtomIsRaw)) {
          offenders.push(siteOf(rule.selectors, property, value));
        }
      }
    }
    expect(counted, 'no border-radius declarations found at all').toBeGreaterThan(50);
    expect(offenders, `${offenders.length} border-radius declarations off the token scale`).toEqual([]);
  });

  it('names a type-scale role for every font-size, never a raw pixel', async () => {
    const css = stripComments(await adminStylesheet());
    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rulesOf(css)) {
      for (const [property, value] of declarationsOf(rule)) {
        if (property !== 'font-size') continue;
        counted += 1;
        if (/^-?[\d.]+(px|rem)$/.test(value)) offenders.push(siteOf(rule.selectors, property, value));
      }
    }
    expect(counted, 'no font-size declarations found at all').toBeGreaterThan(50);
    expect(offenders, `${offenders.length} font-size declarations off the type scale`).toEqual([]);
  });
});

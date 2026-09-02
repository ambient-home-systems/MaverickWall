import { describe, expect, it } from 'vitest';
import { TYPE_ROLES } from '../src/http/design-tokens.js';
import {
  adminStylesheet,
  declarationsOf,
  rulesOf,
  splitTopLevel,
  stripComments,
} from './admin-stylesheet.js';

/**
 * RFC 009 Phase 6 — the design system becomes a constraint.
 *
 * The correlation the audit found is exact and is the whole reason this file
 * exists: **every dimension of this design system that has a test is
 * respected, and every dimension without one has drifted.** Colour, button
 * states, shadows and the mobile drawer are each pinned by a test and each
 * still holds. Type and spacing were pinned by nothing, and by the time
 * anybody looked there were twelve font sizes on one page and five uses of the
 * spacing scale across 372 declarations.
 *
 * So these are not a sweep. Each assertion lands with an **explicit allow-list
 * of what fails today**, which does three things at once:
 *
 *  - the suite is green on merge, so nothing is blocked on a large diff for an
 *    invisible gain — the RFC rules that out by name;
 *  - every *new* violation fails immediately, which is the whole point;
 *  - the list is the burn-down. A fixed offender leaves a stale entry, and a
 *    stale entry fails too, so the list can only shrink.
 *
 * The failure messages print the allow-list's size, because a list that grows
 * quietly is a constraint that has been repealed quietly.
 *
 * Every check derives its subject from the served stylesheet rather than from
 * a list kept by hand — `admin-button-states.test.ts` is the model, and the
 * reason is that a hand-written list only ever covers what somebody remembered
 * to add to it.
 */

/**
 * A stable name for one offending declaration: `selectors { property: value }`.
 *
 * Keyed on the selector *and* the value on purpose. Editing either changes the
 * key, so touching a rule brings its entry back into view — which is exactly
 * the "convert opportunistically" the RFC asks for, rather than a list that
 * quietly outlives the code it describes.
 */
function siteOf(selectors: readonly string[], property: string, value: string): string {
  return `${selectors.join(',')} { ${property}: ${value} }`;
}

/** Report offenders against an allow-list, in both directions. */
function holdTo(found: readonly string[], allowed: readonly string[], what: string): void {
  // Two rules can produce the same site string — the same selector and value in
  // a base rule and again inside a media query. One entry is one thing to fix.
  const offenders = [...new Set(found)];
  const permitted = new Set(allowed);
  const fresh = offenders.filter((site) => !permitted.has(site)).sort();
  expect(
    fresh,
    `${fresh.length} new ${what} (allow-list holds ${allowed.length}):\n` +
      fresh.map((site) => `  ${site}`).join('\n'),
  ).toEqual([]);

  const seen = new Set(offenders);
  const stale = allowed.filter((site) => !seen.has(site)).sort();
  expect(
    stale,
    `${stale.length} allow-listed ${what} no longer exist — delete these lines, ` +
      `the list is down to ${allowed.length - stale.length}:\n` +
      stale.map((site) => `  ${site}`).join('\n'),
  ).toEqual([]);
}

/* ---- 1. The type scale ---------------------------------------------------- */

/**
 * The literal sizes the scale declares, read out of the scale.
 *
 * A call site written as `font-size:14px` is on the scale even though it does
 * not name a role, and rewriting several hundred of those is not what this
 * assertion is for. What it forbids is a *thirteenth* size: `13px`, `19px`,
 * `.9rem` and `11.5px` are not on the ladder and were nobody's decision.
 *
 * Derived rather than transcribed. A hand-copied ladder is a second statement
 * of the type scale, and two statements of one thing is the drift this file
 * exists to catch — retuning a role in `design-tokens.ts` would leave the copy
 * here quietly certifying the old size and rejecting the new one.
 */
function scaleSizes(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/--mw-t-[a-z0-9-]+-size\s*:\s*([^;]+)/g)].map((m) => (m[1] as string).trim()),
  );
}

/**
 * Sizes that fail today: `13px` seven times, `19px`, `11.5px`, `15px`, `22px`,
 * and four rem values on a sheet that sizes in px everywhere else.
 *
 * Kept as a flat list of *sites* rather than of *values*, because freezing the
 * vocabulary would let a fresh `font-size:13px` land anywhere and still pass —
 * and a thirteenth size arriving on a new screen is the drift this exists to
 * stop. Every one of these is a declaration somebody has to look at.
 */
const OFF_SCALE_TYPE: readonly string[] = [];

/**
 * Font shorthands written out longhand rather than as a role.
 *
 * The last two are the interesting ones and the loose first version of this
 * check waved them through: they *name* scale roles for weight and
 * line-height, and then set the size to a hand-picked `10px` in between. A
 * shorthand that mentions a role is not a shorthand that uses one.
 */
const HAND_WRITTEN_FONT: readonly string[] = [];

/* ---- 2. The 4px spacing grid ---------------------------------------------- */

/**
 * Every property that spends space.
 *
 * The logical forms and `grid-gap` are here even though the sheet uses none of
 * them today, which is exactly why: a check that only knows the properties
 * already written is a check a new screen walks straight past. `padding-inline`
 * is the same decision as `padding-left` and has to answer to the same grid.
 */
const SPACING_PROPERTY =
  /^(margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(grid-)?(row-|column-)?gap$/;

/**
 * Empty: the 159 sites this held have all been converted to the 4px grid.
 *
 * It stays a list of *sites* rather than of a *vocabulary*, because "freeze
 * the vocabulary" was the RFC's instruction about what may be written next,
 * and a value allow-list would enforce it exactly backwards: a new
 * `gap:6px` on a new screen would sail through because 6px is already spent
 * somewhere else. A fresh off-grid site still lands here, one entry at a
 * time, rather than reopening a vocabulary this file no longer keeps.
 */
const OFF_GRID_SPACING: readonly string[] = [];

/* ---- 3. Tokens nothing reads ---------------------------------------------- */

/**
 * Tokens nothing reads today. Two kinds, and the difference matters when one
 * is being burned down:
 *
 *  - **The one-offs.** `--mw-focus`, `--mw-hairline`, `--mw-shadow-0`,
 *    `--mw-danger-ink`, `--mw-night-soft`, `--mw-dur-3` and
 *    the `--night` alias are declared, described in a comment, and never
 *    used. Each is a delete or a use, and it is 6b's call which. (`--mw-touch`
 *    was the RFC's own example of one — it now backs the Phase 7 touch-target
 *    rules below 900px.)
 *  - **The unfilled rungs of a ladder.** `--mw-s-2` and the `--mw-t-*` parts
 *    are emitted as complete scales by construction — `adminTypeVars()` writes
 *    four parts and a shorthand for every role whether or not a call site
 *    wants them — so an unread rung is a vocabulary with room in it rather
 *    than a stray declaration. They are still listed rather than exempted by a
 *    naming rule, because "it looks like part of a scale" is exactly the
 *    reasoning that would let a genuinely dead token in beside them, and
 *    because a scale nobody uses at all is worth seeing.
 */
const UNREFERENCED_TOKENS: readonly string[] = [
  '--mw-danger-ink',
  '--mw-dur-3',
  '--mw-focus',
  '--mw-hairline',
  '--mw-night-soft',
  '--mw-s-2',
  '--mw-s-3',
  '--mw-s-5',
  '--mw-s-6',
  '--mw-s-7',
  '--mw-shadow-0',
  '--mw-t-body-lg',
  '--mw-t-body-lg-lh',
  '--mw-t-body-lg-tracking',
  '--mw-t-body-lg-weight',
  '--mw-t-body-sm',
  '--mw-t-body-sm-tracking',
  '--mw-t-body-sm-weight',
  '--mw-t-body-weight',
  '--mw-t-display',
  '--mw-t-display-lh',
  '--mw-t-display-size',
  '--mw-t-display-tracking',
  '--mw-t-display-weight',
  '--mw-t-h1-lh',
  '--mw-t-h1-size',
  '--mw-t-h1-weight',
  '--mw-t-h2-lh',
  '--mw-t-h2-weight',
  '--mw-t-h3-lh',
  '--mw-t-h3-size',
  '--mw-t-h3-weight',
  '--mw-t-h4-lh',
  '--mw-t-h4-size',
  '--mw-t-h4-weight',
  '--mw-t-label-lh',
  '--mw-t-label-sm-lh',
  '--mw-t-label-sm-weight',
  '--mw-t-label-xs-lh',
  '--mw-t-label-xs-weight',
  '--night',
];

describe('the admin type scale', () => {
  it('sets every font-size from the scale', async () => {
    const css = stripComments(await adminStylesheet());
    const onTheScale = scaleSizes(css);
    expect(onTheScale.size, 'the type scale declares no sizes').toBeGreaterThanOrEqual(10);

    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rulesOf(css)) {
      for (const [property, value] of declarationsOf(rule)) {
        if (property !== 'font-size') continue;
        counted += 1;
        // The whole value, not a substring. `clamp(11px,2vw,var(--mw-t-h1-size))`
        // mentions a role and is still an off-scale 11px on a narrow phone.
        if (/^var\(\s*--mw-t-[a-z0-9-]+\s*\)$/.test(value)) continue;
        if (onTheScale.has(value)) continue;
        offenders.push(siteOf(rule.selectors, property, value));
      }
    }
    // A guard on the guard: if the parser stops finding declarations the check
    // has become a no-op that passes over the drift it exists for.
    expect(counted, 'no font-size declarations found at all').toBeGreaterThan(50);
    holdTo(offenders, OFF_SCALE_TYPE, 'font-size declarations off the scale');
  });

  it('writes the font shorthand as a role, never by hand', async () => {
    // The shorthand carries size, line-height and weight together, so a
    // hand-written one opts out of three quarters of the scale at once — and
    // it does it invisibly, because the size it happens to name is usually one
    // the scale also has.
    const offenders: string[] = [];
    for (const rule of rulesOf(await adminStylesheet())) {
      for (const [property, value] of declarationsOf(rule)) {
        if (property !== 'font') continue;
        if (value === 'inherit') continue;
        if (/^var\(\s*--mw-t-[a-z0-9-]+\s*\)$/.test(value)) continue;
        offenders.push(siteOf(rule.selectors, property, value));
      }
    }
    holdTo(offenders, HAND_WRITTEN_FONT, 'hand-written font shorthands');
  });

  it('names a role for every size the scale declares', async () => {
    // The scale is the vocabulary; a role missing from the emitted properties
    // would make every call site naming it resolve to nothing.
    const css = stripComments(await adminStylesheet());
    for (const role of TYPE_ROLES) {
      expect(css, `--mw-t-${role} is not declared`).toContain(`--mw-t-${role}-size:`);
    }
  });
});

describe('the admin spacing grid', () => {
  it('places every margin, padding and gap on the 4px scale', async () => {
    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rulesOf(await adminStylesheet())) {
      for (const [property, value] of declarationsOf(rule)) {
        if (!SPACING_PROPERTY.test(property)) continue;
        counted += 1;
        if (onGrid(value)) continue;
        offenders.push(siteOf(rule.selectors, property, value));
      }
    }
    expect(counted, 'no spacing declarations found at all').toBeGreaterThan(200);
    holdTo(offenders, OFF_GRID_SPACING, 'spacing declarations off the 4px grid');
  });

  it('declares the scale as a complete ladder of fours', async () => {
    const css = stripComments(await adminStylesheet());
    const rungs = [...css.matchAll(/--mw-s-(\d+)\s*:\s*([^;]+)/g)].map(
      (m) => [Number(m[1]), (m[2] as string).trim()] as const,
    );
    expect(rungs.length, 'the spacing scale has gone missing').toBeGreaterThan(5);
    for (const [index, value] of rungs) {
      const px = /^(\d+)px$/.exec(value);
      expect(px, `--mw-s-${index} is ${value}, which is not a pixel step`).not.toBeNull();
      expect(
        Number((px as RegExpExecArray)[1]) % 4,
        `--mw-s-${index} is ${value}, which is off its own grid`,
      ).toBe(0);
    }
  });
});

/**
 * Is every length in this value a multiple of 4px?
 *
 * `rem` counts, resolved at the browser default of 16px, because that is what
 * the admin runs at and `.5rem` is 8px however it is spelled. Lengths inside
 * `calc()` and `env()` are checked too rather than waved through: the whole
 * point of a grid is that the arithmetic lands on it.
 *
 * Anything that is not a px or rem length — `auto`, a percentage, `70vh`, a
 * token — is not on the grid's axis and is not this assertion's business.
 */
function onGrid(value: string): boolean {
  for (const part of splitTopLevel(value, ' ')) {
    for (const match of part.matchAll(/(-?[\d.]+)(px|rem)/g)) {
      const px = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
      if (px % 4 !== 0) return false;
    }
  }
  return true;
}

describe('the admin token vocabulary', () => {
  it('reads every token it declares', async () => {
    // The mirror of `admin-design-system.test.ts`'s dangling-var check, and the
    // half that had never been asserted. A token nothing reads is a claim the
    // stylesheet is making about itself and not honouring.
    const css = stripComments(await adminStylesheet());
    const declared = [
      ...new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1] as string)),
    ];
    const used = new Set([...css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1] as string));
    expect(declared.length, 'no tokens declared at all').toBeGreaterThan(60);
    holdTo(
      declared.filter((token) => !used.has(token)).sort(),
      UNREFERENCED_TOKENS,
      'tokens nothing reads',
    );
  });
});

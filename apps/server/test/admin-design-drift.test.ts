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
function holdTo(offenders: readonly string[], allowed: readonly string[], what: string): void {
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
const OFF_SCALE_TYPE: readonly string[] = [
  '.code { font-size: 1rem }',
  '.error span { font-size: 13px }',
  '.hep-id { font-size: 11.5px }',
  '.insp-empty { font-size: 13px }',
  '.le-layers-empty { font-size: 13px }',
  '.le-media-upload { font-size: 13px }',
  '.le-modal-close { font-size: 22px }',
  '.le-pop-row { font-size: 13px }',
  '.preview .warn { font-size: .9rem }',
  '.side .brand b { font-size: 19px }',
  '.side-foot .who b { font-size: 13px }',
  '.slots label { font-size: .7rem }',
  '.slots select { font-size: .9rem }',
  '.srow-text b { font-size: 15px }',
  '.themecard .cap small { font-size: 11.5px }',
  '.wizbox .brand b { font-size: 19px }',
  '.wset-lead { font-size: 13px }',
  'input[type=file] { font-size: .95rem }',
];

/** Font shorthands written out longhand rather than as a role. */
const HAND_WRITTEN_FONT: readonly string[] = [
  '.switch { font: 400 14px/20px var(--sans) }',
  'pre.code { font: 12px/1.5 var(--mono) }',
  'pre.log { font: 12px/1.55 var(--mono) }',
];

/* ---- 2. The 4px spacing grid ---------------------------------------------- */

const SPACING_PROPERTY =
  /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/;

/**
 * 159 of 372 spacing declarations are off the grid today, in 33 distinct
 * values — `10px`, `6px`, `14px`, `2px`, `.6rem`, `.42rem`, `-3px` and the
 * rest. That is the RFC's finding stated exactly: five uses of the spacing
 * scale in the whole sheet.
 *
 * It is a long list and it is deliberately not shortened by allow-listing the
 * *vocabulary* instead. "Freeze the vocabulary" is the RFC's instruction about
 * what may be written next, and a value allow-list would enforce it exactly
 * backwards: a new `gap:6px` on a new screen would sail through because 6px is
 * already spent somewhere else. Sites are what a burn-down is made of.
 */
const OFF_GRID_SPACING: readonly string[] = [
  '#ha-entity-picker { margin-top: .6rem }',
  '.arow { padding: 6px 16px }',
  '.card .host,.host { margin: .35rem 0 }',
  '.card p { margin: .4rem 0 }',
  '.card.is-paused h2 .tag { margin-left: 10px }',
  '.code { padding: .15rem .4rem }',
  '.content { padding: 22px 20px 48px }',
  '.cpreview { gap: 2px }',
  '.cpreview { padding: 9px 11px }',
  '.crumb-back { gap: 5px }',
  '.error strong { margin-bottom: 2px }',
  '.error { padding: .9rem 1.1rem }',
  '.field .field-input { padding: 0 11px }',
  '.field .field-input:focus,.field .field-input:focus-visible { padding: 0 10px }',
  '.field input[type=color].field-input { padding: 5px 6px }',
  '.field input[type=file].field-input { padding: 9px 11px }',
  '.field select.field-input { padding-right: 34px }',
  '.field textarea.field-input { padding: 10px 11px }',
  '.field textarea.field-input:focus { padding: 9px 10px }',
  '.formdefault { margin: -1px }',
  '.helppop p { margin: .35rem 0 }',
  '.helppop { padding: 12px 14px }',
  '.hep-chip.active::before { margin-top: -3px }',
  '.hep-chips { gap: 6px }',
  '.hep-field { gap: 6px }',
  '.hep-footer { gap: 14px }',
  '.hep-footer { margin-top: 14px }',
  '.hep-pill { gap: .4rem }',
  '.hep-pill { padding: 0 6px 0 12px }',
  '.hep-row { padding: .6rem .8rem }',
  '.hep-selected { gap: 6px }',
  '.hep-selected { margin-bottom: 10px }',
  '.insp-body { padding: 4px 18px 18px }',
  '.insp-danger { margin-top: 18px }',
  '.insp-danger { padding-top: 14px }',
  '.insp-empty { padding: 22px 18px }',
  '.insp-head { gap: 10px }',
  '.insp-head { padding: 12px 8px 12px 18px }',
  '.insp-ink-list { padding-left: 18px }',
  '.insp-ink-note { margin: 14px 0 4px }',
  '.insp-lane { padding: 0 14px }',
  '.insp-lanes { gap: 6px }',
  '.insp-lanes { margin: 8px 0 10px }',
  '.insp-tab { padding: 0 14px }',
  '.insp-tabs { margin: 0 0 6px }',
  '.le-add { gap: 6px }',
  '.le-aspect { padding: .42rem .6rem }',
  '.le-bar-main { gap: 10px }',
  '.le-bg input[type=color] { padding: 2px }',
  '.le-bg input[type=number] { padding: .42rem .5rem }',
  '.le-bg select { padding: .42rem .6rem }',
  '.le-bg { gap: 10px }',
  '.le-box-cell { gap: 3px }',
  '.le-canvas-pop { padding: 14px 16px 16px }',
  '.le-cfg-check { gap: .55rem }',
  '.le-cfg-checks { gap: 6px 16px }',
  '.le-cfg-checks { margin-top: 2px }',
  '.le-cfg-field textarea { padding: 8px 10px }',
  '.le-cfg-field>span { margin-bottom: 6px }',
  '.le-inspect-card .insp-empty { padding: 16px 18px }',
  '.le-ladder { gap: 2px }',
  '.le-ladder-row { padding: 6px 8px }',
  '.le-ladder-row.is-cut { padding: 5px 7px }',
  '.le-layer { gap: 10px }',
  '.le-layer-grip { padding: 0 2px }',
  '.le-layers { padding: 6px }',
  '.le-layers-empty { padding: 14px 16px }',
  '.le-layers-sub { margin-top: 2px }',
  '.le-media { gap: 10px }',
  '.le-modal-grid { gap: 10px }',
  '.le-not-drawn { padding: 10px 12px }',
  '.le-palette { gap: 6px }',
  '.le-pop-sep { margin: 10px 0 }',
  '.le-pop-title { margin-bottom: 2px }',
  '.le-tool-link,.le-tool-btn,.le-layers-btn { gap: 6px }',
  '.le-toolbar { gap: 10px }',
  '.le-widget-flag { padding: 2px 6px }',
  '.le-widget-label { padding: 2px 6px }',
  '.modebar { gap: 10px 12px }',
  '.modebar { margin: 0 0 18px }',
  '.nav { padding: 6px 12px 12px }',
  '.nav-badge { padding: 2px 8px }',
  '.nav-group>span { padding: 0 10px 6px }',
  '.prev-head { margin: 0 0 10px }',
  '.preview .warn { margin-top: .6rem }',
  '.preview h3 { margin: 0 0 .3rem }',
  '.preview li { gap: .9rem }',
  '.preview ul { margin: .6rem 0 0 }',
  '.preview { padding: 16px 18px }',
  '.pv-grid { gap: 5px }',
  '.pv-grid { margin-top: .7rem }',
  '.pv-num { margin: 2px 0 }',
  '.qr { margin: .6rem 0 }',
  '.qr { padding: .8rem }',
  '.row-fields .field { margin-top: 1.1rem }',
  '.rows .field { margin: 14px 16px }',
  '.rows .field-hint { margin: -6px 16px 12px }',
  '.rows>.rowsub>.field { margin: 6px 0 0 }',
  '.savebar { gap: 14px }',
  '.saved { padding: .7rem .75rem .7rem 1.1rem }',
  '.sect { margin-top: 30px }',
  '.sect-head { margin-bottom: 14px }',
  '.seg button.on::before,.le-orient-btn.is-on::before,.themebtn[data-active="true"]::before { margin-top: -3px }',
  '.side .brand small { margin-top: 3px }',
  '.side .brand { gap: 11px }',
  '.side-foot { padding: 14px 16px }',
  '.side-foot-id { gap: 10px }',
  '.slots label { margin: .4rem 0 .2rem }',
  '.slots select { padding: .4rem .3rem }',
  '.srow { padding: 6px 16px }',
  '.srow-value { gap: 2px }',
  '.srow.is-wide { padding-bottom: 10px }',
  '.srow.is-wide { padding-top: 10px }',
  '.stat .big { margin: 12px 0 2px }',
  '.stat .top { gap: 10px }',
  '.steps { margin: 22px 0 26px }',
  '.switch { margin: .35rem 0 }',
  '.tag { gap: 6px }',
  '.tag { padding: 4px 10px }',
  '.tb-controls>.tb-group { margin: 1.6rem 0 .2rem }',
  '.tf-row input[type=color] { padding: 2px }',
  '.tf-row { margin: 9px 0 }',
  '.themebtn { padding: 0 10px }',
  '.themecard .cap { padding: 10px 14px }',
  '.themegrid { gap: 14px }',
  '.themegrid { margin-top: .6rem }',
  '.today-big { margin: 6px 0 2px }',
  '.topbar .crumb { margin: 0 0 2px }',
  '.tpl-card .btn-sm { margin-top: 2px }',
  '.tpl-card { gap: 14px }',
  '.tpl-cat { margin: 26px 0 14px }',
  '.tpl-copy .row { gap: 10px }',
  '.tpl-copy { margin-top: 34px }',
  '.tpl-copy { padding-top: 22px }',
  '.tpl-grid { gap: 22px }',
  '.two-up { gap: 14px }',
  '.wall-status { gap: 7px }',
  '.walls a.active::before { margin-top: -3px }',
  '.walls { margin: .4rem 0 1rem }',
  '.wizbox .brand { gap: 11px }',
  '.wizbox>form,.wizbox>.error { margin-top: 18px }',
  '.wset { gap: 26px }',
  '.wset-back { gap: 6px }',
  '.wset-back { padding: 0 12px 0 6px }',
  '.wset-group { margin: 22px 0 0 }',
  '.wset-group:first-of-type { margin-top: 14px }',
  '.wset-lead { margin: 0 0 14px }',
  '.wset-nav { gap: 2px }',
  'button,.btn { margin-top: 1.4rem }',
  'form { margin: 1.4rem 0 0 }',
  'img.avatar { margin-right: .4rem }',
  'input[type=color] { padding: .2rem }',
  'input[type=file] { padding: .55rem }',
  'input[type=text],input[type=email],input[type=password],input[type=number],input[type=time],select,textarea { padding: .62rem .7rem }',
  'label { margin: 1rem 0 .35rem }',
  'p.hint,.hint { margin: .35rem 0 0 }',
  'pre.log { padding: .8rem 1rem }',
  'ul.plain li { margin: .45rem 0 }',
  'ul.plain { margin: .6rem 0 .6rem 1.1rem }',
];

/* ---- 3. Tokens nothing reads ---------------------------------------------- */

/**
 * Tokens nothing reads today. Two kinds, and the difference matters when one
 * is being burned down:
 *
 *  - **The one-offs.** `--mw-touch: 44px` is the RFC's own example: it has
 *    zero references while the drawer, the nav row and the settings row all
 *    hard-code 48px, so the token is *stricter* than the code and disagrees
 *    with it in silence. `--mw-focus`, `--mw-hairline`, `--mw-shadow-0`,
 *    `--mw-danger-ink`, `--mw-warn-soft`, `--mw-night-soft`, `--mw-dur-3` and
 *    the `--night` alias are the same shape: declared, described in a comment,
 *    and never used. Each is a delete or a use, and it is 6b's call which.
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
  '--mw-t-body',
  '--mw-t-body-lg',
  '--mw-t-body-lg-lh',
  '--mw-t-body-lg-tracking',
  '--mw-t-body-lg-weight',
  '--mw-t-body-sm-lh',
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
  '--mw-t-h2-size',
  '--mw-t-h2-weight',
  '--mw-t-h3-lh',
  '--mw-t-h3-size',
  '--mw-t-h3-weight',
  '--mw-t-h4-lh',
  '--mw-t-h4-size',
  '--mw-t-h4-weight',
  '--mw-t-label-lh',
  '--mw-t-label-sm-lh',
  '--mw-t-label-sm-size',
  '--mw-t-label-sm-weight',
  '--mw-t-label-xs-size',
  '--mw-touch',
  '--mw-warn-soft',
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
        if (/var\(\s*--mw-t-/.test(value)) continue;
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
        if (/var\(\s*--mw-t-[a-z0-9-]+\s*\)/.test(value)) continue;
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
    // stylesheet is making about itself and not honouring — `--mw-touch:44px`
    // has zero references while the code hard-codes 48px, so the token is
    // *stricter* than the design it describes and nobody reading it would know.
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

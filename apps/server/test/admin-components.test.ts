import { describe, expect, it } from 'vitest';
import {
  COMPONENT_STYLE,
  card,
  dataTable,
  destructive,
  emptyState,
  listRow,
  pageHeader,
  section,
  tag,
} from '../src/http/components.js';
import { adminStylesheet, declarationsOf, rulesOf, splitTopLevel, stripComments } from './admin-stylesheet.js';

/**
 * The component layer, held to the constraint it exists to make checkable.
 *
 * `admin-design-drift.test.ts` is the burn-down and this is the fence in front
 * of it. The difference matters: drift holds the *whole* stylesheet to the 4px
 * grid with an allow-list of what fails today, because forty-nine screens of
 * literal HTML cannot be rewritten in one diff. The components are new, they
 * are what every screen is meant to reach for next, and there is no reason for
 * a single raw length in them — so here the bar is absolute and there is no
 * allow-list to add to.
 *
 * The correlation that file records is the reason to write this one at all:
 * **every dimension of this design system that has a test is respected, and
 * every dimension without one has drifted.** A component layer with no test is
 * a component layer that will have three hand-picked paddings in it by the
 * third screen that uses it.
 */

/* ---- The tokens the sheet actually declares ------------------------------- */

/**
 * Every `--mw-*` custom property, read out of the served stylesheet.
 *
 * Derived rather than transcribed, for the reason the type-scale check is:
 * a hand-copied list is a second statement of the vocabulary, and two
 * statements of one thing is the drift being tested for.
 */
async function declaredTokens(): Promise<Set<string>> {
  const css = stripComments(await adminStylesheet());
  return new Set([...css.matchAll(/(--mw-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1] as string));
}

/** The component layer's own rules, comments out. */
function componentRules(): ReturnType<typeof rulesOf> {
  // `rulesOf` matches innermost braces first, so a media query's preamble is
  // never returned as a rule and its children come back as ordinary ones —
  // which is what lets `@media(max-width:560px)` carry a raw pixel while every
  // declaration inside it is still checked.
  return rulesOf(COMPONENT_STYLE);
}

/**
 * Values a component may state without a token behind them.
 *
 * None of these is a length or a colour. They are keywords, ratios and the
 * intrinsic units — `100%` of a container, `1fr` of a grid, `64ch` of the
 * reader's own type, `0` which is the same on every grid there has ever been.
 */
const NOT_A_LENGTH = /^(0|auto|none|inherit|initial|unset|currentcolor|transparent)$/i;

/** Does this value state a raw px or rem length anywhere inside it? */
function hasRawLength(value: string): boolean {
  return /(^|[^a-zA-Z0-9-])-?[\d.]+(px|rem|em)\b/.test(value);
}

describe('the admin component layer', () => {
  it('is served — the rules reach a real page', async () => {
    // The whole file could be correct and unreferenced. `COMPONENT_STYLE` is a
    // string until `html.ts` interpolates it, and a check that reads only the
    // string would pass just as happily over a component layer nobody ships.
    const css = await adminStylesheet();
    for (const selector of ['.mw-sect', '.mw-row', '.mw-table', '.mw-empty', '.card', '.tag']) {
      expect(css, `${selector} is not in the served stylesheet`).toContain(selector);
    }
  });

  it('spends tokens and no raw lengths, in every declaration it makes', async () => {
    const rules = componentRules();
    // A guard on the guard: a parser that stops finding rules turns this into
    // an assertion about nothing that passes.
    expect(rules.length, 'no component rules found at all').toBeGreaterThan(20);

    const offenders: string[] = [];
    let counted = 0;
    for (const rule of rules) {
      for (const [property, value] of declarationsOf(rule)) {
        counted += 1;
        if (NOT_A_LENGTH.test(value)) continue;
        if (!hasRawLength(value)) continue;
        offenders.push(`${rule.selectors.join(',')} { ${property}: ${value} }`);
      }
    }
    expect(counted, 'no declarations found at all').toBeGreaterThan(60);
    expect(
      offenders,
      'a component may not state a length of its own — spend --mw-s-*, --mw-r-*, ' +
        `--mw-hairline or --mw-touch:\n${offenders.map((o) => `  ${o}`).join('\n')}`,
    ).toEqual([]);
  });

  it('names only tokens the stylesheet declares', async () => {
    // The dangling-`var()` class of bug, scoped to the layer that will grow.
    // Its symptom is silence: a card whose background resolves to nothing just
    // quietly stops being a card, and CSS says not a word about it.
    const declared = await declaredTokens();
    const used = new Set(
      [...COMPONENT_STYLE.matchAll(/var\(\s*(--mw-[a-zA-Z0-9-]+)/g)].map((m) => m[1] as string),
    );
    expect(used.size, 'the components read no tokens at all').toBeGreaterThan(15);
    const dangling = [...used].filter((token) => !declared.has(token)).sort();
    expect(dangling, `these resolve to nothing: ${dangling.join(', ')}`).toEqual([]);
  });

  it('sets no colour of its own', async () => {
    // Every colour comes from a role, so a scheme swap is a token swap. The
    // sheet-wide version of this allows #fff and #000 for the QR plate and the
    // e-paper preview, which are a physically white medium drawn honestly; a
    // component has no such case.
    expect(COMPONENT_STYLE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(COMPONENT_STYLE).not.toMatch(/\brgba?\(/);
    expect(COMPONENT_STYLE).not.toMatch(/\bhsla?\(/);
  });

  it('casts no shadow and rounds nothing into a pill', () => {
    // The two shadows in this system belong to the modal drawer and the widget
    // sheet, which cover the page. A card is a hairline and a surface step, and
    // an elevation ladder is how a settings screen starts reading as a
    // dashboard. `--mw-r-full` is for things that are actually circles.
    expect(COMPONENT_STYLE).not.toMatch(/box-shadow/);
    expect(COMPONENT_STYLE).not.toMatch(/--mw-shadow/);
    expect(COMPONENT_STYLE).not.toMatch(/--mw-r-full/);
  });

  it('reads the whole spacing scale, which nothing did before it', async () => {
    // Five of the seven rungs were declared, commented and read by nothing —
    // and that was the audit's finding stated as a fact about the stylesheet
    // rather than as a count of offending declarations. If a later edit puts
    // one back out of use, that is worth seeing here rather than as a stale
    // entry in the drift file six months later.
    const used = new Set(
      [...COMPONENT_STYLE.matchAll(/var\(\s*(--mw-s-\d)/g)].map((m) => m[1] as string),
    );
    expect([...used].sort()).toEqual([
      '--mw-s-1',
      '--mw-s-2',
      '--mw-s-3',
      '--mw-s-4',
      '--mw-s-5',
      '--mw-s-6',
      '--mw-s-7',
    ]);
  });

  it('declares no font-size, only whole type roles', () => {
    // A shorthand carries size, line-height and weight together, so writing
    // one by hand opts out of three quarters of the scale at once — and it
    // does it invisibly, because the size it names is usually one the scale
    // also has. A component names the role and nothing else.
    for (const rule of componentRules()) {
      for (const [property, value] of declarationsOf(rule)) {
        if (property === 'font-size') {
          expect.fail(`${rule.selectors.join(',')} sets font-size:${value} rather than a role`);
        }
        if (property !== 'font') continue;
        expect(value, `${rule.selectors.join(',')} writes a font shorthand by hand`).toMatch(
          /^var\(\s*--mw-t-[a-z0-9-]+\s*\)$/,
        );
      }
    }
  });

  it('puts every spacing value on the 4px grid, through the tokens', async () => {
    // The rungs are 4, 8, 12, 16, 24, 32, 48 and this proves the components
    // land on them rather than on a `calc()` that happens to resolve between
    // two. `calc(var(--mw-touch) + var(--mw-s-1))` is 44 + 4 = 48, which is on
    // the grid; `calc(var(--mw-touch) - var(--mw-s-1))` would be 40 and also
    // on it, so what this catches is the arithmetic that is not.
    const css = stripComments(await adminStylesheet());
    const rungs = new Map<string, number>();
    for (const match of css.matchAll(/(--mw-s-\d|--mw-touch)\s*:\s*(\d+)px/g)) {
      rungs.set(match[1] as string, Number(match[2]));
    }
    expect(rungs.size, 'the spacing scale has gone missing').toBeGreaterThan(7);

    for (const rule of componentRules()) {
      for (const [property, value] of declarationsOf(rule)) {
        if (!/^(margin|padding|gap|row-gap|column-gap|min-height)/.test(property)) continue;
        for (const part of splitTopLevel(value.replace(/^calc\(|\)$/g, ''), ' ')) {
          let total = 0;
          let saw = false;
          for (const token of part.matchAll(/var\(\s*(--mw-[a-z0-9-]+)\s*\)/g)) {
            const px = rungs.get(token[1] as string);
            if (px === undefined) continue;
            total += px;
            saw = true;
          }
          if (!saw) continue;
          expect(
            total % 4,
            `${rule.selectors.join(',')} { ${property}: ${value} } is off the 4px grid`,
          ).toBe(0);
        }
      }
    }
  });
});

/* ---- What the components render ------------------------------------------- */

describe('pageHeader', () => {
  it('draws a plain crumb when the page is not inside anything', () => {
    const html = pageHeader({ heading: 'Calendars', crumb: 'Content' });
    expect(html).toContain('<div class="crumb">Content</div>');
    expect(html).toContain('<h1>Calendars</h1>');
    expect(html).not.toContain('crumb-back');
  });

  it('turns the crumb itself into the back link, and adds no second header', () => {
    /*
     * The rule, and the reason it is one function: a page nested one level down
     * gets its back affordance *in the app bar*, so it needs none of its own —
     * and in particular no second hamburger, which is what a "Walls" button in
     * the page would read as beside the drawer's. On a real supervisor there is
     * already one of Home Assistant's own stacked against it.
     */
    const html = pageHeader({
      heading: 'Kitchen',
      crumb: 'Walls',
      back: { label: 'Walls', href: 'admin/walls' },
    });
    expect(html).toContain('class="crumb crumb-back" href="admin/walls"');
    // Exactly one navigation-menu control, and it is the drawer's.
    expect([...html.matchAll(/for="mw-nav"/g)]).toHaveLength(1);
    expect([...html.matchAll(/<header/g)]).toHaveLength(1);
    expect([...html.matchAll(/<h1/g)]).toHaveLength(1);
  });

  it('escapes a heading somebody else chose', () => {
    // A wall's name is a household's own text and reaches this.
    const html = pageHeader({ heading: '<script>alert(1)</script>', crumb: 'Walls' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('section', () => {
  it('carries no icon beside its heading, and offers no way to add one', () => {
    // The absence is the fix. An icon standing next to the thing that already
    // names it is the sentence twice, one of them in a language the reader has
    // to learn — and a `section(title, icon, …)` would be four screens away
    // from having one.
    const html = section('Backup', 'Two files.', '<p>x</p>');
    expect(html).not.toContain('<svg');
    expect(html).toContain('<h2>Backup</h2>');
    expect(html).toContain('Two files.');
  });

  it('draws no help paragraph when there is nothing to say', () => {
    expect(section('Update check', undefined, '<p>x</p>')).not.toContain('mw-sect-help');
  });

  it('takes a fragment somebody can link to', () => {
    expect(section('Add a calendar', undefined, '', 'add')).toContain('id="add"');
  });
});

describe('card', () => {
  it('is a hairline and a ground, never a shadow', async () => {
    expect(card('<p>x</p>')).toBe('<article class="card"><p>x</p></article>');
    const css = COMPONENT_STYLE;
    const rule = rulesOf(css).find((r) => r.selectors.includes('.card'));
    expect(rule, '.card has no rule').toBeDefined();
    expect((rule as { body: string }).body).not.toContain('shadow');
    expect((rule as { body: string }).body).toContain('--mw-hairline');
  });

  it('takes a tone on the edge and leaves the ground alone', () => {
    /*
     * A tinted card is a 400px region drawn in a colour sized for a chip, and
     * whatever inside it says the same thing in words — an errorBlock, a tag —
     * is on that same `-soft` ground and vanishes into it. So the hue goes on
     * the border and nowhere else, which is what this checks: the tone rules
     * set `border-color` and never a background.
     */
    expect(card('<p>x</p>', { tone: 'danger' })).toContain('class="card is-danger"');
    for (const rule of rulesOf(COMPONENT_STYLE)) {
      if (!rule.selectors.some((s) => /^\.card\.is-/.test(s))) continue;
      expect(rule.body, `${rule.selectors.join(',')} tints its ground`).not.toMatch(/background/);
      expect(rule.body).toMatch(/border-color/);
    }
  });
});

describe('listRow', () => {
  it('makes the whole row the target when the row navigates', () => {
    const html = listRow('', { title: 'Kitchen', detail: '800×480', href: 'admin/walls/k' });
    expect(html).toContain('class="mw-row-link" href="admin/walls/k"');
    const stretch = rulesOf(COMPONENT_STYLE).find((r) =>
      r.selectors.includes('.mw-row-link::after'),
    );
    expect(stretch, 'nothing stretches the link over the row').toBeDefined();
    expect((stretch as { body: string }).body).toContain('inset:0');
    // And the row is the positioned ancestor that `inset:0` resolves against —
    // without which the overlay covers the nearest positioned thing above,
    // which on this page is the whole content column.
    const row = rulesOf(COMPONENT_STYLE).find((r) => r.selectors.includes('.mw-row'));
    expect((row as { body: string }).body).toContain('position:relative');
  });

  it('leaves the trail unstacked, because the stacking is somewhere else', async () => {
    /*
     * A `position:relative;z-index:1` here reads as the fix for "the overlay
     * eats the button", and it was written that way first. Measured, it changed
     * nothing any assertion could see: `button,.btn` in the shell is already
     * `position:relative` for its own stretched pointer target, so a control in
     * the trail is a positioned descendant later in the document than the
     * overlay and paints over it unaided. A line nothing can contradict is not
     * a fix — this codebase reverted a `grid-template-rows` for the same reason
     * — so the declaration is gone and the coupling is asserted instead.
     *
     * Here: that the coupling exists. In `browser-components.test.ts`: that a
     * tap on the row's own button actually reaches the button, which is what
     * goes red if `button,.btn` ever stops positioning itself.
     */
    const trail = rulesOf(COMPONENT_STYLE).find((r) => r.selectors.includes('.mw-row-trail'));
    expect((trail as { body: string }).body).not.toMatch(/z-index/);
    const button = rulesOf(await adminStylesheet()).find((r) =>
      r.selectors.includes('button') && r.selectors.includes('.btn'),
    );
    expect(button, 'the shell no longer has a button rule at all').toBeDefined();
    expect(
      (button as { body: string }).body,
      'button,.btn is no longer positioned — a stretched row link now eats every ' +
        'control in a trail, and .mw-row-trail has nothing of its own to stop it',
    ).toMatch(/position\s*:\s*relative/);
  });

  it('draws no link, and no lead or trail wrapper, when it was given none', () => {
    const html = listRow('', { title: 'Database' });
    expect(html).not.toContain('<a');
    expect(html).not.toContain('mw-row-lead');
    expect(html).not.toContain('mw-row-trail');
  });

  it('is at least the pointer minimum, said as the pointer minimum', () => {
    // Written as `calc(var(--mw-touch) + …)` rather than as `48px`, so the
    // relationship survives somebody retuning either. A literal is the same
    // pixel and a decision nobody can review.
    const row = rulesOf(COMPONENT_STYLE).find((r) => r.selectors.includes('.mw-row'));
    expect((row as { body: string }).body).toMatch(/min-height:calc\(var\(--mw-touch\)/);
  });
});

describe('dataTable', () => {
  it('scrolls inside its own wrapper, so the page body never goes sideways', () => {
    const html = dataTable([{ label: 'Reading' }], [['x']]);
    expect(html.startsWith('<div class="mw-table-wrap">')).toBe(true);
    const wrap = rulesOf(COMPONENT_STYLE).find((r) => r.selectors.includes('.mw-table-wrap'));
    expect((wrap as { body: string }).body).toContain('overflow-x:auto');
  });

  it('declares tabular figures rather than inheriting them', () => {
    // A table is where a reader compares two numbers by where they start, and
    // a figure that changes width moves the column under it. Declared, so a
    // table inside anything that reset the inherited value still gets it.
    const table = rulesOf(COMPONENT_STYLE).find((r) => r.selectors.includes('.mw-table'));
    expect((table as { body: string }).body).toContain('font-variant-numeric:tabular-nums');
  });

  it('right-aligns a numeric column in the head and in the body', () => {
    const html = dataTable(
      [{ label: 'Reading' }, { label: 'Value', numeric: true }],
      [['Schema', '38']],
    );
    expect(html).toContain('<th>Reading</th>');
    expect(html).toContain('<th class="is-num">Value</th>');
    expect(html).toContain('<td>Schema</td>');
    expect(html).toContain('<td class="is-num">38</td>');
  });

  it('escapes a column label and passes a cell through as markup', () => {
    // Cells are markup because a cell often holds a tag or a host; a label is
    // text and is escaped here, which is the seam a caller has to know about.
    const html = dataTable([{ label: '<b>x</b>' }], [[tag('Checks out', 'ok')]]);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<span class="tag tag-ok">Checks out</span>');
  });
});

describe('tag', () => {
  it('says the state in words, so the colour is never the only signal', () => {
    // WCAG 1.4.1, and the reason there is deliberately no glyph in front of
    // it: an icon here would be decoration standing beside the word that
    // already says it, which is the one placement this admin bans outright.
    expect(tag('Not syncing', 'warn')).toBe('<span class="tag tag-warn">Not syncing</span>');
    expect(tag('Checks out', 'ok')).toContain('Checks out');
    expect(tag('Anything')).toBe('<span class="tag">Anything</span>');
    expect(tag('Problem', 'danger')).not.toContain('<svg');
  });

  it('uses the -soft grounds and never paints a hue on itself', () => {
    // `.tag-ok` shipped once as `background: var(--mw-ok); color: var(--mw-ok)`
    // — an invisible word on a green chip — because two M3 roles collapsed onto
    // one. The sheet-wide check for that is in admin-design-system.test.ts;
    // this is the same claim about the four tones a component can produce.
    for (const rule of rulesOf(COMPONENT_STYLE)) {
      if (!rule.selectors.some((s) => /^\.tag-/.test(s))) continue;
      const bg = /background\s*:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      const fg = /(?:^|;)\s*color\s*:\s*var\((--mw-[a-z0-9-]+)\)/.exec(rule.body);
      expect(bg, `${rule.selectors.join(',')} has no ground`).not.toBeNull();
      expect(fg, `${rule.selectors.join(',')} has no text colour`).not.toBeNull();
      expect((bg as RegExpExecArray)[1]).toMatch(/-soft$/);
      expect((fg as RegExpExecArray)[1]).not.toBe((bg as RegExpExecArray)[1]);
    }
  });
});

describe('emptyState', () => {
  it('names the thing that is missing, with no icon and no cheer', () => {
    const html = emptyState('No calendars yet. Add the iCal address of one below.');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('!');
    expect(html).toContain('No calendars yet');
  });

  it('offers the one action, when there is one to offer', () => {
    const html = emptyState('No walls yet.', { label: 'Add a wall', href: 'admin/walls/new' });
    expect(html).toContain('<a class="btn" href="admin/walls/new">Add a wall</a>');
    expect(emptyState('Nothing logged yet.')).not.toContain('<a ');
  });
});

describe('destructive', () => {
  it('is a GET to a confirmation, never a one-click POST', () => {
    // The confirmation is not a nicety bolted on the front — it is where the
    // naming happens, and `confirmDestroyPage` is the other half of this.
    const html = destructive('Remove', {
      thing: 'Family',
      confirmAction: 'admin/calendars/abc/delete',
    });
    expect(html).toContain('method="get" action="admin/calendars/abc/delete"');
    expect(html).not.toContain('method="post"');
  });

  it('carries the ellipsis, and an accessible name that says which thing', () => {
    // Eight calendar rows is eight identical "Remove"s to a screen reader
    // otherwise; and the ellipsis is the wording "Reset layout…" and "Unpair
    // wall…" already use for the two other actions that ask before they act.
    const html = destructive('Remove', { thing: 'Family', confirmAction: 'x' });
    expect(html).toContain('>Remove…</button>');
    expect(html).toContain('aria-label="Remove Family"');
  });

  it('is an overflow row by default and a danger button when asked', () => {
    expect(destructive('Remove', { thing: 'a', confirmAction: 'x' })).toContain(
      'class="ovf-item is-danger"',
    );
    expect(
      destructive('Unpair', { thing: 'Kitchen', confirmAction: 'x', variant: 'button' }),
    ).toContain('class="btn-danger"');
  });
});

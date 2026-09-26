import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Where a browser wall may move, and how — a scope, where this file used to be
 * a ban (plan P4.3, decision D7).
 *
 * **What it replaced.** For as long as the rule existed it read "no transition
 * or animation on any surface a screen sees", and this file enforced it by
 * refusing the words outright: in `display.css`, in the served copy, in the
 * wall's HTML and offline shell, and in every module in `main.ts`'s import
 * graph. The reasons were the wall's and they have not gone anywhere: it has no
 * pointer, so a transition confirms nothing; it redraws every fifteen seconds,
 * so an animation restarts four times a minute and reads as a flicker in a
 * room; and it is often a cheap tablet bolted up high, where every frame of
 * motion is work. The owner decided weather and countdown styles may move
 * anyway, confetti included, and those three reasons became the conditions
 * rather than the ban. This file is what makes each condition a build failure
 * rather than a convention — a convention being what a future contributor
 * breaks, reasonably, from a browser habit, in a file nobody re-reads.
 *
 * ## The stylesheet — `display.css`, in source and in the copy `dist/` serves
 *
 *  - **Every `@keyframes` and every animation binding sits inside
 *    `@media (prefers-reduced-motion: no-preference)`.** A household who has
 *    asked their system for less motion gets none, with no setting of ours to
 *    find first.
 *  - **Every binding is under `.canvas[data-motion="on"]`** — the wall's own
 *    Motion switch, which `main.ts` stamps and every admin preview leaves off.
 *    A selector that reached an animated element any other way would move it
 *    on a wall whose household switched motion off.
 *  - **Keyframes touch `transform` and `opacity` and nothing else.** Both are
 *    composited; anything else is a layout or a paint on every frame.
 *  - **No duration and no delay in the stylesheet, and no shorthand that could
 *    carry either.** `motion.ts` computes the phase *from* the duration, so the
 *    duration is stated once, in TypeScript, beside that arithmetic. A second
 *    copy here is how a loop comes to resume a fifth of a cycle out.
 *  - **Only four longhands at all**: name, timing function, iteration count,
 *    fill mode. `alternate` would make a cycle two durations long and the
 *    phase arithmetic wrong; `paused` would hold an element still at whatever
 *    phase it was drawn; neither is needed, so neither is allowed until
 *    somebody argues for it here.
 *  - **Every name a binding uses is a keyframe set the scoped block declares.**
 *  - **No transition anywhere.** A transition is started by a change to a
 *    property on an element that persists, and on this wall no element
 *    persists past a tick, so one would either never run or run on every
 *    redraw — and nothing phase-locks it. Smooth scrolling, view transitions
 *    and `@starting-style` stay out on the same argument.
 *
 * ## The modules — every one in the wall's compiled import graph
 *
 * `motion.ts` is **the one module that says "animation"**, and it writes two
 * properties and no others: `animation-duration` and `animation-delay`, inline,
 * which move nothing without a name the scoped block binds. Every other module
 * in the graph still carries none of the words, so a renderer that reached for
 * `style.animation`, `element.animate()` or a transition goes red here and has
 * to go through the one door instead — the shape `ha-write-boundary.test.ts`
 * gives the only write this application makes to anybody's house.
 *
 * The admin keeps its own rule, which is unchanged: it is a page with a
 * pointer, on a device somebody is holding, and
 * `apps/server/test/motion-scope.test.ts` holds its three durations and three
 * easings inside `prefers-reduced-motion`. That file also holds the panel path
 * to reaching no stylesheet at all — an e-paper panel is always still.
 *
 * The editors that live in this package (`layout-editor.ts`,
 * `theme-editor.ts`, `display-editor.ts` and friends) are admin screens that
 * happen to be built here, and the reason they are out of scope is the import
 * graph rather than a list: a screen loads `main.js`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const DIST = join(HERE, '..', 'dist');

/** The one condition every motion rule sits inside, written the one way. */
const REDUCED_MOTION = '@media (prefers-reduced-motion: no-preference)';
/** The one compound every binding's selector starts from. */
const MOTION_SCOPE = /^\.canvas\[data-motion="on"\][\s>]/;
/** The animation longhands the stylesheet may state. Duration and delay are TypeScript's. */
const LONGHANDS = new Set([
  'animation-name',
  'animation-timing-function',
  'animation-iteration-count',
  'animation-fill-mode',
]);
/** What a keyframe may move. */
const KEYFRAME_PROPERTIES = new Set(['transform', 'opacity']);

/** Comments first: this file's own prose, and the stylesheet's, name every pattern here. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ---------------------------------------------------------------------------
// A stylesheet, as the rules the browser will read
// ---------------------------------------------------------------------------

interface Declaration {
  readonly property: string;
  readonly value: string;
}

/** A rule or an at-rule: its prelude, its own declarations, and what it nests. */
interface Block {
  readonly prelude: string;
  readonly declarations: Declaration[];
  readonly children: Block[];
}

/**
 * Parse a stylesheet into nested blocks.
 *
 * Small on purpose, and tolerant of exactly what CSS is: preludes and
 * declarations separated by braces and semicolons, with strings (an attribute
 * selector's `"on"`, a font's `url('…')`) read whole so a quoted `;` or `}`
 * cannot end anything. It is a parser rather than a regex over the text
 * because the rule is about *nesting* — a binding inside the reduced-motion
 * block and outside it look identical line by line.
 */
function parseStylesheet(css: string): Block {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let at = 0;
  const readBlock = (prelude: string): Block => {
    const block: Block = { prelude, declarations: [], children: [] };
    let buffer = '';
    while (at < source.length) {
      const char = source[at] as string;
      if (char === '"' || char === "'") {
        const end = source.indexOf(char, at + 1);
        const close = end === -1 ? source.length - 1 : end;
        buffer += source.slice(at, close + 1);
        at = close + 1;
        continue;
      }
      at += 1;
      if (char === '{') {
        block.children.push(readBlock(buffer.trim()));
        buffer = '';
      } else if (char === ';' || char === '}') {
        const text = buffer.trim();
        buffer = '';
        if (text !== '') {
          const colon = text.indexOf(':');
          if (colon > 0 && !text.startsWith('@')) {
            block.declarations.push({
              property: text.slice(0, colon).trim().toLowerCase(),
              value: text.slice(colon + 1).trim(),
            });
          }
        }
        if (char === '}') return block;
      } else {
        buffer += char;
      }
    }
    return block;
  };
  return readBlock('');
}

/** Every block with the chain of preludes it sits inside, outermost first. */
function* walk(block: Block, ancestors: readonly string[] = []): Generator<{ block: Block; ancestors: readonly string[] }> {
  for (const child of block.children) {
    yield { block: child, ancestors };
    yield* walk(child, [...ancestors, child.prelude]);
  }
}

/** The top-level selectors of a selector list — split on the commas outside brackets and parentheses. */
function selectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of prelude) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

const isKeyframes = (prelude: string): boolean => /^@(-[a-z]+-)?keyframes\b/i.test(prelude);
const insideReducedMotion = (ancestors: readonly string[]): boolean =>
  ancestors.some((prelude) => prelude.replace(/\s+/g, ' ') === REDUCED_MOTION);

/**
 * Every way `css` breaks the scope, as sentences. Empty is a stylesheet that
 * keeps it. Also returns what was found in scope, so a caller can tell a
 * stylesheet that keeps the rule from one with nothing in it to keep.
 */
function scopeFaults(css: string): { faults: string[]; bindings: number; keyframes: string[] } {
  const faults: string[] = [];
  const keyframes: string[] = [];
  const names: string[] = [];
  let bindings = 0;
  const sheet = parseStylesheet(css);

  if (/@(-[a-z]+-)?starting-style\b/i.test(stripComments(css))) {
    faults.push('declares @starting-style, which is a transition by another name');
  }

  for (const { block, ancestors } of walk(sheet)) {
    const inKeyframes = ancestors.some(isKeyframes);
    if (isKeyframes(block.prelude)) {
      const name = block.prelude.replace(/^@(-[a-z]+-)?keyframes\s+/i, '').trim();
      keyframes.push(name);
      if (!insideReducedMotion(ancestors)) {
        faults.push(`@keyframes ${name} is outside ${REDUCED_MOTION}`);
      }
      continue;
    }
    for (const { property, value } of block.declarations) {
      const where = `${block.prelude} { ${property}: ${value} }`;
      if (inKeyframes) {
        if (!KEYFRAME_PROPERTIES.has(property)) {
          faults.push(`a keyframe moves ${property} (${where}) — only transform and opacity are composited`);
        }
        continue;
      }
      if (/^transition(-|$)/.test(property)) faults.push(`declares a transition: ${where}`);
      if (property === 'scroll-behavior' && /smooth/i.test(value)) faults.push(`scrolls smoothly: ${where}`);
      if (property.startsWith('view-transition')) faults.push(`declares a view transition: ${where}`);
      if (!/^animation(-|$)/.test(property)) continue;

      if (!LONGHANDS.has(property)) {
        faults.push(
          property === 'animation' || property === 'animation-duration' || property === 'animation-delay'
            ? `states ${property} (${where}) — a duration and a delay are motion.ts's, stated once beside the phase arithmetic`
            : `uses ${property} (${where}), which is not one of ${[...LONGHANDS].join(', ')}`,
        );
        continue;
      }
      bindings += 1;
      if (!insideReducedMotion(ancestors)) faults.push(`binds ${property} outside ${REDUCED_MOTION}: ${where}`);
      for (const selector of selectors(block.prelude)) {
        if (!MOTION_SCOPE.test(selector)) {
          faults.push(`binds ${property} on "${selector}", which is not under .canvas[data-motion="on"]`);
        }
      }
      if (property === 'animation-name') names.push(...value.split(',').map((one) => one.trim()));
    }
  }
  for (const name of names) {
    if (name !== 'none' && !keyframes.includes(name)) {
      faults.push(`animation-name ${name} names no keyframe set this stylesheet declares`);
    }
  }
  return { faults, bindings, keyframes };
}

// ---------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------

describe("the wall's stylesheet keeps motion inside its scope", () => {
  it('in source', () => {
    const found = scopeFaults(readFileSync(join(SRC, 'display.css'), 'utf8'));
    expect(found.faults).toEqual([]);
  });

  it('in the copy the server actually serves', () => {
    /*
     * `dist/display.css` is a *copy* made by `copy-static.mjs`, so source and
     * served are two files and only one of them reaches a wall. `pnpm test`
     * builds before it tests, which is why this can insist the copy exists
     * rather than skipping when it does not.
     */
    const served = join(DIST, 'display.css');
    expect(existsSync(served), 'no dist/display.css — run the build').toBe(true);
    expect(scopeFaults(readFileSync(served, 'utf8')).faults).toEqual([]);
  });

  it('has something inside the scope, so the assertions above are about something', () => {
    // The fixture's two keyframe sets (`motion-fixture.ts`), and the first real
    // styles' (P5.1): the Today card's sky and the playful strip's bob. A scan
    // that found no bindings would pass every assertion above on a stylesheet
    // that had lost its motion entirely; the countdown's arrive with S16.
    const found = scopeFaults(readFileSync(join(SRC, 'display.css'), 'utf8'));
    expect(found.bindings).toBeGreaterThan(0);
    expect(found.keyframes).toEqual(
      expect.arrayContaining([
        'fx-fixture-drift',
        'fx-fixture-arrive',
        'wt-glow',
        'wt-drift',
        'wt-rain',
        'wt-snow',
        'wp-bob',
      ]),
    );
  });

  it('refuses each way out of the scope, which is how the checks above are known to see', () => {
    /*
     * The mutations, kept. Each is a small stylesheet that breaks exactly one
     * condition, and the scan has to say so — the premise of every assertion
     * above, stated as a table rather than trusted.
     */
    const inScope = (rules: string): string => `${REDUCED_MOTION} { @keyframes k { to { opacity: 0; } } ${rules} }`;
    const cases: readonly [string, string][] = [
      ['a binding outside the media block', `${inScope('')} .canvas[data-motion="on"] .x { animation-name: k; }`],
      ['keyframes outside the media block', `@keyframes k { to { opacity: 0; } }`],
      ['a binding not under the switch', inScope('.fw .x { animation-name: k; }')],
      ['a switch that is not "on"', inScope('.canvas[data-motion] .x { animation-name: k; }')],
      ['one selector of two not under the switch', inScope('.canvas[data-motion="on"] .x, .y { animation-name: k; }')],
      ['a keyframe that moves layout', `${REDUCED_MOTION} { @keyframes k { to { width: 50%; } } }`],
      ['a keyframe that paints', `${REDUCED_MOTION} { @keyframes k { to { background: red; } } }`],
      ['a duration in the stylesheet', inScope('.canvas[data-motion="on"] .x { animation-duration: 6s; }')],
      ['a delay in the stylesheet', inScope('.canvas[data-motion="on"] .x { animation-delay: -1s; }')],
      ['the shorthand', inScope('.canvas[data-motion="on"] .x { animation: k 6s infinite; }')],
      ['an alternating loop', inScope('.canvas[data-motion="on"] .x { animation-direction: alternate; }')],
      ['a name nothing declares', inScope('.canvas[data-motion="on"] .x { animation-name: gone; }')],
      ['a transition, even in scope', inScope('.canvas[data-motion="on"] .x { transition: opacity 1s; }')],
      ['smooth scrolling', 'html { scroll-behavior: smooth; }'],
      ['a view transition', '.x { view-transition-name: a; }'],
      ['a starting style', '@starting-style { .x { opacity: 0; } }'],
      ['a vendor keyframe set outside', '@-webkit-keyframes k { to { opacity: 0; } }'],
    ];
    for (const [label, css] of cases) {
      expect(scopeFaults(css).faults, label).not.toEqual([]);
    }
    // And the shape the stylesheet actually uses passes, or the table proves nothing.
    expect(
      scopeFaults(inScope('.canvas[data-motion="on"] .x.fx-playing { animation-name: k; animation-fill-mode: both; }'))
        .faults,
    ).toEqual([]);
  });

  it('is the only stylesheet a wall loads', () => {
    // A second sheet is a second place the scope would have to be enforced, and
    // the admin's — which moves on its own terms — is exactly the one that must
    // not arrive here.
    const html = readFileSync(join(SRC, 'index.html'), 'utf8');
    const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)].map((m) => m[0]);
    expect(sheets.length, `the wall loads ${sheets.length} stylesheets: ${sheets.join(' ')}`).toBe(1);
    expect(sheets[0]).toContain('/assets/display.css');
    expect(/transition|animation|keyframes/i.test(stripComments(html)), 'index.html moves something').toBe(false);
  });

  it('ships no motion in the offline shell either', () => {
    const shell = join(DIST, 'sw.js');
    expect(existsSync(shell), 'no dist/sw.js — run the build').toBe(true);
    expect(/transition|animation|keyframes/i.test(stripComments(readFileSync(shell, 'utf8')))).toBe(false);
    // …and the shell caches exactly the one stylesheet, so an offline wall
    // cannot be handed a second one either.
    const cached = [...readFileSync(shell, 'utf8').matchAll(/"\/assets\/([\w.-]+\.css)"/g)].map((m) => m[1]);
    expect(cached).toEqual(['display.css']);
  });
});

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Every local module `main.ts` reaches, transitively — the wall, and only it. */
function wallModules(): string[] {
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const source = readFileSync(join(SRC, `${name}.ts`), 'utf8');
    for (const match of source.matchAll(/from '\.\/([\w-]+)\.js'/g)) visit(match[1] as string);
  };
  visit('main');
  return [...visited];
}

/** The one module in the graph that may say "animation". */
const DOOR = 'motion';

const WALL = wallModules().sort();

describe("the wall's own modules move nothing except through motion.ts", () => {
  it('walks a graph rather than a list, so a new module is covered by existing', () => {
    // The premise. A walker that found nothing would pass every assertion below.
    expect(WALL.length).toBeGreaterThan(10);
    expect(WALL).toContain('main');
    expect(WALL).toContain('render');
    // …and the door is in it, or the exemption below is about nothing.
    expect(WALL).toContain(DOOR);
  });

  for (const name of WALL.filter((one) => one !== DOOR)) {
    it(`${name}.ts does not mention motion`, () => {
      const source = stripComments(readFileSync(join(SRC, `${name}.ts`), 'utf8'));
      for (const word of ['transition', 'animation', 'keyframes'] as const) {
        expect(
          new RegExp(word, 'i').test(source),
          `${name}.ts mentions "${word}" outside a comment — motion on the wall goes through ` +
            'motion.ts, which is the one place it is phase-locked',
        ).toBe(false);
      }
      // `Element.animate()` is the one spelling that contains neither word.
      expect(/\.animate\s*\(/.test(source), `${name}.ts calls .animate()`).toBe(false);
    });
  }

  it('motion.ts writes a duration and a delay, and nothing that could move anything alone', () => {
    const source = stripComments(readFileSync(join(SRC, `${DOOR}.ts`), 'utf8'));
    const written = new Set([...source.matchAll(/animation[\w-]*/gi)].map((m) => m[0]));
    expect([...written].sort()).toEqual(['animationDelay', 'animationDuration']);
    expect(/transition|keyframes/i.test(source), 'motion.ts reaches for a transition or keyframes').toBe(false);
    expect(/\.animate\s*\(/.test(source), 'motion.ts calls .animate()').toBe(false);
    // No stylesheet of its own either: what moves is declared in display.css,
    // inside the scope, and nowhere a script could add a rule outside it.
    expect(/insertRule|CSSStyleSheet|createElement\(\s*['"]style/.test(source)).toBe(false);
  });

  it('leaves the admin editors alone, which is why the graph is the fence', () => {
    /*
     * These live in this package and are loaded by admin screens rather than by
     * a wall, so they are outside the scope by construction. Asserted rather
     * than assumed: if one of them ever entered the wall's graph, the sweep
     * above would start covering it — and this would go red first, saying why.
     */
    const editors = readdirSync(SRC)
      .filter((f) => f.endsWith('-editor.ts') || f === 'tabs.ts' || f === 'inspector.ts')
      .map((f) => f.replace(/\.ts$/, ''));
    expect(editors.length).toBeGreaterThan(2);
    for (const editor of editors) {
      expect(WALL, `${editor} is in the wall's import graph`).not.toContain(editor);
    }
  });
});

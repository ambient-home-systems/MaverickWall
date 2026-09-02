import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Nothing a screen draws may move, and this is what makes that structural.
 *
 * The rule is one of this project's design rules and it has been a *convention*
 * for as long as it has existed: "no transition or animation on any surface a
 * screen sees. The wall has no pointer and redraws every 15 s; the panel
 * physically cannot animate." A convention is what a future contributor breaks
 * — reasonably, from a browser habit, in a file nobody re-reads — so the ban is
 * a build failure now.
 *
 * Two reasons rather than taste. **The wall redraws on a fifteen-second tick**,
 * so a transition on a value that changes each tick is not a fade, it is a
 * flicker in a room somebody lives in; and every second of it is a repaint on a
 * screen that is often a cheap tablet bolted to a wall. **The panel cannot
 * animate at all** — an e-paper sheet takes hundreds of milliseconds to settle
 * one frame, and the whole point of the phase this test ships in is that a
 * settled frame's rectangles do not move, so that the next one can be pushed as
 * a partial refresh rather than a full flash.
 *
 * ## What is checked, and where the fence is
 *
 *  - `display.css`, in **source and in the copy `dist/` serves**, carries no
 *    transition, no animation, no `@keyframes`, no smooth scrolling and no view
 *    transition. Both, because a stale `dist/` is what a screen actually loads.
 *  - The wall's own HTML and its offline shell carry no inline motion.
 *  - **Every module in the wall's compiled import graph** — walked from
 *    `main.ts` the way `sw-shell.test.ts` walks it, rather than from a list
 *    somebody maintains — contains neither word at all. Not "writes no
 *    `style.transition`": the wall has no motion of any kind, so the words have
 *    no business in it, and a blanket ban needs no judgement about which spelling
 *    of `element.animate` somebody reached for.
 *
 * The admin is deliberately **out of scope** and keeps its three durations and
 * three easings: it is a page with a pointer, on a device somebody is holding.
 * `apps/server/test/motion-scope.test.ts` is the other half of this fence — it
 * holds the admin's motion inside `prefers-reduced-motion: no-preference`, and
 * holds the panel path to shipping no stylesheet at all.
 *
 * The editors that live in this package (`layout-editor.ts`, `theme-editor.ts`,
 * `display-editor.ts` and friends) are admin screens that happen to be built
 * here, so they are out of scope too — and the *reason* they are out of scope is
 * the import graph rather than a list: a screen loads `main.js`, and nothing a
 * screen loads may move.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const DIST = join(HERE, '..', 'dist');

/** Comments first: this file's own prose names every pattern it bans. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every motion a stylesheet can express, as one list. */
const CSS_MOTION: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'a transition', pattern: /(^|[;{}\s])transition(-[a-z-]+)?\s*:/i },
  { name: 'an animation', pattern: /(^|[;{}\s])animation(-[a-z-]+)?\s*:/i },
  { name: 'a keyframe set', pattern: /@(-[a-z]+-)?keyframes\b/i },
  { name: 'smooth scrolling', pattern: /scroll-behavior\s*:\s*smooth/i },
  { name: 'a view transition', pattern: /view-transition/i },
  { name: 'a starting style', pattern: /@starting-style\b/i },
];

function scan(label: string, source: string): void {
  const css = stripComments(source);
  for (const { name, pattern } of CSS_MOTION) {
    const found = pattern.exec(css);
    expect(
      found,
      `${label} declares ${name} (${found?.[0].trim() ?? ''}) — a screen has no pointer, ` +
        'redraws every fifteen seconds, and on e-paper cannot animate at all',
    ).toBeNull();
  }
}

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

describe("the wall's stylesheet", () => {
  it('declares no motion of any kind, in source', () => {
    scan('display.css', readFileSync(join(SRC, 'display.css'), 'utf8'));
  });

  it('declares none in the copy the server actually serves', () => {
    /*
     * `dist/display.css` is a *copy* made by `copy-static.mjs`, so source and
     * served are two files and only one of them reaches a wall. `pnpm test`
     * builds before it tests, which is why this can insist the copy exists
     * rather than skipping when it does not.
     */
    const served = join(DIST, 'display.css');
    expect(existsSync(served), 'no dist/display.css — run the build').toBe(true);
    scan('dist/display.css', readFileSync(served, 'utf8'));
  });

  it('is the only stylesheet a wall loads', () => {
    // A second sheet is a second place the ban would have to be enforced, and
    // the admin's — which legitimately moves — is exactly the one that must not
    // arrive here.
    const html = readFileSync(join(SRC, 'index.html'), 'utf8');
    const sheets = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)].map((m) => m[0]);
    expect(sheets.length, `the wall loads ${sheets.length} stylesheets: ${sheets.join(' ')}`).toBe(1);
    expect(sheets[0]).toContain('/assets/display.css');
    scan('index.html', html);
  });

  it('ships no inline motion in the offline shell either', () => {
    const shell = join(DIST, 'sw.js');
    expect(existsSync(shell), 'no dist/sw.js — run the build').toBe(true);
    scan('dist/sw.js', readFileSync(shell, 'utf8'));
    // …and the shell caches exactly the one stylesheet, so an offline wall
    // cannot be handed a second one either.
    const cached = [...readFileSync(shell, 'utf8').matchAll(/"\/assets\/([\w.-]+\.css)"/g)].map((m) => m[1]);
    expect(cached).toEqual(['display.css']);
  });
});

const WALL = wallModules().sort();

describe("the wall's own modules", () => {
  const modules = WALL;

  it('walks a graph rather than a list, so a new module is covered by existing', () => {
    // The premise. A walker that found nothing would pass every assertion below.
    expect(modules.length).toBeGreaterThan(10);
    expect(modules).toContain('main');
    expect(modules).toContain('render');
  });

  for (const name of WALL) {
    it(`${name}.ts does not mention motion`, () => {
      const source = stripComments(readFileSync(join(SRC, `${name}.ts`), 'utf8'));
      for (const word of ['transition', 'animation', 'keyframes'] as const) {
        expect(
          new RegExp(word, 'i').test(source),
          `${name}.ts mentions "${word}" outside a comment — the wall has no motion, ` +
            'so it has no reason to know the word',
        ).toBe(false);
      }
      // `Element.animate()` is the one spelling that does not contain either
      // word, so it is named directly.
      expect(/\.animate\s*\(/.test(source), `${name}.ts calls .animate()`).toBe(false);
    });
  }

  it('leaves the admin editors alone, which is why the graph is the fence', () => {
    /*
     * These live in this package and are loaded by admin screens rather than by
     * a wall, so they are outside the ban by construction. Asserted rather than
     * assumed: if one of them ever entered the wall's graph, the sweep above
     * would start covering it — and this would go red first, saying why.
     */
    const editors = readdirSync(SRC)
      .filter((f) => f.endsWith('-editor.ts') || f === 'tabs.ts' || f === 'inspector.ts')
      .map((f) => f.replace(/\.ts$/, ''));
    expect(editors.length).toBeGreaterThan(2);
    for (const editor of editors) {
      expect(modules, `${editor} is in the wall's import graph`).not.toContain(editor);
    }
  });
});

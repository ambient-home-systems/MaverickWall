import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { THEME_NAMES, applyTheme, type Themeable } from '../src/theme.js';

/**
 * Every custom property the wall reads is one something actually sets.
 *
 * `var(--x, fallback)` never fails loudly. A token that no longer exists, or
 * that never existed here at all, resolves silently to whatever literal was
 * written beside it years ago — so the rule keeps drawing, keeps looking
 * plausible, and stops following the theme. This bundle had three of them at
 * once and each had been wrong for a different length of time:
 *
 *  - **`--ruleSoft`** is the *admin*'s token, declared in `http/html.ts`, and
 *    it had leaked into the wall's stylesheet. `.gp-reading`'s divider had
 *    therefore never resolved to anything but its own
 *    `rgba(255, 255, 255, 0.06)` — a hairline on Panels and invisible on
 *    Household, Blueprint and Almanac, which is three themes of five.
 *  - **`--line`** was declared nowhere by anybody, so two borders had always
 *    fallen through to their second fallback, `--muted`.
 *  - **`--bg` and `--ink`'s own fallbacks were Board's**, and Board is retired
 *    and aliased to Panels. The one moment those are ever on screen — between
 *    the stylesheet parsing and `applyTheme` running — was the retired theme
 *    painting the first frame of every wall.
 *
 * None of that is visible by reading a rule: each one *has* a value, and the
 * value looks like a colour somebody chose. It is only visible by asking what
 * declares the name.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const CSS = readFileSync(join(SRC, 'display.css'), 'utf8');

/** The stylesheet with its comments removed, so prose cannot look like code. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * What `applyTheme` writes onto the root, asked of the function rather than
 * transcribed — a sixth theme is covered the day it is declared.
 */
function themeProperties(): Set<string> {
  const props = new Set<string>();
  for (const name of THEME_NAMES) {
    const el: Themeable & { props: Record<string, string> } = {
      props: {},
      style: {
        setProperty(key: string, value: string): void {
          (el.props as Record<string, string>)[key] = value;
        },
        removeProperty(): void {},
      },
      setAttribute(): void {},
    } as unknown as Themeable & { props: Record<string, string> };
    applyTheme(el, name);
    for (const key of Object.keys(el.props)) props.add(key);
  }
  return props;
}

/**
 * Every custom property this bundle's own TypeScript names, comments stripped.
 *
 * Derived rather than listed, and the first draft of this file listed them —
 * which was wrong in the way that matters. A hand-list fails on every
 * *legitimate* new token, so it cries wolf on ordinary work and teaches
 * whoever hits it to append a name without reading why; the fault it exists
 * for is a token that **nothing anywhere** sets, and that is exactly what a
 * derivation can still see. `--ruleSoft` and `--line` were set by nobody in
 * this repository's display at all.
 *
 * Comments are stripped from the sources for the same reason they are stripped
 * from the stylesheet: this file's own prose mentions `--ruleSoft` a dozen
 * times, and prose that reads as a declaration would make the guard pass on
 * the strength of its own explanation.
 */
function namedInSource(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(SRC, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const match of source.matchAll(/['"`](--[A-Za-z0-9_-]+)['"`]/g)) {
      names.add(match[1] as string);
    }
    // `` `${property}-ink` `` — a name built from another, which no literal scan
    // can see. The suffix is what is declared here; the stems are literals above.
    for (const match of source.matchAll(/\$\{[A-Za-z]+\}(-[A-Za-z0-9_-]+)`/g)) {
      for (const stem of [...names]) names.add(`${stem}${match[1] as string}`);
    }
  }
  return names;
}

describe('the display stylesheet', () => {
  it('reads no custom property that nothing declares', () => {
    const read = new Set(
      [...RULES.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1] as string),
    );
    /*
     * Declared by the stylesheet itself — `:root` and the per-theme blocks —
     * plus what a theme writes and what any source file names. Anything left
     * has no source at all: not a rule, not a theme, not a renderer.
     */
    const declared = new Set([
      ...[...RULES.matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)].map((match) => match[1] as string),
      ...themeProperties(),
      ...namedInSource(),
    ]);

    const orphans = [...read].filter((name) => !declared.has(name)).sort();
    expect(
      orphans,
      `${orphans.length} custom propert${orphans.length === 1 ? 'y is' : 'ies are'} read by ` +
        `display.css and set by nothing: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('is looking at the real stylesheet, so a move fails loudly', () => {
    // A regex over a file that has been renamed matches nothing and passes
    // every assertion above by comparing two empty sets.
    expect(RULES).toContain('--ink-event');
    expect([...RULES.matchAll(/var\(\s*--/g)].length).toBeGreaterThan(200);
  });

  it('falls back to the default theme, never to a retired one', () => {
    /*
     * A `var(--x, <literal>)` is the value on screen for the instant between
     * this sheet parsing and `applyTheme` running, and for good on a wall
     * whose script never runs at all — which is the `<noscript>` case, and the
     * one screen where being wrong is most visible.
     *
     * Board, Slate and Glance are retired and `resolveName` aliases all three
     * to Panels, so a literal lifted from one of them is a theme nothing can
     * select any longer, deciding the first paint. The three below are Board's
     * `--bg`, `--ink` and `--panel`; `1.2rem` is the radius `theme.ts` records
     * as removed for reading as "a rounded bubble, not a panel".
     */
    const retired = ['#0B0E11', '#E9EEF4', '#151A1F', 'var(--radius, 1.2rem)'];
    const found = retired.filter((value) => RULES.includes(value));
    expect(found, `retired theme values are still on the fallback path: ${found.join(', ')}`).toEqual(
      [],
    );

    // And what the fallbacks *are* is Panels', which is the documented default.
    const panels: Record<string, string> = {};
    const el = {
      style: {
        setProperty(key: string, value: string): void {
          panels[key] = value;
        },
        removeProperty(): void {},
      },
      setAttribute(): void {},
    } as unknown as Themeable;
    applyTheme(el, 'panels');
    for (const token of ['--bg', '--ink', '--panel'] as const) {
      const fallback = new RegExp(`var\\(${token},\\s*(#[0-9A-Fa-f]{6})\\)`).exec(RULES);
      if (fallback === null) continue;
      expect(
        (fallback[1] as string).toUpperCase(),
        `${token}'s fallback is not Panels' own value`,
      ).toBe((panels[token] as string).toUpperCase());
    }
  });
});

import { describe, expect, it } from 'vitest';
import { adminStylesheet as stylesheet, rulesOf } from './admin-stylesheet.js';

/**
 * Every control that opts out of the filled button must opt out of its states.
 *
 * `button,.btn` is the *filled* variant — primary ground, on-primary label —
 * and its `:hover` / `:active` rules are `(0,1,1)`, which beats any
 * single-class rule. So a control that clears its background to become a tab,
 * a menu row or an icon button looks right at rest and fills with **primary**
 * the moment a pointer touches it, drawing its own label in a colour picked
 * for a different ground. Gold on gold.
 *
 * That was reported from a real screen: hovering the widget inspector's Style
 * tab made the word vanish. `:active` is the same fault and the more important
 * half — a phone has no hover, a tap is `:active`, so it was flashing
 * unreadable on every press on the device the editor was redesigned for.
 *
 * The rule is derived from the stylesheet rather than a list kept by hand: any
 * single-class rule that clears its background *and* says `cursor:pointer` is
 * a control with no container, and must declare both states. A new one is
 * covered the day it is written.
 */

const SETS_BACKGROUND = /(^|;|\s)background(-color)?\s*:/;
const CLEARS_BACKGROUND = /background\s*:\s*(none|transparent)/;

describe('controls that clear the filled button background', () => {
  it('declare a hover and a pressed state of their own', async () => {
    const rules = rulesOf(await stylesheet());

    // Single-class rules that clear the background and behave as a control.
    const containerless = new Set<string>();
    for (const rule of rules) {
      if (!CLEARS_BACKGROUND.test(rule.body) || !/cursor\s*:\s*pointer/.test(rule.body)) continue;
      for (const selector of rule.selectors) {
        if (/^\.[a-z0-9-]+$/i.test(selector)) containerless.add(selector);
      }
    }
    // A guard on the guard: if the heuristic stops matching anything, the check
    // has quietly become a no-op and would pass over the very bug it exists for.
    expect(containerless.size).toBeGreaterThan(3);

    const withState = (suffix: string): Set<string> => {
      const found = new Set<string>();
      for (const rule of rules) {
        if (!SETS_BACKGROUND.test(rule.body)) continue;
        for (const selector of rule.selectors) {
          if (selector.endsWith(suffix)) found.add(selector.slice(0, -suffix.length));
        }
      }
      return found;
    };
    const hovered = withState(':hover');
    const pressed = withState(':active');

    /*
     * One exemption, and it is about what the element *is*.
     *
     * `.srow-select` is a native <select> wearing a settings row — it clears
     * its background for the same reason, but `button:hover` cannot match it,
     * so it has nothing to opt out of. Anything else that turns up here is a
     * real control and belongs in the grouped state rules.
     */
    const NOT_A_BUTTON = new Set(['.srow-select']);

    const missing: string[] = [];
    for (const selector of [...containerless].sort()) {
      if (NOT_A_BUTTON.has(selector)) continue;
      if (!hovered.has(selector)) missing.push(`${selector} has no :hover background`);
      if (!pressed.has(selector)) missing.push(`${selector} has no :active background`);
    }
    expect(
      missing,
      'these fill with primary on hover or press, and draw their label on it',
    ).toEqual([]);
  });

  it('does not let the inspector tab take the filled button’s accent', async () => {
    // The reported symptom, pinned on its own: hovering Style made the word
    // vanish because the only background in play was the accent fill.
    const rules = rulesOf(await stylesheet());
    const tabHover = rules.filter(
      (rule) => rule.selectors.includes('.insp-tab:hover') && SETS_BACKGROUND.test(rule.body),
    );
    expect(tabHover.length).toBeGreaterThan(0);
    for (const rule of tabHover) {
      // `--mw-accent-soft` would be fine — a tinted ground with its own text
      // colour. `--mw-accent` is the filled button's ground, and the tab draws
      // its label in the ink colour, so that pair is the bug.
      expect(rule.body).not.toMatch(/background(-color)?:\s*var\(--mw-accent\)/);
      // A tint over whatever the tab sits on, not a fill.
      expect(rule.body).toContain('--mw-wash-hover');
    }
  });
});

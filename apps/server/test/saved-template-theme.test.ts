/**
 * Every template that repaints a wall has a sentence that says which colour.
 *
 * Applying a template writes `template.theme` onto the wall when the card names
 * one — twelve of the fourteen shipped wall templates do, seven `panels` and
 * five `almanac` — and for as long as that was true the only thing that said so
 * was a caption on the gallery card. The household pressed Sky Week and their
 * kitchen changed colour under a strip reading "Layout applied." (RFC 015
 * §2.8's third mechanism, §3.6's fix).
 *
 * `saved.ts`'s first stated property is that the token is a **key and never a
 * message**: nothing a caller passes is echoed, and the strip draws a literal
 * out of `SAVED_MESSAGES`. So the theme names are written into that table by
 * hand, which is affordable exactly while the catalogue names two themes — and
 * this file is what keeps it affordable rather than letting it rot. It walks
 * the catalogue and fails the build when a template names a theme with no key,
 * so a fifteenth card in a third theme is a hole somebody has to fill rather
 * than a strip that quietly names the wrong colour.
 *
 * The lookup's own fallback is the other half, and it is deliberate: a miss
 * answers the generic sentence rather than throwing, because a household who
 * applied a template must be told their layout changed even on the day this
 * table has not caught up (rule nine). That is precisely why the gate has to be
 * a test — a silent, correct-looking fallback is invisible from inside the
 * product.
 */
import { describe, expect, it } from 'vitest';
import { SAVED_MESSAGES, templateAppliedKey } from '../src/http/saved.js';
import { TEMPLATES, PANEL_TEMPLATES } from '../src/templates/index.js';
import { THEMES, themeName } from '../src/http/theme-cards.js';

describe('the sentence a template leaves behind', () => {
  it('names the theme of every template that sets one', () => {
    const naming = TEMPLATES.filter((t) => t.theme !== undefined);
    // A catalogue with no themed template would pass every assertion below
    // while proving nothing, which is how this kind of sweep goes quiet.
    expect(naming.length, 'no shipped template names a theme any more').toBeGreaterThan(5);

    const missing: string[] = [];
    for (const template of naming) {
      const key = templateAppliedKey(template.theme);
      if (key === 'layout-template-applied') missing.push(`${template.name} (${template.theme})`);
    }
    expect(
      missing,
      'a template repaints the wall and the strip will not say which colour — ' +
        `add a 'layout-template-applied-<theme>' to SAVED_MESSAGES:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('says the theme by the name the household picked it under', () => {
    /*
     * The sentence is a literal, so nothing derives it — which is exactly the
     * thing that goes wrong unwatched. `THEMES` is where a household reads
     * "Paper Almanac", and a strip saying "Almanac" would be naming a card
     * that is not on the gallery. Checked against the table rather than against
     * a second literal, because two literals is how `/admin/themes` came to
     * offer three themes that no longer exist (RFC 015 §2.1).
     */
    for (const theme of THEMES) {
      const key = templateAppliedKey(theme.key);
      if (key === 'layout-template-applied') continue; // No template wears it.
      expect(SAVED_MESSAGES[key], `${theme.key}'s sentence`).toContain(themeName(theme.key));
    }
  });

  it('leaves a template with no theme, and every panel template, on the plain sentence', () => {
    /*
     * Classic and Blank name no theme deliberately — "a card called 'Blank'
     * repainting a kitchen is the last thing somebody pressing it expects" —
     * and a panel has no theme at all, so every e-paper apply lands here too.
     * Asserted as the *value* rather than as "not one of the themed ones": a
     * key that stopped existing would satisfy the weaker reading.
     */
    expect(templateAppliedKey(undefined)).toBe('layout-template-applied');
    for (const template of TEMPLATES.filter((t) => t.theme === undefined)) {
      expect(templateAppliedKey(template.theme), template.name).toBe('layout-template-applied');
    }
    for (const template of PANEL_TEMPLATES) {
      expect(template.theme, `${template.name} is a panel card and has no theme`).toBeUndefined();
      expect(templateAppliedKey(template.theme), template.name).toBe('layout-template-applied');
    }
  });

  it('refuses a theme name that is not a key, rather than inventing a token', () => {
    // The fallback, asked directly: a stored or hand-posted theme this table
    // has never heard of answers the generic sentence and never a key the
    // strip would fail to render.
    for (const stranger of ['', 'board', 'custom:abc', 'no-such-theme']) {
      expect(templateAppliedKey(stranger), stranger).toBe('layout-template-applied');
    }
  });
});

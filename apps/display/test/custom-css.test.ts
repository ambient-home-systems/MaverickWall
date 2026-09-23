import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CSS_MAX_CHARS,
  createCustomCssSheet,
  customCssBlocks,
  splitRules,
  type RuleSheet,
} from '../src/custom-css.js';

/**
 * The wall's end of a household's own CSS (RFC 014 §7, precondition 3), with
 * no browser: the rule split, the insert policy, and what a manifest is
 * trusted to carry. The CSSOM half — that a rule inserted this way is under
 * the display's Content-Security-Policy and refused when it fetches — is
 * `apps/server/test/display-csp.test.ts`, in a real Chromium.
 */

describe('splitRules', () => {
  it('cuts at the brace that closes each top-level rule', () => {
    expect(splitRules('.a{color:red}.b{color:blue}')).toEqual(['.a{color:red}', '.b{color:blue}']);
  });

  it('keeps a nested block inside the rule that holds it', () => {
    expect(splitRules('@media (x){.a{color:red}.b{color:blue}}.c{}')).toEqual([
      '@media (x){.a{color:red}.b{color:blue}}',
      '.c{}',
    ]);
  });

  it('reads a brace inside a string as text', () => {
    expect(splitRules('.a{content:"}"}.b{content:\'{\'}')).toEqual(['.a{content:"}"}', ".b{content:'{'}"]);
  });

  it('reads an escaped quote inside a string as text', () => {
    expect(splitRules('.a{content:"\\"}"}.b{}')).toEqual(['.a{content:"\\"}"}', '.b{}']);
  });

  it('reads a brace inside a comment as text', () => {
    expect(splitRules('/* } */.a{color:red}/* { */.b{}')).toEqual(['.a{color:red}', '.b{}']);
  });

  it('cuts a blockless statement at its semicolon, for the browser to refuse', () => {
    expect(splitRules('@import "x";.a{}')).toEqual(['@import "x";', '.a{}']);
  });

  it('hands an unterminated last rule over rather than losing it', () => {
    expect(splitRules('.a{color:red}.b{color:blue')).toEqual(['.a{color:red}', '.b{color:blue']);
  });

  it('answers nothing for nothing', () => {
    expect(splitRules('')).toEqual([]);
    expect(splitRules('  \n ')).toEqual([]);
    expect(splitRules('/* only */')).toEqual([]);
  });

  it('survives stray closing braces', () => {
    expect(splitRules('}}.a{}')).toEqual(['}', '}', '.a{}']);
  });
});

describe('customCssBlocks', () => {
  it('takes the wall’s block first, then each widget’s, and only strings with something in them', () => {
    expect(
      customCssBlocks('.canvas .fw{}', [
        { customCss: '[data-widget-id="a"] .x{}' },
        {},
        { customCss: 12 },
        { customCss: '   ' },
        { customCss: '[data-widget-id="b"] .y{}' },
      ]),
    ).toEqual(['.canvas .fw{}', '[data-widget-id="a"] .x{}', '[data-widget-id="b"] .y{}']);
  });

  it('answers nothing for a manifest that carries nothing', () => {
    expect(customCssBlocks(undefined, [{}, {}])).toEqual([]);
  });

  it('refuses a block past the bound, whichever bundle wrote it', () => {
    const huge = `.a{}${' '.repeat(CUSTOM_CSS_MAX_CHARS)}`;
    expect(customCssBlocks(huge, [{ customCss: huge }])).toEqual([]);
  });
});

/** A sheet that remembers what was inserted and can be told to refuse some. */
function fakeSheet(own: number, refuse: (rule: string) => boolean = () => false): RuleSheet & { rules: string[] } {
  const rules = Array.from({ length: own }, (_, i) => `.wall-${i}{}`);
  return {
    rules,
    get cssRules() {
      return { length: rules.length };
    },
    insertRule(rule: string, index: number): number {
      if (refuse(rule)) throw new Error(`refused: ${rule}`);
      rules.splice(index, 0, rule);
      return index;
    },
    deleteRule(index: number): void {
      rules.splice(index, 1);
    },
  };
}

describe('createCustomCssSheet', () => {
  it('appends every rule after the wall’s own', () => {
    const sheet = fakeSheet(3);
    const custom = createCustomCssSheet(() => sheet);
    custom.apply(['.a{}.b{}', '@media (x){.c{}}']);
    expect(sheet.rules).toEqual(['.wall-0{}', '.wall-1{}', '.wall-2{}', '.a{}', '.b{}', '@media (x){.c{}}']);
  });

  it('drops a rule the browser refuses, and keeps the ones around it', () => {
    const sheet = fakeSheet(1, (rule) => rule.includes('bad'));
    const custom = createCustomCssSheet(() => sheet);
    custom.apply(['.a{}.bad{}.c{}']);
    expect(sheet.rules).toEqual(['.wall-0{}', '.a{}', '.c{}']);
  });

  it('replaces rather than accumulates, and clears down to the wall’s own', () => {
    const sheet = fakeSheet(2);
    const custom = createCustomCssSheet(() => sheet);
    custom.apply(['.a{}']);
    custom.apply(['.b{}', '.c{}']);
    expect(sheet.rules).toEqual(['.wall-0{}', '.wall-1{}', '.b{}', '.c{}']);
    custom.clear();
    expect(sheet.rules).toEqual(['.wall-0{}', '.wall-1{}']);
    custom.clear();
    expect(sheet.rules).toEqual(['.wall-0{}', '.wall-1{}']);
  });

  it('does nothing on a redraw with the same blocks', () => {
    let inserted = 0;
    const sheet = fakeSheet(1);
    const counting: RuleSheet = {
      get cssRules() {
        return sheet.cssRules;
      },
      insertRule: (rule, index) => {
        inserted++;
        return sheet.insertRule(rule, index);
      },
      deleteRule: (index) => sheet.deleteRule(index),
    };
    const custom = createCustomCssSheet(() => counting);
    custom.apply(['.a{}.b{}']);
    custom.apply(['.a{}.b{}']);
    custom.apply(['.a{}.b{}']);
    expect(inserted).toBe(2);
    custom.apply(['.a{}']);
    expect(inserted).toBe(3);
    expect(sheet.rules).toEqual(['.wall-0{}', '.a{}']);
  });

  it('waits for a sheet that is not there yet, and applies once it is', () => {
    let sheet: RuleSheet | undefined;
    const custom = createCustomCssSheet(() => sheet);
    custom.apply(['.a{}']);
    const real = fakeSheet(2);
    sheet = real;
    custom.apply(['.a{}']);
    expect(real.rules).toEqual(['.wall-0{}', '.wall-1{}', '.a{}']);
  });

  it('treats a sheet whose rules cannot be read as no sheet', () => {
    const custom = createCustomCssSheet(() => {
      throw new Error('cross-origin');
    });
    expect(() => custom.apply(['.a{}'])).not.toThrow();
    expect(() => custom.clear()).not.toThrow();
  });
});

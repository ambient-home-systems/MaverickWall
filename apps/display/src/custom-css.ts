/**
 * A household's own CSS, on the wall (RFC 014 §7, precondition 3).
 *
 * The server has already read the text with a real parser, refused what has to
 * be refused and scoped every selector under the box it is for
 * (`apps/server/src/api/custom-css.ts`); what arrives in the manifest is the
 * scoped output, one string per widget and one for the wall. This module is
 * the wall's end of that, and it does three things and no more:
 *
 *  - **It inserts through the CSSOM and never through markup.** Each rule goes
 *    in with `CSSStyleSheet.insertRule` on the wall's own `display.css` sheet,
 *    at the end, so the household's rules come after every rule of the wall's
 *    and win at equal specificity — which is the whole of how they override.
 *    Not a `<style>` element: the display serves a Content-Security-Policy of
 *    `style-src 'self'` with no `'unsafe-inline'`, and a `<style>` written by
 *    script is exactly what that directive refuses. The CSSOM is not governed
 *    by it, which `display-csp.test.ts` measured before this existed.
 *  - **It drops what the browser refuses, one rule at a time.** `insertRule`
 *    throws on a rule this engine cannot read — a selector it does not know,
 *    an `@import` past the first index — and one bad rule must cost that rule
 *    and never the block, let alone the wall. So the text is split into
 *    rules here and each is inserted under its own `try`.
 *  - **It is applied only while a canvas is drawn**, and cleared otherwise.
 *    The pairing form, the boot message, the offline banner and an alert
 *    takeover are all outside `.canvas` by construction, and every rule is
 *    scoped under it or under a box inside it — so none of them can match the
 *    chrome. The clearing is belt and braces on top of that: `draw` asks
 *    whether the document it just built holds a canvas, and the chrome paths
 *    clear before they draw.
 *
 * Nothing here parses CSS. The split below is a brace counter that knows
 * about strings, escapes and comments, which is all a top-level rule boundary
 * needs; the sanitiser's output has no comments in it, and a stored copy that
 * somehow does is still split correctly.
 *
 * Pure apart from the sheet it is handed, so the split and the insert policy
 * can be tested without a browser — the reason `widget-options.ts`, `ink.ts`
 * and `gutter.ts` are shaped this way.
 */

/**
 * The most one block may be, in characters, as this bundle is willing to hand
 * the CSSOM. The server bounds what a household *types* at 8 KB and the scoped
 * output is at most a few times that; a stored copy in IndexedDB may have been
 * written by any bundle, so the bound is here as well, generous and absolute.
 */
export const CUSTOM_CSS_MAX_CHARS = 64 * 1024;

/**
 * The blocks to apply for a drawn canvas: the wall's own, then each widget's.
 *
 * Read defensively — a manifest from a server older than the field never
 * carries it, one from a newer server may carry anything, and a cached copy
 * was written by whatever bundle was hanging at the time. A block that is not
 * a string, is empty, or is past the bound is simply not one.
 */
export function customCssBlocks(
  wall: unknown,
  widgets: readonly { readonly customCss?: unknown }[],
): string[] {
  const blocks: string[] = [];
  const keep = (value: unknown): void => {
    if (typeof value !== 'string') return;
    if (value.trim() === '' || value.length > CUSTOM_CSS_MAX_CHARS) return;
    blocks.push(value);
  };
  keep(wall);
  for (const widget of widgets) keep(widget.customCss);
  return blocks;
}

/**
 * The top-level rules of a stylesheet, as separate strings.
 *
 * A rule ends at the `}` that closes its outermost block; a statement with no
 * block (`@import …;`, which the server never sends) ends at a `;` outside
 * any block. Braces inside strings and comments are text, and a backslash
 * escapes the character after it inside a string. Whatever is left at the end
 * is one more rule, so an unterminated last rule is handed to the browser to
 * judge rather than lost.
 */
export function splitRules(css: string): string[] {
  const rules: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | undefined;
  let i = 0;
  const cut = (): void => {
    const rule = current.trim();
    if (rule !== '') rules.push(rule);
    current = '';
  };
  while (i < css.length) {
    const ch = css.charAt(i);
    if (quote !== undefined) {
      if (ch === '\\') {
        current += css.slice(i, i + 2);
        i += 2;
      } else {
        if (ch === quote) quote = undefined;
        current += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && css.charAt(i + 1) === '*') {
      // A comment is dropped rather than carried: it is text to the brace
      // count, and nothing to the browser.
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? css.length : close + 2;
      continue;
    }
    current += ch;
    i += 1;
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0) cut();
    } else if (ch === ';' && depth === 0) {
      cut();
    }
  }
  cut();
  return rules;
}

/** The slice of a stylesheet this module needs: what `CSSStyleSheet` gives. */
export interface RuleSheet {
  readonly cssRules: { readonly length: number };
  insertRule(rule: string, index: number): number;
  deleteRule(index: number): void;
}

export interface CustomCssSheet {
  /** Put exactly these blocks on the sheet, replacing whatever was there. */
  apply(blocks: readonly string[]): void;
  /** Take every household rule off the sheet, leaving the wall's own. */
  clear(): void;
}

/**
 * The household's rules on one sheet, after everything the wall put there.
 *
 * `findSheet` is asked on every call rather than once, because the wall's
 * stylesheet is a `<link>` and a module can run before it has finished
 * loading; until it is there, nothing is applied and nothing is remembered,
 * so the next draw simply tries again. The number of rules the sheet held
 * when it was first found is the fence: everything at or past that index is
 * the household's and is what `clear` removes, and nothing below it is ever
 * touched.
 *
 * `apply` is idempotent on its input — the same blocks twice cost nothing —
 * because `draw` runs every fifteen seconds and re-inserting a few dozen rules
 * each tick would be a style recalculation for nothing.
 */
export function createCustomCssSheet(findSheet: () => RuleSheet | undefined): CustomCssSheet {
  let sheet: RuleSheet | undefined;
  let base = 0;
  let applied: string | undefined;

  const locate = (): RuleSheet | undefined => {
    if (sheet !== undefined) return sheet;
    let found: RuleSheet | undefined;
    try {
      found = findSheet();
      if (found !== undefined) base = found.cssRules.length;
    } catch {
      // A sheet whose rules cannot be read (a cross-origin one, which the wall's
      // never is) is no sheet at all as far as this is concerned.
      found = undefined;
    }
    sheet = found;
    return sheet;
  };

  const clear = (): void => {
    const target = locate();
    applied = undefined;
    if (target === undefined) return;
    try {
      while (target.cssRules.length > base) target.deleteRule(target.cssRules.length - 1);
    } catch {
      // Leave what could not be removed; the next apply retries the whole set.
    }
  };

  return {
    clear,
    apply(blocks: readonly string[]): void {
      const target = locate();
      if (target === undefined) return;
      const key = blocks.join('\n');
      if (key === applied) return;
      clear();
      for (const block of blocks) {
        for (const rule of splitRules(block)) {
          try {
            target.insertRule(rule, target.cssRules.length);
          } catch {
            // This engine could not read the rule. It costs that rule alone;
            // the wall draws on, which is the whole of rule nine here.
          }
        }
      }
      applied = key;
    },
  };
}

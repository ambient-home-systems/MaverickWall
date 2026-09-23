import * as csstree from 'css-tree';
import type { CssNode, CssNodePlain, Declaration, List, Rule, SelectorList } from 'css-tree';

/**
 * A household's own CSS, read at save time and scoped to the box it is for
 * (RFC 014 §7, precondition 2).
 *
 * One block per wall and one per widget, typed into a textarea on the wall's
 * Advanced page, stored beside what the household wrote as the *scoped* text
 * the manifest carries, and inserted by the wall through the CSSOM after its
 * own stylesheet. Everything about that is decided here, once, as a pure
 * function — for the reason `safeNextPath`, `widget-options.ts` and `ink.ts`
 * are pure: a policy that lives inside a handler is a policy a test can only
 * reach through a server, one case at a time, and this one is an allowlist a
 * reader has to be able to take in whole.
 *
 * ## Refuse, never strip
 *
 * Every refusal is a 400 naming the line and the reason, echoed beside the
 * field. Nothing is quietly removed: a block that had its `@import` taken out
 * and was saved anyway is a block whose author believes it does something it
 * does not, and the next thing they paste in is the same line again. The
 * bypass table in `test/custom-css.test.ts` is written against that property —
 * every row asserts `ok === false`, so a sanitiser that strips instead of
 * rejecting turns the whole table red.
 *
 * ## What is refused, and why each
 *
 * - **`@import`, `@font-face`, `@namespace`, and every at-rule that is not
 *   `@media`, `@supports` or `@container`** — an allowlist rather than a list
 *   of the bad ones, so `@charset`, `@layer` (rule two), `@property`, `@page`
 *   and whatever the next spec adds are refused without a clause each. The
 *   name is unescaped and lowercased before it is matched, because `@IMPORT`,
 *   `@\69 mport` and `@import` are one keyword to a browser and were three to
 *   the regex this replaces.
 * - **`url()` anywhere** — as a node, as a `url(` function, and the other
 *   functions that name something to fetch: `src()`, `image()`, `image-set()`
 *   (which takes bare strings, so a scan for `url(` never sees it),
 *   `cross-fade()`, `element()`, `paint()`. In every property, in a custom
 *   property's value, and in an at-rule's prelude. Rule three: the wall
 *   fetches nothing but its own calendar, and a beacon pasted from a forum is
 *   a tracking pixel with the household's address on it, refreshed every
 *   fifteen seconds for months. The display's Content-Security-Policy is the
 *   second mechanism for the same rule, and this one is what keeps it from
 *   being the only one.
 * - **`transition*`, `animation*`, `view-transition-name`, `scroll-behavior`,
 *   and `@keyframes` in any vendor spelling** — nothing on a wall moves: it
 *   has no pointer, redraws every fifteen seconds, and on e-paper cannot
 *   animate at all (`apps/display/test/motion.test.ts` is the same rule for
 *   the wall's own stylesheet).
 * - **`position: fixed | sticky`** — either pins something over the whole
 *   wall, outside the box the block is scoped to, on a screen nobody can fix
 *   from the kitchen (rule nine). `position` may be `static`, `relative` or
 *   `absolute`, written out: not `var()`, not a fallback, not an escape.
 * - **`!important`** — the rules here are inserted after the wall's own, so
 *   at equal specificity they already win; `!important` would let one line
 *   beat the theme's inline tokens and the density tiers' own writes.
 * - **A selector that names something outside the box** — `html`, `body`,
 *   `:root`, `:host`, `#wall`, `.screen*`, `.canvas`, `.banner*`, `.alert*`,
 *   `.pair-*`, `.message`, `.pairing` — anywhere in the selector, `:not()`
 *   and friends included. **None of these could match through the scope
 *   anyway: CSS has no combinator that climbs.** Descendant, child, next- and
 *   subsequent-sibling all select *forward* from the scope, and `:has()` is
 *   refused with them (rule two). So the refusal is a courtesy rather than
 *   the fence — a selector naming the chrome is a mistake, and "this reaches
 *   outside the widget" is a better answer than a rule that silently matches
 *   nothing.
 * - **Nesting** — `&`, a rule inside a rule, an at-rule inside a rule. A
 *   nested `&` can put an *ancestor* in front of the scope (`.canvas & {}`
 *   resolves to `.canvas <scope>`), which is the one spelling that would
 *   climb; and nesting is newer than the browsers rule two keeps, so half the
 *   walls would drop it unread. Write the whole selector out.
 * - **Anything the parser could not read** — a parse error, or a leftover the
 *   parser had to skip. css-tree is tolerant by design and hands back `Raw`
 *   nodes for what it could not parse; a block with one of those in it is a
 *   block the wall would read differently from how it was written.
 * - **More than 8 KB.** A bound on what a manifest carries per widget, and
 *   on what somebody can paste without reading.
 *
 * ## Custom properties — decided, and why
 *
 * A block **may define** a custom property (`--accent: #f00` on a cell), because
 * that is how a household retunes a token the wall's own rules already read —
 * the same lever the style lane pulls, one selector deeper. A block **may
 * read** the wall's own tokens through `var()`. What it may not do is read
 * back a property it defined itself: `.a { --p: fixed } .b { position: var(--p) }`
 * assembles a value at one site and uses it at another, and this sanitiser
 * checks values where they are *used*. Three rules close that, and each is a
 * row in the table:
 *
 *  1. `position` takes a bare keyword only — no `var()`, so no indirection
 *     reaches it whatever the property held.
 *  2. `var(--x)` is refused anywhere when `--x` is defined anywhere in the
 *     same block. Reading the wall's tokens is fine; reading your own is not,
 *     because the wall's are validated data and yours are the thing under
 *     review.
 *  3. A custom property's value may not carry `fixed` or `sticky` as an
 *     identifier at all. Today no rule in `display.css` reads a custom
 *     property into `position`, so this closes a door that is not open; it is
 *     here because the stylesheet is rewritten most releases and this file
 *     cannot see it.
 *
 * Everything else about a custom property's value — `url()`, functions,
 * `!important` — is checked exactly as any other value is.
 *
 * ## Scoping without moving the cascade
 *
 * Every complex selector in every rule — inside `@media` and the other two
 * as well — is rewritten under the box's own selector: `.canvas` for the wall's
 * block, `[data-widget-id="…"]` for a widget's (the attribute `renderFreeform`
 * already writes on every `.fw`). Two forms are emitted for each, joined by a
 * comma:
 *
 *   .fw-clock .clock  →  [data-widget-id="w1"] .fw-clock .clock,
 *                        [data-widget-id="w1"].fw-clock .clock
 *
 * The descendant form reaches everything inside the box; the self form
 * compounds the scope into the selector's *first* compound (after a leading
 * type selector, so `div.x` becomes `div[…].x` and stays valid), which is what
 * lets `.fw-clock { border: … }` — the selector a household reads straight off
 * the wall's markup — reach the box it names rather than silently matching
 * nothing. Both forms add exactly one attribute (or one class) of specificity,
 * to every selector alike, so the order the household's own rules win in is the
 * order they wrote: the `preview-css.ts` argument, where `:root` became
 * `.preview-wall` at the same (0,1,0) precisely so nothing changed which rule
 * wins. Against the wall's own stylesheet the block comes *after* it, which is
 * the whole of how it is meant to override, and the one attribute it gains is
 * the price of being scoped at all.
 *
 * What the scope is not: a shadow root. RFC 014 §7 says why — it would reshape
 * the renderer's DOM and every measurement taken across it — and this is the
 * parser the RFC named as the alternative.
 */

/** The most one block may be, in bytes of UTF-8. */
export const CUSTOM_CSS_MAX_BYTES = 8 * 1024;

/** The wall's block is scoped to the canvas; a widget's to its own box. */
export type CssScope = { readonly kind: 'wall' } | { readonly kind: 'widget'; readonly id: string };

/** The attribute `renderFreeform` writes on every box, and the selector reads. */
export const WIDGET_SCOPE_ATTRIBUTE = 'data-widget-id';
/** The class the wall's block is scoped under. */
export const WALL_SCOPE_CLASS = 'canvas';

export type CustomCssOutcome =
  | {
      readonly ok: true;
      /** The scoped, compact text the manifest carries. Empty for an empty block. */
      readonly css: string;
      /** How many style rules survived — the page says so beside the field. */
      readonly rules: number;
    }
  | {
      readonly ok: false;
      /** 1-based, in the household's own text. */
      readonly line: number;
      readonly column: number;
      /** Written for somebody standing at a settings screen, not for a log. */
      readonly reason: string;
    };

/**
 * The verbatim sentence the editor states beside the textarea, and the panel's
 * honours table states beside the key (RFC 014 §7, precondition 3). One
 * constant, because three copies of a promise are three chances to soften it.
 */
export const CUSTOM_CSS_PROMISE =
  "Class names may change between releases; a panel ignores this; the wall's own rules about motion and size are not enforced here.";

/** The conditional group rules a block may carry; every other at-rule is refused. */
const ALLOWED_AT_RULES: ReadonlySet<string> = new Set(['media', 'supports', 'container']);

/** Functions whose whole job is to name something to fetch. */
const FETCHING_FUNCTIONS: ReadonlySet<string> = new Set([
  'url',
  'src',
  'image',
  'image-set',
  'cross-fade',
  'element',
  'paint',
]);

/** The only values `position` may take here, written out. */
const ALLOWED_POSITIONS: ReadonlySet<string> = new Set([
  'static',
  'relative',
  'absolute',
  'initial',
  'inherit',
  'unset',
  'revert',
]);

/** The two `position` values that leave the box. */
const PINNING_POSITIONS: ReadonlySet<string> = new Set(['fixed', 'sticky']);

/** Chrome the wall draws outside any canvas, by class prefix and by exact name. */
const OUTSIDE_CLASS_PREFIXES: readonly string[] = ['screen', 'banner', 'alert', 'pair-'];
const OUTSIDE_CLASSES: ReadonlySet<string> = new Set(['canvas', 'message', 'pairing']);
const OUTSIDE_TYPES: ReadonlySet<string> = new Set(['html', 'body']);
const OUTSIDE_PSEUDO_CLASSES: ReadonlySet<string> = new Set(['root', 'host', 'host-context', 'has']);
const OUTSIDE_IDS: ReadonlySet<string> = new Set(['wall']);

class Refused extends Error {
  constructor(
    readonly line: number,
    readonly column: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

function refuse(node: { readonly loc?: csstree.CssLocation | null | undefined } | undefined, reason: string): never {
  throw new Refused(node?.loc?.start.line ?? 1, node?.loc?.start.column ?? 1, reason);
}

/** A name as a browser reads it: escapes resolved, case folded. */
function plainName(raw: string): string {
  return csstree.ident.decode(raw).toLowerCase();
}

/** Twelve characters of what could not be read, on one line. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 24 ? `${flat.slice(0, 24)}…` : flat;
}

/**
 * Read a block, refuse what has to be refused, and scope what is left.
 *
 * The first refusal wins: a block with three faults gets the first one named,
 * fixes it, and gets the next — which is how a compiler reports too, and is
 * far better than three sentences beside one field.
 */
export function sanitiseCustomCss(source: string, scope: CssScope): CustomCssOutcome {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > CUSTOM_CSS_MAX_BYTES) {
    return {
      ok: false,
      line: 1,
      column: 1,
      reason: `This is ${(bytes / 1024).toFixed(1)} KB and the limit is 8 KB. Trim it, or move part of it to a widget's own CSS.`,
    };
  }
  if (source.trim() === '') return { ok: true, css: '', rules: 0 };

  try {
    const ast = parseWhole(source);
    const defined = customPropertiesDefined(ast);
    const scopeNode = (): CssNodePlain => scopeSelectorNode(scope);
    let rules = 0;
    const walkChildren = (children: List<CssNode>, insideRule: boolean): void => {
      for (const child of children.toArray()) {
        switch (child.type) {
          case 'Rule':
            if (insideRule) refuse(child, 'Nesting is not allowed here. Write the whole selector out instead.');
            checkRule(child, scope, defined);
            child.prelude = scopeSelectors(child.prelude as SelectorList, scopeNode);
            walkChildren(child.block.children, true);
            rules++;
            break;
          case 'Atrule': {
            if (insideRule) refuse(child, 'Nesting is not allowed here. Write the whole selector out instead.');
            checkAtrule(child, defined);
            if (child.block !== null) walkChildren(child.block.children, false);
            break;
          }
          case 'Declaration':
            if (!insideRule) refuse(child, 'A declaration needs a selector. Put it inside a rule.');
            checkDeclaration(child, defined);
            break;
          case 'Raw':
            if (child.value.trim() !== '') {
              refuse(child, `Could not read this part: ${snippet(child.value)}.`);
            }
            break;
          default:
            refuse(child, `Could not read this part: ${snippet(csstree.generate(child))}.`);
        }
      }
    };
    walkChildren((ast as csstree.StyleSheet).children, false);
    return { ok: true, css: csstree.generate(ast), rules };
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, line: error.line, column: error.column, reason: error.reason };
    }
    // css-tree throws only on its own bugs; a block must never take the
    // request down with it (rule nine, one layer out).
    return { ok: false, line: 1, column: 1, reason: 'Could not read this at all.' };
  }
}

/** The sentence a settings page puts beside the field. */
export function refusalSentence(outcome: Extract<CustomCssOutcome, { ok: false }>): string {
  return `Line ${outcome.line}: ${outcome.reason}`;
}

/**
 * Parse tolerantly, then refuse the first thing the parser had to skip.
 *
 * css-tree records a parse error and carries on with a `Raw` node in place of
 * what it could not read, which is right for a linter and wrong here: a block
 * the wall would read differently from how it was written is a block that
 * should not be saved.
 */
function parseWhole(source: string): CssNode {
  const errors: { readonly message: string; readonly line: number; readonly column: number }[] = [];
  const ast = csstree.parse(source, {
    positions: true,
    parseCustomProperty: true,
    onParseError: (error) => {
      errors.push({ message: error.message, line: error.line, column: error.column });
    },
  });
  const first = errors[0];
  if (first !== undefined) {
    throw new Refused(first.line, first.column, `Could not read this: ${first.message}.`);
  }
  return ast;
}

/** Every custom property the block defines, anywhere in it, unescaped. */
function customPropertiesDefined(ast: CssNode): ReadonlySet<string> {
  const names = new Set<string>();
  csstree.walk(ast, (node) => {
    if (node.type === 'Declaration') {
      const name = csstree.ident.decode(node.property);
      if (name.startsWith('--')) names.add(name.toLowerCase());
    }
  });
  return names;
}

function checkAtrule(atrule: csstree.Atrule, defined: ReadonlySet<string>): void {
  const name = plainName(atrule.name);
  if (name === 'import') {
    refuse(atrule, '@import is not allowed here: the wall loads nothing from anywhere but its own server.');
  }
  if (name === 'font-face') {
    refuse(atrule, '@font-face is not allowed here: every face the wall draws ships with it.');
  }
  if (name.endsWith('keyframes')) {
    refuse(atrule, `@${name} is not allowed here: nothing on a wall moves.`);
  }
  if (!ALLOWED_AT_RULES.has(name)) {
    refuse(atrule, `@${name} is not allowed here. Only @media, @supports and @container are.`);
  }
  if (atrule.prelude !== null) {
    if (atrule.prelude.type === 'Raw') {
      refuse(atrule, `Could not read this part: ${snippet(atrule.prelude.value)}.`);
    }
    checkValueNodes(atrule.prelude, defined, undefined);
  }
  if (atrule.block === null) {
    refuse(atrule, `@${name} needs a block of rules after it.`);
  }
}

function checkRule(rule: Rule, scope: CssScope, _defined: ReadonlySet<string>): void {
  if (rule.prelude.type === 'Raw') {
    refuse(rule, `Could not read this selector: ${snippet(rule.prelude.value)}.`);
  }
  const noun = scope.kind === 'wall' ? 'the layout' : 'the widget';
  for (const selector of rule.prelude.children.toArray()) {
    if (selector.type !== 'Selector') {
      refuse(selector, `Could not read this selector: ${snippet(csstree.generate(selector))}.`);
    }
    const first = selector.children.first;
    if (first !== null && first.type === 'Combinator') {
      refuse(
        selector,
        `A selector cannot start with "${first.name.trim() || ' '}" here. Write the whole selector out instead.`,
      );
    }
    csstree.walk(selector, (node) => {
      switch (node.type) {
        case 'NestingSelector':
          refuse(node, 'Nesting is not allowed here. Write the whole selector out instead.');
          break;
        case 'TypeSelector': {
          const name = plainName(node.name);
          if (OUTSIDE_TYPES.has(name)) refuse(node, outside(name, noun));
          break;
        }
        case 'PseudoClassSelector': {
          const name = plainName(node.name);
          if (OUTSIDE_PSEUDO_CLASSES.has(name)) refuse(node, outside(`:${name}`, noun));
          break;
        }
        case 'ClassSelector': {
          const name = plainName(node.name);
          if (OUTSIDE_CLASSES.has(name) || OUTSIDE_CLASS_PREFIXES.some((prefix) => name.startsWith(prefix))) {
            refuse(node, outside(`.${name}`, noun));
          }
          break;
        }
        case 'IdSelector': {
          const name = plainName(node.name);
          if (OUTSIDE_IDS.has(name)) refuse(node, outside(`#${name}`, noun));
          break;
        }
        default:
          break;
      }
    });
  }
}

function outside(what: string, noun: string): string {
  return `"${what}" reaches outside ${noun}. Everything here already applies inside it, so write the selector from there.`;
}

function checkDeclaration(declaration: Declaration, defined: ReadonlySet<string>): void {
  if (declaration.important !== false) {
    refuse(
      declaration,
      "!important is not allowed here. These rules already come after the wall's own, so they win without it.",
    );
  }
  const name = csstree.ident.decode(declaration.property).toLowerCase();
  const custom = name.startsWith('--');
  const info = custom ? undefined : csstree.property(name);
  const basename = info?.basename ?? name;

  if (!custom) {
    if (
      basename.startsWith('transition') ||
      basename.startsWith('animation') ||
      basename === 'view-transition-name' ||
      basename === 'scroll-behavior'
    ) {
      refuse(
        declaration,
        `${name} is not allowed here: nothing on a wall moves — it redraws every fifteen seconds, and a panel cannot animate at all.`,
      );
    }
    if (basename === 'behavior' || basename === 'binding') {
      refuse(declaration, `${name} is not allowed here: it loads something from somewhere else.`);
    }
  }

  if (declaration.value.type === 'Raw') {
    refuse(declaration, `Could not read the value of ${name}: ${snippet(declaration.value.value)}.`);
  }

  if (!custom && basename === 'position') {
    const parts = declaration.value.children.toArray();
    const only = parts.length === 1 ? parts[0] : undefined;
    const keyword = only !== undefined && only.type === 'Identifier' ? plainName(only.name) : undefined;
    if (keyword !== undefined && PINNING_POSITIONS.has(keyword)) {
      refuse(
        declaration,
        `position: ${keyword} is not allowed here: it would pin something over the whole wall, outside its box. Use absolute inside the box instead.`,
      );
    }
    if (keyword === undefined || !ALLOWED_POSITIONS.has(keyword)) {
      refuse(
        declaration,
        `position takes static, relative or absolute here, written out — not "${snippet(csstree.generate(declaration.value))}".`,
      );
    }
  }

  checkValueNodes(declaration.value, defined, custom ? name : undefined);
}

/**
 * The value-level rules, applied to every node under a value or a prelude.
 *
 * `customProperty` is the name being defined when this value is a custom
 * property's, for the one rule that applies only there.
 */
function checkValueNodes(value: CssNode, defined: ReadonlySet<string>, customProperty: string | undefined): void {
  csstree.walk(value, (node) => {
    switch (node.type) {
      case 'Url':
        refuse(node, 'url() is not allowed here: the wall fetches nothing but its own calendar.');
        break;
      case 'Function': {
        const name = plainName(node.name);
        const bare = name.replace(/^-[a-z]+-/, '');
        if (FETCHING_FUNCTIONS.has(bare)) {
          refuse(node, `${name}() is not allowed here: it names something to fetch.`);
        }
        if (bare === 'var') {
          const first = node.children.first;
          const read = first !== null && first.type === 'Identifier' ? plainName(first.name) : undefined;
          if (read !== undefined && defined.has(read)) {
            refuse(
              node,
              `var(${read}) reads a value this CSS sets itself, so it cannot be checked where it is used. Write the value in directly.`,
            );
          }
        }
        break;
      }
      case 'Identifier': {
        if (customProperty !== undefined) {
          const word = plainName(node.name);
          if (PINNING_POSITIONS.has(word)) {
            refuse(
              node,
              `${customProperty} carries "${word}", which a rule could read as a position. Set position where it is used instead.`,
            );
          }
        }
        break;
      }
      default:
        break;
    }
  });
}

/** The scope as a selector node — an attribute selector, or the canvas class. */
function scopeSelectorNode(scope: CssScope): CssNodePlain {
  if (scope.kind === 'wall') return { type: 'ClassSelector', name: WALL_SCOPE_CLASS };
  return {
    type: 'AttributeSelector',
    name: { type: 'Identifier', name: WIDGET_SCOPE_ATTRIBUTE },
    matcher: '=',
    // A String node, so `generate` escapes whatever the id holds — the
    // schema allows any 64 characters, and an id is never built into text.
    value: { type: 'String', value: scope.id },
    flags: null,
  };
}

/**
 * Both forms of every selector in the list, under the scope. See the module
 * note for why two, and why the specificity added is the same for each.
 */
function scopeSelectors(list: SelectorList, scopeNode: () => CssNodePlain): SelectorList {
  const out: CssNodePlain[] = [];
  for (const selector of list.children.toArray()) {
    const plain = csstree.toPlainObject(selector) as csstree.SelectorPlain;
    const parts = plain.children;
    out.push({
      type: 'Selector',
      children: [scopeNode(), { type: 'Combinator', name: ' ' }, ...parts],
    });
    const firstCombinator = parts.findIndex((part) => part.type === 'Combinator');
    const compound = firstCombinator === -1 ? parts : parts.slice(0, firstCombinator);
    const rest = firstCombinator === -1 ? [] : parts.slice(firstCombinator);
    // After a leading type selector, which has to come first in a compound.
    const at = compound[0]?.type === 'TypeSelector' ? 1 : 0;
    out.push({
      type: 'Selector',
      children: [...compound.slice(0, at), scopeNode(), ...compound.slice(at), ...rest],
    });
  }
  return csstree.fromPlainObject({ type: 'SelectorList', children: out }) as SelectorList;
}

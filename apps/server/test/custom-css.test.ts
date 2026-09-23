import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CSS_MAX_BYTES,
  CUSTOM_CSS_PROMISE,
  refusalSentence,
  sanitiseCustomCss,
  type CssScope,
} from '../src/api/custom-css.js';

/**
 * The household CSS sanitiser, enumerated (RFC 014 §7, precondition 2).
 *
 * In the shape of `sign-in-next.test.ts`'s table against `safeNextPath`: every
 * bypass is a row — the string a household (or a forum post) could paste, and
 * the reason it must be refused — so the whole policy is one table somebody
 * can read down, and adding a bypass is one line rather than a copied block.
 *
 * **Every row asserts `ok === false`.** That is the property the module is
 * built on: it refuses and never strips. A sanitiser that quietly removed the
 * `@import` and saved the rest would answer `ok: true` on every one of these
 * and turn the whole table red — which is the mutation this file exists to
 * catch, and was checked by making it (see the module's own docstring).
 */

const WIDGET: CssScope = { kind: 'widget', id: 'w1' };
const WALL: CssScope = { kind: 'wall' };

/** What a paste could carry, and the words the refusal has to say. */
const REFUSED: ReadonlyArray<readonly [string, string, RegExp]> = [
  // ---- @import, in every spelling the parser reads as one and the one it does not
  ['@import with a url()', '@import url("https://evil.example/x.css");', /@import/],
  ['@import with a bare string', '@import "https://evil.example/x.css";', /@import/],
  ['@import in capitals', '@IMPORT url(x.css);', /@import/],
  ['@import with an escaped letter', '@\\69 mport "x";', /@import/],
  ['@import with a layer', '@import url(x.css) layer(base);', /@import/],
  // A comment inside the keyword is not an @import to a browser either — it is
  // an at-rule called `@im` — and it is refused as the stranger it is, which is
  // what an allowlist buys over a list of the bad ones.
  ['a comment splitting the keyword', '@im/**/port "x";', /@im is not allowed/],
  ['@import inside @media', '@media (min-width: 1px) { @import "x"; }', /@import/],
  // ---- the other at-rules
  ['@font-face', '@font-face { font-family: X; src: url(x.woff2) }', /@font-face/],
  ['@keyframes', '@keyframes k { from { opacity: 0 } to { opacity: 1 } }', /keyframes/],
  ['vendor-prefixed keyframes', '@-webkit-keyframes k { from { opacity: 0 } }', /keyframes/],
  ['@namespace', '@namespace svg url(http://www.w3.org/2000/svg);', /@namespace/],
  ['@charset', '@charset "utf-8";', /@charset/],
  ['@layer (rule two)', '@layer base { .a { color: red } }', /@layer/],
  ['@property', '@property --x { syntax: "*"; inherits: false }', /@property/],
  ['@page', '@page { margin: 0 }', /@page/],
  ['@scope', '@scope (.a) { .b { color: red } }', /@scope/],
  ['@media with no block', '@media (x);', /needs a block/],
  // ---- url() and its cousins, in every property
  ['url() in background', '.a { background: url(https://evil.example/x.png) }', /url\(\)/],
  ['url() quoted', '.a { background: url("https://evil.example/x.png") }', /url\(\)/],
  ['url() in background-image', '.a { background-image: url(x.png) }', /url\(\)/],
  ['image-set() with bare strings', '.a { background-image: image-set("a.png" 1x, "b.png" 2x) }', /image-set\(\)/],
  ['image-set() with a url()', '.a { background-image: image-set(url(a.png) 1x) }', /image-set\(\)|url\(\)/],
  ['vendor-prefixed image-set()', '.a { background-image: -webkit-image-set("a.png" 1x) }', /image-set\(\)/],
  ['url() in cursor', '.a { cursor: url(a.cur), auto }', /url\(\)/],
  ['url() in mask', '.a { mask: url(#m) }', /url\(\)/],
  ['url() in a vendor-prefixed mask', '.a { -webkit-mask-image: url(m.svg) }', /url\(\)/],
  ['url() in list-style', '.a { list-style: url(b.png) }', /url\(\)/],
  ['url() in list-style-image', '.a { list-style-image: url(b.png) }', /url\(\)/],
  ['url() in content', '.a::before { content: url(x.png) }', /url\(\)/],
  ['url() in filter', '.a { filter: url(#f) }', /url\(\)/],
  ['url() in border-image', '.a { border-image: url(b.png) 30 }', /url\(\)/],
  ['url() in a custom property', '.a { --pic: url(x.png) }', /url\(\)/],
  ['url() in a @supports prelude', '@supports (background: url(x.png)) { .a { color: red } }', /url\(\)/],
  ['src()', '.a { background: src("x.png") }', /src\(\)/],
  ['image()', '.a { background: image("x.png") }', /image\(\)/],
  ['cross-fade()', '.a { background: cross-fade(url(a.png), url(b.png)) }', /cross-fade\(\)|url\(\)/],
  ['element()', '.a { background: -moz-element(#x) }', /element\(\)/],
  ['paint()', '.a { background: paint(x) }', /paint\(\)/],
  ['behavior', '.a { behavior: url(x.htc) }', /behavior|url\(\)/],
  ['-moz-binding', '.a { -moz-binding: url(x.xml#y) }', /binding|url\(\)/],
  // ---- motion
  ['transition', '.a { transition: all 1s }', /transition/],
  ['transition-property', '.a { transition-property: opacity }', /transition-property/],
  ['vendor-prefixed transition', '.a { -webkit-transition: opacity 1s }', /transition/],
  ['animation', '.a { animation: k 1s }', /animation/],
  ['animation-name', '.a { animation-name: k }', /animation-name/],
  ['scroll-behavior', '.a { scroll-behavior: smooth }', /scroll-behavior/],
  ['view-transition-name', '.a { view-transition-name: x }', /view-transition-name/],
  // ---- position, in every spelling, and through every indirection
  ['position: fixed', '.a { position: fixed }', /position: fixed/],
  ['position: sticky', '.a { position: sticky }', /position: sticky/],
  ['position: FIXED', '.a { position: FIXED }', /position: fixed/],
  ['position with an escaped letter', '.a { position: \\66 ixed }', /position: fixed/],
  ['position through a custom property the block defines', '.a { --p: fixed } .b { position: var(--p) }', /position takes|carries "fixed"/],
  ['position through a var() fallback', '.a { position: var(--nothing, fixed) }', /position takes/],
  ['position through a wall token', '.a { position: var(--bg) }', /position takes/],
  ['a custom property carrying fixed', '.a { --p: fixed }', /carries "fixed"/],
  ['a custom property carrying sticky, in capitals', '.a { --p: STICKY }', /carries "sticky"/],
  ['a var() of a property the block itself defines', '.a { --p: red } .b { color: var(--p) }', /var\(--p\) reads a value this CSS sets itself/],
  ['a var() of a property the block defines later', '.b { color: var(--p) } .a { --p: red }', /var\(--p\)/],
  // ---- !important
  ['!important', '.a { color: red !important }', /!important/],
  ['!important in capitals', '.a { color: red !IMPORTANT }', /!important/],
  ['!important with a space', '.a { color: red ! important }', /!important/],
  // ---- selectors that reach outside the box
  ['body', 'body { display: none }', /"body" reaches outside/],
  ['html', 'html { font-size: 0 }', /"html" reaches outside/],
  ['BODY, in capitals', 'BODY { display: none }', /"body" reaches outside/],
  ['body, escaped', '\\62 ody { display: none }', /"body" reaches outside/],
  [':root', ':root { --bg: red }', /":root" reaches outside/],
  [':host', ':host { display: none }', /":host" reaches outside/],
  [':has()', '.x:has(.y) { display: none }', /":has" reaches outside/],
  ['#wall', '#wall { display: none }', /"#wall" reaches outside/],
  ['.screen', '.screen { display: none }', /"\.screen" reaches outside/],
  ['.screen-message', '.screen-message { display: none }', /"\.screen-message" reaches outside/],
  ['.canvas', '.canvas { display: none }', /"\.canvas" reaches outside/],
  ['.banners', '.banners { display: none }', /"\.banners" reaches outside/],
  ['.banner-warn', '.banner-warn { display: none }', /"\.banner-warn" reaches outside/],
  ['.alert', '.alert { display: none }', /"\.alert" reaches outside/],
  ['.alert-foot', '.alert-foot { display: none }', /"\.alert-foot" reaches outside/],
  ['.pair-form', '.pair-form { display: none }', /"\.pair-form" reaches outside/],
  ['.pairing', '.pairing { display: none }', /"\.pairing" reaches outside/],
  ['.message', '.message { display: none }', /"\.message" reaches outside/],
  // A comma is how a selector list escapes a scan of the first selector; the
  // list is parsed, so the second member is refused like the first.
  ['a selector escaping through a comma', '.fw, body { display: none }', /"body" reaches outside/],
  ['a selector escaping through a comma with no space', '.fw,body { display: none }', /"body" reaches outside/],
  ['an outside name inside :not()', '.x:not(.canvas) { color: red }', /"\.canvas" reaches outside/],
  ['an outside name inside :is()', '.x:is(body, .y) { color: red }', /"body" reaches outside/],
  ['an outside name as an ancestor', '.canvas .fw { color: red }', /"\.canvas" reaches outside/],
  ['an outside name inside @media', '@media (x) { body { display: none } }', /"body" reaches outside/],
  // ---- nesting, which is the one spelling that could climb
  ['a nesting selector', '& .fw { color: red }', /Nesting is not allowed/],
  ['a nested rule', '.fw { .x { color: red } }', /Nesting|Could not read/],
  ['a nested rule with &', '.fw { &:hover { color: red } }', /Nesting is not allowed/],
  ['a nested at-rule', '.fw { @media (x) { color: red } }', /Nesting is not allowed/],
  ['an ancestor placed in front of the scope', '.canvas & { color: red }', /reaches outside|Nesting/],
  ['a leading combinator', '> .x { color: red }', /cannot start with/],
  // ---- escapes and strings, which fool a scan and not a parser
  ['an escaped brace hiding a second rule', '.a\\{ { color: red } body { color: red }', /"body" reaches outside/],
  ['a brace inside a string hiding a second rule', '.a { content: "}" } body { color: red }', /"body" reaches outside/],
  ['a brace inside a string hiding an @import', '.a { content: "}" } @import "x";', /@import/],
  // ---- what the parser could not read
  ['stray closing braces', '}}', /Could not read/],
  ['a declaration with no colon', 'a { b }', /Could not read/],
  ['a declaration outside any rule', 'color: red;', /Could not read|needs a selector/],
  ['a vendor-prefixed url() property', '.a { -webkit-mask: url(m.svg) }', /url\(\)/],
];

describe('sanitiseCustomCss refuses, and never strips', () => {
  for (const [what, css, reason] of REFUSED) {
    it(`refuses ${what}`, () => {
      const outcome = sanitiseCustomCss(css, WIDGET);
      expect(outcome.ok, `accepted: ${css}\n  as: ${outcome.ok ? outcome.css : ''}`).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason, css).toMatch(reason);
      expect(outcome.line).toBeGreaterThanOrEqual(1);
    });
  }

  it('refuses the same rows for the wall’s own block', () => {
    for (const [, css] of REFUSED) {
      expect(sanitiseCustomCss(css, WALL).ok, css).toBe(false);
    }
  });

  it('refuses a block over 8 KB, and says so in kilobytes', () => {
    const big = `.a{color:red}${' '.repeat(CUSTOM_CSS_MAX_BYTES)}`;
    const outcome = sanitiseCustomCss(big, WIDGET);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/limit is 8 KB/);
    // And measured in bytes, not characters: a multi-byte character counts.
    const wide = `.a{content:"${'é'.repeat(CUSTOM_CSS_MAX_BYTES / 2)}"}`;
    expect(sanitiseCustomCss(wide, WIDGET).ok).toBe(false);
  });

  it('names the line the fault is on, in the household’s own text', () => {
    const outcome = sanitiseCustomCss('.a { color: red }\n.b {\n  position: fixed;\n}', WIDGET);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.line).toBe(3);
    expect(refusalSentence(outcome)).toMatch(/^Line 3: position: fixed/);
  });

  it('names the first fault only, so one fix leads to the next', () => {
    const outcome = sanitiseCustomCss('.a { position: fixed }\n@import "x";', WIDGET);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.line).toBe(1);
  });
});

/** What a household actually writes, and what the wall is handed. */
const KEPT: ReadonlyArray<readonly [string, string, CssScope, string]> = [
  [
    'a descendant selector, in both forms',
    '.fw-clock .clock { color: #fff }',
    WIDGET,
    '[data-widget-id="w1"] .fw-clock .clock,[data-widget-id="w1"].fw-clock .clock{color:#fff}',
  ],
  [
    'a type selector, which stays first in its compound',
    'div.x > .y { color: red }',
    WIDGET,
    '[data-widget-id="w1"] div.x>.y,div[data-widget-id="w1"].x>.y{color:red}',
  ],
  ['the universal selector', '* { margin: 0 }', WIDGET, '[data-widget-id="w1"] *,*[data-widget-id="w1"]{margin:0}'],
  [
    'a pseudo-element alone',
    '::before { content: "" }',
    WIDGET,
    '[data-widget-id="w1"] ::before,[data-widget-id="w1"]::before{content:""}',
  ],
  [
    'a selector list, every member scoped',
    '.a, .b { color: red }',
    WIDGET,
    '[data-widget-id="w1"] .a,[data-widget-id="w1"].a,[data-widget-id="w1"] .b,[data-widget-id="w1"].b{color:red}',
  ],
  [
    'a rule inside @media',
    '@media (min-width: 1px) { .a { color: red } }',
    WIDGET,
    '@media (min-width:1px){[data-widget-id="w1"] .a,[data-widget-id="w1"].a{color:red}}',
  ],
  ['the wall’s block, under the canvas', '.fw { padding: 0 }', WALL, '.canvas .fw,.canvas.fw{padding:0}'],
  ['position: absolute', '.a { position: absolute; top: 0 }', WIDGET, '{position:absolute;top:0}'],
  ['position: relative', '.a { position: relative }', WIDGET, '{position:relative}'],
  ['display: none', '.fw-content { display: none }', WIDGET, '{display:none}'],
  ['a transform, which the promise says is the household’s own risk', '.a { transform: scale(1.2) }', WIDGET, '{transform:scale(1.2)}'],
  [
    'a custom property set, and a wall token read',
    '.a { --accent: #f00; color: var(--bg) }',
    WIDGET,
    '{--accent:#f00;color:var(--bg)}',
  ],
  ['a var() with a fallback that is not a position', '.a { color: var(--nothing, red) }', WIDGET, '{color:var(--nothing,red)}'],
  ['a comment, dropped', '/* the clock */ .a { color: red }', WIDGET, '[data-widget-id="w1"] .a,[data-widget-id="w1"].a{color:red}'],
  ['an unclosed last rule, which the parser closes', '.a { color: red', WIDGET, '{color:red}'],
  ['an attribute selector of its own', '.a[data-count="3"] { color: red }', WIDGET, '.a[data-count="3"]'],
  ['a container query (rule two, amended)', '@container (min-width: 10ch) { .a { color: red } }', WIDGET, '@container (min-width:10ch){[data-widget-id="w1"] .a'],
  ['a :not() naming something inside', '.a:not(.b) { color: red }', WIDGET, '.a:not(.b)'],
];

describe('sanitiseCustomCss keeps what a household writes, scoped', () => {
  for (const [what, css, scope, expected] of KEPT) {
    it(`keeps ${what}`, () => {
      const outcome = sanitiseCustomCss(css, scope);
      expect(outcome.ok, `refused: ${outcome.ok ? '' : outcome.reason}`).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.css).toContain(expected);
    });
  }

  it('emits two selectors for every one written, and never fewer', () => {
    const outcome = sanitiseCustomCss('.a, .b .c, .d > .e { color: red }', WIDGET);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css.split(',').length).toBe(6);
    expect(outcome.rules).toBe(1);
  });

  it('escapes the id inside the attribute selector, whatever it holds', () => {
    const outcome = sanitiseCustomCss('.a { color: red }', { kind: 'widget', id: 'w"1\\x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.css.startsWith('[data-widget-id="w\\"1\\\\x"]')).toBe(true);
  });

  it('answers an empty block as no CSS at all', () => {
    expect(sanitiseCustomCss('', WIDGET)).toEqual({ ok: true, css: '', rules: 0 });
    expect(sanitiseCustomCss('   \n\t', WALL)).toEqual({ ok: true, css: '', rules: 0 });
    expect(sanitiseCustomCss('/* only a comment */', WALL)).toEqual({ ok: true, css: '', rules: 0 });
  });

  it('counts the rules it kept, inside @media as well', () => {
    const outcome = sanitiseCustomCss('.a{color:red} @media (x){ .b{color:red} .c{color:red} }', WIDGET);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rules).toBe(3);
  });

  it('is the promise the editor and the panel state, word for word', () => {
    expect(CUSTOM_CSS_PROMISE).toBe(
      "Class names may change between releases; a panel ignores this; the wall's own rules about motion and size are not enforced here.",
    );
  });
});

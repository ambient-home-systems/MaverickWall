/**
 * Bundled emoji artwork, drawn as `<img>` and never as text (D6, plan item
 * P4.2).
 *
 * `emojiNode` is the one seam every designed wall style will draw an emoji
 * through — no style consumes it yet (P5.1 and P5.2 are later sessions), so
 * this is the mechanism itself under test rather than a widget. That is
 * deliberate: two renderers holding one rule is this project's most repeated
 * bug, and the cure each time has been to resolve a decision once and prove
 * the resolution, before anything downstream can quietly resolve it a second
 * way.
 *
 * `no-emoji.test.ts` used to be the proof, by scanning source text for a code
 * point. That is the wrong kind of test for a rule that is now about what a
 * *browser* does with a key, not about what a file contains — measure the
 * computed value, never the class name — so this is a real paired wall in a
 * real browser: the module is imported the way the display bundle itself
 * would import it, the node it builds is appended to the live document, and
 * what is asserted is what actually reached the DOM and the network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEARDOWN,
  HOUSEHOLD_CALENDARS,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

const SLOW = 60_000;

let wall: Installation;
let link: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  link = await wall.pairLink('Kitchen');
}, SLOW);

afterAll(async () => {
  await wall?.dispose();
  await shutDownBrowser();
}, TEARDOWN);

describe('emojiNode', () => {
  it(
    'draws a real <img>, same-origin, never a code point in the DOM',
    async () => {
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        // A string rather than a function: this file is itself transformed by
        // Vite before vitest runs it, which rewrites a literal `import(...)`
        // in this file's own source into `__vite_ssr_dynamic_import__(...)` —
        // a helper the browser page has never heard of. A string is opaque to
        // that transform, so the `import()` inside it reaches the browser
        // exactly as written and resolves against `/assets/emoji.js`, the
        // *display* bundle's own compiled output.
        interface Probe {
          readonly ok: boolean;
          readonly tagName?: string;
          readonly src?: string;
          readonly alt?: string;
          readonly className?: string;
          readonly naturalWidth?: number;
          readonly naturalHeight?: number;
          readonly unknownKey?: unknown;
          readonly keyCount?: number;
          readonly hasSun?: boolean;
          readonly hasHourglass?: boolean;
        }
        const result = (await page.evaluate(`
          (async () => {
            const mod = await import('/assets/emoji.js');
            const node = mod.emojiNode('sun', 'probe-emoji');
            if (node === null) return { ok: false };
            document.body.appendChild(node);
            await new Promise((resolve) => {
              if (node.complete) resolve(undefined);
              else node.addEventListener('load', () => resolve(undefined), { once: true });
            });
            return {
              ok: true,
              tagName: node.tagName,
              src: node.src,
              alt: node.alt,
              className: node.className,
              naturalWidth: node.naturalWidth,
              naturalHeight: node.naturalHeight,
              unknownKey: mod.emojiNode('this-key-does-not-exist'),
              keyCount: mod.EMOJI_KEYS.length,
              hasSun: mod.EMOJI_KEYS.includes('sun'),
              hasHourglass: mod.EMOJI_KEYS.includes('hourglass'),
            };
          })()`)) as Probe;

        expect(result.ok).toBe(true);
        // An <img>, not a text node standing in for one.
        expect(result.tagName).toBe('IMG');
        // Same-origin, bundled artwork — the whole of rule three here.
        expect(result.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/assets\/emoji\/sun\.svg$/);
        expect(result.alt).toBe('Sun');
        expect(result.className).toBe('probe-emoji');
        // The network request actually resolved to a real picture rather
        // than a broken reference silently sitting in the DOM.
        expect(result.naturalWidth).toBeGreaterThan(0);
        expect(result.naturalHeight).toBeGreaterThan(0);
        // A key nobody curated draws nothing, the glyphNode rule, rather than
        // a broken image or the raw string reaching the page.
        expect(result.unknownKey).toBeNull();
        expect(result.keyCount).toBeGreaterThanOrEqual(150);
        expect(result.hasSun).toBe(true);
        expect(result.hasHourglass).toBe(true);

        // The one thing a code-point ban was ever checking: that nowhere on
        // the rendered page does an emoji character appear as text. Proven
        // here by reading the live DOM rather than the source that built it.
        const bodyText = await page.evaluate(() => document.body.textContent ?? '');
        expect(bodyText).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is served as SVG, immutably cached, from no directory but its own',
    async () => {
      const { page, close } = await loadWallSettled(link, { width: 1080, height: 1920 });
      try {
        const direct = await page.evaluate(async () => {
          const res = await fetch('/assets/emoji/hourglass.svg');
          return {
            status: res.status,
            contentType: res.headers.get('content-type'),
            cacheControl: res.headers.get('cache-control'),
            bodyStartsWithSvg: (await res.text()).trimStart().startsWith('<svg'),
          };
        });
        expect(direct.status).toBe(200);
        expect(direct.contentType).toMatch(/^image\/svg\+xml/);
        expect(direct.cacheControl).toBe('public, max-age=31536000, immutable');
        expect(direct.bodyStartsWithSvg).toBe(true);

        // The name must be slash-free: a traversal cannot be spelled, and an
        // encoded one is refused by Hono's own routing before it ever reaches
        // this route's handler.
        const traversal = await page.evaluate(async () => {
          const res = await fetch('/assets/emoji/..%2Ffonts%2Froboto.woff2');
          return res.status;
        });
        expect(traversal).not.toBe(200);

        // Served files must be SVG-only — a request for something this
        // directory does not carry, or a non-.svg name, is a 404 rather than
        // whatever `contentTypeFor` would have guessed at.
        const nonSvg = await page.evaluate(async () => {
          const res = await fetch('/assets/emoji/LICENSES.md');
          return res.status;
        });
        expect(nonSvg).toBe(404);

        const missing = await page.evaluate(async () => {
          const res = await fetch('/assets/emoji/not-a-real-key.svg');
          return res.status;
        });
        expect(missing).toBe(404);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

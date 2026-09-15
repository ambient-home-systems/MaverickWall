/**
 * The display's Content-Security-Policy, measured in a real browser
 * (RFC 014 §7, precondition 1).
 *
 * Rule three — no third-party origin in the display bundle or HTML — has been
 * true here as a property of the *code*: nothing in `apps/display` fetches
 * from anywhere but its own origin, and `admin-origins.test.ts` reads the
 * served markup to prove the same of the admin. A CSP is the *second*
 * mechanism, and it is a property of the browser: a reference that got past
 * the first is refused by the second. This file is what says the second one is
 * on, that it costs the wall nothing, and — the half a header alone cannot
 * establish — that it actually refuses something.
 *
 * ## What the surfaces turned out to need
 *
 * Every directive below is the tightest value five real surfaces were measured
 * against, not the value RFC 014 §7 predicted. Three findings:
 *
 *   - **`style-src 'self'` is enough. `'unsafe-inline'` is not needed**, which
 *     the RFC expected it would be ("needed for the inline styles the renderer
 *     already writes"). The renderer writes no inline styles in the sense CSP
 *     means: it writes through the CSSOM — `element.style.setProperty` in
 *     `theme.ts` and `main.ts`, `element.style.x = …` in `render.ts` — and the
 *     CSSOM is not a parse of author text, so CSP does not govern it. What CSP
 *     governs is a `style` attribute *in markup* and a `<style>` element, and
 *     the wall's document has neither. Measured, not reasoned: surface (b)
 *     draws the shipped Classic wall, whose every box, tier, theme token and
 *     type role reaches the glass through that door, at zero violations.
 *   - **`connect-src` names the host rather than relying on `'self'`.** `'self'`
 *     is specified to cover a `ws:`/`wss:` upgrade of the document's own
 *     origin and engines have disagreed about that for years; the push hub
 *     (`net/push-hub.ts`) is what it is for, so the host is spelled out.
 *   - **`data:` in `img-src` is load-bearing**, which is worth knowing before
 *     somebody tidies it away as the loose end of an otherwise `'self'`-only
 *     policy. Measured by removing it: `img-src *` — which reads as *looser*
 *     than what ships and is not, because `*` does not cover a scheme —
 *     reddens four of the five surfaces with `img-src refused data`. That is
 *     the wall's favicon, which is inline precisely because a fetched one
 *     would be the third-party origin rule three exists to refuse.
 *
 * Nothing was relaxed to make a surface pass. The one thing a surface *did*
 * need was a change on our side rather than in the policy: the "the display
 * bundle was not found" page at `/` carried a `style` attribute, which is the
 * one thing on any of these paths a browser would have refused, and it is now
 * written without one.
 *
 * ## The five surfaces, and why each is here
 *
 *   (a) the pairing form — a wall before it holds a token, which is the one
 *       document with a real `<form>` and an `<input>` on it (`form-action`);
 *   (b) a paired wall drawing the Classic seed — the whole renderer: eight
 *       bundled faces, `/d/media` avatars, the CSSOM theme, the density tiers;
 *   (c) the offline shell — the service worker replays the cached `/` and its
 *       cached headers, so the policy has to survive the round trip through
 *       the Cache API rather than being a property of a live response;
 *   (d) the theme builder's preview iframe on `/admin/themes` — the display's
 *       own renderer and stylesheet on an *admin* page, which is the surface a
 *       policy leaking off `/assets/*` onto the admin would break first. Its
 *       zero is only worth anything beside two other assertions, and they are
 *       both here: §1 says the admin serves no policy of its own, and this
 *       test says the preview actually drew and was actually themed — a blank
 *       iframe reports zero violations very reliably;
 *   (e) an image widget served from `/d/media` — a `background-image` written
 *       through the CSSOM, which is the exact shape the positive control uses
 *       to fail, differing only in the host it names.
 *
 * ## The positive control
 *
 * Without it this file cannot go red: five surfaces reporting no violations is
 * also what a missing header looks like. So the last test inserts a rule
 * through `CSSStyleSheet.insertRule` — the door RFC 014 §7 precondition 3
 * would give a household's own CSS block — painting a box with
 * `url(https://example.invalid/x.png)`, and asserts exactly one violation
 * naming that host. It proves both halves at once: the CSSOM accepts and
 * applies the declaration (so `style-src` really is not what governs it), and
 * `img-src` refuses the fetch it asks for.
 *
 * Six mutations were checked against this file and all six are red: the header
 * dropped entirely (3 red, the control among them), `img-src *` (5), an
 * `'unsafe-inline'` added to `style-src` (1), `/assets/*` taken off the
 * surface list (1), `/sw.js` taken off it (1), and `connect-src` widened from
 * this host to a bare `ws: wss:` (1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import {
  TEARDOWN,
  browser,
  install,
  settleWall,
  shellCache,
  shutDownBrowser,
  wallState,
  type Installation,
} from './browser-harness.js';

/** Long: each of these boots a server, a browser context and a wall. */
const SLOW = 90_000;

const installations: Installation[] = [];
async function fresh(options: Parameters<typeof install>[0] = {}): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
}, TEARDOWN);

// ---------------------------------------------------------------------------
// Counting violations
// ---------------------------------------------------------------------------

/** One refusal, in the terms a failure message can print. */
interface Violation {
  readonly blockedURI: string;
  readonly violatedDirective: string;
  readonly documentURI: string;
}

/**
 * Arm the listener **before anything navigates**, in every frame.
 *
 * `addInitScript` runs at document start on each navigation and each attached
 * frame, which is the only placement that can see a violation raised by the
 * document's own first stylesheet or its first module. A listener added after
 * `goto` resolves has already missed the interesting half — and would leave
 * this file passing for the same reason a missing header would.
 *
 * On `document` rather than `window`: a violation is fired at the element that
 * caused it where there is one and at the document where there is not, and it
 * bubbles, so the document catches both.
 */
async function armViolationListener(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const seen: {
      blockedURI: string;
      violatedDirective: string;
      documentURI: string;
    }[] = [];
    (globalThis as { __mwCsp?: unknown[] }).__mwCsp = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      const e = event as SecurityPolicyViolationEvent;
      seen.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective || e.effectiveDirective,
        documentURI: e.documentURI,
      });
    });
  });
}

/**
 * Everything refused in this page and in every frame under it.
 *
 * All frames, because surface (d) is an iframe and a violation raised inside
 * it is reported in *its* document, never the parent's — reading the top frame
 * alone would make the one surface that has a nested document the one surface
 * that could not fail.
 */
async function violations(page: Page): Promise<Violation[]> {
  const found: Violation[] = [];
  const frames: Frame[] = page.frames();
  for (const frame of frames) {
    const some = await frame
      .evaluate(() => (globalThis as { __mwCsp?: unknown[] }).__mwCsp ?? [])
      .catch(() => [] as unknown[]);
    found.push(...(some as Violation[]));
  }
  return found;
}

/** A failure that names what was refused rather than printing `[ ] !== [ ]`. */
function describeViolations(found: readonly Violation[]): string {
  if (found.length === 0) return 'none';
  return found
    .map((v) => `${v.violatedDirective} refused ${v.blockedURI} (in ${v.documentURI})`)
    .join('\n  ');
}

/** The header itself, so a surface's zero is a zero *under* a policy. */
async function policyOf(base: string, path: string): Promise<string | null> {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  // The body is drained so the connection does not stay open across a `kill()`.
  await response.arrayBuffer().catch(() => undefined);
  return response.headers.get('content-security-policy');
}

/** A real 1x1 PNG — `storeImage` sniffs magic bytes and refuses anything else. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ===========================================================================
// 1 · The header is served, and only where it belongs
// ===========================================================================

describe('1 · where the policy is served', () => {
  it(
    'is on every document and asset the wall loads, and on nothing in the admin',
    async () => {
      const wall = await fresh();

      for (const path of ['/', '/assets/display.css', '/assets/main.js', '/sw.js', '/d/manifest']) {
        const policy = await policyOf(wall.base, path);
        expect(policy, `${path} served no Content-Security-Policy`).not.toBeNull();
        expect(policy, path).toContain("default-src 'self'");
        expect(policy, path).toContain("object-src 'none'");
        /*
         * Asserted as an absence rather than left to the directive list above.
         * `'unsafe-inline'` is the one value somebody would add to make a
         * surface stop complaining, and the whole finding of this file is that
         * no surface needs it.
         */
        expect(policy, `${path} carries 'unsafe-inline'`).not.toContain('unsafe-inline');
        expect(policy, `${path} carries 'unsafe-eval'`).not.toContain('unsafe-eval');
      }

      /*
       * The websocket host is the request's own, so a household running two
       * walls behind one reverse proxy does not open `ws:` to the world.
       */
      const host = new URL(wall.base).host;
      const onRoot = await policyOf(wall.base, '/');
      expect(onRoot).toContain(`connect-src 'self' ws://${host} wss://${host}`);
      expect(onRoot, 'a bare ws: scheme would allow any host at all').not.toMatch(/ws:(?:;|\s|$)/);

      /*
       * The admin is out of scope and has to stay out: it carries an inline
       * `<style>` on the two pages that must work before anything else does, a
       * `srcdoc` preview iframe and `blob:` URLs in the editor. A policy that
       * leaked onto it would be one this file never measured.
       */
      for (const path of ['/healthz', '/admin', '/admin/themes', '/setup']) {
        expect(await policyOf(wall.base, path), `${path} inherited the display policy`).toBeNull();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 2 · The five surfaces
// ===========================================================================

describe('2 · the surfaces the wall actually draws', () => {
  it(
    '(a) draws the pairing form with nothing refused',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        // No pairing token: the bundle asks for the manifest, is told 401, and
        // draws the code-entry form.
        await page.goto(`${wall.base}/`, { waitUntil: 'load' });
        await page.waitForSelector('.pair-form', { timeout: 20_000 });
        await page.waitForTimeout(500);

        const found = await violations(page);
        expect(found.length, `the pairing form:\n  ${describeViolations(found)}`).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    '(b) draws the shipped Classic wall with nothing refused',
    async () => {
      const wall = await fresh({ feed: true });
      const link = await wall.pairLink();
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        // A second tick, so a redraw's worth of CSSOM writes is in the count.
        await page.waitForTimeout(1000);

        const state = await wallState(page);
        expect(
          state.widgets,
          'no widget was drawn at all, so a clean violation count says nothing',
        ).toBeGreaterThan(0);

        const found = await violations(page);
        expect(found.length, `the Classic wall:\n  ${describeViolations(found)}`).toBe(0);

        /*
         * The faces specifically, because `font-display: swap` makes a refused
         * font silent: the wall draws in a fallback and nothing on screen says
         * so. A zero above covers it, and this names it if it ever stops
         * being zero for the reason that is hardest to see.
         */
        expect(
          found.filter((v) => v.violatedDirective.startsWith('font-src')),
          'a bundled face was refused, which a wall would show only as different type',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    '(c) replays the offline shell with nothing refused',
    async () => {
      const wall = await fresh({ feed: true });
      const link = await wall.pairLink();
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);

        /*
         * The worker has to be *controlling* before a reload is served from the
         * device — `skipWaiting` plus `clients.claim` make that happen without
         * a second navigation. Reported rather than thrown: "the worker never
         * took control" is a diagnosis and a bare timeout is not.
         */
        const controlled = await page
          .waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        expect(controlled, 'the service worker never took control, so there is no offline shell to measure').toBe(true);

        await page.reload({ waitUntil: 'load' });
        await settleWall(page);

        const cached = await shellCache(page);
        expect(cached, 'the shell cache holds no document, so the reload below is not offline').toContain('/');

        await wall.kill();
        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(1500);

        const state = await wallState(page);
        expect(
          state.widgets,
          `nothing drew offline, so the violation count is about a blank page. Cached: ${cached.join(' ')}`,
        ).toBeGreaterThan(0);

        /*
         * The point of this surface: the Cache API stores the response with its
         * headers, so the replayed `/` carries the policy it was served with
         * and the offline wall is under it too. A wall that dropped the header
         * on the way through the cache would draw identically and be
         * unprotected, which is why this is asserted rather than assumed.
         */
        const replayed = await page.evaluate(async () => {
          const names = await caches.keys();
          for (const name of names) {
            const hit = await (await caches.open(name)).match('/');
            if (hit !== undefined) return hit.headers.get('content-security-policy');
          }
          return null;
        });
        expect(replayed, 'the cached shell carries no policy, so an offline wall runs without one').not.toBeNull();
        expect(replayed as string, 'the cached shell carries some other policy').toContain("default-src 'self'");

        const found = await violations(page);
        expect(found.length, `the offline shell:\n  ${describeViolations(found)}`).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    "(d) draws the theme builder's preview iframe with nothing refused",
    async () => {
      const wall = await fresh({ feed: true });
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/themes/new`, { waitUntil: 'load' });
        await page.waitForSelector('#theme-preview iframe', { timeout: 20_000 });
        await page.waitForTimeout(1500);

        /*
         * The preview has to have *drawn*, or this measures an empty iframe.
         * It renders a real wall through the display's own `renderFreeform`
         * into a `srcdoc` document carrying `/assets/display.css` inline.
         */
        const drew = await page.evaluate(() => {
          const frame = document.querySelector('#theme-preview iframe') as HTMLIFrameElement | null;
          const wallEl = frame?.contentDocument?.getElementById('wall');
          return {
            children: wallEl?.childElementCount ?? 0,
            themed: frame?.contentDocument?.documentElement.getAttribute('data-theme') ?? '',
          };
        });
        expect(drew.children, 'the theme preview drew nothing, so this surface proves nothing').toBeGreaterThan(0);
        expect(drew.themed, 'the preview was never themed, so the CSSOM half was not exercised').not.toBe('');

        const found = await violations(page);
        expect(found.length, `the theme builder:\n  ${describeViolations(found)}`).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  it(
    '(e) draws an image widget from /d/media with nothing refused',
    async () => {
      const wall = await fresh({ feed: true });
      const link = await wall.pairLink();
      const screen = wall.db
        .prepare('SELECT id FROM screens ORDER BY created_at DESC LIMIT 1')
        .get() as { id: string };

      const upload = new FormData();
      upload.append('image', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'wall.png');
      const stored = (await (await wall.call('/admin/media/upload', { method: 'POST', body: upload })).json()) as {
        ok: boolean;
        name?: string;
        message?: string;
      };
      expect(stored.ok, `the upload this test needs was refused: ${stored.message ?? ''}`).toBe(true);
      const name = stored.name as string;

      const saved = await wall.call('/admin/layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          screen: screen.id,
          mode: 'freeform',
          aspect: 1080 / 1920,
          widgets: [
            { id: 'picture', type: 'image', x: 0.05, y: 0.05, w: 0.9, h: 0.4, z: 0, config: { image: name } },
            { id: 'agenda', type: 'calendar', x: 0.05, y: 0.5, w: 0.9, h: 0.45, z: 0, config: { mode: 'list' } },
          ],
        }),
      });
      expect(saved.status, 'the layout this test needs was refused').toBe(200);

      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        await page.waitForTimeout(1000);

        /*
         * The picture is drawn as a `background-image` on a div rather than as
         * an `<img>`, and written through the CSSOM — which is the identical
         * mechanism the positive control below uses to fail. So the assertion
         * is that the box exists *and* carries the `/d/media` URL: a box drawn
         * with no background would leave `img-src` untested on the one surface
         * that is here to test it.
         */
        const painted = await page.evaluate(() =>
          /*
           * Every `.fw-image`, not the first. The widget *wrapper* is
           * `div.fw.fw-image` and the picture inside it is `div.fw-image` too,
           * so `querySelector` answers the wrapper — which has no background
           * and reported `none`, which reads exactly like a refused fetch.
           */
          [...document.querySelectorAll('#wall .fw-image')].map(
            (box) => getComputedStyle(box as HTMLElement).backgroundImage,
          ),
        );
        expect(painted.length, 'no image widget drew, so /d/media was never fetched').toBeGreaterThan(0);
        expect(
          painted.join(' | '),
          'the image widget drew with no background, so nothing fetched /d/media',
        ).toContain('/d/media/');

        const found = await violations(page);
        expect(found.length, `the image widget:\n  ${describeViolations(found)}`).toBe(0);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 3 · The positive control
// ===========================================================================

describe('3 · the policy refuses something', () => {
  /**
   * Five clean surfaces and a header nobody sent look the same from here.
   *
   * This is the assertion that can only pass with the header on, and it uses
   * the door RFC 014 §7 precondition 3 would hand a household: a rule inserted
   * through `CSSStyleSheet.insertRule`, on the display's own same-origin
   * stylesheet. `example.invalid` is reserved by RFC 2606 and resolves
   * nowhere, which matters: CSP refuses the fetch *before* DNS, so the
   * violation is the policy's and never the network's.
   */
  it(
    'refuses a stranger’s origin injected through the CSSOM, and names it',
    async () => {
      const wall = await fresh({ feed: true });
      const link = await wall.pairLink();
      /*
       * Its own context rather than `loadWallSettled`, and that is a
       * constraint rather than a preference: the listener has to be armed
       * before the first navigation, and that helper opens the context itself.
       */
      const context = await (await browser()).newContext({ viewport: { width: 1080, height: 1920 } });
      await armViolationListener(context);
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        await page.waitForTimeout(500);

        const before = await violations(page);
        expect(before.length, `the wall was already violating:\n  ${describeViolations(before)}`).toBe(0);

        const inserted = await page.evaluate(() => {
          const sheet = [...document.styleSheets].find((s) => (s.href ?? '').includes('display.css'));
          if (sheet === undefined) return 'no display.css stylesheet to insert into';
          try {
            sheet.insertRule(
              '#wall { background-image: url(https://example.invalid/x.png) }',
              sheet.cssRules.length,
            );
          } catch (reason) {
            return `insertRule threw: ${String(reason)}`;
          }
          const wallEl = document.getElementById('wall');
          // Read back, so "the rule applied" is measured rather than assumed —
          // this is also what says `style-src` is not what governs the CSSOM.
          return wallEl === null ? 'no #wall' : getComputedStyle(wallEl).backgroundImage;
        });
        expect(
          inserted,
          'the CSSOM rule did not apply, so nothing asked the browser to fetch anything',
        ).toContain('example.invalid');

        /*
         * The fetch is asynchronous, so the refusal is not instant — but a
         * timeout here is *the* result this test exists to report, and a bare
         * `waitForFunction timed out` is not a diagnosis. Swallowed, so the
         * count below is what fails and says "expected exactly one refusal,
         * got: none" — which is what a wall with no header looks like.
         */
        await page
          .waitForFunction(
            () => ((globalThis as { __mwCsp?: unknown[] }).__mwCsp ?? []).length > 0,
            null,
            { timeout: 10_000 },
          )
          .catch(() => undefined);

        const found = await violations(page);
        expect(found.length, `expected exactly one refusal, got:\n  ${describeViolations(found)}`).toBe(1);
        const only = found[0] as Violation;
        expect(only.blockedURI, describeViolations(found)).toContain('example.invalid');
        expect(only.violatedDirective, describeViolations(found)).toMatch(/^img-src/);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

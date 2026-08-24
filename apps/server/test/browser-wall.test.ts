/**
 * RFC 009 Phase 0 — five tests that open a browser.
 *
 * Not a suite. Five, each one aimed at a fault this project has already paid
 * for or is about to: an offline reload that draws black, an agenda at 4.7px, a
 * timezone from West Africa, an editor whose guard stands down on the event it
 * exists for, and a phone whose first screenful is navigation.
 *
 * **Five of the eight assertions are red today, deliberately.** Four of them are
 * the regression tests for RFC 009 items that Phase 1 fixes — 1.1, 1.2, 1.3 and
 * 1.7 — and the RFC says two of those fixes need their test in front of them. A
 * test that goes green the day the bug is fixed is worth more than one written
 * afterwards to agree with the fix; each was checked by simulating the fix and
 * watching it turn.
 *
 * The fifth is a fault **nobody had filed**, found by this file on its first
 * clean run: in landscape the free-form canvas is drawn 23px off the left edge
 * of the glass. See the overflow test for the mechanism.
 *
 * Everything that makes these honest lives in `browser-harness.ts`: a real
 * server that can be killed, a real feed, a real browser, and a measurement of
 * the size text is *drawn* at rather than the size it is declared at.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  browser,
  install,
  LEGIBILITY_FLOOR_REM,
  measureWall,
  settleWall,
  shellCache,
  shutDownBrowser,
  wallState,
  type Installation,
  type TextRun,
} from './browser-harness.js';

/*
 * A container started by `docker run` with no `TZ` resolves to `UTC`, which is
 * what the README's own one-liner does — and `Intl.supportedValuesOf` lists 418
 * zones with neither `UTC` nor `Etc/UTC` among them. Setting it here is what
 * reproduces the box a household actually installs on; without it the host's
 * own zone matches an option, the select renders correctly, and test 3 passes
 * on a wizard that is broken everywhere else.
 */
process.env['TZ'] = 'UTC';

/** Long, because each of these boots a server, a browser context and a wall. */
const SLOW = 60_000;

const installations: Installation[] = [];
async function fresh(options?: Parameters<typeof install>[0]): Promise<Installation> {
  const made = await install(options);
  installations.push(made);
  return made;
}

afterAll(async () => {
  for (const one of installations) await one.dispose();
  await shutDownBrowser();
});

/** Everything a failure needs to be actionable, smallest first. */
function report(runs: readonly TextRun[], remPx: number): string {
  return runs
    .slice()
    .sort((a, b) => a.effectiveRem - b.effectiveRem)
    .slice(0, 8)
    .map(
      (run) =>
        `  ${run.effectiveRem.toFixed(3)}rem (${run.effectivePx.toFixed(1)}px at rem=${remPx}px)` +
        `  x${run.scale.toFixed(3)} of ${run.declaredPx}px  ${run.where}  “${run.text}”`,
    )
    .join('\n');
}

// ===========================================================================
// 1 · The offline wall
// ===========================================================================

describe('1 · the offline wall', () => {
  /**
   * Load, reload, kill the server, reload again.
   *
   * The server is *killed*, not stubbed: connections are refused the way they
   * are when somebody reboots the router, which is the only version of this
   * that has ever found anything.
   */
  async function reloadWithNothingBehindIt(
    onlineLoads: 1 | 2,
    viewport: { width: number; height: number } = { width: 1080, height: 1920 },
  ): Promise<{
    state: Awaited<ReturnType<typeof wallState>>;
    online: Awaited<ReturnType<typeof wallState>>;
    cached: string[];
    controlled: boolean;
    error?: string;
  }> {
    const wall = await fresh({ feed: true });
    const context = await (await browser()).newContext({ viewport });
    try {
      const page = await context.newPage();
      await page.goto(await wall.pairLink(), { waitUntil: 'load' });
      await settleWall(page);
      /*
       * The worker has to be *controlling* before a reload can be served from
       * it. `skipWaiting` + `clients.claim` make that happen without a second
       * navigation, so this is a wait rather than an extra load — and its
       * failure is reported rather than thrown, because "the worker never took
       * control" is a diagnosis and `waitForFunction timed out` is not.
       */
      const controlled = await page
        .waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (onlineLoads === 2 && controlled) {
        await page.reload({ waitUntil: 'load' });
        await settleWall(page);
      }

      const cached = await shellCache(page);
      /*
       * What the wall looks like with the server *up*, so the offline check
       * can be a comparison rather than a literal.
       *
       * Pinning "five widget boxes" would pin this test to the Classic
       * template's widget count: RFC 009 Phase 2.1 omits a widget that has no
       * data and no configuration, which takes the unconfigured Weather and
       * Shift boxes off the first-run wall and would turn this red for a
       * reason that has nothing to do with reloads.
       */
      const online = await wallState(page);
      await wall.kill();

      let error: string | undefined;
      await page.reload({ waitUntil: 'load' }).catch((reason: unknown) => {
        error = String(reason).split('\n')[0];
      });
      // No `settleWall`: whether a canvas ever appears is the question.
      await page.waitForTimeout(1500);
      const state = await wallState(page);
      return error === undefined
        ? { state, online, cached, controlled }
        : { state, online, cached, controlled, error };
    } finally {
      await context.close();
    }
  }

  it(
    'draws the calendar with the server dead, after a reload the worker controlled',
    async () => {
      const { state, online, cached, controlled, error } = await reloadWithNothingBehindIt(2);
      expect(
        controlled,
        'the service worker never took control, so nothing can be served from the ' +
          'device with the server down. main.ts registers it on `load`; sw.ts claims ' +
          'its clients on activate.',
      ).toBe(true);
      expect(error, 'the reload itself failed, so nothing was served from the device').toBeUndefined();
      expect(online.widgets, 'the wall drew nothing even with the server up').toBeGreaterThan(0);
      expect(
        { children: state.children, canvases: state.canvases, widgets: state.widgets },
        `#wall after an offline reload. Cached: ${cached.join(' ')}\n  on screen: “${state.text}”`,
      ).toEqual({ children: online.children, canvases: online.canvases, widgets: online.widgets });
    },
    SLOW,
  );

  /**
   * The same thing after a single online load — **red until RFC 009 1.1**.
   *
   * `sw.ts:49` lists the shell by hand and the list has drifted: `render.js`
   * imports `density.js`, `ladder.js` and `widget-options.js`, none of which is
   * in it. The install-time cache is therefore missing three modules the page
   * needs, and a wall reloaded before its first *controlled* reload has back-
   * filled them draws nothing at all. Every new screen passes through that
   * window.
   *
   * The fix is to derive `SHELL` from the built import graph. When it lands,
   * this goes green with no edit.
   */
  it(
    'draws the calendar with the server dead, after only one online load',
    async () => {
      const { state, online, cached, controlled, error } = await reloadWithNothingBehindIt(1);
      expect(
        controlled,
        'the service worker never took control, so nothing can be served from the ' +
          'device with the server down. main.ts registers it on `load`; sw.ts claims ' +
          'its clients on activate.',
      ).toBe(true);
      expect(error, 'the reload itself failed, so nothing was served from the device').toBeUndefined();
      expect(online.widgets, 'the wall drew nothing even with the server up').toBeGreaterThan(0);
      expect(
        { children: state.children, canvases: state.canvases, widgets: state.widgets },
        `#wall after an offline reload following ONE online load. ` +
          `Cached: ${cached.join(' ')}\n  on screen: “${state.text}”`,
      ).toEqual({ children: online.children, canvases: online.canvases, widgets: online.widgets });
    },
    SLOW,
  );

  /**
   * And the banner sits beside the wall rather than across it.
   *
   * The sixth assertion in a file that was meant to hold five, and it arrived
   * with the landscape canvas fix rather than with Phase 0 — because until the
   * canvas was letterboxed against the frame, this was broken and nothing
   * said so.
   *
   * A banner is the only thing here that cannot be arranged: it exists when
   * the server does not, so the offline dance above is the only way to get
   * one, which is exactly how `CLAUDE.md` records finding this fault the first
   * time — *"A banner in landscape drew the month on top of itself | Killing
   * the server, which is the only way to get a banner."* It came back in the
   * free-form era, in the same orientation, for a different reason. Measured
   * on a 1920x1080 wall before the fix:
   *
   *     canvas  left -23  top  46  right 1897  bottom 1126   (46px off the glass)
   *     banner  left -23  top  42  right 1942  bottom   99   (behind the canvas)
   *
   * Which is worse than an overlap: the canvas is painted after it, so a
   * screenshot of that wall has no banner on it at all. The household got
   * stale data with nothing saying so — rule nine failing at the one moment it
   * exists for. So the assertion is that they do not intersect, not merely
   * that both are on screen.
   *
   * Portrait was correct throughout, which is what kept it quiet: the base
   * `.screen` rule is a flex *column*, so the banner takes its own row under
   * the canvas — and in landscape the two-column grid was overriding that.
   */
  it(
    'draws the offline banner under the wall, not across it',
    async () => {
      const { state, controlled, error } = await reloadWithNothingBehindIt(2, {
        width: 1920,
        height: 1080,
      });
      expect(controlled, 'the service worker never took control').toBe(true);
      expect(error, 'the reload itself failed').toBeUndefined();

      const { canvas, banner, viewport } = state;
      expect(canvas, 'no canvas was drawn offline').toBeDefined();
      expect(
        banner,
        'no banner, so there is nothing to check — a wall with the server dead ' +
          'must say so (rule nine), and this test cannot do its job without one',
      ).toBeDefined();

      const where = `canvas ${JSON.stringify(canvas)} banner ${JSON.stringify(banner)} in ${viewport.width}x${viewport.height}`;
      for (const [name, rect] of [['canvas', canvas!], ['banner', banner!]] as const) {
        expect(
          rect.left >= -1 && rect.top >= -1 &&
            rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1,
          `the ${name} is drawn partly off the glass. ${where}`,
        ).toBe(true);
      }

      const overlaps =
        canvas!.left < banner!.right && banner!.left < canvas!.right &&
        canvas!.top < banner!.bottom && banner!.top < canvas!.bottom;
      expect(
        overlaps,
        `the banner is drawn on top of the wall. It is the one thing on screen ` +
          `that has to be read, and the calendar underneath it is the one thing ` +
          `somebody walked over for. ${where}`,
      ).toBe(false);
    },
    SLOW,
  );
});

// ===========================================================================
// 2 · The first-run wall
// ===========================================================================

describe('2 · the first-run wall', () => {
  /*
   * A fresh install with one feed and nothing else — no location, no people, no
   * arrangement — which is what a household has five minutes after unboxing,
   * and what the Classic template draws.
   */
  const SIZES = [
    { width: 1080, height: 1920, name: 'portrait 1080x1920' },
    { width: 1920, height: 1080, name: 'landscape 1920x1080' },
    { width: 1280, height: 720, name: 'landscape 1280x720' },
  ] as const;

  let measured: Promise<Map<string, Awaited<ReturnType<typeof measureWall>>>> | undefined;

  /**
   * One wall, measured at three sizes, once for both assertions.
   *
   * The promise is memoised rather than the result, so a run that fails
   * part-way through — a `settleWall` that times out on a slow box — is not
   * repeated by the second test with a whole second installation behind it.
   * Both tests then fail on the same measurement, which is also the truer
   * report.
   */
  async function measureEverySize(): Promise<Map<string, Awaited<ReturnType<typeof measureWall>>>> {
    if (measured === undefined) measured = measureOnce();
    return measured;
  }

  async function measureOnce(): Promise<Map<string, Awaited<ReturnType<typeof measureWall>>>> {
    const wall = await fresh({ feed: true });
    const link = await wall.pairLink();
    const out = new Map<string, Awaited<ReturnType<typeof measureWall>>>();
    for (const size of SIZES) {
      const context = await (await browser()).newContext({
        viewport: { width: size.width, height: size.height },
      });
      try {
        const page = await context.newPage();
        await page.goto(link, { waitUntil: 'load' });
        await settleWall(page);
        out.set(size.name, await measureWall(page));
      } finally {
        await context.close();
      }
    }
    return out;
  }

  /**
   * The canvas is the letterbox it claims to be, and nothing spills past it.
   *
   * Three measurements, because each catches something the others cannot.
   *
   * `scrollHeight` against `clientHeight` is how this project has learned to
   * see content that `overflow: hidden` has silently eaten. A frame drawn *off
   * to one side* has no scrollable overflow at all, so the canvas's own rect is
   * checked against the glass — which is how "the takeover drew in the left
   * half of a television" was found, after the layout looked merely
   * left-aligned. And a canvas wholly *inside* the glass can still be the wrong
   * size, which neither of those sees at all.
   *
   * That third one is not hypothetical. It is what the half-done version of
   * this fix looked like: adding `.screen.freeform` to the landscape exemption
   * moved the canvas back on screen and left it **1920x1002 on a 1920x1080
   * television** — squeezed by the padding box, a band of bare ground above the
   * wall and another below, and both rect checks green. `padding: 0` is the
   * other half, and this assertion is what says so.
   */
  it(
    'letterboxes the canvas into the screen, with nothing past the edge',
    async () => {
      const all = await measureEverySize();

      // Every size, then one assertion — a loop that throws on the first stops
      // measuring, and "it is wrong at 1920x1080" is a much smaller fact than
      // "it is wrong in landscape and right in portrait".
      const spilling = SIZES.flatMap((size) =>
        all.get(size.name)!.overflowing.map((one) => `${size.name}: ${JSON.stringify(one)}`),
      );
      expect(
        spilling,
        'something is drawn past the frame that holds it. overflow:hidden means ' +
          'it is silently gone, and a month grid missing its last week looks deliberate.',
      ).toEqual([]);

      const offGlass = SIZES.flatMap((size) =>
        all.get(size.name)!.outsideViewport.map((one) => `${size.name}: ${JSON.stringify(one)}`),
      );
      expect(
        offGlass,
        'the wall is drawn partly off the glass. The canvas is letterboxed into ' +
          'the frame, so its own rect has to be inside it.',
      ).toEqual([]);

      /*
       * A pixel of slack, because the letterbox rarely divides evenly: a 16:9
       * canvas in a 1366x768 frame is 1365.34 wide by arithmetic and by
       * measurement, and that third of a pixel is the letterbox working.
       *
       * This holds because the canvas has the screen to itself. A banner is a
       * second row and the canvas correctly gives up its height for one — so
       * do not extend this assertion to a wall with the server down; the
       * banner test in describe 1 is where that case is measured.
       */
      const misfitted = SIZES.flatMap((size) => {
        const fit = all.get(size.name)!.canvasFit;
        if (fit === undefined) return [`${size.name}: no canvas to measure`];
        const wrong =
          Math.abs(fit.actual.width - fit.expected.width) > 1 ||
          Math.abs(fit.actual.height - fit.expected.height) > 1;
        return wrong
          ? [
              `${size.name}: drew ${Math.round(fit.actual.width)}x${Math.round(fit.actual.height)} ` +
                `where aspect ${fit.aspect} in this frame is ` +
                `${Math.round(fit.expected.width)}x${Math.round(fit.expected.height)}`,
            ]
          : [];
      });
      expect(
        misfitted,
        'the canvas is not the largest box of its aspect that fits the frame. ' +
          'Inside the glass is not the same as filling it — a canvas squeezed by ' +
          'a padding box is wholly on screen and wholly wrong.',
      ).toEqual([]);
    },
    SLOW,
  );

  /**
   * No word smaller than the floor — **red until RFC 009 1.3**.
   *
   * `minScaleFor` protects a note at 0.3, a weather reading at 0.4 and a chore
   * board at 0.62, and drops the calendar through to `default: 0.2` — the
   * lowest floor in the system, on the one thing the product exists to show.
   * The Classic wall's agenda therefore draws at roughly a quarter size, which
   * is 7.1px on a 1080p wall and 4.4px on a 720p one.
   *
   * The floor is in rem because the fault is: the *same* wall draws the *same*
   * 0.34rem on both those screens. See `LEGIBILITY_FLOOR_REM` for where 0.713
   * comes from and why it is quoted rather than imported.
   */
  it(
    'draws no word below the legibility floor',
    async () => {
      const all = await measureEverySize();
      const offending: string[] = [];
      const detail: string[] = [];
      for (const size of SIZES) {
        const wall = all.get(size.name)!;
        expect(wall.runs.length, `${size.name}: nothing was drawn at all`).toBeGreaterThan(10);

        const tooSmall = wall.runs.filter((run) => run.effectiveRem < LEGIBILITY_FLOOR_REM);
        if (tooSmall.length === 0) continue;
        offending.push(`${size.name}: ${tooSmall.length}/${wall.runs.length}`);
        detail.push(`${size.name} (rem=${wall.remPx}px)\n${report(tooSmall, wall.remPx)}`);
      }
      expect(
        offending,
        `text is drawn below ${LEGIBILITY_FLOOR_REM}rem — the design's own --t-micro ` +
          `(1.15rem) at the deepest scale this project has measured and accepted ` +
          `(MIN_CHORE_SCALE, 0.62). Smallest first:\n${detail.join('\n')}`,
      ).toEqual([]);
    },
    SLOW,
  );
});

// ===========================================================================
// 3 · The wizard, clicked through
// ===========================================================================

describe('3 · the wizard, clicked through', () => {
  it(
    'stores the zone it detected, not whatever sorts first',
    async () => {
      const wall = await fresh({ wizard: false });
      const context = await (await browser()).newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await context.newPage();

        // The bootstrap code, exchanged for the cookie exactly as the link in
        // the container log does.
        await page.goto(`${wall.base}/setup?token=${wall.setupToken}`, { waitUntil: 'load' });

        await page.fill('input[name="name"]', 'Household');
        await page.fill('input[name="email"]', 'family@home.local');
        await page.fill('input[name="password"]', 'correct-horse-battery');
        await page.fill('input[name="confirm"]', 'correct-horse-battery');
        await Promise.all([
          page.waitForURL((url) => url.pathname === '/setup', { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        // Step 2, accepted exactly as it arrives. Nothing is chosen here, which
        // is the whole point: this is the household who clicks straight through.
        const select = page.locator('select[name="timezone"]');
        await select.waitFor({ timeout: 10_000 });
        const offered = await select.evaluate((node: HTMLSelectElement) => ({
          chosen: node.value,
          first: node.options[0]?.value ?? '',
          markedInMarkup: node.querySelector('option[selected]')?.getAttribute('value') ?? null,
          count: node.options.length,
        }));

        await Promise.all([
          page.waitForURL((url) => url.pathname === '/setup/calendar', { timeout: 20_000 }),
          page.click('button[type="submit"]'),
        ]);

        // Step 3, skipped — a feed can fail for reasons the household does not
        // control, and setup is already complete by here.
        await Promise.all([
          page.waitForURL((url) => url.pathname === '/setup/done', { timeout: 20_000 }),
          page.click('button.btn-text'),
        ]);

        const stored = (
          wall.db
            .prepare(`SELECT timezone FROM household_settings WHERE id = 'singleton'`)
            .get() as { timezone: string }
        ).timezone;

        const detail =
          `the form offered ${offered.count} zones, marked ${String(offered.markedInMarkup)} in the ` +
          `markup, and the browser chose “${offered.chosen}”; the first in the list is ` +
          `“${offered.first}”. The box detects UTC, which Intl.supportedValuesOf does not list.`;

        /*
         * The mechanism, and it is about the *markup*, not the ordering.
         *
         * `zone === selected` never matches when the detection is UTC, so no
         * option carries `selected` and the browser falls through to the first
         * one alphabetically. Asserting "not the first in the list" would look
         * equivalent and is not: a fix that offers Etc/UTC at the top of the
         * list would be marked correct and read as broken.
         */
        expect(
          offered.markedInMarkup,
          `the timezone form marked no option as selected, so the browser chose ` +
            `for the household. ${detail}`,
        ).not.toBeNull();
        // What it stored is what it showed as chosen.
        expect(stored, `the wizard stored a zone it never showed. ${detail}`).toBe(offered.chosen);
        // And the consequence: what it stored has to mean what the box detected.
        expect(stored, `stored a zone that is not the UTC this box detects. ${detail}`).toMatch(
          /^(Etc\/)?(UTC|GMT|UCT|Universal|Zulu|GMT[+-]0)$/,
        );
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 4 · The editor, driven
// ===========================================================================

describe('4 · the editor, driven', () => {
  /** Sign in the way a household does, then open the default display's editor. */
  async function editorPage(wall: Installation, page: Page): Promise<void> {
    await wall.signIn(page);
    await page.goto(`${wall.base}/admin/displays/default`, { waitUntil: 'load' });
    await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
  }

  /** Where the editor thinks each widget is, read back out of its own mount. */
  const placements = (page: Page): Promise<Record<string, { x: number; y: number }>> =>
    page.evaluate(() => {
      const mount = document.getElementById('layout-editor');
      const raw = mount?.getAttribute('data-json') ?? '{}';
      const parsed = JSON.parse(raw) as {
        portrait?: { widgets?: { id: string; type: string; x: number; y: number }[] };
      };
      const out: Record<string, { x: number; y: number }> = {};
      for (const widget of parsed.portrait?.widgets ?? []) {
        out[widget.id] = { x: widget.x, y: widget.y };
      }
      return out;
    });

  /** Drag the first widget on the canvas by a visible amount. */
  async function dragFirstWidget(page: Page): Promise<string> {
    const box = page.locator('.le-overlay .le-widget').first();
    const id = (await box.getAttribute('data-id')) ?? '';
    const rect = await box.boundingBox();
    if (rect === null) throw new Error('the first widget has no box to drag');
    // From its middle, so the grab lands on the box and not its resize handle.
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 40, rect.y + rect.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    return id;
  }

  it(
    'moves a widget, saves it, and the wall it reloads has it in the new place',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await editorPage(wall, page);

        const before = await placements(page);
        const id = await dragFirstWidget(page);
        expect(Object.keys(before), 'the editor opened with no widgets').toContain(id);

        // Save is the one button, and it is disabled until something is dirty —
        // so its being clickable is itself the dirty flag having flipped.
        const save = page.locator('[data-action="save"]');
        await expect
          .poll(() => save.isEnabled(), { timeout: 10_000 })
          .toBe(true);
        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), save.click()]);

        await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
        const after = await placements(page);

        expect(after[id], 'the widget is gone after saving').toBeDefined();
        expect(
          after[id],
          `the drag did not survive the save and reload: ${JSON.stringify(before[id])} → ` +
            `${JSON.stringify(after[id])}`,
        ).not.toEqual(before[id]);
      } finally {
        await context.close();
      }
    },
    SLOW,
  );

  /**
   * A link click with unsaved work must ask — **red until RFC 009 1.7**.
   *
   * `display-editor.ts` sets `navigating = true` on any click inside an
   * `a[href]`, in the capture phase, and never sets it back. `beforeunload`
   * then returns early, so the one navigation the guard exists for is the one
   * it stands down on: drag a widget, click Calendars, and the edit is gone
   * with nothing said.
   *
   * Chromium only raises a `beforeunload` dialogue after a real user gesture,
   * which the drag above supplies. Playwright dismisses dialogues by default,
   * so the observable difference is whether the page navigated at all.
   */
  it(
    'warns before a link throws away an unsaved drag',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await editorPage(wall, page);
        const from = page.url();

        await dragFirstWidget(page);
        await expect
          .poll(() => page.locator('[data-action="save"]').isEnabled(), { timeout: 10_000 })
          .toBe(true);

        // "Stay on this page", which is what a household who did not mean to
        // lose their work would press.
        let asked = false;
        page.on('dialog', (dialog) => {
          asked = true;
          void dialog.dismiss();
        });

        await page.click('a[href*="admin/calendars"]');
        await page.waitForTimeout(1500);

        expect(
          { asked, url: page.url() },
          'clicking a nav link with an unsaved drag navigated away without asking',
        ).toEqual({ asked: true, url: from });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

// ===========================================================================
// 5 · A phone
// ===========================================================================

describe('5 · a phone', () => {
  it(
    'opens the drawer on a tap, and does not spend the first screenful on navigation',
    async () => {
      const wall = await fresh();
      const context = await (await browser()).newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        await page.goto(`${wall.base}/admin/calendars`, { waitUntil: 'load' });

        /*
         * Closed first, because that is the state the page loads in. The
         * compact nav used to be recast in place as a wrapping field of pills,
         * which cost the first screenful of every page on a phone; the drawer
         * replaced it precisely so the page's own first control is reachable
         * without scrolling.
         */
        const firstControl = await page.evaluate(() => {
          const main = document.querySelector('main');
          const candidates = main?.querySelectorAll<HTMLElement>(
            'a[href], button, input:not([type="hidden"]), select, textarea',
          );
          for (const control of Array.from(candidates ?? [])) {
            /*
             * The first control somebody can actually see.
             *
             * A `hidden` control — `admin.ts` already emits one, the wall
             * editor's Discard button — is `display:none`, and
             * `getBoundingClientRect()` on that is all zeros. Taking the first
             * *match* would read `top: 0, bottom: 0` and pass the fold check
             * however far down the first real control sits, which is a test
             * agreeing with the page it exists to catch.
             */
            const style = getComputedStyle(control);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = control.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            return {
              label: (control.textContent ?? control.getAttribute('name') ?? control.tagName)
                .trim()
                .slice(0, 40),
              top: rect.top,
              bottom: rect.bottom,
              fold: window.innerHeight,
            };
          }
          return null;
        });
        expect(firstControl, 'the page has no visible control in <main> at all').not.toBeNull();
        const control = firstControl!;
        expect(
          control.top >= 0 && control.bottom <= control.fold,
          `the first control in <main> (“${control.label}”) is not wholly above the ` +
            `fold on a 390x844 phone: it runs ${Math.round(control.top)}–` +
            `${Math.round(control.bottom)} of ${control.fold}. That is navigation ` +
            `eating the first screenful, which is the fault the modal drawer replaced.`,
        ).toBe(true);

        // Now the tap. The drawer is a checkbox the CSS reads — no script — so
        // this is a real label press, and what is asserted is where the panel
        // ends up, not what class it carries.
        const drawer = page.locator('aside.side');
        const before = await drawer.boundingBox();
        expect(before, 'there is no drawer panel on this page').not.toBeNull();
        expect(
          before!.x + before!.width,
          `the drawer is already on screen before the hamburger is tapped: ${JSON.stringify(before)}`,
        ).toBeLessThanOrEqual(1);

        await page.locator('label.navbtn').tap();
        await page.waitForTimeout(400);

        const after = await drawer.boundingBox();
        expect(after, 'the drawer disappeared entirely').not.toBeNull();
        expect(
          { x: Math.round(after!.x), visible: await drawer.isVisible() },
          `the hamburger did not bring the drawer on screen: ${JSON.stringify(after)}`,
        ).toEqual({ x: 0, visible: true });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});

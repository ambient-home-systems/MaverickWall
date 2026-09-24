/**
 * Motion that survives the fifteen-second rebuild, measured on a real wall
 * (plan P4.3, decision D7).
 *
 * The wall empties and rebuilds its whole document on every tick, so every
 * animated element is a *new* element fifteen seconds later. What this file
 * measures is what a real Chromium computes for those elements — the
 * `CSSAnimation` behind them, read through the Web Animations API — rather than
 * any class or inline style, because an inline `animation-delay` that the
 * browser ignores reads exactly like one it honours:
 *
 *  1. **A loop is continuous across a redraw.** The phase the old element had
 *     reached, plus the time that passed, is the phase the rebuilt element
 *     starts at — to within the draw's own latency, where a restart lands half
 *     a cycle away (`FIXTURE_LOOP_MS` is six seconds, and a tick is two and a
 *     half of them).
 *  2. **A one-shot fires once per event.** It plays when its event first
 *     appears; a redraw in the middle of it resumes rather than restarting; and
 *     the next tick after it finishes draws the still frame with no animation
 *     at all. A new event fires again.
 *  3. **The scope holds on the glass**: with the system asking for reduced
 *     motion, and with the wall's own Motion switch off, the same element
 *     computes no animation.
 *
 * The thing that moves is `motion-fixture.ts` — a demonstration, not a product
 * feature, and the first test holds that as a fact: the layout save refuses it
 * outright, so the only way it reaches a wall is the manifest being rewritten
 * on its way to the page (`patchManifest`). What is being measured is the
 * mechanism the real styles will use, not the fixture's look.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';

process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const VIEWPORT = { width: 1080, height: 1920 } as const;
/** `FIXTURE_LOOP_MS` and `FIXTURE_ONCE_MS` in `apps/display/src/motion-fixture.ts`. */
const LOOP_MS = 6_000;
const ONCE_MS = 2_400;
/**
 * How far a rebuilt element may land from where continuity puts it. The draw
 * reads the clock once at its start and the animation begins when the new
 * element is first styled, so the new phase lags by the draw's own duration;
 * a restart misses by thousands.
 */
const TOLERANCE_MS = 300;

/** The distance between two phases on a loop of `cycle`, the short way round. */
function around(a: number, b: number, cycle: number): number {
  const d = (((a - b) % cycle) + cycle) % cycle;
  return Math.min(d, cycle - d);
}

/** The fixture as a widget, with whichever event the test is on. */
let event = 'arrival-1';
function withFixture(body: Record<string, unknown>): void {
  const layout = body['layout'] as Record<string, { widgets?: unknown[] } | undefined>;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const canvas = layout[orientation];
    if (canvas === undefined) continue;
    canvas.widgets = [
      ...(canvas.widgets ?? []),
      { id: 'fx-demo', type: 'motion-fixture', x: 0.6, y: 0.02, w: 0.35, h: 0.1, z: 50, config: { event } },
    ];
  }
}

interface Reading {
  /** Computed, not declared. */
  readonly name: string;
  readonly delay: string;
  /** How many animations the element carries, and the first one's position in its cycle, ms. */
  readonly running: number;
  readonly phase: number | undefined;
  readonly startTime: number | undefined;
  readonly at: number;
}

/**
 * Read an element's animation, waiting for it to be *ready* first — a CSS
 * animation's start time is set on the frame after it is created, and a
 * phase read before then is zero whatever the delay says.
 */
async function read(page: Page, selector: string, mark = false): Promise<Reading> {
  return page.evaluate(
    async ({ selector, mark }) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`nothing on the wall matches ${selector}`);
      const animations = node.getAnimations();
      await Promise.all(animations.map((one) => one.ready));
      const first = animations[0];
      const timing = first?.effect?.getComputedTiming();
      const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      const style = getComputedStyle(node);
      if (mark) node.dataset['seen'] = '1';
      const at = document.timeline.currentTime;
      return {
        name: style.animationName,
        delay: style.animationDelay,
        running: animations.filter((one) => one.playState === 'running').length,
        phase: local === undefined ? undefined : local - delay,
        startTime: typeof first?.startTime === 'number' ? first.startTime : undefined,
        at: typeof at === 'number' ? at : 0,
      };
    },
    { selector, mark },
  );
}

/** Wait until the element marked by `read(…, true)` has been replaced by a redraw. */
async function redrawn(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const node = document.querySelector<HTMLElement>(sel);
      return node !== null && node.dataset['seen'] === undefined;
    },
    selector,
    { timeout: 25_000, polling: 50 },
  );
}

async function pairingLink(home: Installation, screenId: string): Promise<string> {
  const html = await (await home.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  return found;
}

let home: Installation;
let screenId: string;
let link: string;

beforeAll(async () => {
  home = await install({ calendars: HOUSEHOLD_CALENDARS.slice(0, 1), timezone: 'Europe/London' });
  screenId = await home.pairWall('Kitchen');
  link = await pairingLink(home, screenId);
}, SLOW);

afterAll(async () => {
  await home.dispose();
  await shutDownBrowser();
}, TEARDOWN);

describe('the fixture is a fixture', () => {
  it('cannot be placed by a household: the layout save refuses it', async () => {
    const refused = await home.call('/admin/layout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        screen: screenId,
        orientation: 'portrait',
        mode: 'freeform',
        aspect: 0.5625,
        widgets: [{ id: 'fx', type: 'motion-fixture', x: 0, y: 0, w: 0.5, h: 0.5, z: 0 }],
        background: null,
      }),
    });
    expect(refused.status).toBe(400);
  });
});

describe('a loop on a real wall', () => {
  it(
    'is continuous across a tick: the rebuilt element starts where the old one had got to',
    async () => {
      const { page, close } = await loadWallSettled(link, VIEWPORT, { patchManifest: withFixture });
      try {
        const loop = '#wall .canvas .fx-fixture-loop';
        const before = await read(page, loop, true);
        // The premise: the browser really is running the fixture's keyframes,
        // with the negative delay `motion.ts` wrote — read off the computed
        // style, not off the inline one.
        expect(before.name).toBe('fx-fixture-drift');
        expect(before.running).toBe(1);
        expect(before.delay).toMatch(/^-\d/);
        expect(before.phase).toBeDefined();

        await redrawn(page, loop);
        const after = await read(page, loop);
        expect(after.running).toBe(1);

        /*
         * The premise that makes the assertion able to fail. A restarted loop
         * would sit `(gap mod cycle)` away from a continuous one, where `gap`
         * is the time between the two elements' creation — so a gap that
         * happened to be a whole number of cycles would pass a restart. The
         * tick is 15,000ms against a 6,000ms cycle, which is half a cycle; a
         * poll landing just after a tick is the case this refuses to read.
         */
        const gap = (after.startTime ?? 0) - (before.startTime ?? 0);
        expect(around(gap, 0, LOOP_MS), `the redraw came ${gap.toFixed(0)}ms after the last`).toBeGreaterThan(1_000);

        const expected = (before.phase as number) + (after.at - before.at);
        const missed = around(after.phase as number, expected, LOOP_MS);
        expect(
          missed,
          `the rebuilt loop is ${missed.toFixed(0)}ms from where the old one had reached ` +
            `(old ${(before.phase as number).toFixed(0)}ms + ${(after.at - before.at).toFixed(0)}ms elapsed, ` +
            `new ${(after.phase as number).toFixed(0)}ms)`,
        ).toBeLessThan(TOLERANCE_MS);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('a one-shot on a real wall', () => {
  it(
    'fires for its event, resumes through a redraw, and does not refire on the next tick',
    async () => {
      event = 'arrival-1';
      const { page, close } = await loadWallSettled(link, VIEWPORT, { patchManifest: withFixture });
      try {
        // A new event, delivered the way a real one would be: in a manifest.
        event = 'arrival-2';
        const once = '#wall .canvas .fx-fixture-once[data-event="arrival-2"]';
        await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
        await page.waitForSelector(once, { timeout: 20_000 });

        // It fires: running, near its start, under its own keyframes.
        const fired = await read(page, once, true);
        expect(fired.name).toBe('fx-fixture-arrive');
        expect(fired.running, 'the one-shot did not fire for a new event').toBe(1);
        expect(fired.phase as number).toBeLessThan(ONCE_MS / 2);
        const firedAt = fired.at - (fired.phase as number);

        // A redraw in the middle of it: resumed, not restarted.
        await page.evaluate(() => (window as unknown as { maverickWall: { poll(): void } }).maverickWall.poll());
        await redrawn(page, once);
        const middle = await read(page, once, true);
        const elapsed = middle.at - firedAt;
        // The premise: the redraw landed inside the burst (measured, ~820ms in:
        // the harness holds every manifest 750ms), or this proves nothing.
        expect(elapsed, 'the redraw came after the burst had ended').toBeLessThan(ONCE_MS - TOLERANCE_MS);
        expect(middle.running, 'a redraw part-way through stopped the burst').toBe(1);
        expect(
          Math.abs((middle.phase as number) - elapsed),
          `the burst restarted at ${(middle.phase as number).toFixed(0)}ms, ${elapsed.toFixed(0)}ms after it fired`,
        ).toBeLessThan(TOLERANCE_MS);

        // Past its end, the next tick draws the still frame and nothing moves.
        await page.waitForTimeout(Math.max(0, ONCE_MS + 200 - (middle.at - firedAt)));
        await read(page, once, true);
        await redrawn(page, once);
        const later = await read(page, once);
        expect(later.running, 'the one-shot fired again on a tick with no new event').toBe(0);
        expect(later.name).toBe('none');
        const still = await page.$eval(once, (node) => ({
          opacity: getComputedStyle(node).opacity,
          playing: node.classList.contains('fx-playing'),
        }));
        expect(still).toEqual({ opacity: '1', playing: false });
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('the scope, on the glass', () => {
  it(
    'is still for a device that asks for reduced motion',
    async () => {
      const { page, close } = await loadWallSettled(link, VIEWPORT, { patchManifest: withFixture });
      try {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const reading = await read(page, '#wall .canvas .fx-fixture-loop');
        expect(reading.running).toBe(0);
        expect(reading.name).toBe('none');
        // …and the same page moves again when the preference is lifted, so the
        // stillness above is the media query and not a fixture that never moved.
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await read(page, '#wall .canvas .fx-fixture-loop')).name).toBe('fx-fixture-drift');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    "is still on a wall whose Motion switch is off, and says so on the canvas",
    async () => {
      const off = await home.post(`/admin/screens/${screenId}`, {
        name: 'Kitchen',
        orientation: 'auto',
        rotation: '0',
        theme: 'panels',
        clock_24: '',
        // Drawn on, posted with the box unticked: the household switched it off.
        motion_shown: '1',
      });
      expect(off.status).toBe(302);
      const { page, close } = await loadWallSettled(link, VIEWPORT, { patchManifest: withFixture });
      try {
        expect(await page.$eval('#wall .canvas', (node) => node.getAttribute('data-motion'))).toBe('off');
        const reading = await read(page, '#wall .canvas .fx-fixture-loop');
        expect(reading.running).toBe(0);
        expect(reading.name).toBe('none');
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

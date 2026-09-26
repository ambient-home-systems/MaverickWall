/**
 * The forecast's `today` look, measured (plan item P5.1, "iOS widget").
 *
 * RFC 014 §4.2's rule, as every designed look carries it: a real paired wall,
 * the shipped Classic seed with three family calendars, at 1080x1920 and
 * 1920x1080, on a wall nobody has measured and on one set to a 32" television
 * read from 1.2 metres. The forecast is **the captured London answer** —
 * the days, the current reading and the next twenty-four hours
 * (`browser-weather-looks.ts` says how each is seeded and what is moved).
 *
 *  1. **Nothing clipped, nothing belted, tabular figures, role sizes.** Every
 *     run sits inside the box, no `nowrap` run is cut, the belt had nothing to
 *     hide, every figure is `tabular-nums` as computed, and on a measured wall
 *     each run is its role to the px the page resolves it to.
 *  2. **The lede is capped the way the clock is (decision D1)**: never more
 *     than 1.8x the event role the agenda's titles are drawn at — asserted at
 *     three sizes, as the rule's own text asks — and at the cap wherever the
 *     box has room, so the cap is what binds rather than something smaller.
 *  3. **The sky is the theme's.** The card's computed background is the
 *     gradient of the two stops the page resolves for its sky, its words are
 *     that sky's ink, and it casts the theme's own `--shadow-card`.
 *  4. **What a box gives up, in the plan's order**: the hours, then as one
 *     line the next days, then the feels-like, then the words — never the lede.
 *  5. **With no current reading it falls back to today's high and low** as the
 *     lede, and says nothing only a measurement could.
 *  6. **What moves is scoped and continuous**: the sky's glow is running under
 *     its own keyframes with the negative delay `motion.ts` wrote, resumes
 *     where it was across a real fifteen-second redraw, and is still for a
 *     device that asks for reduced motion. A wet sky rains; a clear night is
 *     still.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  SIZES,
  WALLS,
  measureScreen,
  readForecastBox,
  roleSizes,
  setWeather,
  tokenColours,
  wallName,
  weatherWall,
  type WeatherWall,
} from './browser-weather-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 240_000;
/** `CLOCK_MAX_LEDE_RATIO` in `apps/display/src/orientation.ts`: the clock's cap, and so the lede's. */
const CAP_RATIO = 1.8;

let ww: WeatherWall;

beforeAll(async () => {
  ww = await weatherWall({ hours: true });
}, SLOW);

afterAll(async () => {
  await ww?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

interface Card {
  readonly sky: string | null;
  readonly mode: string | null;
  readonly lede: string;
  readonly ledeLow: string | null;
  readonly range: readonly string[];
  readonly cond: string | null;
  readonly feels: string | null;
  readonly next: string | null;
  readonly rungs: string | null;
  readonly tier: string | null;
  readonly hours: readonly { readonly at: string; readonly temp: string }[];
  readonly days: readonly string[];
  readonly fonts: Record<string, number>;
  /** The event role the agenda's titles are drawn at: `--t-wall-lede`, or `--t-event` where nobody measured. */
  readonly ledeRole: number;
  /** The clock's own cap on this page, as the cascade resolves it. */
  readonly cap: number;
  readonly background: string;
  readonly ink: string;
  readonly shadow: string;
  readonly themeShadow: string;
  readonly fx: string | null;
  readonly fxCount: number;
}

async function readCard(page: Page, widgetId: string): Promise<Card> {
  return page.evaluate((id) => {
    const box = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${id}"]`);
    const card = box?.querySelector<HTMLElement>('.wx-today');
    if (box === null || box === undefined || card === null || card === undefined) throw new Error('no Today card');
    const text = (sel: string): string | null => card.querySelector(sel)?.textContent ?? null;
    const size = (sel: string): number | undefined => {
      const node = card.querySelector(sel);
      return node === null ? undefined : parseFloat(getComputedStyle(node).fontSize);
    };
    const probe = (css: Partial<CSSStyleDeclaration>): CSSStyleDeclaration => {
      const node = document.createElement('span');
      Object.assign(node.style, css);
      card.appendChild(node);
      const out = getComputedStyle(node);
      const copy = { fontSize: out.fontSize, boxShadow: out.boxShadow } as CSSStyleDeclaration;
      node.remove();
      return copy;
    };
    const fonts: Record<string, number> = {};
    for (const [name, sel] of [
      ['lede', '.wt-head'],
      ['range', '.wt-range'],
      ['cond', '.wt-cond'],
      ['feels', '.wt-feels'],
      ['hourAt', '.wt-hour-at'],
      ['hourTemp', '.wt-hour-temp'],
      ['day', '.wt-dl'],
    ] as const) {
      const value = size(sel);
      if (value !== undefined) fonts[name] = value;
    }
    return {
      sky: card.getAttribute('data-sky'),
      mode: card.getAttribute('data-lede'),
      lede: text('.wt-temp') ?? '',
      ledeLow: text('.wt-temp-lo'),
      range: Array.from(card.querySelectorAll('.wt-range span')).map((one) => one.textContent ?? ''),
      cond: text('.wt-cond'),
      feels: text('.wt-feels'),
      next: box.getAttribute('data-next'),
      rungs: box.getAttribute('data-rungs'),
      tier: box.getAttribute('data-tier'),
      hours: Array.from(card.querySelectorAll('.wt-hour')).map((hour) => ({
        at: hour.querySelector('.wt-hour-at')?.textContent ?? '',
        temp: hour.querySelector('.wt-hour-temp')?.textContent ?? '',
      })),
      days: Array.from(card.querySelectorAll('.wt-dl')).map((one) => one.textContent ?? ''),
      fonts,
      ledeRole: parseFloat(probe({ fontSize: 'var(--t-wall-lede, var(--t-event))' }).fontSize),
      cap: parseFloat(probe({ fontSize: 'var(--t-wall-clock, calc(var(--t-event) * 1.8))' }).fontSize),
      background: getComputedStyle(card).backgroundImage,
      ink: getComputedStyle(card.querySelector('.wt-top') as Element).color,
      shadow: getComputedStyle(card).boxShadow,
      themeShadow: probe({ boxShadow: 'var(--shadow-card, none)' }).boxShadow,
      fx: card.querySelector('.wt-sky')?.getAttribute('data-fx') ?? null,
      fxCount: card.querySelectorAll('.wt-fx').length,
    };
  }, widgetId);
}

const deg = (value: number): string => `${Math.round(value)}°`;

describe('the Today card on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `says today's weather on its sky, clipped nowhere, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(ww, preset);
          const id = ww.weather[size.orientation].id;
          // Classic's own forecast box, then the same box grown to hold the hours.
          for (const resize of [undefined, { h: 0.3 }]) {
            await setWeather(ww, size.orientation, { variant: 'today' }, resize);
            const { page, close } = await loadWallSettled(ww.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${resize === undefined ? 'seed box' : 'tall box'}`;
              const box = await readForecastBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.numerals.length, `${where}: no figures drawn`).toBeGreaterThan(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');

              const card = await readCard(page, id);
              // What it says: the captured reading now, and today's range under it.
              expect(card.mode, where).toBe('now');
              expect(card.lede, where).toBe(deg(ww.currentTemp));
              expect(card.ledeLow, where).toBeNull();
              expect(card.range, where).toEqual([`H ${deg(ww.days[0]!.high)}`, `L ${deg(ww.days[0]!.low)}`]);
              if (card.cond !== null) expect(card.cond, where).toBe(ww.currentCondition);

              // 2. The lede, capped the clock's way, and at its cap with room.
              expect(card.fonts['lede']! / card.ledeRole, `${where}: the lede is ${card.fonts['lede']}px`).toBeLessThanOrEqual(
                CAP_RATIO + 0.005,
              );
              expect(card.fonts['lede']!, where).toBeLessThanOrEqual(card.cap + 0.01);
              if (resize !== undefined && size.orientation === 'portrait') {
                // A wide tall card: nothing but the cap binds the reading.
                expect(Math.abs(card.fonts['lede']! - card.cap), `${where}: the lede is not at its cap`).toBeLessThanOrEqual(0.5);
              }

              // 3. The sky, the ink and the shadow are the theme's own.
              expect(card.sky, where).toBe('day');
              const sky = await tokenColours(page, id, ['--sky-day-top', '--sky-day-bottom', '--sky-day-ink']);
              expect(card.background, where).toContain(sky['--sky-day-top']);
              expect(card.background, where).toContain(sky['--sky-day-bottom']);
              expect(card.ink, where).toBe(sky['--sky-day-ink']);
              expect(card.themeShadow, `${where}: Panels casts no shadow, so this proves nothing`).not.toBe('none');
              expect(card.shadow, where).toBe(card.themeShadow);

              // The next hours, where the box is tall enough for them.
              if (resize !== undefined) {
                expect(card.rungs, where).toBe('lede condition feels next');
                expect(card.next, where).toBe('hours');
                expect(card.hours[0], where).toEqual({ at: 'Now', temp: deg(ww.hours[0]!.temp) });
                card.hours.forEach((hour, i) => expect(hour.temp, `${where} hour ${i}`).toBe(deg(ww.hours[i]!.temp)));
                expect(card.feels, where).toMatch(/^Feels like -?\d+°$/);
              }

              // 1. Role sizes, on a wall whose roles are set.
              const roles = await roleSizes(page);
              if (preset !== undefined) {
                const near = (name: string, role: string): void => {
                  if (card.fonts[name] !== undefined) {
                    expect(card.fonts[name], `${where} ${name}`).toBeCloseTo(roles[role]!, 1);
                  }
                };
                near('cond', 'event');
                near('range', 'time');
                near('feels', 'time');
                near('hourAt', 'scaffold');
                near('hourTemp', 'event');
                near('day', 'time');
              } else {
                expect(roles['event'], 'an unmeasured wall resolved a role').toBeUndefined();
              }
            } finally {
              await close();
            }
          }
        },
        SLOW,
      );
    }
  }

  it(
    'holds the lede to 1.8x the agenda’s event role at a third size, and on a television read from further away',
    async () => {
      // The D1 rule asks for the ratio at three sizes; the two above are the
      // first two. A 43" television read from 1.6m is the third, on the
      // landscape canvas at 2560x1440, in a box with the room to reach the cap.
      measureScreen(ww, 'tv-43');
      const size = { width: 2560, height: 1440 };
      await setWeather(ww, 'landscape', { variant: 'today' }, { h: 0.35 });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const card = await readCard(page, ww.weather.landscape.id);
        expect(card.fonts['lede']! / card.ledeRole).toBeLessThanOrEqual(CAP_RATIO + 0.005);
        // …and it is the cap that binds, not something smaller.
        expect(card.fonts['lede']! / card.ledeRole).toBeGreaterThan(CAP_RATIO - 0.05);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('what a Today card gives up, and what it keeps', () => {
  it(
    'gives up the hours for one line of days, then that line, then the feels-like, then the words — never the lede',
    async () => {
      measureScreen(ww, 'tv-32');
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      const seen: { h: number; rungs: string; next: string; lede: string; days: number; hours: number }[] = [];
      for (const h of [0.3, 0.1, 0.075, 0.06, 0.045]) {
        await setWeather(ww, size.orientation, { variant: 'today' }, { h });
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const box = await readForecastBox(page, id);
          expect(box.clipped, `at h=${h}`).toEqual([]);
          expect(box.belted, `at h=${h}`).toBe(0);
          const card = await readCard(page, id);
          seen.push({ h, rungs: card.rungs ?? '', next: card.next ?? '', lede: card.lede, days: card.days.length, hours: card.hours.length });
        } finally {
          await close();
        }
      }
      const order = ['lede', 'condition', 'feels', 'next'];
      for (const one of seen) {
        // Always the reading, and always a prefix of the kept order.
        expect(one.lede, JSON.stringify(one)).toBe(deg(ww.currentTemp));
        const rungs = one.rungs.split(' ');
        expect(rungs, JSON.stringify(one)).toEqual(order.slice(0, rungs.length));
      }
      // Never more as the box shrinks.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!.rungs.split(' ').length, JSON.stringify(seen)).toBeLessThanOrEqual(seen[i - 1]!.rungs.split(' ').length);
      }
      // The hours first, then the days as one line, then neither.
      expect(seen[0]!.next, JSON.stringify(seen)).toBe('hours');
      const days = seen.findIndex((one) => one.next === 'days');
      const none = seen.findIndex((one) => one.next === 'none');
      expect(days, JSON.stringify(seen)).toBeGreaterThan(0);
      expect(none, JSON.stringify(seen)).toBeGreaterThan(days);
      expect(seen[days]!.days, 'the one line names no day').toBeGreaterThan(0);
      // …and down to the lede alone in the shortest box.
      expect(seen[seen.length - 1]!.rungs, JSON.stringify(seen)).toBe('lede');
    },
    SLOW,
  );

  it(
    'names more of the day in a wider card, off the width each hour is drawn at',
    async () => {
      measureScreen(ww, 'tv-32');
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      const count = async (w: number): Promise<number> => {
        await setWeather(ww, size.orientation, { variant: 'today' }, { w, h: 0.3 });
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const box = await readForecastBox(page, id);
          expect(box.clipped, `at w=${w}`).toEqual([]);
          return (await readCard(page, id)).hours.length;
        } finally {
          await close();
        }
      };
      const narrow = await count(0.35);
      const wide = await count(0.9);
      expect(narrow).toBeGreaterThanOrEqual(1);
      expect(wide).toBeGreaterThan(narrow);
    },
    SLOW,
  );
});

describe('with no reading to call now', () => {
  it(
    'leads with today’s high and low, and says nothing only a measurement could',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { variant: 'today' }, { h: 0.3 });
      const saved = ww.wall.db.prepare(`SELECT * FROM weather_cache WHERE cache_key = 'openmeteo:current'`).get();
      ww.wall.db.prepare(`DELETE FROM weather_cache WHERE cache_key = 'openmeteo:current'`).run();
      try {
        const { page, close } = await loadWallSettled(ww.link, size);
        try {
          const box = await readForecastBox(page, id);
          expect(box.clipped).toEqual([]);
          const card = await readCard(page, id);
          expect(card.mode).toBe('forecast');
          expect(card.lede).toBe(deg(ww.days[0]!.high));
          expect(card.ledeLow).toBe(deg(ww.days[0]!.low));
          // No feels-like and no separate range: nothing presented as now.
          expect(card.feels).toBeNull();
          expect(card.range).toEqual([]);
          // The day's own words and sky: the capture's today is overcast.
          expect(card.cond).toBe(ww.days[0]!.summary);
          expect(card.sky).toBe('cloud');
          expect(card.fx).toBe('drift');
          // Still capped, still the lede.
          expect(card.fonts['lede']! / card.ledeRole).toBeLessThanOrEqual(CAP_RATIO + 0.005);
        } finally {
          await close();
        }
      } finally {
        const row = saved as Record<string, unknown>;
        ww.wall.db
          .prepare('INSERT INTO weather_cache (id, provider, cache_key, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(row['id'], row['provider'], row['cache_key'], row['payload'], row['fetched_at'], row['expires_at']);
      }
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** `SKY_MOTION_MS` in `apps/display/src/weather-looks.ts`. */
const GLOW_MS = 9_000;
const RAIN_MS = 1_200;
/** How far a rebuilt element may land from continuity: the draw's own latency (`browser-motion`'s figure). */
const TOLERANCE_MS = 300;

function around(a: number, b: number, cycle: number): number {
  const d = (((a - b) % cycle) + cycle) % cycle;
  return Math.min(d, cycle - d);
}

interface Phase {
  readonly name: string;
  readonly delay: string;
  readonly running: number;
  readonly phase: number | undefined;
  readonly startTime: number | undefined;
  readonly at: number;
}

/** An element's animation, read once it is ready — the Web Animations API, not a class. */
async function readPhase(page: Page, selector: string, mark = false): Promise<Phase> {
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
      if (mark) node.dataset['seen'] = '1';
      const at = document.timeline.currentTime;
      return {
        name: getComputedStyle(node).animationName,
        delay: getComputedStyle(node).animationDelay,
        running: animations.filter((one) => one.playState === 'running').length,
        phase: local === undefined ? undefined : local - delay,
        startTime: typeof first?.startTime === 'number' ? first.startTime : undefined,
        at: typeof at === 'number' ? at : 0,
      };
    },
    { selector, mark },
  );
}

describe('the sky moves, within its scope', () => {
  it(
    'glows on a clear day, and the glow resumes where it was across a real redraw',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setWeather(ww, size.orientation, { variant: 'today' }, { h: 0.3 });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const glow = `#wall .canvas .fw[data-widget-id="${ww.weather[size.orientation].id}"] .wt-fx-glow`;
        const before = await readPhase(page, glow, true);
        // The premise: the browser is running the card's own keyframes, with
        // the negative delay `motion.ts` wrote.
        expect(before.name).toBe('wt-glow');
        expect(before.running).toBe(1);
        expect(before.delay).toMatch(/^-\d/);
        await page.waitForFunction(
          (sel) => {
            const node = document.querySelector<HTMLElement>(sel);
            return node !== null && node.dataset['seen'] === undefined;
          },
          glow,
          { timeout: 25_000, polling: 50 },
        );
        const after = await readPhase(page, glow);
        expect(after.running).toBe(1);
        // A restart would sit (gap mod cycle) from continuity: 15,000 mod
        // 9,000 is 3,000 either way round, which no tolerance swallows.
        const gap = (after.startTime ?? 0) - (before.startTime ?? 0);
        expect(around(gap, 0, GLOW_MS), `the redraw came ${gap.toFixed(0)}ms after the last`).toBeGreaterThan(1_000);
        const expected = (before.phase as number) + (after.at - before.at);
        expect(around(after.phase as number, expected, GLOW_MS)).toBeLessThan(TOLERANCE_MS);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is still for a device that asks for reduced motion, and moves again when it stops asking',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      await setWeather(ww, size.orientation, { variant: 'today' }, { h: 0.3 });
      const { page, close } = await loadWallSettled(ww.link, size);
      try {
        const glow = `#wall .canvas .fw[data-widget-id="${ww.weather[size.orientation].id}"] .wt-fx-glow`;
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const still = await readPhase(page, glow);
        expect(still.running).toBe(0);
        expect(still.name).toBe('none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await readPhase(page, glow)).name).toBe('wt-glow');
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'rains across a wet sky, every drop locked to the clock a share of the cycle apart; a clear night is still',
    async () => {
      measureScreen(ww, undefined);
      const size = SIZES[0]!;
      const id = ww.weather[size.orientation].id;
      await setWeather(ww, size.orientation, { variant: 'today' }, { h: 0.3 });
      const sky = (glyph: string, isDay: boolean) => (body: Record<string, unknown>): void => {
        const weather = (body['panels'] as Record<string, Record<string, unknown>>)['weather']!;
        const current = weather['current'] as Record<string, unknown>;
        current['glyph'] = glyph;
        current['isDay'] = isDay;
      };
      const wet = await loadWallSettled(ww.link, size, { patchManifest: sky('rain', true) });
      try {
        const card = await readCard(wet.page, id);
        expect(card.sky).toBe('rain');
        expect(card.fx).toBe('rain');
        expect(card.fxCount).toBe(9);
        const drops = await wet.page.evaluate(
          (wid) => Array.from(document.querySelectorAll(`#wall .canvas .fw[data-widget-id="${wid}"] .wt-fx-drop`)).length,
          id,
        );
        const phases: number[] = [];
        for (let i = 1; i <= drops; i++) {
          const one = await readPhase(wet.page, `#wall .canvas .fw[data-widget-id="${id}"] .wt-fx-drop:nth-child(${i})`);
          expect(one.name).toBe('wt-rain');
          expect(one.running).toBe(1);
          phases.push(((one.phase as number) % RAIN_MS + RAIN_MS) % RAIN_MS);
        }
        // Staggered, not in step: no two drops at one point of the fall.
        const sorted = [...phases].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThan(40);
      } finally {
        await wet.close();
      }
      const night = await loadWallSettled(ww.link, size, { patchManifest: sky('clear', false) });
      try {
        const card = await readCard(night.page, id);
        expect(card.sky).toBe('night');
        expect(card.fx).toBeNull();
        expect(card.fxCount).toBe(0);
        const ink = await tokenColours(night.page, id, ['--sky-night-ink']);
        expect(card.ink).toBe(ink['--sky-night-ink']);
      } finally {
        await night.close();
      }
    },
    SLOW,
  );
});

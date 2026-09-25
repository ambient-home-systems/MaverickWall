/**
 * The countdown's `occasion` look — the number dressed for the day — measured
 * on a real wall (plan item P5.2, the second half).
 *
 * The shipped Classic wall with three family calendars, its forecast's box
 * made a countdown, at 1080x1920 and 1920x1080, on a wall nobody has measured
 * and on one set to a 32" television read from 1.2 metres:
 *
 *  1. **A form from the box, and nothing cut.** In Classic's own box, a box
 *     grown to hold everything, and a narrow column: every run and picture
 *     inside the box, no `nowrap` run cut, the belt with nothing to do, the
 *     parts on the glass exactly the parts the tier names, and every figure
 *     `tabular-nums` as computed. In Classic's portrait box — wide and short —
 *     the motif is kept, beside the count, which is why it sits there.
 *  2. **Roles, and one large reading capped (D1).** On the measured wall the
 *     label is the lede and the unit the scaffold, to the px; the count is at
 *     most 1.8 ledes at three sizes, and is the clock's role where it has room.
 *  3. **An accent pair from the theme's own tokens, for every occasion.** The
 *     count's computed colour is the page's own resolution of the occasion's
 *     first token and the unit's of its second; the motif is the occasion's
 *     bundled picture, a same-origin `<img>` that loaded, with no emoji code
 *     point anywhere in the text — and `custom` wears the household's picture
 *     and the theme's accent.
 *  4. **The scene is scoped and continuous.** Every piece runs its own
 *     keyframes with a negative delay from the wall clock, a rebuilt piece
 *     resumes where the old one was across a redraw, and a device asking for
 *     reduced motion gets the still frame — the same pieces, at rest.
 *  5. **On the day it says "Today!"** with its popper where the count goes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { TEARDOWN, loadWallSettled, shutDownBrowser } from './browser-harness.js';
import {
  RATIO_SIZES,
  SIZES,
  WALLS,
  civilDate,
  countdownWall,
  fontSizeIn,
  measureScreen,
  picturesIn,
  poll,
  readCountdownBox,
  roleSizes,
  setCountdown,
  wallName,
  type CountdownWall,
} from './browser-countdown-looks.js';

process.env['TZ'] = 'UTC';

const SLOW = 300_000;

let cw: CountdownWall;

beforeAll(async () => {
  cw = await countdownWall();
}, SLOW);

afterAll(async () => {
  await cw?.wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** `OCCASION_LOOKS` in `apps/display/src/countdown.ts`, read back rather than trusted. */
const LOOKS: Readonly<Record<string, { readonly a: string; readonly b: string; readonly motif?: string; readonly scene: string }>> = {
  christmas: { a: '--temp-hot', b: '--temp-cool', motif: 'christmas-tree', scene: 'snow' },
  birthday: { a: '--wx-storm', b: '--wx-sun', motif: 'birthday-cake', scene: 'balloons' },
  halloween: { a: '--temp-warm', b: '--wx-storm', motif: 'jack-o-lantern', scene: 'leaves' },
  vacation: { a: '--wx-rain', b: '--wx-sun', motif: 'beach-umbrella', scene: 'waves' },
  'schools-out': { a: '--temp-cool', b: '--wx-rain', motif: 'school-satchel', scene: 'planes' },
  'new-year': { a: '--wx-sun', b: '--wx-storm', motif: 'fireworks', scene: 'fireworks' },
  custom: { a: '--accent', b: '--muted', scene: 'sparkles' },
};

/** Classic's box, a box grown to hold everything, and a narrow column. */
const BOXES: readonly { readonly name: string; readonly resize?: { readonly w?: number; readonly h?: number } }[] = [
  { name: "Classic's box" },
  { name: 'a tall box', resize: { w: 0.9, h: 0.3 } },
  { name: 'a narrow column', resize: { w: 0.18, h: 0.35 } },
];

async function partsOn(page: Page, id: string): Promise<string[]> {
  return page.$$eval(`#wall .canvas .fw[data-widget-id="${id}"] [data-part]`, (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset['part'] ?? ''),
  );
}

/** A colour as the page resolves a token, off a probe in the countdown's own section. */
async function tokenColour(page: Page, id: string, token: string): Promise<string> {
  return page.evaluate(
    ({ wid, name }) => {
      const host = document.querySelector(`#wall .canvas .fw[data-widget-id="${wid}"] .cd`);
      if (host === null) throw new Error('no countdown section');
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      host.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    },
    { wid: id, name: token },
  );
}

describe('the occasion on a real wall', () => {
  for (const preset of WALLS) {
    for (const size of SIZES) {
      it(
        `takes a form from its box and cuts nothing, at ${size.width}x${size.height} on the ${wallName(preset)} wall`,
        async () => {
          measureScreen(cw, preset);
          const id = cw.box[size.orientation].id;
          for (const { name, resize } of BOXES) {
            await setCountdown(
              cw,
              { variant: 'occasion', occasion: 'christmas', target: civilDate(cw.wall.now(), 345), title: 'Christmas', unitWords: 'sleeps' },
              resize,
            );
            const { page, close } = await loadWallSettled(cw.link, size);
            try {
              const where = `${wallName(preset)} ${size.width}x${size.height} ${name}`;
              const box = await readCountdownBox(page, id);
              expect(box.clipped, where).toEqual([]);
              expect(box.belted, `${where}: the belt had to hide something`).toBe(0);
              expect(box.tier, `${where}: no tier stamped`).not.toBeNull();
              expect(box.numerals.length, `${where}: no figures drawn`).toBeGreaterThan(0);
              for (const run of box.numerals) expect(run.variant, `${where} "${run.text}"`).toContain('tabular-nums');
              const parts = await partsOn(page, id);
              expect([...parts].sort(), where).toEqual((box.rungs ?? '').split(' ').sort());
              expect(parts, `${where}: the count is gone`).toContain('num');
              if (name === 'a tall box') expect(box.tier, where).toBe('T2');
              // Classic's portrait box is wide and short: the motif is kept,
              // beside the count, where over it there would be no room.
              if (name === "Classic's box" && size.orientation === 'portrait') {
                expect(parts, `${where}: the motif was given up in a wide box`).toContain('motif');
                const beside = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdo-head`, (head) => {
                  const motif = head.querySelector('.cdo-motif')!.getBoundingClientRect();
                  const num = head.querySelector('.cdo-num')!.getBoundingClientRect();
                  return { rightOfMotif: num.left >= motif.right - 0.5, overlapsDown: num.top < motif.bottom && num.bottom > motif.top };
                });
                expect(beside, where).toEqual({ rightOfMotif: true, overlapsDown: true });
              }
              // …and a column too narrow for it beside the count gives it up
              // first: 194px on the portrait wall nobody measured, 13ch of
              // the label's face against the 15 the motif needs.
              if (name === 'a narrow column' && preset === undefined && size.orientation === 'portrait') {
                expect(parts, `${where}: a narrow column kept the motif`).toEqual(['num', 'unit', 'label']);
              }

              if (preset !== undefined) {
                const roles = await roleSizes(page);
                expect(await fontSizeIn(page, id, '.cdo-unit'), `${where}: unit`).toBeCloseTo(roles['scaffold']!, 1);
                if (parts.includes('label')) {
                  expect(await fontSizeIn(page, id, '.cdo-label'), `${where}: label`).toBeCloseTo(roles['lede']!, 1);
                }
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
});

describe('the count is one large reading, capped against the lede (D1)', () => {
  for (const preset of WALLS) {
    it(
      `is at most 1.8 ledes at three sizes, and the clock's role where there is room, on the ${wallName(preset)} wall`,
      async () => {
        measureScreen(cw, preset);
        await setCountdown(cw, { variant: 'occasion', occasion: 'birthday', target: civilDate(cw.wall.now(), 12), title: 'Amy' }, { w: 0.9, h: 0.3 });
        for (const size of RATIO_SIZES) {
          const { page, close } = await loadWallSettled(cw.link, size);
          try {
            const id = cw.box[size.orientation].id;
            const where = `${wallName(preset)} ${size.width}x${size.height}`;
            const count = (await fontSizeIn(page, id, '.cdo-num'))!;
            const lede = (await fontSizeIn(page, id, '.cdo-label'))!;
            expect(count / lede, `${where}: ${count}px over ${lede}px`).toBeLessThanOrEqual(1.8 + 1e-3);
            const clock = await page.evaluate(() => {
              const probe = document.createElement('span');
              probe.style.fontSize = 'var(--t-wall-clock, calc(var(--t-event) * 1.8))';
              document.querySelector('#wall .canvas')?.appendChild(probe);
              const px = parseFloat(getComputedStyle(probe).fontSize);
              probe.remove();
              return px;
            });
            expect(count, where).toBeCloseTo(clock, 1);
          } finally {
            await close();
          }
        }
      },
      SLOW,
    );
  }
});

describe('an accent pair from the theme’s own tokens, and the occasion’s picture', () => {
  it(
    'paints the count and the unit in each occasion’s pair, and draws its motif as bundled artwork',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      for (const [occasion, look] of Object.entries(LOOKS)) {
        await setCountdown(
          cw,
          { variant: 'occasion', occasion, target: civilDate(cw.wall.now(), 12), title: 'The day', emoji: 'rocket' },
          { w: 0.9, h: 0.3 },
        );
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const drawn = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cd-occasion`, (section) => ({
            occasion: (section as HTMLElement).dataset['occasion'],
            scene: section.querySelector<HTMLElement>('.cdo-scene')?.dataset['scene'],
            num: getComputedStyle(section.querySelector('.cdo-num')!).color,
            unit: getComputedStyle(section.querySelector('.cdo-unit')!).color,
            motif: section.querySelector('.cdo-motif img')?.getAttribute('src') ?? null,
            label: Array.from(section.querySelectorAll('.cdo-label img')).map((img) => img.getAttribute('src')),
            pieces: section.querySelectorAll('.cdo-scene .cdo-fx').length,
          }));
          expect(drawn.occasion, occasion).toBe(occasion);
          expect(drawn.scene, occasion).toBe(look.scene);
          expect(drawn.pieces, `${occasion}: an empty scene`).toBeGreaterThan(0);
          expect(drawn.num, `${occasion}: the count`).toBe(await tokenColour(page, id, look.a));
          expect(drawn.unit, `${occasion}: the unit`).toBe(await tokenColour(page, id, look.b));
          // The occasion's own picture, or the household's on `custom`; a
          // picture the household chose beside a named occasion rides with the
          // label, and is never drawn twice.
          if (look.motif === undefined) {
            expect(drawn.motif, occasion).toBe('/assets/emoji/rocket.svg');
            expect(drawn.label, occasion).toEqual([]);
          } else {
            expect(drawn.motif, occasion).toBe(`/assets/emoji/${look.motif}.svg`);
            expect(drawn.label, occasion).toEqual(['/assets/emoji/rocket.svg']);
          }
          const pictures = await picturesIn(page, id);
          expect(pictures.codePoints, occasion).toEqual([]);
          for (const img of pictures.images) {
            expect(new URL(img.src).origin, `${occasion}: ${img.src}`).toBe(new URL(cw.link).origin);
            expect(img.loaded, `${occasion}: ${img.src} did not load`).toBe(true);
          }
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );
});

interface PiecePhase {
  readonly name: string;
  readonly delay: string;
  readonly running: number;
  readonly phase: number | undefined;
  readonly at: number;
}

/** Every piece in the scene: its animation, read once ready — the Web Animations API, not a class. */
async function scenePhases(page: Page, id: string, mark = false): Promise<PiecePhase[]> {
  return page.evaluate(
    async ({ wid, mark }) => {
      const scene = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${wid}"] .cdo-scene`);
      if (scene === null) throw new Error('no scene');
      if (mark) scene.dataset['seen'] = '1';
      const pieces = Array.from(scene.querySelectorAll<HTMLElement>('.cdo-fx'));
      const out: { name: string; delay: string; running: number; phase: number | undefined; at: number }[] = [];
      for (const node of pieces) {
        const animations = node.getAnimations();
        await Promise.all(animations.map((one) => one.ready));
        const timing = animations[0]?.effect?.getComputedTiming();
        const local = typeof timing?.localTime === 'number' ? timing.localTime : undefined;
        const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
        const at = document.timeline.currentTime;
        out.push({
          name: getComputedStyle(node).animationName,
          delay: getComputedStyle(node).animationDelay,
          running: animations.filter((one) => one.playState === 'running').length,
          phase: local === undefined ? undefined : local - delay,
          at: typeof at === 'number' ? at : 0,
        });
      }
      return out;
    },
    { wid: id, mark },
  );
}

/** `OCCASION_SCENE_MS.snow`. */
const SNOW_MS = 6_500;
/** How far a rebuilt piece may land from continuity: the draw's own latency (`browser-motion`'s figure). */
const TOLERANCE_MS = 300;

function around(a: number, b: number, cycle: number): number {
  const d = (((a - b) % cycle) + cycle) % cycle;
  return Math.min(d, cycle - d);
}

describe('the scene moves, within its scope', () => {
  it(
    'snows, every flake locked to the wall clock, and each resumes where it was across a redraw',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      await setCountdown(cw, { variant: 'occasion', occasion: 'christmas', target: civilDate(cw.wall.now(), 12), title: 'Christmas' }, { w: 0.9, h: 0.3 });
      const { page, close } = await loadWallSettled(cw.link, size);
      try {
        const before = await scenePhases(page, id, true);
        expect(before.length).toBe(10);
        for (const flake of before) {
          // The premise: the browser runs the scene's own keyframes, with the
          // negative delay `motion.ts` wrote.
          expect(flake.name).toBe('cd-oc-fall');
          expect(flake.running).toBe(1);
          expect(flake.delay).toMatch(/^-\d|^0s$/);
        }
        // Spread through the fall, a share of the cycle apart, not one row.
        const phases = before.map((flake) => flake.phase as number);
        expect(Math.max(...phases) - Math.min(...phases), 'the flakes fall in step').toBeGreaterThan(SNOW_MS / 2);

        await poll(page);
        await page.waitForFunction(
          (wid) => {
            const scene = document.querySelector<HTMLElement>(`#wall .canvas .fw[data-widget-id="${wid}"] .cdo-scene`);
            return scene !== null && scene.dataset['seen'] === undefined;
          },
          id,
          { timeout: 25_000, polling: 50 },
        );
        const after = await scenePhases(page, id);
        expect(after.length).toBe(before.length);
        // Each rebuilt flake is where the old one had got to. A restart would
        // put a flake at the start of its fall: the flake whose phase is
        // furthest from there is the one that cannot hide one.
        let furthest = 0;
        before.forEach((flake, index) => {
          const expected = (flake.phase as number) + ((after[index] as PiecePhase).at - flake.at);
          expect(around((after[index] as PiecePhase).phase as number, expected, SNOW_MS), `flake ${index}`).toBeLessThan(TOLERANCE_MS);
          furthest = Math.max(furthest, around(expected, 0, SNOW_MS));
        });
        expect(furthest, 'every flake was near the start of its fall, so a restart could hide').toBeGreaterThan(2 * TOLERANCE_MS);
      } finally {
        await close();
      }
    },
    SLOW,
  );

  it(
    'is the still frame for a device that asks for reduced motion — the same pieces, at rest — and moves again after',
    async () => {
      measureScreen(cw, undefined);
      const size = SIZES[0]!;
      const id = cw.box[size.orientation].id;
      for (const occasion of Object.keys(LOOKS)) {
        await setCountdown(cw, { variant: 'occasion', occasion, target: civilDate(cw.wall.now(), 12), title: 'The day' }, { w: 0.9, h: 0.3 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const still = await scenePhases(page, id);
          expect(still.length, `${occasion}: the still frame is empty`).toBeGreaterThan(0);
          for (const piece of still) {
            expect(piece.running, occasion).toBe(0);
            expect(piece.name, occasion).toBe('none');
          }
          // At rest, inside the scene: a picture of the same occasion.
          const inside = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdo-scene`, (scene) => {
            const frame = scene.getBoundingClientRect();
            return Array.from(scene.querySelectorAll('.cdo-fx')).filter((piece) => {
              const r = piece.getBoundingClientRect();
              return r.width > 0 && r.bottom > frame.top && r.top < frame.bottom && r.right > frame.left && r.left < frame.right;
            }).length;
          });
          expect(inside, `${occasion}: nothing of the scene rests in the box`).toBeGreaterThan(0);
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          const moving = await scenePhases(page, id);
          expect(moving.some((piece) => piece.running === 1), `${occasion}: nothing moves again`).toBe(true);
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );
});

describe('the day itself', () => {
  for (const size of SIZES) {
    it(
      `says "Today!" with its popper where the count goes, at ${size.width}x${size.height}`,
      async () => {
        measureScreen(cw, undefined);
        const id = cw.box[size.orientation].id;
        await setCountdown(cw, { variant: 'occasion', occasion: 'new-year', target: civilDate(cw.wall.now(), 0), title: 'New Year' }, { w: 0.9, h: 0.3 });
        const { page, close } = await loadWallSettled(cw.link, size);
        try {
          const num = await page.$eval(`#wall .canvas .fw[data-widget-id="${id}"] .cdo-num`, (n) => ({
            text: n.textContent,
            img: n.querySelector('img')?.getAttribute('src') ?? null,
          }));
          expect(num).toEqual({ text: 'Today!', img: '/assets/emoji/party-popper.svg' });
          expect(await page.$$(`#wall .canvas .fw[data-widget-id="${id}"] .cdo-unit`)).toHaveLength(0);
          expect((await picturesIn(page, id)).codePoints).toEqual([]);
          const box = await readCountdownBox(page, id);
          expect(box.clipped).toEqual([]);
          expect(box.belted).toBe(0);
        } finally {
          await close();
        }
      },
      SLOW,
    );
  }
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';

import {
  HOUSEHOLD_CALENDARS,
  TEARDOWN,
  browser,
  equipHousehold,
  install,
  loadWallSettled,
  shutDownBrowser,
  type Installation,
} from './browser-harness.js';
import { DRAWN_CATEGORIES, WALLPAPERS } from '../src/wallpapers.js';
import { WALL_SIZE_PRESETS } from '../src/wall-sizes.js';

/**
 * A picture toned down towards the canvas's ground (plan item M4.7), and the
 * text shadow for words straight on one (plan item M4.8), on a real paired
 * wall and in the real editor, read off computed style and off pixels rather
 * than off any class.
 *
 *  - **The wash is a vignette under every widget.** Light is measured off the
 *    screen: with the widgets hidden, how much of the theme's card colour is
 *    over the picture at the centre and at the corner.
 *  - **Strong is solved where words sit on it.** With no widget ground, its
 *    centre is the lowest opacity that keeps both inks at 4.5:1 over the
 *    picture's own patches, solved here independently; over a ground it is the
 *    preset. `browser-wallpaper-contrast.test.ts` holds that solved centre
 *    against what every shipped file actually shows.
 *  - **The text shadow is on words straight on a picture and nowhere else**:
 *    not over a widget ground, not over a flat colour, not on an e-ink-sized
 *    wall.
 */

process.env['TZ'] = 'UTC';

const SLOW = 180_000;
const LANDSCAPE = { width: 1920, height: 1080 } as const;
const MARGIN = 3;
const STRONG = { centre: 0.5, edge: 0.8 } as const;

type Rgb = readonly [number, number, number];
const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const linear = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (panel: Rgb, alpha: number, patch: Rgb): Rgb =>
  [0, 1, 2].map((i) => alpha * (panel[i] ?? 0) + (1 - alpha) * (patch[i] ?? 0)) as unknown as Rgb;

/** The lowest hundredth keeping both inks at 4.5:1 over both widened patches — written out, not imported. */
function solve(panel: string, inks: readonly string[], patches: { light: string; dark: string }): number {
  const widened = [hex(patches.light).map((v) => Math.min(255, v + MARGIN)), hex(patches.dark).map((v) => Math.max(0, v - MARGIN))] as unknown as Rgb[];
  for (let step = 0; step <= 100; step++) {
    const alpha = step / 100;
    if (widened.every((patch) => inks.every((ink) => contrast(hex(ink), over(hex(panel), alpha, patch)) >= 4.5))) return alpha;
  }
  return 1;
}

let wall: Installation;
let link: string;
let screenId: string;

beforeAll(async () => {
  wall = await install({ calendars: HOUSEHOLD_CALENDARS });
  equipHousehold(wall.db, wall.now());
  screenId = await wall.pairWall('Kitchen');
  const html = await (await wall.call(`/admin/walls/${screenId}/pair`)).text();
  const found = /(https?:\/\/[^<\s"]*\/pair\?token=[^<\s"]+)/.exec(html)?.[1];
  if (found === undefined) throw new Error('the pairing page printed no link');
  link = found;
}, SLOW);

afterAll(async () => {
  await wall.dispose();
  await shutDownBrowser();
}, TEARDOWN);

/** Put a background, a widget ground and a size on the wall. */
function wear(theme: string, background: object | null, ground: string | null, size?: string): void {
  const json = background === null ? null : JSON.stringify(background);
  const preset = size === undefined ? undefined : WALL_SIZE_PRESETS.find((one) => one.key === size);
  wall.db
    .prepare(
      'UPDATE screens SET theme = ?, layout_background = ?, layout_landscape_background = ?, widget_ground = ?, ' +
        'panel_width_mm = ?, panel_height_mm = ?, read_distance_mm = ? WHERE id = ?',
    )
    .run(theme, json, json, ground, preset?.widthMm ?? null, preset?.heightMm ?? null, preset?.readAtMm ?? null, screenId);
}

/** A canvas token as hex, through a probe: `getPropertyValue` answers the token stream. */
function tokens(page: Page): Promise<{ panel: string; inks: string[]; edge: string; ratio: string; inlineEdge: string }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('#wall .canvas');
    if (canvas === null) throw new Error('no canvas');
    const resolve = (name: string): string => {
      const probe = document.createElement('i');
      probe.style.color = `var(${name})`;
      canvas.appendChild(probe);
      const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? [];
      probe.remove();
      return `#${rgb.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    };
    const style = getComputedStyle(canvas);
    return {
      panel: resolve('--panel'),
      inks: [resolve('--ink'), resolve('--ink-scaffold')],
      edge: style.getPropertyValue('--wash-edge').trim(),
      ratio: style.getPropertyValue('--wash-ratio').trim(),
      inlineEdge: canvas.style.getPropertyValue('--wash-edge'),
    };
  });
}

/** Every leaf box's computed `text-shadow`. */
function textShadows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#wall .canvas .fw:not(.fw-group)')).map((box) => getComputedStyle(box).textShadow),
  );
}

/** The canvas's pixels at a point, as fractions of its box, from a screenshot decoded in the page. */
async function pixels(page: Page, points: readonly (readonly [number, number])[]): Promise<Rgb[]> {
  const box = await page.locator('#wall .canvas').boundingBox();
  if (box === null) throw new Error('no canvas box');
  const shot = (await page.screenshot({ clip: box })).toString('base64');
  return page.evaluate(
    async ({ shot, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return points.map(([fx, fy]) => {
        const d = ctx.getImageData(Math.round(fx * (c.width - 1)), Math.round(fy * (c.height - 1)), 1, 1).data;
        return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number];
      });
    },
    { shot, points },
  );
}

describe('a washed picture on the wall', () => {
  it(
    'lays the card colour over the picture as a vignette under every widget: Light at 0.25 in the middle and 0.55 at the edge',
    async () => {
      // A pale, even paper under a dark theme's card colour: the largest
      // difference the set offers, so the blend can be read back in pixels.
      const points = [
        [0.5, 0.5],
        [0.04, 0.04],
      ] as const;
      const read = async (wash?: string): Promise<{ at: Rgb[]; panel: string; order: string[] }> => {
        wear('panels', { type: 'wallpaper', id: 'paper', ...(wash === undefined ? {} : { wash }) }, 'none');
        const { page, close } = await loadWallSettled(link, LANDSCAPE);
        try {
          const order = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLElement>('#wall .canvas');
            const box = canvas?.querySelector<HTMLElement>('.fw');
            const r = box?.getBoundingClientRect();
            if (r === undefined) return [];
            // Hit-testing skips a layer that takes no pointer, which the wash
            // does not, so it is let in for this one reading.
            const layer = canvas?.querySelector<HTMLElement>('.canvas-wash');
            if (layer) layer.style.pointerEvents = 'auto';
            // What is under a point in the first widget, top first: the wash
            // must be under the widget, never over it.
            return document
              .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              .filter((el) => el === box || el.classList.contains('canvas-wash'))
              .map((el) => (el === box ? 'widget' : 'wash'));
          });
          // Through the CSSOM, which the wall's CSP governs no more than the
          // renderer's own writes; a style tag it refuses, correctly.
          await page.evaluate(() => {
            for (const box of document.querySelectorAll<HTMLElement>('#wall .canvas .fw')) box.style.visibility = 'hidden';
          });
          const at = await pixels(page, points);
          return { at, panel: (await tokens(page)).panel, order };
        } finally {
          await close();
        }
      };
      const bare = await read();
      const light = await read('light');
      expect(light.order, 'the wash is drawn over a widget').toEqual(['widget', 'wash']);
      expect(bare.order).toEqual(['widget']);
      const panel = hex(light.panel);
      // The alpha each pixel shows: how far from the picture towards the card colour.
      const alpha = (washed: Rgb, plain: Rgb): number => {
        const i = [0, 1, 2].sort((a, b) => Math.abs(panel[b]! - plain[b]!) - Math.abs(panel[a]! - plain[a]!))[0]!;
        return (washed[i]! - plain[i]!) / (panel[i]! - plain[i]!);
      };
      const centre = alpha(light.at[0]!, bare.at[0]!);
      const corner = alpha(light.at[1]!, bare.at[1]!);
      expect(centre, `centre ${centre.toFixed(3)}`).toBeCloseTo(0.25, 1);
      expect(Math.abs(centre - 0.25)).toBeLessThan(0.03);
      expect(corner, `corner ${corner.toFixed(3)}`).toBeGreaterThan(0.45);
      expect(corner).toBeLessThanOrEqual(0.56);
    },
    SLOW,
  );

  it(
    'solves a Strong wash for the picture where words sit on it, and draws the preset over a widget ground',
    async () => {
      // The photograph Panels needs most for, by its unblurred patches.
      wear('panels', { type: 'wallpaper', id: 'dusk', wash: 'strong' }, 'none');
      const probe = await loadWallSettled(link, LANDSCAPE);
      const theme = await tokens(probe.page);
      await probe.close();
      const ranked = WALLPAPERS.filter((w) => w.tone === 'dark' && w.bare !== undefined)
        .map((w) => ({ w, solved: solve(theme.panel, theme.inks, w.bare!) }))
        .sort((a, b) => b.solved - a.solved);
      const hardest = ranked[0]!;
      // The premise: this picture needs more than the preset, so a wall drawing the preset would be wrong.
      expect(hardest.solved, `${hardest.w.id} needs no more than Strong's preset`).toBeGreaterThan(STRONG.centre);

      wear('panels', { type: 'wallpaper', id: hardest.w.id, wash: 'strong' }, 'none');
      const solved = await loadWallSettled(link, LANDSCAPE);
      try {
        const read = await tokens(solved.page);
        const edge = Math.max(STRONG.edge, hardest.solved);
        expect(Number(read.edge), `${hardest.w.id}: the edge`).toBeCloseTo(edge, 5);
        expect(Number(read.ratio) * Number(read.edge), `${hardest.w.id}: the centre`).toBeCloseTo(hardest.solved, 2);
      } finally {
        await solved.close();
      }

      // Over a Soft ground the words sit on the ground, so the wash is the preset.
      wear('panels', { type: 'wallpaper', id: hardest.w.id, wash: 'strong' }, 'soft');
      const grounded = await loadWallSettled(link, LANDSCAPE);
      try {
        const read = await tokens(grounded.page);
        expect(read.inlineEdge).toBe('');
        expect(Number(read.edge)).toBeCloseTo(STRONG.edge, 5);
        expect(Number(read.ratio)).toBeCloseTo(STRONG.centre / STRONG.edge, 3);
      } finally {
        await grounded.close();
      }
    },
    SLOW,
  );

  it(
    'draws no wash where none was asked for, which is every wall that existed before this',
    async () => {
      wear('panels', { type: 'wallpaper', id: 'dusk' }, null);
      const { page, close } = await loadWallSettled(link, LANDSCAPE);
      try {
        expect(await page.locator('#wall .canvas-wash').count()).toBe(0);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

describe('words straight on a picture', () => {
  const photo = WALLPAPERS.find((w) => !DRAWN_CATEGORIES.includes(w.category) && w.tone === 'dark')!;

  it(
    'carry the theme’s halo, in its own card colour, and only there',
    async () => {
      wear('panels', { type: 'wallpaper', id: photo.id }, 'none');
      const bare = await loadWallSettled(link, LANDSCAPE);
      try {
        const panel = hex((await tokens(bare.page)).panel);
        const shadows = await textShadows(bare.page);
        expect(shadows.length).toBeGreaterThan(0);
        for (const shadow of shadows) {
          expect(shadow, 'a leaf straight on the picture').toContain(`rgba(${panel.join(', ')}, 0.9)`);
          expect(shadow).toContain(`rgba(${panel.join(', ')}, 0.7)`);
        }
      } finally {
        await bare.close();
      }

      for (const [what, background, ground, size] of [
        ['over a Soft ground', { type: 'wallpaper', id: photo.id }, 'soft', undefined],
        ['over a flat colour', { type: 'solid', color: '#334455' }, 'none', undefined],
        ['on an e-ink-sized wall', { type: 'wallpaper', id: photo.id }, 'none', 'eink-7.5'],
      ] as const) {
        wear('panels', background, ground, size);
        const { page, close } = await loadWallSettled(link, LANDSCAPE);
        try {
          for (const shadow of await textShadows(page)) expect(shadow, what).toBe('none');
        } finally {
          await close();
        }
      }
    },
    SLOW,
  );
});

describe('the wash in the editor', () => {
  it(
    'is chosen beside the widget ground, previewed at once, and saved on both orientations',
    async () => {
      wear('panels', { type: 'wallpaper', id: 'dusk' }, null);
      const context = await (await browser()).newContext({ viewport: { width: 1440, height: 1000 } });
      try {
        const page = await context.newPage();
        await wall.signIn(page);
        const open = async (): Promise<void> => {
          await page.goto(`${wall.base}/admin/walls/${encodeURIComponent(screenId)}`, { waitUntil: 'load' });
          await page.waitForSelector('.le-overlay .le-widget', { timeout: 20_000 });
          await page.click('.le-background-btn');
        };
        await open();
        const pressed = (): Promise<string[]> =>
          page.$$eval('.le-wp-wash [data-wash][aria-pressed="true"]', (b) => b.map((one) => (one as HTMLElement).dataset['wash'] ?? ''));
        expect(await pressed()).toEqual(['none']);
        // Over the Soft ground a wall on a wallpaper has, the sentence says it only changes the picture.
        await page.click('.le-wp-wash [data-wash="strong"]');
        expect(await pressed()).toEqual(['strong']);
        expect(await page.textContent('.le-wp-wash .hint')).toContain('only changes how the picture looks');
        const previewed = await page.evaluate(() => {
          const root = document.querySelector('.le-preview')?.shadowRoot;
          return {
            wash: root?.querySelector<HTMLElement>('.canvas')?.getAttribute('data-wash') ?? null,
            layer: root?.querySelector('.canvas .canvas-wash') !== null && root?.querySelector('.canvas .canvas-wash') !== undefined,
          };
        });
        expect(previewed).toEqual({ wash: 'strong', layer: true });

        // With no ground, the sentence says Strong is worked out so words stay readable.
        await page.click('.le-wp-ground [data-ground="none"]');
        expect(await page.textContent('.le-wp-wash .hint')).toContain('stay easy to read');

        // Choosing another picture keeps the wash.
        await page.click('.le-wallpapers [data-wallpaper="midnight"]');
        expect(await pressed()).toEqual(['strong']);

        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click('[data-action="save"]')]);
        const stored = wall.db
          .prepare('SELECT layout_background AS p, layout_landscape_background AS l FROM screens WHERE id = ?')
          .get(screenId) as { p: string; l: string };
        expect(JSON.parse(stored.p)).toEqual({ type: 'wallpaper', id: 'midnight', wash: 'strong' });
        expect(JSON.parse(stored.l)).toEqual({ type: 'wallpaper', id: 'midnight', wash: 'strong' });

        // And it opens on what was saved; None takes it off again.
        await open();
        expect(await pressed()).toEqual(['strong']);
        await page.click('.le-wp-wash [data-wash="none"]');
        await Promise.all([page.waitForNavigation({ timeout: 20_000 }), page.click('[data-action="save"]')]);
        const cleared = wall.db.prepare('SELECT layout_background AS p FROM screens WHERE id = ?').get(screenId) as { p: string };
        expect(JSON.parse(cleared.p)).toEqual({ type: 'wallpaper', id: 'midnight' });
      } finally {
        await context.close();
      }
    },
    SLOW,
  );
});
